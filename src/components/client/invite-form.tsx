'use client';

import { inviteAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select } from '@/components/ui';

export function InviteForm({
  canInviteAdmin,
  cohorts,
  territories,
}: {
  canInviteAdmin: boolean;
  cohorts: { id: string; name: string }[];
  territories: { id: string; label: string }[];
}) {
  return (
    <ActionForm action={inviteAction}>
      {(state) => {
        // Restored after a rejected submission; React resets the form itself.
        const kept = state.values ?? {};
        return (
          <>
            <Field
              label="Email address"
              htmlFor="invite-email"
              required
              error={state.fieldErrors.email}
            >
              <Input
                id="invite-email"
                name="email"
                type="email"
                required
                placeholder="name@waresport.com"
                defaultValue={state.status === 'error' ? (kept.email ?? '') : ''}
              />
            </Field>

            <Field label="Role" htmlFor="invite-role" required error={state.fieldErrors.role}>
              <Select id="invite-role" name="role" defaultValue={kept.role ?? 'intern'}>
                <option value="intern">Intern</option>
                {canInviteAdmin ? <option value="admin">Admin</option> : null}
              </Select>
            </Field>

            <Field
              label="Cohort"
              htmlFor="invite-cohort"
              hint="Sets their program weeks and reporting timezone."
              error={state.fieldErrors.cohortId}
            >
              <Select
                id="invite-cohort"
                name="cohortId"
                defaultValue={kept.cohortId ?? cohorts[0]?.id ?? ''}
              >
                <option value="">No cohort yet</option>
                {cohorts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Territory"
              htmlFor="invite-territory"
              hint="The intern cannot change this themselves."
              error={state.fieldErrors.territoryId}
            >
              <Select
                id="invite-territory"
                name="territoryId"
                defaultValue={kept.territoryId ?? ''}
              >
                <option value="">Unassigned</option>
                {territories.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
            </div>
            <p className="text-[12px] text-ink-500">
              The invitee receives a one-time code by email. No password is ever created, and an
              uninvited address that verifies its email still gets no access.
            </p>
          </>
        );
      }}
    </ActionForm>
  );
}
