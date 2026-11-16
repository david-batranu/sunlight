/**
 * Sun/moon ephemeris payload for one city-local calendar day.
 *
 * The payload is a pure function of (lat, lon, date): the timezone is resolved
 * from the coordinates with `tz-lookup`, all instants are derived from the local
 * wall clock (DST gaps/overlaps handled by `./time.ts`) and the positions come
 * from `astronomy-engine`.
 *
 * Conventions:
 * - 289 samples at 5 local minutes, local 00:00 .. 24:00 inclusive.
 * - Sun/moon positions use a sea-level `Observer`, `Equator` with the
 *   equinox-of-date and aberration corrections, and `Horizon('normal')`
 *   (standard atmospheric refraction), matching the reference payloads.
 * - Azimuth is degrees clockwise from true north (0 = N, 90 = E).
 * - Almanac events are searched from the start of the local day and discarded
 *   when they fall outside it; events that do not occur are `null` (polar day /
 *   polar night, moon up all day, ...).
 * - Solar noon is refined with a parabolic fit through the three samples around
 *   the highest sampled sun altitude, so it is accurate to a few seconds rather
 *   than to the 5-minute sampling grid. `maxAltitudeDeg` remains the maximum of
 *   the rounded track samples.
 * - Moon phase is evaluated at local noon; the phase name uses narrow windows
 *   around the cardinal phases so that the illuminated-fraction split between
 *   crescent (< 50%) and gibbous (> 50%) is preserved.
 *
 * Nothing is cached: the result depends only on the arguments.
 */

import {
  Body,
  Equator,
  Horizon,
  Illumination,
  MoonPhase,
  Observer,
  SearchAltitude,
  SearchRiseSet,
  type AstroTime
} from 'astronomy-engine';
import tzlookup from 'tz-lookup';
import type { SkyDay, SkyTrack } from '../../shared/types.ts';
import {
  DATE_MAX,
  DATE_MIN,
  MAX_MINUTE,
  MIN_MINUTE,
  SKY_STEP_MINUTES,
  SKY_VERSION
} from '../../shared/constants.ts';
import { localMinutesToUtc, utcOffsetMinutes } from './time.ts';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Observer elevation: the reference payloads use sea level. */
const OBSERVER_HEIGHT_M = 0;

/** Refraction model for both track samples and event searches. */
const REFRACTION = 'normal';

/**
 * Apparent altitude of the sun's centre at the visual horizon: 0.8333° of
 * standard refraction plus the solar semi-diameter. `SearchRiseSet` uses the
 * same definition, so the polar-day/night classification is consistent with
 * the sunrise/sunset searches.
 */
const SUNSET_ALTITUDE_DEG = -0.8333;

/** Local minute used for the moon-phase snapshot. */
const NOON_MINUTE = 12 * 60;

/** Decimal places used by the wire track samples. */
const TRACK_DECIMALS = 2;

/** Decimal places for the max altitude / phase angle / illumination scalars. */
const ALTITUDE_DECIMALS = 2;
const PHASE_ANGLE_DECIMALS = 2;
const ILLUMINATION_DECIMALS = 3;

