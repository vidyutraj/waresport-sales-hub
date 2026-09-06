import '@/lib/server-guard';
import { attempt, isUniqueViolation, type Tx } from '@/lib/db';
import { recordAudit } from './audit';

/**
 * Organization assignment and ownership.
 *
 * Assignment is at organization level, so every contact at a club has exactly
 * one current intern owner. The guarantee is a partial unique index
 * (`organization_assignments_one_current`), not application logic: two
 * concurrent assign or claim transactions cannot both succeed, and the loser
 * surfaces as a collision rather than silently overwriting.
 *
 * Reassignment changes *future* responsibility only. Activity keeps its
 * original actor and meetings keep their credited intern, so historical
 * contribution and compensation are unaffected.
 */

export class AssignmentError extends Error {
  constructor(
    message: string,
    readonly code:
      'collision' | 'territory_mismatch' | 'not_found' | 'inactive_intern' | 'not_permitted',
  ) {
    super(message);
    this.name = 'AssignmentError';
  }
}

export type AssignOptions = {
  actorUserId: string;
  actorRole: 'owner' | 'admin' | 'intern';
  organizationId: string;
  internUserId: string;
  reason?: string | null;
  /** Required when the club's territory differs from the intern's. */
  territoryOverrideReason?: string | null;
};

export type AssignOutcome =
  | { status: 'assigned'; assignmentId: string }
  | { status: 'unchanged'; assignmentId: string }
  | { status: 'reassigned'; assignmentId: string; previousInternId: string };

/**
 * Assign one organization. Idempotent: assigning to the intern who already
 * owns it reports `unchanged` rather than churning history.
 */
