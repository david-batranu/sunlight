/**
 * Degraded-model HTTP policy: models generated through a transient failure
 * (terrain provider down / partial coverage) are still served, but must not be
 * cached as one-year immutable responses.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { CityModel, CreateModelResponse, JobStatus } from '../../shared/types.ts';
import { loadConfig, type AppConfig } from '../../server/config.ts';
import { startSunlightApp, type RunningApp } from '../../server/app.ts';
import { createCityService, type CityServiceOptions } from '../../server/city/service.ts';
import type { ProviderChain } from '../../server/city/providers/chain.ts';
import { loadRawCityFixture } from '../unit/city-helpers.ts';

const tempDirs: string[] = [];
let app: RunningApp;
let config: AppConfig;
const MODEL_KEY = 'gn-683844-r1500-v4';

function appConfig(cacheDir: string): AppConfig {
  const config = loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CACHE_DIR: cacheDir,
    CITY_SOURCE: 'fixture',
    SEEDS_ONLY: '0',
    RATE_LIMIT_PER_MIN: '0',
    READ_RATE_LIMIT_PER_MIN: '0',
    SKY_RATE_LIMIT_PER_MIN: '0',
    GENERATION_CONCURRENCY: '1',
    OSM_USER_AGENT: 'SunlightIntegrationTest/1.0'
  });
  // Force the generation path: an empty seed directory means the bundled
  // Brașov seed can not short-circuit the fixture provider.
  config.seedsDir = path.join(cacheDir, 'seeds');
  return config;
}

before(async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'sunlight-degraded-'));
  tempDirs.push(cacheDir);
  config = appConfig(cacheDir);

  const raw = await loadRawCityFixture();
  const providerChain: ProviderChain = {
    canGenerate: true,
    async fetchRaw() {
      // Pretend the data came from the (live) provider chain so the terrain
      // sampler is attempted, then inject a terrain failure.
      return { ...raw, source: 'overpass' as const };
    },
    statuses: () => ({ overpass: 'up' }),
    shutdown() {
      /* no-op */
    }
  };
  const terrainFetcher = (async () => {
    throw new Error('terrain tiles returned HTTP 503');
  }) as unknown as NonNullable<CityServiceOptions['terrainFetcher']>;
  const cityService = createCityService(config, { providerChain, terrainFetcher });
  app = await startSunlightApp(config, { port: 0, host: '127.0.0.1', cityService });
});

after(async () => {
  if (app) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('a degraded model is served with a short cache profile, not immutable', async () => {
  const created = await fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { kind: 'city', geonameId: 683844 } })
  });
  assert.ok(created.status === 200 || created.status === 202, `unexpected status ${created.status}`);
  const createdBody = (await created.json()) as CreateModelResponse;
  let key = createdBody.key;
  if (createdBody.state === 'queued') {
    const deadline = Date.now() + 20_000;
    let job: JobStatus | null = null;
    while (Date.now() < deadline) {
      const poll: Response = await fetch(`${app.url}/api/jobs/${encodeURIComponent(createdBody.jobId)}`);
      assert.equal(poll.status, 200);
      const status = (await poll.json()) as JobStatus;
      if (status.state === 'done') {
        job = status;
        break;
      }
      assert.notEqual(status.state, 'error', status.error?.message ?? 'job failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(job, 'job did not finish in time');
    key = job.key;
  }
  assert.equal(key, MODEL_KEY);

  const response = await fetch(`${app.url}/api/models/${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(
    response.headers.get('cache-control'),
    'private, max-age=300',
    'degraded models must not be cached as immutable'
  );
  assert.equal(response.headers.get('x-model-degraded'), '1');
  const etag = response.headers.get('etag');
  assert.ok(etag);
  const model = (await response.json()) as CityModel;
  assert.equal(model.meta.degraded, true);
  assert.ok(model.meta.degradedReasons?.some((reason) => reason.includes('terrain')));
  assert.equal(model.terrain, undefined, 'the terrain sampler failed, so the model is flat');

  const revalidated = await fetch(`${app.url}/api/models/${encodeURIComponent(key)}`, {
    headers: { 'If-None-Match': etag! }
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('cache-control'), 'private, max-age=300');
});
