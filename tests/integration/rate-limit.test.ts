/**
 * Rate limiting: limiter window semantics plus HTTP integration with
 * proxy-aware client identities. Runs the real app with the fixture provider; no
 * network is touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig, type AppConfig } from '../../server/config.ts';
import { startSunlightApp, type RunningApp } from '../../server/app.ts';
import { FixedWindowRateLimiter } from '../../server/http/rate-limit.ts';

const tempDirs: string[] = [];
let app: RunningApp;

function configFor(): AppConfig {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'sunlight-rate-'));
  tempDirs.push(cacheDir);
  return loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CACHE_DIR: cacheDir,
    CITY_SOURCE: 'fixture',
    SEEDS_ONLY: '0',
    RATE_LIMIT_PER_MIN: '1',
    READ_RATE_LIMIT_PER_MIN: '2',
    SKY_RATE_LIMIT_PER_MIN: '1',
    TRUST_PROXY: '1',
    GENERATION_CONCURRENCY: '1',
    OSM_USER_AGENT: 'SunlightIntegrationTest/1.0'
  });
}

before(async () => {
  app = await startSunlightApp(configFor(), { port: 0, host: '127.0.0.1' });
});

after(async () => {
  if (app) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function headersFor(ip: string): Record<string, string> {
  return { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' };
}

async function postModel(target: unknown, ip: string): Promise<Response> {
  return fetch(`${app.url}/api/models`, {
    method: 'POST',
    headers: headersFor(ip),
    body: JSON.stringify({ target })
  });
}

async function get(pathname: string, ip: string): Promise<Response> {
  return fetch(`${app.url}${pathname}`, { headers: { 'X-Forwarded-For': ip } });
}

/* ------------------------------------------------------------------ */
/* Limiter unit behaviour                                              */
/* ------------------------------------------------------------------ */

test('fixed-window limiter resets after the window and reports Retry-After', () => {
  const limiter = new FixedWindowRateLimiter(2, 60_000);
  const start = 1_000_000;
  assert.equal(limiter.take('a', start).allowed, true);
  assert.equal(limiter.take('a', start + 10).allowed, true);
  const rejected = limiter.take('a', start + 20);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);
  assert.ok(rejected.retryAfterSec >= 59 && rejected.retryAfterSec <= 60, `got ${rejected.retryAfterSec}`);
  // A later rejection reports a decreasing (never zero) Retry-After.
  const later = limiter.take('a', start + 30_000);
  assert.equal(later.allowed, false);
  assert.ok(later.retryAfterSec >= 29 && later.retryAfterSec <= 30);
  // Other clients and the next window are unaffected.
  assert.equal(limiter.take('b', start + 20).allowed, true);
  assert.equal(limiter.take('a', start + 60_000).allowed, true);
});

test('a zero limit disables the limiter entirely', () => {
  const limiter = new FixedWindowRateLimiter(0);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.take('a').allowed, true);
  }
  assert.equal(limiter.perMinute, 0);
  assert.equal(limiter.tracked, 0);
});

/* ------------------------------------------------------------------ */
/* HTTP integration                                                    */
/* ------------------------------------------------------------------ */

test('invalid POST bodies do not consume generation quota', async () => {
  const ip = '198.51.100.1';
  for (const target of [
    { kind: 'nope' },
    { kind: 'city', geonameId: -1 },
    { kind: 'point', lat: 200, lon: 0 }
  ]) {
    const response = await postModel(target, ip);
    assert.equal(response.status, 400);
  }
  // The quota (one request/minute) is still available for a valid request.
  const valid = await postModel({ kind: 'city', geonameId: 683844 }, ip);
  assert.ok(valid.status === 200 || valid.status === 202, `unexpected status ${valid.status}`);
});

test('independent X-Forwarded-For clients get independent generation buckets', async () => {
  const first = await postModel({ kind: 'city', geonameId: 683844 }, '198.51.100.2');
  assert.ok(first.status === 200 || first.status === 202, `unexpected status ${first.status}`);

  const throttled = await postModel({ kind: 'city', geonameId: 683844 }, '198.51.100.2');
  assert.equal(throttled.status, 429);
  const retryAfter = throttled.headers.get('retry-after');
  assert.ok(retryAfter, '429 responses must include Retry-After');
  assert.ok(Number(retryAfter) >= 1);
  const body = await throttled.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.retryable, true);

  // Another client behind the same proxy is entirely unaffected.
  const secondClient = await postModel({ kind: 'city', geonameId: 683844 }, '198.51.100.3');
  assert.ok(
    secondClient.status === 200 || secondClient.status === 202,
    `unexpected status ${secondClient.status} for a fresh client`
  );
});

test('X-Real-IP is honoured when X-Forwarded-For is absent', async () => {
  const url = `${app.url}/api/models`;
  const target = JSON.stringify({ target: { kind: 'city', geonameId: 683844 } });
  const first = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.4' },
    body: target
  });
  assert.ok(first.status === 200 || first.status === 202);
  const throttled = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.4' },
    body: target
  });
  assert.equal(throttled.status, 429);
});

test('read endpoints are rate limited, health is exempt', async () => {
  const ip = '198.51.100.5';
  assert.equal((await get('/api/cities?q=brasov&limit=3', ip)).status, 200);
  assert.equal((await get('/api/cities/nearest?lat=45.6&lon=25.6', ip)).status, 200);
  const throttled = await get('/api/cities?q=cluj&limit=3', ip);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);

  // Health/readiness never consume nor are blocked by the limit buckets.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await get('/api/health', ip)).status, 200);
    assert.equal((await get('/api/ready', ip)).status, 200);
  }
});

test('sky requests are rate limited per client', async () => {
  const ip = '198.51.100.6';
  const pathQuery = '/api/sky?lat=45.64861&lon=25.60613&date=2026-06-21';
  assert.equal((await get(pathQuery, ip)).status, 200);
  const throttled = await get(pathQuery, ip);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
});

test('invalid read parameters do not consume read quota', async () => {
  const ip = '198.51.100.7';
  // Two invalid reads (bad query / bad coordinates) must not use the 2/minute budget.
  assert.equal((await get('/api/cities?q=', ip)).status, 400);
  assert.equal((await get('/api/cities/nearest?lat=999&lon=0', ip)).status, 400);
  assert.equal((await get('/api/cities?q=brasov', ip)).status, 200);
  assert.equal((await get('/api/cities?q=cluj', ip)).status, 200);
  assert.equal((await get('/api/cities?q=sibiu', ip)).status, 429);
});
