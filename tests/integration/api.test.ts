/**
 * HTTP integration tests. Runs the real app with the fixture city provider and
 * a temporary cache; no external network is touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { CityModel, CreateModelResponse, JobStatus, SkyDay } from '../../shared/types.ts';
import { loadConfig, type AppConfig } from '../../server/config.ts';
import { startSunlightApp, type RunningApp } from '../../server/app.ts';

const tempDirs: string[] = [];
let app: RunningApp;

function configFor(cacheDir: string): AppConfig {
  return loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CACHE_DIR: cacheDir,
    CITY_SOURCE: 'fixture',
    SEEDS_ONLY: '0',
    RATE_LIMIT_PER_MIN: '0',
    GENERATION_CONCURRENCY: '1',
    OSM_USER_AGENT: 'SunlightIntegrationTest/1.0'
  });
}

before(async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'sunlight-int-'));
  tempDirs.push(cacheDir);
  app = await startSunlightApp(configFor(cacheDir), { port: 0, host: '127.0.0.1' });
});

after(async () => {
  if (app) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function postModel(target: unknown): Promise<{ status: number; body: CreateModelResponse }> {
  const response = await fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target })
  });
  return { status: response.status, body: (await response.json()) as CreateModelResponse };
}

async function pollUntilDone(jobId: string, timeoutMs = 20_000): Promise<JobStatus> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${app.url}/api/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200);
    const job = (await response.json()) as JobStatus;
    if (job.state === 'done') return job;
    if (job.state === 'error' || job.state === 'cancelled') {
      assert.fail(`job ended as ${job.state}: ${job.error?.message ?? 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert.fail(`job ${jobId} did not finish in ${timeoutMs}ms`);
}

test('health reports a ready, seed-aware service', async () => {
  const response = await fetch(`${app.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.modelVersion, 2);
  assert.ok(health.cache);
  assert.ok(Array.isArray(health.seeds.slugs));
});

test('city search is diacritic-insensitive and flags seeds', async () => {
  const response = await fetch(`${app.url}/api/cities?q=brasov&limit=5`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { results: Array<{ name: string; geonameId: number; seed: boolean }> };
  assert.ok(body.results.length > 0, 'expected search results');
  const brasov = body.results.find((city) => city.geonameId === 683844);
  assert.ok(brasov, 'expected Brașov in search results');
  assert.equal(brasov.seed, true);
});

test('nearest city resolves coordinates', async () => {
  const response = await fetch(`${app.url}/api/cities/nearest?lat=45.64861&lon=25.60613`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { city: { geonameId: number }; distanceKm: number };
  assert.equal(body.city.geonameId, 683844);
  assert.ok(body.distanceKm < 5);
});

test('generates a model with the fixture provider, then serves it from cache with ETag', async () => {
  const created = await postModel({ kind: 'city', geonameId: 683844 });
  assert.ok(created.status === 200 || created.status === 202, `unexpected status ${created.status}`);
  let modelUrl: string;
  if (created.body.state === 'queued') {
    const job = await pollUntilDone(created.body.jobId);
    modelUrl = job.modelUrl || `/api/models/${encodeURIComponent(created.body.key)}`;
  } else {
    modelUrl = created.body.modelUrl;
  }

  const first = await fetch(`${app.url}${modelUrl}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  const etag = first.headers.get('etag');
  assert.ok(etag && etag.length > 4);
  const model = (await first.json()) as CityModel;
  assert.equal(model.v, 2);
  assert.equal(model.city.geonameId, 683844);
  assert.ok(model.buildings.length > 0, 'fixture model should contain buildings');
  assert.ok(model.meta.radiusM >= 600);

  const second = await fetch(`${app.url}${modelUrl}`, { headers: { 'If-None-Match': etag! } });
  assert.equal(second.status, 304);

  const createdAgain = await postModel({ kind: 'city', geonameId: 683844 });
  assert.equal(createdAgain.status, 200);
  assert.equal(createdAgain.body.state, 'ready');
});

test('concurrent requests for the same new city share one job', async () => {
  const target = { kind: 'point', lat: 45.7, lon: 25.5, name: 'Test point' };
  const [a, b] = await Promise.all([postModel(target), postModel(target)]);
  assert.ok(a.status === 200 || a.status === 202);
  assert.ok(b.status === 200 || b.status === 202);
  if (a.body.state === 'queued' && b.body.state === 'queued') {
    assert.equal(a.body.jobId, b.body.jobId);
    await pollUntilDone(a.body.jobId);
  } else {
    const queued = a.body.state === 'queued' ? a.body : b.body.state === 'queued' ? b.body : null;
    if (queued && queued.state === 'queued') await pollUntilDone(queued.jobId);
  }

  // Point keys contain dots/underscores; make sure the model route accepts them.
  const point = await postModel(target);
  const key = point.body.state === 'ready' ? point.body.key : (point.body as { key: string }).key;
  const model = await fetch(`${app.url}/api/models/${encodeURIComponent(key)}`);
  assert.equal(model.status, 200, 'point model keys must be routeable');
});

test('sky endpoint returns a complete local-day track and caches it', async () => {
  const response = await fetch(`${app.url}/api/sky?lat=45.64861&lon=25.60613&date=2026-06-21`);
  assert.equal(response.status, 200);
  const etag = response.headers.get('etag');
  const sky = (await response.json()) as SkyDay;
  assert.equal(sky.date, '2026-06-21');
  assert.equal(sky.tz, 'Europe/Bucharest');
  assert.equal(sky.track.stepMinutes, 5);
  assert.equal(sky.track.sun.length, 289);
  assert.equal(sky.track.moon.length, 289);
  assert.ok(sky.sun.rise !== null);
  assert.ok(sky.sun.set !== null);
  assert.ok(sky.moon.phaseName.length > 0);
  assert.ok(sky.sun.maxAltitudeDeg > 60 && sky.sun.maxAltitudeDeg < 75);

  const revalidated = await fetch(`${app.url}/api/sky?lat=45.64861&lon=25.60613&date=2026-06-21`, {
    headers: etag ? { 'If-None-Match': etag } : {}
  });
  assert.equal(revalidated.status, 304);
});

test('sky endpoint rejects dates outside 1900-2100 and malformed params', async () => {
  for (const url of [
    '/api/sky?lat=45.6&lon=25.6&date=1899-12-31',
    '/api/sky?lat=45.6&lon=25.6&date=2101-01-01',
    '/api/sky?lat=91&lon=25.6&date=2026-06-21',
    '/api/sky?lat=45.6&lon=25.6&date=not-a-date'
  ]) {
    const response = await fetch(`${app.url}${url}`);
    assert.equal(response.status, 400, url);
  }
});

test('invalid model targets and missing resources return structured errors', async () => {
  const invalid = await fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { kind: 'city', geonameId: -1 } })
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, 'INVALID_TARGET');

  const unknownJob = await fetch(`${app.url}/api/jobs/does-not-exist`);
  assert.equal(unknownJob.status, 404);

  const unknownModel = await fetch(`${app.url}/api/models/gn-1-r1500-v2`);
  assert.equal(unknownModel.status, 404);

  const unknownCity = await postModel({ kind: 'city', geonameId: 999999999 });
  assert.equal(unknownCity.status, 404);
});
