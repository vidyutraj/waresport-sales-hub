import { beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '@/lib/db';
import {
  addMembership,
  createCohort,
  createMeeting,
  createOrganization,
  createUser,
  ensureTerritory,
  expectRejection,
  tag,
} from './factories';
import { compensationFor } from '@/lib/queries/metrics';
import {
  changeAttribution,
  recordPayout,
  revertVerification,
  submitHeld,
  verifyHeld,
} from '@/lib/services/meetings';
import { cohortRange, type Cohort } from '@/lib/domain/program';

/**
 * Compensation correctness against the real database.
 *
 * These exercise the whole path: a meeting is booked, submitted, verified by an
 * admin, and only then counts. Payouts are recorded, reversed and raced.
 */

let owner: string;
let admin: string;
let intern: string;
let otherIntern: string;
let cohortId: string;
let cohort: Cohort;
let range: { start: Date; end: Date };

/** Inside the cohort window (starts 2026-03-02, runs 12 weeks). */
const HELD_AT = new Date('2026-03-10T15:00:00Z');

beforeAll(async () => {
  owner = await createUser({ role: 'owner' });
  admin = await createUser({ role: 'admin' });
  intern = await createUser({ role: 'intern', fullName: 'Comp Intern' });
  otherIntern = await createUser({ role: 'intern', fullName: 'Other Intern' });
  const east = await ensureTerritory('EAST', 'East');
  cohortId = await createCohort({
    name: `Comp cohort ${tag()}`,
    startDate: '2026-03-02',
    createdBy: owner,
  });
  cohort = {
    id: cohortId,
    name: 'Comp cohort',
    startDate: '2026-03-02',
    weeksCount: 12,
    reportingTimezone: 'America/New_York',
  };
  range = cohortRange(cohort);
  for (const id of [intern, otherIntern]) {
    await addMembership({ userId: id, cohortId, territoryId: east, joinedOn: '2026-03-02' });
  }
});

async function comp(userId: string) {
  return asUser(admin, (tx) => compensationFor(tx, { userId, cohortId, cohortRange: range }));
}

async function addVerified(userId: string, count: number, heldAt = HELD_AT): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const orgId = await createOrganization({ createdBy: admin });
    const meetingId = await createMeeting({
      organizationId: orgId,
      creditedUserId: userId,
      cohortId,
      status: 'pending_verification',
      heldAt,
    });
    await asUser(admin, (tx) =>
      verifyHeld(tx, { actorUserId: admin, actorRole: 'admin', meetingId }),
    );
    ids.push(meetingId);
  }
  return ids;
}

describe('only verified held meetings earn anything', () => {
  it('excludes scheduled, pending, cancelled and no-show meetings', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    for (const status of ['scheduled', 'pending_verification', 'cancelled', 'no_show'] as const) {
      const orgId = await createOrganization({ createdBy: admin });
      await createMeeting({
        organizationId: orgId,
        creditedUserId: user,
        cohortId,
        status,
        heldAt: status === 'pending_verification' ? HELD_AT : null,
      });
    }

    const summary = await comp(user);
    expect(summary.verifiedHeldCount).toBe(0);
    expect(summary.earnedCents).toBe(0);
    expect(summary.pendingVerificationCount).toBe(1);
  });
});

describe('milestones across the cohort', () => {
  it('reaches $100 at exactly ten verified meetings, not before', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    await addVerified(user, 9);
    const at9 = await comp(user);
    expect(at9.verifiedHeldCount).toBe(9);
    expect(at9.earnedCents).toBe(0);
    expect(at9.meetingsUntilNextMilestone).toBe(1);

    await addVerified(user, 1);
    const at10 = await comp(user);
    expect(at10.earnedCents).toBe(10_000);
    expect(at10.progressTowardNext).toBe(0);
    expect(at10.meetingsUntilNextMilestone).toBe(10);
  });

  it('accumulates and never resets between weeks', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    // Ten meetings in program week 2, ten more in week 7.
    await addVerified(user, 10, new Date('2026-03-10T15:00:00Z'));
    const afterWeek2 = await comp(user);
    expect(afterWeek2.earnedCents).toBe(10_000);

    await addVerified(user, 10, new Date('2026-04-15T15:00:00Z'));
    const afterWeek7 = await comp(user);
    expect(afterWeek7.verifiedHeldCount).toBe(20);
    expect(afterWeek7.earnedCents).toBe(20_000);
    expect(afterWeek7.meetingsUntilNextMilestone).toBe(10);
  });
});

