import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadInternContext } from '@/lib/queries/intern-context';
import { allProgramWeeks } from '@/lib/domain/program';
import { formatDateRangeHuman } from '@/lib/domain/time';
import { formatDateOnly } from '@/lib/labels';
import { Card, CardBody, CardHeader, PageHeader, SafeLink } from '@/components/ui';
import { ProfileForm } from '@/components/client/profile-form';

export const metadata = { title: 'Profile' };
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

export default async function ProfilePage() {
  const user = await requireIntern();

  const { context, profile } = await asUser(user.id, async (tx) => ({
    context: await loadInternContext(tx, user.id),
    profile: (
      await tx<
        {
          full_name: string | null;
          preferred_name: string | null;
          timezone: string;
          bio: string | null;
          personal_linkedin_url: string | null;
          contact_phone: string | null;
        }[]
      >`
        SELECT full_name, preferred_name, timezone, bio, personal_linkedin_url, contact_phone
        FROM users WHERE id = ${user.id}`
    )[0],
  }));

  const weeks = context.cohort ? allProgramWeeks(context.cohort) : [];
  const first = weeks[0];
  const last = weeks[weeks.length - 1];

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your details. Role, territory, cohort and outreach address are set by an admin."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Your details" />
          <CardBody>
            <ProfileForm
              timezones={COMMON_TIMEZONES}
              defaults={{
                fullName: profile?.full_name ?? '',
                preferredName: profile?.preferred_name ?? '',
                timezone: profile?.timezone ?? 'America/New_York',
                bio: profile?.bio ?? '',
                personalLinkedinUrl: profile?.personal_linkedin_url ?? '',
                contactPhone: profile?.contact_phone ?? '',
              }}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Assignment" description="Read-only." />
          <CardBody className="grid gap-3 text-[13px]">
            <Row label="Role" value={user.role} />
            <Row label="Sign-in email" value={user.email} />
            <Row
              label="Waresport outreach address"
              value={user.waresportOutreachEmail}
              empty="Not provisioned yet"
            />
            <Row label="Cohort" value={context.cohort?.name} empty="Not assigned" />
            <Row
              label="Territory"
              value={context.membership?.territoryName ?? context.membership?.territoryCode}
              empty="Not assigned"
            />
            <Row
              label="Program dates"
              value={first && last ? formatDateRangeHuman(first.startDate, last.endDate) : null}
              empty="—"
            />
            <Row
              label="Joined cohort"
              value={context.membership ? formatDateOnly(context.membership.joinedOn) : null}
              empty="—"
            />
            <Row label="Reporting timezone" value={context.cohort?.reportingTimezone} empty="—" />
            <div>
              <p className="text-[12px] font-medium text-ink-500">Your LinkedIn profile</p>
              <p className="mt-0.5">
                {profile?.personal_linkedin_url ? (
                  <SafeLink href={profile.personal_linkedin_url}>View profile</SafeLink>
                ) : (
                  <span className="text-ink-400">Not set</span>
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-400">
                This is your own profile, kept separate from the prospects you track.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  empty = '—',
}: {
  label: string;
  value?: string | null;
  empty?: string;
}) {
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-500">{label}</p>
      <p className="mt-0.5 wrap-anywhere text-ink-900">
        {value ? value : <span className="text-ink-400">{empty}</span>}
      </p>
    </div>
  );
}
