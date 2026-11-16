/**
 * Pure client-side time helpers: city-local dates, minute-of-day formatting,
 * and light interpolation from the server's 5-minute sky track. The lead owns
 * this file. No DOM and no fetch.
 */

import type { SkyDay } from '../../shared/types.ts';
import { DATE_MAX, DATE_MIN } from '../../shared/constants.ts';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateString(value: string): boolean {
  const match = DATE_RE.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function clampDate(value: string): string {
  if (!DATE_RE.test(value)) return DATE_MIN;
  if (value < DATE_MIN) return DATE_MIN;
  if (value > DATE_MAX) return DATE_MAX;
  return value;
}

/** Adds days to a YYYY-MM-DD string without timezone drift. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** Today's calendar date in a given IANA timezone. */
export function todayInTimezone(tz: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Current wall-clock minute-of-day in a given IANA timezone. */
export function minuteNowInTimezone(tz: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const hour = get('hour') % 24;
    return hour * 60 + get('minute');
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minute)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export function formatDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(utc);
  } catch {
    return date;
  }
}

export function formatDateShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    }).format(utc);
  } catch {
    return date;
  }
}

/** Formats an ISO instant as a city-local wall-clock time. */
export function formatInstant(iso: string | null | undefined, tz: string, withSeconds = false): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false
    }).format(date);
  } catch {
    return '—';
  }
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const abs = Math.abs(Math.round(offsetMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export interface InterpolatedLight {
  sunAlt: number;
  sunAz: number;
  moonAlt: number;
  moonAz: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a + 540) % 360) - 180;
  const value = (a + delta * t + 360) % 360;
  return value < 0 ? value + 360 : value;
}

/**
 * Interpolates the sun/moon track for a local wall-clock minute.
 * The track is sampled every `stepMinutes`, starting at local 00:00.
 */
export function interpolateSky(sky: SkyDay | null, minute: number): InterpolatedLight | null {
  if (!sky || !sky.track || sky.track.sun.length === 0) return null;
  const step = sky.track.stepMinutes || 5;
  const maxIndex = sky.track.sun.length - 1;
  const rawIndex = Math.max(0, Math.min(24 * 60, minute)) / step;
  const index = Math.min(maxIndex - 1, Math.floor(rawIndex));
  const fraction = Math.min(1, Math.max(0, rawIndex - index));
  const sunA = sky.track.sun[index];
  const sunB = sky.track.sun[Math.min(maxIndex, index + 1)];
  const moonA = sky.track.moon[index];
  const moonB = sky.track.moon[Math.min(maxIndex, index + 1)];
  if (!sunA || !sunB || !moonA || !moonB) return null;
  return {
    sunAlt: lerp(sunA[0], sunB[0], fraction),
    sunAz: lerpAngle(sunA[1], sunB[1], fraction),
    moonAlt: lerp(moonA[0], moonB[0], fraction),
    moonAz: lerpAngle(moonA[1], moonB[1], fraction)
  };
}

/** Multiplier for shadow length relative to object height. */
export function shadowMultiplier(altitudeDeg: number): number | null {
  if (altitudeDeg <= 0.5) return null;
  return 1 / Math.tan((altitudeDeg * Math.PI) / 180);
}

export function sunLightLabel(
  altitude: number,
  sun: SkyDay['sun'] | null
): string {
  if (altitude < -18) return 'Night';
  if (altitude < -12) return 'Astronomical twilight';
  if (altitude < -6) return 'Nautical twilight';
  if (altitude < -0.833) return 'Civil twilight';
  if (altitude < 6) {
    const evening = sun?.set != null;
    return evening ? 'Golden hour' : 'Golden light';
  }
  if (altitude < 20) return 'Low sun';
  return 'Daylight';
}

/** Which end of the day the current golden light is likely at. */
export function goldenSide(altitude: number, sky: SkyDay | null, minute: number): 'morning' | 'evening' | null {
  if (!sky || altitude < -6 || altitude > 6) return null;
  return minute < 12 * 60 ? 'morning' : 'evening';
}
