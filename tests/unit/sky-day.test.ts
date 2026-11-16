/**
 * Unit tests for `server/sky/day.ts`.
 *
 * The payload is checked against:
 * - the reference payload `tests/fixtures/sky-brasov-2026-06-21.json`,
 * - published/known ephemeris values (Brașov solstice, Sydney solstices,
 *   equinoxes, Tromsø polar day/night, Europe/Bucharest 2026 DST transitions),
 * - structural properties of the wire contract in `shared/types.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Body, Equator, Horizon, Observer, SearchHourAngle, SearchRiseSet } from 'astronomy-engine';
import type { SkyDay } from '../../shared/types.ts';
import { MAX_MINUTE, MIN_MINUTE, SKY_STEP_MINUTES, SKY_VERSION } from '../../shared/constants.ts';
import { computeSkyDay, resolveTimezone, validateLocalDate } from '../../server/sky/day.ts';
import { localMinutesToUtc } from '../../server/sky/time.ts';

/* ------------------------------------------------------------------ */
/* Fixtures and shared constants                                       */
/* ------------------------------------------------------------------ */

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/sky-brasov-2026-06-21.json', import.meta.url), 'utf8')
) as SkyDay;

const BRASOV = { lat: 45.64861, lon: 25.60613, tz: 'Europe/Bucharest' };
const BUCHAREST = { lat: 44.43225, lon: 26.10626, tz: 'Europe/Bucharest' };
const TROMSO = { lat: 69.65, lon: 18.96, tz: 'Europe/Oslo' };
const SYDNEY = { lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' };
const EQUATOR = { lat: 0, lon: 0, tz: 'Etc/GMT' };

const HOUR_MS = 3_600_000;
const EXPECTED_SAMPLE_COUNT = (MAX_MINUTE - MIN_MINUTE) / SKY_STEP_MINUTES + 1;

const PHASE_NAMES = new Set([
  'New moon',
  'Waxing crescent',
  'First quarter',
  'Waxing gibbous',
  'Full moon',
  'Waning gibbous',
  'Last quarter',
  'Waning crescent'
]);

/** Memoised helper: repeated use of the same payload across tests. */
const skyCache = new Map<string, SkyDay>();
function sky(lat: number, lon: number, date: string): SkyDay {
  const key = `${lat.toFixed(6)}|${lon.toFixed(6)}|${date}`;
  const cached = skyCache.get(key);
  if (cached) return cached;
  const computed = computeSkyDay(lat, lon, date);
  skyCache.set(key, computed);
  return computed;
}

/* ------------------------------------------------------------------ */
/* Test helpers                                                        */
/* ------------------------------------------------------------------ */

function localWallClock(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${hour}:${get('minute')}:${get('second')}`;
}

function localMinuteOfDay(iso: string, tz: string): number {
  const [hours, minutes, seconds] = localWallClock(iso, tz).split(':').map(Number);
  return hours * 60 + minutes + seconds / 60;
}

function assertLocalBetween(
  iso: string | null,
  tz: string,
  earliest: string,
  latest: string,
  label: string
): void {
  assert.ok(iso !== null, `${label} should not be null`);
  const wall = localWallClock(iso, tz);
  assert.ok(wall >= earliest && wall <= latest, `${label}: local ${wall} not in ${earliest}..${latest}`);
}

function assertIsoClose(
  actual: string | null,
  expected: string | null,
  toleranceMs: number,
  label: string
): void {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  const diff = Math.abs(Date.parse(actual) - Date.parse(expected));
  assert.ok(diff <= toleranceMs, `${label}: ${actual} vs ${expected} differs by ${diff}ms`);
}

function assertInsideDay(iso: string | null, day: SkyDay, label: string): void {
  if (iso === null) return;
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `${label} must be a valid ISO instant`);
  assert.ok(ms >= Date.parse(day.dayStartUtc), `${label} ${iso} is before dayStart`);
  assert.ok(ms <= Date.parse(day.dayEndUtc), `${label} ${iso} is after dayEnd`);
}

/** Length of the local day (23/24/25 hours: DST aware). */
function daySpanHours(day: SkyDay): number {
  return (Date.parse(day.dayEndUtc) - Date.parse(day.dayStartUtc)) / HOUR_MS;
}

/** Time between sunrise and sunset in hours. */
function sunriseToSunsetHours(day: SkyDay): number {
  assert.ok(day.sun.rise !== null && day.sun.set !== null);
  return (Date.parse(day.sun.set) - Date.parse(day.sun.rise)) / HOUR_MS;
}

/** Direct astronomy-engine sun altitude, optionally without refraction. */
type HorizonFn = (
  date: Date,
  observer: Observer,
  ra: number,
  dec: number,
  refraction?: string | null
) => { altitude: number };
const horizonAt = Horizon as unknown as HorizonFn;

function sunAltitude(lat: number, lon: number, iso: string, refraction: string | null): number {
  const observer = new Observer(lat, lon, 0);
  const instant = new Date(iso);
  const equator = Equator(Body.Sun, instant, observer, true, true);
  return horizonAt(instant, observer, equator.ra, equator.dec, refraction).altitude;
}

function roundedSunSample(lat: number, lon: number, iso: string): [number, number] {
  const observer = new Observer(lat, lon, 0);
  const instant = new Date(iso);
  const equator = Equator(Body.Sun, instant, observer, true, true);
  const horizon = Horizon(instant, observer, equator.ra, equator.dec, 'normal');
  const round2 = (value: number) => {
    const rounded = Math.round(value * 100) / 100;
    return rounded === 0 ? 0 : rounded;
  };
  const wrapped = round2(horizon.azimuth) % 360;
  return [round2(horizon.altitude), wrapped < 0 ? wrapped + 360 : wrapped];
}

function sunTransitMs(lat: number, lon: number, dayStartIso: string): number {
  const observer = new Observer(lat, lon, 0);
  const event = SearchHourAngle(Body.Sun, observer, 0, new Date(dayStartIso), +1);
  return event.time.date.getTime();
}

/* ------------------------------------------------------------------ */
/* resolveTimezone / validateLocalDate                                 */
/* ------------------------------------------------------------------ */

describe('resolveTimezone', () => {
  it('resolves coordinates to their IANA timezone', () => {
    assert.equal(resolveTimezone(BRASOV.lat, BRASOV.lon), 'Europe/Bucharest');
    assert.equal(resolveTimezone(TROMSO.lat, TROMSO.lon), 'Europe/Oslo');
    assert.equal(resolveTimezone(SYDNEY.lat, SYDNEY.lon), 'Australia/Sydney');
    assert.equal(resolveTimezone(40.7128, -74.006), 'America/New_York');
  });

  it('returns a usable timezone for ocean coordinates', () => {
    const tz = resolveTimezone(0, 180);
    assert.equal(typeof tz, 'string');
    assert.ok(tz.length > 0);
    // The resolved name must be a real IANA timezone.
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-GB', { timeZone: tz }));
  });

  it('rejects impossible coordinates with RangeError', () => {
    for (const [lat, lon] of [
      [91, 0],
      [-91, 0],
      [0, 181],
      [0, -181],
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY]
    ] as const) {
      assert.throws(() => resolveTimezone(lat, lon), RangeError, `${lat},${lon}`);
    }
  });
});

describe('validateLocalDate', () => {
  it('accepts real dates inside the supported range', () => {
    assert.doesNotThrow(() => validateLocalDate('1900-01-01'));
    assert.doesNotThrow(() => validateLocalDate('2100-12-31'));
    assert.doesNotThrow(() => validateLocalDate('2026-06-21'));
    assert.doesNotThrow(() => validateLocalDate('2028-02-29'));
  });

  it('rejects malformed dates with RangeError', () => {
    for (const value of ['', '2026-6-21', '26-06-21', '2026/06/21', 'yesterday', '2026-06-21T00:00']) {
      assert.throws(() => validateLocalDate(value), RangeError, value);
    }
  });

  it('rejects impossible calendar dates with RangeError', () => {
    for (const value of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
      assert.throws(() => validateLocalDate(value), RangeError, value);
    }
  });

  it('rejects dates outside DATE_MIN..DATE_MAX with RangeError', () => {
    for (const value of ['1899-12-31', '1900-00-01', '2101-01-01']) {
      assert.throws(() => validateLocalDate(value), RangeError, value);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Reference payload                                                   */
/* ------------------------------------------------------------------ */

describe('reference payload (Brașov 2026-06-21)', () => {
  const day = sky(FIXTURE.lat, FIXTURE.lon, FIXTURE.date);

  it('matches the scalar and timezone fields', () => {
    assert.equal(day.v, FIXTURE.v);
    assert.equal(day.v, SKY_VERSION);
    assert.equal(day.date, FIXTURE.date);
    assert.equal(day.tz, FIXTURE.tz);
    assert.equal(day.lat, FIXTURE.lat);
    assert.equal(day.lon, FIXTURE.lon);
    assert.equal(day.utcOffsetMinutes, FIXTURE.utcOffsetMinutes);
    assert.equal(day.dayStartUtc, FIXTURE.dayStartUtc);
    assert.equal(day.dayEndUtc, FIXTURE.dayEndUtc);
    assert.equal(day.polarDay, FIXTURE.polarDay);
    assert.equal(day.polarNight, FIXTURE.polarNight);
    assert.equal(day.track.stepMinutes, FIXTURE.track.stepMinutes);
  });

  it('reproduces all 289 sun/moon track samples within rounding tolerance', () => {
    assert.equal(day.track.sun.length, FIXTURE.track.sun.length);
    assert.equal(day.track.moon.length, FIXTURE.track.moon.length);
    for (const body of ['sun', 'moon'] as const) {
      for (let index = 0; index < FIXTURE.track[body].length; index += 1) {
        const actual = day.track[body][index];
        const expected = FIXTURE.track[body][index];
        assert.ok(
          Math.abs(actual[0] - expected[0]) <= 0.02 && Math.abs(actual[1] - expected[1]) <= 0.02,
          `${body}[${index}] = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
        );
      }
    }
  });

  it('reproduces the almanac events', () => {
    assertIsoClose(day.sun.rise, FIXTURE.sun.rise, 1000, 'sun.rise');
    assertIsoClose(day.sun.set, FIXTURE.sun.set, 1000, 'sun.set');
    assertIsoClose(day.sun.civilDawn, FIXTURE.sun.civilDawn, 1000, 'sun.civilDawn');
    assertIsoClose(day.sun.civilDusk, FIXTURE.sun.civilDusk, 1000, 'sun.civilDusk');
    assertIsoClose(day.moon.rise, FIXTURE.moon.rise, 1000, 'moon.rise');
    assertIsoClose(day.moon.set, FIXTURE.moon.set, 1000, 'moon.set');
    assertIsoClose(day.sun.goldenHourMorning?.[0] ?? null, FIXTURE.sun.goldenHourMorning?.[0] ?? null, 1000, 'goldenHourMorning start');
    assertIsoClose(day.sun.goldenHourMorning?.[1] ?? null, FIXTURE.sun.goldenHourMorning?.[1] ?? null, 1000, 'goldenHourMorning end');
    assertIsoClose(day.sun.goldenHourEvening?.[0] ?? null, FIXTURE.sun.goldenHourEvening?.[0] ?? null, 1000, 'goldenHourEvening start');
    assertIsoClose(day.sun.goldenHourEvening?.[1] ?? null, FIXTURE.sun.goldenHourEvening?.[1] ?? null, 1000, 'goldenHourEvening end');
    assert.ok(
      Math.abs(day.sun.maxAltitudeDeg - FIXTURE.sun.maxAltitudeDeg) <= 0.01,
      `maxAltitudeDeg ${day.sun.maxAltitudeDeg} vs ${FIXTURE.sun.maxAltitudeDeg}`
    );
    // Solar noon is refined from the 5-minute grid; the reference payload stores
    // it on the grid, so allow the sub-minute refinement difference.
    assertIsoClose(day.sun.solarNoon, FIXTURE.sun.solarNoon, 60_000, 'sun.solarNoon');
  });

  it('reproduces the moon phase snapshot', () => {
    assert.ok(Math.abs(day.moon.phaseAngleDeg - FIXTURE.moon.phaseAngleDeg) <= 0.01);
    assert.ok(Math.abs(day.moon.illumination - FIXTURE.moon.illumination) <= 0.001);
    assert.equal(day.moon.phaseName, FIXTURE.moon.phaseName);
  });
});