describe('eligibility window', () => {
  it('counts a meeting by its held date, not by when it was approved', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    // Held inside the cohort; approved much later (approval time is "now").
    await addVerified(user, 1, new Date('2026-03-05T12:00:00Z'));
    expect((await comp(user)).verifiedHeldCount).toBe(1);
  });

  it('excludes a meeting held outside the cohort unless an admin overrides', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    // 2026-01-05 is well before the 2026-03-02 cohort start.
    const orgId = await createOrganization({ createdBy: admin });
    const meetingId = await createMeeting({
      organizationId: orgId,
      creditedUserId: user,
      cohortId,
      status: 'pending_verification',
      heldAt: new Date('2026-01-05T15:00:00Z'),
    });
    await asUser(admin, (tx) =>
      verifyHeld(tx, { actorUserId: admin, actorRole: 'admin', meetingId }),
    );
    expect((await comp(user)).verifiedHeldCount).toBe(0);

    // With an explicit, recorded exception it counts.
    await asUser(admin, (tx) =>
      verifyHeld(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        meetingId,
        eligibilityOverrideReason: 'Pre-program pilot call agreed with the founder.',
      }),
    );
    expect((await comp(user)).verifiedHeldCount).toBe(1);
  });
});

describe('payouts', () => {
  it('cannot be recorded twice for the same milestone, even concurrently', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    await addVerified(user, 10);

    // Two simultaneous "mark paid" requests for milestone 1.
    const results = await Promise.allSettled([
      asUser(admin, (tx) =>
        recordPayout(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          userId: user,
          cohortId,
          cohortRange: range,
          milestoneIndex: 1,
          paidOn: '2026-03-20',
        }),
      ),
      asUser(admin, (tx) =>
        recordPayout(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          userId: user,
          cohortId,
          cohortRange: range,
          milestoneIndex: 1,
          paidOn: '2026-03-20',
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const summary = await comp(user);
    expect(summary.paidCents).toBe(10_000);
    expect(summary.paidMilestoneIndices).toEqual([1]);
    expect(summary.balanceCents).toBe(0);
  });

  it('refuses an unearned milestone', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    await addVerified(user, 5);

    const error = await expectRejection(
      asUser(admin, (tx) =>
        recordPayout(tx, {
          actorUserId: admin,
          actorRole: 'admin',
          userId: user,
          cohortId,
          cohortRange: range,
          milestoneIndex: 1,
          paidOn: '2026-03-20',
        }),
      ),
    );
    expect(String(error)).toMatch(/has not been earned yet/i);
  });
});

describe('reversing a verification', () => {
  it('recalculates earnings but never erases a recorded payout', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    const meetingIds = await addVerified(user, 10);

    await asUser(admin, (tx) =>
      recordPayout(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        userId: user,
        cohortId,
        cohortRange: range,
        milestoneIndex: 1,
        paidOn: '2026-03-20',
        reference: 'BANK-123',
      }),
    );
    expect((await comp(user)).balanceCents).toBe(0);

    const result = await asUser(admin, (tx) =>
      revertVerification(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        meetingId: meetingIds[0]!,
        reason: 'Prospect confirmed the call never happened.',
        cohortRange: range,
      }),
    );
    expect(result.overpaymentCents).toBe(10_000);

    const after = await comp(user);
    expect(after.verifiedHeldCount).toBe(9);
    expect(after.earnedCents).toBe(0);
    // The payment record survives.
    expect(after.paidCents).toBe(10_000);
    expect(after.balanceCents).toBe(-10_000);
    expect(after.overpaidCents).toBe(10_000);
    // ...and the shortfall is recorded separately rather than hidden.
    expect(after.unresolvedOverpaymentCents).toBe(-10_000);
  });

  it('reverting before any payout simply lowers the earned total', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    const meetingIds = await addVerified(user, 10);

    const result = await asUser(admin, (tx) =>
      revertVerification(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        meetingId: meetingIds[0]!,
        reason: 'Duplicate record.',
        cohortRange: range,
      }),
    );
    expect(result.overpaymentCents).toBe(0);
    const after = await comp(user);
    expect(after.earnedCents).toBe(0);
    expect(after.paidCents).toBe(0);
    expect(after.overpaidCents).toBe(0);
  });
});

