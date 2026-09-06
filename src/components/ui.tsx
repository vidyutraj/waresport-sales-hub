import clsx from 'clsx';
import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * Shared presentational primitives.
 *
 * These are plain server components with no client-side state, so they can be
 * used anywhere. Interactive widgets that need state live in
 * src/components/client/.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-xs font-semibold tracking-wide text-ink-500 uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-xl font-semibold text-ink-900 sm:text-2xl">{title}</h1>
        {description ? <div className="mt-1 max-w-2xl text-ink-600">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag
      className={clsx(
        // `min-w-0` matters: a grid or flex item defaults to `min-width: auto`,
        // so a wide table inside would stretch the card and push the whole page
        // sideways instead of scrolling within its own container.
        'min-w-0 rounded-[--radius-card] border border-ink-200 bg-white shadow-[0_1px_2px_rgba(17,25,39,0.04)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-ink-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <h2 id={id} className="font-semibold text-ink-900">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-[13px] text-ink-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('px-4 py-4 sm:px-5', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Buttons and links
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700',
  secondary: 'border border-ink-300 bg-white text-ink-800 hover:bg-ink-50 active:bg-ink-100',
  ghost: 'text-ink-700 hover:bg-ink-100',
  danger: 'border border-brand-200 bg-white text-brand-600 hover:bg-brand-50',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentPropsWithoutRef<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button {...props} className={clsx(buttonClass(variant, size), className)} />;
}

export function LinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link href={href} {...props} className={clsx(buttonClass(variant, size), className)}>
      {children}
    </Link>
  );
}

/**
 * A link that is only rendered as an anchor when the URL is a safe http(s)
 * link. Anything else renders as inert text, so imported data can never
 * produce a live `javascript:` or `data:` link.
 */
export function SafeLink({
  href,
  children,
  className,
  external = true,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
  external?: boolean;
}) {
  if (href === null) {
    return <span className={clsx('text-ink-400', className)}>{children}</span>;
  }
  return (
    <a
      href={href}
      className={clsx(
        'text-brand-600 underline underline-offset-2 hover:text-brand-700',
        className,
      )}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
    >
      {children}
    </a>
  );
}

/** The standard rendering for a missing value. Never a broken action. */
export function NotAvailable({ label = 'Not available' }: { label?: string }) {
  return <span className="text-ink-400">{label}</span>;
}

// ---------------------------------------------------------------------------
// Badges and status
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'caution' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  positive: 'bg-positive-50 text-positive-700 ring-positive-100',
  caution: 'bg-caution-50 text-caution-700 ring-caution-100',
  info: 'bg-info-50 text-info-700 ring-info-100',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const ORG_STATUS_TONES: Record<string, BadgeTone> = {
  new: 'neutral',
  contacted: 'info',
  replied: 'info',
  interested: 'positive',
  meeting_booked: 'positive',
  meeting_held: 'positive',
  not_interested: 'neutral',
  unreachable: 'caution',
  do_not_contact: 'caution',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={ORG_STATUS_TONES[status] ?? 'neutral'}>{label}</Badge>;
}