/* ------------------------------------------------------------------ */
/* Known values                                                        */
/* ------------------------------------------------------------------ */

describe('known values (Brașov, 2026-06-21 solstice)', () => {
  const day = sky(BRASOV.lat, BRASOV.lon, '2026-06-21');

  it('has the expected sunrise, sunset and solar noon', () => {
    // Published: sunrise ≈05:28 EEST, sunset ≈21:10 EEST, solar noon ≈13:20 EEST.
    assertLocalBetween(day.sun.rise, day.tz, '05:27:00', '05:30:00', 'sunrise');
    assertLocalBetween(day.sun.set, day.tz, '21:09:00', '21:12:00', 'sunset');
    assertLocalBetween(day.sun.solarNoon, day.tz, '13:18:00', '13:21:00', 'solar noon');
  });

  it('agrees with the engine transit search to the second', () => {
    const solarNoon = day.sun.solarNoon;
    assert.ok(solarNoon !== null);
    const transit = sunTransitMs(BRASOV.lat, BRASOV.lon, day.dayStartUtc);
    assert.ok(Math.abs(Date.parse(solarNoon) - transit) <= 2000);
  });

  it('reflects the summer-solstice geometry', () => {
    assert.equal(day.utcOffsetMinutes, 180);
    assert.equal(day.sun.maxAltitudeDeg, 67.8);
    assert.equal(day.polarDay, false);
    assert.equal(day.polarNight, false);
    assert.equal(day.sun.rise === null, false);
    assert.equal(day.sun.set === null, false);
    assertLocalBetween(day.sun.civilDawn, day.tz, '04:49:00', '04:51:00', 'civil dawn');
    assertLocalBetween(day.sun.civilDusk, day.tz, '21:47:00', '21:50:00', 'civil dusk');
  });

  it('searches civil dusk/dawn and golden-hour boundaries at the right altitudes', () => {
    // SearchAltitude targets are unrefracted altitudes.
    const near = (iso: string | null, target: number, label: string) => {
      assert.ok(iso !== null, `${label} should not be null`);
      const altitude = sunAltitude(BRASOV.lat, BRASOV.lon, iso, null);
      assert.ok(Math.abs(altitude - target) <= 0.05, `${label}: altitude ${altitude} vs ${target}`);
    };
    near(day.sun.civilDawn, -6, 'civilDawn');
    near(day.sun.civilDusk, -6, 'civilDusk');
    const morning = day.sun.goldenHourMorning;
    const evening = day.sun.goldenHourEvening;
    assert.ok(morning !== null && evening !== null);
    near(morning[0], -4, 'goldenHourMorning start');
    near(morning[1], 6, 'goldenHourMorning end');
    near(evening[0], 6, 'goldenHourEvening start');
    near(evening[1], -4, 'goldenHourEvening end');
    // Rise/set use the visual horizon at -0.8333° (unrefracted centre altitude).
    near(day.sun.rise, -0.8333, 'sunrise');
    near(day.sun.set, -0.8333, 'sunset');
  });

  it('orders the sun events through the day', () => {
    const instant = (iso: string | null) => {
      assert.ok(iso !== null);
      return Date.parse(iso);
    };
    assert.ok(instant(day.sun.civilDawn) < instant(day.sun.rise));
    assert.ok(instant(day.sun.rise) < instant(day.sun.solarNoon));
    assert.ok(instant(day.sun.solarNoon) < instant(day.sun.set));
    assert.ok(instant(day.sun.set) < instant(day.sun.civilDusk));
    const morning = day.sun.goldenHourMorning;
    const evening = day.sun.goldenHourEvening;
    assert.ok(morning !== null && evening !== null);
    assert.ok(instant(morning[0]) < instant(day.sun.rise));
    assert.ok(instant(day.sun.rise) < instant(morning[1]));
    assert.ok(instant(day.sun.solarNoon) < instant(evening[0]));
    assert.ok(instant(day.sun.set) < instant(evening[1]));
    assert.ok(instant(evening[0]) < instant(evening[1]));
  });

  it('samples 00:00..24:00 at five-minute steps', () => {
    assert.equal(EXPECTED_SAMPLE_COUNT, 289);
    assert.equal(day.track.stepMinutes, SKY_STEP_MINUTES);
    assert.equal(day.track.sun.length, 289);
    assert.equal(day.track.moon.length, 289);
  });

  it('closes the track with the next local midnight', () => {
    const next = sky(BRASOV.lat, BRASOV.lon, '2026-06-22');
    assert.deepEqual(day.track.sun[288], next.track.sun[0]);
    assert.deepEqual(day.track.moon[288], next.track.moon[0]);
    assert.equal(day.dayEndUtc, next.dayStartUtc);
  });

  it('keeps the sun track continuous and north-clockwise azimuths in range', () => {
    const wrap = (delta: number) => ((delta + 540) % 360) - 180;
    for (let index = 1; index < day.track.sun.length; index += 1) {
      const [altBefore, azBefore] = day.track.sun[index - 1];
      const [altAfter, azAfter] = day.track.sun[index];
      assert.ok(Math.abs(altAfter - altBefore) < 1.5, `altitude jump at sample ${index}`);
      assert.ok(Math.abs(wrap(azAfter - azBefore)) < 5, `azimuth jump at sample ${index}`);
      assert.ok(azAfter >= 0 && azAfter < 360);
    }
  });

  it('wraps the 24:00 sample back to nearly the same sky as 00:00', () => {
    const [firstAlt, firstAz] = day.track.sun[0];
    const [lastAlt, lastAz] = day.track.sun[288];
    assert.ok(Math.abs(lastAlt - firstAlt) < 0.1);
    assert.ok(Math.abs(((lastAz - firstAz + 540) % 360) - 180) < 0.2);
  });
});

