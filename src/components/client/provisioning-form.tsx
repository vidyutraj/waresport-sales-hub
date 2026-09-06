'use client';

import { setProvisioningAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input } from '@/components/ui';

export function ProvisioningForm({
  userId,
  current,
}: {
  userId: string;
  current: {
    outreachEmailProvisioned: boolean;
    linkedinPremiumStartedOn: string;
    linkedinPremiumExpiresOn: string;
  };
}) {
  return (
    <ActionForm action={setProvisioningAction}>
      {(state) => (
        <>
          <input type="hidden" name="userId" value={userId} />
          <Checkbox
            id="p-outreach"
            name="outreachEmailProvisioned"
            defaultChecked={current.outreachEmailProvisioned}
            label="Waresport email address set up"
            hint="Tick once you have actually created the mailbox."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="LinkedIn Premium starts"
              htmlFor="p-start"
              error={state.fieldErrors.linkedinPremiumStartedOn}
            >
              <Input
                id="p-start"
                name="linkedinPremiumStartedOn"
                type="date"
                defaultValue={current.linkedinPremiumStartedOn}
              />
            </Field>
            <Field
              label="Expires"
              htmlFor="p-end"
              hint="Two months per the program guide."
              error={state.fieldErrors.linkedinPremiumExpiresOn}
            >
              <Input
                id="p-end"
                name="linkedinPremiumExpiresOn"
                type="date"
                defaultValue={current.linkedinPremiumExpiresOn}
              />
            </Field>
          </div>
          <Field label="Note" htmlFor="p-note" error={state.fieldErrors.note}>
            <Input id="p-note" name="note" maxLength={300} />
          </Field>
          <div>
            <SubmitButton pendingLabel="Saving…">Save checklist</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
