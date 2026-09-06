import '@/lib/server-guard';
import { asSystem, attempt, isUniqueViolation, type Tx } from '@/lib/db';
import { env, ownerBootstrapEmails } from '@/lib/env';
import { normalizeEmail } from '@/lib/domain/normalize';
import {
  digestsEqual,
  generateOtpCode,
  generateSessionToken,
  hashIp,
  hashToken,
  isWellFormedOtp,
} from './tokens';
import { invitationMessage, sendMail, signInCodeMessage } from './mailer';

/**
 * Authentication service.
 *
 * Everything here runs on the privileged "system" connection, because these
 * flows execute *before* an authenticated identity exists. That is the entire
 * reason the privileged connection exists; no business data is read or written
 * from this module.
 *
 * Design rules enforced below:
 *  - A role is never accepted from client input. It comes from the server-side
 *    invitation record, or from the owner-bootstrap allowlist.
 *  - An invitation claim is atomic and bound to the invited address.
 *  - A verified user with no invitation and no existing account gets nothing.
 *  - Codes and session tokens are stored only as keyed digests.
 *  - Failures are reported without revealing whether an address exists.
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
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter. Returns false once the limit for the current window is
 * exhausted. Durable (survives a restart) and safe under concurrency because
 * the increment happens in a single upsert.
 */
export async function consumeRateLimit(
  tx: Tx,
  bucket: string,
  subject: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const rows = await tx<{ count: number }[]>`
    INSERT INTO rate_limits (bucket, subject, window_start, count)
    VALUES (
      ${bucket},
      ${subject},
      to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}::int) * ${windowSeconds}::int),
      1
    )
    ON CONFLICT (bucket, subject, window_start)
      DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`;
  return (rows[0]?.count ?? limit + 1) <= limit;
}

/** Configured limits, read per call so a deployment can tune them. */
function rateLimits() {
  const e = env();
  return {
    /** Code requests per email address. */
    requestPerEmail: {
      limit: e.AUTH_REQUEST_LIMIT_PER_EMAIL,
      windowSeconds: e.AUTH_RATE_WINDOW_SECONDS,
    },
    /** Code requests per client address, to blunt enumeration sweeps. */
    requestPerIp: { limit: e.AUTH_REQUEST_LIMIT_PER_IP, windowSeconds: e.AUTH_RATE_WINDOW_SECONDS },
    /** Verification attempts per email address. */
    verifyPerEmail: {
      limit: e.AUTH_VERIFY_LIMIT_PER_EMAIL,
      windowSeconds: e.AUTH_RATE_WINDOW_SECONDS,
    },
  };
}

// ---------------------------------------------------------------------------
// Requesting a one-time code
// ---------------------------------------------------------------------------

export type RequestCodeResult =
  | { ok: true; delivered: boolean; cooldownSeconds: number }
  | { ok: false; reason: 'rate_limited' | 'cooldown' | 'invalid_email'; retryAfterSeconds: number };

/**
 * Issue a sign-in or invitation code.
 *
 * `delivered` is deliberately not surfaced to the client: an address with no
 * account and no invitation gets the same visible response as one that does.
 */
