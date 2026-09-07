'use client';

import { useState } from 'react';
import { addPersonAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select } from '@/components/ui';

export function AddPersonForm({
  canAddAdmin,
  cohorts,
  territories,
}: {
  canAddAdmin: boolean;
  cohorts: { id: string; name: string }[];
  territories: { id: string; label: string }[];
}) {
  const [role, setRole] = useState('intern');

  return (
    <ActionForm action={addPersonAction}>
      {(state) => {
        // Restored after a rejected submission; React resets the form itself.
        const kept = state.values ?? {};
        return (
          <>
            <Field label="Name" htmlFor="person-name" error={state.fieldErrors.fullName}>
              <Input
                id="person-name"
                name="fullName"
                placeholder="Jordan Lee"
                defaultValue={state.status === 'error' ? (kept.fullName ?? '') : ''}
              />
            </Field>

            <Field
              label="Email address"
              htmlFor="person-email"
              required
              hint="Identifies the account. No email is ever sent to it."
              error={state.fieldErrors.email}
            >
              <Input
                id="person-email"
                name="email"
                type="email"
                required
                placeholder="name@waresport.com"
                defaultValue={state.status === 'error' ? (kept.email ?? '') : ''}
              />
            </Field>

            <Field label="Role" htmlFor="person-role" required error={state.fieldErrors.role}>
              <Select
                id="person-role"
                name="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="intern">Intern</option>
                {canAddAdmin ? <option value="admin">Admin</option> : null}
              </Select>
            </Field>

            {role === 'admin' ? (
              <Field
                label="Admin password"
                htmlFor="person-password"
                required
                hint="At least 10 characters. Admins must enter this to sign in; interns never see a password."
                error={state.fieldErrors.password}
              >
                <Input
                  id="person-password"
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                />
              </Field>
            ) : null}

            <Field
              label="Cohort"
              htmlFor="person-cohort"
              hint="Sets their program weeks and reporting timezone."
              error={state.fieldErrors.cohortId}
            >
              <Select
                id="person-cohort"
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
              htmlFor="person-territory"
              hint="The intern cannot change this themselves."
              error={state.fieldErrors.territoryId}
            >
              <Select
                id="person-territory"
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
              <SubmitButton pendingLabel="Creating…">Create profile</SubmitButton>
            </div>
            <p className="text-[12px] text-ink-500">
              The profile appears on the sign-in screen straight away. Interns sign in by picking
              their own name; an admin must also enter their password.
            </p>
          </>
        );
      }}
    </ActionForm>
  );
}
