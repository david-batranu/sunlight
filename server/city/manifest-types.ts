/**
 * Shared manifest types for `server/data/seeds/manifest.json`.
 *
 * Kept in a leaf module so both the runtime seed store and
 * `scripts/bake-seeds.mjs` agree on the on-disk format.
 */

import type { CitySource, ModelStats } from '../../shared/types.ts';

export interface ModelManifestEntry {
  slug: string;
  geonameId: number;
  /** Curated display name (correct diacritics). */
  name: string;
  /** Model cache/URL key, e.g. `gn-683844-r900-v1`. */
  key: string;
  /** Gzipped model file name inside the seeds directory. */
  file: string;
  /** Gzipped file size in bytes. */
  bytes: number;
  /** SHA-256 (lowercase hex) of the gzipped file bytes. */
  sha256: string;
  modelVersion: number;
  radiusM: number;
  /** Provider that produced the raw OSM data (`overpass` or `osm-api`). */
  source: CitySource;
  generatedAt: string;
  stats?: ModelStats;
  /** True when the bake produced an incomplete (terrain/coverage) model. */
  degraded?: boolean;
}

export interface SeedManifest {
  v: number;
  modelVersion: number;
  radiusM: number;
  generatedAt: string;
  attribution: string;
  cities: ModelManifestEntry[];
}
