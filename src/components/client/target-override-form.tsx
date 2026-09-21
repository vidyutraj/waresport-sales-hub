'use client';

import { setTargetAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select } from '@/components/ui';

/**
 * Per-intern (or cohort-default) weekly email target editor. LinkedIn has no
 * target, so there is nothing to set for it here.
 *
 * Changing a target never rewrites an elapsed week: those are frozen in
 * `weekly_target_snapshots` the first time they are read after the week ends.
 */
export function TargetOverrideForm({
  cohortId,
  userId,
  weeksCount,
}: {
  cohortId: string;
  userId?: string;
  weeksCount: number;
}) {
  return (
    <ActionForm action={setTargetAction}>
      {(state) => (
        <>
          <input type="hidden" name="cohortId" value={cohortId} />
          {userId ? <input type="hidden" name="userId" value={userId} /> : null}

          <Field label="Week" htmlFor={`t-week-${userId ?? 'default'}`} required>
            <Select id={`t-week-${userId ?? 'default'}`} name="weekNumber" defaultValue="1">
              {Array.from({ length: weeksCount }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>
                  Week {w}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Emails / week"
              htmlFor={`t-email-${userId ?? 'default'}`}
              required
              error={state.fieldErrors.emailTarget}
            >
              <Input
                id={`t-email-${userId ?? 'default'}`}
                name="emailTarget"
                type="number"
                min={0}
                defaultValue={150}
                required
              />
            </Field>
            <Field label="Emails / day (advisory)" htmlFor={`t-epd-${userId ?? 'default'}`}>
              <Input
                id={`t-epd-${userId ?? 'default'}`}
                name="emailDailyPace"
                type="number"
                min={0}
                defaultValue={30}
              />
            </Field>
          </div>

          <Field label="Reason" htmlFor={`t-reason-${userId ?? 'default'}`}>
            <Input
              id={`t-reason-${userId ?? 'default'}`}
              name="reason"
              maxLength={300}
              placeholder="Recorded in the audit log"
            />
          </Field>

          <div>
            <SubmitButton pendingLabel="Saving…">Save target</SubmitButton>
          </div>
          <p className="text-[12px] text-ink-500">
            Setting a target to 0 is allowed and is handled without dividing by zero.
          </p>
        </>
      )}
    </ActionForm>
  );
}
