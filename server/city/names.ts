/**
 * Human-readable names and kind labels for model features.
 *
 * OSM `name` tags are free-form text from a public wiki-tagged database, so
 * everything is sanitized before it reaches the wire model: control characters
 * are stripped, whitespace collapsed, length capped and empty values dropped.
 * Labels are derived deterministically from tags (never localized) so model
 * bytes stay reproducible for the same input + model version.
 */

import type { BuildingType } from '../../shared/types.ts';
import type { OsmTags } from './raw.ts';

/** Maximum length of any persisted name/label, in characters. */
export const MAX_NAME_LENGTH = 80;

/** Maximum number of landmark building names persisted per city. */
export const MAX_NAMED_BUILDINGS = 1200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;
const KIND_SEPARATOR = /[_\-\s]+/g;

/** Tag values that carry no useful kind information. */
const GENERIC_KINDS = new Set(['', 'yes', 'no', 'true', 'false', 'building', 'other', 'unknown', 'unclassified']);

/** Sanitizes a free-form display name; returns `null` when unusable. */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const truncated = cleaned.slice(0, MAX_NAME_LENGTH).trim();
  return truncated.length > 0 ? truncated : null;
}

/** OSM name with the `name:en` fallback; empty/invalid names are ignored. */
export function osmName(tags: OsmTags): string | null {
  return sanitizeName(tags.name) ?? sanitizeName(tags['name:en']);
}

/** Title-cases a raw tag value, e.g. `place_of_worship` → `Place of Worship`. */
export function sanitizeKind(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(CONTROL_CHARS, ' ')
    .replace(KIND_SEPARATOR, ' ')
    .trim()
    .toLowerCase();
  if (!normalized || GENERIC_KINDS.has(normalized)) return null;
  const words = normalized.split(' ').filter(Boolean).slice(0, 4);
  if (words.length === 0) return null;
  const label = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return label.length > 40 ? label.slice(0, 40).trim() : label;
}

/**
 * Short human label for a building, preferring the most specific tag:
 * tourism → historic → amenity → building type. Generic values are omitted.
 */
export function shortKindLabel(tags: OsmTags): string | null {
  return (
    sanitizeKind(tags.tourism) ??
    sanitizeKind(tags.historic) ??
    sanitizeKind(tags.amenity) ??
    sanitizeKind(tags.building)
  );
}

/**
 * Whether a named building is a landmark worth persisting a tooltip for.
 *
 * Names are emitted only for buildings that are interesting to a visitor:
 * tagged with a POI kind (tourism/historic/amenity/shop/office/leisure), tall
 * enough to shape the skyline (>= 25 m), or classified as civic.
 */
export function isNamedLandmark(tags: OsmTags, type: BuildingType, heightM: number): boolean {
  if (!osmName(tags)) return false;
  if (tags.tourism || tags.historic || tags.amenity || tags.shop || tags.office || tags.leisure) return true;
  if (heightM >= 25) return true;
  if (type === 2) return true;
  return false;
}