export async function requestAccessCode(input: {
  email: string;
  ip?: string | null;
}): Promise<RequestCodeResult> {
  const e = env();
  const email = normalizeEmail(input.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email)) {
    return { ok: false, reason: 'invalid_email', retryAfterSeconds: 0 };
  }

  const limits = rateLimits();

  return asSystem(async (tx) => {
    const ipKey = input.ip ?? 'unknown';
    const emailOk = await consumeRateLimit(
      tx,
      'auth_request_email',
      email,
      limits.requestPerEmail.limit,
      limits.requestPerEmail.windowSeconds,
    );
    const ipOk = await consumeRateLimit(
      tx,
      'auth_request_ip',
      ipKey,
      limits.requestPerIp.limit,
      limits.requestPerIp.windowSeconds,
    );
    if (!emailOk || !ipOk) {
      return {
        ok: false as const,
        reason: 'rate_limited' as const,
        retryAfterSeconds: limits.requestPerEmail.windowSeconds,
      };
    }

    // Resend cooldown: a fresh code cannot be minted immediately after one.
    const recent = await tx<{ created_at: Date }[]>`
      SELECT created_at FROM auth_codes
      WHERE email = ${email}
        AND consumed_at IS NULL
        AND created_at > now() - make_interval(secs => ${e.OTP_RESEND_COOLDOWN_SECONDS}::int)
      ORDER BY created_at DESC LIMIT 1`;
    if (recent.length > 0) {
      const elapsed = (Date.now() - recent[0]!.created_at.getTime()) / 1000;
      return {
        ok: false as const,
        reason: 'cooldown' as const,
        retryAfterSeconds: Math.max(1, Math.ceil(e.OTP_RESEND_COOLDOWN_SECONDS - elapsed)),
      };
    }

    const [user] = await tx<{ id: string; status: UserStatus }[]>`
      SELECT id, status FROM users WHERE email = ${email} LIMIT 1`;
    const [invitation] = await tx<{ id: string; created_by_name: string | null }[]>`
      SELECT i.id, coalesce(u.preferred_name, u.full_name, u.email::text) AS created_by_name
      FROM invitations i
      JOIN users u ON u.id = i.created_by
      WHERE i.email = ${email}
        AND i.claimed_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > now()
      LIMIT 1`;

    // A deactivated account is silently given nothing — same visible response.
    const eligible =
      (user !== undefined && user.status !== 'deactivated') || invitation !== undefined;
    if (!eligible) {
      return {
        ok: true as const,
        delivered: false,
        cooldownSeconds: e.OTP_RESEND_COOLDOWN_SECONDS,
      };
    }

    const code = generateOtpCode();
    const purpose = user === undefined ? 'invite_claim' : 'sign_in';
    await tx`
      INSERT INTO auth_codes (email, purpose, code_hash, invitation_id, max_attempts, expires_at, ip_hash)
      VALUES (
        ${email},
        ${purpose},
        ${hashToken(code, e.AUTH_SECRET)},
        ${invitation?.id ?? null},
        ${e.OTP_MAX_ATTEMPTS},
        now() + make_interval(mins => ${e.OTP_TTL_MINUTES}::int),
        ${hashIp(input.ip, e.AUTH_SECRET)}
      )`;

    if (invitation !== undefined) {
      await tx`
        UPDATE invitations
        SET send_count = send_count + 1, last_sent_at = now()
        WHERE id = ${invitation.id}`;
    }

    // Send after the row exists so a delivery failure cannot mint a usable
    // code the user never receives.
    if (purpose === 'invite_claim' && invitation !== undefined) {
      await sendMail(
        invitationMessage(
          email,
          code,
          e.APP_URL,
          e.INVITE_TTL_HOURS,
          invitation.created_by_name ?? 'A Waresport admin',
        ),
      );
    } else {
      await sendMail(signInCodeMessage(email, code, e.OTP_TTL_MINUTES));
    }

    return { ok: true as const, delivered: true, cooldownSeconds: e.OTP_RESEND_COOLDOWN_SECONDS };
  });
}

// ---------------------------------------------------------------------------
// Verifying a code
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; userId: string; sessionToken: string; isNewAccount: boolean }
  | {
      ok: false;
      reason:
        | 'invalid_code'
        | 'expired'
        | 'too_many_attempts'
        | 'rate_limited'
        | 'no_access'
        | 'deactivated';
      attemptsRemaining?: number;
    };

