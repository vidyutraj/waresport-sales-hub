import { beforeAll, describe, expect, it } from 'vitest';
import { asAnonymous, asSystem, asUser } from '@/lib/db';
import {
  addMembership,
  as,
  assignOrg,
  createCohort,
  createContact,
  createOrganization,
  createUser,
  ensureTerritory,
  expectRejection,
  pgCode,
  tag,
} from './factories';
import { setUserRole, setWeeklyTarget, AdminError } from '@/lib/services/admin';
import { verifyHeld, recordPayout } from '@/lib/services/meetings';
import { createMeeting } from './factories';
import { cohortRange } from '@/lib/domain/program';

/**
 * Authorization boundary tests.
 *
 * These run against real PostgreSQL row level security through the
 * `waresport_app` role, which is not a table owner and has NOBYPASSRLS. There
 * is no mocking: an intern here is exactly as privileged as an intern in
 * production, so a forged id or a direct API call is tested for real.
 */

let owner: string;
let admin: string;
let internA: string;
let internB: string;
let inactiveIntern: string;
let cohortId: string;
let east: string;
let orgOfA: string;
let contactOfA: string;
let orgOfB: string;

beforeAll(async () => {
  owner = await createUser({ role: 'owner' });
  admin = await createUser({ role: 'admin' });
  internA = await createUser({ role: 'intern', fullName: 'Intern A' });
  internB = await createUser({ role: 'intern', fullName: 'Intern B' });
  inactiveIntern = await createUser({ role: 'intern', status: 'deactivated' });

  east = await ensureTerritory('EAST', 'East');
  cohortId = await createCohort({ startDate: '2026-03-02', createdBy: owner });
  for (const id of [internA, internB, inactiveIntern]) {
    await addMembership({ userId: id, cohortId, territoryId: east, joinedOn: '2026-03-02' });
  }

  orgOfA = await createOrganization({
    name: `A Club ${tag()}`,
    createdBy: admin,
    territoryId: east,
  });
  contactOfA = await createContact({ organizationId: orgOfA, createdBy: admin });
  orgOfB = await createOrganization({
    name: `B Club ${tag()}`,
    createdBy: admin,
    territoryId: east,
  });

  await assignOrg({ organizationId: orgOfA, internUserId: internA, assignedBy: admin });
  await assignOrg({ organizationId: orgOfB, internUserId: internB, assignedBy: admin });
});

describe('anonymous access', () => {
  it('sees no organizations, contacts or users', async () => {
    const rows = await asAnonymous(async (tx) => ({
      organizations: await tx`SELECT id FROM organizations`,
      contacts: await tx`SELECT id FROM contacts`,
      users: await tx`SELECT id FROM users`,
      meetings: await tx`SELECT id FROM meetings`,
      payouts: await tx`SELECT id FROM payout_ledger`,
    }));
    expect(rows.organizations).toHaveLength(0);
    expect(rows.contacts).toHaveLength(0);
    expect(rows.users).toHaveLength(0);
    expect(rows.meetings).toHaveLength(0);
    expect(rows.payouts).toHaveLength(0);
  });

  it('cannot reach authentication tables at all', async () => {
    const error = await expectRejection(asAnonymous((tx) => tx`SELECT * FROM sessions`));
    // 42501 = insufficient_privilege: the grant itself was revoked.
    expect(pgCode(error)).toBe('42501');
  });
});

