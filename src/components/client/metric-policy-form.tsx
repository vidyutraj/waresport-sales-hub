'use client';

import { setMetricPolicyAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input } from '@/components/ui';

export function MetricPolicyForm({
  cohortId,
  current,
}: {
  cohortId: string;
  current: {
    emailCountsFollowups: boolean;
    linkedinCountsFirstRequestOnly: boolean;
    version: number;
  };
}) {
  return (
    <ActionForm action={setMetricPolicyAction}>
      {(state) => (
        <>
          <input type="hidden" name="cohortId" value={cohortId} />
          <p className="text-[12px] text-ink-500">Currently on version {current.version}.</p>

          <Checkbox
            id="p-followups"
            name="emailCountsFollowups"
            defaultChecked={current.emailCountsFollowups}
            label="Follow-up emails count toward the weekly email target"
            hint="The program guide does not settle this. Default: they do count."
          />
          <Checkbox
            id="p-firstonly"
            name="linkedinCountsFirstRequestOnly"
            defaultChecked={current.linkedinCountsFirstRequestOnly}
            label="Only first-time connection requests count toward the request target"
            hint="Default: on. Messages and accepted connections are tracked separately."
          />

          <Field label="Note" htmlFor="p-notes" error={state.fieldErrors.notes}>
            <Input
              id="p-notes"
              name="notes"
              maxLength={400}
              placeholder="Why you are changing it"
            />
          </Field>

          <div>
            <SubmitButton pendingLabel="Saving…">Create new policy version</SubmitButton>
          </div>
          <p className="text-[12px] text-ink-500">
            Creates a new version effective from now. Weeks already worked keep the rules they were
            measured under.
          </p>
        </>
      )}
    </ActionForm>
  );
}
