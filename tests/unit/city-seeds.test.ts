/**
 * Seed store tests: manifest validation, integrity checks and serving.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { SeedStore } from '../../server/city/seed-store.ts';
import { MODEL_VERSION } from '../../shared/constants.ts';
import type { CityInfo } from '../../shared/types.ts';
import {
  BRASOV_CITY,
  cityKey,
  makeTempDir,
  removeTempDir,
  writeSeedDir
} from './city-helpers.ts';

const BUCHAREST: CityInfo = {
  geonameId: 683506,
  name: 'București',
  country: 'RO',
  lat: 44.43225,
  lon: 26.10626,
  tz: 'Europe/Bucharest'
};

async function makeSeeds(): Promise<{ dir: string; tempDir: string }> {
  const tempDir = await makeTempDir('sunlight-seeds-');
  const dir = path.join(tempDir, 'seeds');
  await writeSeedDir(dir, [
    { slug: 'brasov', geonameId: 683844, name: 'Brașov', city: BRASOV_CITY },
    { slug: 'bucharest', geonameId: 683506, name: 'București', city: BUCHAREST }
  ]);
  return { dir, tempDir };
}

test('loads a valid manifest and serves seed models', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 900 });
    assert.equal(store.count, 2);
    assert.deepEqual(store.slugs, ['brasov', 'bucharest']);
    assert.equal(store.statusValue, 'up');
    assert.deepEqual(store.warningList, []);
    assert.equal(store.byGeonameId(683844)?.slug, 'brasov');
    assert.equal(store.byKey(cityKey(683506))?.slug, 'bucharest');
    assert.equal(store.byGeonameId(1), null);

    const entry = store.byGeonameId(683844);
    assert.ok(entry);
    const ready = await store.read(entry);
    assert.ok(ready);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.resolved.seedSlug, 'brasov');
    assert.deepEqual(ready.resolved.target, { kind: 'city', geonameId: 683844 });
    assert.equal(ready.resolved.city.name, 'Brașov');
    assert.equal(ready.meta.seed, true);
    assert.equal(ready.meta.source, 'seed');
    assert.equal(ready.bytes, entry.bytes);
    assert.equal(ready.etag, `"${entry.sha256}"`);
    assert.ok(ready.gzipped.length > 0);
  } finally {
    await removeTempDir(tempDir);
  }
});

test('missing manifest yields an empty unknown store', async () => {
  const tempDir = await makeTempDir('sunlight-seeds-');
  try {
    const store = await SeedStore.load(path.join(tempDir, 'missing'), {
      modelVersion: MODEL_VERSION,
      radiusM: 900
    });
    assert.equal(store.count, 0);
    assert.equal(store.statusValue, 'unknown');
    assert.deepEqual(store.slugs, []);
  } finally {
    await removeTempDir(tempDir);
  }
});

test('ignores a manifest baked for a different model version', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION + 1, radiusM: 900 });
    assert.equal(store.count, 0);
    assert.equal(store.statusValue, 'down');
    assert.ok(store.warningList.some((warning) => warning.includes('model version')));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('ignores a manifest baked for a different radius', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 600 });
    assert.equal(store.count, 0);
    assert.equal(store.statusValue, 'down');
    assert.ok(store.warningList.some((warning) => warning.includes('radius')));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('excludes a seed whose file checksum does not match the manifest', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const file = path.join(dir, 'brasov.json.gz');
    const original = await readFile(file);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] ^= 0xff;
    await writeFile(file, corrupted);

    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 900 });
    assert.equal(store.count, 1);
    assert.equal(store.statusValue, 'down');
    assert.deepEqual(store.slugs, ['bucharest']);
    assert.ok(store.warningList.some((warning) => warning.startsWith('brasov:')));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('rejects manifest entries that try to escape the seeds directory', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.cities[0].file = '../brasov.json.gz';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 900 });
    assert.equal(store.count, 1);
    assert.deepEqual(store.slugs, ['bucharest']);
    assert.equal(store.statusValue, 'down');
  } finally {
    await removeTempDir(tempDir);
  }
});

test('detects a seed file modified after startup', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 900 });
    const entry = store.byGeonameId(683844);
    assert.ok(entry);
    const file = path.join(dir, entry.file);
    const original = await readFile(file);
    const modified = Buffer.from(original);
    modified[0] ^= 0xff;
    await writeFile(file, modified);
    assert.equal(await store.read(entry), null);
    await writeFile(file, original);
    assert.ok(await store.read(entry));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('list() returns entries in manifest order', async () => {
  const { dir, tempDir } = await makeSeeds();
  try {
    const store = await SeedStore.load(dir, { modelVersion: MODEL_VERSION, radiusM: 900 });
    assert.deepEqual(
      store.list().map((entry) => entry.slug),
      ['brasov', 'bucharest']
    );
  } finally {
    await removeTempDir(tempDir);
  }
});
