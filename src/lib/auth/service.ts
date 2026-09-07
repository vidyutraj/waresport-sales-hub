import '@/lib/server-guard';
import { asSystem, attempt, isUniqueViolation } from '@/lib/db';
import { env } from '@/lib/env';
import { normalizeEmail } from '@/lib/domain/normalize';
import { generateSessionToken, hashIp, hashToken } from './tokens';

/**
 * Authentication service.
 *
 * This workspace is an internal tool on a trusted network, so it deliberately
 * has no password and no email verification. Accounts are created from the
 * backend — `npm run user:create`, or the admin "Add someone" form — and
 * signing in means picking your name from the list on /sign-in.
 *
 * What that buys, and what it does not:
 *  - It is identification, not authentication. Anyone who can reach the app
 *    can sign in as anyone listed. Roles still decide what each account may
 *    do, and RLS still enforces that independently in the database.
 *  - A role is never taken from client input at sign-in: it comes from the
 *    stored user row.
 *  - Sessions are unchanged — an opaque token in an httpOnly cookie, stored
 *    only as a keyed digest, revocable, and expiring.
 *
 * Everything here runs on the privileged "system" connection, because these
 * flows execute *before* an authenticated identity exists. That is the entire
 * reason the privileged connection exists; no business data is read or written
 * from this module.
 */

export type AppRole = 'owner' | 'admin' | 'intern';
export type UserStatus = 'invited' | 'active' | 'deactivated';

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: AppRole;
  status: UserStatus;
  fullName: string | null;
  preferredName: string | null;
  timezone: string;
  waresportOutreachEmail: string | null;
  onboardingCompletedAt: Date | null;
  programAcknowledgedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Creating accounts (backend only)
// ---------------------------------------------------------------------------

export class UserCreationError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'already_exists' | 'not_found',
  ) {
    super(message);
    this.name = 'UserCreationError';
  }
}

export type CreateUserInput = {
  email: string;
  role: AppRole;
  fullName?: string | null;
  preferredName?: string | null;
  timezone?: string | null;
  cohortId?: string | null;
  territoryId?: string | null;
  /** The admin who created the account, when it came from the admin UI. */
  actorUserId?: string | null;
  actorRole?: AppRole | null;
};

/**
 * Create an account.
 *
 * Runs on the system connection: there is no INSERT policy on `users` for the
 * request-scoped connection, which is the point — accounts are never created
 * as a side effect of an ordinary request. The caller does the permission
 * check (`assertAdmin` / `assertOwner`); the actor is recorded in the audit
 * trail.
 */
