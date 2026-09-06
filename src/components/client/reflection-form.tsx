'use client';

import { saveReflectionAction } from '@/app/(intern)/training/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Textarea } from '@/components/ui';

const QUESTIONS = [
  { name: 'whatWorked', label: 'What worked for you?' },
  { name: 'whatDidNotWork', label: "What didn't work?" },
  { name: 'successfulSports', label: 'Which sports had the most success?' },
  { name: 'recommendations', label: 'What should Waresport do differently going forward?' },
] as const;

export function ReflectionForm({ defaults }: { defaults: Record<string, string> }) {
  return (
    <ActionForm action={saveReflectionAction}>
      {(state) => (
        <>
          {QUESTIONS.map((q) => (
            <Field key={q.name} label={q.label} htmlFor={q.name} error={state.fieldErrors[q.name]}>
              <Textarea
                id={q.name}
                name={q.name}
                rows={3}
                maxLength={4000}
                defaultValue={defaults[q.name] ?? ''}
              />
            </Field>
          ))}
          <Checkbox
            id="reflection-submit"
            name="submit"
            label="Submit this reflection to the team"
            hint="You can keep editing after submitting."
          />
          <div>
            <SubmitButton pendingLabel="Saving…">Save reflection</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
