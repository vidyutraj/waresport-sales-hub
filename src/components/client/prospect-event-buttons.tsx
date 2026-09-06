'use client';

import { useActionState, useState } from 'react';
import { recordProspectEventAction } from '@/app/(intern)/linkedin/actions';
import { SubmitButton } from '@/components/client/form';
import { IDLE } from '@/lib/form';

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Stage buttons for one prospect. Each stage is its own event; the request
 * button disappears once a request has been recorded, because it can only
 * count once per profile.
 */
export function ProspectEventButtons({
  prospectId,
  requestSent,
  connected,
}: {
  prospectId: string;
  requestSent: boolean;
  connected: boolean;
}) {
  const [state, dispatch] = useActionState(recordProspectEventAction, IDLE);

  // A fresh idempotency key once the previous submission settles; see the note
  // in log-outreach-panel.tsx.
  const [submission, setSubmission] = useState(() => ({ state, id: newRequestId() }));
  if (submission.state !== state) setSubmission({ state, id: newRequestId() });
  const requestId = submission.id;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {!requestSent ? (
          <form action={dispatch}>
            <input type="hidden" name="prospectId" value={prospectId} />
            <input type="hidden" name="eventType" value="request_sent" />
            <input type="hidden" name="clientRequestId" value={`${requestId}-req`} />
            <SubmitButton variant="primary" size="sm" pendingLabel="Saving…">
              Request sent
            </SubmitButton>
          </form>
        ) : null}

        {requestSent && !connected ? (
          <form action={dispatch}>
            <input type="hidden" name="prospectId" value={prospectId} />
            <input type="hidden" name="eventType" value="connected" />
            <input type="hidden" name="clientRequestId" value={`${requestId}-con`} />
            <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
              Accepted
            </SubmitButton>
          </form>
        ) : null}

        {connected ? (
          <form action={dispatch}>
            <input type="hidden" name="prospectId" value={prospectId} />
            <input type="hidden" name="eventType" value="message_sent" />
            <input type="hidden" name="clientRequestId" value={`${requestId}-msg`} />
            <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
              Message sent
            </SubmitButton>
          </form>
        ) : null}

        <form action={dispatch}>
          <input type="hidden" name="prospectId" value={prospectId} />
          <input type="hidden" name="eventType" value="replied" />
          <input type="hidden" name="clientRequestId" value={`${requestId}-rep`} />
          <SubmitButton variant="ghost" size="sm" pendingLabel="Saving…">
            Replied
          </SubmitButton>
        </form>
      </div>

      {state.status === 'error' && state.message ? (
        <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      {state.status === 'success' && state.message ? (
        <p role="status" className="max-w-xs text-[12px] text-positive-700">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
