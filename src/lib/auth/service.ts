import '@/lib/server-guard';
import { asSystem, attempt, isUniqueViolation } from '@/lib/db';
import { env } from '@/lib/env';
import { normalizeEmail } from '@/lib/domain/normalize';
import { generateSessionToken, hashIp, hashToken } from './tokens';
import { hashPassword, verifyPassword } from './password';

/**
 * Authentication service.
 *
 * This workspace is an internal tool on a trusted network, so signing in as an
 * intern is deliberately lightweight: accounts are created from the backend —
 * `npm run user:create`, or the admin "Add someone" form — and you pick your
 * name from the list on /sign-in.
 *
 * Admin and owner accounts are the exception. Picking a name identifies you but
 * proves nothing, and the admin portal manages accounts, targets, verification
 * and payouts, so those accounts additionally require a password. An admin or
 * owner account with no password set cannot sign in at all — that is what keeps
 * an intern from simply picking the admin card.
 *
 * What that buys, and what it does not:
 *  - Intern sign-in is identification, not authentication: anyone who can reach
 *    the app can sign in as any listed intern. Roles still decide what each
 *    account may do, and RLS still enforces that in the database.
 *  - A role is never taken from client input at sign-in: it comes from the
 *    stored user row.
 *  - Passwords are stored only as scrypt digests and are writable only on the
 *    system connection; a database trigger rejects any attempt to change one
 *    through the request-scoped role.
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
    readonly code: 'invalid_input' | 'already_exists' | 'not_found' | 'password_required',
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
  /** Required for an admin or owner; optional (and unusual) for an intern. */
  password?: string | null;
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

  const password = input.password?.trim() || null;
  if (password === null && roleNeedsPassword(input.role)) {
    throw new UserCreationError(
      `An ${input.role} account needs a password before it can be used.`,
      'password_required',
    );
  }
  // Hash before the transaction: scrypt takes ~100ms and there is no reason to
  // hold a connection open for it.
  const passwordHash = password === null ? null : hashPassword(password);

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
        INSERT INTO users (email, role, status, full_name, preferred_name, timezone,
                           password_hash, password_set_at)
        VALUES (
          ${email},
          ${input.role}::app_role,
          'active',
          ${input.fullName?.trim() || null},
          ${input.preferredName?.trim() || null},
          ${input.timezone?.trim() || 'America/New_York'},
          ${passwordHash},
          ${passwordHash === null ? null : new Date()}
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

/** Admin and owner accounts always need a password; interns only if one is set. */
export function roleNeedsPassword(role: AppRole): boolean {
  return role === 'admin' || role === 'owner';
}

export type SignInChoice = {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  lastSignInAt: Date | null;
  /** The account must present a password to sign in. */
  requiresPassword: boolean;
  /**
   * Requires a password but has none set, so it cannot be signed into until an
   * administrator sets one (`npm run user:set-password`).
   */
  passwordMissing: boolean;
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
        has_password: boolean;
      }[]
    >`
      SELECT id, email::text AS email, role,
             coalesce(
               nullif(btrim(preferred_name), ''),
               nullif(btrim(full_name), ''),
               email::text
             ) AS name,
             last_sign_in_at,
             (password_hash IS NOT NULL) AS has_password
      FROM users
      WHERE status <> 'deactivated'
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`;

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      name: r.name,
      lastSignInAt: r.last_sign_in_at,
      requiresPassword: roleNeedsPassword(r.role) || r.has_password,
      passwordMissing: roleNeedsPassword(r.role) && !r.has_password,
    }));
  });
}

export type StartSessionResult =
  | { ok: true; userId: string; sessionToken: string }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'deactivated'
        | 'password_required'
        | 'password_not_set'
        | 'wrong_password'
        | 'locked';
      /** Seconds until a locked account may try again. */
      retryAfterSeconds?: number;
    };

/** Ten wrong passwords in a row locks the account for fifteen minutes. */
const MAX_PASSWORD_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

/**
 * Start a session for the account that was picked.
 *
 * An account that requires a password only gets a session when `password`
 * verifies. The requirement is decided here, from the stored row — never from
 * anything the client sent — so posting straight to the action cannot skip it.
 */
