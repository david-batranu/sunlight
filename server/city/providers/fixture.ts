/**
 * Fixture provider: deterministic local raw OSM data for tests and
 * `CITY_SOURCE=fixture`. Never touches the network.
 *
 * Fixture file resolution (first match wins):
 *   - city targets: `raw-city-<geonameId>.json|.xml`, then `raw-city.json|.xml`
 *   - point targets: `raw-point-<lat>_<lon>.json|.xml`, then `raw-city.json|.xml`
 *
 * Supported payloads:
 *   - raw Overpass JSON (`{ "elements": [...] }`)
 *   - raw OSM API XML
 *   - wrapper JSON: `{ "v": 1, "format": "overpass-json" | "osm-xml",
 *     "data": {...} | "text": "<xml>" }`
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CityError } from '../errors.ts';
import { formatCoordinate } from '../keys.ts';
import { parseOverpassJson } from '../osm/json.ts';
import { parseOsmXml } from '../osm/xml.ts';
import type { RawOsmData } from '../raw.ts';
import type { CityDataProvider, ProviderFetchRequest, ProviderStatus } from './types.ts';

export interface FixtureProviderOptions {
  dir: string;
}

const FIXTURE_FORMAT = 1;

export function createFixtureProvider(options: FixtureProviderOptions): CityDataProvider {
  let status: ProviderStatus = 'unknown';

  return {
    id: 'fixture',
    source: 'fixture',
    status(): ProviderStatus {
      return status;
    },
    async fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData> {
      const candidates = fixtureCandidates(request);
      request.onProgress?.(5, 'Reading local fixture');

      let lastMissing: string[] = [];
      for (const candidate of candidates) {
        const fullPath = path.join(options.dir, candidate);
        let buffer: Buffer;
        try {
          buffer = await readFile(fullPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            lastMissing.push(candidate);
            continue;
          }
          status = 'down';
          throw new CityError(
            'FIXTURE_INVALID',
            `Could not read the fixture ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
            502,
            false
          );
        }
        request.onProgress?.(35, 'Parsing fixture data', candidate);
        try {
          const parsed = parseFixture(candidate, buffer);
          const raw =
            parsed.center && centerDiffers(parsed.center, request.center)
              ? recenterRawOsmData(parsed.raw, parsed.center, request.center)
              : parsed.raw;
          status = 'up';
          request.onProgress?.(60, 'Fixture data ready', `${raw.ways.length} ways`);
          return raw;
        } catch (error) {
          status = 'down';
          if (error instanceof CityError) throw error;
          throw new CityError(
            'FIXTURE_INVALID',
            `Could not parse the fixture ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
            502,
            false
          );
        }
      }

      status = 'down';
      throw new CityError(
        'FIXTURE_MISSING',
        `No fixture was found for this target (looked for ${lastMissing.join(', ')}).`,
        404,
        false,
        { dir: options.dir, tried: lastMissing }
      );
    }
  };
}

function fixtureCandidates(request: ProviderFetchRequest): string[] {
  const out: string[] = [];
  if (request.target.kind === 'city') {
    const id = request.target.geonameId;
    out.push(`raw-city-${id}.json`, `raw-city-${id}.xml`);
  } else {
    const lat = formatCoordinate(request.target.lat);
    const lon = formatCoordinate(request.target.lon);
    out.push(`raw-point-${lat}_${lon}.json`, `raw-point-${lat}_${lon}.xml`);
  }
  out.push('raw-city.json', 'raw-city.xml');
  return out;
}

interface ParsedFixture {
  raw: RawOsmData;
  /** Declared fixture centre, used to re-centre the sample data for other targets. */
  center: { lat: number; lon: number } | null;
}