export async function verifyAccessCode(input: {
  email: string;
  code: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<VerifyResult> {
  const e = env();
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, reason: 'invalid_code' };
  if (!isWellFormedOtp(input.code)) return { ok: false, reason: 'invalid_code' };

  return asSystem(async (tx) => {
    const limits = rateLimits();
    const allowed = await consumeRateLimit(
      tx,
      'auth_verify_email',
      email,
      limits.verifyPerEmail.limit,
      limits.verifyPerEmail.windowSeconds,
    );
    if (!allowed) return { ok: false as const, reason: 'rate_limited' as const };

    // Lock the newest live code for this address so two concurrent
    // verifications cannot both consume it.
    const [record] = await tx<
      {
        id: string;
        code_hash: Buffer;
        attempts: number;
        max_attempts: number;
        purpose: 'sign_in' | 'invite_claim';
        invitation_id: string | null;
        expired: boolean;
      }[]
    >`
      SELECT id, code_hash, attempts, max_attempts, purpose, invitation_id,
             (expires_at <= now()) AS expired
      FROM auth_codes
      WHERE email = ${email} AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`;

    if (record === undefined) return { ok: false as const, reason: 'invalid_code' as const };
    if (record.expired) {
      await tx`UPDATE auth_codes SET consumed_at = now() WHERE id = ${record.id}`;
      return { ok: false as const, reason: 'expired' as const };
    }
    if (record.attempts >= record.max_attempts) {
      await tx`UPDATE auth_codes SET consumed_at = now() WHERE id = ${record.id}`;
      return { ok: false as const, reason: 'too_many_attempts' as const };
    }

    const matches = digestsEqual(record.code_hash, hashToken(input.code, e.AUTH_SECRET));
    if (!matches) {
      const [updated] = await tx<{ attempts: number }[]>`
        UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ${record.id}
        RETURNING attempts`;
      const remaining = Math.max(
        0,
        record.max_attempts - (updated?.attempts ?? record.max_attempts),
      );
      if (remaining === 0) {
        await tx`UPDATE auth_codes SET consumed_at = now() WHERE id = ${record.id}`;
        return { ok: false as const, reason: 'too_many_attempts' as const };
      }
      return { ok: false as const, reason: 'invalid_code' as const, attemptsRemaining: remaining };
    }

    // Single use: burn the code before doing anything else.
    await tx`UPDATE auth_codes SET consumed_at = now() WHERE id = ${record.id}`;

    const [existing] = await tx<{ id: string; status: UserStatus }[]>`
      SELECT id, status FROM users WHERE email = ${email} LIMIT 1`;

    let userId: string;
    let isNewAccount = false;

    if (existing !== undefined) {
      if (existing.status === 'deactivated') {
        return { ok: false as const, reason: 'deactivated' as const };
      }
      userId = existing.id;
      await tx`
        UPDATE users
        SET email_verified_at = coalesce(email_verified_at, now()),
            last_sign_in_at = now(),
            status = CASE WHEN status = 'invited' THEN 'active'::user_status ELSE status END
        WHERE id = ${userId}`;
    } else {
      const claimed = await claimInvitation(tx, email, record.invitation_id);
      if (claimed === null) return { ok: false as const, reason: 'no_access' as const };
      userId = claimed;
      isNewAccount = true;
    }

    const sessionToken = generateSessionToken();
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_hash)
      VALUES (
        ${userId},
        ${hashToken(sessionToken, e.AUTH_SECRET)},
        now() + make_interval(hours => ${e.SESSION_TTL_HOURS}::int),
        ${(input.userAgent ?? '').slice(0, 400) || null},
        ${hashIp(input.ip, e.AUTH_SECRET)}
      )`;

    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data)
      SELECT u.id, u.role, ${isNewAccount ? 'auth.account_created' : 'auth.signed_in'},
             'user', u.id::text, jsonb_build_object('email', u.email::text)
      FROM users u WHERE u.id = ${userId}`;

    return { ok: true as const, userId, sessionToken, isNewAccount };
  });
}

/**
 * Atomically claim an invitation and create the account it grants.
 *
 * The UPDATE ... WHERE claimed_at IS NULL is the whole guarantee: only one
 * transaction can move the row from unclaimed to claimed, so a double submit
 * or a race between two tabs produces exactly one account. The role and
 * territory come from the invitation row, never from anything the client sent.
 */