/* ------------------------------------------------------------------ */
/* Southern hemisphere and equinoxes                                   */
/* ------------------------------------------------------------------ */

describe('southern hemisphere (Sydney)', () => {
  it('has a short winter day at the June solstice', () => {
    const day = sky(SYDNEY.lat, SYDNEY.lon, '2026-06-21');
    assert.equal(day.tz, 'Australia/Sydney');
    assert.equal(day.utcOffsetMinutes, 600);
    assertLocalBetween(day.sun.rise, day.tz, '06:55:00', '07:05:00', 'sunrise');
    assertLocalBetween(day.sun.set, day.tz, '16:50:00', '16:58:00', 'sunset');
    assertLocalBetween(day.sun.solarNoon, day.tz, '11:54:00', '12:00:00', 'solar noon');
    assert.ok(day.sun.maxAltitudeDeg > 32 && day.sun.maxAltitudeDeg < 34);
    assert.ok(sunriseToSunsetHours(day) > 9.8 && sunriseToSunsetHours(day) < 10.0);
    assert.equal(day.polarDay, false);
    assert.equal(day.polarNight, false);
  });

  it('has a long summer day at the December solstice', () => {
    const day = sky(SYDNEY.lat, SYDNEY.lon, '2026-12-21');
    assert.equal(day.utcOffsetMinutes, 660);
    assertLocalBetween(day.sun.rise, day.tz, '05:38:00', '05:44:00', 'sunrise');
    assertLocalBetween(day.sun.set, day.tz, '20:02:00', '20:09:00', 'sunset');
    assert.ok(day.sun.maxAltitudeDeg > 78 && day.sun.maxAltitudeDeg < 81);
    assert.ok(sunriseToSunsetHours(day) > 14.3 && sunriseToSunsetHours(day) < 14.5);
    // Northern-hemisphere seasons are reversed.
    const june = sky(SYDNEY.lat, SYDNEY.lon, '2026-06-21');
    assert.ok(day.sun.maxAltitudeDeg > june.sun.maxAltitudeDeg);
    assert.ok(sunriseToSunsetHours(day) > sunriseToSunsetHours(june));
  });
});

