import '@/lib/server-guard';
import type { Tx } from '@/lib/db';

/**
 * Lead reads: the organization table, its filters, and the detail view.
 *
 * These queries never add their own visibility clauses for interns — row level
 * security already restricts `organizations`, `contacts` and
 * `organization_assignments` to what the current actor may see. Admin-only
 * filters (such as filtering by assignee) are still gated in the callers.
 */

export type LeadFilters = {
  search?: string | null;
  territoryId?: string | null;
  state?: string | null;
  city?: string | null;
  sport?: string | null;
  source?: string | null;
  status?: string | null;
  assigneeId?: string | null;
  /** 'assigned' | 'unassigned' */
  assignment?: 'assigned' | 'unassigned' | null;
  /** 'email' | 'phone' | 'either' | 'none' */
  contactability?: 'email' | 'phone' | 'either' | 'none' | null;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'recent' | 'follow_up' | null;
};

export type LeadRow = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  sport: string | null;
  source: string | null;
  status: string;
  territoryId: string | null;
  territoryCode: string | null;
  primaryEmail: string | null;
  primaryPhoneRaw: string | null;
  primaryPhoneValid: boolean;
  contactCount: number;
  assigneeId: string | null;
  assigneeName: string | null;
  nextFollowUpOn: string | null;
  lastActivityAt: Date | null;
  isSuppressed: boolean;
};

export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/**
 * The shared lead predicate.
 *
 * Both the paginated table and the "allocate N of these" action filter with
 * this one fragment, so the count an admin sees and the rows the server
 * actually allocates can never drift apart. It assumes the caller has joined
 * `organizations o` and, as `a`, the current (un-ended) assignment row.
 */
function leadPredicate(tx: Tx, filters: LeadFilters) {
  const search = (filters.search ?? '').trim();
  return tx`
    o.is_archived = false
        AND (${search || null}::text IS NULL OR (
              o.name_normalized LIKE '%' || app.normalize_name(${search || null}) || '%'
              OR EXISTS (
                SELECT 1 FROM contacts c
                WHERE c.organization_id = o.id AND c.is_archived = false
                  AND (c.email_normalized LIKE '%' || lower(${search || null}) || '%'
                       OR app.normalize_name(c.full_name) LIKE '%' || app.normalize_name(${search || null}) || '%')
              )))
        AND (${filters.territoryId ?? null}::uuid IS NULL OR o.territory_id = ${filters.territoryId ?? null})
        AND (${filters.state ?? null}::text IS NULL OR o.state = ${filters.state ?? null})
        AND (${filters.city ?? null}::text IS NULL OR o.city_normalized = app.normalize_name(${filters.city ?? null}))
        AND (${filters.sport ?? null}::text IS NULL OR o.sport = ${filters.sport ?? null})
        AND (${filters.source ?? null}::text IS NULL OR o.source = ${filters.source ?? null})
        AND (${filters.status ?? null}::text IS NULL OR o.status::text = ${filters.status ?? null})
        AND (${filters.assigneeId ?? null}::uuid IS NULL OR a.intern_user_id = ${filters.assigneeId ?? null})
        AND (${filters.assignment ?? null}::text IS NULL
             OR (${filters.assignment ?? null} = 'assigned' AND a.id IS NOT NULL)
             OR (${filters.assignment ?? null} = 'unassigned' AND a.id IS NULL))
        AND (${filters.contactability ?? null}::text IS NULL OR (
              CASE ${filters.contactability ?? null}
                WHEN 'email'  THEN EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id = o.id AND c.email_valid AND c.is_archived = false)
                WHEN 'phone'  THEN EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id = o.id AND c.phone_valid AND c.is_archived = false)
                WHEN 'either' THEN EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id = o.id AND (c.email_valid OR c.phone_valid) AND c.is_archived = false)
                WHEN 'none'   THEN NOT EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id = o.id AND (c.email_valid OR c.phone_valid) AND c.is_archived = false)
                ELSE true
              END))`;
}

/**
 * Server-side paginated lead list. All filtering and sorting happens in SQL so
 * a large import stays responsive and the count is always accurate.
 */
