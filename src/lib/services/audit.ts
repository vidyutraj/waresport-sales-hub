import '@/lib/server-guard';
import type { Tx } from '@/lib/db';

/**
 * Audit trail helper.
 *
 * `audit_events` is append-only at the database level (a trigger rejects UPDATE
 * and DELETE for every role, including owners), and RLS makes it unreadable to
 * interns. Sensitive changes record actor, time, action, and before/after.
 *
 * Never pass session tokens or whole contact datasets in here.
 */

export type AuditInput = {
  actorUserId: string;
  actorRole?: 'owner' | 'admin' | 'intern' | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

export async function recordAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx`
    INSERT INTO audit_events
      (actor_user_id, actor_role, action, entity_type, entity_id, before_data, after_data, reason)
    VALUES (
      ${input.actorUserId},
      ${input.actorRole ?? null}::app_role,
      ${input.action},
      ${input.entityType},
      ${input.entityId ?? null},
      ${(input.before ?? null) as never}::jsonb,
      ${(input.after ?? null) as never}::jsonb,
      ${input.reason ?? null}
    )`;
}

export type AuditRow = {
  id: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
};

export async function listAudit(
  tx: Tx,
  input: { entityType?: string; entityId?: string; limit?: number },
): Promise<AuditRow[]> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));
  const rows = await tx<
    {
      id: string;
      actor_name: string | null;
      actor_role: string | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      reason: string | null;
      created_at: Date;
      before_data: unknown;
      after_data: unknown;
    }[]
  >`
    SELECT a.id::text AS id,
           coalesce(u.preferred_name, u.full_name, u.email::text) AS actor_name,
           a.actor_role::text, a.action, a.entity_type, a.entity_id, a.reason,
           a.created_at, a.before_data, a.after_data
    FROM audit_events a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE (${input.entityType ?? null}::text IS NULL OR a.entity_type = ${input.entityType ?? null})
      AND (${input.entityId ?? null}::text IS NULL OR a.entity_id = ${input.entityId ?? null})
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    actorName: r.actor_name,
    actorRole: r.actor_role,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    reason: r.reason,
    createdAt: r.created_at,
    before: r.before_data,
    after: r.after_data,
  }));
}