describe('equinoxes', () => {
  it('has an almost exactly 12 hour day at Brașov', () => {
    for (const date of ['2026-03-20', '2026-09-23']) {
      const day = sky(BRASOV.lat, BRASOV.lon, date);
      assert.ok(day.sun.rise !== null && day.sun.set !== null, date);
      assert.ok(day.sun.maxAltitudeDeg > 43.5 && day.sun.maxAltitudeDeg < 45, `${date} max altitude`);
      assert.ok(sunriseToSunsetHours(day) > 12.0 && sunriseToSunsetHours(day) < 12.3, `${date} daylight`);
    }
  });

  it('puts the sun close to the zenith at the equator', () => {
    const day = sky(EQUATOR.lat, EQUATOR.lon, '2026-03-20');
    assert.equal(day.tz, 'Etc/GMT');
    assert.equal(day.utcOffsetMinutes, 0);
    assert.ok(day.sun.maxAltitudeDeg > 88, `max altitude ${day.sun.maxAltitudeDeg}`);
    assert.ok(day.sun.rise !== null && day.sun.set !== null);
    assert.ok(sunriseToSunsetHours(day) > 12.0 && sunriseToSunsetHours(day) < 12.2);
  });
});

/* ------------------------------------------------------------------ */
/* Polar day / polar night                                             */
/* ------------------------------------------------------------------ */

