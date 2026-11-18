/**
 * Public facade types for the city service.
 *
 * These are re-exported from `server/city/service.ts`, which is the module the
 * API layer imports; keeping them in a leaf module avoids import cycles between
 * the service, cache and seed store.
 */

import type {
  CachedArea,
  CityInfo,
  CitySearchResponse,
  HealthCheck,
  HealthWorkerInfo,
  JobStatus,
  ModelMeta,
  ModelTarget,
  NearestCityResponse
} from '../../shared/types.ts';

export interface ResolvedTarget {
  /** Cache/URL key, e.g. `gn-683844-r900-v1`. */
  key: string;
  target: ModelTarget;
  city: CityInfo;
  /** Slug when a bundled pre-baked seed exists for this city. */
  seedSlug: string | null;
}

export interface ReadyModel {
  state: 'ready';
  resolved: ResolvedTarget;
  meta: ModelMeta;
  /** Strong ETag (quoted SHA-256 hex of the gzipped bytes). */
  etag: string;
  /** Gzipped payload size in bytes. */
  bytes: number;
  gzipped: Buffer;
}

export interface QueuedModel {
  state: 'queued';
  resolved: ResolvedTarget;
  jobId: string;
}

export type EnsureModelResult = ReadyModel | QueuedModel;

/** Per-call generation options supplied by the API layer. */
export interface EnsureModelOptions {
  /** Stable client identity used for the per-client job cap. */
  clientId?: string;
  /** Pre-resolved target to avoid resolving (and scanning the index) twice. */
  resolved?: ResolvedTarget;
}

export interface CachedAreaQuery {
  lat: number;
  lon: number;
  radiusM: number;
}

export interface CityServiceHealth {
  cache: { models: number; bytes: number; maxBytes: number };
  queue: { active: number; queued: number };
  providers: Record<string, 'up' | 'down' | 'unknown'>;
  seeds: { count: number; slugs: string[] };
  /** True when the core serving contract is available. */
  ready: boolean;
  /** True when the service is serving with reduced capability. */
  degraded: boolean;
  checks: HealthCheck[];
  worker: HealthWorkerInfo;
}

export interface CityService {
  init(): Promise<void>;
  search(query: string, limit?: number): CitySearchResponse;
  nearest(lat: number, lon: number): NearestCityResponse | null;
  resolve(target: ModelTarget): ResolvedTarget;
  ensureModel(target: ModelTarget, options?: EnsureModelOptions): Promise<EnsureModelResult>;
  getJob(jobId: string): JobStatus | null;
  cancelJob(jobId: string): boolean;
  readModel(key: string): Promise<ReadyModel | null>;
  cachedAreas(limit?: number, near?: CachedAreaQuery): CachedArea[];
  health(): CityServiceHealth;
  shutdown(): Promise<void>;
}
