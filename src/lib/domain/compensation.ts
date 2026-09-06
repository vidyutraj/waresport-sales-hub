/**
 * Compensation model, from the program guide:
 *
 *   "For every 10 meetings that are booked and actually take place, you earn
 *    $100 — and your total builds throughout the internship rather than
 *    resetting week to week."
 *
 * Implementation defaults (documented in docs/assumptions.md, not claims about
 * the PDF):
 *  - "actually take place" is operationalised as a meeting an admin or owner
 *    has moved to `verified_held`.
 *  - Eligibility is by the meeting's *held date* falling inside the credited
 *    intern's cohort window — not by when an admin got around to approving it.
 *    An admin may record an explicit exception with a reason.
 *  - Scheduled, pending, cancelled and no-show meetings are worth nothing.
 *  - Counts never reset: not weekly, not on sign-out, not on reassignment.
 */

export const MEETINGS_PER_MILESTONE = 10;
export const MILESTONE_AMOUNT_CENTS = 10_000; // $100.00 USD
export const CURRENCY = 'USD' as const;

export type CompensationInput = {
  /** Eligible verified-held meeting count for this intern in this cohort. */
  verifiedHeldCount: number;
  /** Sum of non-voided payout ledger entries, in cents. */
  paidCents: number;
};

export type CompensationSummary = {
  verifiedHeldCount: number;
  earnedMilestones: number;
  earnedCents: number;
  paidCents: number;
  /** earned − paid. Negative means more was paid out than is now earned. */
  balanceCents: number;
  /** Set when a verification reversal left the intern overpaid. */
  overpaidCents: number;
  /** Meetings counted toward the milestone in progress: H mod 10. */
  progressTowardNext: number;
  /** Meetings still needed for the next $100. Always 1..10, never 0. */
  meetingsUntilNextMilestone: number;
  /** The next milestone's index (1-based), for payout idempotency keys. */
  nextMilestoneIndex: number;
};

export function computeCompensation(input: CompensationInput): CompensationSummary {
  const held = Math.max(0, Math.trunc(input.verifiedHeldCount));
  const paidCents = Math.trunc(input.paidCents);

  const earnedMilestones = Math.floor(held / MEETINGS_PER_MILESTONE);
  const earnedCents = earnedMilestones * MILESTONE_AMOUNT_CENTS;
  const progressTowardNext = held % MEETINGS_PER_MILESTONE;
  const balanceCents = earnedCents - paidCents;

  return {
    verifiedHeldCount: held,
    earnedMilestones,
    earnedCents,
    paidCents,
    balanceCents,
    // Reported separately so a reversal never silently hides a negative number.
    overpaidCents: balanceCents < 0 ? -balanceCents : 0,
    progressTowardNext,
    // At exactly 10 held meetings this is 10, not 0: "$100 earned; 0/10 toward
    // your next $100" — never a misleading "0 earned" display.
    meetingsUntilNextMilestone: MEETINGS_PER_MILESTONE - progressTowardNext,
    nextMilestoneIndex: earnedMilestones + 1,
  };
}

/** Which milestone indices are earned but not yet recorded as paid. */
export function unpaidMilestoneIndices(
  earnedMilestones: number,
  paidMilestoneIndices: readonly number[],
): number[] {
  const paid = new Set(paidMilestoneIndices);
  const out: number[] = [];
  for (let i = 1; i <= earnedMilestones; i += 1) {
    if (!paid.has(i)) out.push(i);
  }
  return out;
}

/**
 * Guard for recording a payout. A milestone can only be marked paid once it
 * has actually been earned; unearned milestones are rejected outright.
 */
export function canRecordPayout(
  earnedMilestones: number,
  milestoneIndex: number,
  paidMilestoneIndices: readonly number[],
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 1) {
    return { ok: false, reason: 'Milestone index must be a positive integer.' };
  }
  if (milestoneIndex > earnedMilestones) {
    return {
      ok: false,
      reason:
        `Milestone ${milestoneIndex} has not been earned yet ` +
        `(${earnedMilestones} milestone${earnedMilestones === 1 ? '' : 's'} earned).`,
    };
  }
  if (paidMilestoneIndices.includes(milestoneIndex)) {
    return { ok: false, reason: `Milestone ${milestoneIndex} is already recorded as paid.` };
  }
  return { ok: true };
}

export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const body =
    remainder === 0
      ? `$${dollars.toLocaleString('en-US')}`
      : `$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
  return negative ? `−${body}` : body;
}

/** Human summary used on the intern dashboard and in admin ledgers. */
export function milestoneHeadline(summary: CompensationSummary): string {
  if (summary.earnedCents === 0) {
    return `${summary.meetingsUntilNextMilestone} more verified meeting${
      summary.meetingsUntilNextMilestone === 1 ? '' : 's'
    } to your first $100`;
  }
  return (
    `${formatCents(summary.earnedCents)} earned; ` +
    `${summary.progressTowardNext}/${MEETINGS_PER_MILESTONE} toward your next $100`
  );
}
