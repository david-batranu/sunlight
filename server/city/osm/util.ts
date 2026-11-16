/**
 * Safe extraction helpers shared by the OSM XML and Overpass JSON parsers.
 *
 * OSM data is external input: every attribute is treated as `unknown` and
 * validated before it reaches the pipeline.
 */

import type { OsmTags, RawCoord } from '../raw.ts';

const FORBIDDEN_TAG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safeTags(value: unknown): OsmTags {
  const tags = Object.create(null) as OsmTags;
  if (!value || typeof value !== 'object') return tags;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || FORBIDDEN_TAG_KEYS.has(key)) continue;
    if (typeof raw === 'string') tags[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) tags[key] = String(raw);
  }
  return tags;
}

export function tagCount(tags: OsmTags): number {
  return Object.keys(tags).length;
}

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

export function parseOsmId(value: unknown): number | null {
  const number = parseFiniteNumber(value);
  if (number === null || !Number.isSafeInteger(number) || number <= 0) return null;
  return number;
}

export function parseCoord(value: unknown): RawCoord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { lat?: unknown; lon?: unknown };
  const lat = parseFiniteNumber(record.lat);
  const lon = parseFiniteNumber(record.lon);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Parses an Overpass inline `geometry` array (or a single member node). */
export function parseGeometryArray(value: unknown): RawCoord[] | null {
  if (!Array.isArray(value)) return null;
  const coords: RawCoord[] = [];
  for (const entry of value) {
    const coord = parseCoord(entry);
    if (!coord) return null;
    coords.push(coord);
  }
  return coords.length >= 2 ? coords : null;
}

export function parseNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const id = parseOsmId(entry);
    if (id !== null) out.push(id);
  }
  return out;
}
