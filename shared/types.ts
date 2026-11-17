/**
 * Wire contracts shared by the server, the SPA and tests.
 *
 * All lengths in the persisted model are integer decimetres: 1 unit = 0.1 m.
 * The browser divides by 10 before handing geometry to Three.js.
 */

export type CitySource = 'overpass' | 'osm-api' | 'seed' | 'fixture' | 'cache';

export interface CityInfo {
  /** GeoNames id for indexed cities, null for arbitrary points. */
  geonameId: number | null;
  name: string;
  /** ISO 3166-1 alpha-2 country code, or "" when unknown. */
  country: string;
  lat: number;
  lon: number;
  tz: string;
}

export interface ModelStats {
  buildings: number;
  roads: number;
  areas: number;
  /** Footprints discarded because of MAX_BUILDINGS. */
  dropped: number;
}

export interface ModelMeta {
  generatedAt: string;
  source: CitySource;
  /** True when the model was served from a bundled pre-baked seed. */
  seed: boolean;
  radiusM: number;
  stats: ModelStats;
  warnings: string[];
  attribution: string;
  timingsMs?: Record<string, number>;
  /**
   * True when a transient failure (terrain provider, partial upstream
   * coverage) produced a usable-but-incomplete model. Degraded models are
   * served with a short/no-store cache profile so they can be refreshed, and
   * seed baking treats them as stale.
   */
  degraded?: boolean;
  /** Human-readable reasons for `degraded` (bounded, no host paths). */
  degradedReasons?: string[];
}

export interface ModelBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxHeight: number;
}

/** Building type codes, used by the renderer's palette. */
export type BuildingType = 0 | 1 | 2 | 3; // 0 residential, 1 commercial, 2 civic, 3 industrial

export interface BuildingRecord {
  /** Flat outer ring: [x0, z0, x1, z1, ...], decimetres. */
  p: number[];
  /** Height in decimetres. */
  h: number;
  t: BuildingType;
  /** 1 when the renderer may add a simple pitched roof. */
  r?: 0 | 1;
  /** Display name for a landmark building (OSM name tag). */
  n?: string;
  /** Short kind label derived from OSM tags, e.g. "Church", "Museum", "Hotel". */
  k?: string;
}

/** 1 arterial, 2 primary, 3 secondary, 4 local/pedestrian, 5 hiking trail, 9 rail. */
export type RoadClass = 1 | 2 | 3 | 4 | 5 | 9;

export interface RoadRecord {
  c: RoadClass;
  p: number[];
  /** Road or street name from OSM. */
  n?: string;
}

/** 1 water, 2 park, 3 forest, 4 grass/plaza. */
export interface AreaRecord {
  k: number;
  p: number[];
  holes?: number[][];
  /** Park, water or square name from OSM. */
  n?: string;
}

/**
 * Terrain heightfield over the model square.
 *
 * Sample grid: `cols` × `rows` points in model space, row-major from the
 * north-west corner (`x0`, `z0`) and increasing east (+X) / south (+Z).
 * Heights are non-negative integer decimetres above `baseM`, so the wire
 * payload stays compact; `baseM` records the absolute elevation of h = 0.
 */
export interface TerrainRecord {
  /** West-most sample coordinate in decimetres. */
  x0: number;
  /** North-most sample coordinate in decimetres. */
  z0: number;
  /** Sample spacing in decimetres. */
  step: number;
  cols: number;
  rows: number;
  /** Row-major heights above `baseM`, in decimetres, length cols × rows. */
  h: number[];
  /** Absolute elevation in metres represented by a height of zero. */
  baseM: number;
  /** Human-readable elevation source, e.g. "AWS Terrain Tiles". */
  source?: string;
}

export interface CityModel {
  v: number;
  key: string;
  city: CityInfo;
  meta: ModelMeta;
  bounds: ModelBounds;
  buildings: BuildingRecord[];
  roads: RoadRecord[];
  areas: AreaRecord[];
  /** Optional heightfield; omitted for flat models or when elevation failed. */
  terrain?: TerrainRecord;
}

/* ------------------------------------------------------------------ */
/* City search                                                         */
/* ------------------------------------------------------------------ */

export interface CitySearchResult {
  geonameId: number;
  name: string;
  asciiName: string;
  /** ISO country code. */
  country: string;
  countryName: string;
  lat: number;
  lon: number;
  tz: string;
  population: number;
  /** True when a bundled pre-baked seed model exists for this city. */
  seed: boolean;
  seedSlug?: string;
}

export interface CitySearchResponse {
  results: CitySearchResult[];
}

export interface NearestCityResponse {
  city: CitySearchResult;
  distanceKm: number;
}

