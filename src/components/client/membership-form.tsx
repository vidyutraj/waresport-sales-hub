'use client';

import { setMembershipAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select } from '@/components/ui';

export function MembershipForm({
  userId,
  cohorts,
  territories,
  current,
}: {
  userId: string;
  cohorts: { id: string; name: string; startDate: string }[];
  territories: { id: string; label: string }[];
  current: { cohortId: string; territoryId: string; joinedOn: string; outreachEmail: string };
}) {
  return (
    <ActionForm action={setMembershipAction}>
      {(state) => (
        <>
          <input type="hidden" name="userId" value={userId} />

          <Field label="Cohort" htmlFor="m-cohort" required error={state.fieldErrors.cohortId}>
            <Select id="m-cohort" name="cohortId" defaultValue={current.cohortId} required>
              <option value="">Choose a cohort…</option>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (starts {c.startDate})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Territory" htmlFor="m-territory" error={state.fieldErrors.territoryId}>
            <Select id="m-territory" name="territoryId" defaultValue={current.territoryId}>
              <option value="">Unassigned</option>
              {territories.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Joined on"
            htmlFor="m-joined"
            required
            hint="A late joiner still follows the cohort's week numbering."
            error={state.fieldErrors.joinedOn}
          >
            <Input
              id="m-joined"
              name="joinedOn"
              type="date"
              defaultValue={current.joinedOn}
              required
            />
          </Field>

          <Field
            label="Waresport outreach address"
            htmlFor="m-outreach"
            hint="Recorded here; this system does not create the mailbox."
            error={state.fieldErrors.outreachEmail}
          >
            <Input
              id="m-outreach"
              name="outreachEmail"
              type="email"
              defaultValue={current.outreachEmail}
              placeholder="name@waresport.com"
            />
          </Field>

          <div>
            <SubmitButton pendingLabel="Saving…">Save assignment</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
