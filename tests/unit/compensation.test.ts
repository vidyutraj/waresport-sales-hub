import { describe, expect, it } from 'vitest';
import {
  canRecordPayout,
  computeCompensation,
  formatCents,
  MILESTONE_AMOUNT_CENTS,
  milestoneHeadline,
  unpaidMilestoneIndices,
} from '@/lib/domain/compensation';

describe('compensation milestones', () => {
  it('matches the worked examples in the brief', () => {
    const cases: [number, number, number][] = [
      // [verified held, earned dollars, meetings until next milestone]
      [0, 0, 10],
      [9, 0, 1],
      [10, 100, 10],
      [19, 100, 1],
      [20, 200, 10],
      [30, 300, 10],
    ];
    for (const [held, dollars, remaining] of cases) {
      const s = computeCompensation({ verifiedHeldCount: held, paidCents: 0 });
      expect(s.earnedCents, `H=${held} earned`).toBe(dollars * 100);
      expect(s.meetingsUntilNextMilestone, `H=${held} remaining`).toBe(remaining);
    }
  });

  it('reports progress toward the next milestone as H mod 10', () => {
    expect(computeCompensation({ verifiedHeldCount: 0, paidCents: 0 }).progressTowardNext).toBe(0);
    expect(computeCompensation({ verifiedHeldCount: 7, paidCents: 0 }).progressTowardNext).toBe(7);
    expect(computeCompensation({ verifiedHeldCount: 10, paidCents: 0 }).progressTowardNext).toBe(0);
    expect(computeCompensation({ verifiedHeldCount: 23, paidCents: 0 }).progressTowardNext).toBe(3);
  });

  it('never shows a misleading zero-earned state at exactly ten meetings', () => {
    const s = computeCompensation({ verifiedHeldCount: 10, paidCents: 0 });
    expect(s.earnedMilestones).toBe(1);
    expect(milestoneHeadline(s)).toBe('$100 earned; 0/10 toward your next $100');
  });

  it('describes the first milestone before anything is earned', () => {
    expect(milestoneHeadline(computeCompensation({ verifiedHeldCount: 9, paidCents: 0 }))).toBe(
      '1 more verified meeting to your first $100',
    );
    expect(milestoneHeadline(computeCompensation({ verifiedHeldCount: 0, paidCents: 0 }))).toBe(
      '10 more verified meetings to your first $100',
    );
  });

  it('uses integer cents throughout', () => {
    expect(MILESTONE_AMOUNT_CENTS).toBe(10_000);
    expect(computeCompensation({ verifiedHeldCount: 37, paidCents: 0 }).earnedCents).toBe(30_000);
  });

  it('treats negative or fractional inputs defensively', () => {
    expect(computeCompensation({ verifiedHeldCount: -4, paidCents: 0 }).earnedCents).toBe(0);
    expect(computeCompensation({ verifiedHeldCount: 10.9, paidCents: 0 }).earnedMilestones).toBe(1);
  });
});

describe('balance and reconciliation', () => {
  it('computes balance as earned minus paid', () => {
    const s = computeCompensation({ verifiedHeldCount: 25, paidCents: 10_000 });
    expect(s.earnedCents).toBe(20_000);
    expect(s.paidCents).toBe(10_000);
    expect(s.balanceCents).toBe(10_000);
    expect(s.overpaidCents).toBe(0);
  });

  it('surfaces an overpayment separately instead of hiding a negative balance', () => {
    // A verification was reversed after a payout had already been recorded.
    const s = computeCompensation({ verifiedHeldCount: 9, paidCents: 10_000 });
    expect(s.earnedCents).toBe(0);
    expect(s.balanceCents).toBe(-10_000);
    expect(s.overpaidCents).toBe(10_000);
  });

  it('does not erase historical payouts when earnings drop', () => {
    const before = computeCompensation({ verifiedHeldCount: 20, paidCents: 20_000 });
    const after = computeCompensation({ verifiedHeldCount: 19, paidCents: 20_000 });
    expect(before.balanceCents).toBe(0);
    expect(after.paidCents).toBe(20_000);
    expect(after.earnedCents).toBe(10_000);
    expect(after.overpaidCents).toBe(10_000);
  });
});

describe('payout eligibility guards', () => {
  it('lists earned but unpaid milestones in order', () => {
    expect(unpaidMilestoneIndices(3, [1])).toEqual([2, 3]);
    expect(unpaidMilestoneIndices(3, [1, 2, 3])).toEqual([]);
    expect(unpaidMilestoneIndices(0, [])).toEqual([]);
  });

  it('refuses to pay an unearned milestone', () => {
    expect(canRecordPayout(1, 2, [])).toEqual({
      ok: false,
      reason: 'Milestone 2 has not been earned yet (1 milestone earned).',
    });
    expect(canRecordPayout(0, 1, [])).toMatchObject({ ok: false });
  });

  it('refuses to pay the same milestone twice', () => {
    expect(canRecordPayout(2, 1, [1])).toEqual({
      ok: false,
      reason: 'Milestone 1 is already recorded as paid.',
    });
  });

  it('accepts a genuinely earned, unpaid milestone', () => {
    expect(canRecordPayout(2, 2, [1])).toEqual({ ok: true });
  });

  it('rejects nonsense milestone indices', () => {
    expect(canRecordPayout(5, 0, [])).toMatchObject({ ok: false });
    expect(canRecordPayout(5, -1, [])).toMatchObject({ ok: false });
    expect(canRecordPayout(5, 1.5, [])).toMatchObject({ ok: false });
  });
});

describe('currency formatting', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCents(0)).toBe('$0');
    expect(formatCents(10_000)).toBe('$100');
    expect(formatCents(123_400)).toBe('$1,234');
  });

  it('formats partial dollars and negatives', () => {
    expect(formatCents(10_050)).toBe('$100.50');
    expect(formatCents(-10_000)).toBe('−$100');
  });
});
