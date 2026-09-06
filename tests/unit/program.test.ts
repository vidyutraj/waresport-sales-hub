import { describe, expect, it } from 'vitest';
import {
  allProgramWeeks,
  cohortRange,
  currentProgramWeek,
  formatRate,
  isParticipatingInWeek,
  locateWeek,
  PROGRAM_DEFAULT_TARGETS,
  programDefaultTargets,
  programWeek,
  progressPercent,
  rate,
  suggestedRemainingPace,
  type Cohort,
} from '@/lib/domain/program';
import { formatPlainDate, zonedDateString } from '@/lib/domain/time';

const east: Cohort = {
  id: 'c1',
  name: 'Spring 2026',
  startDate: '2026-03-02',
  weeksCount: 12,
  reportingTimezone: 'America/New_York',
};

describe('program targets from the guide', () => {
  it('uses 75 emails / 50 requests in week 1', () => {
    expect(programDefaultTargets(1)).toEqual({
      emailTarget: 75,
      linkedinTarget: 50,
      emailDailyPace: 15,
      linkedinDailyPace: 10,
    });
  });

  it('uses 150 emails / 100 requests from week 2 onward', () => {
    for (const week of [2, 3, 7, 12]) {
      expect(programDefaultTargets(week)).toEqual({
        emailTarget: 150,
        linkedinTarget: 100,
        emailDailyPace: 30,
        linkedinDailyPace: 20,
      });
    }
  });

  it('matches the figures printed in the program PDF', () => {
    expect(PROGRAM_DEFAULT_TARGETS.week1.emails).toBe(75);
    expect(PROGRAM_DEFAULT_TARGETS.week1.linkedin).toBe(50);
    expect(PROGRAM_DEFAULT_TARGETS.laterWeeks.emails).toBe(150);
    expect(PROGRAM_DEFAULT_TARGETS.laterWeeks.linkedin).toBe(100);
  });
});

describe('week boundaries', () => {
  it('makes week 1 the first seven calendar days from the start date', () => {
    const w1 = programWeek(east, 1);
    expect(formatPlainDate(w1.startDate)).toBe('2026-03-02');
    expect(formatPlainDate(w1.endDate)).toBe('2026-03-08');
    expect(w1.range.start.toISOString()).toBe('2026-03-02T05:00:00.000Z');
    // Week 1 contains the spring-forward transition, so it ends after 167h.
    expect(w1.range.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('produces consecutive, gapless, non-overlapping weeks', () => {
    const weeks = allProgramWeeks(east);
    expect(weeks).toHaveLength(12);
    for (let i = 1; i < weeks.length; i += 1) {
      expect(weeks[i]!.range.start.getTime()).toBe(weeks[i - 1]!.range.end.getTime());
    }
    expect(weeks[11]!.range.end.getTime()).toBe(cohortRange(east).end.getTime());
  });

  it('treats week ranges as half-open', () => {
    const w1 = programWeek(east, 1);
    const w2 = programWeek(east, 2);
    // The exact boundary instant belongs to week 2, never to both.
    expect(locateWeek(east, w1.range.end)).toMatchObject({ kind: 'in' });
    expect(
      (locateWeek(east, w1.range.end) as { week: { weekNumber: number } }).week.weekNumber,
    ).toBe(2);
    expect(locateWeek(east, new Date(w2.range.start.getTime() - 1))).toMatchObject({
      kind: 'in',
    });
  });

  it('locates instants before, inside and after the program', () => {
    expect(locateWeek(east, new Date('2026-02-25T12:00:00Z'))).toEqual({
      kind: 'before',
      daysUntilStart: 5,
    });
    const inside = locateWeek(east, new Date('2026-04-01T16:00:00Z'));
    expect(inside.kind).toBe('in');
    if (inside.kind === 'in') expect(inside.week.weekNumber).toBe(5);
    expect(locateWeek(east, new Date('2026-06-01T16:00:00Z'))).toEqual({
      kind: 'after',
      weeksElapsed: 13,
    });
  });

  it('does not invent targets outside the program window', () => {
    expect(currentProgramWeek(east, new Date('2026-02-01T12:00:00Z'))).toBeNull();
    expect(currentProgramWeek(east, new Date('2026-09-01T12:00:00Z'))).toBeNull();
  });

  it('computes boundaries in the cohort timezone, not the viewer timezone', () => {
    const west: Cohort = { ...east, id: 'c2', reportingTimezone: 'America/Los_Angeles' };
    expect(programWeek(west, 1).range.start.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    // 06:00 UTC on Mar 9 is already week 2 in New York but still week 1 in LA.
    const boundary = new Date('2026-03-09T06:00:00Z');
    const inEast = locateWeek(east, boundary);
    const inWest = locateWeek(west, boundary);
    expect(inEast.kind === 'in' && inEast.week.weekNumber).toBe(2);
    expect(inWest.kind === 'in' && inWest.week.weekNumber).toBe(1);
  });

  it('keeps every week exactly seven local days regardless of DST', () => {
    for (const week of allProgramWeeks(east)) {
      const startLocal = zonedDateString(week.range.start, east.reportingTimezone);
      expect(startLocal).toBe(formatPlainDate(week.startDate));
      const lastInstant = new Date(week.range.end.getTime() - 1);
      expect(zonedDateString(lastInstant, east.reportingTimezone)).toBe(
        formatPlainDate(week.endDate),
      );
    }
  });

  it('rejects invalid week numbers', () => {
    expect(() => programWeek(east, 0)).toThrow(/positive integer/);
    expect(() => programWeek(east, 1.5)).toThrow(/positive integer/);
  });
});

describe('late joiners', () => {
  it('follows the cohort calendar rather than a personal week 1', () => {
    const w1 = programWeek(east, 1);
    const w4 = programWeek(east, 4);
    // Joined at the start of week 4.
    expect(isParticipatingInWeek(w1, '2026-03-23')).toBe(false);
    expect(isParticipatingInWeek(w4, '2026-03-23')).toBe(true);
  });

  it('stops participating after leaving', () => {
    const w8 = programWeek(east, 8);
    expect(isParticipatingInWeek(w8, '2026-03-02', '2026-04-05')).toBe(false);
    expect(isParticipatingInWeek(w8, '2026-03-02', '2026-05-01')).toBe(true);
  });
});

describe('pace and progress arithmetic', () => {
  it('never divides by zero', () => {
    expect(suggestedRemainingPace(0, 0, 5)).toBeNull();
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(4, 0)).toBe(100);
    expect(suggestedRemainingPace(150, 30, 0)).toBe(120);
  });

  it('rounds the suggested pace up', () => {
    expect(suggestedRemainingPace(150, 0, 5)).toBe(30);
    expect(suggestedRemainingPace(150, 31, 4)).toBe(30);
    expect(suggestedRemainingPace(150, 150, 3)).toBe(0);
    expect(suggestedRemainingPace(150, 400, 3)).toBe(0);
  });

  it('caps progress at 100 percent', () => {
    expect(progressPercent(200, 150)).toBe(100);
    expect(progressPercent(75, 150)).toBe(50);
  });
});

describe('rates with explicit denominators', () => {
  it('renders an em dash when the denominator is zero', () => {
    expect(formatRate(rate(0, 0))).toBe('—');
    expect(rate(0, 0).percent).toBeNull();
  });

  it('reports one decimal place', () => {
    expect(formatRate(rate(1, 3))).toBe('33.3%');
    expect(formatRate(rate(5, 20))).toBe('25%');
  });
});
