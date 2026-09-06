import {
  addDays,
  comparePlainDates,
  diffDays,
  formatDateRangeHuman,
  formatPlainDate,
  parsePlainDate,
  zonedDate,
  zonedStartOfDay,
  type HalfOpenRange,
  type PlainDate,
} from './time';

/**
 * Program-week model.
 *
 * The program guide specifies "12 weeks" and different targets for week 1 vs
 * weeks 2–12, but does not define where a week starts. This implementation
 * uses: week 1 is the first seven calendar days beginning on the cohort start
 * date, and weeks 2..N follow consecutively. Boundaries are computed in the
 * cohort's reporting timezone as half-open [start, end) intervals.
 *
 * This is an implementation default, documented in docs/assumptions.md, and
 * the cohort start date and reporting timezone are both admin-configurable.
 */

/** Targets stated in the program guide (Waresport_Internship_Program.pdf). */
export const PROGRAM_DEFAULT_TARGETS = {
  week1: { emails: 75, linkedin: 50, emailsPerDay: 15, linkedinPerDay: 10 },
  laterWeeks: { emails: 150, linkedin: 100, emailsPerDay: 30, linkedinPerDay: 20 },
} as const;

export const DEFAULT_PROGRAM_WEEKS = 12;
/** The suggested daily pace in the guide is spread over 5 working days. */
export const SUGGESTED_WORKING_DAYS_PER_WEEK = 5;

export type ProgramTargets = {
  emailTarget: number;
  linkedinTarget: number;
  emailDailyPace: number;
  linkedinDailyPace: number;
};

export function programDefaultTargets(weekNumber: number): ProgramTargets {
  const t = weekNumber <= 1 ? PROGRAM_DEFAULT_TARGETS.week1 : PROGRAM_DEFAULT_TARGETS.laterWeeks;
  return {
    emailTarget: t.emails,
    linkedinTarget: t.linkedin,
    emailDailyPace: t.emailsPerDay,
    linkedinDailyPace: t.linkedinPerDay,
  };
}

export type Cohort = {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  startDate: string;
  weeksCount: number;
  reportingTimezone: string;
};

export type ProgramWeek = {
  weekNumber: number;
  /** Inclusive first local calendar day of the week. */
  startDate: PlainDate;
  /** Inclusive last local calendar day of the week. */
  endDate: PlainDate;
  /** Half-open UTC instant range used for every database query. */
  range: HalfOpenRange;
  label: string;
};

export function programWeek(cohort: Cohort, weekNumber: number): ProgramWeek {
  if (!Number.isInteger(weekNumber) || weekNumber < 1) {
    throw new Error(`Week number must be a positive integer, received ${weekNumber}`);
  }
  const start = parsePlainDate(cohort.startDate);
  const weekStart = addDays(start, (weekNumber - 1) * 7);
  const weekEndExclusive = addDays(weekStart, 7);
  const endDate = addDays(weekEndExclusive, -1);
  return {
    weekNumber,
    startDate: weekStart,
    endDate,
    range: {
      start: zonedStartOfDay(weekStart, cohort.reportingTimezone),
      end: zonedStartOfDay(weekEndExclusive, cohort.reportingTimezone),
    },
    label: `Week ${weekNumber} · ${formatDateRangeHuman(weekStart, endDate)}`,
  };
}

export function allProgramWeeks(cohort: Cohort): ProgramWeek[] {
  return Array.from({ length: cohort.weeksCount }, (_, i) => programWeek(cohort, i + 1));
}

/** The full half-open instant range covering the whole program. */
export function cohortRange(cohort: Cohort): HalfOpenRange {
  const start = parsePlainDate(cohort.startDate);
  return {
    start: zonedStartOfDay(start, cohort.reportingTimezone),
    end: zonedStartOfDay(addDays(start, cohort.weeksCount * 7), cohort.reportingTimezone),
  };
}

export type WeekLocation =
  | { kind: 'before'; daysUntilStart: number }
  | { kind: 'in'; week: ProgramWeek }
  | { kind: 'after'; weeksElapsed: number };

/**
 * Where an instant falls relative to the program. Dates outside the 12 weeks
 * never silently generate new targets — callers must handle 'before'/'after'.
 */
export function locateWeek(cohort: Cohort, instant: Date): WeekLocation {
  const local = zonedDate(instant, cohort.reportingTimezone);
  const start = parsePlainDate(cohort.startDate);
  const offset = diffDays(local, start);
  if (offset < 0) return { kind: 'before', daysUntilStart: -offset };
  const weekNumber = Math.floor(offset / 7) + 1;
  if (weekNumber > cohort.weeksCount) {
    return { kind: 'after', weeksElapsed: weekNumber - 1 };
  }
  return { kind: 'in', week: programWeek(cohort, weekNumber) };
}

/** Convenience: the current week, or null when outside the program. */
export function currentProgramWeek(cohort: Cohort, now: Date): ProgramWeek | null {
  const at = locateWeek(cohort, now);
  return at.kind === 'in' ? at.week : null;
}

/**
 * A late joiner follows their cohort's calendar rather than getting a personal
 * week 1. `joinedOn` only decides which weeks count as "participating".
 */
export function isParticipatingInWeek(
  week: ProgramWeek,
  joinedOn: string,
  leftOn?: string | null,
): boolean {
  const joined = parsePlainDate(joinedOn);
  if (comparePlainDates(joined, week.endDate) > 0) return false;
  if (leftOn) {
    const left = parsePlainDate(leftOn);
    if (comparePlainDates(left, week.startDate) < 0) return false;
  }
  return true;
}

/**
 * Remaining suggested daily pace. The guide's per-day figures are advisory —
 * they never create an attendance rule — so this is informational only.
 * Returns null when the target is zero (nothing to pace toward).
 */
export function suggestedRemainingPace(
  target: number,
  achieved: number,
  workingDaysRemaining: number,
): number | null {
  if (target <= 0) return null;
  const remaining = Math.max(0, target - achieved);
  if (remaining === 0) return 0;
  if (workingDaysRemaining <= 0) return remaining;
  return Math.ceil(remaining / workingDaysRemaining);
}

/** Progress as a 0–100 percentage; a zero target reads as complete, never NaN. */
export function progressPercent(achieved: number, target: number): number {
  if (target <= 0) return achieved > 0 ? 100 : 0;
  return Math.min(100, Math.round((achieved / target) * 100));
}

/**
 * A ratio with an explicit denominator. Renders as an em dash when the
 * denominator is zero rather than inventing a 0% conversion rate.
 */
export type Rate = { numerator: number; denominator: number; percent: number | null };

export function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    percent: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
  };
}

export function formatRate(r: Rate): string {
  return r.percent === null ? '—' : `${r.percent}%`;
}

export function cohortStartDateString(cohort: Cohort): string {
  return formatPlainDate(parsePlainDate(cohort.startDate));
}
