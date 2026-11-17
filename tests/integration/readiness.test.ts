/**
 * Health vs readiness semantics.
 *
 * `/api/health` is the orchestration probe and stays 200 for a degraded but
 * serving deployment; `/api/ready` is the strict readiness probe and returns
 * 503 when the service has no model source at all.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { HealthResponse } from '../../shared/types.ts';
import { loadConfig, type AppConfig } from '../../server/config.ts';
import { startSunlightApp, type RunningApp } from '../../server/app.ts';

const tempDirs: string[] = [];
let app: RunningApp;

function unusableConfig(): AppConfig {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'sunlight-unready-'));
  tempDirs.push(cacheDir);
  const config = loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CACHE_DIR: cacheDir,
    CITY_SOURCE: 'seed',
    SEEDS_ONLY: '1',
    RATE_LIMIT_PER_MIN: '0',
    READ_RATE_LIMIT_PER_MIN: '0',
    SKY_RATE_LIMIT_PER_MIN: '0'
  });
  // No bundled seeds and live generation disabled: nothing can be served.
  config.seedsDir = path.join(cacheDir, 'seeds');
  return config;
}

before(async () => {
  app = await startSunlightApp(unusableConfig(), { port: 0, host: '127.0.0.1' });
});

after(async () => {
  if (app) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('an unready service reports ok:false on /api/health but stays 200 for orchestration', async () => {
  const response = await fetch(`${app.url}/api/health`);
  assert.equal(response.status, 200, '/api/health must stay 200 while the process runs');
  const health = (await response.json()) as HealthResponse;
  assert.equal(health.ok, false);
  assert.equal(health.ready, false);
  assert.equal(health.degraded, true);
  assert.equal(health.status, 'unready');
  const generation = health.checks.find((check) => check.name === 'generation');
  assert.equal(generation?.ok, false);
});

test('/api/ready returns 503 with the same health payload', async () => {
  const response = await fetch(`${app.url}/api/ready`);
  assert.equal(response.status, 503);
  const health = (await response.json()) as HealthResponse;
  assert.equal(health.ready, false);
  assert.equal(health.status, 'unready');
});

test('an unready service still returns structured errors instead of crashing', async () => {
  const response = await fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { kind: 'city', geonameId: 683844 } })
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'SEED_UNAVAILABLE');

  const model = await fetch(`${app.url}/api/models/gn-683844-r1500-v4`);
  assert.equal(model.status, 404);
  assert.equal((await model.json()).error.code, 'MODEL_NOT_READY');
});
