import { requireIntern } from '@/lib/auth/session';
import { AppShell, INTERN_NAV } from '@/components/app-shell';
import { asUser } from '@/lib/db';
import { loadInternContext } from '@/lib/queries/intern-context';

export const dynamic = 'force-dynamic';

export default async function InternLayout({ children }: { children: React.ReactNode }) {
  const user = await requireIntern();
  const context = await asUser(user.id, (tx) => loadInternContext(tx, user.id));

  const label = context.week
    ? `${context.membership?.territoryCode ?? 'No territory'} · Week ${context.week.weekNumber} of ${context.cohort?.weeksCount ?? 12}`
    : (context.membership?.territoryCode ?? 'No cohort assigned');

  return (
    <AppShell user={user} nav={INTERN_NAV} contextLabel={label}>
      {children}
    </AppShell>
  );
}
