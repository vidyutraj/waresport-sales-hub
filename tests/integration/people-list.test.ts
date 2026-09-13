import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '@/lib/db';
import { listPeople } from '@/lib/services/admin';
import { as, createUser, tag } from './factories';

/**
 * Who the admin people list shows.
 *
 * An account cannot be hard-deleted once it has audit rows, because the audit
 * log is append-only. To undo one, it is deactivated and moved onto the
 * reserved `.invalid` domain, which frees the real address for re-use. Those
 * placeholders are not people and must not be listed. A genuinely deactivated
 * account keeps its real address and must stay listed, so it can be reactivated.
 */

let admin: string;
let active: string;
let deactivated: string;
let retired: string;

beforeAll(async () => {
  const t = tag();
  admin = await createUser({ email: `admin-${t}@example.test`, role: 'admin' });
  active = await createUser({ email: `active-${t}@example.test`, role: 'intern' });
  deactivated = await createUser({ email: `deactivated-${t}@example.test`, role: 'intern' });
  retired = await createUser({ email: `to-retire-${t}@example.test`, role: 'intern' });

  await asSystem(async (tx) => {
    await tx`UPDATE users SET status = 'deactivated' WHERE id = ${deactivated}`;
    await tx`
      UPDATE users
      SET status = 'deactivated', email = ${`retired+${t}@waresport.invalid`}
      WHERE id = ${retired}`;
  });
});

describe('listPeople', () => {
  it('lists active and genuinely deactivated accounts', async () => {
    const ids = (await as(admin, (tx) => listPeople(tx))).map((p) => p.id);
    expect(ids).toContain(active);
    expect(ids).toContain(deactivated);
  });

  it('hides retired placeholder accounts', async () => {
    const people = await as(admin, (tx) => listPeople(tx));
    expect(people.map((p) => p.id)).not.toContain(retired);
    expect(people.some((p) => p.email.endsWith('.invalid'))).toBe(false);
  });

  it('hides them from the intern-only list used by pickers too', async () => {
    const interns = await as(admin, (tx) => listPeople(tx, { role: 'intern' }));
    expect(interns.map((p) => p.id)).not.toContain(retired);
    expect(interns.map((p) => p.id)).toContain(deactivated);
  });
});