export async function assignOrganization(tx: Tx, options: AssignOptions): Promise<AssignOutcome> {
  const [org] = await tx<{ id: string; territory_id: string | null; name: string }[]>`
    SELECT id, territory_id, name FROM organizations
    WHERE id = ${options.organizationId} AND is_archived = false`;
  if (org === undefined) throw new AssignmentError('That club no longer exists.', 'not_found');

  const [intern] = await tx<
    { id: string; status: string; role: string; territory_id: string | null }[]
  >`
    SELECT u.id, u.status::text, u.role::text, m.territory_id
    FROM users u
    LEFT JOIN cohort_memberships m ON m.user_id = u.id AND m.left_on IS NULL
    WHERE u.id = ${options.internUserId}`;
  if (intern === undefined) throw new AssignmentError('That intern no longer exists.', 'not_found');
  if (intern.status !== 'active') {
    throw new AssignmentError(
      'That intern is deactivated and cannot receive leads.',
      'inactive_intern',
    );
  }
  if (intern.role !== 'intern') {
    throw new AssignmentError('Leads can only be assigned to intern accounts.', 'not_permitted');
  }

  // A territory mismatch is allowed, but only as a deliberate, recorded choice.
  const mismatch =
    org.territory_id !== null &&
    intern.territory_id !== null &&
    org.territory_id !== intern.territory_id;
  if (mismatch && !options.territoryOverrideReason) {
    throw new AssignmentError(
      `${org.name} is outside that intern's territory. Provide an override reason to assign it anyway.`,
      'territory_mismatch',
    );
  }

  const [current] = await tx<{ id: string; intern_user_id: string }[]>`
    SELECT id, intern_user_id FROM organization_assignments
    WHERE organization_id = ${options.organizationId} AND unassigned_at IS NULL
    FOR UPDATE`;

  if (current !== undefined && current.intern_user_id === options.internUserId) {
    return { status: 'unchanged', assignmentId: current.id };
  }

  if (current !== undefined) {
    await tx`
      UPDATE organization_assignments
      SET unassigned_at = now(), unassigned_by = ${options.actorUserId}
      WHERE id = ${current.id}`;
  }

  // A savepoint so a losing race rolls back only this INSERT, leaving the
  // surrounding (possibly bulk) transaction usable.
  const inserted = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO organization_assignments
        (organization_id, intern_user_id, assigned_by, reason, territory_override_reason)
      VALUES (${options.organizationId}, ${options.internUserId}, ${options.actorUserId},
              ${options.reason ?? null}, ${mismatch ? (options.territoryOverrideReason ?? null) : null})
      RETURNING id`;
    return row;
  });

  if (!inserted.ok || inserted.value === undefined) {
    if (!inserted.ok && !isUniqueViolation(inserted.error)) throw inserted.error;
    throw new AssignmentError(
      'Another admin assigned this club a moment ago. Reload and try again.',
      'collision',
    );
  }
  const assignmentId = inserted.value.id;

  await recordAudit(tx, {
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    action: current === undefined ? 'assignment.created' : 'assignment.reassigned',
    entityType: 'organization',
    entityId: options.organizationId,
    before: current ? { internUserId: current.intern_user_id } : null,
    after: { internUserId: options.internUserId, territoryOverride: mismatch },
    reason: options.reason ?? options.territoryOverrideReason ?? null,
  });

  return current === undefined
    ? { status: 'assigned', assignmentId }
    : { status: 'reassigned', assignmentId, previousInternId: current.intern_user_id };
}

export async function unassignOrganization(
  tx: Tx,
  options: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    organizationId: string;
    reason?: string | null;
  },
): Promise<{ status: 'unassigned' | 'not_assigned' }> {
  const [current] = await tx<{ id: string; intern_user_id: string }[]>`
    UPDATE organization_assignments
    SET unassigned_at = now(), unassigned_by = ${options.actorUserId}, reason = ${options.reason ?? null}
    WHERE organization_id = ${options.organizationId} AND unassigned_at IS NULL
    RETURNING id, intern_user_id`;

  if (current === undefined) return { status: 'not_assigned' };

  await recordAudit(tx, {
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    action: 'assignment.removed',
    entityType: 'organization',
    entityId: options.organizationId,
    before: { internUserId: current.intern_user_id },
    after: null,
    reason: options.reason ?? null,
  });
  return { status: 'unassigned' };
}

export type BulkAssignResult = {
  assigned: number;
  reassigned: number;
  unchanged: number;
  failures: { organizationId: string; reason: string }[];
};

/**
 * Bulk assign, applied one organization at a time so a single collision or
 * territory mismatch is reported rather than aborting the whole batch.
 */
export async function bulkAssign(
  tx: Tx,
  options: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    organizationIds: readonly string[];
    internUserId: string;
    reason?: string | null;
    territoryOverrideReason?: string | null;
  },
): Promise<BulkAssignResult> {
  const result: BulkAssignResult = { assigned: 0, reassigned: 0, unchanged: 0, failures: [] };
  for (const organizationId of options.organizationIds) {
    // Each organization gets its own savepoint, so one rejected club (a
    // territory mismatch, a concurrent claim) does not abort the batch.
    const outcome = await attempt(tx, (sp) =>
      assignOrganization(sp, { ...options, organizationId }),
    );
    if (outcome.ok) {
      if (outcome.value.status === 'assigned') result.assigned += 1;
      else if (outcome.value.status === 'reassigned') result.reassigned += 1;
      else result.unchanged += 1;
    } else {
      result.failures.push({
        organizationId,
        reason:
          outcome.error instanceof AssignmentError
            ? outcome.error.message
            : 'Unexpected error while assigning.',
      });
    }
  }
  return result;
}

/**
 * Deterministic even distribution.
 *
 * Re-exported from src/lib/distribution.ts so the admin's on-screen preview
 * and this server-side application share one implementation and can never
 * disagree about which intern gets which club.
 */
export { planEvenDistribution } from '@/lib/distribution';

export type CollisionNotice = {
  organizationId: string;
  organizationName: string;
  /** Deliberately minimal: no notes, no contacts, no other intern's identity. */
  alreadyClaimed: true;
};

/**
 * Intern-initiated claim of an organization they researched themselves.
 *
 * The server always checks for an existing organization first. If another
 * intern already owns it the caller gets a minimal collision notice — the
 * other intern's name, notes and contacts are never exposed.
 */
export async function claimResearchedOrganization(
  tx: Tx,
  options: { actorUserId: string; organizationId: string },
): Promise<{ status: 'claimed' } | { status: 'collision'; notice: CollisionNotice }> {
  const [org] = await tx<{ id: string; name: string; created_by: string | null }[]>`
    SELECT id, name, created_by FROM organizations WHERE id = ${options.organizationId}`;
  if (org === undefined) throw new AssignmentError('That club no longer exists.', 'not_found');

  const claimed = await attempt(
    tx,
    (sp) =>
      sp`
      INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by, reason)
      VALUES (${options.organizationId}, ${options.actorUserId}, ${options.actorUserId},
              'Self-claimed researched organization')`,
  );
  if (!claimed.ok) {
    if (!isUniqueViolation(claimed.error)) throw claimed.error;
    return {
      status: 'collision',
      notice: { organizationId: org.id, organizationName: org.name, alreadyClaimed: true },
    };
  }

  await recordAudit(tx, {
    actorUserId: options.actorUserId,
    actorRole: 'intern',
    action: 'assignment.self_claimed',
    entityType: 'organization',
    entityId: options.organizationId,
    after: { internUserId: options.actorUserId },
  });
  return { status: 'claimed' };
}
