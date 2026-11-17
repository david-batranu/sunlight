/**
 * Health/readiness payload assembly shared by `/api/health` and `/api/ready`.
 */

import type { AppConfig } from '../config.ts';
import type { CityServiceHealth } from '../city/contract.ts';
import type { HealthResponse, HealthStatus } from '../../shared/types.ts';

/**
 * Builds the health payload from the city-service health snapshot.
 *
 * - `ok` is only true when the service is ready *and* fully degraded-free.
 * - `ready` is true when the core contract is serviceable (cache + at least one
 *   model source); `/api/ready` maps it to 200/503.
 * - `/api/health` stays 200 while degraded so orchestration does not restart a
 *   deployment that is still serving.
 */
export function buildHealthResponse(
  config: AppConfig,
  city: CityServiceHealth,
  sky: { entries: number },
  http?: HealthResponse['http'],
  uptimeSec = Math.round(process.uptime())
): HealthResponse {
  const ok = city.ready && !city.degraded;
  const status: HealthStatus = !city.ready ? 'unready' : city.degraded ? 'degraded' : 'ok';
  return {
    ok,
    ready: city.ready,
    degraded: city.degraded,
    status,
    version: config.version,
    build: {
      version: config.version,
      sha: config.gitSha,
      imageTag: config.imageTag,
      node: process.version
    },
    modelVersion: config.modelVersion,
    uptimeSec,
    cache: city.cache,
    queue: { ...city.queue, maxQueued: config.jobQueueMax },
    providers: city.providers,
    seeds: city.seeds,
    worker: city.worker,
    checks: city.checks,
    sky,
    ...(http ? { http } : {})
  };
}

/** HTTP status for a health payload: only an unready service is 503. */
export function healthHttpStatus(health: Pick<HealthResponse, 'ready'>): number {
  return health.ready ? 200 : 503;
}