export async function startSessionForUser(input: {
  userId: string;
  password?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<StartSessionResult> {
  const e = env();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.userId)) {
    return { ok: false, reason: 'not_found' };
  }

  // Read the account, decide what it needs, and verify outside a transaction:
  // scrypt is deliberately slow and must not hold a database connection.
  const account = await asSystem(async (tx) => {
    const [row] = await tx<
      {
        id: string;
        status: UserStatus;
        role: AppRole;
        password_hash: string | null;
        failed_password_attempts: number;
        password_locked_until: Date | null;
      }[]
    >`
      SELECT id, status, role, password_hash, failed_password_attempts, password_locked_until
      FROM users WHERE id = ${input.userId} LIMIT 1`;
    return row;
  });

  if (account === undefined) return { ok: false, reason: 'not_found' };
  if (account.status === 'deactivated') return { ok: false, reason: 'deactivated' };

  const needsPassword = roleNeedsPassword(account.role) || account.password_hash !== null;

  if (needsPassword) {
    if (account.password_hash === null) return { ok: false, reason: 'password_not_set' };

    const lockedUntil = account.password_locked_until;
    if (lockedUntil !== null && lockedUntil.getTime() > Date.now()) {
      return {
        ok: false,
        reason: 'locked',
        retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
      };
    }

    const supplied = input.password ?? '';
    if (supplied === '') return { ok: false, reason: 'password_required' };

    if (!verifyPassword(supplied, account.password_hash)) {
      const attempts = await asSystem(async (tx) => {
        const [row] = await tx<{ failed_password_attempts: number }[]>`
          UPDATE users
          SET failed_password_attempts = failed_password_attempts + 1,
              password_locked_until = CASE
                WHEN failed_password_attempts + 1 >= ${MAX_PASSWORD_ATTEMPTS}
                  THEN now() + make_interval(mins => ${LOCKOUT_MINUTES}::int)
                ELSE password_locked_until
              END
          WHERE id = ${account.id}
          RETURNING failed_password_attempts`;
        return row?.failed_password_attempts ?? 0;
      });
      return attempts >= MAX_PASSWORD_ATTEMPTS
        ? { ok: false, reason: 'locked', retryAfterSeconds: LOCKOUT_MINUTES * 60 }
        : { ok: false, reason: 'wrong_password' };
    }
  }

  return asSystem(async (tx) => {
    await tx`
      UPDATE users
      SET last_sign_in_at = now(),
          status = CASE WHEN status = 'invited' THEN 'active'::user_status ELSE status END,
          failed_password_attempts = 0,
          password_locked_until = NULL
      WHERE id = ${account.id}`;

    const sessionToken = generateSessionToken();
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_hash)
      VALUES (
        ${account.id},
        ${hashToken(sessionToken, e.AUTH_SECRET)},
        now() + make_interval(hours => ${e.SESSION_TTL_HOURS}::int),
        ${(input.userAgent ?? '').slice(0, 400) || null},
        ${hashIp(input.ip, e.AUTH_SECRET)}
      )`;

    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data)
      SELECT u.id, u.role, 'auth.signed_in', 'user', u.id::text,
             jsonb_build_object('email', u.email::text)
      FROM users u WHERE u.id = ${account.id}`;

    return { ok: true as const, userId: account.id, sessionToken };
  });
}

/** One account, for rendering the password step. */
export async function findSignInChoice(userId: string): Promise<SignInChoice | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const choices = await listSignInChoices();
  return choices.find((c) => c.id === userId) ?? null;
}

// ---------------------------------------------------------------------------
// Setting a password (backend only)
// ---------------------------------------------------------------------------

/**
 * Set or replace an account's password, and sign it out everywhere.
 *
 * Reachable from `npm run user:set-password` only. Every live session for the
 * account is revoked, so changing the password actually locks out whoever had
 * the old one.
 */
