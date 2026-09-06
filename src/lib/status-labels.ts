/**
 * Organization workflow statuses.
 *
 * Duplicated out of the server-only outreach service so client components can
 * import the labels without pulling a database module into the browser bundle.
 * tests/unit/labels.test.ts keeps the two lists identical.
 */
export const ORG_STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  meeting_held: 'Meeting held',
  not_interested: 'Not interested',
  unreachable: 'Unreachable',
  do_not_contact: 'Do not contact',
} as const;

export type OrgStatusKey = keyof typeof ORG_STATUS_LABELS;
