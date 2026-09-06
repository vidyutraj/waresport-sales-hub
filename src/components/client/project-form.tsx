'use client';

import { saveProjectAction } from '@/app/admin/resources/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';

export function ProjectForm({
  cohorts,
  interns,
}: {
  cohorts: { id: string; name: string }[];
  interns: { id: string; name: string }[];
}) {
  return (
    <ActionForm action={saveProjectAction}>
      {(state) => (
        <>
          <Field label="Title" htmlFor="pr-title" required error={state.fieldErrors.title}>
            <Input
              id="pr-title"
              name="title"
              required
              maxLength={200}
              placeholder="Research volleyball clubs in the Southeast"
            />
          </Field>

          <Field label="Description" htmlFor="pr-desc" error={state.fieldErrors.description}>
            <Textarea id="pr-desc" name="description" rows={3} maxLength={4000} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Due date" htmlFor="pr-due" error={state.fieldErrors.dueOn}>
              <Input id="pr-due" name="dueOn" type="date" />
            </Field>
            <Field label="Cohort" htmlFor="pr-cohort">
              <Select id="pr-cohort" name="cohortId" defaultValue={cohorts[0]?.id ?? ''}>
                <option value="">Any</option>
                {cohorts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink-800">Assign to</legend>
            {interns.length === 0 ? (
              <p className="text-[12px] text-ink-500">No active interns yet.</p>
            ) : (
              <div className="grid gap-2">
                {interns.map((i) => (
                  <Checkbox
                    key={i.id}
                    id={`pr-assignee-${i.id}`}
                    name="assignees"
                    value={i.id}
                    label={i.name}
                  />
                ))}
              </div>
            )}
          </fieldset>

          <div>
            <SubmitButton pendingLabel="Saving…">Create project</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
