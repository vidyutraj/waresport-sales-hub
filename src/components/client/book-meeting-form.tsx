'use client';

import { useActionState, useState } from 'react';
import { bookMeetingAction } from '@/app/(intern)/meetings/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import { Field, Input, Select, Textarea, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

function localSoon(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

export function BookMeetingForm({
  organizationId,
  contacts,
  timezone,
}: {
  organizationId: string;
  contacts: { id: string; label: string }[];
  timezone: string;
}) {
  const [state, dispatch] = useActionState(bookMeetingAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass('secondary', 'sm')}
      >
        Book a meeting
      </button>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="scheduledTimezone" value={timezone} />
      <FormFeedback state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact" htmlFor="meeting-contact">
          <Select id="meeting-contact" name="contactId" defaultValue={contacts[0]?.id ?? ''}>
            <option value="">No specific contact</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Scheduled start"
          htmlFor="meeting-start"
          required
          hint={`In ${timezone.replace(/_/g, ' ')}`}
          error={state.fieldErrors.scheduledStartLocal}
        >
          <Input
            id="meeting-start"
            name="scheduledStartLocal"
            type="datetime-local"
            defaultValue={localSoon()}
            required
          />
        </Field>
      </div>

      <Field
        label="Calendar or reference link"
        htmlFor="meeting-ref"
        error={state.fieldErrors.referenceUrl}
      >
        <Input id="meeting-ref" name="referenceUrl" inputMode="url" placeholder="https://…" />
      </Field>

      <Field label="Notes" htmlFor="meeting-notes">
        <Textarea id="meeting-notes" name="notes" rows={2} maxLength={1000} />
      </Field>

      <div className="flex gap-2">
        <SubmitButton pendingLabel="Booking…">Book meeting</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'md')}>
          Cancel
        </button>
      </div>
      <p className="text-[12px] text-ink-500">
        An admin approves the booking first. It is worth nothing until the meeting has taken place
        and an admin has verified it.
      </p>
    </form>
  );
}
