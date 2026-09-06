'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Button, Input, Select } from '@/components/ui';

/**
 * Admin dashboard filters. Persisted in the URL, so a filtered view is
 * shareable and survives a reload.
 */
export function DashboardFilterBar({
  basePath,
  cohorts,
  territories,
  interns = [],
  defaults,
}: {
  basePath: string;
  cohorts: { id: string; name: string }[];
  territories: string[];
  interns?: { id: string; name: string }[];
  defaults: Record<string, string>;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    const next = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      const v = String(value).trim();
      if (v !== '') next.set(key, v);
    }
    startTransition(() => {
      router.push(next.toString() === '' ? basePath : `${basePath}?${next.toString()}`);
    });
  }

  return (
    <form action={submit} className="flex flex-wrap items-end gap-3 px-4 py-3">
      <div>
        <label htmlFor="f-cohort" className="mb-1 block text-[12px] font-medium text-ink-700">
          Cohort
        </label>
        <Select id="f-cohort" name="cohortId" defaultValue={defaults.cohortId ?? ''}>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      {territories.length > 0 ? (
        <div>
          <label htmlFor="f-territory" className="mb-1 block text-[12px] font-medium text-ink-700">
            Territory
          </label>
          <Select id="f-territory" name="territory" defaultValue={defaults.territory ?? ''}>
            <option value="">All</option>
            {territories.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {interns.length > 0 ? (
        <div>
          <label htmlFor="f-intern" className="mb-1 block text-[12px] font-medium text-ink-700">
            Intern
          </label>
          <Select id="f-intern" name="internId" defaultValue={defaults.internId ?? ''}>
            <option value="">All</option>
            {interns.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div>
        <label htmlFor="f-from" className="mb-1 block text-[12px] font-medium text-ink-700">
          From
        </label>
        <Input id="f-from" name="from" type="date" defaultValue={defaults.from ?? ''} />
      </div>
      <div>
        <label htmlFor="f-to" className="mb-1 block text-[12px] font-medium text-ink-700">
          To
        </label>
        <Input id="f-to" name="to" type="date" defaultValue={defaults.to ?? ''} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Applying…' : 'Apply'}
        </Button>
        {[...params.keys()].length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => startTransition(() => router.push(basePath))}
          >
            Reset
          </Button>
        ) : null}
      </div>
      <p className="w-full text-[12px] text-ink-500">
        Date range filters period metrics only. Meetings and compensation are always cumulative for
        the whole cohort.
      </p>
    </form>
  );
}
