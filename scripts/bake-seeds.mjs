#!/usr/bin/env node
/**
 * Bakes the eight pre-baked Romanian city seed models.
 *
 *   node scripts/bake-seeds.mjs
 *   npm run bake:seeds
 *
 * Options:
 *   --source <auto|overpass|osm-api|fixture>  Provider chain to use (default auto)
 *   --out <dir>                               Output directory (default server/data/seeds)
 *   --only <slug[,slug]>                      Bake only the named seed cities
 *   --radius <m>                              Model radius in metres (default CITY_RADIUS_M)
 *   --fixture-dir <dir>                       Fixture directory for --source fixture
 *   --generated-at <iso>                      Fixed generatedAt (reproducible fixture bakes)
 *   --force                                   Re-bake even when a valid seed already exists
 *   --help                                    Show this help
 *
 * For each city the script fetches OSM data through the normal provider chain
 * (Overpass → OSM API tiled fallback), builds the deterministic city model,
 * gzips it atomically to `<slug>.json.gz`, and rewrites `manifest.json` with
 * sizes and SHA-256 digests. A failed city does not destroy an existing valid
 * bake: the previous manifest entry and file are preserved.
 *
 * Seeds are baked with `meta.seed = true` and `meta.source = 'seed'`; the
 * manifest records which provider produced the raw data. Runtime never touches
 * the network for a seeded city.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { CITY_RADIUS_M, MODEL_VERSION, OSM_ATTRIBUTION, SEED_CITIES } from '../shared/constants.ts';
import { loadConfig } from '../server/config.ts';
import { buildCityModel } from '../server/city/build.ts';
import { atomicWriteFile } from '../server/city/fs-atomic.ts';
import { cityModelKey } from '../server/city/keys.ts';
import { sha256Hex } from '../server/city/model-io.ts';
import { createProviderChain } from '../server/city/providers/chain.ts';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUT = path.join(ROOT, 'server', 'data', 'seeds');
const MANIFEST_FORMAT = 1;
const MANIFEST_FILE = 'manifest.json';
const PER_CITY_TIMEOUT_MS = 300_000;
const VALID_SOURCES = new Set(['auto', 'overpass', 'osm-api', 'fixture']);

function usage() {
  const lines = [
    'Bake the bundled Sunlight seed city models from OpenStreetMap.',
    '',
    'Usage: node scripts/bake-seeds.mjs [options]',
    '',
    '  --source <auto|overpass|osm-api|fixture>  Provider chain (default auto)',
    '  --out <dir>                               Output directory (default server/data/seeds)',
    '  --only <slug[,slug]>                      Bake only these seed cities',
    '  --radius <m>                              Model radius in metres (default ' + CITY_RADIUS_M + ')',
    '  --fixture-dir <dir>                       Fixture directory for --source fixture',
    '  --generated-at <iso>                      Fixed generatedAt timestamp',
    '  --force                                   Re-bake even when a seed is already valid',
    '  --help                                    Show this help',
    '',
    'Seed cities: ' + SEED_CITIES.map((city) => city.slug).join(', ')
  ];
  console.log(lines.join('\n'));
}

function parseArgs(argv) {
  const options = {
    source: 'auto',
    out: DEFAULT_OUT,
    only: null,
    radius: CITY_RADIUS_M,
    fixtureDir: null,
    generatedAt: null,
    force: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--source':
        options.source = next();
        break;
      case '--out':
        options.out = path.resolve(next());
        break;
      case '--only':
        options.only = next()
          .split(',')
          .map((slug) => slug.trim())
          .filter(Boolean);
        break;
      case '--radius':
        options.radius = Number(next());
        break;
      case '--fixture-dir':
        options.fixtureDir = path.resolve(next());
        break;
      case '--generated-at':
        options.generatedAt = next();
        break;
      case '--force':
        options.force = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!VALID_SOURCES.has(options.source)) {
    throw new Error(`--source must be one of ${[...VALID_SOURCES].join(', ')}`);
  }
  if (!Number.isFinite(options.radius) || options.radius < 100 || options.radius > 5000) {
    throw new Error('--radius must be a number between 100 and 5000');
  }
  if (options.generatedAt !== null && Number.isNaN(Date.parse(options.generatedAt))) {
    throw new Error('--generated-at must be an ISO-8601 timestamp');
  }
  return options;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function readPreviousManifest(outDir) {
  try {
    const raw = await readFile(path.join(outDir, MANIFEST_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cities)) return [];
    return parsed.cities;
  } catch {
    return [];
  }
}

/** True when the existing seed file matches its manifest entry and this model version. */
async function existingSeedIsValid(outDir, entry, modelVersion, radiusM) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.modelVersion !== modelVersion || entry.radiusM !== radiusM) return false;
  if (typeof entry.file !== 'string' || typeof entry.sha256 !== 'string' || !Number.isSafeInteger(entry.bytes)) {
    return false;
  }
  if (!existsSync(path.join(outDir, entry.file))) return false;
  try {
    const buffer = await readFile(path.join(outDir, entry.file));
    if (buffer.length !== entry.bytes) return false;
    if (sha256Hex(buffer) !== entry.sha256) return false;
    const model = JSON.parse(gunzipSync(buffer).toString('utf8'));
    return model.v === modelVersion && model.key === entry.key && model.meta?.seed === true;
  } catch {
    return false;
  }
}

