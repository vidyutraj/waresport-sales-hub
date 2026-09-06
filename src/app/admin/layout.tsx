import { requireAdmin } from '@/lib/auth/session';
import { AppShell, ADMIN_NAV } from '@/components/app-shell';
import { asUser } from '@/lib/db';
import { listCohorts } from '@/lib/queries/program';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin();
  const cohorts = await asUser(user.id, (tx) => listCohorts(tx));
  const active = cohorts.find((c) => c.isActive) ?? cohorts[0];

  return (
    <AppShell
      user={user}
      nav={ADMIN_NAV}
      contextLabel={
        active ? `${active.name} · ${active.reportingTimezone}` : 'No cohort configured'
      }
    >
      {children}
    </AppShell>
  );
}
