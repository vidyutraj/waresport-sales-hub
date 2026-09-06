import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  formatPlainDate,
  parsePlainDate,
  zonedDateString,
  zonedDayRange,
  zonedStartOfDay,
  zoneOffsetMs,
} from '@/lib/domain/time';

describe('plain date arithmetic', () => {
  it('parses and formats ISO dates', () => {
    expect(formatPlainDate(parsePlainDate('2026-03-02'))).toBe('2026-03-02');
  });

  it('rejects non-dates', () => {
    expect(() => parsePlainDate('2026-02-30')).toThrow(/not a real calendar date/);
    expect(() => parsePlainDate('03/02/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('adds days across month and year boundaries', () => {
    expect(formatPlainDate(addDays(parsePlainDate('2026-12-30'), 5))).toBe('2027-01-04');
    expect(formatPlainDate(addDays(parsePlainDate('2028-02-28'), 1))).toBe('2028-02-29');
  });

  it('computes day differences symmetrically', () => {
    expect(diffDays(parsePlainDate('2026-03-09'), parsePlainDate('2026-03-02'))).toBe(7);
    expect(diffDays(parsePlainDate('2026-03-02'), parsePlainDate('2026-03-09'))).toBe(-7);
  });
});

describe('timezone boundaries', () => {
  it('resolves local midnight to the correct UTC instant', () => {
    // 2026-01-15 is EST (UTC-5).
    expect(zonedStartOfDay(parsePlainDate('2026-01-15'), 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
    // 2026-07-15 is EDT (UTC-4).
    expect(zonedStartOfDay(parsePlainDate('2026-07-15'), 'America/New_York').toISOString()).toBe(
      '2026-07-15T04:00:00.000Z',
    );
    // Los Angeles, winter (UTC-8).
    expect(zonedStartOfDay(parsePlainDate('2026-01-15'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    // A zone with a non-hour offset.
    expect(zonedStartOfDay(parsePlainDate('2026-01-15'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-01-14T18:30:00.000Z',
    );
  });

  it('keeps a seven-day week seven local days long across spring forward', () => {
    // US DST begins 2026-03-08. A week containing it is 167 hours, not 168.
    const range = zonedDayRange(parsePlainDate('2026-03-02'), 'America/New_York', 7);
    const hours = (range.end.getTime() - range.start.getTime()) / 3_600_000;
    expect(hours).toBe(167);
    expect(zonedDateString(range.start, 'America/New_York')).toBe('2026-03-02');
    // End is exclusive: it is local midnight starting the *next* week.
    expect(zonedDateString(range.end, 'America/New_York')).toBe('2026-03-09');
  });

  it('keeps a seven-day week seven local days long across fall back', () => {
    // US DST ends 2026-11-01.
    const range = zonedDayRange(parsePlainDate('2026-10-26'), 'America/New_York', 7);
    const hours = (range.end.getTime() - range.start.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });

  it('is unaffected by the process timezone for a zone with no DST', () => {
    expect(zonedStartOfDay(parsePlainDate('2026-06-15'), 'UTC').toISOString()).toBe(
      '2026-06-15T00:00:00.000Z',
    );
    expect(zonedStartOfDay(parsePlainDate('2026-06-15'), 'America/Phoenix').toISOString()).toBe(
      '2026-06-15T07:00:00.000Z',
    );
  });

  it('reports zone offsets that change with DST', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
  });

  it('maps an instant back to its local calendar date', () => {
    // 04:00 UTC on Jul 16 is still Jul 16 in New York (00:00 EDT).
    expect(zonedDateString(new Date('2026-07-16T04:00:00Z'), 'America/New_York')).toBe(
      '2026-07-16',
    );
    // One millisecond earlier is still Jul 15 locally.
    expect(zonedDateString(new Date('2026-07-16T03:59:59Z'), 'America/New_York')).toBe(
      '2026-07-15',
    );
  });

  it('handles a zone whose DST transition happens at local midnight', () => {
    // Chile springs forward at 24:00, so 2026-09-06 00:00 does not exist.
    const start = zonedStartOfDay(parsePlainDate('2026-09-06'), 'America/Santiago');
    expect(zonedDateString(start, 'America/Santiago')).toBe('2026-09-06');
  });
});
