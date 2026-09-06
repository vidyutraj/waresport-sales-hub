'use client';

import { useActionState, useState } from 'react';
import { addProspectAction } from '@/app/(intern)/linkedin/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import { Field, Input, Select, Textarea } from '@/components/ui';
import { IDLE } from '@/lib/form';

export function AddProspectForm({
  organizations,
}: {
  organizations: { id: string; label: string }[];
}) {
  const [state, dispatch] = useActionState(addProspectAction, IDLE);
  const [mode, setMode] = useState<'existing_org' | 'new_org'>(
    organizations.length > 0 ? 'existing_org' : 'new_org',
  );

  // React resets an uncontrolled form once the action settles, so a rejected
  // submission would otherwise wipe everything typed. The server echoes the
  // submitted values back and they are restored here.
  const kept = state.values ?? {};
  // Re-mounting the fields on each new state makes the restored defaults take
  // effect after React's automatic form reset.
  const formKey = `${state.status}-${Object.keys(kept).length}-${kept.profileUrl ?? ''}`;

  return (
    <form action={dispatch} key={formKey} className="flex flex-col gap-4">
      <FormFeedback state={state} />

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-800">Organization</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="mode"
              value="existing_org"
              checked={mode === 'existing_org'}
              onChange={() => setMode('existing_org')}
              disabled={organizations.length === 0}
              className="accent-brand-500"
            />
            One of my assigned clubs
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="mode"
              value="new_org"
              checked={mode === 'new_org'}
              onChange={() => setMode('new_org')}
              className="accent-brand-500"
            />
            A new organization I researched
          </label>
        </div>
      </fieldset>

      {mode === 'existing_org' ? (
        <Field
          label="Club"
          htmlFor="organizationId"
          required
          error={state.fieldErrors.organizationId}
        >
          <Select
            id="organizationId"
            name="organizationId"
            defaultValue={kept.organizationId ?? ''}
          >
            <option value="">Choose a club…</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Organization name"
            htmlFor="newOrgName"
            required
            error={state.fieldErrors.newOrgName}
            className="sm:col-span-1"
          >
            <Input
              id="newOrgName"
              name="newOrgName"
              maxLength={300}
              defaultValue={kept.newOrgName ?? ''}
            />
          </Field>
          <Field label="City" htmlFor="newOrgCity" error={state.fieldErrors.newOrgCity}>
            <Input
              id="newOrgCity"
              name="newOrgCity"
              maxLength={120}
              defaultValue={kept.newOrgCity ?? ''}
            />
          </Field>
          <Field
            label="State"
            htmlFor="newOrgState"
            hint="Two-letter code. Sets the territory."
            error={state.fieldErrors.newOrgState}
          >
            <Input
              id="newOrgState"
              name="newOrgState"
              maxLength={20}
              placeholder="NC"
              defaultValue={kept.newOrgState ?? ''}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="fullName" required error={state.fieldErrors.fullName}>
          <Input
            id="fullName"
            name="fullName"
            maxLength={160}
            required
            defaultValue={kept.fullName ?? ''}
          />
        </Field>
        <Field label="Title" htmlFor="title" error={state.fieldErrors.title}>
          <Input
            id="title"
            name="title"
            maxLength={160}
            placeholder="President, Registrar…"
            defaultValue={kept.title ?? ''}
          />
        </Field>
      </div>

      <Field
        label="LinkedIn profile URL"
        htmlFor="profileUrl"
        required
        hint="Their personal profile (linkedin.com/in/…). Tracking parameters are stripped; the link is never fetched."
        error={state.fieldErrors.profileUrl}
      >
        <Input
          id="profileUrl"
          name="profileUrl"
          inputMode="url"
          required
          placeholder="https://www.linkedin.com/in/example"
          defaultValue={kept.profileUrl ?? ''}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sport" htmlFor="sport" error={state.fieldErrors.sport}>
          <Input
            id="sport"
            name="sport"
            maxLength={80}
            placeholder="Basketball, Soccer…"
            defaultValue={kept.sport ?? ''}
          />
        </Field>
        <Field label="Email" htmlFor="prospect-email" error={state.fieldErrors.email}>
          <Input
            id="prospect-email"
            name="email"
            type="email"
            maxLength={254}
            defaultValue={kept.email ?? ''}
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor="prospect-notes" error={state.fieldErrors.notes}>
        <Textarea
          id="prospect-notes"
          name="notes"
          rows={2}
          maxLength={1000}
          defaultValue={kept.notes ?? ''}
        />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Adding…">Add prospect</SubmitButton>
        <p className="text-[12px] text-ink-500">
          Adding a prospect is research. Record the request separately once you send it.
        </p>
      </div>
    </form>
  );
}
