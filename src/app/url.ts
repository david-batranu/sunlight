/**
 * URL deep-link state. The lead owns this file.
 *
 *   ?city=gn:683844&date=2026-06-21&time=13:30
 *   ?point=45.64861,25.60613&name=My%20place&date=...&time=...
 *
 * Seed cities are addressed as `city=gn:<geonameId>`; `seed:<slug>` is accepted
 * as a convenience alias.
 */

import type { ModelTarget } from '../../shared/types.ts';
import { DATE_MAX, DATE_MIN, SEED_BY_GEONAME_ID, SEED_BY_SLUG } from '../../shared/constants.ts';
import { clampDate, formatMinuteOfDay, isValidDateString, parseMinuteOfDay } from './time.ts';

export interface UrlState {
  target: ModelTarget | null;
  date: string | null;
  minute: number | null;
}

function parseCityParam(value: string | null): ModelTarget | null {
  if (!value) return null;
  if (value.startsWith('gn:')) {
    const id = Number(value.slice(3));
    if (Number.isFinite(id) && id > 0 && SEED_BY_GEONAME_ID.has(id)) {
      return { kind: 'city', geonameId: id };
    }
    // Any indexed city, not just seeds.
    if (Number.isFinite(id) && id > 0) return { kind: 'city', geonameId: Math.round(id) };
    return null;
  }
  if (value.startsWith('seed:')) {
    const seed = SEED_BY_SLUG.get(value.slice(5));
    return seed ? { kind: 'city', geonameId: seed.geonameId } : null;
  }
  return null;
}

function parsePointParam(point: string | null, name: string | null): ModelTarget | null {
  if (!point) return null;
  const [latS, lonS] = point.split(',');
  const lat = Number(latS);
  const lon = Number(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const cleaned = (name || '').trim().slice(0, 80);
  return cleaned ? { kind: 'point', lat, lon, name: cleaned } : { kind: 'point', lat, lon };
}

export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const target = parseCityParam(params.get('city')) ?? parsePointParam(params.get('point'), params.get('name'));
  const rawDate = params.get('date');
  const date = rawDate && isValidDateString(rawDate) ? clampDate(rawDate) : null;
  const rawTime = params.get('time');
  const minute = rawTime ? parseMinuteOfDay(rawTime) : null;
  return { target, date, minute };
}

export function buildUrl(
  target: ModelTarget | null,
  date: string,
  minute: number,
  base = window.location.pathname
): string {
  const params = new URLSearchParams();
  if (target) {
    if (target.kind === 'city') {
      params.set('city', `gn:${target.geonameId}`);
    } else {
      params.set('point', `${target.lat.toFixed(5)},${target.lon.toFixed(5)}`);
      if (target.name) params.set('name', target.name.slice(0, 80));
    }
  }
  if (isValidDateString(date) && date >= DATE_MIN && date <= DATE_MAX) params.set('date', date);
  params.set('time', formatMinuteOfDay(minute));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function replaceUrl(target: ModelTarget | null, date: string, minute: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.history.replaceState(null, '', buildUrl(target, date, minute));
  } catch {
    /* history may be unavailable in tests */
  }
}
