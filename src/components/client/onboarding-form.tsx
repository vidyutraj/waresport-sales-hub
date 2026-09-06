'use client';

import { completeOnboardingAction } from '@/app/onboarding/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';

export function OnboardingForm({
  defaultTimezone,
  timezones,
  topics,
}: {
  defaultTimezone: string;
  timezones: string[];
  topics: { key: string; title: string; description: string | null }[];
}) {
  const options = timezones.includes(defaultTimezone) ? timezones : [defaultTimezone, ...timezones];

  return (
    <ActionForm action={completeOnboardingAction}>
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName" required error={state.fieldErrors.fullName}>
              <Input id="fullName" name="fullName" autoComplete="name" required autoFocus />
            </Field>
            <Field
              label="Preferred name"
              htmlFor="preferredName"
              hint="What the team should call you."
              error={state.fieldErrors.preferredName}
            >
              <Input id="preferredName" name="preferredName" autoComplete="nickname" />
            </Field>
          </div>

          <Field
            label="Your timezone"
            htmlFor="timezone"
            required
            hint="Used for how times are shown to you. Weekly goals still run on the cohort's reporting timezone."
            error={state.fieldErrors.timezone}
          >
            <Select id="timezone" name="timezone" defaultValue={defaultTimezone} required>
              {options.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Short bio"
            htmlFor="bio"
            hint="A sentence or two. Optional."
            error={state.fieldErrors.bio}
          >
            <Textarea id="bio" name="bio" rows={3} maxLength={600} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Your own LinkedIn profile"
              htmlFor="personalLinkedinUrl"
              hint="Your personal profile — not a prospect's. Prospect profiles go in the LinkedIn tracker."
              error={state.fieldErrors.personalLinkedinUrl}
            >
              <Input
                id="personalLinkedinUrl"
                name="personalLinkedinUrl"
                inputMode="url"
                placeholder="https://www.linkedin.com/in/your-profile"
              />
            </Field>
            <Field
              label="Contact phone"
              htmlFor="contactPhone"
              error={state.fieldErrors.contactPhone}
            >
              <Input id="contactPhone" name="contactPhone" inputMode="tel" autoComplete="tel" />
            </Field>
          </div>

          <fieldset className="rounded-lg border border-ink-200 p-4">
            <legend className="px-1 text-[13px] font-semibold text-ink-800">
              Training checklist
            </legend>
            <p className="mb-3 text-[12px] text-ink-500">
              Tick what you have already covered. You can update this any time from Training &amp;
              Projects — it is self-reported.
            </p>
            <div className="grid gap-2.5">
              {topics.map((topic) => (
                <Checkbox
                  key={topic.key}
                  id={`training-${topic.key}`}
                  name="training"
                  value={topic.key}
                  label={topic.title}
                  hint={topic.description ?? undefined}
                />
              ))}
            </div>
          </fieldset>

          <div className="rounded-lg border border-ink-200 bg-ink-50 p-4">
            <Checkbox
              id="acknowledge"
              name="acknowledge"
              label="I have read the program guidance and understand how outreach is logged."
              hint="Only outreach you actually sent counts. Research, drafts and copied addresses do not."
            />
            {state.fieldErrors.acknowledge ? (
              <p role="alert" className="mt-2 text-[12px] font-medium text-brand-600">
                {state.fieldErrors.acknowledge}
              </p>
            ) : null}
          </div>

          <div>
            <SubmitButton pendingLabel="Saving…">Finish setup</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
