import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '@/lib/security/csp';
import { env, resetEnvCache } from '@/lib/env';

describe('content security policy', () => {
  it('uses a nonce and strict-dynamic when one is supplied, not unsafe-inline', () => {
    const csp = contentSecurityPolicy({ nonce: 'abc123' });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('falls back to unsafe-inline only when there is no nonce', () => {
    expect(contentSecurityPolicy({})).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('never allows eval or plugins outside development', () => {
    const csp = contentSecurityPolicy({ nonce: 'abc123' });
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('allows eval in development, where React needs it for error overlays', () => {
    expect(contentSecurityPolicy({ nonce: 'abc123', isDev: true })).toContain("'unsafe-eval'");
  });

  it('upgrades insecure requests only over https', () => {
    expect(contentSecurityPolicy({ https: true })).toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy({ https: false })).not.toContain('upgrade-insecure-requests');
  });
});

describe('deployment configuration guard', () => {
  const SAFE = {
    NODE_ENV: 'production',
    APP_URL: 'https://sales.example.com',
    AUTH_SECRET: 'a-real-secret-that-is-long-enough-to-pass-0123',
    DATABASE_URL: 'postgres://owner:pw@db.example.com:5432/app?sslmode=require',
    APP_DATABASE_URL: 'postgres://app:pw@db.example.com:5432/app?sslmode=require',
  };

  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    resetEnvCache();
  });

  afterEach(() => {
    process.env = saved;
    resetEnvCache();
  });

  function load(overrides: Record<string, string>) {
    process.env = { ...saved, ...SAFE, ...overrides } as NodeJS.ProcessEnv;
    resetEnvCache();
    return () => env();
  }

  it('accepts a correctly configured deployment', () => {
    expect(load({})).not.toThrow();
  });

  it('refuses the example secret', () => {
    expect(load({ AUTH_SECRET: 'dev-only-insecure-secret-change-me-0123456789abcdef' })).toThrow(
      /AUTH_SECRET is still the example value/,
    );
  });

  it('refuses plain HTTP, which would drop the Secure flag off session cookies', () => {
    expect(load({ APP_URL: 'http://sales.example.com' })).toThrow(/must be https/);
  });

  it('refuses a hosted database reached without TLS', () => {
    expect(load({ DATABASE_URL: 'postgres://owner:pw@db.example.com:5432/app' })).toThrow(
      /DATABASE_URL must use TLS/,
    );
  });

  it('refuses running business queries on the owning connection, which bypasses RLS', () => {
    expect(load({ APP_DATABASE_URL: SAFE.DATABASE_URL })).toThrow(/row level security/);
  });

  it('leaves loopback alone, so a local production build and the e2e suite still run', () => {
    expect(
      load({
        APP_URL: 'http://127.0.0.1:3000',
        AUTH_SECRET: 'dev-only-insecure-secret-change-me-0123456789abcdef',
        DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/waresport',
      }),
    ).not.toThrow();
  });

  it('allows a provider private network (Fly, Railway) without TLS', () => {
    expect(
      load({
        DATABASE_URL: 'postgres://owner:pw@app-db.internal:5432/app',
        APP_DATABASE_URL: 'postgres://app:pw@app-db.internal:5432/app',
      }),
    ).not.toThrow();
  });
});
