import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Plain ESM with one dependency — `postgres`, which the application already
 * bundles — so the exact same runner works locally and inside the production
 * image, where there is no TypeScript loader and no dev dependencies. Two
 * runners would eventually disagree about what "migrated" means.
 *
 * Local runs pick up .env.local / .env when dotenv is installed; a deployment
 * gets its configuration from the platform.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

async function loadLocalEnvIfPresent() {
  try {
    const { config } = await import('dotenv');
    config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
    config({ path: resolve(process.cwd(), '.env'), quiet: true });
  } catch {
    // Not installed in production images. The platform supplies the environment.
  }
}

async function main() {
  await loadLocalEnvIfPresent();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // Same pooler caveat as the application client: no prepared statements when
  // the connection goes through a transaction pooler.
  const pooled = /-pooler\.|pgbouncer=true/.test(url);
  const sql = postgres(url, { max: 1, prepare: !pooled, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`;

    const applied = new Map(
      (await sql`SELECT name, checksum FROM schema_migrations`).map((r) => [r.name, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      const body = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 32);
      const previous = applied.get(file);

      if (previous === checksum) continue;
      if (previous && previous !== checksum) {
        throw new Error(
          `Migration ${file} has already been applied but its contents changed.\n` +
            `Add a new migration instead of editing an applied one (or run npm run db:reset locally).`,
        );
      }

      // Each migration is one transaction: it applies completely or not at all.
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
      console.info(`  applied ${file}`);
      ran += 1;
    }

    console.info(ran === 0 ? 'Database is up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
