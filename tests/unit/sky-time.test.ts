/**
 * Unit tests for the local-wall-clock <-> UTC helpers in `server/sky/time.ts`.
 *
 * The DST transition instants asserted here are the real Europe/Bucharest
 * 2026 transitions: clocks jump forward on 2026-03-29 (02:00 EET -> 03:00 EEST,
 * i.e. 00:00Z -> 01:00Z) and fall back on 2026-10-25 (04:00 EEST -> 03:00 EET,
 * i.e. 01:00Z -> 01:00Z again).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_MINUTE, MIN_MINUTE } from '../../shared/constants.ts';
import { localMinutesToUtc, todayInTimezone, utcOffsetMinutes } from '../../server/sky/time.ts';

const BUCHAREST = 'Europe/Bucharest';
const SYDNEY = 'Australia/Sydney';
const KATHMANDU = 'Asia/Kathmandu';

const HOUR_MINUTES = 60;

/** Local wall clock of an instant, as a canonical date plus minute of day. */
function wallClock(tz: string, instant: Date): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minute: hour * HOUR_MINUTES + Number(get('minute'))
  };
}

/** Expected wall clock for a local date + local minute (1440 rolls over). */
function wallClockOf(date: string, minute: number): { date: string; minute: number } {
  const [year, month, day] = date.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day) + minute * 60_000;
  const instant = new Date(ms);
  return {
    date: instant.toISOString().slice(0, 10),
    minute: instant.getUTCHours() * HOUR_MINUTES + instant.getUTCMinutes()
  };
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

describe('utcOffsetMinutes', () => {
  it('reports whole-minute offsets for modern zones', () => {
    assert.equal(utcOffsetMinutes(BUCHAREST, new Date('2026-06-21T10:00:00Z')), 180);
    assert.equal(utcOffsetMinutes(BUCHAREST, new Date('2026-01-15T10:00:00Z')), 120);
    assert.equal(utcOffsetMinutes(SYDNEY, new Date('2026-06-21T00:00:00Z')), 600);
    assert.equal(utcOffsetMinutes(SYDNEY, new Date('2026-12-21T00:00:00Z')), 660);
    assert.equal(utcOffsetMinutes('Asia/Kolkata', new Date('2026-06-21T00:00:00Z')), 330);
    assert.equal(utcOffsetMinutes(KATHMANDU, new Date('2026-06-21T00:00:00Z')), 345);
    assert.equal(utcOffsetMinutes('Etc/GMT', new Date('2026-06-21T00:00:00Z')), 0);
    assert.equal(utcOffsetMinutes('UTC', new Date('2026-06-21T00:00:00Z')), 0);
  });

  it('rounds historical second-level offsets to whole minutes', () => {
    // Bucharest used LMT +01:44:24 before the 1892 railway-time reform.
    assert.equal(utcOffsetMinutes(BUCHAREST, new Date('1900-01-01T00:00:00Z')), 104);
  });

  it('rejects invalid instants and timezones with RangeError', () => {
    assert.throws(() => utcOffsetMinutes(BUCHAREST, new Date(Number.NaN)), RangeError);
    assert.throws(() => utcOffsetMinutes('Not/AZone', new Date('2026-06-21T00:00:00Z')), RangeError);
  });
});

