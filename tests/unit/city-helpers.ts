/**
 * Shared helpers for the city unit tests.
 *
 * Not a test file itself (the `city-*.test.ts` glob only picks up tests), so
 * importing it never registers tests accidentally.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { AppConfig } from '../../server/config.ts';
import { loadConfig } from '../../server/config.ts';
import { buildCityModel, type BuildInput } from '../../server/city/build.ts';
import type { SeedManifest } from '../../server/city/manifest-types.ts';
import { sha256Hex } from '../../server/city/model-io.ts';
import { parseOverpassJson } from '../../server/city/osm/json.ts';
import { parseOsmXml } from '../../server/city/osm/xml.ts';
import type { RawOsmData } from '../../server/city/raw.ts';
import { MODEL_VERSION, OSM_ATTRIBUTION } from '../../shared/constants.ts';
import type { CityInfo, CityModel, CitySource, ModelMeta } from '../../shared/types.ts';

const require = createRequire(import.meta.url);

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const FIXTURES_DIR = path.join(REPO_ROOT, 'server', 'data', 'fixtures');
export const CITIES_INDEX_PATH = path.join(REPO_ROOT, 'server', 'data', 'cities.json.gz');

export const BRASOV_CITY: CityInfo = {
  geonameId: 683844,
  name: 'Brașov',
  country: 'RO',
  lat: 45.64861,
  lon: 25.60613,
  tz: 'Europe/Bucharest'
};

export const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/** Parses the wrapped `raw-city.json` fixture into the pipeline's raw form. */
export async function loadRawCityFixture(): Promise<RawOsmData> {
  const text = await readFile(path.join(FIXTURES_DIR, 'raw-city.json'), 'utf8');
  const wrapped = JSON.parse(text) as { format?: string; data?: unknown };
  if (wrapped.format !== 'overpass-json' || !wrapped.data) {
    throw new Error('raw-city.json is not a wrapped overpass-json fixture');
  }
  return parseOverpassJson(JSON.stringify(wrapped.data), { source: 'fixture' });
}

export async function loadOsmXmlFixture(): Promise<RawOsmData> {
  const text = await readFile(path.join(FIXTURES_DIR, 'raw-tile.xml'), 'utf8');
  return parseOsmXml(text, { source: 'osm-api' });
}

export function fixtureBuildInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    key: 'gn-683844-r900-v1',
    city: BRASOV_CITY,
    centerLat: BRASOV_CITY.lat,
    centerLon: BRASOV_CITY.lon,
    radiusM: 900,
    modelVersion: MODEL_VERSION,
    source: 'fixture',
    seed: false,
    generatedAt: FIXED_TIMESTAMP,
    attribution: OSM_ATTRIBUTION,
    ...overrides
  };
}

export async function buildFixtureModel(overrides: Partial<BuildInput> = {}): Promise<CityModel> {
  const raw = await loadRawCityFixture();
  return buildCityModel(raw, fixtureBuildInput(overrides));
}

export function makeMeta(overrides: Partial<ModelMeta> = {}): ModelMeta {
  return {
    generatedAt: FIXED_TIMESTAMP,
    source: 'fixture',
    seed: false,
    radiusM: 900,
    stats: { buildings: 1, roads: 1, areas: 0, dropped: 0 },
    warnings: [],
    attribution: OSM_ATTRIBUTION,
    ...overrides
  };
}

export function makeModel(key: string, overrides: { meta?: Partial<ModelMeta>; city?: CityInfo } = {}): CityModel {
  return {
    v: MODEL_VERSION,
    key,
    city: overrides.city ?? BRASOV_CITY,
    meta: makeMeta(overrides.meta),
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10, maxHeight: 100 },
    buildings: [{ p: [-10, -10, 10, -10, 10, 10, -10, 10], h: 100, t: 0, r: 1 }],
    roads: [{ c: 3, p: [-10, 0, 10, 0] }],
    areas: []
  };
}

export function serializeModel(model: CityModel): Buffer {
  return Buffer.from(JSON.stringify(model), 'utf8');
}

export function gzipModelSync(model: CityModel): Buffer {
  return gzipSync(serializeModel(model), { level: 9 });
}

export async function makeTempDir(prefix = 'sunlight-city-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Loads the real server config but redirects writable paths into a temp dir. */
export function makeTestConfig(tmpDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    cacheDir: path.join(tmpDir, 'cache'),
    seedsDir: path.join(tmpDir, 'seeds'),
    fixtureDir: FIXTURES_DIR,
    citySource: 'fixture',
    seedsOnly: false,
    generationConcurrency: 1,
    cacheMaxBytes: 64 * 1024 * 1024,
    ...overrides
  };
}

export interface SyntheticSeed {
  slug: string;
  geonameId: number;
  name: string;
  city: CityInfo;
  source?: CitySource;
  key?: string;
}

/**
 * Writes a seed directory (one gzipped model + manifest) for tests, using the
 * same on-disk contract as `scripts/bake-seeds.mjs`.
 */
export async function writeSeedDir(dir: string, seeds: SyntheticSeed[]): Promise<SeedManifest> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const cities: SeedManifest['cities'] = [];
  for (const seed of seeds) {
    const key = seed.key ?? `gn-${seed.geonameId}-r900-v${MODEL_VERSION}`;
    const model = makeModel(key, { city: seed.city, meta: { seed: true, source: 'seed' } });
    const gzipped = gzipModelSync(model);
    const file = `${seed.slug}.json.gz`;
    await writeFile(path.join(dir, file), gzipped);
    cities.push({
      slug: seed.slug,
      geonameId: seed.geonameId,
      name: seed.name,
      key,
      file,
      bytes: gzipped.length,
      sha256: sha256Hex(gzipped),
      modelVersion: MODEL_VERSION,
      radiusM: 900,
      source: seed.source ?? 'overpass',
      generatedAt: FIXED_TIMESTAMP,
      stats: model.meta.stats
    });
  }
  const manifest: SeedManifest = {
    v: 1,
    modelVersion: MODEL_VERSION,
    radiusM: 900,
    generatedAt: FIXED_TIMESTAMP,
    attribution: OSM_ATTRIBUTION,
    cities
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export { require as requireFromHere };
