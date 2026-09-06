import '@/lib/server-guard';
import { attempt, isUniqueViolation, type Tx } from '@/lib/db';
import { analyseLinkedInProfileUrl } from '@/lib/domain/linkedin';
import { normalizeEmail, normalizeText } from '@/lib/domain/normalize';
import { logActivity, OutreachError } from './outreach';
import { recordAudit } from './audit';

/**
 * LinkedIn prospect tracker.
 *
 * Interns accumulate researched people here independently of the imported
 * email leads. Creating a prospect is research, not outreach: it produces no
 * activity event and moves no counter. Sending the connection request is a
 * separate, explicit action — and a given profile's request can only ever be
 * counted once, enforced by a partial unique index on activity_events.
 *
 * Profile URLs are canonicalised but never fetched or scraped.
 */

export class ProspectError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'duplicate'
      | 'collision'
      | 'not_found'
      | 'invalid_input'
      | 'already_requested',
  ) {
    super(message);
    this.name = 'ProspectError';
  }
}

export type ProspectStatus =
  | 'not_contacted'
  | 'request_sent'
  | 'connected'
  | 'message_sent'
  | 'replied'
  | 'interested'
  | 'meeting_booked'
  | 'not_interested';

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  not_contacted: 'Not contacted',
  request_sent: 'Request sent',
  connected: 'Connected',
  message_sent: 'Message sent',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  not_interested: 'Not interested',
};

export type CreateProspectInput = {
  actorUserId: string;
  organizationId: string;
  fullName: string;
  profileUrl: string;
  title?: string | null;
  territoryId?: string | null;
  sport?: string | null;
  email?: string | null;
  notes?: string | null;
};

export type CreateProspectResult =
  | { status: 'created'; prospectId: string }
  | { status: 'already_yours'; prospectId: string }
  /** Minimal notice: no other intern's name, notes or contacts are exposed. */
  | { status: 'collision'; profileUrl: string };

