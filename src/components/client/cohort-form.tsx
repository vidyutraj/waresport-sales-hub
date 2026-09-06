'use client';

import { saveCohortAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select } from '@/components/ui';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'UTC',
];

export function CohortForm({
  cohorts,
  current,
}: {
  cohorts: { id: string; name: string }[];
  current: {
    cohortId: string;
    name: string;
    startDate: string;
    weeksCount: number;
    reportingTimezone: string;
    rowVersion: number;
  } | null;
}) {
  const zones =
    current && !TIMEZONES.includes(current.reportingTimezone)
      ? [current.reportingTimezone, ...TIMEZONES]
      : TIMEZONES;

  return (
    <>
      {cohorts.length > 1 ? (
        <form method="get" className="mb-4">
          <label
            htmlFor="cohort-switch"
            className="mb-1 block text-[12px] font-medium text-ink-700"
          >
            Editing
          </label>
          <Select
            id="cohort-switch"
            name="cohortId"
            defaultValue={current?.cohortId ?? ''}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </form>
      ) : null}

      <ActionForm action={saveCohortAction}>
        {(state) => (
          <>
            {current ? (
              <>
                <input type="hidden" name="cohortId" value={current.cohortId} />
                {/* Optimistic-locking token: a stale editor is rejected. */}
                <input type="hidden" name="expectedRowVersion" value={current.rowVersion} />
              </>
            ) : null}

            <Field label="Name" htmlFor="c-name" required error={state.fieldErrors.name}>
              <Input
                id="c-name"
                name="name"
                defaultValue={current?.name ?? ''}
                required
                maxLength={120}
                placeholder="Spring 2026"
              />
            </Field>

            <Field
              label="Start date"
              htmlFor="c-start"
              required
              hint="Week 1 is the seven calendar days beginning on this date."
              error={state.fieldErrors.startDate}
            >
              <Input
                id="c-start"
                name="startDate"
                type="date"
                defaultValue={current?.startDate ?? ''}
                required
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Weeks" htmlFor="c-weeks" required error={state.fieldErrors.weeksCount}>
                <Input
                  id="c-weeks"
                  name="weeksCount"
                  type="number"
                  min={1}
                  max={52}
                  defaultValue={current?.weeksCount ?? 12}
                  required
                />
              </Field>
              <Field
                label="Reporting timezone"
                htmlFor="c-tz"
                required
                hint="All week boundaries and leaderboards use this."
                error={state.fieldErrors.reportingTimezone}
              >
                <Select
                  id="c-tz"
                  name="reportingTimezone"
                  defaultValue={current?.reportingTimezone ?? 'America/New_York'}
                  required
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div>
              <SubmitButton pendingLabel="Saving…">
                {current ? 'Save cohort' : 'Create cohort'}
              </SubmitButton>
            </div>
          </>
        )}
      </ActionForm>
    </>
  );
}
