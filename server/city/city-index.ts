/**
 * GeoNames city search index (`server/data/cities.json.gz`).
 *
 * The payload is `{v, source, attribution, generatedAt, count, cities}`, where
 * every city is `[geonameId, name, asciiName, cc, admin1, lat, lon, tz,
 * population]` (see `scripts/build-city-index.mjs`). Matching is
 * diacritic-insensitive, ranked by match quality then population, and stable
 * across runs.
 */

import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';
import type { CitySearchResult } from '../../shared/types.ts';
import { CityError } from './errors.ts';
import { haversineKm } from './geometry.ts';
import { log } from './logger.ts';

const gunzipAsync = promisify(gunzipCallback);

const INDEX_FORMAT = 1;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

/** Common letters that do not decompose under NFD. */
const TRANSLITERATION: Record<string, string> = {
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  ĸ: 'k'
};

export interface CityRecord {
  geonameId: number;
  name: string;
  asciiName: string;
  country: string;
  admin1: string;
  lat: number;
  lon: number;
  tz: string;
  population: number;
  nameNorm: string;
  asciiNorm: string;
}

export interface NearestCityMatch {
  record: CityRecord;
  distanceKm: number;
}

export type SeedSlugLookup = (geonameId: number) => string | null;

/** Diacritic-insensitive, punctuation-insensitive search key. */
export function normalizeCityName(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[øłđðþßæœıĸ]/g, (character) => TRANSLITERATION[character] ?? character)
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
}

export class CityIndex {
  private readonly records: CityRecord[];
  private readonly byId: Map<number, CityRecord>;
  private readonly displayNames: { of(code: string): string | undefined } | null;
  private readonly countryNames = new Map<string, string>();

  private constructor(records: CityRecord[]) {
    this.records = records;
    this.byId = new Map(records.map((record) => [record.geonameId, record]));
    this.displayNames = createDisplayNames();
  }

