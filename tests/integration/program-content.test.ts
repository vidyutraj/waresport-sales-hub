import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '@/lib/db';
import { as, createUser, tag } from './factories';

/**
 * Resource and project lifecycle, through row level security.
 *
 * These exist because archiving a resource was impossible in production while
 * every test still passed: the only SELECT policy on `resources` filtered out
 * archived rows, so the *new* row of the update was invisible to the actor and
 * PostgreSQL rejected it. An update that left the flag alone succeeded, which
 * is exactly why nothing caught it.
 *
 * The lesson generalises: whenever a read policy filters on a column the
 * application also writes, flipping that column has to be exercised for real.
 */

let admin: string;
let intern: string;

beforeAll(async () => {
  const t = tag();
  admin = await createUser({ email: `admin-${t}@example.test`, role: 'admin' });
  intern = await createUser({ email: `intern-${t}@example.test`, role: 'intern' });
});

async function createResource(title: string): Promise<string> {
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO resources (title, category, audience, summary, created_by)
      VALUES (${title}, 'training', 'all', 'Fixture', ${admin})
      RETURNING id`;
    return row!.id;
  });
}

describe('archiving a resource', () => {
  it('an admin can archive one, and it stays archived', async () => {
    const id = await createResource(`Archivable ${tag()}`);

    await as(admin, async (tx) => {
      await tx`UPDATE resources SET is_archived = true WHERE id = ${id}`;
    });

    const [row] = await asSystem(
      (tx) => tx<{ is_archived: boolean }[]>`SELECT is_archived FROM resources WHERE id = ${id}`,
    );
    expect(row?.is_archived).toBe(true);
  });

  it('an admin can still see an archived resource, so it can be restored', async () => {
    const id = await createResource(`Restorable ${tag()}`);

    await as(admin, async (tx) => {
      await tx`UPDATE resources SET is_archived = true WHERE id = ${id}`;
    });

    const visible = await as(
      admin,
      (tx) => tx<{ id: string }[]>`SELECT id FROM resources WHERE id = ${id}`,
    );
    expect(visible).toHaveLength(1);

    await as(admin, async (tx) => {
      await tx`UPDATE resources SET is_archived = false WHERE id = ${id}`;
    });

    const [row] = await asSystem(
      (tx) => tx<{ is_archived: boolean }[]>`SELECT is_archived FROM resources WHERE id = ${id}`,
    );
    expect(row?.is_archived).toBe(false);
  });

  it('an archived resource disappears for an intern', async () => {
    const id = await createResource(`Hidden ${tag()}`);

    const before = await as(
      intern,
      (tx) => tx<{ id: string }[]>`SELECT id FROM resources WHERE id = ${id}`,
    );
    expect(before).toHaveLength(1);

    await as(admin, async (tx) => {
      await tx`UPDATE resources SET is_archived = true WHERE id = ${id}`;
    });

    const after = await as(
      intern,
      (tx) => tx<{ id: string }[]>`SELECT id FROM resources WHERE id = ${id}`,
    );
    expect(after).toHaveLength(0);
  });

  it('an intern cannot archive a resource', async () => {
    const id = await createResource(`Intern-proof ${tag()}`);

    await as(intern, async (tx) => {
      await tx`UPDATE resources SET is_archived = true WHERE id = ${id}`;
    });

    const [row] = await asSystem(
      (tx) => tx<{ is_archived: boolean }[]>`SELECT is_archived FROM resources WHERE id = ${id}`,
    );
    expect(row?.is_archived).toBe(false);
  });
});

describe('cancelling a project', () => {
  async function createProject(title: string): Promise<string> {
    return asSystem(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO projects (title, description, status, created_by)
        VALUES (${title}, 'Fixture', 'active', ${admin})
        RETURNING id`;
      return row!.id;
    });
  }

  it('an admin can cancel one', async () => {
    const id = await createProject(`Cancellable ${tag()}`);

    await as(admin, async (tx) => {
      await tx`UPDATE projects SET status = 'cancelled' WHERE id = ${id}`;
    });

    const [row] = await asSystem(
      (tx) => tx<{ status: string }[]>`SELECT status::text FROM projects WHERE id = ${id}`,
    );
    expect(row?.status).toBe('cancelled');
  });

  it('an intern cannot cancel one', async () => {
    const id = await createProject(`Intern-proof ${tag()}`);

    await as(intern, async (tx) => {
      await tx`UPDATE projects SET status = 'cancelled' WHERE id = ${id}`;
    });

    const [row] = await asSystem(
      (tx) => tx<{ status: string }[]>`SELECT status::text FROM projects WHERE id = ${id}`,
    );
    expect(row?.status).toBe('active');
  });
});