export async function createProspect(
  tx: Tx,
  input: CreateProspectInput,
): Promise<CreateProspectResult> {
  const fullName = normalizeText(input.fullName);
  if (fullName === null) throw new ProspectError('A prospect name is required.', 'invalid_input');

  const analysis = analyseLinkedInProfileUrl(input.profileUrl);
  if (!analysis.ok) throw new ProspectError(analysis.reason, 'invalid_url');

  const [existing] = await tx<{ id: string; created_by: string }[]>`
    SELECT id, created_by FROM linkedin_prospects
    WHERE profile_key = ${analysis.key} AND is_archived = false`;

  if (existing !== undefined) {
    return existing.created_by === input.actorUserId
      ? { status: 'already_yours', prospectId: existing.id }
      : { status: 'collision', profileUrl: analysis.url };
  }

  const created = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO linkedin_prospects (
        organization_id, created_by, full_name, title, profile_url, profile_url_raw,
        profile_key, linkedin_public_id, territory_id, sport, email, notes
      ) VALUES (
        ${input.organizationId}, ${input.actorUserId}, ${fullName},
        ${normalizeText(input.title ?? null)}, ${analysis.url}, ${analysis.raw},
        ${analysis.key}, ${analysis.publicId}, ${input.territoryId ?? null},
        ${normalizeText(input.sport ?? null)}, ${normalizeEmail(input.email ?? null)},
        ${normalizeText(input.notes ?? null)}
      )
      RETURNING id`;
    return row;
  });

  if (!created.ok) {
    // Someone inserted the same profile between the check and the insert.
    if (isUniqueViolation(created.error)) {
      return { status: 'collision', profileUrl: analysis.url };
    }
    throw created.error;
  }
  const row = created.value;
  if (row === undefined) throw new ProspectError('Could not save that prospect.', 'invalid_input');

  // Creation is recorded on the prospect's own timeline, never as outreach.
  await tx`
    INSERT INTO prospect_events (prospect_id, actor_user_id, event_type, notes)
    VALUES (${row.id}, ${input.actorUserId}, 'created', 'Prospect researched and added')`;

  return { status: 'created', prospectId: row.id };
}

/**
 * Record that a connection request was actually sent.
 *
 * This is the only prospect event that counts toward the weekly LinkedIn
 * target, and only the first one for any given profile.
 */
export async function recordConnectionRequest(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    prospectId: string;
    occurredAt: Date;
    notes?: string | null;
    cohortId?: string | null;
    cohortRange?: { start: Date; end: Date } | null;
    clientRequestId?: string | null;
    now?: Date;
  },
): Promise<{ activityId: string; deduplicated: boolean }> {
  const [prospect] = await tx<{ id: string; organization_id: string; status: ProspectStatus }[]>`
    SELECT id, organization_id, status FROM linkedin_prospects
    WHERE id = ${input.prospectId} FOR UPDATE`;
  if (prospect === undefined)
    throw new ProspectError('That prospect no longer exists.', 'not_found');

  let result;
  try {
    result = await logActivity(tx, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      organizationId: prospect.organization_id,
      prospectId: prospect.id,
      cohortId: input.cohortId ?? null,
      actionType: 'linkedin_connection_request',
      occurredAt: input.occurredAt,
      outcome: 'sent',
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId ?? null,
      cohortRange: input.cohortRange ?? null,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof OutreachError && error.code === 'duplicate_request') {
      throw new ProspectError(
        'A connection request to this profile is already recorded. It only counts once.',
        'already_requested',
      );
    }
    throw error;
  }

  await tx`
    INSERT INTO prospect_events (prospect_id, actor_user_id, event_type, occurred_at, notes, activity_id)
    VALUES (${prospect.id}, ${input.actorUserId}, 'request_sent', ${input.occurredAt},
            ${input.notes ?? null}, ${result.activityId})`;
  await tx`
    UPDATE linkedin_prospects SET status = 'request_sent'
    WHERE id = ${prospect.id} AND status = 'not_contacted'`;

  return { activityId: result.activityId, deduplicated: result.deduplicated };
}

/**
 * Later lifecycle events. An accepted connection is not outreach; a message
 * sent after connecting is logged as outreach but, under the default metric
 * policy, does not count a second time toward the request target.
 */
export async function recordProspectEvent(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    prospectId: string;
    eventType: 'connected' | 'message_sent' | 'replied' | 'interested' | 'not_interested' | 'note';
    occurredAt: Date;
    notes?: string | null;
    cohortId?: string | null;
    cohortRange?: { start: Date; end: Date } | null;
    clientRequestId?: string | null;
    now?: Date;
  },
): Promise<{ activityId: string | null }> {
  const [prospect] = await tx<{ id: string; organization_id: string }[]>`
    SELECT id, organization_id FROM linkedin_prospects WHERE id = ${input.prospectId}`;
  if (prospect === undefined)
    throw new ProspectError('That prospect no longer exists.', 'not_found');

  let activityId: string | null = null;

  // Only a message the intern actually sent is outreach.
  if (input.eventType === 'message_sent') {
    const result = await logActivity(tx, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      organizationId: prospect.organization_id,
      prospectId: prospect.id,
      cohortId: input.cohortId ?? null,
      actionType: 'linkedin_message',
      occurredAt: input.occurredAt,
      outcome: 'sent',
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId ?? null,
      cohortRange: input.cohortRange ?? null,
      now: input.now,
    });
    activityId = result.activityId;
  }

  await tx`
    INSERT INTO prospect_events (prospect_id, actor_user_id, event_type, occurred_at, notes, activity_id)
    VALUES (${prospect.id}, ${input.actorUserId}, ${input.eventType}::prospect_event_type,
            ${input.occurredAt}, ${input.notes ?? null}, ${activityId})`;

  const nextStatus: Partial<Record<typeof input.eventType, ProspectStatus>> = {
    connected: 'connected',
    message_sent: 'message_sent',
    replied: 'replied',
    interested: 'interested',
    not_interested: 'not_interested',
  };
  const status = nextStatus[input.eventType];
  if (status) {
    await tx`
      UPDATE linkedin_prospects SET status = ${status}::prospect_status WHERE id = ${prospect.id}`;
  }

  return { activityId };
}

export type ProspectRow = {
  id: string;
  fullName: string;
  title: string | null;
  profileUrl: string;
  organizationId: string;
  organizationName: string;
  status: ProspectStatus;
  sport: string | null;
  email: string | null;
  notes: string | null;
  createdAt: Date;
  requestSentAt: Date | null;
  connectedAt: Date | null;
  messagesSent: number;
};

export async function listProspects(
  tx: Tx,
  input: { createdBy?: string | null; organizationId?: string | null; limit?: number },
): Promise<ProspectRow[]> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 200));
  const rows = await tx<
    {
      id: string;
      full_name: string;
      title: string | null;
      profile_url: string;
      organization_id: string;
      organization_name: string;
      status: ProspectStatus;
      sport: string | null;
      email: string | null;
      notes: string | null;
      created_at: Date;
      request_sent_at: Date | null;
      connected_at: Date | null;
      messages_sent: string;
    }[]
  >`
    SELECT p.id, p.full_name, p.title, p.profile_url, p.organization_id,
           o.name AS organization_name, p.status, p.sport, p.email::text AS email,
           p.notes, p.created_at,
           (SELECT min(e.occurred_at) FROM prospect_events e
             WHERE e.prospect_id = p.id AND e.event_type = 'request_sent' AND e.voided_at IS NULL) AS request_sent_at,
           (SELECT min(e.occurred_at) FROM prospect_events e
             WHERE e.prospect_id = p.id AND e.event_type = 'connected' AND e.voided_at IS NULL) AS connected_at,
           (SELECT count(*) FROM prospect_events e
             WHERE e.prospect_id = p.id AND e.event_type = 'message_sent' AND e.voided_at IS NULL)::text AS messages_sent
    FROM linkedin_prospects p
    JOIN organizations o ON o.id = p.organization_id
    WHERE p.is_archived = false
      AND (${input.createdBy ?? null}::uuid IS NULL OR p.created_by = ${input.createdBy ?? null})
      AND (${input.organizationId ?? null}::uuid IS NULL OR p.organization_id = ${input.organizationId ?? null})
    ORDER BY p.created_at DESC
    LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    title: r.title,
    profileUrl: r.profile_url,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    status: r.status,
    sport: r.sport,
    email: r.email,
    notes: r.notes,
    createdAt: r.created_at,
    requestSentAt: r.request_sent_at,
    connectedAt: r.connected_at,
    messagesSent: Number(r.messages_sent),
  }));
}

