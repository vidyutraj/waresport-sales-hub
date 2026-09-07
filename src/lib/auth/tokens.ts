import { createHash, randomBytes } from 'node:crypto';

/**
 * Session token primitives.
 *
 * A session token is only ever persisted as a keyed SHA-256 digest. The
 * plaintext exists in the user's cookie and nowhere else, so a database dump
 * cannot be replayed as a login.
 */

/** 32 bytes of CSPRNG entropy, base64url encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Keyed digest. The secret makes precomputation across deployments useless. */
export function hashToken(token: string, secret: string): Buffer {
  return createHash('sha256').update(`${secret}:${token}`).digest();
}

export function hashIp(ip: string | null | undefined, secret: string): Buffer | null {
  const value = (ip ?? '').trim();
  if (value === '') return null;
  // Hashed so that logs and audit rows never carry a raw address.
  return createHash('sha256').update(`ip:${secret}:${value}`).digest();
}

export const SESSION_COOKIE_NAME = 'waresport_session';
/** Used over HTTPS. `__Host-` locks the cookie to this exact origin. */
export const HOST_SESSION_COOKIE_NAME = '__Host-waresport_session';
