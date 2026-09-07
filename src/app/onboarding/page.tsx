import { redirect } from 'next/navigation';
import { asUser } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { getActiveMembership } from '@/lib/queries/program';
import { allProgramWeeks } from '@/lib/domain/program';
import { formatDateRangeHuman } from '@/lib/domain/time';
import { OnboardingForm } from '@/components/client/onboarding-form';
import { SignOutButton } from '@/components/client/sign-out-button';
import { Card, CardBody, CardHeader, WaresportMark } from '@/components/ui';

export const metadata = { title: 'Set up your account' };

export const dynamic = 'force-dynamic';

const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Asia/Kolkata',
  'UTC',
];

export default async function OnboardingPage() {
  const user = await requireUser();
  if (user.onboardingCompletedAt !== null) {
    redirect(user.role === 'intern' ? '/overview' : '/admin');
  }

  const { membership, topics } = await asUser(user.id, async (tx) => ({
    membership: await getActiveMembership(tx, user.id),
    topics: await tx<{ key: string; title: string; description: string | null }[]>`
      SELECT key, title, description FROM training_topics WHERE is_active ORDER BY sort_order`,
  }));

  const weeks = membership ? allProgramWeeks(membership.cohort) : [];
  const first = weeks[0];
  const last = weeks[weeks.length - 1];

  return (
    <div className="min-h-dvh">
      {/*
        Onboarding renders its own header rather than the app shell, so it has to
        carry its own way out: without this, picking the wrong profile on the
        sign-in screen is a dead end. / sends an un-onboarded account here and
        /sign-in sends anyone with a session back to /, so signing out is the
        only way back to the picker.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3 bg-ink-900 px-5 py-3">
        <WaresportMark />
        <div className="flex items-center gap-2 text-[13px] text-ink-200">
          <span className="hidden sm:inline">Signed in as {user.email}</span>
          <span className="text-ink-400">·</span>
          <SignOutButton className="rounded-lg px-2 py-1 text-[13px] text-ink-200 underline hover:bg-white/10 hover:text-white" />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-xl font-semibold text-ink-900 sm:text-2xl">Set up your account</h1>
        <p className="mt-1 mb-6 max-w-2xl text-ink-600">
          A few details so the team knows who is doing what. Your territory, cohort and Waresport
          outreach address are set by an admin and cannot be changed here.
        </p>

        <div className="grid gap-5">
          <Card>
            <CardHeader title="Your assignment" description="Set by an admin. Read-only." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Detail label="Sign-in email" value={user.email} />
              <Detail
                label="Waresport outreach address"
                value={user.waresportOutreachEmail}
                empty="Not provisioned yet — an admin will set this up."
              />
              <Detail label="Cohort" value={membership?.cohort.name} empty="Not assigned yet" />
              <Detail
                label="Territory"
                value={membership?.territoryName ?? membership?.territoryCode}
                empty="Not assigned yet"
              />
              <Detail
                label="Program dates"
                value={
                  first && last
                    ? `${formatDateRangeHuman(first.startDate, last.endDate)} · ${weeks.length} weeks`
                    : null
                }
                empty="Set once you are added to a cohort"
              />
              <Detail
                label="Reporting timezone"
                value={membership?.cohort.reportingTimezone}
                empty="—"
                hint="All weekly goals are measured in this timezone, not yours."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="About you" />
            <CardBody>
              <OnboardingForm
                defaultTimezone={membership?.cohort.reportingTimezone ?? user.timezone}
                timezones={COMMON_TIMEZONES}
                topics={topics}
              />
            </CardBody>
          </Card>
        </div>
      </main>
    </div>
  );
}

function Detail({
  label,
  value,
  empty = '—',
  hint,
}: {
  label: string;
  value?: string | null;
  empty?: string;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink-900">
        {value ? value : <span className="text-ink-400">{empty}</span>}
      </dd>
      {hint ? <p className="mt-0.5 text-[12px] text-ink-500">{hint}</p> : null}
    </div>
  );
}
