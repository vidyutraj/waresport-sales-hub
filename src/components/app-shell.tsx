import Link from 'next/link';
import type { ReactNode } from 'react';
import { WaresportMark } from '@/components/ui';
import { PrimaryNav, type NavItem } from '@/components/client/primary-nav';
import { SignOutButton } from '@/components/client/sign-out-button';
import type { AuthenticatedUser } from '@/lib/auth/service';
import { displayName } from '@/lib/auth/session';

/** Intern navigation, in the order the brief specifies. */
export const INTERN_NAV: NavItem[] = [
  { href: '/overview', label: 'Overview' },
  { href: '/leads', label: 'My Leads' },
  { href: '/linkedin', label: 'LinkedIn' },
  { href: '/follow-ups', label: 'Follow-ups' },
  { href: '/meetings', label: 'Meetings & Earnings' },
  { href: '/training', label: 'Training & Projects' },
  { href: '/profile', label: 'Profile' },
];

/** Admin navigation, in the order the brief specifies. */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/leads', label: 'Leads & Imports' },
  { href: '/admin/interns', label: 'Interns' },
  { href: '/admin/meetings', label: 'Meetings & Payouts' },
  { href: '/admin/targets', label: 'Targets & Program' },
  { href: '/admin/resources', label: 'Resources & Projects' },
  { href: '/admin/settings', label: 'Settings' },
];

export function AppShell({
  user,
  nav,
  children,
  contextLabel,
}: {
  user: AuthenticatedUser;
  nav: NavItem[];
  children: ReactNode;
  contextLabel?: string;
}) {
  return (
    <div className="min-h-dvh">
      <header className="bg-ink-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="shrink-0">
            <WaresportMark subtitle="Sales Hub" />
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            {contextLabel ? (
              <span className="hidden text-[12px] text-ink-300 lg:inline">{contextLabel}</span>
            ) : null}
            <span className="hidden max-w-[14rem] truncate text-[13px] text-ink-200 sm:inline">
              {displayName(user)}
            </span>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium tracking-wide text-ink-100 uppercase">
              {user.role}
            </span>
            <SignOutButton className="rounded-lg px-2 py-1 text-[13px] text-ink-200 hover:bg-white/10 hover:text-white" />
          </div>
        </div>
        <PrimaryNav items={nav} />
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}
