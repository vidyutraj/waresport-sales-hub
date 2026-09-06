import '@/lib/server-guard';
import postgres from 'postgres';
import { env } from './env';

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;

/**
 * Two connections, deliberately.
 *
 * `system` connects as the table owner. It is used ONLY by migrations, the
 * unauthenticated authentication surface (one-time codes, sessions, invite
 * claiming) and CLI scripts, because those run before a session identity
 * exists. Every code path that uses it is reviewed and enumerated in
 * docs/architecture.md.
 *
 * `app` connects as `waresport_app`, which owns nothing and has NOBYPASSRLS.
 * All business reads and writes run here inside a transaction that pins
 * `app.user_id`, so PostgreSQL row level security is the last line of
 * defence behind the application's own authorization checks.
 */
const globalForDb = globalThis as unknown as {
  __waresportSystemSql?: Sql;
  __waresportAppSql?: Sql;
};

function create(url: string, max: number): Sql {
  return postgres(url, {
    max,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    onnotice: () => {},
    transform: { undefined: null },
  }) as Sql;
}

export function systemSql(): Sql {
  globalForDb.__waresportSystemSql ??= create(env().DATABASE_URL, 10);
  return globalForDb.__waresportSystemSql;
}

export function appSql(): Sql {
  globalForDb.__waresportAppSql ??= create(env().APP_DATABASE_URL, 20);
  return globalForDb.__waresportAppSql;
}

export type ActorContext = {
  userId: string;
  role: 'owner' | 'admin' | 'intern';
};

/**
 * Run a unit of work as a specific user. The identity is pinned with
 * `SET LOCAL`, so it is scoped to this transaction and cannot leak to the
 * next borrower of the pooled connection.
 */
export async function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appSql().begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx as Tx);
  }) as Promise<T>;
}

/** Read-only convenience wrapper with the same identity pinning. */
export async function readAsUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return asUser(userId, fn);
}

/**
 * Run as an anonymous (unauthenticated) principal against the RLS-enforced
 * connection. Used by tests to prove that anonymous access sees nothing.
 */
export async function asAnonymous<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appSql().begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', '', true)`;
    return fn(tx as Tx);
  }) as Promise<T>;
}

/** Privileged system work. Keep the surface small and auditable. */
export async function asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return systemSql().begin(async (tx) => fn(tx as Tx)) as Promise<T>;
}

export async function closeConnections(): Promise<void> {
  await Promise.all([
    globalForDb.__waresportSystemSql?.end({ timeout: 5 }),
    globalForDb.__waresportAppSql?.end({ timeout: 5 }),
  ]);
  globalForDb.__waresportSystemSql = undefined;
  globalForDb.__waresportAppSql = undefined;
}

/**
 * Run `fn` inside a SAVEPOINT and report failure instead of throwing.
 *
 * This matters because PostgreSQL aborts the whole transaction when a
 * statement raises — catching a unique-violation in JavaScript is not enough,
 * since every later statement on that connection would fail with
 * "current transaction is aborted". Wrapping the risky statement in a
 * savepoint rolls back only that statement, leaving the surrounding
 * transaction usable.
 *
 * Used wherever a constraint violation is an expected outcome: duplicate
 * assignment claims, repeated connection requests, double payouts, and
 * idempotent import upserts.
 */
export async function attempt<T>(
  tx: Tx,
  fn: (tx: Tx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    const value = (await tx.savepoint((sp) => fn(sp as unknown as Tx))) as T;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** PostgreSQL unique-violation, used to detect assignment/payout races. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export function isPrivilegeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === '42501' || error.code === '2F004';
}

/**
 * A `RAISE ... USING ERRCODE = 'restrict_violation'` from one of the integrity
 * triggers. PostgreSQL reports that as SQLSTATE 23001.
 */
export function isRestrictViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23001';
}

export function pgErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return null;
}

export function pgErrorMessage(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return null;
}
