/**
 * Queue saturation contract: when a client already has the maximum number of
 * generations in flight, a new request gets 503 + Retry-After (not a silent
 * queue blow-up). Uses a slow injected provider; no network is touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig, type AppConfig } from '../../server/config.ts';
import { startSunlightApp, type RunningApp } from '../../server/app.ts';
import type { ProviderChain } from '../../server/city/providers/chain.ts';
import { createCityService } from '../../server/city/service.ts';
import { loadRawCityFixture } from '../unit/city-helpers.ts';

const tempDirs: string[] = [];
let app: RunningApp;

function slowChain(delayMs: number): ProviderChain {
  return {
    canGenerate: true,
    async fetchRaw() {
      const raw = await loadRawCityFixture();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return raw;
    },
    statuses: () => ({ fixture: 'up' }),
    shutdown() {
      /* no-op */
    }
  };
}

before(async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'sunlight-saturation-'));
  tempDirs.push(cacheDir);
  const config: AppConfig = loadConfig({
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
    JOB_PER_CLIENT_MAX: '2',
    TRUST_PROXY: '1',
    OSM_USER_AGENT: 'SunlightIntegrationTest/1.0'
  });
  config.seedsDir = path.join(cacheDir, 'seeds');
  const cityService = createCityService(config, { providerChain: slowChain(1500) });
  app = await startSunlightApp(config, { port: 0, host: '127.0.0.1', cityService });
});

after(async () => {
  if (app) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function post(target: unknown, ip: string): Promise<Response> {
  return fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip
    },
    body: JSON.stringify({ target })
  });
}

test('per-client saturation returns 503 with Retry-After', async () => {
  const client = '198.51.100.50';
  const first = await post({ kind: 'city', geonameId: 683844 }, client);
  assert.equal(first.status, 202);
  const second = await post({ kind: 'point', lat: 45.66, lon: 25.62 }, client);
  assert.equal(second.status, 202);

  const saturated = await post({ kind: 'point', lat: 45.67, lon: 25.63 }, client);
  assert.equal(saturated.status, 503);
  assert.ok(Number(saturated.headers.get('retry-after')) >= 1, '503 must include Retry-After');
  const body = await saturated.json();
  assert.equal(body.error.code, 'CLIENT_JOB_LIMIT');
  assert.equal(body.error.retryable, true);

  // Other clients are unaffected by one client's backlog.
  const other = await post({ kind: 'point', lat: 45.68, lon: 25.64 }, '198.51.100.51');
  assert.equal(other.status, 202);
});

test('DELETE /api/jobs/:id cancels a queued generation and is idempotent-ish', async () => {
  const client = '198.51.100.60';
  const created = await post({ kind: 'point', lat: 45.70, lon: 25.70 }, client);
  assert.equal(created.status, 202);
  const body = await created.json();
  assert.equal(body.state, 'queued');

  const cancelled = await fetch(`${app.url}/api/jobs/${encodeURIComponent(body.jobId)}`, {
    method: 'DELETE'
  });
  assert.equal(cancelled.status, 204);

  const status = await fetch(`${app.url}/api/jobs/${encodeURIComponent(body.jobId)}`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).state, 'cancelled');

  const again = await fetch(`${app.url}/api/jobs/${encodeURIComponent(body.jobId)}`, {
    method: 'DELETE'
  });
  assert.equal(again.status, 404);
});
