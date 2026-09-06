'use client';

import { updateProfileAction } from '@/app/onboarding/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Select, Textarea } from '@/components/ui';

export function ProfileForm({
  timezones,
  defaults,
}: {
  timezones: string[];
  defaults: Record<string, string>;
}) {
  const tz = defaults.timezone ?? 'America/New_York';
  const options = timezones.includes(tz) ? timezones : [tz, ...timezones];

  return (
    <ActionForm action={updateProfileAction}>
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName" required error={state.fieldErrors.fullName}>
              <Input id="fullName" name="fullName" defaultValue={defaults.fullName} required />
            </Field>
            <Field
              label="Preferred name"
              htmlFor="preferredName"
              error={state.fieldErrors.preferredName}
            >
              <Input
                id="preferredName"
                name="preferredName"
                defaultValue={defaults.preferredName}
              />
            </Field>
          </div>

          <Field
            label="Your timezone"
            htmlFor="timezone"
            required
            hint="Controls how times are displayed to you. Weekly goals still use the cohort's reporting timezone."
            error={state.fieldErrors.timezone}
          >
            <Select id="timezone" name="timezone" defaultValue={tz} required>
              {options.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Short bio" htmlFor="bio" error={state.fieldErrors.bio}>
            <Textarea id="bio" name="bio" rows={3} maxLength={600} defaultValue={defaults.bio} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Your own LinkedIn profile"
              htmlFor="personalLinkedinUrl"
              hint="Not a prospect's profile."
              error={state.fieldErrors.personalLinkedinUrl}
            >
              <Input
                id="personalLinkedinUrl"
                name="personalLinkedinUrl"
                inputMode="url"
                defaultValue={defaults.personalLinkedinUrl}
              />
            </Field>
            <Field
              label="Contact phone"
              htmlFor="contactPhone"
              error={state.fieldErrors.contactPhone}
            >
              <Input
                id="contactPhone"
                name="contactPhone"
                inputMode="tel"
                defaultValue={defaults.contactPhone}
              />
            </Field>
          </div>

          <div>
            <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
