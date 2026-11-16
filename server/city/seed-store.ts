/**
 * Bundled pre-baked seed models.
 *
 * `scripts/bake-seeds.mjs` writes `<dir>/<slug>.json.gz` plus a `manifest.json`
 * carrying the gzipped file size, SHA-256, model version, radius and stats.
 * Runtime is read-only: every manifest entry is integrity-verified at startup,
 * and incompatible (stale version/radius) manifests are ignored so the service
 * can still fall back to live generation.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CitySource, ModelStats } from '../../shared/types.ts';
import type { ReadyModel } from './contract.ts';
import { CityError } from './errors.ts';
import { isValidModelKey } from './keys.ts';
import { log } from './logger.ts';
import { gunzipModel, quotedEtag, sha256Hex } from './model-io.ts';
import type { ModelManifestEntry } from './manifest-types.ts';

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_FORMAT = 1;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.json\.gz$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export type SeedStatus = 'up' | 'down' | 'unknown';

export interface SeedStoreInfo {
  count: number;
  slugs: string[];
  status: SeedStatus;
  warnings: string[];
}

export class SeedStore {
  private readonly dir: string;
  private readonly entries: ModelManifestEntry[];
  private readonly entriesById = new Map<number, ModelManifestEntry>();
  private readonly entriesByKey = new Map<string, ModelManifestEntry>();
  private readonly warnings: string[];
  private readonly status: SeedStatus;

  private constructor(dir: string, info: SeedStoreInfo, entries: ModelManifestEntry[]) {
    this.dir = dir;
    this.entries = entries;
    this.warnings = info.warnings;
    this.status = info.status;
    for (const entry of entries) {
      this.entriesById.set(entry.geonameId, entry);
      this.entriesByKey.set(entry.key, entry);
    }
  }

  static async load(dir: string, options: { modelVersion: number; radiusM: number }): Promise<SeedStore> {
    const manifestPath = path.join(dir, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        log.info(`no seed manifest at ${manifestPath}; serving live-generated models only`);
        return new SeedStore(dir, { count: 0, slugs: [], status: 'unknown', warnings: [] }, []);
      }
      log.warn(`could not read the seed manifest: ${error instanceof Error ? error.message : String(error)}`);
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings: ['seed manifest is unreadable'] }, []);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn(`seed manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings: ['seed manifest is invalid JSON'] }, []);
    }

    const warnings: string[] = [];
    if (!parsed || typeof parsed !== 'object') {
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings: ['seed manifest has an invalid shape'] }, []);
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.v !== MANIFEST_FORMAT) {
      warnings.push(`unsupported seed manifest version ${String(manifest.v)}`);
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings }, []);
    }
    const manifestVersion = typeof manifest.modelVersion === 'number' ? manifest.modelVersion : NaN;
    const manifestRadius = typeof manifest.radiusM === 'number' ? manifest.radiusM : NaN;
    if (manifestVersion !== options.modelVersion) {
      warnings.push(`seed manifest model version ${String(manifest.modelVersion)} does not match runtime ${options.modelVersion}`);
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings }, []);
    }
    if (manifestRadius !== options.radiusM) {
      warnings.push(`seed manifest radius ${String(manifest.radiusM)} m does not match runtime ${options.radiusM} m`);
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings }, []);
    }
    if (!Array.isArray(manifest.cities)) {
      warnings.push('seed manifest cities list is missing');
      return new SeedStore(dir, { count: 0, slugs: [], status: 'down', warnings }, []);
    }

    const verified: ModelManifestEntry[] = [];
    let failures = 0;
    for (const candidate of manifest.cities) {
      const entry = parseEntry(candidate, manifestVersion, manifestRadius);
      if (!entry) {
        failures += 1;
        warnings.push('ignored a malformed seed manifest entry');
        continue;
      }
      const problem = await verifySeedFile(dir, entry, options);
      if (problem) {
        failures += 1;
        warnings.push(`${entry.slug}: ${problem}`);
        continue;
      }
      verified.push(entry);
    }

    if (failures > 0) log.warn(`seed manifest: ${failures} entry/entries failed verification`);
    const status: SeedStatus = verified.length === 0 ? 'down' : failures > 0 ? 'down' : 'up';
    log.info(`seeds: ${verified.length} ready${failures > 0 ? `, ${failures} invalid` : ''}`);
    return new SeedStore(
      dir,
      { count: verified.length, slugs: verified.map((entry) => entry.slug), status, warnings },
      verified
    );
  }

  get count(): number {
    return this.entries.length;
  }

  get slugs(): string[] {
    return this.entries.map((entry) => entry.slug);
  }

  get statusValue(): SeedStatus {
    return this.status;
  }

  get warningList(): string[] {
    return [...this.warnings];
  }

  /** Seed entries in bake priority order. */
  list(): ModelManifestEntry[] {
    return [...this.entries];
  }

  byGeonameId(geonameId: number): ModelManifestEntry | null {
    return this.entriesById.get(geonameId) ?? null;
  }

  byKey(key: string): ModelManifestEntry | null {
    return this.entriesByKey.get(key) ?? null;
  }

  /**
   * Reads and validates a seed model from disk.
   *
   * Returns `null` (and logs a warning) when the file has been modified or
   * corrupted since startup; the caller then falls back to cache/generation.
   */
  async read(entry: ModelManifestEntry): Promise<ReadyModel | null> {
    let gzipped: Buffer;
    try {
      gzipped = await readFile(path.join(this.dir, entry.file));
    } catch (error) {
      log.warn(`seed ${entry.slug} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (gzipped.length !== entry.bytes) {
      log.warn(`seed ${entry.slug} has an unexpected size (${gzipped.length} != ${entry.bytes})`);
      return null;
    }
    if (sha256Hex(gzipped) !== entry.sha256) {
      log.warn(`seed ${entry.slug} checksum mismatch; refusing to serve it`);
      return null;
    }
    let model;
    try {
      model = await gunzipModel(gzipped);
    } catch (error) {
      log.warn(`seed ${entry.slug} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (model.key !== entry.key) {
      log.warn(`seed ${entry.slug} contains model ${model.key}, expected ${entry.key}`);
      return null;
    }
    if (model.city.geonameId !== entry.geonameId) {
      log.warn(`seed ${entry.slug} contains city ${String(model.city.geonameId)}, expected ${entry.geonameId}`);
      return null;
    }
    return {
      state: 'ready',
      resolved: {
        key: entry.key,
        target: { kind: 'city', geonameId: entry.geonameId },
        city: model.city,
        seedSlug: entry.slug
      },
      meta: model.meta,
      etag: quotedEtag(entry.sha256),
      bytes: gzipped.length,
      gzipped
    };
  }
}

async function verifySeedFile(
  dir: string,
  entry: ModelManifestEntry,
  options: { modelVersion: number; radiusM: number }
): Promise<string | null> {
  let gzipped: Buffer;
  try {
    gzipped = await readFile(path.join(dir, entry.file));
  } catch (error) {
    return `unreadable seed file (${error instanceof Error ? error.message : String(error)})`;
  }
  if (gzipped.length !== entry.bytes) return 'seed file size does not match the manifest';
  if (sha256Hex(gzipped) !== entry.sha256) return 'seed file checksum does not match the manifest';
  let model;
  try {
    model = await gunzipModel(gzipped);
  } catch (error) {
    return `seed file is corrupt (${error instanceof Error ? error.message : String(error)})`;
  }
  if (model.key !== entry.key) return 'seed model key does not match the manifest';
  if (model.v !== options.modelVersion) return 'seed model version does not match the manifest';
  if (!model.meta.seed) return 'seed model is not marked as a seed';
  if (model.city.geonameId !== entry.geonameId) return 'seed model city does not match the manifest';
  if (model.meta.radiusM !== options.radiusM) return 'seed model radius does not match the runtime radius';
  return null;
}

function parseEntry(candidate: unknown, manifestVersion: number, manifestRadius: number): ModelManifestEntry | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Record<string, unknown>;
  const slug = typeof value.slug === 'string' ? value.slug : '';
  const file = typeof value.file === 'string' ? value.file : `${slug}.json.gz`;
  const geonameId = value.geonameId;
  const key = typeof value.key === 'string' ? value.key : '';
  const sha256 = typeof value.sha256 === 'string' ? value.sha256 : '';
  const bytes = value.bytes;
  const name = typeof value.name === 'string' ? value.name : '';
  if (!SAFE_SLUG.test(slug)) return null;
  if (!SAFE_FILE.test(file)) return null;
  if (!Number.isSafeInteger(geonameId) || (geonameId as number) <= 0) return null;
  if (!isValidModelKey(key)) return null;
  if (!HEX_SHA256.test(sha256)) return null;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) return null;
  if (!name) return null;
  const modelVersion = typeof value.modelVersion === 'number' ? value.modelVersion : manifestVersion;
  const radiusM = typeof value.radiusM === 'number' ? value.radiusM : manifestRadius;
  const source = typeof value.source === 'string' ? (value.source as CitySource) : 'seed';
  const generatedAt = typeof value.generatedAt === 'string' ? value.generatedAt : new Date(0).toISOString();
  const stats = isStats(value.stats) ? value.stats : undefined;
  return {
    slug,
    geonameId: geonameId as number,
    name,
    key,
    file,
    bytes: bytes as number,
    sha256,
    modelVersion,
    radiusM,
    source,
    generatedAt,
    ...(stats ? { stats } : {})
  };
}

function isStats(value: unknown): value is ModelStats {
  if (!value || typeof value !== 'object') return false;
  const stats = value as Record<string, unknown>;
  return ['buildings', 'roads', 'areas', 'dropped'].every(
    (field) => typeof stats[field] === 'number' && Number.isSafeInteger(stats[field]) && (stats[field] as number) >= 0
  );
}

/** Thrown by helpers that need a seed entry guaranteed to exist (unused paths throw 404). */
export function missingSeedError(slugOrId: string | number): CityError {
  return new CityError('SEED_UNAVAILABLE', `No pre-baked seed model exists for ${String(slugOrId)}.`, 404, false);
}