export async function listLeads(tx: Tx, filters: LeadFilters): Promise<Paginated<LeadRow>> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const offset = (page - 1) * pageSize;

  const rows = await tx<
    {
      id: string;
      name: string;
      city: string | null;
      state: string | null;
      sport: string | null;
      source: string | null;
      status: string;
      territory_id: string | null;
      territory_code: string | null;
      primary_email: string | null;
      primary_phone_raw: string | null;
      primary_phone_valid: boolean | null;
      contact_count: string;
      assignee_id: string | null;
      assignee_name: string | null;
      next_follow_up_on: string | null;
      last_activity_at: Date | null;
      is_suppressed: boolean;
      total_count: string;
    }[]
  >`
    WITH filtered AS (
      SELECT o.id
      FROM organizations o
      LEFT JOIN organization_assignments a
        ON a.organization_id = o.id AND a.unassigned_at IS NULL
      WHERE ${leadPredicate(tx, filters)}
    ),
    counted AS (SELECT count(*)::text AS total FROM filtered)
    SELECT o.id, o.name, o.city, o.state, o.sport, o.source, o.status::text,
           o.territory_id, t.code AS territory_code,
           pc.email::text AS primary_email,
           pc.phone_raw AS primary_phone_raw,
           pc.phone_valid AS primary_phone_valid,
           (SELECT count(*) FROM contacts c WHERE c.organization_id = o.id AND c.is_archived = false)::text AS contact_count,
           a.intern_user_id AS assignee_id,
           coalesce(u.preferred_name, u.full_name, u.email::text) AS assignee_name,
           (SELECT min(f.due_on)::text FROM follow_ups f
             WHERE f.organization_id = o.id AND f.status = 'open') AS next_follow_up_on,
           (SELECT max(e.occurred_at) FROM activity_events e
             WHERE e.organization_id = o.id AND e.voided_at IS NULL) AS last_activity_at,
           EXISTS (SELECT 1 FROM suppressions s
                   WHERE s.lifted_at IS NULL
                     AND (s.organization_id = o.id
                          OR s.contact_id IN (SELECT c.id FROM contacts c WHERE c.organization_id = o.id))) AS is_suppressed,
           counted.total AS total_count
    FROM filtered
    JOIN organizations o ON o.id = filtered.id
    CROSS JOIN counted
    LEFT JOIN territories t ON t.id = o.territory_id
    LEFT JOIN organization_assignments a ON a.organization_id = o.id AND a.unassigned_at IS NULL
    LEFT JOIN users u ON u.id = a.intern_user_id
    LEFT JOIN LATERAL (
      SELECT c.email, c.phone_raw, c.phone_valid
      FROM contacts c
      WHERE c.organization_id = o.id AND c.is_archived = false
      ORDER BY c.is_primary DESC, c.email_valid DESC, c.phone_valid DESC, c.created_at
      LIMIT 1
    ) pc ON true
    ORDER BY
      CASE WHEN ${filters.sort ?? 'name'} = 'recent' THEN 0 ELSE 1 END,
      (SELECT max(e.occurred_at) FROM activity_events e
        WHERE e.organization_id = o.id AND e.voided_at IS NULL) DESC NULLS LAST,
      CASE WHEN ${filters.sort ?? 'name'} = 'follow_up' THEN 0 ELSE 1 END,
      (SELECT min(f.due_on) FROM follow_ups f
        WHERE f.organization_id = o.id AND f.status = 'open') ASC NULLS LAST,
      o.name ASC
    LIMIT ${pageSize} OFFSET ${offset}`;

  const total = Number(rows[0]?.total_count ?? 0);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      state: r.state,
      sport: r.sport,
      source: r.source,
      status: r.status,
      territoryId: r.territory_id,
      territoryCode: r.territory_code,
      primaryEmail: r.primary_email,
      primaryPhoneRaw: r.primary_phone_raw,
      primaryPhoneValid: r.primary_phone_valid ?? false,
      contactCount: Number(r.contact_count),
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
      nextFollowUpOn: r.next_follow_up_on,
      lastActivityAt: r.last_activity_at,
      isSuppressed: r.is_suppressed,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Distinct filter values, so the UI only offers options that exist. */
