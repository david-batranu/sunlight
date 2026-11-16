/**
 * Pure display formatters and small geometry helpers for the UI.
 *
 * This module must stay free of DOM access so it can be unit-tested with
 * `node --test tests/unit/ui-*.test.ts`.
 */

import type { CitySource } from '../../shared/types.ts';
import { shadowMultiplier } from '../app/time.ts';

export type Mood = 'day' | 'golden' | 'twilight' | 'night';

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW'
] as const;

const MOOD_LABELS: Record<Mood, string> = {
  day: 'Daylight',
  golden: 'Golden hour',
  twilight: 'Twilight',
  night: 'Night'
};

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** 16-wind compass abbreviation, e.g. 135° → "SE". */
export function formatCompass(azimuthDeg: number): string {
  const index = Math.round(normalizeDegrees(azimuthDeg) / 22.5) % 16;
  return COMPASS_POINTS[index];
}

/** Thousands-grouped integer, e.g. 4812 → "4,812". */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** Compact population label using metric-style suffixes: 1.2 M, 315 k. */
export function formatPopulation(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)} M`;
  if (value >= 100_000) return `${Math.round(value / 1_000)} k`;
  if (value >= 10_000) return `${trimZero(value / 1_000)} k`;
  return formatCount(value);
}

/** Signed altitude in degrees, one decimal. */
export function formatAltitude(altitudeDeg: number): string {
  if (!Number.isFinite(altitudeDeg)) return '—';
  const rounded = round(altitudeDeg, 1);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}°`;
}

/** Azimuth in degrees plus compass point, e.g. "127° SE". */
export function formatAzimuth(azimuthDeg: number): string {
  if (!Number.isFinite(azimuthDeg)) return '—';
  const normalized = normalizeDegrees(azimuthDeg);
  return `${Math.round(normalized) % 360}° ${formatCompass(normalized)}`;
}

/** Shadow length relative to object height, or an em dash when the sun is down. */
export function formatShadowMultiplier(altitudeDeg: number): string {
  if (!Number.isFinite(altitudeDeg)) return '—';
  const multiplier = shadowMultiplier(altitudeDeg);
  if (multiplier === null || !Number.isFinite(multiplier)) return '—';
  if (multiplier > 99) return '>99 × height';
  if (multiplier >= 10) return `${Math.round(multiplier)} × height`;
  return `${multiplier.toFixed(1)} × height`;
}

export function formatIllumination(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** Human-readable moon phase name derived from the phase angle (0–360°). */
export function phaseNameForAngle(phaseAngleDeg: number): string {
  const angle = normalizeDegrees(phaseAngleDeg);
  if (angle < 22.5 || angle >= 337.5) return 'New moon';
  if (angle < 67.5) return 'Waxing crescent';
  if (angle < 112.5) return 'First quarter';
  if (angle < 157.5) return 'Waxing gibbous';
  if (angle < 202.5) return 'Full moon';
  if (angle < 247.5) return 'Waning gibbous';
  if (angle < 292.5) return 'Last quarter';
  return 'Waning crescent';
}

export interface MoonPhaseGeometry {
  /** SVG path for the illuminated part, or null on a new moon. */
  path: string | null;
  waxing: boolean;
  illumination: number;
}

/**
 * Builds an SVG path describing the illuminated part of the moon for a phase
 * angle: 0 = new, 90 = first quarter, 180 = full, 270 = last quarter.
 */
export function moonPhaseGeometry(
  phaseAngleDeg: number,
  radius = 10,
  cx = 0,
  cy = 0
): MoonPhaseGeometry {
  const angle = normalizeDegrees(phaseAngleDeg);
  const radians = (angle * Math.PI) / 180;
  const illumination = (1 - Math.cos(radians)) / 2;
  const waxing = Math.sin(radians) >= 0;
  const r = Math.max(0.1, radius);
  const top = round(cy - r, 2);
  const bottom = round(cy + r, 2);

  if (illumination <= 0.002) return { path: null, waxing, illumination: 0 };
  if (illumination >= 0.998) {
    const path =
      `M ${round(cx, 2)} ${top} ` +
      `A ${round(r, 2)} ${round(r, 2)} 0 1 1 ${round(cx, 2)} ${bottom} ` +
      `A ${round(r, 2)} ${round(r, 2)} 0 1 1 ${round(cx, 2)} ${top} Z`;
    return { path, waxing, illumination };
  }

  const rx = round(r * Math.abs(Math.cos(radians)), 2);
  const arc = round(r, 2);
  // The lit limb runs down the right edge while waxing, the left edge while waning.
  const outerSweep = waxing ? 1 : 0;
  // A crescent's terminator bulges toward the lit limb; a gibbous one away from it.
  const crescent = illumination < 0.5;
  const terminatorSweep = waxing ? (crescent ? 0 : 1) : crescent ? 1 : 0;
  const path =
    `M ${round(cx, 2)} ${top} ` +
    `A ${arc} ${arc} 0 0 ${outerSweep} ${round(cx, 2)} ${bottom} ` +
    `A ${rx} ${arc} 0 0 ${terminatorSweep} ${round(cx, 2)} ${top} Z`;
  return { path, waxing, illumination };
}

/**
 * Local wall-clock minute-of-day for an ISO instant in the given IANA timezone.
 * Returns null for invalid input.
 */
export function instantToLocalMinute(iso: string | null | undefined, tz: string): number | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(instant);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? NaN);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? NaN);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/** "45.6486° N, 25.6061° E" */
export function formatCoords(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

/** 1-based day of the year for a YYYY-MM-DD date. */
export function dayOfYear(date: string): number {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  const [year, month, day] = parts as [number, number, number];
  const utc = Date.UTC(year, month - 1, day);
  const start = Date.UTC(year, 0, 1);
  return Math.round((utc - start) / 86_400_000) + 1;
}

/** English country name for an ISO 3166-1 alpha-2 code, falling back to the code. */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  const upper = code.trim().toUpperCase().slice(0, 2);
  if (upper.length !== 2) return code;
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    const name = display.of(upper);
    return !name || name === 'Unknown Region' ? upper : name;
  } catch {
    return upper;
  }
}

/** Short label for the model data source. */
export function sourceLabel(source: CitySource): string {
  switch (source) {
    case 'overpass':
      return 'OpenStreetMap · live';
    case 'osm-api':
      return 'OpenStreetMap · tiled';
    case 'seed':
      return 'Pre-baked seed';
    case 'fixture':
      return 'Fixture data';
    case 'cache':
      return 'Cached model';
    default:
      return 'Unknown source';
  }
}

export function moodLabel(mood: Mood): string {
  return MOOD_LABELS[mood];
}

/** Metric speed label for the playback select: 5 → "5 min/s". */
export function formatSpeed(minutesPerSecond: number): string {
  if (!Number.isFinite(minutesPerSecond)) return '—';
  const rounded = Math.round(minutesPerSecond * 10) / 10;
  return `${rounded} min/s`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