describe('localMinutesToUtc', () => {
  it('maps plain-day wall-clock minutes to UTC', () => {
    assert.equal(localMinutesToUtc('2026-06-21', 0, BUCHAREST).toISOString(), '2026-06-20T21:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-06-21', 12 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-06-21T09:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-06-21', MAX_MINUTE, BUCHAREST).toISOString(), '2026-06-21T21:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-01-15', 0, BUCHAREST).toISOString(), '2026-01-14T22:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-01-15', 12 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-01-15T10:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-06-21', 0, SYDNEY).toISOString(), '2026-06-20T14:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-06-21', 12 * HOUR_MINUTES, SYDNEY).toISOString(), '2026-06-21T02:00:00.000Z');
    // +05:45 offset: 00:00 local is 18:15Z on the previous UTC day.
    assert.equal(localMinutesToUtc('2026-06-21', 0, KATHMANDU).toISOString(), '2026-06-20T18:15:00.000Z');
  });

  it('maps local 24:00 to the next local midnight', () => {
    const dates = ['2026-06-21', '2026-01-15', '2026-03-29', '2026-10-25'];
    for (const date of dates) {
      assert.equal(
        localMinutesToUtc(date, MAX_MINUTE, BUCHAREST).toISOString(),
        localMinutesToUtc(nextDate(date), MIN_MINUTE, BUCHAREST).toISOString(),
        `24:00 on ${date} must equal 00:00 on ${nextDate(date)}`
      );
    }
    assert.equal(
      localMinutesToUtc('2026-06-21', MAX_MINUTE, SYDNEY).toISOString(),
      localMinutesToUtc('2026-06-22', MIN_MINUTE, SYDNEY).toISOString()
    );
  });

  it('handles the spring-forward gap deterministically', () => {
    // 2026-03-29 00:00 EET and 02:30 EET exist normally.
    assert.equal(localMinutesToUtc('2026-03-29', 0, BUCHAREST).toISOString(), '2026-03-28T22:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-03-29', 150, BUCHAREST).toISOString(), '2026-03-29T00:30:00.000Z');
    // 03:00-03:59 wall clock does not exist: shifted forward by the 60 min gap.
    assert.equal(localMinutesToUtc('2026-03-29', 3 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-03-29T01:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-03-29', 3 * HOUR_MINUTES + 59, BUCHAREST).toISOString(), '2026-03-29T01:59:00.000Z');
    // The first existing wall clock after the gap (04:00 EEST) is the same instant.
    assert.equal(localMinutesToUtc('2026-03-29', 4 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-03-29T01:00:00.000Z');
    // End of the (23 hour) day.
    assert.equal(localMinutesToUtc('2026-03-29', MAX_MINUTE, BUCHAREST).toISOString(), '2026-03-29T21:00:00.000Z');
  });

  it('handles the fall-back overlap deterministically (first occurrence)', () => {
    // 03:00-03:59 wall clock happens twice; the EEST occurrence wins.
    assert.equal(localMinutesToUtc('2026-10-25', 3 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-10-25T00:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-25', 3 * HOUR_MINUTES + 30, BUCHAREST).toISOString(), '2026-10-25T00:30:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-25', 4 * HOUR_MINUTES - 1, BUCHAREST).toISOString(), '2026-10-25T00:59:00.000Z');
    // 04:00 EET is the first wall clock after the overlap.
    assert.equal(localMinutesToUtc('2026-10-25', 4 * HOUR_MINUTES, BUCHAREST).toISOString(), '2026-10-25T02:00:00.000Z');
    // End of the (25 hour) day.
    assert.equal(localMinutesToUtc('2026-10-25', MAX_MINUTE, BUCHAREST).toISOString(), '2026-10-25T22:00:00.000Z');
  });

  it('handles 30-minute DST shifts (Lord Howe Island)', () => {
    const tz = 'Australia/Lord_Howe';
    // DST starts 2026-10-04: 02:00 -> 02:30 local, so 02:00-02:29 is missing and
    // the gap is shifted forward by 30 minutes instead of a full hour.
    assert.equal(localMinutesToUtc('2026-10-04', 2 * HOUR_MINUTES + 15, tz).toISOString(), '2026-10-03T15:45:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-04', 2 * HOUR_MINUTES + 30, tz).toISOString(), '2026-10-03T15:30:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-04', 3 * HOUR_MINUTES, tz).toISOString(), '2026-10-03T16:00:00.000Z');
    // DST ends 2026-04-05: 02:00 -> 01:30, so 01:30-01:59 happens twice; the
    // first (daylight saving) occurrence is used.
    assert.equal(localMinutesToUtc('2026-04-05', HOUR_MINUTES + 45, tz).toISOString(), '2026-04-04T14:45:00.000Z');
    assert.equal(localMinutesToUtc('2026-04-05', 2 * HOUR_MINUTES, tz).toISOString(), '2026-04-04T15:30:00.000Z');
    // The local days are 23.5 and 24.5 hours long.
    const span = (date: string) =>
      localMinutesToUtc(date, MAX_MINUTE, tz).getTime() - localMinutesToUtc(date, MIN_MINUTE, tz).getTime();
    assert.equal(span('2026-10-04'), 23.5 * 3_600_000);
    assert.equal(span('2026-04-05'), 24.5 * 3_600_000);
  });

  it('spans 23/25 hours on DST transition days and 24 hours otherwise', () => {
    const span = (date: string) =>
      localMinutesToUtc(date, MAX_MINUTE, BUCHAREST).getTime() -
      localMinutesToUtc(date, MIN_MINUTE, BUCHAREST).getTime();
    assert.equal(span('2026-03-29'), 23 * 3_600_000);
    assert.equal(span('2026-10-25'), 25 * 3_600_000);
    assert.equal(span('2026-06-21'), 24 * 3_600_000);
  });

  it('round-trips existing wall-clock minutes through the instant', () => {
    const cases: Array<[string, number, string]> = [
      ['2026-06-21', 0, BUCHAREST],
      ['2026-06-21', 12 * HOUR_MINUTES, BUCHAREST],
      ['2026-06-21', MAX_MINUTE, BUCHAREST],
      ['2026-01-15', 7 * HOUR_MINUTES + 45, BUCHAREST],
      ['2026-03-29', 0, BUCHAREST],
      ['2026-03-29', 150, BUCHAREST],
      ['2026-03-29', 4 * HOUR_MINUTES, BUCHAREST],
      ['2026-03-29', MAX_MINUTE, BUCHAREST],
      ['2026-10-25', 0, BUCHAREST],
      ['2026-10-25', 3 * HOUR_MINUTES, BUCHAREST],
      ['2026-10-25', 3 * HOUR_MINUTES + 30, BUCHAREST],
      ['2026-10-25', 4 * HOUR_MINUTES, BUCHAREST],
      ['2026-10-25', MAX_MINUTE, BUCHAREST],
      ['2026-06-21', 0, SYDNEY],
      ['2026-06-21', 12 * HOUR_MINUTES, SYDNEY],
      ['2026-06-21', 0, KATHMANDU]
    ];
    for (const [date, minute, tz] of cases) {
      const instant = localMinutesToUtc(date, minute, tz);
      assert.deepEqual(wallClock(tz, instant), wallClockOf(date, minute), `${date} ${minute} ${tz}`);
    }
  });

  it('is deterministic for repeated calls', () => {
    const first = localMinutesToUtc('2026-03-29', 3 * HOUR_MINUTES, BUCHAREST);
    const second = localMinutesToUtc('2026-03-29', 3 * HOUR_MINUTES, BUCHAREST);
    assert.equal(first.getTime(), second.getTime());
  });

  it('rejects invalid dates, minutes and timezones with RangeError', () => {
    for (const badDate of ['', '2026-6-21', '2026-02-30', '1899-12-31', '2101-01-01', 'yesterday']) {
      assert.throws(() => localMinutesToUtc(badDate, 0, BUCHAREST), RangeError, badDate);
    }
    for (const badMinute of [-1, MAX_MINUTE + 1, 12.5, Number.NaN]) {
      assert.throws(() => localMinutesToUtc('2026-06-21', badMinute, BUCHAREST), RangeError, String(badMinute));
    }
    assert.throws(() => localMinutesToUtc('2026-06-21', 0, 'Not/AZone'), RangeError);
  });
});

describe('todayInTimezone', () => {
  it('formats the local calendar date across the UTC day boundary', () => {
    assert.equal(todayInTimezone(BUCHAREST, new Date('2026-06-20T20:59:59Z')), '2026-06-20');
    assert.equal(todayInTimezone(BUCHAREST, new Date('2026-06-20T21:00:00Z')), '2026-06-21');
    assert.equal(todayInTimezone(BUCHAREST, new Date('2026-06-21T20:59:59Z')), '2026-06-21');
    assert.equal(todayInTimezone(BUCHAREST, new Date('2026-06-21T21:00:00Z')), '2026-06-22');
    // UTC+14: the local date is the next UTC date for most of the day.
    assert.equal(todayInTimezone('Pacific/Kiritimati', new Date('2026-06-21T09:30:00Z')), '2026-06-21');
    assert.equal(todayInTimezone('Pacific/Kiritimati', new Date('2026-06-21T10:30:00Z')), '2026-06-22');
    // UTC-4 in June: local date is the previous UTC date before 04:00Z.
    assert.equal(todayInTimezone('America/New_York', new Date('2026-06-21T03:59:59Z')), '2026-06-20');
    assert.equal(todayInTimezone('America/New_York', new Date('2026-06-21T04:00:00Z')), '2026-06-21');
  });

  it('uses the current time by default', () => {
    const value = todayInTimezone(BUCHAREST);
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(value, todayInTimezone(BUCHAREST, new Date()));
  });

  it('rejects invalid instants and timezones with RangeError', () => {
    assert.throws(() => todayInTimezone(BUCHAREST, new Date(Number.NaN)), RangeError);
    assert.throws(() => todayInTimezone('Not/AZone', new Date('2026-06-21T00:00:00Z')), RangeError);
  });
});