/**
 * The first `limit` unallocated clubs matching these filters, in the order an
 * admin sees them (by name), so "allocate 20" always takes the same 20 the
 * table shows first.
 *
 * `assignment` is forced: this only ever returns clubs nobody owns, which is
 * what makes a partial allocation safe to repeat — the rest stay in the
 * unallocated queue for next time.
 */
export async function listUnallocatedLeadIds(
  tx: Tx,
  filters: LeadFilters,
  limit: number,
): Promise<{ id: string; name: string }[]> {
  const capped = Math.min(2000, Math.max(1, Math.trunc(limit)));
  const rows = await tx<{ id: string; name: string }[]>`
    SELECT o.id, o.name
    FROM organizations o
    LEFT JOIN organization_assignments a
      ON a.organization_id = o.id AND a.unassigned_at IS NULL
    WHERE ${leadPredicate(tx, { ...filters, assignment: 'unassigned' })}
    ORDER BY o.name ASC, o.id ASC
    LIMIT ${capped}`;
  return rows;
}

/** How many unallocated clubs match these filters in total. */
export async function countUnallocatedLeads(tx: Tx, filters: LeadFilters): Promise<number> {
  const [row] = await tx<{ c: string }[]>`
    SELECT count(*)::text AS c
    FROM organizations o
    LEFT JOIN organization_assignments a
      ON a.organization_id = o.id AND a.unassigned_at IS NULL
    WHERE ${leadPredicate(tx, { ...filters, assignment: 'unassigned' })}`;
  return Number(row?.c ?? 0);
}

export async function leadFilterOptions(tx: Tx): Promise<{
  states: string[];
  sports: string[];
  sources: string[];
}> {
  const [states, sports, sources] = await Promise.all([
    tx<
      { v: string }[]
    >`SELECT DISTINCT state AS v FROM organizations WHERE state IS NOT NULL AND is_archived = false ORDER BY 1`,
    tx<
      { v: string }[]
    >`SELECT DISTINCT sport AS v FROM organizations WHERE sport IS NOT NULL AND is_archived = false ORDER BY 1`,
    tx<
      { v: string }[]
    >`SELECT DISTINCT source AS v FROM organizations WHERE source IS NOT NULL AND is_archived = false ORDER BY 1`,
  ]);
  return {
    states: states.map((r) => r.v),
    sports: sports.map((r) => r.v),
    sources: sources.map((r) => r.v),
  };
}

export type ContactRow = {
  id: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string | null;
  emailValid: boolean;
  phoneRaw: string | null;
  phoneE164: string | null;
  phoneValid: boolean;
  phoneExtension: string | null;
  linkedinUrl: string | null;
  notes: string | null;
  sourceUrl: string | null;
  suppressedChannels: string[];
};

export type OrganizationDetail = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  sport: string | null;
  source: string | null;
  sourceUrl: string | null;
  notes: string | null;
  status: string;
  territoryId: string | null;
  territoryCode: string | null;
  rowVersion: number;
  createdAt: Date;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedAt: Date | null;
  /** True when the viewer only retains history and no longer owns the club. */
  historyOnly: boolean;
  contacts: ContactRow[];
};

