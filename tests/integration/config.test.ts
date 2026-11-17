/**
 * Runtime configuration tests: proxy/rate-limit/queue env parsing, cache limit
 * semantics and the public build identity.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../../server/config.ts';
import { REPO_ROOT } from '../unit/city-helpers.ts';

const MIB = 1024 * 1024;

test('defaults are safe for a directly exposed single-node deployment', () => {
  const config = loadConfig({});
  assert.equal(config.trustProxy, false);
  assert.deepEqual(config.trustedProxyCidrs, []);
  assert.equal(config.rateLimitPerMin, 30);
  assert.equal(config.readRateLimitPerMin, 120);
  assert.equal(config.skyRateLimitPerMin, 60);
  assert.equal(config.jobQueueMax, 8);
  assert.equal(config.jobPerClientMax, 2);
  assert.equal(config.failureCooldownSec, 60);
  assert.equal(config.cacheMaxBytes, 1024 * MIB);
  assert.equal(config.gitSha, null);
  assert.equal(config.imageTag, null);
  assert.equal(typeof config.version, 'string');
  assert.ok(config.version.length > 0);
  // DEFAULT_CITY was parsed but unused by the server; it must be gone rather
  // than silently ignored.
  assert.equal('defaultCityGeonameId' in config, false);
});

test('proxy, rate-limit, queue and build-identity env vars are parsed', () => {
  const config = loadConfig({
    TRUST_PROXY: '1',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32, 10.0.0.0/8 ,',
    RATE_LIMIT_PER_MIN: '12',
    READ_RATE_LIMIT_PER_MIN: '7',
    SKY_RATE_LIMIT_PER_MIN: '3',
    JOB_QUEUE_MAX: '4',
    JOB_PER_CLIENT_MAX: '1',
    FAILURE_COOLDOWN_SEC: '0',
    CACHE_MAX_MB: '512',
    GIT_SHA: 'abc123',
    IMAGE_TAG: 'sha-abc123',
    SUNLIGHT_VERSION: '9.9.9'
  });
  assert.equal(config.trustProxy, true);
  assert.deepEqual(config.trustedProxyCidrs, ['127.0.0.1/32', '10.0.0.0/8']);
  assert.equal(config.rateLimitPerMin, 12);
  assert.equal(config.readRateLimitPerMin, 7);
  assert.equal(config.skyRateLimitPerMin, 3);
  assert.equal(config.jobQueueMax, 4);
  assert.equal(config.jobPerClientMax, 1);
  assert.equal(config.failureCooldownSec, 0);
  assert.equal(config.cacheMaxBytes, 512 * MIB);
  assert.equal(config.gitSha, 'abc123');
  assert.equal(config.imageTag, 'sha-abc123');
  assert.equal(config.version, '9.9.9');
});

test('CACHE_MAX_MB=0 explicitly disables the cache; negatives are rejected', () => {
  assert.equal(loadConfig({ CACHE_MAX_MB: '0' }).cacheMaxBytes, 0);
  assert.equal(loadConfig({ CACHE_MAX_MB: '1' }).cacheMaxBytes, MIB);
  assert.throws(() => loadConfig({ CACHE_MAX_MB: '-1' }), /CACHE_MAX_MB/);
  assert.throws(() => loadConfig({ CACHE_MAX_MB: 'lots' }), /CACHE_MAX_MB/);
});

test('version falls back to package.json so release identity cannot drift', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(loadConfig({}).version, pkg.version);
});

test('.env.example documents every operational knob and drops DEFAULT_CITY', async () => {
  const example = await readFile(path.join(REPO_ROOT, '.env.example'), 'utf8');
  for (const name of [
    'CACHE_MAX_MB',
    'RATE_LIMIT_PER_MIN',
    'READ_RATE_LIMIT_PER_MIN',
    'SKY_RATE_LIMIT_PER_MIN',
    'TRUST_PROXY',
    'TRUSTED_PROXY_CIDRS',
    'JOB_QUEUE_MAX',
    'JOB_PER_CLIENT_MAX',
    'GIT_SHA',
    'IMAGE_TAG'
  ]) {
    assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), `.env.example must document ${name}`);
  }
  assert.doesNotMatch(example, /^\s*DEFAULT_CITY=/m);
});
