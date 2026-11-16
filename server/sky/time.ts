/**
 * Local wall-clock <-> UTC conversion helpers for the sky/ephemeris module.
 *
 * Timezone rules come from the ICU/`Intl` database, so no timezone data is
 * bundled and historical/legislated changes are honoured. The two ambiguous
 * DST cases are resolved deterministically:
 *
 * - Gap (spring forward): a wall-clock minute that does not exist is shifted
 *   forward by the size of the gap. For a `02:00 -> 03:00` transition, the
 *   non-existent `02:30` resolves to the instant the clock jumped to, i.e. the
 *   instant that reads `03:30` afterwards.
 * - Overlap (fall back): a wall-clock minute that occurs twice resolves to its
 *   first occurrence, while daylight saving time is still in effect.
 *
 * Every function here is pure: results depend only on the arguments, nothing is
 * cached and no argument is mutated. That keeps `computeSkyDay` reproducible
 * for tests and for the pre-baked fixture payloads.
 */

import { DATE_MAX, DATE_MIN, MAX_MINUTE, MIN_MINUTE } from '../../shared/constants.ts';

const MS_PER_MINUTE = 60_000;

/**
 * Probe distance used to sample the UTC offset on both sides of a possible
 * transition. Larger than the sum of the largest wall-clock offset (+14h) and
 * the largest DST shift (2h), so both candidate offsets are always observed.
 */
const OFFSET_PROBE_MS = 26 * 60 * MS_PER_MINUTE;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formatter used to read the wall-clock time of an instant in a timezone. */
function timeZoneFormatter(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch {
    throw new RangeError(`Unknown or invalid IANA time zone: ${JSON.stringify(tz)}`);
  }
}

/** Wall-clock reading in `tz` at `instant`, encoded as if it were UTC. */
function wallClockMs(tz: string, instant: Date): number {
  const parts = timeZoneFormatter(tz).formatToParts(instant);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  // Some ICU versions render midnight as hour 24; keep it in [0, 24).
  return Date.UTC(year, month - 1, day, hour % 24, minute, second);
}

/**
 * UTC offset of `tz` at an instant, in milliseconds. Computed as
 * (wall-clock reading) - (UTC instant) at whole-second precision.
 */
function offsetMsAt(tz: string, instantMs: number): number {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return wallClockMs(tz, new Date(wholeSecond)) - wholeSecond;
}

/** Converts a validated `YYYY-MM-DD` string into a UTC-midnight timestamp. */
function localWallClockMs(date: string): number {
  const value = typeof date === 'string' ? date.trim() : '';
  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    throw new RangeError(`Invalid local date ${JSON.stringify(date)}; expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const wallMs = Date.UTC(year, month - 1, day);
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date ${JSON.stringify(value)}`);
  }
  if (value < DATE_MIN || value > DATE_MAX) {
    throw new RangeError(
      `Local date ${value} is outside the supported range ${DATE_MIN}..${DATE_MAX}`
    );
  }
  return wallMs;
}

function assertMinute(minute: number): void {
  if (!Number.isInteger(minute) || minute < MIN_MINUTE || minute > MAX_MINUTE) {
    throw new RangeError(
      `Local minute must be an integer between ${MIN_MINUTE} and ${MAX_MINUTE}; received ${String(minute)}`
    );
  }
}

function assertInstant(instant: Date): number {
  const ms = instant instanceof Date ? instant.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new RangeError('Invalid Date instant');
  }
  return ms;
}

/**
 * UTC instant of a local wall-clock minute on a local calendar date.
 *
 * `minute` is a minute of the local day in `[0, 1440]`; `1440` (24:00) maps to
 * the following local midnight and is used for the open end of the day.
 * DST gaps/overlaps follow the deterministic policy in the module comment.
 */
export function localMinutesToUtc(date: string, minute: number, tz: string): Date {
  assertMinute(minute);
  const wallMs = localWallClockMs(date) + minute * MS_PER_MINUTE;
  const offsets = new Set<number>([
    offsetMsAt(tz, wallMs - OFFSET_PROBE_MS),
    offsetMsAt(tz, wallMs + OFFSET_PROBE_MS)
  ]);

  const matches: number[] = [];
  for (const offset of offsets) {
    const instantMs = wallMs - offset;
    if (offsetMsAt(tz, instantMs) === offset) matches.push(instantMs);
  }
  if (matches.length > 0) {
    // Ambiguous wall clock (fall-back overlap): the earlier instant is the
    // first occurrence, while daylight saving time is still in effect.
    return new Date(Math.min(...matches));
  }

  // Missing wall clock (spring-forward gap): no instant matches. Choosing the
  // latest candidate instant shifts the minute forward by the size of the gap.
  let latest = -Infinity;
  for (const offset of offsets) {
    latest = Math.max(latest, wallMs - offset);
  }
  return new Date(latest);
}

/** UTC offset of an IANA timezone at a given instant, in whole minutes. */
export function utcOffsetMinutes(tz: string, instant: Date): number {
  return Math.round(offsetMsAt(tz, assertInstant(instant)) / MS_PER_MINUTE);
}

/** Today's local calendar date (`YYYY-MM-DD`) in an IANA timezone. */
export function todayInTimezone(tz: string, now: Date = new Date()): string {
  const instantMs = assertInstant(now);
  const wallMs = wallClockMs(tz, new Date(Math.floor(instantMs / 1000) * 1000));
  const wall = new Date(wallMs);
  const year = String(wall.getUTCFullYear()).padStart(4, '0');
  const month = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const day = String(wall.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