export type ProspectCounters = {
  total: number;
  requestsSent: number;
  connected: number;
  messagesSent: number;
  replied: number;
  meetingsBooked: number;
};

/**
 * Separate counters, deliberately. Requests, acceptances and messages are
 * different events; conflating them would let repetitive messaging look like
 * new outreach.
 */
export async function prospectCounters(tx: Tx, createdBy: string): Promise<ProspectCounters> {
  const [row] = await tx<
    {
      total: string;
      requests_sent: string;
      connected: string;
      messages_sent: string;
      replied: string;
      meetings_booked: string;
    }[]
  >`
    SELECT
      count(DISTINCT p.id)::text AS total,
      count(DISTINCT e.prospect_id) FILTER (WHERE e.event_type = 'request_sent' AND e.voided_at IS NULL)::text AS requests_sent,
      count(DISTINCT e.prospect_id) FILTER (WHERE e.event_type = 'connected' AND e.voided_at IS NULL)::text AS connected,
      count(*) FILTER (WHERE e.event_type = 'message_sent' AND e.voided_at IS NULL)::text AS messages_sent,
      count(DISTINCT e.prospect_id) FILTER (WHERE e.event_type = 'replied' AND e.voided_at IS NULL)::text AS replied,
      count(DISTINCT e.prospect_id) FILTER (WHERE e.event_type = 'meeting_booked' AND e.voided_at IS NULL)::text AS meetings_booked
    FROM linkedin_prospects p
    LEFT JOIN prospect_events e ON e.prospect_id = p.id
    WHERE p.created_by = ${createdBy} AND p.is_archived = false`;

  return {
    total: Number(row?.total ?? 0),
    requestsSent: Number(row?.requests_sent ?? 0),
    connected: Number(row?.connected ?? 0),
    messagesSent: Number(row?.messages_sent ?? 0),
    replied: Number(row?.replied ?? 0),
    meetingsBooked: Number(row?.meetings_booked ?? 0),
  };
}