export async function getOrganizationDetail(
  tx: Tx,
  organizationId: string,
  viewerId: string,
): Promise<OrganizationDetail | null> {
  const [org] = await tx<
    {
      id: string;
      name: string;
      city: string | null;
      state: string | null;
      sport: string | null;
      source: string | null;
      source_url: string | null;
      notes: string | null;
      status: string;
      territory_id: string | null;
      territory_code: string | null;
      row_version: number;
      created_at: Date;
      assignee_id: string | null;
      assignee_name: string | null;
      assigned_at: Date | null;
    }[]
  >`
    SELECT o.id, o.name, o.city, o.state, o.sport, o.source, o.source_url, o.notes,
           o.status::text, o.territory_id, t.code AS territory_code, o.row_version, o.created_at,
           a.intern_user_id AS assignee_id,
           coalesce(u.preferred_name, u.full_name, u.email::text) AS assignee_name,
           a.assigned_at
    FROM organizations o
    LEFT JOIN territories t ON t.id = o.territory_id
    LEFT JOIN organization_assignments a ON a.organization_id = o.id AND a.unassigned_at IS NULL
    LEFT JOIN users u ON u.id = a.intern_user_id
    WHERE o.id = ${organizationId}`;

  if (org === undefined) return null;

  // RLS returns no contact rows unless the viewer currently owns the club, so
  // an empty list here is the correct "history only" signal rather than a bug.
  const contacts = await tx<
    {
      id: string;
      full_name: string | null;
      role_title: string | null;
      email: string | null;
      email_valid: boolean;
      phone_raw: string | null;
      phone_e164: string | null;
      phone_valid: boolean;
      phone_extension: string | null;
      linkedin_url: string | null;
      notes: string | null;
      source_url: string | null;
      suppressed_channels: string[];
    }[]
  >`
    SELECT c.id, c.full_name, c.role_title, c.email::text AS email, c.email_valid,
           c.phone_raw, c.phone_e164, c.phone_valid, c.phone_extension,
           c.linkedin_url, c.notes, c.source_url,
           coalesce(array(
             SELECT s.channel::text FROM suppressions s
             WHERE s.lifted_at IS NULL
               AND (s.contact_id = c.id OR (s.scope = 'organization' AND s.organization_id = c.organization_id))
           ), '{}') AS suppressed_channels
    FROM contacts c
    WHERE c.organization_id = ${organizationId} AND c.is_archived = false
    ORDER BY c.is_primary DESC, c.email_valid DESC, c.created_at`;

  return {
    id: org.id,
    name: org.name,
    city: org.city,
    state: org.state,
    sport: org.sport,
    source: org.source,
    sourceUrl: org.source_url,
    notes: org.notes,
    status: org.status,
    territoryId: org.territory_id,
    territoryCode: org.territory_code,
    rowVersion: org.row_version,
    createdAt: org.created_at,
    assigneeId: org.assignee_id,
    assigneeName: org.assignee_name,
    assignedAt: org.assigned_at,
    historyOnly: org.assignee_id !== viewerId,
    contacts: contacts.map((c) => ({
      id: c.id,
      fullName: c.full_name,
      roleTitle: c.role_title,
      email: c.email,
      emailValid: c.email_valid,
      phoneRaw: c.phone_raw,
      phoneE164: c.phone_e164,
      phoneValid: c.phone_valid,
      phoneExtension: c.phone_extension,
      linkedinUrl: c.linkedin_url,
      notes: c.notes,
      sourceUrl: c.source_url,
      suppressedChannels: c.suppressed_channels,
    })),
  };
}

export type AssignmentHistoryRow = {
  id: string;
  internUserId: string;
  internName: string;
  assignedAt: Date;
  unassignedAt: Date | null;
  assignedByName: string;
  reason: string | null;
  territoryOverrideReason: string | null;
};

export async function assignmentHistory(
  tx: Tx,
  organizationId: string,
): Promise<AssignmentHistoryRow[]> {
  const rows = await tx<
    {
      id: string;
      intern_user_id: string;
      intern_name: string;
      assigned_at: Date;
      unassigned_at: Date | null;
      assigned_by_name: string;
      reason: string | null;
      territory_override_reason: string | null;
    }[]
  >`
    SELECT a.id, a.intern_user_id,
           coalesce(i.preferred_name, i.full_name, i.email::text, 'Another team member')
             AS intern_name,
           a.assigned_at, a.unassigned_at,
           coalesce(b.preferred_name, b.full_name, b.email::text, 'A Waresport admin')
             AS assigned_by_name,
           a.reason, a.territory_override_reason
    FROM organization_assignments a
    LEFT JOIN users i ON i.id = a.intern_user_id
    LEFT JOIN users b ON b.id = a.assigned_by
    WHERE a.organization_id = ${organizationId}
    ORDER BY a.assigned_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    internUserId: r.intern_user_id,
    internName: r.intern_name,
    assignedAt: r.assigned_at,
    unassignedAt: r.unassigned_at,
    assignedByName: r.assigned_by_name,
    reason: r.reason,
    territoryOverrideReason: r.territory_override_reason,
  }));
}
