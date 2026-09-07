import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Admin password hashing.
 *
 * Interns sign in by picking their name. Admin and owner accounts additionally
 * require a password, because picking a name is not a credential and the admin
 * portal is where the damage would be.
 *
 * scrypt with the parameters below takes ~100ms per attempt, which is the
 * point: it makes an offline attack on a stolen hash expensive, and it rate
 * limits online guessing on its own. The stored string carries its own
 * parameters, so they can be raised later without invalidating old hashes.
 *
 * Format:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 */

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 10;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

export function assertUsablePassword(password: string): void {
  if (password.trim().length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters. Use a passphrase.`,
    );
  }
}

export function hashPassword(password: string): string {
  assertUsablePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Constant-time verification.
 *
 * Returns false for anything malformed rather than throwing: a corrupt stored
 * hash must read as "wrong password", never as an unhandled error on the
 * sign-in path.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (stored === null || stored === '') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p))
    return false;
  // Reject absurd parameters from a tampered row rather than trying to honour
  // them: scrypt allocates roughly 128 * N * r bytes.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = scryptSync(password.normalize('NFKC'), salt, expected.length, { N: n, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** A readable, high-entropy passphrase for a freshly created admin account. */
export function generatePassword(): string {
  // 24 base64url characters ≈ 144 bits. Ambiguous characters are not a concern
  // because this is copied and pasted, never transcribed by hand.
  return randomBytes(18).toString('base64url');
}
