'use client';

import { setTerritoryStatesAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Select, Textarea } from '@/components/ui';

export function TerritoryStatesForm({
  territories,
}: {
  territories: { id: string; label: string }[];
}) {
  return (
    <ActionForm action={setTerritoryStatesAction}>
      {(state) => (
        <>
          <Field label="Territory" htmlFor="ts-territory" required>
            <Select
              id="ts-territory"
              name="territoryId"
              required
              defaultValue={territories[0]?.id ?? ''}
            >
              {territories.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="State codes"
            htmlFor="ts-states"
            required
            hint="Two-letter codes or full state names, separated by spaces, commas or new lines. A state already mapped elsewhere is moved here."
            error={state.fieldErrors.stateCodes}
          >
            <Textarea
              id="ts-states"
              name="stateCodes"
              rows={4}
              required
              placeholder="NC, SC, VA, GA"
            />
          </Field>

          <div>
            <SubmitButton pendingLabel="Saving…">Map states</SubmitButton>
          </div>
          <p className="text-[12px] text-ink-500">
            Changing the map affects future imports and newly created clubs. Existing clubs keep
            their current territory until edited.
          </p>
        </>
      )}
    </ActionForm>
  );
}