export async function setUserPassword(input: {
  emailOrId: string;
  password: string;
}): Promise<{ userId: string; email: string }> {
  const hash = hashPassword(input.password);
  const identifier = input.emailOrId.trim();
  const email = normalizeEmail(identifier);

  const user = await asSystem(async (tx) => {
    const [row] = await tx<{ id: string; email: string }[]>`
      UPDATE users
      SET password_hash = ${hash},
          password_set_at = now(),
          failed_password_attempts = 0,
          password_locked_until = NULL
      WHERE id::text = ${identifier} OR email = ${email || identifier}
      RETURNING id, email::text AS email`;
    return row;
  });

  if (user === undefined) {
    throw new UserCreationError(`No account matches "${identifier}".`, 'not_found');
  }

  await revokeAllSessionsForUser(user.id);
  return { userId: user.id, email: user.email };
}

// ---------------------------------------------------------------------------
// Changing an account from the backend
// ---------------------------------------------------------------------------

/** Look one account up by id or email, on the system connection. */
async function findAccount(
  emailOrId: string,
): Promise<{ id: string; email: string; role: AppRole; status: UserStatus; hasPassword: boolean }> {
  const identifier = emailOrId.trim();
  const email = normalizeEmail(identifier);
  const row = await asSystem(async (tx) => {
    const [found] = await tx<
      {
        id: string;
        email: string;
        role: AppRole;
        status: UserStatus;
        has_password: boolean;
      }[]
    >`
      SELECT id, email::text AS email, role, status, (password_hash IS NOT NULL) AS has_password
      FROM users
      WHERE id::text = ${identifier} OR email = ${email || identifier}
      LIMIT 1`;
    return found;
  });
  if (row === undefined) {
    throw new UserCreationError(`No account matches "${identifier}".`, 'not_found');
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    hasPassword: row.has_password,
  };
}

/**
 * Change an account's role.
 *
 * Promoting to admin or owner without a password would create an account that
 * cannot sign in, so that is refused here rather than discovered later at the
 * sign-in screen.
 */
export async function setAccountRole(input: {
  emailOrId: string;
  role: AppRole;
}): Promise<{ userId: string; email: string; previousRole: AppRole }> {
  const account = await findAccount(input.emailOrId);
  if (account.role === input.role) {
    return { userId: account.id, email: account.email, previousRole: account.role };
  }
  if (roleNeedsPassword(input.role) && !account.hasPassword) {
    throw new UserCreationError(
      `${account.email} has no password, and an ${input.role} needs one. Set a password first.`,
      'password_required',
    );
  }

  await asSystem(async (tx) => {
    await tx`UPDATE users SET role = ${input.role}::app_role WHERE id = ${account.id}`;
    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id,
                                before_data, after_data, reason)
      VALUES (${account.id}, ${input.role}::app_role, 'user.role_changed', 'user', ${account.id}::text,
              jsonb_build_object('role', ${account.role}::text),
              jsonb_build_object('role', ${input.role}::text),
              'Changed from the backend')`;
  });

  return { userId: account.id, email: account.email, previousRole: account.role };
}

/**
 * Deactivate or reactivate an account.
 *
 * Deactivating drops it off the sign-in screen and kills its live sessions on
 * the next request. Nothing it produced is deleted: imports, activity and
 * meetings stay attributed to it, which is why this is the right way to retire
 * an account rather than removing the row.
 *
 * The database refuses to deactivate the last active owner; that surfaces here
 * as a plain message.
 */
export async function setAccountActive(input: {
  emailOrId: string;
  active: boolean;
}): Promise<{ userId: string; email: string; role: AppRole }> {
  const account = await findAccount(input.emailOrId);
  const status: UserStatus = input.active ? 'active' : 'deactivated';

  try {
    await asSystem(async (tx) => {
      await tx`UPDATE users SET status = ${status}::user_status WHERE id = ${account.id}`;
      await tx`
        INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id,
                                  before_data, after_data, reason)
        VALUES (${account.id}, ${account.role}::app_role,
                ${input.active ? 'user.reactivated' : 'user.deactivated'},
                'user', ${account.id}::text,
                jsonb_build_object('status', ${account.status}::text),
                jsonb_build_object('status', ${status}::text),
                'Changed from the backend')`;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('last active owner')) {
      throw new UserCreationError(
        'That is the only active owner. Promote another account to owner first.',
        'invalid_input',
      );
    }
    throw error;
  }

  if (!input.active) await revokeAllSessionsForUser(account.id);
  return { userId: account.id, email: account.email, role: account.role };
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
