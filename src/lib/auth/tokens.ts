import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Token and one-time-code primitives.
 *
 * Session tokens and OTP codes are only ever persisted as a keyed SHA-256
 * digest. The plaintext exists in the user's cookie / inbox and nowhere else,
 * so a database dump cannot be replayed as a login.
 */

/** 32 bytes of CSPRNG entropy, base64url encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A 6-digit numeric code. Uniform over 000000–999999 via rejection-free
 * `randomInt`, so no digit is more likely than another.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Keyed digest. The secret makes precomputation across deployments useless. */
export function hashToken(token: string, secret: string): Buffer {
  return createHash('sha256').update(`${secret}:${token}`).digest();
}

/** Constant-time comparison of two digests. */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hashIp(ip: string | null | undefined, secret: string): Buffer | null {
  const value = (ip ?? '').trim();
  if (value === '') return null;
  // Hashed so that logs and audit rows never carry a raw address.
  return createHash('sha256').update(`ip:${secret}:${value}`).digest();
}

/** Six digits, nothing else. Rejects whitespace and separators up front. */
export function isWellFormedOtp(code: string): boolean {
  return /^[0-9]{6}$/.test(code);
}

export const SESSION_COOKIE_NAME = 'waresport_session';
export const PENDING_COOKIE_NAME = 'waresport_pending';