describe('attribution', () => {
  it('follows the credited intern, not the club assignment', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });

    const orgId = await createOrganization({ createdBy: admin });
    const meetingId = await createMeeting({
      organizationId: orgId,
      creditedUserId: user,
      cohortId,
      status: 'pending_verification',
      heldAt: HELD_AT,
    });
    await asUser(admin, (tx) =>
      verifyHeld(tx, { actorUserId: admin, actorRole: 'admin', meetingId }),
    );
    expect((await comp(user)).verifiedHeldCount).toBe(1);

    // Reassigning the club to another intern must not move the credit.
    await asUser(
      admin,
      (tx) =>
        tx`UPDATE organization_assignments SET unassigned_at = now()
         WHERE organization_id = ${orgId} AND unassigned_at IS NULL`,
    );
    await asUser(
      admin,
      (tx) =>
        tx`INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by)
         VALUES (${orgId}, ${otherIntern}, ${admin})`,
    );
    expect((await comp(user)).verifiedHeldCount).toBe(1);
    expect((await comp(otherIntern)).verifiedHeldCount).toBe(0);
  });

  it('moves credit only through an explicit, audited admin change', async () => {
    const from = await createUser({ role: 'intern' });
    const to = await createUser({ role: 'intern' });
    await addMembership({ userId: from, cohortId, joinedOn: '2026-03-02' });
    await addMembership({ userId: to, cohortId, joinedOn: '2026-03-02' });

    const meetingIds = await addVerified(from, 1);
    await asUser(admin, (tx) =>
      changeAttribution(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        meetingId: meetingIds[0]!,
        newCreditedUserId: to,
        reason: 'Booked by the wrong intern in error.',
      }),
    );

    expect((await comp(from)).verifiedHeldCount).toBe(0);
    expect((await comp(to)).verifiedHeldCount).toBe(1);

    const audit = await asUser(
      admin,
      (tx) =>
        tx<{ reason: string | null }[]>`
        SELECT reason FROM audit_events
        WHERE action = 'meeting.attribution_changed' AND entity_id = ${meetingIds[0]!}`,
    );
    expect(audit[0]?.reason).toMatch(/wrong intern/i);
  });
});

describe('an intern reading their own ledger', () => {
  it('sees payouts an admin recorded for them', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    await addVerified(user, 10);
    await asUser(admin, (tx) =>
      recordPayout(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        userId: user,
        cohortId,
        cohortRange: range,
        milestoneIndex: 1,
        paidOn: '2026-03-20',
        reference: 'BANK-LEDGER-1',
      }),
    );

    // The intern may read their own payout but not the admin who recorded it;
    // the ledger must still list the row, with a neutral recorder label.
    const { listPayouts } = await import('@/lib/services/meetings');
    const rows = await asUser(user, (tx) => listPayouts(tx, { userId: user, cohortId }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reference).toBe('BANK-LEDGER-1');
    expect(rows[0]!.recordedByName).toBe('A Waresport admin');
  });
});

describe('held-time validation', () => {
  it('rejects a held time in the future', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    const orgId = await createOrganization({ createdBy: admin });
    const meetingId = await createMeeting({
      organizationId: orgId,
      creditedUserId: user,
      cohortId,
      status: 'scheduled',
    });

    const error = await expectRejection(
      asUser(admin, (tx) =>
        submitHeld(tx, {
          actorUserId: admin,
          meetingId,
          heldAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    );
    expect(String(error)).toMatch(/cannot be recorded as held in the future/i);
  });
});

describe('rescheduling', () => {
  it('never creates a second payable meeting', async () => {
    const user = await createUser({ role: 'intern' });
    await addMembership({ userId: user, cohortId, joinedOn: '2026-03-02' });
    const orgId = await createOrganization({ createdBy: admin });
    const meetingId = await createMeeting({
      organizationId: orgId,
      creditedUserId: user,
      cohortId,
      status: 'scheduled',
    });

    const { rescheduleMeeting } = await import('@/lib/services/meetings');
    await asUser(admin, (tx) =>
      rescheduleMeeting(tx, {
        actorUserId: admin,
        meetingId,
        scheduledStartAt: new Date('2026-03-18T16:00:00Z'),
        reason: 'Prospect asked to move it.',
      }),
    );

    const rows = await asUser(
      admin,
      (tx) =>
        tx<
          { c: string }[]
        >`SELECT count(*)::text AS c FROM meetings WHERE organization_id = ${orgId}`,
    );
    expect(Number(rows[0]!.c)).toBe(1);

    await asUser(admin, (tx) => submitHeld(tx, { actorUserId: admin, meetingId, heldAt: HELD_AT }));
    await asUser(admin, (tx) =>
      verifyHeld(tx, { actorUserId: admin, actorRole: 'admin', meetingId }),
    );
    expect((await comp(user)).verifiedHeldCount).toBe(1);
  });
});