/* ------------------------------------------------------------------ */
/* Model generation                                                    */
/* ------------------------------------------------------------------ */

export type ModelTarget =
  | { kind: 'city'; geonameId: number }
  | { kind: 'point'; lat: number; lon: number; name?: string };

export interface CreateModelRequest {
  target: ModelTarget;
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export type GenerationStep = 'resolve' | 'seed' | 'cache' | 'fetch' | 'parse' | 'build' | 'write';

export interface JobProgress {
  step: GenerationStep;
  label: string;
  /** 0..100 */
  percent: number;
  detail?: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

export interface JobStatus {
  jobId: string;
  key: string;
  state: JobState;
  progress: JobProgress;
  startedAt: string;
  updatedAt: string;
  modelUrl?: string;
  error?: ApiError;
}

export interface CreateModelReady {
  state: 'ready';
  key: string;
  modelUrl: string;
}

export interface CreateModelQueued {
  state: 'queued';
  key: string;
  jobId: string;
  statusUrl: string;
}

export type CreateModelResponse = CreateModelReady | CreateModelQueued;

export interface ApiErrorBody {
  error: ApiError;
}

/* ------------------------------------------------------------------ */
/* Sky / ephemeris                                                     */
/* ------------------------------------------------------------------ */

/**
 * Per-local-minute samples. `sun` and `moon` are arrays of [altitudeDeg, azimuthDeg].
 * Azimuth is degrees clockwise from true north (0 = N, 90 = E).
 * Index i corresponds to local wall-clock minute i * stepMinutes.
 */
export interface SkyTrack {
  stepMinutes: number;
  sun: Array<[number, number]>;
  moon: Array<[number, number]>;
}

export interface SkyDay {
  v: number;
  /** City-local calendar date, YYYY-MM-DD. */
  date: string;
  tz: string;
  lat: number;
  lon: number;
  /** UTC offset used for the local noon of that date, in minutes. */
  utcOffsetMinutes: number;
  dayStartUtc: string;
  dayEndUtc: string;
  track: SkyTrack;
  sun: {
    rise: string | null;
    set: string | null;
    civilDawn: string | null;
    civilDusk: string | null;
    solarNoon: string | null;
    maxAltitudeDeg: number;
    /** ISO instants [start, end]. */
    goldenHourMorning: [string, string] | null;
    goldenHourEvening: [string, string] | null;
  };
  moon: {
    rise: string | null;
    set: string | null;
    /** 0 = new, 180 = full, 360 = new again. */
    phaseAngleDeg: number;
    /** 0..1 illuminated fraction of the visible disc. */
    illumination: number;
    phaseName: string;
  };
  polarDay: boolean;
  polarNight: boolean;
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type HealthStatus = 'ok' | 'degraded' | 'unready';

export interface HealthBuildInfo {
  /** Application/package version. */
  version: string;
  /** Commit SHA when the deployment provides GIT_SHA. */
  sha: string | null;
  /** Container image tag when the deployment provides IMAGE_TAG. */
  imageTag: string | null;
  /** Node.js runtime version. */
  node: string;
}

export interface HealthWorkerInfo {
  /** A worker entry exists and has not been disabled by a boot failure. */
  enabled: boolean;
  /** True once the worker failed and generation fell back in-process. */
  disabled: boolean;
  /** How many times a worker boot/crash triggered the in-process fallback. */
  fallbacks: number;
}

/**
 * `/api/health` and `/api/ready` payload.
 *
 * `ok` is false for both degraded and unready states; `ready` only reflects
 * whether the service can serve its core contract at all. `/api/ready` returns
 * 503 when `ready` is false; `/api/health` returns 200 while degraded so a
 * degraded-but-serving deployment is not restarted by orchestration.
 */
export interface HealthResponse {
  ok: boolean;
  ready: boolean;
  degraded: boolean;
  status: HealthStatus;
  version: string;
  build: HealthBuildInfo;
  modelVersion: number;
  uptimeSec: number;
  cache: { models: number; bytes: number; maxBytes: number };
  queue: { active: number; queued: number; maxQueued?: number };
  providers: Record<string, 'up' | 'down' | 'unknown'>;
  seeds: { count: number; slugs: string[] };
  worker: HealthWorkerInfo;
  checks: HealthCheck[];
  sky?: { entries: number };
  /** In-process request counters and a 256-sample p95 latency. */
  http?: {
    requests: number;
    errors: number;
    rateLimited: number;
    p95Ms: number;
  };
}

/* ------------------------------------------------------------------ */
/* Progress reporting contract for the generator                       */
/* ------------------------------------------------------------------ */

export interface ProgressReporter {
  (step: GenerationStep, percent: number, label: string, detail?: string): void;
}