describe('a deactivated account', () => {
  it('sees nothing, even with a valid user id pinned', async () => {
    const rows = await as(inactiveIntern, async (tx) => ({
      organizations: await tx`SELECT id FROM organizations`,
      followUps: await tx`SELECT id FROM follow_ups`,
    }));
    expect(rows.organizations).toHaveLength(0);
    expect(rows.followUps).toHaveLength(0);
  });

  it('cannot log activity', async () => {
    const error = await expectRejection(
      as(
        inactiveIntern,
        (tx) =>
          tx`INSERT INTO activity_events
             (organization_id, actor_user_id, channel, action_type, occurred_at, outcome)
           VALUES (${orgOfB}, ${inactiveIntern}, 'email', 'email_initial', now(), 'sent')`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });
});

describe('intern A cannot reach intern B', () => {
  it('cannot read an unassigned club by forging its id', async () => {
    const rows = await as(internA, (tx) => tx`SELECT id FROM organizations WHERE id = ${orgOfB}`);
    expect(rows).toHaveLength(0);
  });

  it('cannot read another club’s contacts', async () => {
    const rows = await as(
      internA,
      (tx) => tx`SELECT id FROM contacts WHERE organization_id = ${orgOfB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot browse the unassigned lead pool', async () => {
    const unassigned = await createOrganization({ name: `Pool ${tag()}`, createdBy: admin });
    const rows = await as(
      internA,
      (tx) => tx`SELECT id FROM organizations WHERE id = ${unassigned}`,
    );
    expect(rows).toHaveLength(0);
    // ...and cannot claim it by inserting an assignment for themselves.
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by)
           VALUES (${unassigned}, ${internA}, ${internA})`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot see another intern’s profile row', async () => {
    const rows = await as(internA, (tx) => tx`SELECT id FROM users WHERE id = ${internB}`);
    expect(rows).toHaveLength(0);
  });

  it('cannot write activity attributed to another intern', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO activity_events
             (organization_id, actor_user_id, channel, action_type, occurred_at, outcome)
           VALUES (${orgOfA}, ${internB}, 'email', 'email_initial', now(), 'sent')`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot log activity against a club it does not own', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO activity_events
             (organization_id, actor_user_id, channel, action_type, occurred_at, outcome)
           VALUES (${orgOfB}, ${internA}, 'email', 'email_initial', now(), 'sent')`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot read another intern’s follow-ups or meetings', async () => {
    await asUser(
      admin,
      (tx) =>
        tx`INSERT INTO follow_ups (organization_id, assigned_user_id, due_on)
         VALUES (${orgOfB}, ${internB}, current_date)`,
    );
    const meetingId = await createMeeting({
      organizationId: orgOfB,
      creditedUserId: internB,
      cohortId,
    });
    const rows = await as(internA, async (tx) => ({
      followUps: await tx`SELECT id FROM follow_ups WHERE assigned_user_id = ${internB}`,
      meetings: await tx`SELECT id FROM meetings WHERE id = ${meetingId}`,
    }));
    expect(rows.followUps).toHaveLength(0);
    expect(rows.meetings).toHaveLength(0);
  });

  it('cannot read another intern’s payouts', async () => {
    await asUser(
      admin,
      (tx) =>
        tx`INSERT INTO payout_ledger (user_id, cohort_id, milestone_index, amount_cents, paid_on, recorded_by)
         VALUES (${internB}, ${cohortId}, 1, 10000, current_date, ${admin})`,
    );
    const rows = await as(
      internA,
      (tx) => tx`SELECT id FROM payout_ledger WHERE user_id = ${internB}`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('interns cannot perform admin-only actions', () => {
  it('cannot escalate their own role', async () => {
    const error = await expectRejection(
      as(internA, (tx) => tx`UPDATE users SET role = 'admin' WHERE id = ${internA}`),
    );
    // The privilege trigger fires before RLS can silently no-op it.
    expect(String(error)).toMatch(/only an owner may change roles/i);
  });

  it('cannot activate or deactivate an account', async () => {
    const error = await expectRejection(
      as(internA, (tx) => tx`UPDATE users SET status = 'deactivated' WHERE id = ${internA}`),
    );
    expect(String(error)).toMatch(/only an admin may change account status/i);
  });

  it('cannot set their own outreach address', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`UPDATE users SET waresport_outreach_email = 'fake@waresport.com' WHERE id = ${internA}`,
      ),
    );
    expect(String(error)).toMatch(/only an admin/i);
  });

  it('cannot change their own targets', async () => {
    const error = await expectRejection(
      as(internA, (tx) =>
        setWeeklyTarget(tx, {
          actorUserId: internA,
          actorRole: 'admin',
          cohortId,
          userId: internA,
          weekNumber: 1,
          emailTarget: 1,
          linkedinTarget: 1,
          emailDailyPace: 1,
          linkedinDailyPace: 1,
        }),
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot import leads', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO import_batches (filename, file_hash, file_bytes, uploaded_by, idempotency_key)
           VALUES ('x.csv', 'h', 1, ${internA}, ${tag()})`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot verify a meeting, even one credited to themselves', async () => {
    const meetingId = await createMeeting({
      organizationId: orgOfA,
      creditedUserId: internA,
      cohortId,
      status: 'pending_verification',
      heldAt: new Date(Date.now() - 3_600_000),
    });
    const error = await expectRejection(
      as(internA, (tx) =>
        verifyHeld(tx, {
          actorUserId: internA,
          actorRole: 'admin',
          meetingId,
        }),
      ),
    );
    expect(String(error)).toMatch(/only an admin or owner may verify/i);
  });

  it('cannot record a payout', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO payout_ledger (user_id, cohort_id, milestone_index, amount_cents, paid_on, recorded_by)
           VALUES (${internA}, ${cohortId}, 9, 10000, current_date, ${internA})`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot assign clubs to themselves or anyone else', async () => {
    const error = await expectRejection(
      as(
        internA,
        (tx) =>
          tx`INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by)
           VALUES (${orgOfB}, ${internA}, ${internA})`,
      ),
    );
    expect(pgCode(error)).toBe('42501');
  });

  it('cannot read the audit log', async () => {
    const rows = await as(internA, (tx) => tx`SELECT id FROM audit_events`);
    expect(rows).toHaveLength(0);
  });

  it('cannot lift a suppression', async () => {
    const [suppression] = await asUser(
      admin,
      (tx) =>
        tx<{ id: string }[]>`
        INSERT INTO suppressions (scope, organization_id, contact_id, channel, reason, created_by)
        VALUES ('contact', ${orgOfA}, ${contactOfA}, 'email', 'test', ${admin})
        RETURNING id`,
    );
    const updated = await as(
      internA,
      (tx) =>
        tx`UPDATE suppressions SET lifted_at = now(), lift_reason = 'x' WHERE id = ${suppression!.id}
         RETURNING id`,
    );
    // RLS makes the UPDATE match zero rows rather than raising.
    expect(updated).toHaveLength(0);
  });
});

describe('admins cannot perform owner-only actions', () => {
  it('cannot grant the admin role', async () => {
    const error = await expectRejection(
      as(admin, (tx) =>
        setUserRole(tx, {
          actorUserId: admin,
          userId: internA,
          role: 'admin',
          reason: 'test escalation attempt',
        }),
      ),
    );
    expect(String(error)).toMatch(/only an owner may change roles/i);
  });

  it('cannot demote the owner', async () => {
    const error = await expectRejection(
      as(admin, (tx) => tx`UPDATE users SET role = 'intern' WHERE id = ${owner}`),
    );
    expect(String(error)).toMatch(/only an owner may change roles/i);
  });
});

describe('the workspace always keeps an owner', () => {
  it('refuses to demote the last active owner', async () => {
    // This test database may contain other owners from other suites, so make a
    // dedicated one-owner world by checking the guard directly on a sole owner.
    const soleOwner = await createUser({ role: 'owner' });
    const others = await asUser(
      soleOwner,
      (tx) =>
        tx<
          { id: string }[]
        >`SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND id <> ${soleOwner}`,
    );
    // Deactivate every other owner so `soleOwner` really is the last one.
    for (const other of others) {
      await asUser(
        soleOwner,
        (tx) => tx`UPDATE users SET status = 'deactivated' WHERE id = ${other.id}`,
      );
    }

    const error = await expectRejection(
      asUser(
        soleOwner,
        (tx) => tx`UPDATE users SET status = 'deactivated' WHERE id = ${soleOwner}`,
      ),
    );
    expect(String(error)).toMatch(/last active owner/i);

    // Restore the other owners so later suites still work.
    for (const other of others) {
      await asUser(
        soleOwner,
        (tx) => tx`UPDATE users SET status = 'active' WHERE id = ${other.id}`,
      );
    }
  });
});

describe('the audit log is append-only', () => {
  it('is unwritable through RLS and unwritable at the table level', async () => {
    const marker = tag();
    await asUser(
      owner,
      (tx) =>
        tx`INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id)
         VALUES (${owner}, 'test.event', 'test', ${marker})`,
    );

    // Layer 1: the application role has no UPDATE/DELETE policy, so the
    // statement matches nothing rather than rewriting history.
    const updated = await asUser(
      owner,
      (tx) =>
        tx`UPDATE audit_events SET action = 'tampered' WHERE entity_id = ${marker} RETURNING id`,
    );
    expect(updated).toHaveLength(0);

    // Layer 2: even the table owner is refused by the immutability trigger.
    const ownerError = await expectRejection(
      asSystem((tx) => tx`UPDATE audit_events SET action = 'tampered' WHERE entity_id = ${marker}`),
    );
    expect(String(ownerError)).toMatch(/append-only/i);

    const deleteError = await expectRejection(
      asSystem((tx) => tx`DELETE FROM audit_events WHERE entity_id = ${marker}`),
    );
    expect(String(deleteError)).toMatch(/append-only/i);

    const [still] = await asSystem(
      (tx) => tx<{ action: string }[]>`SELECT action FROM audit_events WHERE entity_id = ${marker}`,
    );
    expect(still?.action).toBe('test.event');
  });
});

describe('admin capabilities', () => {
  it('can read every intern and organization', async () => {
    const rows = await asUser(admin, async (tx) => ({
      users: await tx`SELECT id FROM users WHERE id IN (${internA}, ${internB})`,
      organizations: await tx`SELECT id FROM organizations WHERE id IN (${orgOfA}, ${orgOfB})`,
    }));
    expect(rows.users).toHaveLength(2);
    expect(rows.organizations).toHaveLength(2);
  });

  it('can verify a meeting and record the resulting payout', async () => {
    const heldAt = new Date('2026-03-10T15:00:00Z');
    const cohort = {
      id: cohortId,
      name: 'x',
      startDate: '2026-03-02',
      weeksCount: 12,
      reportingTimezone: 'America/New_York',
    };

    for (let i = 0; i < 10; i += 1) {
      const orgId = await createOrganization({ createdBy: admin });
      const meetingId = await createMeeting({
        organizationId: orgId,
        creditedUserId: internA,
        cohortId,
        status: 'pending_verification',
        heldAt,
      });
      await asUser(admin, (tx) =>
        verifyHeld(tx, { actorUserId: admin, actorRole: 'admin', meetingId }),
      );
    }

    const payout = await asUser(admin, (tx) =>
      recordPayout(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        userId: internA,
        cohortId,
        cohortRange: cohortRange(cohort),
        milestoneIndex: 1,
        paidOn: '2026-03-20',
      }),
    );
    expect(payout.amountCents).toBe(10_000);
  });

  it('cannot record an unearned milestone', async () => {
    const cohort = {
      id: cohortId,
      name: 'x',
      startDate: '2026-03-02',
      weeksCount: 12,
      reportingTimezone: 'America/New_York',
    };
    const error = await expectRejection(
      asUser(admin, (tx) =>
        recordPayout(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          userId: internA,
          cohortId,
          cohortRange: cohortRange(cohort),
          milestoneIndex: 9,
          paidOn: '2026-03-20',
        }),
      ),
    );
    expect(String(error)).toMatch(/has not been earned yet/i);
  });
});

describe('AdminError surface', () => {
  it('is a distinguishable error type', () => {
    const error = new AdminError('nope', 'not_permitted');
    expect(error.name).toBe('AdminError');
    expect(error.code).toBe('not_permitted');
  });
});
