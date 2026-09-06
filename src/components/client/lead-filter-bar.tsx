'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Button, Input, Select } from '@/components/ui';

/**
 * Lead list filters.
 *
 * State lives entirely in the URL, so a filtered view is bookmarkable, back
 * and forward work, and a page reload keeps the same result set. Submitting
 * always resets to page 1.
 */
export function LeadFilterBar({
  basePath,
  states,
  statuses,
  sports = [],
  sources = [],
  assignees = [],
  defaults,
  showAssignment = false,
}: {
  basePath: string;
  states: string[];
  statuses: { value: string; label: string }[];
  sports?: string[];
  sources?: string[];
  assignees?: { id: string; name: string }[];
  defaults: Record<string, string>;
  showAssignment?: boolean;
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

  const hasFilters = [...params.keys()].some((k) => k !== 'page');

  return (
    <form action={submit} className="flex flex-wrap items-end gap-3 px-4 py-3" role="search">
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="filter-q" className="mb-1 block text-[12px] font-medium text-ink-700">
          Search
        </label>
        <Input
          id="filter-q"
          name="q"
          type="search"
          placeholder="Club, contact or email"
          defaultValue={defaults.q ?? ''}
        />
      </div>

      <FilterSelect id="filter-state" name="state" label="State" defaultValue={defaults.state}>
        <option value="">All states</option>
        {states.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </FilterSelect>

      <FilterSelect id="filter-status" name="status" label="Status" defaultValue={defaults.status}>
        <option value="">Any status</option>
        {statuses.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </FilterSelect>

      {sports.length > 0 ? (
        <FilterSelect id="filter-sport" name="sport" label="Sport" defaultValue={defaults.sport}>
          <option value="">Any sport</option>
          {sports.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FilterSelect>
      ) : null}

      {sources.length > 0 ? (
        <FilterSelect
          id="filter-source"
          name="source"
          label="Source"
          defaultValue={defaults.source}
        >
          <option value="">Any source</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FilterSelect>
      ) : null}

      <FilterSelect
        id="filter-contactability"
        name="contactability"
        label="Contactable by"
        defaultValue={defaults.contactability}
      >
        <option value="">Any</option>
        <option value="email">Valid email</option>
        <option value="phone">Valid phone</option>
        <option value="either">Email or phone</option>
        <option value="none">Neither — research needed</option>
      </FilterSelect>

      {assignees.length > 0 ? (
        <FilterSelect
          id="filter-assignee"
          name="assigneeId"
          label="Assigned to"
          defaultValue={defaults.assigneeId}
        >
          <option value="">Anyone</option>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </FilterSelect>
      ) : null}

      {showAssignment ? (
        <FilterSelect
          id="filter-assignment"
          name="assignment"
          label="Assignment"
          defaultValue={defaults.assignment}
        >
          <option value="">All</option>
          <option value="assigned">Assigned</option>
          <option value="unassigned">Unassigned</option>
        </FilterSelect>
      ) : null}

      <FilterSelect id="filter-sort" name="sort" label="Sort" defaultValue={defaults.sort}>
        <option value="name">Club name</option>
        <option value="recent">Most recent activity</option>
        <option value="follow_up">Soonest follow-up</option>
      </FilterSelect>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Filtering…' : 'Apply'}
        </Button>
        {hasFilters ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => startTransition(() => router.push(basePath))}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function FilterSelect({
  id,
  name,
  label,
  defaultValue,
  children,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-ink-700">
        {label}
      </label>
      <Select id={id} name={name} defaultValue={defaultValue ?? ''} className="min-w-[9rem]">
        {children}
      </Select>
    </div>
  );
}