async function bakeCity(city, context) {
  const { options, config, providerChain, radiusM, modelVersion, outDir } = context;
  const key = cityModelKey(city.geonameId, radiusM, modelVersion);
  const startedAt = Date.now();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('bake timed out')), PER_CITY_TIMEOUT_MS);
  timeout.unref?.();

  let lastDecile = -1;
  const onProgress = (percent, label, detail) => {
    const decile = Math.floor(percent / 25);
    if (decile === lastDecile) return;
    lastDecile = decile;
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`    ${String(Math.round(percent)).padStart(3)}% ${label}${suffix}`);
  };

  try {
    console.log(`  fetching OSM data (${options.source}) ...`);
    const raw = await providerChain.fetchRaw({
      target: { kind: 'city', geonameId: city.geonameId },
      center: { lat: city.lat, lon: city.lon },
      radiusM,
      signal: controller.signal,
      onProgress
    });
    if (raw.ways.length === 0) {
      throw new Error('provider returned no OSM ways');
    }
    console.log(
      `    raw data: ${raw.ways.length} ways, ${raw.relations.length} relations (source: ${raw.source})`
    );

    const model = buildCityModel(raw, {
      key,
      city: {
        geonameId: city.geonameId,
        name: city.name,
        country: 'RO',
        lat: city.lat,
        lon: city.lon,
        tz: city.tz
      },
      centerLat: city.lat,
      centerLon: city.lon,
      radiusM,
      modelVersion,
      source: 'seed',
      seed: true,
      generatedAt,
      attribution: OSM_ATTRIBUTION,
      warnings: raw.warnings
    });

    const json = Buffer.from(JSON.stringify(model), 'utf8');
    const gzipped = gzipSync(json, { level: 9 });
    // Self-check: the manifest digest must describe exactly what is written.
    const decoded = JSON.parse(gunzipSync(gzipped).toString('utf8'));
    if (decoded.key !== key || decoded.v !== modelVersion || decoded.meta?.seed !== true) {
      throw new Error('self-check of the baked model failed');
    }

    await mkdir(outDir, { recursive: true });
    const file = `${city.slug}.json.gz`;
    await atomicWriteFile(path.join(outDir, file), gzipped);

    const entry = {
      slug: city.slug,
      geonameId: city.geonameId,
      name: city.name,
      key,
      file,
      bytes: gzipped.length,
      sha256: sha256Hex(gzipped),
      modelVersion,
      radiusM,
      source: raw.source,
      generatedAt,
      stats: model.meta.stats
    };
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `  baked ${city.slug}: ${model.meta.stats.buildings} buildings, ${model.meta.stats.roads} roads, ` +
        `${model.meta.stats.areas} areas, ${formatBytes(gzipped.length)} in ${elapsed}s`
    );
    if (model.meta.warnings.length > 0) {
      console.log(`    warnings: ${model.meta.warnings.join(' | ')}`);
    }
    return { entry, raw };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const radiusM = Math.round(options.radius);
  const modelVersion = MODEL_VERSION;
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    citySource: options.source,
    cityRadiusM: radiusM,
    seedsOnly: false,
    ...(options.fixtureDir ? { fixtureDir: options.fixtureDir } : {})
  };
  const providerChain = createProviderChain(config);
  if (!providerChain.canGenerate) {
    throw new Error(`--source ${options.source} cannot fetch raw OSM data`);
  }

  const selected = options.only
    ? SEED_CITIES.filter((city) => options.only.includes(city.slug))
    : [...SEED_CITIES];
  if (selected.length === 0) {
    throw new Error(`No seed city matched --only ${String(options.only)}`);
  }
  if (options.only) {
    const unknown = options.only.filter((slug) => !SEED_CITIES.some((city) => city.slug === slug));
    if (unknown.length > 0) throw new Error(`Unknown seed city slug(s): ${unknown.join(', ')}`);
  }

  const outDir = options.out;
  await mkdir(outDir, { recursive: true });
  const previousEntries = await readPreviousManifest(outDir);
  const previousBySlug = new Map(
    previousEntries.filter((entry) => entry && typeof entry === 'object').map((entry) => [entry.slug, entry])
  );

  console.log(`Sunlight seed bake: ${selected.length} city/cities → ${path.relative(ROOT, outDir)}`);
  console.log(`  model version ${modelVersion}, radius ${radiusM} m, source ${options.source}`);

  const results = new Map();
  const failures = [];
  for (let index = 0; index < selected.length; index += 1) {
    const city = selected[index];
    console.log(`\n[${index + 1}/${selected.length}] ${city.name} (${city.slug}, gn-${city.geonameId})`);
    const previous = previousBySlug.get(city.slug);
    if (!options.force && (await existingSeedIsValid(outDir, previous, modelVersion, radiusM))) {
      console.log(`  up to date (${formatBytes(previous.bytes)}, sha ${previous.sha256.slice(0, 12)}…); use --force to re-bake`);
      results.set(city.slug, previous);
      continue;
    }
    try {
      const { entry } = await bakeCity(city, {
        options,
        config,
        providerChain,
        radiusM,
        modelVersion,
        outDir
      });
      results.set(city.slug, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ city, message });
      console.error(`  FAILED: ${message}`);
      if (previous && (await existingSeedIsValid(outDir, previous, modelVersion, radiusM))) {
        console.log('  keeping the previous valid bake for this city');
        results.set(city.slug, previous);
      }
    }
  }

  // Keep valid seeds for cities that were not selected by --only (and preserve
  // a failed city's previous bake), so a partial run never shrinks the manifest.
  const cities = [];
  for (const city of SEED_CITIES) {
    const entry = results.get(city.slug);
    if (entry) {
      cities.push(entry);
      continue;
    }
    if (!options.only) continue;
    const previous = previousBySlug.get(city.slug);
    if (previous && (await existingSeedIsValid(outDir, previous, modelVersion, radiusM))) {
      cities.push(previous);
    }
  }
  const manifest = {
    v: MANIFEST_FORMAT,
    modelVersion,
    radiusM,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    attribution: OSM_ATTRIBUTION,
    cities
  };
  await atomicWriteFile(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');

  const totalBytes = cities.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(
    `\nWrote ${MANIFEST_FILE}: ${cities.length} seed(s), ${formatBytes(totalBytes)} total, ` +
      `${path.relative(ROOT, path.join(outDir, MANIFEST_FILE))}`
  );
  for (const entry of cities) {
    console.log(
      `  ${entry.slug.padEnd(12)} ${String(entry.stats?.buildings ?? '?').padStart(6)} buildings  ` +
        `${formatBytes(entry.bytes).padStart(9)}  sha ${entry.sha256.slice(0, 12)}…  (${entry.source})`
    );
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} city/cities failed:`);
    for (const failure of failures) console.error(`  ${failure.city.slug}: ${failure.message}`);
    return 1;
  }
  return 0;
}

const exitCode = await main().catch((error) => {
  console.error(`bake-seeds failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return 1;
});
process.exitCode = exitCode;
