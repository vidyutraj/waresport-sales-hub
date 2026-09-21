'use client';

import { useState } from 'react';
import { logBookedMeetingAction } from '@/app/(intern)/meetings/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import {
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
  buttonClass,
} from '@/components/ui';

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'phone', label: 'Phone' },
  { value: 'referral', label: 'Referral' },
  { value: 'other', label: 'Other' },
] as const;

/**
 * Log a meeting the moment it is booked: who, when, the Meet link, how they
 * were reached and what is known about them. It goes to an admin for approval.
 */
export function LogMeetingForm({ timezone }: { timezone: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary', 'md')}>
        Log a booked meeting
      </button>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Log a booked meeting"
        description="An admin approves it before it is scheduled. It still earns nothing until it has taken place and been verified."
      />
      <CardBody>
        <ActionForm action={logBookedMeetingAction}>
          {(state) => {
            // Restored after a rejected submission; React resets the form itself.
            const kept = state.status === 'error' ? (state.values ?? {}) : {};
            return (
              <>
                <input type="hidden" name="scheduledTimezone" value={timezone} />

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Who is the meeting with?"
                    htmlFor="log-meeting-name"
                    required
                    error={state.fieldErrors.contactName}
                  >
                    <Input
                      id="log-meeting-name"
                      name="contactName"
                      required
                      autoComplete="off"
                      placeholder="Jordan Lee"
                      defaultValue={kept.contactName ?? ''}
                    />
                  </Field>

                  <Field
                    label="When"
                    htmlFor="log-meeting-start"
                    required
                    hint={`In ${timezone.replace(/_/g, ' ')}`}
                    error={state.fieldErrors.scheduledStartLocal}
                  >
                    <Input
                      id="log-meeting-start"
                      name="scheduledStartLocal"
                      type="datetime-local"
                      required
                      defaultValue={kept.scheduledStartLocal ?? ''}
                    />
                  </Field>

                  <Field
                    label="Google Meet link"
                    htmlFor="log-meeting-link"
                    required
                    error={state.fieldErrors.meetingLink}
                  >
                    <Input
                      id="log-meeting-link"
                      name="meetingLink"
                      required
                      inputMode="url"
                      placeholder="https://meet.google.com/abc-defg-hij"
                      defaultValue={kept.meetingLink ?? ''}
                    />
                  </Field>

                  <Field
                    label="How did you reach them?"
                    htmlFor="log-meeting-channel"
                    required
                    error={state.fieldErrors.outreachChannel}
                  >
                    <Select
                      id="log-meeting-channel"
                      name="outreachChannel"
                      required
                      defaultValue={kept.outreachChannel ?? ''}
                    >
                      <option value="" disabled>
                        Choose one
                      </option>
                      {CHANNELS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <Field
                  label="What do you know about them?"
                  htmlFor="log-meeting-background"
                  hint="Optional. Their role, organization, what they are interested in, anything the admin should know."
                  error={state.fieldErrors.background}
                >
                  <Textarea
                    id="log-meeting-background"
                    name="background"
                    rows={3}
                    maxLength={2000}
                    defaultValue={kept.background ?? ''}
                  />
                </Field>

                <div className="flex gap-2">
                  <SubmitButton pendingLabel="Sending…">Send for approval</SubmitButton>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className={buttonClass('ghost', 'md')}
                  >
                    Close
                  </button>
                </div>
              </>
            );
          }}
        </ActionForm>
      </CardBody>
    </Card>
  );
}