export type ProspectEventRow = {
  id: string;
  eventType: string;
  occurredAt: Date;
  notes: string | null;
  actorName: string;
  voidedAt: Date | null;
};

export async function prospectTimeline(tx: Tx, prospectId: string): Promise<ProspectEventRow[]> {
  const rows = await tx<
    {
      id: string;
      event_type: string;
      occurred_at: Date;
      notes: string | null;
      actor_name: string;
      voided_at: Date | null;
    }[]
  >`
    SELECT e.id, e.event_type::text, e.occurred_at, e.notes,
           coalesce(u.preferred_name, u.full_name, u.email::text, 'Another team member')
             AS actor_name,
           e.voided_at
    FROM prospect_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.prospect_id = ${prospectId}
    ORDER BY e.occurred_at DESC, e.created_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    notes: r.notes,
    actorName: r.actor_name,
    voidedAt: r.voided_at,
  }));
}

/** Create the organization an intern researched, so a prospect can hang off it. */
export async function createResearchedOrganization(
  tx: Tx,
  input: {
    actorUserId: string;
    name: string;
    city?: string | null;
    state?: string | null;
    sport?: string | null;
    sourceUrl?: string | null;
    notes?: string | null;
    territoryId?: string | null;
  },
): Promise<
  | { status: 'created'; organizationId: string }
  | { status: 'exists'; organizationId: string | null }
> {
  const name = normalizeText(input.name);
  if (name === null) throw new ProspectError('An organization name is required.', 'invalid_input');

  const created = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO organizations (name, city, state, sport, source, source_url, notes,
                                 territory_id, territory_source, created_by)
      VALUES (${name}, ${normalizeText(input.city ?? null)}, ${input.state ?? null},
              ${normalizeText(input.sport ?? null)}, 'intern_research',
              ${input.sourceUrl ?? null}, ${normalizeText(input.notes ?? null)},
              ${input.territoryId ?? null},
              ${input.territoryId ? 'state_map' : 'unassigned'}, ${input.actorUserId})
      RETURNING id`;
    return row;
  });

  if (!created.ok) {
    if (!isUniqueViolation(created.error)) throw created.error;
    // The club already exists. RLS may hide it from this intern, in which case
    // the id comes back null and the UI shows a minimal collision notice.
    const [found] = await tx<{ id: string }[]>`
      SELECT id FROM organizations
      WHERE name_normalized = app.normalize_name(${name})
        AND coalesce(state, '') = coalesce(${input.state ?? null}, '')
        AND city_normalized = coalesce(app.normalize_name(${input.city ?? null}), '')
        AND is_archived = false`;
    return { status: 'exists', organizationId: found?.id ?? null };
  }

  const row = created.value;
  if (row === undefined)
    throw new ProspectError('Could not create that organization.', 'invalid_input');

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: 'intern',
    action: 'organization.created_by_intern',
    entityType: 'organization',
    entityId: row.id,
    after: { name, state: input.state ?? null },
  });

  return { status: 'created', organizationId: row.id };
}