export async function createUserAccount(
  input: CreateUserInput,
): Promise<{ userId: string; email: string }> {
  const email = normalizeEmail(input.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email)) {
    throw new UserCreationError('Enter a valid email address.', 'invalid_input');
  }
  if (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'intern') {
    throw new UserCreationError('Pick a role.', 'invalid_input');
  }

  return asSystem(async (tx) => {
    const [existing] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    if (existing !== undefined) {
      throw new UserCreationError(
        'That address already has an account in this workspace.',
        'already_exists',
      );
    }

    let cohortStartDate: string | null = null;
    if (input.cohortId != null) {
      const [cohort] = await tx<{ start_date: string }[]>`
        SELECT start_date::text AS start_date FROM cohorts WHERE id = ${input.cohortId}`;
      if (cohort === undefined) throw new UserCreationError('Unknown cohort.', 'not_found');
      cohortStartDate = cohort.start_date;
    }
    if (input.territoryId != null) {
      const [territory] = await tx<{ id: string }[]>`
        SELECT id FROM territories WHERE id = ${input.territoryId}`;
      if (territory === undefined) throw new UserCreationError('Unknown territory.', 'not_found');
    }

    // A concurrent create of the same address loses the unique index rather
    // than aborting the surrounding transaction.
    const created = await attempt(tx, async (sp) => {
      const [row] = await sp<{ id: string }[]>`
        INSERT INTO users (email, role, status, full_name, preferred_name, timezone)
        VALUES (
          ${email},
          ${input.role}::app_role,
          'active',
          ${input.fullName?.trim() || null},
          ${input.preferredName?.trim() || null},
          ${input.timezone?.trim() || 'America/New_York'}
        )
        RETURNING id`;
      return row;
    });

    if (!created.ok) {
      if (isUniqueViolation(created.error)) {
        throw new UserCreationError(
          'That address already has an account in this workspace.',
          'already_exists',
        );
      }
      throw created.error;
    }
    const user = created.value;
    if (user === undefined) {
      throw new UserCreationError('Could not create that account.', 'invalid_input');
    }

    if (input.cohortId != null) {
      await tx`
        INSERT INTO cohort_memberships (user_id, cohort_id, territory_id, joined_on)
        VALUES (
          ${user.id},
          ${input.cohortId},
          ${input.territoryId ?? null},
          GREATEST(${cohortStartDate}::date, current_date)
        )
        ON CONFLICT (user_id, cohort_id) DO NOTHING`;
    }

    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data, reason)
      VALUES (
        ${input.actorUserId ?? user.id},
        ${input.actorRole ?? input.role}::app_role,
        'user.created',
        'user',
        ${user.id}::text,
        jsonb_build_object('email', ${email}::text, 'role', ${input.role}::text),
        ${input.actorUserId == null ? 'Created from the backend' : 'Created by an admin'}
      )`;

    return { userId: user.id, email };
  });
}

// ---------------------------------------------------------------------------
// Signing in: pick who you are
// ---------------------------------------------------------------------------

export type SignInChoice = {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  lastSignInAt: Date | null;
};

/** Everyone who can be picked on the sign-in screen. */
export async function listSignInChoices(): Promise<SignInChoice[]> {
  return asSystem(async (tx) => {
    const rows = await tx<
      {
        id: string;
        email: string;
        role: AppRole;
        name: string;
        last_sign_in_at: Date | null;
      }[]
    >`
      SELECT id, email::text AS email, role,
             coalesce(
               nullif(btrim(preferred_name), ''),
               nullif(btrim(full_name), ''),
               email::text
             ) AS name,
             last_sign_in_at
      FROM users
      WHERE status <> 'deactivated'
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`;

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      name: r.name,
      lastSignInAt: r.last_sign_in_at,
    }));
  });
}

export type StartSessionResult =
  | { ok: true; userId: string; sessionToken: string }
  | { ok: false; reason: 'not_found' | 'deactivated' };

/** Start a session for the account that was picked. */
export async function startSessionForUser(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<StartSessionResult> {
  const e = env();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.userId)) {
    return { ok: false, reason: 'not_found' };
  }

  return asSystem(async (tx) => {
    const [user] = await tx<{ id: string; status: UserStatus }[]>`
      SELECT id, status FROM users WHERE id = ${input.userId} LIMIT 1`;
    if (user === undefined) return { ok: false as const, reason: 'not_found' as const };
    if (user.status === 'deactivated') {
      return { ok: false as const, reason: 'deactivated' as const };
    }

    await tx`
      UPDATE users
      SET last_sign_in_at = now(),
          status = CASE WHEN status = 'invited' THEN 'active'::user_status ELSE status END
      WHERE id = ${user.id}`;

    const sessionToken = generateSessionToken();
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_hash)
      VALUES (
        ${user.id},
        ${hashToken(sessionToken, e.AUTH_SECRET)},
        now() + make_interval(hours => ${e.SESSION_TTL_HOURS}::int),
        ${(input.userAgent ?? '').slice(0, 400) || null},
        ${hashIp(input.ip, e.AUTH_SECRET)}
      )`;

    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data)
      SELECT u.id, u.role, 'auth.signed_in', 'user', u.id::text,
             jsonb_build_object('email', u.email::text)
      FROM users u WHERE u.id = ${user.id}`;

    return { ok: true as const, userId: user.id, sessionToken };
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function loadSessionUser(token: string): Promise<AuthenticatedUser | null> {
  const e = env();
  if (token.length < 16 || token.length > 256) return null;

  return asSystem(async (tx) => {
    const [row] = await tx<
      {
        id: string;
        email: string;
        role: AppRole;
        status: UserStatus;
        full_name: string | null;
        preferred_name: string | null;
        timezone: string;
        waresport_outreach_email: string | null;
        onboarding_completed_at: Date | null;
        program_acknowledged_at: Date | null;
        session_id: string;
      }[]
    >`
      SELECT u.id, u.email::text AS email, u.role, u.status, u.full_name, u.preferred_name,
             u.timezone, u.waresport_outreach_email::text AS waresport_outreach_email,
             u.onboarding_completed_at, u.program_acknowledged_at, s.id AS session_id
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(token, e.AUTH_SECRET)}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1`;

    if (row === undefined) return null;

    // Deactivation takes effect immediately, even for a live session.
    if (row.status !== 'active') {
      await tx`UPDATE sessions SET revoked_at = now() WHERE id = ${row.session_id}`;
      return null;
    }

    await tx`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.session_id}`;

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      fullName: row.full_name,
      preferredName: row.preferred_name,
      timezone: row.timezone,
      waresportOutreachEmail: row.waresport_outreach_email,
      onboardingCompletedAt: row.onboarding_completed_at,
      programAcknowledgedAt: row.program_acknowledged_at,
    };
  });
}

export async function revokeSession(token: string): Promise<void> {
  const e = env();
  await asSystem(async (tx) => {
    await tx`
      UPDATE sessions SET revoked_at = now()
      WHERE token_hash = ${hashToken(token, e.AUTH_SECRET)} AND revoked_at IS NULL`;
  });
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await asSystem(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  });
}
