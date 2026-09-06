'use client';

import { useActionState } from 'react';
import { toggleTrainingAction } from '@/app/(intern)/training/actions';
import { SubmitButton } from '@/components/client/form';
import { IDLE } from '@/lib/form';

export function TrainingChecklist({
  topics,
}: {
  topics: { key: string; title: string; done: boolean }[];
}) {
  const [state, dispatch] = useActionState(toggleTrainingAction, IDLE);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {topics.map((t) => (
          <li key={t.key} className="flex items-start justify-between gap-3">
            <span
              className={
                t.done ? 'text-[13px] text-ink-500 line-through' : 'text-[13px] text-ink-800'
              }
            >
              {t.title}
            </span>
            <form action={dispatch} className="shrink-0">
              <input type="hidden" name="topicKey" value={t.key} />
              <input type="hidden" name="complete" value={t.done ? 'false' : 'true'} />
              <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                {t.done ? 'Undo' : 'Mark done'}
              </SubmitButton>
            </form>
          </li>
        ))}
      </ul>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
