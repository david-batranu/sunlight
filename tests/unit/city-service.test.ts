/**
 * City service facade tests: fixture provider end-to-end (queue → worker →
 * cache → readModel), seeds-only mode, resolution, health and shutdown.
 *
 * No network: the fixture provider and a temporary cache/seed directory are
 * used everywhere.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import type { CityService } from '../../server/city/contract.ts';
import { CityError } from '../../server/city/errors.ts';
import { createCityService } from '../../server/city/service.ts';
import { MODEL_VERSION } from '../../shared/constants.ts';
import type { JobStatus } from '../../shared/types.ts';
import {
  BRASOV_CITY,
  FIXED_TIMESTAMP,
  makeTempDir,
  makeTestConfig,
  removeTempDir,
  writeSeedDir
} from './city-helpers.ts';

process.env.SUNLIGHT_LOG_LEVEL = process.env.SUNLIGHT_LOG_LEVEL ?? 'error';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withService(
  overrides: Parameters<typeof makeTestConfig>[1],
  run: (service: CityService, dir: string) => Promise<void>
): Promise<void> {
  const dir = await makeTempDir('sunlight-service-');
  const service = createCityService(makeTestConfig(dir, overrides));
  try {
    await service.init();
    await run(service, dir);
  } finally {
    await service.shutdown();
    await removeTempDir(dir);
  }
}

async function waitForJob(service: CityService, jobId: string, timeoutMs = 5000): Promise<JobStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = service.getJob(jobId);
    if (status && (status.state === 'done' || status.state === 'error' || status.state === 'cancelled')) return status;
    await delay(10);
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

test('search/resolve are unavailable before init and health is safe', async () => {
  const dir = await makeTempDir('sunlight-service-');
  const service = createCityService(makeTestConfig(dir));
  try {
    assert.throws(
      () => service.search('brasov'),
      (error: unknown) => error instanceof CityError && error.code === 'NOT_INITIALIZED' && error.status === 503
    );
    const health = service.health();
    assert.deepEqual(health.cache, { models: 0, bytes: 0, maxBytes: 64 * 1024 * 1024 });
    assert.deepEqual(health.queue, { active: 0, queued: 0 });
    assert.deepEqual(health.seeds, { count: 0, slugs: [] });
    assert.equal(service.getJob('nope'), null);
    assert.equal(service.cancelJob('nope'), false);
    assert.equal(await service.readModel('gn-683844-r900-v1'), null);
    await service.shutdown();
    await service.shutdown(); // idempotent
  } finally {
    await removeTempDir(dir);
  }
});

test('search, nearest and resolve work against the bundled index', async () => {
  await withService({}, async (service) => {
    const search = service.search('brasov', 5);
    assert.ok(search.results.length > 0);
    assert.equal(search.results[0].geonameId, 683844);
    assert.equal(search.results[0].seed, false);
    assert.deepEqual(service.search('   ').results, []);
    assert.deepEqual(service.search('zzzzqqqq').results, []);

    const nearest = service.nearest(45.64861, 25.60613);
    assert.ok(nearest);
    assert.equal(nearest.city.geonameId, 683844);
    assert.ok(nearest.distanceKm < 0.01);

    assert.throws(
      () => service.nearest(91, 25),
      (error: unknown) => error instanceof CityError && error.code === 'INVALID_COORDINATES' && error.status === 400
    );
    assert.throws(
      () => service.nearest(45, 181),
      (error: unknown) => error instanceof CityError && error.code === 'INVALID_COORDINATES'
    );

    const resolved = service.resolve({ kind: 'city', geonameId: 683844 });
    assert.equal(resolved.key, 'gn-683844-r900-v1');
    assert.deepEqual(resolved.target, { kind: 'city', geonameId: 683844 });
    assert.equal(resolved.city.geonameId, 683844);
    assert.equal(resolved.city.tz, 'Europe/Bucharest');
    assert.equal(resolved.seedSlug, null);

    const point = service.resolve({ kind: 'point', lat: 45.65, lon: 25.6 });
    assert.equal(point.key, 'pt-45.65000_25.60000-r900-v1');
    assert.equal(point.city.geonameId, null);
    assert.equal(point.city.country, 'RO');
    assert.equal(point.city.tz, 'Europe/Bucharest');
    assert.ok(point.city.name.endsWith('area'));

    const named = service.resolve({ kind: 'point', lat: 45.65, lon: 25.6, name: '  My   Place ' });
    assert.equal(named.city.name, 'My Place');
    assert.deepEqual(named.target, { kind: 'point', lat: 45.65, lon: 25.6, name: 'My Place' });

    assert.throws(
      () => service.resolve({ kind: 'city', geonameId: 999_999_999 }),
      (error: unknown) => error instanceof CityError && error.code === 'CITY_NOT_FOUND' && error.status === 404
    );
    assert.throws(
      () => service.resolve({ kind: 'city', geonameId: 0 }),
      (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
    );
    assert.throws(
      () => service.resolve({ kind: 'nope' } as never),
      (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
    );
    assert.throws(
      () => service.resolve({ kind: 'point', lat: 100, lon: 0 }),
      (error: unknown) => error instanceof CityError && error.code === 'INVALID_COORDINATES'
    );
  });
});

test('generates a city model end to end with fixture provider and worker', async () => {
  await withService({}, async (service, dir) => {
    const resolved = service.resolve({ kind: 'city', geonameId: 683844 });
    const startedAt = Date.now();
    const ensured = await service.ensureModel({ kind: 'city', geonameId: 683844 });
    const elapsed = Date.now() - startedAt;
    assert.equal(ensured.state, 'queued');
    assert.ok(elapsed < 1000, `ensureModel must not block generation (took ${elapsed}ms)`);
    if (ensured.state !== 'queued') throw new Error('unreachable');
    assert.equal(ensured.resolved.key, resolved.key);
    assert.ok(ensured.jobId.length > 0);

    // Concurrent/duplicate requests for the same key share the job.
    const duplicate = await service.ensureModel({ kind: 'city', geonameId: 683844 });
    assert.equal(duplicate.state, 'queued');
    if (duplicate.state === 'queued') assert.equal(duplicate.jobId, ensured.jobId);

    // Collect progress while polling.
    const percents: number[] = [];
    let status = service.getJob(ensured.jobId);
    assert.ok(status);
    percents.push(status.progress.percent);
    const deadline = Date.now() + 5000;
    while (status && status.state !== 'done' && status.state !== 'error' && Date.now() < deadline) {
      assert.ok(status.progress.percent <= 100);
      percents.push(status.progress.percent);
      await delay(10);
      status = service.getJob(ensured.jobId);
    }
    assert.ok(status);
    assert.equal(status.state, 'done', JSON.stringify(status));
    assert.equal(status.progress.percent, 100);
    assert.equal(status.modelUrl, '/api/models/gn-683844-r900-v1');
    for (let i = 1; i < percents.length; i += 1) {
      assert.ok(percents[i] >= percents[i - 1], `progress must be monotonic: ${percents.join(',')}`);
    }

    const ready = await service.readModel(resolved.key);
    assert.ok(ready);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.meta.seed, false);
    assert.equal(ready.meta.radiusM, 900);
    assert.equal(ready.meta.stats.buildings, 12);
    assert.ok(ready.bytes > 0);
    assert.match(ready.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(ready.bytes, ready.gzipped.length);
    assert.equal(ready.resolved.key, resolved.key);

    // Subsequent ensureModel calls are served from cache.
    const again = await service.ensureModel({ kind: 'city', geonameId: 683844 });
    assert.equal(again.state, 'ready');
    if (again.state === 'ready') assert.equal(again.etag, ready.etag);

    assert.equal(await service.readModel('gn-1-r900-v1'), null);
    assert.equal(await service.readModel('../etc/passwd'), null);

    const health = service.health();
    assert.equal(health.cache.models >= 1, true);
    assert.ok(health.cache.bytes >= ready.bytes);
    assert.equal(health.queue.active, 0);
    assert.equal(health.queue.queued, 0);
    assert.equal(health.providers.fixture, 'up');
    assert.equal(health.providers.overpass, 'unknown');
    assert.equal(health.seeds.count, 0);

    // A fresh service instance serves the persisted cache without regenerating.
    await service.shutdown();
    const restarted = createCityService(makeTestConfig(dir));
    await restarted.init();
    try {
      const cached = await restarted.readModel(resolved.key);
      assert.ok(cached);
      assert.equal(cached.bytes, ready.bytes);
      assert.equal(cached.etag, ready.etag);
      assert.equal(restarted.health().cache.models >= 1, true);
    } finally {
      await restarted.shutdown();
    }
  });
});

test('generates arbitrary point models near a city', async () => {
  await withService({}, async (service) => {
    const point = { kind: 'point' as const, lat: 45.66, lon: 25.62 };
    const resolved = service.resolve(point);
    assert.match(resolved.key, /^pt-45\.66000_25\.62000-r900-v1$/);
    const ensured = await service.ensureModel(point);
    assert.equal(ensured.state, 'queued');
    if (ensured.state !== 'queued') return;
    const status = await waitForJob(service, ensured.jobId);
    assert.equal(status.state, 'done', JSON.stringify(status));
    const ready = await service.readModel(resolved.key);
    assert.ok(ready);
    assert.equal(ready.resolved.city.geonameId, null);
    assert.equal(ready.resolved.city.name, resolved.city.name);
    assert.equal(ready.meta.seed, false);
    assert.ok(ready.meta.stats.buildings > 0);
  });
});

test('seeds-only mode serves bundled seeds and refuses generation', async () => {
  const dir = await makeTempDir('sunlight-service-');
  try {
    const seedsDir = path.join(dir, 'seeds');
    await writeSeedDir(seedsDir, [
      { slug: 'brasov', geonameId: 683844, name: 'Brașov', city: BRASOV_CITY }
    ]);
    const service = createCityService(
      makeTestConfig(dir, { seedsDir, citySource: 'seed', seedsOnly: true })
    );
    try {
      await service.init();
      const health = service.health();
      assert.equal(health.seeds.count, 1);
      assert.deepEqual(health.seeds.slugs, ['brasov']);
      assert.equal(health.providers.seed, 'up');

      const search = service.search('brasov', 1);
      assert.equal(search.results[0].seed, true);
      assert.equal(search.results[0].seedSlug, 'brasov');

      const resolved = service.resolve({ kind: 'city', geonameId: 683844 });
      assert.equal(resolved.seedSlug, 'brasov');
      assert.equal(resolved.city.name, 'Brașov');

      const ensured = await service.ensureModel({ kind: 'city', geonameId: 683844 });
      assert.equal(ensured.state, 'ready');
      if (ensured.state !== 'ready') return;
      assert.equal(ensured.meta.seed, true);
      assert.equal(ensured.meta.source, 'seed');
      assert.match(ensured.etag, /^"[0-9a-f]{64}"$/);
      assert.equal(ensured.resolved.seedSlug, 'brasov');

      const read = await service.readModel(resolved.key);
      assert.ok(read);
      assert.equal(read.meta.seed, true);

      await assert.rejects(
        service.ensureModel({ kind: 'city', geonameId: 683506 }),
        (error: unknown) => error instanceof CityError && error.code === 'SEED_UNAVAILABLE' && error.status === 404
      );
      await assert.rejects(
        service.ensureModel({ kind: 'point', lat: 45.65, lon: 25.6 }),
        (error: unknown) => error instanceof CityError && error.code === 'SEED_UNAVAILABLE'
      );
    } finally {
      await service.shutdown();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('seeds-only mode still serves previously generated cache entries', async () => {
  const dir = await makeTempDir('sunlight-service-');
  try {
    const fixtureService = createCityService(makeTestConfig(dir));
    await fixtureService.init();
    const key = 'gn-683844-r900-v1';
    try {
      const ensured = await fixtureService.ensureModel({ kind: 'city', geonameId: 683844 });
      assert.equal(ensured.state, 'queued');
      if (ensured.state === 'queued') {
        const status = await waitForJob(fixtureService, ensured.jobId);
        assert.equal(status.state, 'done');
      }
    } finally {
      await fixtureService.shutdown();
    }

    const seedsOnlyService = createCityService(
      makeTestConfig(dir, { citySource: 'seed', seedsOnly: true })
    );
    try {
      await seedsOnlyService.init();
      const ensured = await seedsOnlyService.ensureModel({ kind: 'city', geonameId: 683844 });
      assert.equal(ensured.state, 'ready');
      if (ensured.state === 'ready') {
        assert.equal(ensured.resolved.key, key);
        assert.equal(ensured.meta.seed, false);
      }
      assert.ok(await seedsOnlyService.readModel(key));
    } finally {
      await seedsOnlyService.shutdown();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('cancelJob handles unknown and active jobs', async () => {
  await withService({}, async (service) => {
    assert.equal(service.cancelJob('not-a-job'), false);
    const ensured = await service.ensureModel({ kind: 'city', geonameId: 683844 });
    assert.equal(ensured.state, 'queued');
    if (ensured.state !== 'queued') return;
    const cancelled = service.cancelJob(ensured.jobId);
    if (cancelled) {
      const status = service.getJob(ensured.jobId);
      assert.equal(status?.state, 'cancelled');
      // Retrying after cancellation creates a fresh job that can finish.
      const retry = await service.ensureModel({ kind: 'city', geonameId: 683844 });
      assert.equal(retry.state, 'queued');
      if (retry.state === 'queued') {
        assert.notEqual(retry.jobId, ensured.jobId);
        await waitForJob(service, retry.jobId);
      }
    } else {
      const status = await waitForJob(service, ensured.jobId);
      assert.ok(status.state === 'done' || status.state === 'error');
    }
    assert.equal(await service.readModel('gn-683844-r900-v1').then((model) => model !== null), true);
  });
});

test('init is idempotent and model version is embedded in keys', async () => {
  await withService({}, async (service) => {
    await service.init();
    const resolved = service.resolve({ kind: 'city', geonameId: 683844 });
    assert.ok(resolved.key.endsWith(`-v${MODEL_VERSION}`));
    assert.equal(resolved.key, `gn-683844-r900-v${MODEL_VERSION}`);
    assert.equal(service.health().cache.maxBytes, 64 * 1024 * 1024);
  });
});

test('point nearby-city naming and country come from the index', async () => {
  await withService({}, async (service) => {
    const near = service.resolve({ kind: 'point', lat: 45.7, lon: 25.7 });
    assert.ok(near.city.name.endsWith(' area'));
    assert.equal(near.city.country, 'RO');
    const far = service.resolve({ kind: 'point', lat: 0, lon: 0 });
    assert.equal(far.city.country, '');
    assert.match(far.city.name, /^0\.000, 0\.000$/);
    assert.ok(far.city.tz.length > 0);
  });
});
