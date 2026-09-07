import { describe, expect, it } from 'vitest';
import {
  assertUsablePassword,
  generatePassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  WeakPasswordError,
} from '@/lib/auth/password';

describe('admin passwords', () => {
  it('verifies the password it hashed', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password, including near misses', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', () => {
    expect(hashPassword('a passphrase here')).not.toBe(hashPassword('a passphrase here'));
  });

  it('reads a missing or malformed stored hash as "wrong password", never a throw', () => {
    expect(verifyPassword('anything', null)).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$16384$8$1$only-five-parts')).toBe(false);
    // A tampered row must not be able to ask for a 64 GiB allocation.
    expect(verifyPassword('anything', 'scrypt$99999999$8$1$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('refuses a password too short to be worth having', () => {
    expect(() => assertUsablePassword('short')).toThrow(WeakPasswordError);
    expect(() => hashPassword('short')).toThrow(WeakPasswordError);
    expect(() => assertUsablePassword('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('generates a password that is long enough to be accepted', () => {
    const generated = generatePassword();
    expect(generated.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(verifyPassword(generated, hashPassword(generated))).toBe(true);
  });
});