describe('high latitudes (Tromsø)', () => {
  it('has polar day at the June solstice', () => {
    const day = sky(TROMSO.lat, TROMSO.lon, '2026-06-21');
    assert.equal(day.tz, 'Europe/Oslo');
    assert.equal(day.polarDay, true);
    assert.equal(day.polarNight, false);
    assert.equal(day.sun.rise, null);
    assert.equal(day.sun.set, null);
    assert.equal(day.sun.civilDawn, null);
    assert.equal(day.sun.civilDusk, null);
    assert.equal(day.sun.goldenHourMorning, null);
    assert.equal(day.sun.goldenHourEvening, null);
    assert.ok(day.sun.maxAltitudeDeg > 43 && day.sun.maxAltitudeDeg < 45);
    assert.ok(day.track.sun.every(([altitude]) => altitude > 0));
    assert.equal(daySpanHours(day), 24);
    assert.ok(day.sun.solarNoon !== null);
    // The event search is bounded to the local day: an unbounded search would
    // find the next sunrise (weeks away), but that event is not part of this day.
    const unbounded = SearchRiseSet(
      Body.Sun,
      new Observer(TROMSO.lat, TROMSO.lon, 0),
      +1,
      new Date(day.dayStartUtc),
      60
    );
    assert.ok(unbounded !== null);
    assert.ok(unbounded.date.getTime() > Date.parse(day.dayEndUtc));
    assert.equal(day.sun.rise, null);
  });

  it('has polar night at the December solstice', () => {
    const day = sky(TROMSO.lat, TROMSO.lon, '2026-12-21');
    assert.equal(day.polarDay, false);
    assert.equal(day.polarNight, true);
    assert.equal(day.sun.rise, null);
    assert.equal(day.sun.set, null);
    assert.ok(day.sun.maxAltitudeDeg > -4 && day.sun.maxAltitudeDeg < -2);
    assert.ok(day.track.sun.every(([altitude]) => altitude < 0));
    assert.equal(daySpanHours(day), 24);
    // Civil twilight still occurs around local noon, but the golden hour does not.
    assert.ok(day.sun.civilDawn !== null);
    assert.ok(day.sun.civilDusk !== null);
    assert.equal(day.sun.goldenHourMorning, null);
    assert.equal(day.sun.goldenHourEvening, null);
    assert.ok(day.sun.solarNoon !== null);
    assert.equal(day.moon.rise, null);
    assert.equal(day.moon.set, null);
  });
});