function parseFixture(fileName: string, buffer: Buffer): ParsedFixture {
  const text = buffer.toString('utf8');
  const trimmed = text.trimStart();
  if (!trimmed) throw new CityError('FIXTURE_INVALID', `The fixture ${fileName} is empty.`, 502, false);

  if (fileName.endsWith('.xml') || trimmed.startsWith('<')) {
    return { raw: parseOsmXml(text, { source: 'fixture' }), center: null };
  }
  if (!trimmed.startsWith('{')) {
    throw new CityError(
      'FIXTURE_INVALID',
      `The fixture ${fileName} is neither JSON nor OSM XML.`,
      502,
      false
    );
  }

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (error) {
    throw new CityError(
      'FIXTURE_INVALID',
      `The fixture ${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      502,
      false
    );
  }
  if (!root || typeof root !== 'object') {
    throw new CityError('FIXTURE_INVALID', `The fixture ${fileName} has an invalid shape.`, 502, false);
  }
  const record = root as Record<string, unknown>;
  const declaredCenter = readDeclaredCenter(record.center);
  if (Array.isArray(record.elements)) {
    return { raw: parseOverpassJson(text, { source: 'fixture' }), center: declaredCenter };
  }
  if (record.v !== FIXTURE_FORMAT || record.v === undefined) {
    // Allow wrapped fixtures without an explicit version but reject unknown ones.
    if (record.v !== undefined) {
      throw new CityError('FIXTURE_INVALID', `Unsupported fixture version ${String(record.v)}.`, 502, false);
    }
  }
  if (record.format === 'overpass-json') {
    const data = record.data;
    if (!data || typeof data !== 'object') {
      throw new CityError('FIXTURE_INVALID', `The fixture ${fileName} has no overpass data object.`, 502, false);
    }
    const elements = (data as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) {
      throw new CityError('FIXTURE_INVALID', `The fixture ${fileName} has no elements array.`, 502, false);
    }
    return { raw: parseOverpassJson(JSON.stringify(data), { source: 'fixture' }), center: declaredCenter };
  }
  if (record.format === 'osm-xml') {
    const xml = typeof record.text === 'string' ? record.text : typeof record.data === 'string' ? record.data : null;
    if (!xml) {
      throw new CityError('FIXTURE_INVALID', `The fixture ${fileName} has no XML text.`, 502, false);
    }
    return { raw: parseOsmXml(xml, { source: 'fixture' }), center: declaredCenter };
  }
  throw new CityError(
    'FIXTURE_INVALID',
    `The fixture ${fileName} is not a recognised raw OSM fixture.`,
    502,
    false
  );
}

function readDeclaredCenter(value: unknown): { lat: number; lon: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { lat?: unknown; lon?: unknown };
  const lat = record.lat;
  const lon = record.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function centerDiffers(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
  return Math.abs(a.lat - b.lat) > 1e-6 || Math.abs(a.lon - b.lon) > 1e-6;
}

function normalizeLon(lon: number): number {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/**
 * Translates fixture geometry so the same sample city can be rendered at any
 * requested target (used by `CITY_SOURCE=fixture` smoke runs and tests).
 */
export function recenterRawOsmData(
  raw: RawOsmData,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): RawOsmData {
  const deltaLat = to.lat - from.lat;
  const deltaLon = to.lon - from.lon;
  const move = (coord: { lat: number; lon: number }): { lat: number; lon: number } => ({
    lat: Math.max(-90, Math.min(90, coord.lat + deltaLat)),
    lon: normalizeLon(coord.lon + deltaLon)
  });
  return {
    ...raw,
    nodes: raw.nodes.map((node) => ({ ...node, ...move(node) })),
    ways: raw.ways.map((way) => ({
      ...way,
      geometry: way.geometry ? way.geometry.map(move) : undefined
    })),
    relations: raw.relations.map((relation) => ({
      ...relation,
      members: relation.members.map((member) => ({
        ...member,
        geometry: member.geometry ? member.geometry.map(move) : undefined,
        ...(typeof member.lat === 'number' && typeof member.lon === 'number'
          ? (() => {
              const moved = move({ lat: member.lat, lon: member.lon });
              return { lat: moved.lat, lon: moved.lon };
            })()
          : {})
      }))
    }))
  };
}
