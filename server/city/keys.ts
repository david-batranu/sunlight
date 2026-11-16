/**
 * Canonical model keys and strict validation.
 *
 * Key format (stable across releases, part of the public URL space):
 *
 *   city:  gn-<geonameId>-r<radiusM>-v<modelVersion>
 *   point: pt-<lat>-<lon>-r<radiusM>-v<modelVersion>
 *
 * Coordinates are rendered with five decimals and a leading minus sign for the
 * southern/western hemisphere (e.g. `pt--33.92490_-70.64030-r900-v1`); readers
 * never parse keys, they are only used as opaque cache/URL identifiers, so the
 * double dash is harmless.
 */

import type { ModelTarget } from '../../shared/types.ts';
import { CityError } from './errors.ts';

/** Model keys are used in URLs and file names, so keep them to a safe alphabet. */
const KEY_CHARSET = /^[A-Za-z0-9._-]+$/;
const KEY_PATTERN = /^(?:gn-[1-9]\d{0,11}|pt--?\d{1,3}\.\d{5}_-?\d{1,3}\.\d{5})-r[1-9]\d{2,3}-v[1-9]\d{0,4}$/;

const MAX_KEY_LENGTH = 96;

function normalizeNegativeZero(value: string): string {
  return /^-0(?:\.0+)?$/.test(value) ? value.slice(1) : value;
}

/** Renders a coordinate with a fixed number of decimals (locale independent). */
export function formatCoordinate(value: number, digits = 5): string {
  if (!Number.isFinite(value)) {
    throw new CityError('INVALID_TARGET', 'Coordinates must be finite numbers.', 400);
  }
  return normalizeNegativeZero(value.toFixed(digits));
}

export function cityModelKey(geonameId: number, radiusM: number, modelVersion: number): string {
  if (!Number.isSafeInteger(geonameId) || geonameId <= 0) {
    throw new CityError('INVALID_TARGET', 'A positive integer GeoNames id is required.', 400);
  }
  return `gn-${geonameId}-r${normalizeRadius(radiusM)}-v${normalizeVersion(modelVersion)}`;
}

export function pointModelKey(lat: number, lon: number, radiusM: number, modelVersion: number): string {
  return `pt-${formatCoordinate(lat)}_${formatCoordinate(lon)}-r${normalizeRadius(radiusM)}-v${normalizeVersion(
    modelVersion
  )}`;
}

export function modelKeyForTarget(target: ModelTarget, radiusM: number, modelVersion: number): string {
  if (target.kind === 'city') return cityModelKey(target.geonameId, radiusM, modelVersion);
  return pointModelKey(target.lat, target.lon, radiusM, modelVersion);
}

export function isValidModelKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    KEY_CHARSET.test(key) &&
    KEY_PATTERN.test(key)
  );
}

/** Validates a key and throws a 400 `CityError` when it cannot be a model key. */
export function assertValidModelKey(key: string): string {
  if (!isValidModelKey(key)) {
    throw new CityError('INVALID_KEY', 'The model key is not valid.', 400);
  }
  return key;
}

function normalizeRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new CityError('INVALID_TARGET', 'The city radius must be a positive number.', 400);
  }
  return Math.round(radiusM);
}

function normalizeVersion(modelVersion: number): number {
  if (!Number.isSafeInteger(modelVersion) || modelVersion < 1) {
    throw new CityError('INVALID_TARGET', 'The model version must be a positive integer.', 400);
  }
  return modelVersion;
}