/** Phase-angle windows (degrees) that are named after a cardinal phase. */
const NEW_MOON_WINDOW_DEG = 8;
const QUARTER_MOON_WINDOW_DEG = 5;
const FULL_MOON_WINDOW_DEG = 8;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface DayWindow {
  /** UTC instant of local 00:00. */
  startMs: number;
  /** UTC instant of local 24:00, exclusive end of the local day. */
  endMs: number;
  /** Length of the local day in days (23/24/25, or 23.5/24.5 for half-hour DST shifts). */
  spanDays: number;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function normalizeAzimuth(azimuth: number): number {
  const wrapped = normalizeDegrees(roundTo(azimuth, TRACK_DECIMALS));
  return wrapped >= 360 ? 0 : wrapped;
}

function assertCoordinates(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`Latitude must be a finite number in [-90, 90]; received ${String(lat)}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`Longitude must be a finite number in [-180, 180]; received ${String(lon)}`);
  }
}

/** Resolves the IANA timezone of a coordinate with `tz-lookup`. */
export function resolveTimezone(lat: number, lon: number): string {
  assertCoordinates(lat, lon);
  try {
    const tz = tzlookup(lat, lon);
    if (typeof tz === 'string' && tz.length > 0) return tz;
  } catch {
    // tz-lookup throws for coordinates outside its table; fall through.
  }
  throw new RangeError(`Unable to resolve an IANA time zone for coordinates (${lat}, ${lon})`);
}

/**
 * Throws a `RangeError` when `date` is not a real `YYYY-MM-DD` calendar date
 * inside the supported range (`DATE_MIN`..`DATE_MAX`).
 */
export function validateLocalDate(date: string): void {
  const value = typeof date === 'string' ? date.trim() : '';
  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    throw new RangeError(`Invalid local date ${JSON.stringify(date)}; expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date ${JSON.stringify(value)}`);
  }
  if (value < DATE_MIN || value > DATE_MAX) {
    throw new RangeError(`Local date ${value} is outside the supported range ${DATE_MIN}..${DATE_MAX}`);
  }
}

/** Sun or moon position as [altitudeDeg, azimuthDeg] in horizon coordinates. */
function skyPosition(body: Body, instant: Date, observer: Observer): [number, number] {
  const equator = Equator(body, instant, observer, true, true);
  const horizon = Horizon(instant, observer, equator.ra, equator.dec, REFRACTION);
  return [horizon.altitude, normalizeDegrees(horizon.azimuth)];
}

/** Handles a search result: ISO string when inside the local day, else null. */
function isoIfWithinDay(event: AstroTime | null, window: DayWindow): string | null {
  if (event === null) return null;
  const ms = event.date.getTime();
  if (!Number.isFinite(ms) || ms < window.startMs || ms > window.endMs) return null;
  return event.date.toISOString();
}

function searchRiseSetWithinDay(
  body: Body,
  observer: Observer,
  direction: 1 | -1,
  window: DayWindow
): string | null {
  const event = SearchRiseSet(body, observer, direction, new Date(window.startMs), window.spanDays);
  return isoIfWithinDay(event, window);
}

function searchAltitudeWithinDay(
  body: Body,
  observer: Observer,
  direction: 1 | -1,
  window: DayWindow,
  altitudeDeg: number
): string | null {
  const event = SearchAltitude(
    body,
    observer,
    direction,
    new Date(window.startMs),
    window.spanDays,
    altitudeDeg
  );
  return isoIfWithinDay(event, window);
}

function orderedPair(start: string | null, end: string | null): [string, string] | null {
  if (start === null || end === null) return null;
  if (Date.parse(start) > Date.parse(end)) return null;
  return [start, end];
}

/**
 * Refines solar noon from the three track samples around the highest sun.
 * Fits a parabola through the sampled altitudes and returns its vertex instant.
 */
function refineSolarNoon(
  date: string,
  tz: string,
  sampleMinutes: readonly number[],
  sunAltitudes: readonly number[],
  maxIndex: number
): Date {
  const middleMinute = sampleMinutes[maxIndex] ?? MIN_MINUTE;
  const middleMs = localMinutesToUtc(date, middleMinute, tz).getTime();
  if (maxIndex <= 0 || maxIndex >= sunAltitudes.length - 1) {
    return new Date(middleMs);
  }
  const previous = sunAltitudes[maxIndex - 1];
  const middle = sunAltitudes[maxIndex];
  const next = sunAltitudes[maxIndex + 1];
  const curvature = previous - 2 * middle + next;
  if (!Number.isFinite(curvature) || curvature >= 0) {
    return new Date(middleMs);
  }
  const offsetSamples = (0.5 * (previous - next)) / curvature;
  if (!Number.isFinite(offsetSamples)) {
    return new Date(middleMs);
  }
  const clamped = Math.max(-1, Math.min(1, offsetSamples));
  return new Date(middleMs + clamped * SKY_STEP_MINUTES * MS_PER_MINUTE);
}

/**
 * Human readable phase name for a 0..360 phase angle
 * (0 = new, 90 = first quarter, 180 = full, 270 = last quarter).
 * Cardinal phases use narrow windows; everything else follows the illuminated
 * fraction: below 50% is a crescent, above 50% is gibbous.
 */
function moonPhaseName(phaseAngleDeg: number): string {
  const angle = normalizeDegrees(phaseAngleDeg);
  if (angle <= NEW_MOON_WINDOW_DEG || angle >= 360 - NEW_MOON_WINDOW_DEG) return 'New moon';
  if (Math.abs(angle - 90) <= QUARTER_MOON_WINDOW_DEG) return 'First quarter';
  if (Math.abs(angle - 180) <= FULL_MOON_WINDOW_DEG) return 'Full moon';
  if (Math.abs(angle - 270) <= QUARTER_MOON_WINDOW_DEG) return 'Last quarter';
  if (angle < 90) return 'Waxing crescent';
  if (angle < 180) return 'Waxing gibbous';
  if (angle < 270) return 'Waning gibbous';
  return 'Waning crescent';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Computes the complete sky payload for a city-local calendar day.
 *
 * @throws RangeError when the coordinates or the date are invalid, or when the
 * timezone cannot be resolved.
 */
export function computeSkyDay(lat: number, lon: number, date: string): SkyDay {
  assertCoordinates(lat, lon);
  validateLocalDate(date);
  const localDate = date.trim();
  const tz = resolveTimezone(lat, lon);
  const observer = new Observer(lat, lon, OBSERVER_HEIGHT_M);

  const dayStart = localMinutesToUtc(localDate, MIN_MINUTE, tz);
  const dayEnd = localMinutesToUtc(localDate, MAX_MINUTE, tz);
  const window: DayWindow = {
    startMs: dayStart.getTime(),
    endMs: dayEnd.getTime(),
    spanDays: (dayEnd.getTime() - dayStart.getTime()) / MS_PER_DAY
  };

  // Sampling grid: local 00:00, 00:05, ... 24:00 (289 samples for the
  // configured 5-minute step). The 24:00 sample is the following local
  // midnight instant, so it closes the day rather than duplicating 00:00.
  const sampleMinutes: number[] = [];
  for (let minute = MIN_MINUTE; minute < MAX_MINUTE; minute += SKY_STEP_MINUTES) {
    sampleMinutes.push(minute);
  }
  sampleMinutes.push(MAX_MINUTE);

  const sunTrack: Array<[number, number]> = [];
  const moonTrack: Array<[number, number]> = [];
  const sunAltitudes: number[] = [];
  let maxSunAltitude = -Infinity;
  let maxSunIndex = 0;

  for (let index = 0; index < sampleMinutes.length; index += 1) {
    const minute = sampleMinutes[index];
    const instant = localMinutesToUtc(localDate, minute, tz);
    const [sunAltitude, sunAzimuth] = skyPosition(Body.Sun, instant, observer);
    const [moonAltitude, moonAzimuth] = skyPosition(Body.Moon, instant, observer);

    sunAltitudes.push(sunAltitude);
    sunTrack.push([roundTo(sunAltitude, TRACK_DECIMALS), normalizeAzimuth(sunAzimuth)]);
    moonTrack.push([roundTo(moonAltitude, TRACK_DECIMALS), normalizeAzimuth(moonAzimuth)]);

    if (sunAltitude > maxSunAltitude) {
      maxSunAltitude = sunAltitude;
      maxSunIndex = index;
    }
  }

  let minSunAltitude = Infinity;
  for (const altitude of sunAltitudes) {
    if (altitude < minSunAltitude) minSunAltitude = altitude;
  }

  const sunRise = searchRiseSetWithinDay(Body.Sun, observer, +1, window);
  const sunSet = searchRiseSetWithinDay(Body.Sun, observer, -1, window);
  const civilDawn = searchAltitudeWithinDay(Body.Sun, observer, +1, window, -6);
  const civilDusk = searchAltitudeWithinDay(Body.Sun, observer, -1, window, -6);
  const goldenMorningStart = searchAltitudeWithinDay(Body.Sun, observer, +1, window, -4);
  const goldenMorningEnd = searchAltitudeWithinDay(Body.Sun, observer, +1, window, 6);
  const goldenEveningStart = searchAltitudeWithinDay(Body.Sun, observer, -1, window, 6);
  const goldenEveningEnd = searchAltitudeWithinDay(Body.Sun, observer, -1, window, -4);

  const moonRise = searchRiseSetWithinDay(Body.Moon, observer, +1, window);
  const moonSet = searchRiseSetWithinDay(Body.Moon, observer, -1, window);

  // A local day without a sunrise and a sunset is either polar day or polar
  // night; the sampled sun altitude decides which side of the horizon it stays.
  const noSunEvents = sunRise === null && sunSet === null;
  const polarDay = noSunEvents && minSunAltitude > SUNSET_ALTITUDE_DEG;
  const polarNight = noSunEvents && maxSunAltitude < SUNSET_ALTITUDE_DEG;

  const localNoon = localMinutesToUtc(localDate, NOON_MINUTE, tz);
  const phaseAngle = normalizeDegrees(MoonPhase(localNoon));
  const illumination = Illumination(Body.Moon, localNoon).phase_fraction;

  const solarNoon = refineSolarNoon(localDate, tz, sampleMinutes, sunAltitudes, maxSunIndex);
  const track: SkyTrack = {
    stepMinutes: SKY_STEP_MINUTES,
    sun: sunTrack,
    moon: moonTrack
  };

  return {
    v: SKY_VERSION,
    date: localDate,
    tz,
    lat,
    lon,
    utcOffsetMinutes: utcOffsetMinutes(tz, localNoon),
    dayStartUtc: dayStart.toISOString(),
    dayEndUtc: dayEnd.toISOString(),
    track,
    sun: {
      rise: sunRise,
      set: sunSet,
      civilDawn,
      civilDusk,
      solarNoon: solarNoon.toISOString(),
      maxAltitudeDeg: roundTo(maxSunAltitude, ALTITUDE_DECIMALS),
      goldenHourMorning: orderedPair(goldenMorningStart, goldenMorningEnd),
      goldenHourEvening: orderedPair(goldenEveningStart, goldenEveningEnd)
    },
    moon: {
      rise: moonRise,
      set: moonSet,
      phaseAngleDeg: roundTo(phaseAngle, PHASE_ANGLE_DECIMALS),
      illumination: roundTo(clamp01(illumination), ILLUMINATION_DECIMALS),
      phaseName: moonPhaseName(phaseAngle)
    },
    polarDay,
    polarNight
  };
}
