/**
 * Model cache tests: atomic writes, ETags, corruption cleanup and LRU eviction.
 */

import assert from 'node:assert/strict';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { ModelCache } from '../../server/city/model-cache.ts';
import { sha256Hex } from '../../server/city/model-io.ts';
import {
  BRASOV_CITY,
  gzipModelSync,
  makeMeta,
  makeModel,
  makeTempDir,
  removeTempDir
} from './city-helpers.ts';

const KEY = 'gn-683844-r900-v1';
const TARGET = { kind: 'city' as const, geonameId: 683844 };

function writeInfo(metaSeed = false) {
  return {
    meta: makeMeta({ seed: metaSeed }),
    city: BRASOV_CITY,
    target: TARGET,
    seedSlug: metaSeed ? 'brasov' : null,
    modelVersion: 1,
    radiusM: 900
  };
}

async function withCache(maxBytes: number, run: (cache: ModelCache, dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir('sunlight-cache-');
  try {
    const cache = new ModelCache(dir, maxBytes);
    await cache.init();
    await run(cache, dir);
  } finally {
    await removeTempDir(dir);
  }
}

function modelFile(dir: string, key: string): string {
  return path.join(dir, 'models', `${key}.json.gz`);
}

function metaFile(dir: string, key: string): string {
  return path.join(dir, 'models', `${key}.meta.json`);
}

test('write then read returns the gzipped bytes and a strong SHA-256 ETag', async () => {
  await withCache(1_000_000, async (cache, dir) => {
    const gzipped = gzipModelSync(makeModel(KEY));
    const expectedEtag = `"${sha256Hex(gzipped)}"`;
    const entry = await cache.write(KEY, gzipped, writeInfo());
    assert.equal(entry.etag, expectedEtag);
    assert.equal(entry.gzipBytes, gzipped.length);
    assert.equal(cache.models, 1);
    assert.equal(cache.bytes, gzipped.length);

    const read = await cache.read(KEY);
    assert.ok(read);
    assert.equal(read.entry.etag, expectedEtag);
    assert.deepEqual(read.gzipped, gzipped);
    assert.equal(read.entry.meta.stats.buildings, 1);
    assert.equal(read.entry.city.name, BRASOV_CITY.name);
    assert.deepEqual(read.entry.target, TARGET);
    assert.equal(read.entry.seedSlug, null);
    assert.equal((await cache.read('gn-1-r900-v1')), null);

    const files = await readdir(path.join(dir, 'models'));
    assert.deepEqual(files.sort(), [`${KEY}.json.gz`, `${KEY}.meta.json`]);
    assert.equal(await cache.read(KEY) === null, false);
  });
});

test('cache survives service-style re-initialization', async () => {
  const dir = await makeTempDir('sunlight-cache-');
  try {
    const first = new ModelCache(dir, 1_000_000);
    await first.init();
    const gzipped = gzipModelSync(makeModel(KEY));
    await first.write(KEY, gzipped, writeInfo());

    const second = new ModelCache(dir, 1_000_000);
    await second.init();
    assert.equal(second.models, 1);
    assert.equal(second.bytes, gzipped.length);
    const read = await second.read(KEY);
    assert.deepEqual(read?.gzipped, gzipped);
  } finally {
    await removeTempDir(dir);
  }
});

test('detects and removes corrupted model bytes on read', async () => {
  await withCache(1_000_000, async (cache, dir) => {
    const gzipped = gzipModelSync(makeModel(KEY));
    await cache.write(KEY, gzipped, writeInfo());
    // Flip one byte in the payload: size stays the same, checksum does not.
    const corrupted = Buffer.from(gzipped);
    corrupted[corrupted.length - 5] ^= 0xff;
    await writeFile(modelFile(dir, KEY), corrupted);
    assert.equal(await cache.read(KEY), null);
    assert.equal(cache.models, 0);
    assert.equal(cache.bytes, 0);
    await assert.rejects(readFile(modelFile(dir, KEY)));
  });
});

test('startup scan removes entries with invalid sidecars, size mismatches and temp files', async () => {
  const dir = await makeTempDir('sunlight-cache-');
  try {
    const cache = new ModelCache(dir, 1_000_000);
    await cache.init();
    const gzipped = gzipModelSync(makeModel(KEY));
    await cache.write(KEY, gzipped, writeInfo());
    // Corruption 1: invalid JSON sidecar.
    await writeFile(metaFile(dir, KEY), '{not json');
    const second = new ModelCache(dir, 1_000_000);
    await second.init();
    assert.equal(second.models, 0);
    await assert.rejects(readFile(metaFile(dir, KEY)));

    // Corruption 2: size mismatch between sidecar and file.
    const third = new ModelCache(dir, 1_000_000);
    await third.init();
    await third.write(KEY, gzipped, writeInfo());
    await writeFile(modelFile(dir, KEY), Buffer.concat([gzipped, Buffer.from('extra')]));
    const fourth = new ModelCache(dir, 1_000_000);
    await fourth.init();
    assert.equal(fourth.models, 0);

    // Orphans: sidecar without model and an interrupted temp write.
    await writeFile(metaFile(dir, 'gn-2-r900-v1'), JSON.stringify({ v: 1 }));
    await writeFile(path.join(dir, 'models', '.gn-3-r900-v1.json.gz.tmp-123'), 'partial');
    const fifth = new ModelCache(dir, 1_000_000);
    await fifth.init();
    assert.equal(fifth.models, 0);
    const files = await readdir(path.join(dir, 'models'));
    assert.deepEqual(files, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('evicts least-recently-used entries above the byte budget', async () => {
  const keys = ['gn-1-r900-v1', 'gn-2-r900-v1', 'gn-3-r900-v1'];
  const payloads = keys.map((key) => gzipModelSync(makeModel(key)));
  const maxBytes = Math.max(...payloads.map((payload) => payload.length)) * 2 + 100;
  const dir = await makeTempDir('sunlight-cache-');
  try {
    const cache = new ModelCache(dir, maxBytes);
    await cache.init();
    for (let i = 0; i < keys.length; i += 1) await cache.write(keys[i], payloads[i], writeInfo());
    assert.equal(cache.models, 2);
    assert.ok(cache.bytes <= maxBytes);
    assert.equal(await cache.read(keys[0]), null);
    assert.ok(await cache.read(keys[2]));
    await assert.rejects(readFile(modelFile(dir, keys[0])));
  } finally {
    await removeTempDir(dir);
  }
});

test('reading an entry refreshes its LRU position', async () => {
  const keys = ['gn-1-r900-v1', 'gn-2-r900-v1', 'gn-3-r900-v1'];
  const payloads = keys.map((key) => gzipModelSync(makeModel(key)));
  const maxBytes = Math.max(...payloads.map((payload) => payload.length)) * 2 + 100;
  const dir = await makeTempDir('sunlight-cache-');
  try {
    const cache = new ModelCache(dir, maxBytes);
    await cache.init();
    await cache.write(keys[0], payloads[0], writeInfo());
    await cache.write(keys[1], payloads[1], writeInfo());
    assert.ok(await cache.read(keys[0])); // key 0 becomes most recently used
    await cache.write(keys[2], payloads[2], writeInfo());
    assert.equal(cache.models, 2);
    assert.ok(await cache.read(keys[0]), 'recently read entry survives');
    assert.ok(await cache.read(keys[2]), 'new entry survives');
    assert.equal(await cache.read(keys[1]), null, 'key 1 was least recently used');
  } finally {
    await removeTempDir(dir);
  }
});

test('a zero byte budget means unlimited cache', async () => {
  await withCache(0, async (cache) => {
    for (const key of ['gn-1-r900-v1', 'gn-2-r900-v1']) {
      await cache.write(key, gzipModelSync(makeModel(key)), writeInfo());
    }
    assert.equal(cache.models, 2);
    assert.equal(cache.maxBytesLimit, Number.POSITIVE_INFINITY);
  });
});

test('clear removes every cached file', async () => {
  await withCache(1_000_000, async (cache, dir) => {
    await cache.write(KEY, gzipModelSync(makeModel(KEY)), writeInfo());
    await cache.clear();
    assert.equal(cache.models, 0);
    assert.equal(cache.bytes, 0);
    assert.deepEqual(await readdir(path.join(dir, 'models')), []);
  });
});

test('write is atomic: no temp files are left behind', async () => {
  await withCache(1_000_000, async (_cache, dir) => {
    const cache = new ModelCache(dir, 1_000_000);
    await cache.init();
    await cache.write(KEY, gzipModelSync(makeModel(KEY)), writeInfo());
    const files = await readdir(path.join(dir, 'models'));
    assert.equal(files.some((file) => file.includes('.tmp-')), false);
  });
});
