/**
 * Human-readable labels for enum values.
 *
 * Kept in one place so a status never reads differently on two screens, and so
 * the wording that distinguishes "sent" from "logged" stays consistent with
 * the metric definitions.
 */

export const ACTION_LABELS: Record<string, string> = {
  email_initial: 'Initial email',
  email_followup: 'Follow-up email',
  linkedin_connection_request: 'LinkedIn connection request',
  linkedin_message: 'LinkedIn message',
  linkedin_followup: 'LinkedIn follow-up',
  phone_call: 'Phone call',
  research_note: 'Research note',
};

/** Actions offered when logging against a club, grouped for the picker. */
export const LOGGABLE_ACTIONS: { value: string; label: string; help: string }[] = [
  {
    value: 'email_initial',
    label: 'Initial email',
    help: 'First email you have sent to this contact. Counts toward your weekly email target.',
  },
  {
    value: 'email_followup',
    label: 'Follow-up email',
    help: 'A later email to someone you already contacted. Counts toward the weekly email target under the default policy.',
  },
  {
    value: 'linkedin_message',
    label: 'LinkedIn message',
    help: 'A message sent after connecting. Tracked, but does not count again toward the request target.',
  },
  {
    value: 'phone_call',
    label: 'Phone call',
    help: 'Cold calling is optional. Tracked separately; it has no weekly target.',
  },
  {
    value: 'research_note',
    label: 'Research note',
    help: 'Research, a draft, or a note. Never counts as outreach.',
  },
];

export const OUTCOME_LABELS: Record<string, string> = {
  sent: 'Sent',
  no_response: 'No response',
  replied: 'Replied',
  positive_reply: 'Positive reply',
  not_interested: 'Not interested',
  bounced: 'Email bounced',
  invalid_contact: 'Invalid contact',
  do_not_contact: 'Do not contact',
  meeting_booked: 'Meeting booked',
  logged: 'Logged',
};

/** Outcomes offered per action type, so impossible pairings are never shown. */
export const OUTCOMES_FOR_ACTION: Record<string, string[]> = {
  email_initial: [
    'sent',
    'replied',
    'positive_reply',
    'not_interested',
    'bounced',
    'invalid_contact',
    'do_not_contact',
  ],
  email_followup: [
    'sent',
    'replied',
    'positive_reply',
    'not_interested',
    'bounced',
    'invalid_contact',
    'do_not_contact',
  ],
  linkedin_connection_request: ['sent'],
  linkedin_message: ['sent', 'replied', 'positive_reply', 'not_interested'],
  linkedin_followup: ['sent', 'replied', 'no_response'],
  phone_call: [
    'no_response',
    'replied',
    'positive_reply',
    'not_interested',
    'invalid_contact',
    'do_not_contact',
  ],
  research_note: ['logged'],
};

export const SUPPRESSING_OUTCOME_NOTE: Record<string, string> = {
  bounced: 'Recording a bounce suppresses further email to this contact until an admin lifts it.',
  invalid_contact: 'This suppresses all further outreach to this contact until an admin lifts it.',
  do_not_contact: 'This suppresses all further outreach to this contact until an admin lifts it.',
};

export const PROSPECT_EVENT_LABELS: Record<string, string> = {
  created: 'Prospect added (research — not outreach)',
  request_sent: 'Connection request sent',
  connected: 'Connection accepted',
  message_sent: 'Message sent',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  not_interested: 'Not interested',
  note: 'Note',
};

export const FOLLOW_UP_BUCKET_LABELS: Record<string, string> = {
  overdue: 'Overdue',
  due_today: 'Due today',
  upcoming: 'Upcoming',
  snoozed: 'Snoozed',
  completed: 'Completed',
};

export const IMPORT_OUTCOME_TONES: Record<
  string,
  'neutral' | 'positive' | 'caution' | 'info' | 'brand'
> = {
  organization_created: 'positive',
  contact_added: 'info',
  updated: 'info',
  skipped_duplicate: 'neutral',
  needs_review: 'caution',
  invalid: 'brand',
};

export const TARGET_SOURCE_LABELS: Record<string, string> = {
  intern_override: 'Per-intern override',
  cohort_default: 'Cohort default',
  program_default: 'Program guide default',
};

/** Formats an instant for display in a given IANA timezone. */
export function formatInstant(
  value: Date | null | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(value);
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    dateStyle: 'medium',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
