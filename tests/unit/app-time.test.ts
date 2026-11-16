import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkyDay } from '../../shared/types.ts';
import {
  addDays,
  formatInstant,
  formatMinuteOfDay,
  formatUtcOffset,
  interpolateSky,
  isValidDateString,
  parseMinuteOfDay,
  shadowMultiplier,
  todayInTimezone
} from '../../src/app/time.ts';
import { buildUrl, parseUrlState } from '../../src/app/url.ts';

const skyTrack = (sun: Array<[number, number]>, moon: Array<[number, number]>): SkyDay => ({
  v: 1,
  date: '2026-06-21',
  tz: 'Europe/Bucharest',
  lat: 45.6486,
  lon: 25.6061,
  utcOffsetMinutes: 180,
  dayStartUtc: '2026-06-20T21:00:00.000Z',
  dayEndUtc: '2026-06-21T21:00:00.000Z',
  track: { stepMinutes: 5, sun, moon },
  sun: {
    rise: null,
    set: null,
    civilDawn: null,
    civilDusk: null,
    solarNoon: null,
    maxAltitudeDeg: 0,
    goldenHourMorning: null,
    goldenHourEvening: null
  },
  moon: { rise: null, set: null, phaseAngleDeg: 0, illumination: 0, phaseName: 'New moon' },
  polarDay: false,
  polarNight: false
});

test('date string validation and clamping', () => {
  assert.equal(isValidDateString('2026-06-21'), true);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('1899-12-31'), false);
  assert.equal(isValidDateString('2101-01-01'), false);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('todayInTimezone handles offsets around midnight', () => {
  const instant = new Date('2026-06-21T22:30:00Z');
  assert.equal(todayInTimezone('Europe/Bucharest', instant), '2026-06-22');
  assert.equal(todayInTimezone('America/New_York', instant), '2026-06-21');
});

test('minute formatting and parsing round-trips', () => {
  assert.equal(formatMinuteOfDay(0), '00:00');
  assert.equal(formatMinuteOfDay(13 * 60 + 5), '13:05');
  assert.equal(formatMinuteOfDay(1439.9), '23:59');
  assert.equal(parseMinuteOfDay('13:05'), 785);
  assert.equal(parseMinuteOfDay('24:00'), null);
  assert.equal(parseMinuteOfDay('7:5'), null);
});

test('sky track interpolation is continuous and wraps azimuth', () => {
  const sun: Array<[number, number]> = [];
  const moon: Array<[number, number]> = [];
  for (let i = 0; i < 289; i += 1) {
    if (i === 0) {
      sun.push([-10, 350]);
      moon.push([20, 100]);
    } else if (i === 1) {
      sun.push([0, 10]);
      moon.push([21, 110]);
    } else {
      sun.push([45, 180]);
      moon.push([30, 120]);
    }
  }
  const sky = skyTrack(sun, moon);
  const at0 = interpolateSky(sky, 0);
  assert.ok(at0);
  assert.equal(at0.sunAlt, -10);
  assert.equal(at0.sunAz, 350);
  const at25 = interpolateSky(sky, 2.5);
  assert.ok(at25);
  assert.ok(at25.sunAz > 350 || at25.sunAz < 10, 'azimuth should move through north');
  const atEnd = interpolateSky(sky, 1440);
  assert.ok(atEnd);
  assert.equal(atEnd.sunAlt, 45);
});

test('shadow multiplier is only defined above the horizon', () => {
  assert.equal(shadowMultiplier(-1), null);
  assert.equal(shadowMultiplier(0), null);
  const at45 = shadowMultiplier(45);
  assert.ok(at45 !== null && Math.abs(at45 - 1) < 0.01);
  const at30 = shadowMultiplier(30);
  assert.ok(at30 !== null && Math.abs(at30 - Math.sqrt(3)) < 0.01);
});

test('UTC offset formatting', () => {
  assert.equal(formatUtcOffset(120), 'UTC+02:00');
  assert.equal(formatUtcOffset(-300), 'UTC−05:00');
  assert.equal(formatUtcOffset(330), 'UTC+05:30');
});

test('formatInstant renders city-local time', () => {
  assert.equal(formatInstant('2026-06-21T10:20:00.000Z', 'Europe/Bucharest'), '13:20');
  assert.equal(formatInstant(null, 'Europe/Bucharest'), '—');
});

test('URL state round-trips city and point targets', () => {
  const cityUrl = new URL(buildUrl({ kind: 'city', geonameId: 683844 }, '2026-06-21', 810, 'http://example.test/'));
  const cityState = parseUrlState(cityUrl.search);
  assert.deepEqual(cityState.target, { kind: 'city', geonameId: 683844 });
  assert.equal(cityState.date, '2026-06-21');
  assert.equal(cityState.minute, 810);

  const pointUrl = new URL(
    buildUrl({ kind: 'point', lat: 45.6, lon: 25.6, name: 'My place' }, '2026-01-01', 0, 'http://example.test/')
  );
  const pointState = parseUrlState(pointUrl.search);
  assert.deepEqual(pointState.target, { kind: 'point', lat: 45.6, lon: 25.6, name: 'My place' });
  assert.equal(pointState.minute, 0);
});

test('URL parsing tolerates garbage', () => {
  assert.deepEqual(parseUrlState('?city=gn:notanumber&date=bad&time=99:00'), {
    target: null,
    date: null,
    minute: null
  });
  assert.deepEqual(parseUrlState('?point=999,999'), { target: null, date: null, minute: null });
});
