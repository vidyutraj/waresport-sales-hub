import { beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '@/lib/db';
import {
  addMembership,
  assignOrg,
  createCohort,
  createContact,
  createOrganization,
  createUser,
  ensureTerritory,
  expectRejection,
  tag,
} from './factories';
import {
  assignOrganization,
  bulkAssign,
  claimResearchedOrganization,
  planEvenDistribution,
} from '@/lib/services/assignment';
import {
  applySuppression,
  liftSuppression,
  logActivity,
  OutreachError,
  voidActivity,
} from '@/lib/services/outreach';
import {
  createProspect,
  recordConnectionRequest,
  recordProspectEvent,
} from '@/lib/services/prospects';
import { outreachTotals, recentActivity } from '@/lib/queries/metrics';
import { DEFAULT_METRIC_POLICY } from '@/lib/domain/metrics';
import { cohortRange, programWeek, type Cohort } from '@/lib/domain/program';

let owner: string;
let admin: string;
let internA: string;
let internB: string;
let cohortId: string;
let cohort: Cohort;
let east: string;
let west: string;

const OCCURRED = new Date('2026-03-04T14:00:00Z'); // inside week 1

beforeAll(async () => {
  owner = await createUser({ role: 'owner' });
  admin = await createUser({ role: 'admin' });
  internA = await createUser({ role: 'intern', fullName: 'Assign A' });
  internB = await createUser({ role: 'intern', fullName: 'Assign B' });
  east = await ensureTerritory('EAST', 'East');
  west = await ensureTerritory('WEST', 'West');
  cohortId = await createCohort({
    name: `Assign cohort ${tag()}`,
    startDate: '2026-03-02',
    createdBy: owner,
  });
  cohort = {
    id: cohortId,
    name: 'Assign cohort',
    startDate: '2026-03-02',
    weeksCount: 12,
    reportingTimezone: 'America/New_York',
  };
  await addMembership({ userId: internA, cohortId, territoryId: east, joinedOn: '2026-03-02' });
  await addMembership({ userId: internB, cohortId, territoryId: west, joinedOn: '2026-03-02' });
});

describe('assignment concurrency', () => {
  it('lets only one of two simultaneous assignments win', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });

    const results = await Promise.allSettled([
      asUser(admin, (tx) =>
        assignOrganization(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          organizationId: orgId,
          internUserId: internA,
        }),
      ),
      asUser(admin, (tx) =>
        assignOrganization(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          organizationId: orgId,
          internUserId: internB,
          territoryOverrideReason: 'Cross-territory test',
        }),
      ),
    ]);

    // Whichever ordering the database picks, exactly one current assignment
    // exists afterwards — that is the invariant the unique index guarantees.
    const current = await asUser(
      admin,
      (tx) =>
        tx<{ intern_user_id: string }[]>`
        SELECT intern_user_id FROM organization_assignments
        WHERE organization_id = ${orgId} AND unassigned_at IS NULL`,
    );
    expect(current).toHaveLength(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('reports a collision when an intern claims an already-claimed club', async () => {
    const orgId = await asUser(internA, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO organizations (name, city, state, created_by, source)
        VALUES (${`Claimed ${tag()}`}, 'Testville', 'NC', ${internA}, 'intern_research')
        RETURNING id`;
      return row!.id;
    });

    const first = await asUser(internA, (tx) =>
      claimResearchedOrganization(tx, { actorUserId: internA, organizationId: orgId }),
    );
    expect(first.status).toBe('claimed');

    const second = await asUser(internA, (tx) =>
      claimResearchedOrganization(tx, { actorUserId: internA, organizationId: orgId }),
    );
    expect(second.status).toBe('collision');
    if (second.status === 'collision') {
      // The notice carries no other intern's identity, notes or contacts.
      expect(Object.keys(second.notice).sort()).toEqual([
        'alreadyClaimed',
        'organizationId',
        'organizationName',
      ]);
    }
  });
});

describe('territory guard', () => {
  it('refuses a cross-territory assignment without a reason', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    const error = await expectRejection(
      asUser(admin, (tx) =>
        assignOrganization(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          organizationId: orgId,
          internUserId: internB, // WEST intern, EAST club
        }),
      ),
    );
    expect(String(error)).toMatch(/outside that intern's territory/i);
  });

  it('allows it with an explicit override reason, and records the reason', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await asUser(admin, (tx) =>
      assignOrganization(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationId: orgId,
        internUserId: internB,
        territoryOverrideReason: 'Intern B already has a relationship there.',
      }),
    );
    const [row] = await asUser(
      admin,
      (tx) =>
        tx<{ territory_override_reason: string | null }[]>`
        SELECT territory_override_reason FROM organization_assignments
        WHERE organization_id = ${orgId} AND unassigned_at IS NULL`,
    );
    expect(row?.territory_override_reason).toMatch(/relationship/i);
  });
});

describe('bulk assignment survives partial failure', () => {
  it('reports failures without aborting the whole batch', async () => {
    const good = await createOrganization({ createdBy: admin, territoryId: east });
    const crossTerritory = await createOrganization({ createdBy: admin, territoryId: west });
    const alsoGood = await createOrganization({ createdBy: admin, territoryId: east });

    const result = await asUser(admin, (tx) =>
      bulkAssign(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationIds: [good, crossTerritory, alsoGood],
        internUserId: internA, // EAST
      }),
    );

    expect(result.assigned).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.organizationId).toBe(crossTerritory);

    // The two valid assignments really did commit.
    const rows = await asUser(
      admin,
      (tx) =>
        tx<{ organization_id: string }[]>`
        SELECT organization_id FROM organization_assignments
        WHERE organization_id IN (${good}, ${alsoGood}) AND unassigned_at IS NULL`,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('even distribution', () => {
  it('is deterministic and puts the remainder on the earliest interns', () => {
    const plan = planEvenDistribution(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['x', 'y', 'z']);
    expect(plan.get('x')).toEqual(['a', 'd', 'g']);
    expect(plan.get('y')).toEqual(['b', 'e']);
    expect(plan.get('z')).toEqual(['c', 'f']);

    // Same inputs, same output, every time.
    const again = planEvenDistribution(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['x', 'y', 'z']);
    expect([...again.entries()]).toEqual([...plan.entries()]);
  });
});

describe('reassignment preserves history', () => {
  it('keeps the original actor on every logged activity', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    // Reassign to intern B.
    await asUser(admin, (tx) =>
      assignOrganization(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationId: orgId,
        internUserId: internB,
        territoryOverrideReason: 'Handover test',
      }),
    );

    // A's contribution still counts for A, not for B.
    const week1 = programWeek(cohort, 1);
    const aTotals = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    const bTotals = await asUser(internB, (tx) =>
      outreachTotals(tx, {
        actorUserId: internB,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(aTotals.emails).toBe(1);
    expect(bTotals.emails).toBe(0);
  });

  it('shows the new owner the outreach history but not other interns’ private data', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    await createContact({ organizationId: orgId, createdBy: admin });

    await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        notes: 'Reached out to the president.',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    await asUser(admin, (tx) =>
      assignOrganization(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationId: orgId,
        internUserId: internB,
        territoryOverrideReason: 'Handover test',
      }),
    );

    // The new owner can see the history (so they do not double-contact) ...
    const historyForB = await asUser(
      internB,
      (tx) => tx<{ id: string }[]>`SELECT id FROM activity_events WHERE organization_id = ${orgId}`,
    );
    expect(historyForB.length).toBeGreaterThan(0);

    // ... and can see the contacts, because they now own the club.
    const contactsForB = await asUser(
      internB,
      (tx) => tx<{ id: string }[]>`SELECT id FROM contacts WHERE organization_id = ${orgId}`,
    );
    expect(contactsForB.length).toBe(1);

    // The former owner keeps their own history ...
    const historyForA = await asUser(
      internA,
      (tx) => tx<{ id: string }[]>`SELECT id FROM activity_events WHERE organization_id = ${orgId}`,
    );
    expect(historyForA.length).toBe(1);

    // ... but loses access to the club's live contact data.
    const contactsForA = await asUser(
      internA,
      (tx) => tx<{ id: string }[]>`SELECT id FROM contacts WHERE organization_id = ${orgId}`,
    );
    expect(contactsForA).toHaveLength(0);

    // And cannot modify someone else's record.
    const updated = await asUser(
      internA,
      (tx) =>
        tx`UPDATE activity_events SET voided_at = now(), void_reason = 'x'
         WHERE organization_id = ${orgId} AND actor_user_id = ${internB} RETURNING id`,
    );
    expect(updated).toHaveLength(0);
  });

  it('renders the previous owner’s work in the timeline the new owner reads', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        notes: 'First contact by the previous owner.',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    await asUser(admin, (tx) =>
      assignOrganization(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationId: orgId,
        internUserId: internB,
        territoryOverrideReason: 'Timeline visibility test',
      }),
    );

    // The formatted timeline (not just the raw table) must still include it.
    // An inner join on `users` would silently drop the row here, because RLS
    // hides intern A's profile from intern B.
    const timeline = await asUser(internB, (tx) =>
      recentActivity(tx, { organizationId: orgId, limit: 50 }),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.actorUserId).toBe(internA);
    expect(timeline[0]!.notes).toMatch(/previous owner/i);
    // The actor is still attributed, but their name is not disclosed.
    expect(timeline[0]!.actorName).toBe('Another team member');
  });
});

describe('activity logging rules', () => {
  it('rejects a future timestamp', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    const error = await expectRejection(
      asUser(internA, (tx) =>
        logActivity(tx, {
          actorUserId: internA,
          actorRole: 'intern',
          organizationId: orgId,
          cohortId,
          actionType: 'email_initial',
          occurredAt: new Date(Date.now() + 3_600_000),
          outcome: 'sent',
        }),
      ),
    );
    expect(String(error)).toMatch(/future timestamp/i);
  });

  it('rejects backdating outside the cohort window', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    const error = await expectRejection(
      asUser(internA, (tx) =>
        logActivity(tx, {
          actorUserId: internA,
          actorRole: 'intern',
          organizationId: orgId,
          cohortId,
          actionType: 'email_initial',
          occurredAt: new Date('2025-01-01T12:00:00Z'),
          outcome: 'sent',
          cohortRange: cohortRange(cohort),
        }),
      ),
    );
    expect(String(error)).toMatch(/outside your cohort/i);
  });

  it('deduplicates a retried submit rather than double-counting', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const requestId = `req-${tag()}-${tag()}`;

    const first = await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        clientRequestId: requestId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    const second = await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        clientRequestId: requestId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    expect(second.deduplicated).toBe(true);
    expect(second.activityId).toBe(first.activityId);

    const rows = await asUser(
      internA,
      (tx) =>
        tx<{ c: string }[]>`
        SELECT count(*)::text AS c FROM activity_events
        WHERE organization_id = ${orgId} AND actor_user_id = ${internA}`,
    );
    expect(Number(rows[0]!.c)).toBe(1);
  });

  it('voiding removes the entry from metrics without deleting it', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const week1 = programWeek(cohort, 1);

    const before = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );

    const logged = await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    const during = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(during.emails).toBe(before.emails + 1);

    await asUser(internA, (tx) =>
      voidActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        activityId: logged.activityId,
        reason: 'Logged against the wrong club.',
      }),
    );

    const after = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(after.emails).toBe(before.emails);

    // The row is still there, with its reason.
    const [row] = await asUser(
      internA,
      (tx) =>
        tx<{ void_reason: string | null }[]>`
        SELECT void_reason FROM activity_events WHERE id = ${logged.activityId}`,
    );
    expect(row?.void_reason).toMatch(/wrong club/i);
  });

  it('makes logged activity immutable apart from voiding', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const logged = await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    const error = await expectRejection(
      asUser(
        internA,
        (tx) =>
          tx`UPDATE activity_events SET action_type = 'email_followup' WHERE id = ${logged.activityId}`,
      ),
    );
    expect(String(error)).toMatch(/immutable/i);
  });

  it('does not count research notes as outreach', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const week1 = programWeek(cohort, 1);
    const before = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );

    await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        cohortId,
        actionType: 'research_note',
        occurredAt: OCCURRED,
        outcome: 'logged',
        notes: 'Drafted an email but have not sent it yet.',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    const after = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(after.emails).toBe(before.emails);
    expect(after.linkedinRequests).toBe(before.linkedinRequests);
    expect(after.researchNotes).toBe(before.researchNotes + 1);
  });
});

describe('suppression', () => {
  it('blocks new outreach across assignees and survives reassignment', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    const contactId = await createContact({ organizationId: orgId, createdBy: admin });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    // Intern A records a do-not-contact outcome.
    await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        contactId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'do_not_contact',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    // A cannot log to that contact again.
    const errorForA = await expectRejection(
      asUser(internA, (tx) =>
        logActivity(tx, {
          actorUserId: internA,
          actorRole: 'intern',
          organizationId: orgId,
          contactId,
          cohortId,
          actionType: 'email_followup',
          occurredAt: OCCURRED,
          outcome: 'sent',
          now: new Date('2026-03-05T00:00:00Z'),
        }),
      ),
    );
    // The typed domain error, not a raw database message: the UI relies on
    // this to show an actionable explanation rather than "something failed".
    expect(errorForA).toBeInstanceOf(OutreachError);
    expect((errorForA as OutreachError).code).toBe('suppressed');
    expect(String(errorForA)).toMatch(/an admin must lift the suppression/i);

    // After reassignment, the new owner is blocked too.
    await asUser(admin, (tx) =>
      assignOrganization(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        organizationId: orgId,
        internUserId: internB,
        territoryOverrideReason: 'Suppression test',
      }),
    );
    const errorForB = await expectRejection(
      asUser(internB, (tx) =>
        logActivity(tx, {
          actorUserId: internB,
          actorRole: 'intern',
          organizationId: orgId,
          contactId,
          cohortId,
          actionType: 'email_initial',
          occurredAt: OCCURRED,
          outcome: 'sent',
          now: new Date('2026-03-05T00:00:00Z'),
        }),
      ),
    );
    expect(String(errorForB)).toMatch(/suppressed/i);

    // An admin lifting it restores logging.
    const [suppression] = await asUser(
      admin,
      (tx) =>
        tx<{ id: string }[]>`
        SELECT id FROM suppressions
        WHERE contact_id = ${contactId} AND lifted_at IS NULL LIMIT 1`,
    );
    await asUser(admin, (tx) =>
      liftSuppression(tx, {
        actorUserId: admin,
        suppressionId: suppression!.id,
        reason: 'Contact asked to be re-added.',
      }),
    );

    const ok = await asUser(internB, (tx) =>
      logActivity(tx, {
        actorUserId: internB,
        actorRole: 'intern',
        organizationId: orgId,
        contactId,
        cohortId,
        actionType: 'email_initial',
        occurredAt: OCCURRED,
        outcome: 'sent',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    expect(ok.activityId).toBeTruthy();
  });

  it('still allows a research note against a suppressed contact', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    const contactId = await createContact({ organizationId: orgId, createdBy: admin });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    await asUser(admin, (tx) =>
      applySuppression(tx, {
        actorUserId: admin,
        organizationId: orgId,
        contactId,
        channel: 'all',
        reason: 'Test suppression',
      }),
    );

    const note = await asUser(internA, (tx) =>
      logActivity(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        organizationId: orgId,
        contactId,
        cohortId,
        actionType: 'research_note',
        occurredAt: OCCURRED,
        outcome: 'logged',
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    expect(note.activityId).toBeTruthy();
  });
});

describe('LinkedIn prospects', () => {
  it('counts a connection request once and only once', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const week1 = programWeek(cohort, 1);

    const created = await asUser(internA, (tx) =>
      createProspect(tx, {
        actorUserId: internA,
        organizationId: orgId,
        fullName: 'Pat Director',
        profileUrl: `https://www.linkedin.com/in/pat-director-${tag()}`,
      }),
    );
    expect(created.status).toBe('created');
    const prospectId = created.status === 'created' ? created.prospectId : '';

    // Creating a prospect is research, not outreach.
    const afterCreate = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );

    await asUser(internA, (tx) =>
      recordConnectionRequest(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        prospectId,
        occurredAt: OCCURRED,
        cohortId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );

    const afterRequest = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(afterRequest.linkedinRequests).toBe(afterCreate.linkedinRequests + 1);

    // A second request for the same profile is rejected.
    const error = await expectRejection(
      asUser(internA, (tx) =>
        recordConnectionRequest(tx, {
          actorUserId: internA,
          actorRole: 'intern',
          prospectId,
          occurredAt: OCCURRED,
          cohortId,
          now: new Date('2026-03-05T00:00:00Z'),
        }),
      ),
    );
    expect(String(error)).toMatch(/already recorded/i);

    const stillOne = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(stillOne.linkedinRequests).toBe(afterRequest.linkedinRequests);
  });

  it('keeps acceptances and messages as separate, non-counting events', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });
    const week1 = programWeek(cohort, 1);

    const created = await asUser(internA, (tx) =>
      createProspect(tx, {
        actorUserId: internA,
        organizationId: orgId,
        fullName: 'Sam Chair',
        profileUrl: `https://www.linkedin.com/in/sam-chair-${tag()}`,
      }),
    );
    const prospectId = created.status === 'created' ? created.prospectId : '';

    await asUser(internA, (tx) =>
      recordConnectionRequest(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        prospectId,
        occurredAt: OCCURRED,
        cohortId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    const afterRequest = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );

    // Accepting the connection is not outreach at all.
    await asUser(internA, (tx) =>
      recordProspectEvent(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        prospectId,
        eventType: 'connected',
        occurredAt: OCCURRED,
        cohortId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    const afterConnected = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(afterConnected.linkedinRequests).toBe(afterRequest.linkedinRequests);

    // A message is logged as outreach but does not count as a new request.
    await asUser(internA, (tx) =>
      recordProspectEvent(tx, {
        actorUserId: internA,
        actorRole: 'intern',
        prospectId,
        eventType: 'message_sent',
        occurredAt: OCCURRED,
        cohortId,
        now: new Date('2026-03-05T00:00:00Z'),
      }),
    );
    const afterMessage = await asUser(internA, (tx) =>
      outreachTotals(tx, {
        actorUserId: internA,
        range: week1.range,
        policy: DEFAULT_METRIC_POLICY,
      }),
    );
    expect(afterMessage.linkedinRequests).toBe(afterRequest.linkedinRequests);
    expect(afterMessage.followUps).toBe(afterConnected.followUps + 1);
  });

  it('reports a cross-intern duplicate profile without leaking anything', async () => {
    const orgA = await createOrganization({ createdBy: admin, territoryId: east });
    const orgB = await createOrganization({ createdBy: admin, territoryId: west });
    await assignOrg({ organizationId: orgA, internUserId: internA, assignedBy: admin });
    await assignOrg({ organizationId: orgB, internUserId: internB, assignedBy: admin });

    const url = `https://www.linkedin.com/in/shared-${tag()}`;
    await asUser(internA, (tx) =>
      createProspect(tx, {
        actorUserId: internA,
        organizationId: orgA,
        fullName: 'Shared Person',
        profileUrl: url,
      }),
    );

    const collision = await asUser(internB, (tx) =>
      createProspect(tx, {
        actorUserId: internB,
        organizationId: orgB,
        fullName: 'Shared Person',
        // Different casing and a tracking parameter: still the same profile.
        profileUrl: `${url.toUpperCase().replace('HTTPS://WWW.LINKEDIN.COM/IN/', 'https://www.linkedin.com/in/')}?utm_source=x`,
      }),
    );
    expect(collision.status).toBe('collision');
    if (collision.status === 'collision') {
      expect(Object.keys(collision).sort()).toEqual(['profileUrl', 'status']);
    }
  });

  it('rejects an unsafe or non-profile URL', async () => {
    const orgId = await createOrganization({ createdBy: admin, territoryId: east });
    await assignOrg({ organizationId: orgId, internUserId: internA, assignedBy: admin });

    for (const bad of [
      'https://linkedin.com.evil.example/in/someone',
      'javascript:alert(1)',
      'https://www.linkedin.com/company/waresport',
    ]) {
      const error = await expectRejection(
        asUser(internA, (tx) =>
          createProspect(tx, {
            actorUserId: internA,
            organizationId: orgId,
            fullName: 'Bad Link',
            profileUrl: bad,
          }),
        ),
      );
      expect(String(error), bad).toMatch(/LinkedIn|valid|profile|protocol/i);
    }
  });
});
