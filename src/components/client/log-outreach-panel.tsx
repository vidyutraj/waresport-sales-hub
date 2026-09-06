'use client';

import { useActionState, useState } from 'react';
import { logOutreachAction } from '@/app/(intern)/leads/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import { Field, Input, Select, Textarea } from '@/components/ui';
import { IDLE } from '@/lib/form';
import {
  LOGGABLE_ACTIONS,
  OUTCOMES_FOR_ACTION,
  OUTCOME_LABELS,
  SUPPRESSING_OUTCOME_NOTE,
} from '@/lib/labels';

/**
 * The intern's primary action.
 *
 * Kept deliberately short: pick what you sent, to whom, and when. The
 * timestamp is prefilled to now, the outcome list narrows to what is possible
 * for the chosen action, and a fresh idempotency key is minted per mount so a
 * double-click or a retried submit cannot create two entries.
 */

function localNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function LogOutreachPanel({
  organizationId,
  contacts,
  timezone,
  inProgram,
}: {
  organizationId: string;
  contacts: { id: string; label: string; suppressedChannels: string[] }[];
  timezone: string;
  inProgram: boolean;
}) {
  const [state, dispatch] = useActionState(logOutreachAction, IDLE);
  const [actionType, setActionType] = useState<string>('email_initial');
  const [outcome, setOutcome] = useState<string>('sent');
  const [contactId, setContactId] = useState<string>(contacts[0]?.id ?? '');

  // A fresh idempotency key once the previous submission settles: a retry of
  // the in-flight submission reuses the key and is deduplicated server-side,
  // while the next deliberate log gets a new one. Held in state (not useMemo,
  // which is only a caching hint, and not an effect, which renders twice).
  const [submission, setSubmission] = useState(() => ({ state, id: newRequestId() }));
  if (submission.state !== state) setSubmission({ state, id: newRequestId() });
  const requestId = submission.id;

  const outcomes = OUTCOMES_FOR_ACTION[actionType] ?? ['sent'];
  const actionHelp = LOGGABLE_ACTIONS.find((a) => a.value === actionType)?.help;
  const selectedContact = contacts.find((c) => c.id === contactId);
  const suppressed = (selectedContact?.suppressedChannels ?? []).length > 0;

  return (
    <form action={dispatch} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="clientRequestId" value={requestId} />

      <FormFeedback state={state} />

      {!inProgram ? (
        <p className="rounded-lg border border-caution-100 bg-caution-50 px-3 py-2 text-[12px] text-caution-700">
          Today is outside your cohort window. You can still log work dated inside the program, but
          it will not count toward a weekly target.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="What did you do?"
          htmlFor="actionType"
          required
          error={state.fieldErrors.actionType}
        >
          <Select
            id="actionType"
            name="actionType"
            value={actionType}
            onChange={(e) => {
              setActionType(e.target.value);
              setOutcome((OUTCOMES_FOR_ACTION[e.target.value] ?? ['sent'])[0] ?? 'sent');
            }}
          >
            {LOGGABLE_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Contact" htmlFor="contactId" error={state.fieldErrors.contactId}>
          <Select
            id="contactId"
            name="contactId"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">Club-level (no specific contact)</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.suppressedChannels.length > 0 ? ' — suppressed' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {actionHelp ? <p className="-mt-1 text-[12px] text-ink-500">{actionHelp}</p> : null}

      {suppressed ? (
        <p
          role="alert"
          className="rounded-lg border border-caution-100 bg-caution-50 px-3 py-2 text-[12px] text-caution-700"
        >
          Outreach to this contact is suppressed ({selectedContact?.suppressedChannels.join(', ')}).
          The server will reject a new send until an admin lifts it.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Outcome" htmlFor="outcome" required error={state.fieldErrors.outcome}>
          <Select
            id="outcome"
            name="outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            {outcomes.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o] ?? o}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="When"
          htmlFor="occurredAtLocal"
          required
          hint={`Your timezone: ${timezone.replace(/_/g, ' ')}. A future time is rejected.`}
          error={state.fieldErrors.occurredAtLocal}
        >
          <Input
            id="occurredAtLocal"
            name="occurredAtLocal"
            type="datetime-local"
            defaultValue={localNow()}
            required
          />
        </Field>
      </div>

      {SUPPRESSING_OUTCOME_NOTE[outcome] ? (
        <p className="rounded-lg border border-caution-100 bg-caution-50 px-3 py-2 text-[12px] text-caution-700">
          {SUPPRESSING_OUTCOME_NOTE[outcome]}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Next follow-up"
          htmlFor="followUpOn"
          hint="Adds a task to your follow-up queue."
          error={state.fieldErrors.followUpOn}
        >
          <Input id="followUpOn" name="followUpOn" type="date" />
        </Field>
        <Field
          label="Reference link"
          htmlFor="evidenceUrl"
          hint="Optional. A thread or calendar link, for your own reference."
          error={state.fieldErrors.evidenceUrl}
        >
          <Input id="evidenceUrl" name="evidenceUrl" inputMode="url" placeholder="https://…" />
        </Field>
      </div>

      <Field label="Notes" htmlFor="notes" error={state.fieldErrors.notes}>
        <Textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          placeholder="What you said, or what they replied."
        />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Logging…">Log it</SubmitButton>
        <p className="text-[12px] text-ink-500">Only record what you have actually sent.</p>
      </div>
    </form>
  );
}