// ---------------------------------------------------------------------------
// Feedback states
// ---------------------------------------------------------------------------

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'positive' | 'caution' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-info-100 bg-info-50 text-info-700',
    positive: 'border-positive-100 bg-positive-50 text-positive-700',
    caution: 'border-caution-100 bg-caution-50 text-caution-700',
    danger: 'border-brand-200 bg-brand-50 text-brand-700',
  } as const;
  return (
    <div
      role={tone === 'danger' || tone === 'caution' ? 'alert' : 'status'}
      className={clsx('rounded-lg border px-3.5 py-3 text-[13px]', tones[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={clsx(title && 'mt-1')}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <p className="font-semibold text-ink-800">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-ink-500">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

/** Tables scroll inside their own container; the page never scrolls sideways. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-full overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-left text-[13px]">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  scope = 'col',
  numeric = false,
}: {
  children?: ReactNode;
  className?: string;
  scope?: 'col' | 'row';
  numeric?: boolean;
}) {
  return (
    <th
      scope={scope}
      className={clsx(
        'border-b border-ink-200 bg-ink-50 px-3 py-2 font-semibold text-ink-600',
        numeric && 'text-right tabular',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  numeric = false,
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  numeric?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        'border-b border-ink-100 px-3 py-2 align-top text-ink-800',
        numeric && 'text-right tabular',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  definition,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: BadgeTone;
  definition?: string;
}) {
  const accents: Record<BadgeTone, string> = {
    neutral: 'text-ink-900',
    brand: 'text-brand-600',
    positive: 'text-positive-600',
    caution: 'text-caution-600',
    info: 'text-info-600',
  };
  // A stable, label-derived hook so acceptance tests can read a specific tile
  // without depending on surrounding markup.
  const testId = `stat-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
  return (
    <div
      className="rounded-[--radius-card] border border-ink-200 bg-white p-4"
      data-testid={testId}
    >
      <p className="text-[12px] font-medium text-ink-500" title={definition}>
        {label}
        {definition ? <span className="sr-only"> — {definition}</span> : null}
      </p>
      <p
        data-testid={`${testId}-value`}
        className={clsx('mt-1 text-2xl font-semibold tabular', accents[tone])}
      >
        {value}
      </p>
      {sub ? <div className="mt-1 text-[12px] text-ink-500">{sub}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  max,
  label,
  tone = 'brand',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'brand' | 'positive';
}) {
  // A zero target reads as complete rather than dividing by zero.
  const percent = max <= 0 ? (value > 0 ? 100 : 0) : Math.min(100, Math.round((value / max) * 100));
  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={Math.max(max, value)}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-ink-100"
      >
        <div
          className={clsx(
            'h-full rounded-full',
            tone === 'brand' ? 'bg-brand-500' : 'bg-positive-600',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function DefinitionNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[12px] leading-relaxed text-ink-500">{children}</p>;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-800">
        {label}
        {required ? (
          <span className="ml-0.5 text-brand-600" aria-hidden="true">
            *
          </span>
        ) : null}
        {!required ? <span className="ml-1 font-normal text-ink-400">(optional)</span> : null}
      </label>
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-[12px] text-ink-500">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[12px] font-medium text-brand-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  'h-9 w-full rounded-lg border border-ink-300 bg-white px-2.5 text-sm text-ink-900 ' +
  'placeholder:text-ink-400 disabled:bg-ink-50 disabled:text-ink-500';

export function Input({ className, ...props }: ComponentPropsWithoutRef<'input'>) {
  return <input {...props} className={clsx(CONTROL, className)} />;
}

export function Select({ className, children, ...props }: ComponentPropsWithoutRef<'select'>) {
  return (
    <select {...props} className={clsx(CONTROL, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: ComponentPropsWithoutRef<'textarea'>) {
  return (
    <textarea
      {...props}
      className={clsx(
        'w-full rounded-lg border border-ink-300 bg-white px-2.5 py-2 text-sm text-ink-900 placeholder:text-ink-400',
        className,
      )}
    />
  );
}

export function Checkbox({
  label,
  hint,
  className,
  id,
  ...props
}: ComponentPropsWithoutRef<'input'> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <div className={clsx('flex items-start gap-2', className)}>
      <input
        {...props}
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink-300 accent-brand-500"
      />
      <label htmlFor={id} className="text-[13px] text-ink-800">
        {label}
        {hint ? <span className="mt-0.5 block text-[12px] text-ink-500">{hint}</span> : null}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  pageCount,
  total,
  buildHref,
}: {
  page: number;
  pageCount: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-[12px] text-ink-500">
        {total.toLocaleString()} {total === 1 ? 'record' : 'records'}
      </p>
    );
  }
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[12px] text-ink-600"
    >
      <p>
        Page {page} of {pageCount} · {total.toLocaleString()} records
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={buildHref(page - 1)} className={buttonClass('secondary', 'sm')} rel="prev">
            Previous
          </Link>
        ) : (
          <span className={clsx(buttonClass('secondary', 'sm'), 'pointer-events-none opacity-50')}>
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link href={buildHref(page + 1)} className={buttonClass('secondary', 'sm')} rel="next">
            Next
          </Link>
        ) : (
          <span className={clsx(buttonClass('secondary', 'sm'), 'pointer-events-none opacity-50')}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function WaresportMark({ subtitle = 'Sales Hub' }: { subtitle?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[13px] font-bold tracking-[0.16em] text-white">WARESPORT</span>
      <span className="text-[13px] text-ink-400">{subtitle}</span>
    </span>
  );
}
