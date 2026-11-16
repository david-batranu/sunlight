/**
 * Runtime configuration for the Sunlight application server.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CITY_GEONAME_ID, CITY_RADIUS_M } from '../shared/constants.ts';

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
  cacheMaxBytes: number;
  cityRadiusM: number;
  generationConcurrency: number;
  citySource: CitySourceMode;
  seedsOnly: boolean;
  defaultCityGeonameId: number;
  osmUserAgent: string;
  overpassEndpoints: string[];
  rateLimitPerMin: number;
  modelVersion: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    cacheMaxBytes: num(env.CACHE_MAX_MB, 1024) * 1024 * 1024,
    cityRadiusM: Math.min(1500, Math.max(600, num(env.CITY_RADIUS_M, CITY_RADIUS_M))),
    generationConcurrency: Math.min(4, Math.max(1, num(env.GENERATION_CONCURRENCY, 1))),
    citySource: sourceMode(env.CITY_SOURCE),
    seedsOnly: bool(env.SEEDS_ONLY),
    defaultCityGeonameId: num(env.DEFAULT_CITY?.replace(/^gn-/, ''), DEFAULT_CITY_GEONAME_ID),
    osmUserAgent: env.OSM_USER_AGENT || 'SunlightCity/0.1 (+https://example.com/sunlight)',
    overpassEndpoints: (env.OVERPASS_ENDPOINTS || 'https://overpass-api.de/api/interpreter')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitPerMin: Math.max(0, num(env.RATE_LIMIT_PER_MIN, 30)),
    modelVersion: 1
  };
}