  static async load(filePath: string): Promise<CityIndex> {
    let compressed: Buffer;
    try {
      compressed = await readFile(filePath);
    } catch (error) {
      throw new CityError(
        'INDEX_MISSING',
        `Could not read the city index at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        500,
        false
      );
    }
    let json: Buffer;
    try {
      json = await gunzipAsync(compressed);
    } catch (error) {
      throw new CityError(
        'INDEX_INVALID',
        `The city index is not valid gzip: ${error instanceof Error ? error.message : String(error)}`,
        500,
        false
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json.toString('utf8'));
    } catch (error) {
      throw new CityError(
        'INDEX_INVALID',
        `The city index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        500,
        false
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new CityError('INDEX_INVALID', 'The city index payload is not an object.', 500, false);
    }
    const payload = parsed as { v?: unknown; count?: unknown; cities?: unknown };
    if (payload.v !== INDEX_FORMAT) {
      throw new CityError('INDEX_INVALID', `Unsupported city index version ${String(payload.v)}.`, 500, false);
    }
    if (!Array.isArray(payload.cities)) {
      throw new CityError('INDEX_INVALID', 'The city index has no cities array.', 500, false);
    }

    const records: CityRecord[] = [];
    let skipped = 0;
    for (const entry of payload.cities) {
      const record = parseRecord(entry);
      if (!record) {
        skipped += 1;
        continue;
      }
      records.push(record);
    }
    if (records.length === 0) {
      throw new CityError('INDEX_INVALID', 'The city index contains no usable cities.', 500, false);
    }
    if (skipped > 0) log.warn(`city index: skipped ${skipped} malformed row(s)`);
    if (typeof payload.count === 'number' && payload.count !== records.length) {
      log.warn(`city index: count header is ${payload.count}, loaded ${records.length}`);
    }
    log.info(`city index: ${records.length} cities loaded`);
    return new CityIndex(records);
  }

  get count(): number {
    return this.records.length;
  }

  get(geonameId: number): CityRecord | null {
    return this.byId.get(geonameId) ?? null;
  }

  /** Ranked, diacritic-insensitive substring search. */
  search(query: string, limit: number, seedLookup?: SeedSlugLookup): CitySearchResult[] {
    const normalized = normalizeCityName(query);
    if (!normalized) return [];
    const tokens = normalized.split(' ').filter(Boolean);
    const scored: Array<{ record: CityRecord; score: number }> = [];

    for (const record of this.records) {
      const score = scoreRecord(record, normalized, tokens);
      if (score > 0) scored.push({ record, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || b.record.population - a.record.population || a.record.geonameId - b.record.geonameId
    );
    const capped = Math.max(0, Math.min(limit, scored.length));
    const results: CitySearchResult[] = [];
    for (let i = 0; i < capped; i += 1) {
      const record = scored[i].record;
      const seedSlug = seedLookup?.(record.geonameId) ?? null;
      results.push(toSearchResult(record, seedSlug, (code) => this.countryName(code)));
    }
    return results;
  }

  /** Nearest indexed city (haversine), deterministic tie-breaking. */
  nearest(lat: number, lon: number): NearestCityMatch | null {
    let best: CityRecord | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const record of this.records) {
      const distance = haversineKm(lat, lon, record.lat, record.lon);
      if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && best && record.geonameId < best.geonameId)) {
        best = record;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    return { record: best, distanceKm: Math.round(bestDistance * 1000) / 1000 };
  }

  /** English country name for an ISO 3166-1 alpha-2 code ('' when unknown). */
  countryName(code: string): string {
    if (!code) return '';
    const key = code.toUpperCase();
    const cached = this.countryNames.get(key);
    if (cached !== undefined) return cached;
    let name = key;
    try {
      const display = this.displayNames?.of(key);
      if (typeof display === 'string' && display && display !== key) name = display;
    } catch {
      name = key;
    }
    this.countryNames.set(key, name);
    return name;
  }

  /** Maps an index record to the public search result shape. */
  toResult(record: CityRecord, seedLookup?: SeedSlugLookup): CitySearchResult {
    return toSearchResult(record, seedLookup?.(record.geonameId) ?? null, (code) => this.countryName(code));
  }
}

function parseRecord(entry: unknown): CityRecord | null {
  if (!Array.isArray(entry) || entry.length < 9) return null;
  const [id, name, asciiName, country, admin1, lat, lon, tz, population] = entry;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof name !== 'string' || !name) return null;
  if (typeof asciiName !== 'string') return null;
  if (typeof country !== 'string') return null;
  if (typeof admin1 !== 'string') return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (typeof tz !== 'string' || !tz) return null;
  if (typeof population !== 'number' || !Number.isFinite(population) || population < 0) return null;
  return {
    geonameId: id,
    name,
    asciiName,
    country,
    admin1,
    lat,
    lon,
    tz,
    population,
    nameNorm: normalizeCityName(name),
    asciiNorm: normalizeCityName(asciiName)
  };
}

function toSearchResult(
  record: CityRecord,
  seedSlug: string | null,
  countryName: (code: string) => string
): CitySearchResult {
  const result: CitySearchResult = {
    geonameId: record.geonameId,
    name: record.name,
    asciiName: record.asciiName,
    country: record.country,
    countryName: countryName(record.country),
    lat: record.lat,
    lon: record.lon,
    tz: record.tz,
    population: record.population,
    seed: seedSlug !== null
  };
  if (seedSlug !== null) result.seedSlug = seedSlug;
  return result;
}

function scoreRecord(record: CityRecord, query: string, tokens: string[]): number {
  if (record.nameNorm === query || record.asciiNorm === query) return 1100;
  let score = 0;
  if (record.nameNorm.startsWith(query) || record.asciiNorm.startsWith(query)) {
    score = 900;
  } else if (startsWord(record.nameNorm, query) || startsWord(record.asciiNorm, query)) {
    score = 750;
  } else if (record.nameNorm.includes(` ${query}`) || record.asciiNorm.includes(` ${query}`)) {
    score = 650;
  } else if (record.nameNorm.includes(query) || record.asciiNorm.includes(query)) {
    score = 520;
  } else if (tokens.length > 1 && tokens.every((token) => record.nameNorm.includes(token) || record.asciiNorm.includes(token))) {
    score = 300;
  } else {
    return 0;
  }
  // Prefer the more specific (shorter) name for the same match quality.
  const lengthPenalty = Math.min(120, Math.abs(record.nameNorm.length - query.length));
  return score - lengthPenalty;
}

function startsWord(text: string, query: string): boolean {
  if (text.startsWith(query)) return true;
  const index = text.indexOf(` ${query}`);
  return index >= 0;
}

function createDisplayNames(): { of(code: string): string | undefined } | null {
  const ctor = (Intl as unknown as {
    DisplayNames?: new (locales: string[], options: { type: 'region' }) => { of(code: string): string | undefined };
  }).DisplayNames;
  if (!ctor) return null;
  try {
    return new ctor(['en'], { type: 'region' });
  } catch {
    return null;
  }
}
