/**
 * Metric classification.
 *
 * The weekly goals in the program guide are stated as "emails" and "LinkedIn
 * requests". The guide does not settle whether a follow-up email counts toward
 * the weekly email number, so the default policy below is an implementation
 * choice, versioned per cohort and editable prospectively by an admin.
 *
 * Nothing here derives volume from a status label: only explicitly logged
 * activity events count, and voided events never count.
 */

export type ActivityAction =
  | 'email_initial'
  | 'email_followup'
  | 'linkedin_connection_request'
  | 'linkedin_message'
  | 'linkedin_followup'
  | 'phone_call'
  | 'research_note';

export type MetricPolicy = {
  version: number;
  /** Default true: both initial and follow-up emails count toward the target. */
  emailCountsFollowups: boolean;
  /** Default true: only a first-time connection request counts, not messages. */
  linkedinCountsFirstRequestOnly: boolean;
};

export const DEFAULT_METRIC_POLICY: MetricPolicy = {
  version: 1,
  emailCountsFollowups: true,
  linkedinCountsFirstRequestOnly: true,
};

export const EMAIL_ACTIONS: readonly ActivityAction[] = ['email_initial', 'email_followup'];
export const LINKEDIN_ACTIONS: readonly ActivityAction[] = [
  'linkedin_connection_request',
  'linkedin_message',
  'linkedin_followup',
];

/** Research and unsent drafts are never outreach. */
export function isOutreachAction(action: ActivityAction): boolean {
  return action !== 'research_note';
}

export function countsTowardEmailTarget(action: ActivityAction, policy: MetricPolicy): boolean {
  if (action === 'email_initial') return true;
  if (action === 'email_followup') return policy.emailCountsFollowups;
  return false;
}

export function countsTowardLinkedinTarget(action: ActivityAction, policy: MetricPolicy): boolean {
  if (action === 'linkedin_connection_request') return true;
  if (action === 'linkedin_message' || action === 'linkedin_followup') {
    return !policy.linkedinCountsFirstRequestOnly;
  }
  return false;
}

export function isFirstTouchAction(action: ActivityAction): boolean {
  return action === 'email_initial' || action === 'linkedin_connection_request';
}

export function isFollowUpAction(action: ActivityAction): boolean {
  return (
    action === 'email_followup' || action === 'linkedin_message' || action === 'linkedin_followup'
  );
}

export type ActivityLike = {
  actionType: ActivityAction;
  organizationId: string;
  prospectId?: string | null;
  voidedAt?: Date | string | null;
};

export type WeeklyMetricTotals = {
  emails: number;
  linkedinConnections: number;
  firstTouches: number;
  followUps: number;
  uniqueOrganizations: number;
  phoneCalls: number;
  researchNotes: number;
};

/**
 * Reference implementation used by unit tests and by the CSV/export paths.
 * The dashboards run the equivalent aggregation in SQL against the same
 * definitions — see src/lib/queries/metrics.ts.
 */
export function summariseActivities(
  activities: readonly ActivityLike[],
  policy: MetricPolicy = DEFAULT_METRIC_POLICY,
): WeeklyMetricTotals {
  const live = activities.filter((a) => !a.voidedAt);
  const orgs = new Set<string>();
  let emails = 0;
  let linkedinConnections = 0;
  let firstTouches = 0;
  let followUps = 0;
  let phoneCalls = 0;
  let researchNotes = 0;

  for (const a of live) {
    if (isOutreachAction(a.actionType)) orgs.add(a.organizationId);
    if (countsTowardEmailTarget(a.actionType, policy)) emails += 1;
    if (countsTowardLinkedinTarget(a.actionType, policy)) linkedinConnections += 1;
    if (isFirstTouchAction(a.actionType)) firstTouches += 1;
    if (isFollowUpAction(a.actionType)) followUps += 1;
    if (a.actionType === 'phone_call') phoneCalls += 1;
    if (a.actionType === 'research_note') researchNotes += 1;
  }

  return {
    emails,
    linkedinConnections,
    firstTouches,
    followUps,
    uniqueOrganizations: orgs.size,
    phoneCalls,
    researchNotes,
  };
}

/** Human-readable definition strings shown next to every rate in the UI. */
export const METRIC_DEFINITIONS = {
  emails:
    'Explicitly logged initial and follow-up emails sent by this intern in the period. Self-reported; not independently verified.',
  linkedinConnections:
    'People who accepted a LinkedIn connection request and were logged by this intern in the period. Each profile counts once. There is no target: interns keep adding to it.',
  replyRate:
    'Organizations with at least one logged reply ÷ organizations that received at least one outreach action in the period.',
  meetingRate:
    'Verified-held meetings ÷ organizations that received at least one outreach action in the period.',
  verifiedHeld:
    'Meetings an admin or owner confirmed actually took place. Scheduled, pending, cancelled and no-show meetings are excluded.',
} as const;
