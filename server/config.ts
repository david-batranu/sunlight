/**
 * Runtime configuration for the Sunlight application server.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITY_RADIUS_M, MODEL_VERSION } from '../shared/constants.ts';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export type CitySourceMode = 'auto' | 'overpass' | 'osm-api' | 'fixture' | 'seed';

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  seedsDir: string;
  fixtureDir: string;
  cacheDir: string;
  staticDir: string;
  port: number;
  host: string;
  /** 0 disables the persistent disk cache entirely (no writes, nothing served). */
  cacheMaxBytes: number;
  cityRadiusM: number;
  generationConcurrency: number;
  citySource: CitySourceMode;
  seedsOnly: boolean;
  osmUserAgent: string;
  overpassEndpoints: string[];
  /** Generation requests per client per minute; 0 disables the limit. */
  rateLimitPerMin: number;
  /** `/api/cities` + `/api/cities/nearest` requests per client per minute; 0 disables. */
  readRateLimitPerMin: number;
  /** `/api/sky` requests per client per minute; 0 disables. */
  skyRateLimitPerMin: number;
  /** Trust `X-Forwarded-For`/`X-Real-IP` from a reverse proxy. */
  trustProxy: boolean;
  /** When non-empty, proxy headers are only accepted from these peers (CIDRs). */
  trustedProxyCidrs: string[];
  /** Maximum queued (not running) generation jobs; 1..N. */
  jobQueueMax: number;
  /** Maximum active+queued generation jobs per client; 0 disables the cap. */
  jobPerClientMax: number;
  queueMaxAgeSec: number;
  /** How long a failed model key is negative-cached before it may be retried (s). */
  failureCooldownSec: number;
  /** Public application version (package.json unless overridden). */
  version: string;
  /** Commit SHA of the running build, when provided by the deployment. */
  gitSha: string | null;
  /** Container image tag of the running build, when provided by the deployment. */
  imageTag: string | null;
  modelVersion: number;
}

const MIB = 1024 * 1024;

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.floor(num(value, fallback));
  return Math.min(max, Math.max(min, n));
}

function bool(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function sourceMode(value: string | undefined): CitySourceMode {
  switch (value) {
    case 'overpass':
    case 'osm-api':
    case 'fixture':
    case 'seed':
      return value;
    default:
      return 'auto';
  }
}

/**
 * `CACHE_MAX_MB=0` explicitly disables the persistent cache (unlimited caching
 * is no longer representable; use a large positive value for that). Negative or
 * non-numeric values are configuration errors rather than silently clamped.
 */
function cacheMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.CACHE_MAX_MB;
  if (raw === undefined || raw.trim() === '') return 1024 * MIB;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes < 0) {
    throw new Error('CACHE_MAX_MB must be a non-negative number (0 disables the disk cache).');
  }
  return Math.floor(megabytes * MIB);
}

/** Package version, falling back to a sane literal when package.json is unavailable. */
function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch {
    /* packaged assets may not include package.json */
  }
  return '0.1.0';
}

function cidrList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    rootDir: ROOT,
    dataDir: path.join(ROOT, 'server', 'data'),
    seedsDir: path.join(ROOT, 'server', 'data', 'seeds'),
    fixtureDir: path.join(ROOT, 'server', 'data', 'fixtures'),
    cacheDir: path.resolve(ROOT, env.CACHE_DIR || path.join('.cache', 'sunlight')),
    staticDir: path.join(ROOT, 'dist'),
    port: num(env.PORT, 8090),
    host: env.HOST || '127.0.0.1',
    cacheMaxBytes: cacheMaxBytes(env),
    cityRadiusM: Math.min(1500, Math.max(600, num(env.CITY_RADIUS_M, CITY_RADIUS_M))),
    generationConcurrency: Math.min(4, Math.max(1, num(env.GENERATION_CONCURRENCY, 1))),
    citySource: sourceMode(env.CITY_SOURCE),
    seedsOnly: bool(env.SEEDS_ONLY),
    osmUserAgent: env.OSM_USER_AGENT || 'SunlightCity/0.1 (+https://example.com/sunlight)',
    overpassEndpoints: (env.OVERPASS_ENDPOINTS || 'https://overpass-api.de/api/interpreter')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitPerMin: Math.max(0, num(env.RATE_LIMIT_PER_MIN, 30)),
    readRateLimitPerMin: Math.max(0, num(env.READ_RATE_LIMIT_PER_MIN, 120)),
    skyRateLimitPerMin: Math.max(0, num(env.SKY_RATE_LIMIT_PER_MIN, 60)),
    trustProxy: bool(env.TRUST_PROXY),
    trustedProxyCidrs: cidrList(env.TRUSTED_PROXY_CIDRS),
    jobQueueMax: int(env.JOB_QUEUE_MAX, 8, 1, 1000),
    jobPerClientMax: int(env.JOB_PER_CLIENT_MAX, 2, 0, 1000),
    queueMaxAgeSec: int(env.QUEUE_MAX_AGE_SEC, 600, 0, 86_400),
    failureCooldownSec: int(env.FAILURE_COOLDOWN_SEC, 60, 0, 3600),
    version: env.SUNLIGHT_VERSION?.trim() || packageVersion(),
    gitSha: env.GIT_SHA?.trim() || null,
    imageTag: env.IMAGE_TAG?.trim() || null,
    modelVersion: MODEL_VERSION
  };
}