async function claimInvitation(
  tx: Tx,
  email: string,
  hintedInvitationId: string | null,
): Promise<string | null> {
  const [invitation] = await tx<
    {
      id: string;
      role: AppRole;
      cohort_id: string | null;
      territory_id: string | null;
    }[]
  >`
    UPDATE invitations
    SET claimed_at = now()
    WHERE id = (
      SELECT id FROM invitations
      WHERE email = ${email}
        AND claimed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
        ${hintedInvitationId ? tx`AND id = ${hintedInvitationId}` : tx``}
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, role, cohort_id, territory_id`;

  if (invitation === undefined) return null;

  const [user] = await tx<{ id: string }[]>`
    INSERT INTO users (email, role, status, email_verified_at, last_sign_in_at)
    VALUES (${email}, ${invitation.role}, 'active', now(), now())
    RETURNING id`;
  if (user === undefined) return null;

  await tx`UPDATE invitations SET claimed_by = ${user.id} WHERE id = ${invitation.id}`;

  if (invitation.cohort_id !== null) {
    const [cohort] = await tx<{ start_date: string }[]>`
      SELECT start_date::text AS start_date FROM cohorts WHERE id = ${invitation.cohort_id}`;
    await tx`
      INSERT INTO cohort_memberships (user_id, cohort_id, territory_id, joined_on)
      VALUES (
        ${user.id},
        ${invitation.cohort_id},
        ${invitation.territory_id},
        GREATEST(${cohort?.start_date ?? null}::date, current_date)
      )
      ON CONFLICT (user_id, cohort_id) DO NOTHING`;
  }

  await tx`
    INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data)
    VALUES (${user.id}, ${invitation.role}, 'invitation.claimed', 'invitation', ${invitation.id},
            jsonb_build_object('email', ${email}::text, 'role', ${invitation.role}::text))`;

  return user.id;
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

// ---------------------------------------------------------------------------
// Owner bootstrap
// ---------------------------------------------------------------------------

export class BootstrapError extends Error {}

/**
 * Create (or promote) the first owner.
 *
 * This is a server-side operation only: it is reachable from the CLI
 * (`npm run bootstrap:owner`) and requires the address to appear in the
 * OWNER_BOOTSTRAP_EMAILS allowlist. The first public signup never becomes an
 * owner, and the account still has to verify its email before it can sign in.
 */
export async function bootstrapOwner(input: {
  email: string;
  fullName?: string | null;
  timezone?: string | null;
}): Promise<{ userId: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new BootstrapError('An email address is required.');

  const allowlist = ownerBootstrapEmails();
  if (allowlist.length === 0) {
    throw new BootstrapError(
      'OWNER_BOOTSTRAP_EMAILS is empty. Set it to the intended owner address before bootstrapping.',
    );
  }
  if (!allowlist.includes(email)) {
    throw new BootstrapError(
      `${email} is not in OWNER_BOOTSTRAP_EMAILS. Add it there first — owners are never created from a public signup.`,
    );
  }

  return asSystem(async (tx) => {
    const [existing] = await tx<{ id: string; role: AppRole }[]>`
      SELECT id, role FROM users WHERE email = ${email} LIMIT 1`;

    if (existing !== undefined) {
      if (existing.role === 'owner') return { userId: existing.id, created: false };
      await tx`UPDATE users SET role = 'owner', status = 'active' WHERE id = ${existing.id}`;
      await tx`
        INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, before_data, after_data, reason)
        VALUES (${existing.id}, 'owner', 'user.role_changed', 'user', ${existing.id},
                jsonb_build_object('role', ${existing.role}::text), jsonb_build_object('role', 'owner'),
                'Owner bootstrap via server-side CLI')`;
      return { userId: existing.id, created: false };
    }

    // Savepoint: a concurrent bootstrap of the same address loses the unique
    // index, and we fall through to reading the winner rather than aborting.
    const created = await attempt(tx, async (sp) => {
      const [row] = await sp<{ id: string }[]>`
        INSERT INTO users (email, role, status, full_name, timezone)
        VALUES (${email}, 'owner', 'active', ${input.fullName ?? null},
                ${input.timezone ?? 'America/New_York'})
        RETURNING id`;
      return row;
    });

    if (!created.ok) {
      if (isUniqueViolation(created.error)) {
        const [again] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
        if (again !== undefined) return { userId: again.id, created: false };
      }
      throw created.error;
    }

    const user = created.value;
    if (user === undefined) throw new BootstrapError('Could not create the owner account.');
    await tx`
      INSERT INTO audit_events (actor_user_id, actor_role, action, entity_type, entity_id, after_data, reason)
      VALUES (${user.id}, 'owner', 'user.created', 'user', ${user.id},
              jsonb_build_object('email', ${email}::text, 'role', 'owner'),
              'Owner bootstrap via server-side CLI')`;
    return { userId: user.id, created: true };
  });
}