/* ------------------------------------------------------------------ */
/* DST transitions                                                     */
/* ------------------------------------------------------------------ */

describe('DST transition days (Europe/Bucharest 2026)', () => {
  it('has a 23 hour local day when clocks spring forward (2026-03-29)', () => {
    const day = sky(BUCHAREST.lat, BUCHAREST.lon, '2026-03-29');
    assert.equal(day.tz, 'Europe/Bucharest');
    assert.equal(day.utcOffsetMinutes, 180);
    assert.equal(day.dayStartUtc, '2026-03-28T22:00:00.000Z');
    assert.equal(day.dayEndUtc, '2026-03-29T21:00:00.000Z');
    assert.equal(daySpanHours(day), 23);
    assert.equal(day.track.sun.length, 289);
    assert.ok(day.sun.rise !== null && day.sun.set !== null);
    // The 03:00..03:59 wall clock does not exist: those samples repeat the
    // instants used by 04:00..04:59 local time.
    for (let offset = 0; offset < 12; offset += 1) {
      assert.deepEqual(day.track.sun[36 + offset], day.track.sun[48 + offset], `sun sample ${36 + offset}`);
      assert.deepEqual(day.track.moon[36 + offset], day.track.moon[48 + offset], `moon sample ${36 + offset}`);
    }
  });

  it('has a 25 hour local day when clocks fall back (2026-10-25)', () => {
    const day = sky(BUCHAREST.lat, BUCHAREST.lon, '2026-10-25');
    assert.equal(day.utcOffsetMinutes, 120);
    assert.equal(day.dayStartUtc, '2026-10-24T21:00:00.000Z');
    assert.equal(day.dayEndUtc, '2026-10-25T22:00:00.000Z');
    assert.equal(daySpanHours(day), 25);
    assert.equal(day.track.sun.length, 289);
    assert.ok(day.sun.rise !== null && day.sun.set !== null);
    // 03:00..03:59 local time occurs twice; the first (EEST) occurrence is used,
    // so 04:00 local time jumps two hours ahead in UTC.
    assert.equal(localMinutesToUtc('2026-10-25', 180, day.tz).toISOString(), '2026-10-25T00:00:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-25', 210, day.tz).toISOString(), '2026-10-25T00:30:00.000Z');
    assert.equal(localMinutesToUtc('2026-10-25', 240, day.tz).toISOString(), '2026-10-25T02:00:00.000Z');
  });

  it('maps each sample index to its wall-clock minute on transition days', () => {
    const nextDate: Record<string, string> = { '2026-03-29': '2026-03-30', '2026-10-25': '2026-10-26' };
    for (const date of ['2026-03-29', '2026-10-25']) {
      const day = sky(BUCHAREST.lat, BUCHAREST.lon, date);
      for (const index of [0, 1, 36, 37, 47, 48, 49, 100, 288]) {
        const instant = localMinutesToUtc(date, index * SKY_STEP_MINUTES, day.tz);
        assert.deepEqual(
          day.track.sun[index],
          roundedSunSample(BUCHAREST.lat, BUCHAREST.lon, instant.toISOString()),
          `${date} sun sample ${index}`
        );
      }
      const next = sky(BUCHAREST.lat, BUCHAREST.lon, nextDate[date]);
      assert.deepEqual(day.track.sun[288], next.track.sun[0], `${date} end sample`);
      assert.deepEqual(day.track.moon[288], next.track.moon[0], `${date} end moon sample`);
    }
  });

  it('reports the UTC offset at local noon, not at local midnight', () => {
    for (const [date, expected] of [
      ['2026-03-29', 180],
      ['2026-10-25', 120],
      ['2026-06-21', 180],
      ['2026-12-21', 120]
    ] as const) {
      const day = sky(BUCHAREST.lat, BUCHAREST.lon, date);
      assert.equal(day.utcOffsetMinutes, expected, date);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Contract shape and robustness                                       */
/* ------------------------------------------------------------------ */

describe('SkyDay payload contract', () => {
  const cases: Array<{ lat: number; lon: number; date: string; tz: string; daylightMs: number }> = [
    { ...BRASOV, date: '2026-06-21', daylightMs: 24 * HOUR_MS },
    { ...BRASOV, date: '2026-12-21', daylightMs: 24 * HOUR_MS },
    { ...TROMSO, date: '2026-06-21', daylightMs: 24 * HOUR_MS },
    { ...TROMSO, date: '2026-12-21', daylightMs: 24 * HOUR_MS },
    { ...SYDNEY, date: '2026-06-21', daylightMs: 24 * HOUR_MS },
    { ...SYDNEY, date: '2026-12-21', daylightMs: 24 * HOUR_MS },
    { ...EQUATOR, date: '2026-03-20', daylightMs: 24 * HOUR_MS },
    { ...BUCHAREST, date: '2026-03-29', daylightMs: 23 * HOUR_MS },
    { ...BUCHAREST, date: '2026-10-25', daylightMs: 25 * HOUR_MS },
    // Lord Howe Island shifts its clocks by 30 minutes, not a full hour.
    { lat: -31.55, lon: 159.08, date: '2026-10-04', tz: 'Australia/Lord_Howe', daylightMs: 23.5 * HOUR_MS }
  ];

  for (const testCase of cases) {
    it(`is structurally valid for ${testCase.lat},${testCase.lon} ${testCase.date}`, () => {
      const day = sky(testCase.lat, testCase.lon, testCase.date);
      assert.equal(day.v, SKY_VERSION);
      assert.equal(day.date, testCase.date);
      assert.equal(day.tz, testCase.tz);
      assert.equal(day.lat, testCase.lat);
      assert.equal(day.lon, testCase.lon);
      assert.equal(day.track.stepMinutes, SKY_STEP_MINUTES);
      assert.equal(EXPECTED_SAMPLE_COUNT, 289);
      assert.equal(day.track.sun.length, 289);
      assert.equal(day.track.moon.length, 289);

      for (const body of ['sun', 'moon'] as const) {
        for (const [altitude, azimuth] of day.track[body]) {
          assert.ok(Number.isFinite(altitude) && altitude >= -90 && altitude <= 90);
          assert.ok(Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360);
        }
      }

      assert.ok(Number.isInteger(day.utcOffsetMinutes));
      assert.ok(day.utcOffsetMinutes >= -12 * 60 && day.utcOffsetMinutes <= 14 * 60);
      assert.equal(day.dayStartUtc, localMinutesToUtc(testCase.date, MIN_MINUTE, testCase.tz).toISOString());
      assert.equal(day.dayEndUtc, localMinutesToUtc(testCase.date, MAX_MINUTE, testCase.tz).toISOString());
      assert.equal(Date.parse(day.dayEndUtc) - Date.parse(day.dayStartUtc), testCase.daylightMs);

      for (const [label, iso] of [
        ['sun.rise', day.sun.rise],
        ['sun.set', day.sun.set],
        ['sun.civilDawn', day.sun.civilDawn],
        ['sun.civilDusk', day.sun.civilDusk],
        ['sun.solarNoon', day.sun.solarNoon],
        ['moon.rise', day.moon.rise],
        ['moon.set', day.moon.set],
        ['goldenHourMorning start', day.sun.goldenHourMorning?.[0] ?? null],
        ['goldenHourMorning end', day.sun.goldenHourMorning?.[1] ?? null],
        ['goldenHourEvening start', day.sun.goldenHourEvening?.[0] ?? null],
        ['goldenHourEvening end', day.sun.goldenHourEvening?.[1] ?? null]
      ] as const) {
        assertInsideDay(iso, day, label);
      }

      assert.equal(typeof day.sun.solarNoon, 'string');
      const trackMax = Math.max(...day.track.sun.map(([altitude]) => altitude));
      assert.ok(Math.abs(day.sun.maxAltitudeDeg - trackMax) <= 1e-9);
      assert.ok(!(day.polarDay && day.polarNight));
      if (day.polarDay || day.polarNight) {
        assert.equal(day.sun.rise, null);
        assert.equal(day.sun.set, null);
      }
      assert.ok(day.moon.phaseAngleDeg >= 0 && day.moon.phaseAngleDeg <= 360);
      assert.ok(day.moon.illumination >= 0 && day.moon.illumination <= 1);
      assert.ok(PHASE_NAMES.has(day.moon.phaseName), day.moon.phaseName);
    });
  }

  it('is deterministic', () => {
    const first = computeSkyDay(BRASOV.lat, BRASOV.lon, '2026-06-21');
    const second = computeSkyDay(BRASOV.lat, BRASOV.lon, '2026-06-21');
    assert.deepEqual(first, second);
  });

  it('supports the extreme supported dates', () => {
    for (const date of ['1900-01-01', '2100-12-31']) {
      const day = sky(BRASOV.lat, BRASOV.lon, date);
      assert.equal(day.date, date);
      assert.equal(day.track.sun.length, 289);
      assert.equal(day.track.moon.length, 289);
      assert.ok(day.sun.solarNoon !== null);
      assert.ok(Number.isFinite(Date.parse(day.sun.solarNoon)));
    }
    // Historical local mean time for Bucharest is +01:44:24, rounded to minutes.
    assert.equal(sky(BRASOV.lat, BRASOV.lon, '1900-01-01').utcOffsetMinutes, 104);
  });

  it('rejects invalid coordinates and dates with RangeError', () => {
    assert.throws(() => computeSkyDay(91, 0, '2026-06-21'), RangeError);
    assert.throws(() => computeSkyDay(0, 181, '2026-06-21'), RangeError);
    assert.throws(() => computeSkyDay(Number.NaN, 0, '2026-06-21'), RangeError);
    assert.throws(() => computeSkyDay(BRASOV.lat, BRASOV.lon, '2026-02-30'), RangeError);
    assert.throws(() => computeSkyDay(BRASOV.lat, BRASOV.lon, '1899-12-31'), RangeError);
  });
});

/* ------------------------------------------------------------------ */
/* Moon phase names                                                    */
/* ------------------------------------------------------------------ */

describe('moon phase names', () => {
  const cases: Array<{ date: string; name: string }> = [
    { date: '2026-01-03', name: 'Full moon' }, // full moon 2026-01-03 10:03Z
    { date: '2026-03-11', name: 'Last quarter' }, // last quarter 2026-03-11 09:39Z
    { date: '2026-03-22', name: 'Waxing crescent' },
    { date: '2026-03-29', name: 'Waxing gibbous' },
    { date: '2026-06-15', name: 'New moon' }, // new moon 2026-06-15 02:54Z
    { date: '2026-06-21', name: 'Waxing crescent' },
    { date: '2026-06-29', name: 'Full moon' }, // full moon 2026-06-29 23:57Z
    { date: '2026-07-04', name: 'Waning gibbous' },
    { date: '2026-07-09', name: 'Waning crescent' },
    { date: '2026-11-09', name: 'New moon' }, // new moon 2026-11-09 07:02Z
    { date: '2026-11-17', name: 'First quarter' } // first quarter 2026-11-17 11:48Z
  ];

  for (const testCase of cases) {
    it(`labels ${testCase.date} as "${testCase.name}"`, () => {
      const day = sky(BRASOV.lat, BRASOV.lon, testCase.date);
      assert.equal(day.moon.phaseName, testCase.name);
      assert.ok(day.moon.phaseAngleDeg >= 0 && day.moon.phaseAngleDeg <= 360);
      assert.ok(day.moon.illumination >= 0 && day.moon.illumination <= 1);
      if (testCase.name === 'Waxing crescent' || testCase.name === 'Waning crescent') {
        assert.ok(day.moon.illumination < 0.5, `crescent must be < 50% lit: ${day.moon.illumination}`);
      }
      if (testCase.name === 'Waxing gibbous' || testCase.name === 'Waning gibbous') {
        assert.ok(day.moon.illumination > 0.5, `gibbous must be > 50% lit: ${day.moon.illumination}`);
      }
    });
  }

  it('advances the phase angle through a lunation', () => {
    let previous = -1;
    for (const date of [
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21'
    ]) {
      const angle = sky(BRASOV.lat, BRASOV.lon, date).moon.phaseAngleDeg;
      if (previous >= 0) {
        const delta = angle - previous;
        assert.ok(delta > 10 && delta < 15, `phase advance on ${date}: ${delta}`);
      }
      previous = angle;
    }
  });
});
