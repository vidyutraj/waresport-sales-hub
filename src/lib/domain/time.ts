/**
 * Timezone-correct date arithmetic.
 *
 * Rules used throughout the application:
 *  - Every instant is stored in UTC.
 *  - Reporting boundaries (program weeks, "today", leaderboards) are computed
 *    in the *cohort's* IANA reporting timezone, never the viewer's.
 *  - All ranges are half-open: [start, end).
 *  - Calendar arithmetic happens on plain Y-M-D values and is only then
 *    projected onto an instant, so a week that crosses a daylight-saving
 *    transition is still exactly seven local days (167 or 169 hours).
 */

export type PlainDate = { year: number; month: number; day: number };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parsePlainDate(value: string): PlainDate {
  const m = ISO_DATE.exec(value);
  if (!m) throw new Error(`Expected a YYYY-MM-DD date, received "${value}"`);
  const [, y, mo, d] = m;
  const date: PlainDate = { year: Number(y), month: Number(mo), day: Number(d) };
  // Round-trip through UTC so 2026-02-30 and 2026-13-01 are rejected rather
  // than silently rolling over into the following month.
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    probe.getUTCFullYear() !== date.year ||
    probe.getUTCMonth() + 1 !== date.month ||
    probe.getUTCDate() !== date.day
  ) {
    throw new Error(`"${value}" is not a real calendar date`);
  }
  return date;
}

export function formatPlainDate(date: PlainDate): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(date.year, 4)}-${p(date.month)}-${p(date.day)}`;
}

/** Add whole calendar days. Pure calendar math — no timezone involved. */
export function addDays(date: PlainDate, days: number): PlainDate {
  const ms = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function diffDays(a: PlainDate, b: PlainDate): number {
  const ms = Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
  return Math.round(ms / 86_400_000);
}

export function comparePlainDates(a: PlainDate, b: PlainDate): number {
  return diffDays(a, b);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

type ZonedParts = PlainDate & { hour: number; minute: number; second: number };

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east positive). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Formatting drops sub-second precision, so round the instant to match.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of local midnight on `date` in `timeZone`.
 *
 * Two passes are required: the first guesses using the offset that applies at
 * the naive instant, the second re-resolves using the offset that actually
 * applies at the guessed instant. For a local time skipped by a spring-forward
 * transition this settles on the first instant that does exist that day.
 */
export function zonedStartOfDay(date: PlainDate, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  // If midnight does not exist locally (DST gap), step forward to the first
  // instant of that local calendar day.
  const check = zonedParts(instant, timeZone);
  if (check.day !== date.day || check.month !== date.month || check.year !== date.year) {
    instant = new Date(instant.getTime() + 3_600_000);
  }
  return instant;
}

/** The local calendar date of `instant` in `timeZone`. */
export function zonedDate(instant: Date, timeZone: string): PlainDate {
  const p = zonedParts(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

export function zonedDateString(instant: Date, timeZone: string): string {
  return formatPlainDate(zonedDate(instant, timeZone));
}

export type HalfOpenRange = { start: Date; end: Date };

/** [local midnight of `date`, local midnight of `date` + `days`) */
export function zonedDayRange(date: PlainDate, timeZone: string, days = 1): HalfOpenRange {
  return {
    start: zonedStartOfDay(date, timeZone),
    end: zonedStartOfDay(addDays(date, days), timeZone),
  };
}

export function isWithin(range: HalfOpenRange, instant: Date): boolean {
  return instant.getTime() >= range.start.getTime() && instant.getTime() < range.end.getTime();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPlainDateHuman(date: PlainDate): string {
  return `${MONTHS[date.month - 1]} ${date.day}, ${date.year}`;
}

/** "Mar 3 – Mar 9, 2026" style label for a program week. */
export function formatDateRangeHuman(startInclusive: PlainDate, endInclusive: PlainDate): string {
  const sameYear = startInclusive.year === endInclusive.year;
  const left = `${MONTHS[startInclusive.month - 1]} ${startInclusive.day}${
    sameYear ? '' : `, ${startInclusive.year}`
  }`;
  const right = `${MONTHS[endInclusive.month - 1]} ${endInclusive.day}, ${endInclusive.year}`;
  return `${left} – ${right}`;
}
