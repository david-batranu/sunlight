/**
 * Model serialization, gzip + ETag helpers, and structural validation of
 * persisted models.
 *
 * Determinism: the model JSON is produced by `JSON.stringify` over objects
 * whose key order is fixed by the builder, and gzip is called with a fixed
 * level, so the same `CityModel` always serializes to the same bytes.
 */

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import type { CityInfo, CityModel, ModelMeta, ModelTarget } from '../../shared/types.ts';
import { CityError } from './errors.ts';
import { MAX_NAME_LENGTH } from './names.ts';

const gzipAsync = promisify(gzipCallback);
const gunzipAsync = promisify(gunzipCallback);

/**
 * Model gzip level. Level 6 is ~2.5x faster than level 9 for ~1% more bytes on
 * representative city models; generation CPU time matters more than a few KiB.
 */
export const MODEL_GZIP_LEVEL = 6;

export function serializeModel(model: CityModel): Buffer {
  return Buffer.from(JSON.stringify(model), 'utf8');
}

export async function gzipModel(model: CityModel): Promise<Buffer> {
  try {
    return await gzipAsync(serializeModel(model), { level: MODEL_GZIP_LEVEL });
  } catch (error) {
    throw new CityError(
      'CACHE_FAILED',
      `Could not gzip the model: ${error instanceof Error ? error.message : String(error)}`,
      500,
      false
    );
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Strong ETag: quoted lowercase SHA-256 hex. */
export function quotedEtag(sha256: string): string {
  return `"${sha256}"`;
}

export function modelEtag(gzipped: Buffer): string {
  return quotedEtag(sha256Hex(gzipped));
}

/** Strips quotes from an ETag, returning the hex digest (or the input). */
export function etagDigest(etag: string): string {
  const match = /^"([0-9a-f]{64})"$/.exec(etag);
  return match ? match[1] : etag.replace(/^"|"$/g, '');
}

export async function gunzipModel(gzipped: Buffer): Promise<CityModel> {
  let json: Buffer;
  try {
    json = await gunzipAsync(gzipped);
  } catch (error) {
    throw new CityError(
      'MODEL_CORRUPT',
      `Could not gunzip the model: ${error instanceof Error ? error.message : String(error)}`,
      500,
      false
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch (error) {
    throw new CityError(
      'MODEL_CORRUPT',
      `Could not parse the model JSON: ${error instanceof Error ? error.message : String(error)}`,
      500,
      false
    );
  }
  return validateCityModel(parsed);
}

function fail(message: string): never {
  throw new CityError('MODEL_CORRUPT', `Invalid persisted city model: ${message}`, 500, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function assertOptionalName(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NAME_LENGTH) {
    fail(`${field} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  }
}

function assertNumberArray(value: unknown, field: string, minLength: number): number[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length < minLength) fail(`${field} is too short`);
  if (value.length % 2 !== 0) fail(`${field} must contain x/z pairs`);
  for (const entry of value) if (!isFiniteNumber(entry)) fail(`${field} contains a non-finite coordinate`);
  return value as number[];
}

/** Validates the wire shape of a persisted model; throws `MODEL_CORRUPT`. */
export function validateCityModel(value: unknown): CityModel {
  if (!isRecord(value)) fail('root is not an object');
  if (!isInteger(value.v) || (value.v as number) < 1) fail('v must be a positive integer');
  if (typeof value.key !== 'string' || !value.key) fail('key must be a string');

  const city = value.city;
  if (!isRecord(city)) fail('city must be an object');
  if (city.geonameId !== null && !isInteger(city.geonameId)) fail('city.geonameId must be an integer or null');
  if (typeof city.name !== 'string') fail('city.name must be a string');
  if (typeof city.country !== 'string') fail('city.country must be a string');
  if (!isFiniteNumber(city.lat) || !isFiniteNumber(city.lon)) fail('city coordinates must be finite');
  if (typeof city.tz !== 'string' || !city.tz) fail('city.tz must be a string');

  const meta = value.meta;
  if (!isRecord(meta)) fail('meta must be an object');
  if (typeof meta.generatedAt !== 'string' || Number.isNaN(Date.parse(meta.generatedAt))) {
    fail('meta.generatedAt must be an ISO timestamp');
  }
  if (typeof meta.source !== 'string') fail('meta.source must be a string');
  if (typeof meta.seed !== 'boolean') fail('meta.seed must be a boolean');
  if (!isFiniteNumber(meta.radiusM)) fail('meta.radiusM must be a number');
  const stats = meta.stats;
  if (!isRecord(stats)) fail('meta.stats must be an object');
  for (const field of ['buildings', 'roads', 'areas', 'dropped']) {
    if (!isInteger(stats[field]) || (stats[field] as number) < 0) fail(`meta.stats.${field} must be a non-negative integer`);
  }
  if (!Array.isArray(meta.warnings) || meta.warnings.some((warning) => typeof warning !== 'string')) {
    fail('meta.warnings must be an array of strings');
  }
  if (typeof meta.attribution !== 'string') fail('meta.attribution must be a string');
  if (meta.degraded !== undefined && typeof meta.degraded !== 'boolean') {
    fail('meta.degraded must be a boolean when present');
  }
  if (meta.degradedReasons !== undefined) {
    if (!Array.isArray(meta.degradedReasons) || meta.degradedReasons.some((reason) => typeof reason !== 'string')) {
      fail('meta.degradedReasons must be an array of strings when present');
    }
  }

  const bounds = value.bounds;
  if (!isRecord(bounds)) fail('bounds must be an object');
  for (const field of ['minX', 'maxX', 'minZ', 'maxZ', 'maxHeight']) {
    if (!isFiniteNumber(bounds[field])) fail(`bounds.${field} must be a number`);
  }

  if (value.terrain !== undefined) {
    const terrain = value.terrain;
    if (!isRecord(terrain)) fail('terrain must be an object');
    for (const field of ['x0', 'z0', 'step', 'baseM']) {
      if (!isFiniteNumber(terrain[field])) fail(`terrain.${field} must be a finite number`);
    }
    if ((terrain.step as number) <= 0) fail('terrain.step must be positive');
    for (const field of ['cols', 'rows']) {
      if (!isInteger(terrain[field]) || (terrain[field] as number) < 2 || (terrain[field] as number) > 1024) {
        fail(`terrain.${field} must be an integer between 2 and 1024`);
      }
    }
    const count = (terrain.cols as number) * (terrain.rows as number);
    if (!Array.isArray(terrain.h) || terrain.h.length !== count) fail('terrain.h must have cols × rows entries');
    for (const height of terrain.h) {
      if (!isInteger(height) || (height as number) < 0 || (height as number) > 100_000) {
        fail('terrain.h entries must be non-negative integer decimetres');
      }
    }
    if (terrain.source !== undefined && typeof terrain.source !== 'string') fail('terrain.source must be a string');
  }

  if (!Array.isArray(value.buildings)) fail('buildings must be an array');
  for (const building of value.buildings) {
    if (!isRecord(building)) fail('building must be an object');
    assertNumberArray(building.p, 'building.p', 6);
    if (!isInteger(building.h) || (building.h as number) <= 0) fail('building.h must be a positive integer');
    if (!isInteger(building.t) || (building.t as number) < 0 || (building.t as number) > 3) fail('building.t out of range');
    if (building.r !== undefined && building.r !== 0 && building.r !== 1) fail('building.r must be 0 or 1');
    assertOptionalName(building.n, 'building.n');
    assertOptionalName(building.k, 'building.k');
  }

  if (!Array.isArray(value.roads)) fail('roads must be an array');
  for (const road of value.roads) {
    if (!isRecord(road)) fail('road must be an object');
    if (!isInteger(road.c) || ![1, 2, 3, 4, 5, 9].includes(road.c as number)) fail('road.c out of range');
    assertNumberArray(road.p, 'road.p', 4);
    assertOptionalName(road.n, 'road.n');
  }

  if (!Array.isArray(value.areas)) fail('areas must be an array');
  for (const area of value.areas) {
    if (!isRecord(area)) fail('area must be an object');
    if (!isInteger(area.k) || ![1, 2, 3, 4].includes(area.k as number)) fail('area.k out of range');
    assertNumberArray(area.p, 'area.p', 6);
    if (area.holes !== undefined) {
      if (!Array.isArray(area.holes)) fail('area.holes must be an array');
      for (const hole of area.holes) assertNumberArray(hole, 'area.holes[]', 6);
    }
    assertOptionalName(area.n, 'area.n');
  }

  return value as unknown as CityModel;
}

/** Validates a city descriptor (model `city`, cache sidecars, seed manifests). */
export function isCityInfo(value: unknown): value is CityInfo {
  if (!isRecord(value)) return false;
  return (
    (value.geonameId === null || isInteger(value.geonameId)) &&
    typeof value.name === 'string' &&
    typeof value.country === 'string' &&
    isFiniteNumber(value.lat) &&
    isFiniteNumber(value.lon) &&
    typeof value.tz === 'string' &&
    value.tz.length > 0
  );
}

/** Validates a stored target descriptor (cache sidecars / seed manifests). */
export function validateModelTarget(value: unknown): ModelTarget {
  if (!isRecord(value)) fail('target must be an object');
  if (value.kind === 'city') {
    if (!isInteger(value.geonameId) || (value.geonameId as number) <= 0) fail('target.geonameId must be positive');
    return { kind: 'city', geonameId: value.geonameId as number };
  }
  if (value.kind === 'point') {
    if (!isFiniteNumber(value.lat) || !isFiniteNumber(value.lon)) fail('target coordinates must be finite');
    const target: ModelTarget = { kind: 'point', lat: value.lat as number, lon: value.lon as number };
    if (typeof value.name === 'string' && value.name) target.name = value.name;
    return target;
  }
  fail('target.kind must be "city" or "point"');
}

export function isModelMeta(value: unknown): value is ModelMeta {
  if (!isRecord(value)) return false;
  const stats = value.stats;
  return (
    typeof value.generatedAt === 'string' &&
    !Number.isNaN(Date.parse(value.generatedAt)) &&
    typeof value.source === 'string' &&
    typeof value.seed === 'boolean' &&
    typeof value.radiusM === 'number' &&
    Number.isFinite(value.radiusM) &&
    isRecord(stats) &&
    typeof stats.buildings === 'number' &&
    typeof stats.roads === 'number' &&
    typeof stats.areas === 'number' &&
    typeof stats.dropped === 'number' &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    typeof value.attribution === 'string' &&
    (value.degraded === undefined || typeof value.degraded === 'boolean') &&
    (value.degradedReasons === undefined ||
      (Array.isArray(value.degradedReasons) && value.degradedReasons.every((reason) => typeof reason === 'string')))
  );
}
