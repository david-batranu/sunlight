/**
 * Seed bake script tests: fixture-only bakes, manifest integrity, determinism,
 * CLI error handling and runtime seed serving of the baked output.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { createCityService } from '../../server/city/service.ts';
import type { SeedManifest } from '../../server/city/manifest-types.ts';
import { sha256Hex } from '../../server/city/model-io.ts';
import {
  FIXED_TIMESTAMP,
  REPO_ROOT,
  makeTempDir,
  makeTestConfig,
  removeTempDir
} from './city-helpers.ts';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bake-seeds.mjs');

async function runBake(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, SUNLIGHT_LOG_LEVEL: 'error' }
  });
}

test('bake-seeds --help prints usage', async () => {
  const { stdout } = await runBake(['--help']);
  assert.match(stdout, /Bake the bundled Sunlight seed city models/);
  assert.match(stdout, /--source/);
  assert.match(stdout, /brasov/);
});

test('bake-seeds rejects unknown sources and cities', async () => {
  await assert.rejects(runBake(['--source', 'seed', '--out', '/tmp/never-written']));
  await assert.rejects(
    runBake(['--source', 'fixture', '--only', 'atlantis', '--out', '/tmp/never-written'])
  );
});

test('fixture bake writes a verifiable manifest and gzipped seed model', async () => {
  const dir = await makeTempDir('sunlight-bake-');
  try {
    const outDir = path.join(dir, 'seeds');
    const { stdout } = await runBake([
      '--source',
      'fixture',
      '--out',
      outDir,
      '--only',
      'brasov',
      '--generated-at',
      FIXED_TIMESTAMP
    ]);
    assert.match(stdout, /baked brasov/);

    const files = (await readdir(outDir)).sort();
    assert.deepEqual(files, ['brasov.json.gz', 'manifest.json']);

    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')) as SeedManifest;
    assert.equal(manifest.v, 1);
    assert.equal(manifest.modelVersion, 1);
    assert.equal(manifest.radiusM, 900);
    assert.equal(manifest.generatedAt, FIXED_TIMESTAMP);
    assert.equal(manifest.cities.length, 1);
    const entry = manifest.cities[0];
    assert.equal(entry.slug, 'brasov');
    assert.equal(entry.geonameId, 683844);
    assert.equal(entry.name, 'Brașov');
    assert.equal(entry.key, 'gn-683844-r900-v1');
    assert.equal(entry.file, 'brasov.json.gz');
    assert.equal(entry.modelVersion, 1);
    assert.equal(entry.radiusM, 900);
    assert.equal(entry.source, 'fixture');

    const gzipped = await readFile(path.join(outDir, entry.file));
    assert.equal(gzipped.length, entry.bytes);
    assert.equal(sha256Hex(gzipped), entry.sha256);
    const model = JSON.parse(gunzipSync(gzipped).toString('utf8'));
    assert.equal(model.v, 1);
    assert.equal(model.key, 'gn-683844-r900-v1');
    assert.equal(model.meta.seed, true);
    assert.equal(model.meta.source, 'seed');
    assert.equal(model.meta.generatedAt, FIXED_TIMESTAMP);
    assert.deepEqual(model.meta.stats, entry.stats);
    assert.equal(model.meta.stats.buildings, 12);

    // The baked directory is directly consumable by the runtime in seed-only mode.
    const service = createCityService(
      makeTestConfig(dir, { seedsDir: outDir, citySource: 'seed', seedsOnly: true })
    );
    try {
      await service.init();
      assert.deepEqual(service.health().seeds, { count: 1, slugs: ['brasov'] });
      const ensured = await service.ensureModel({ kind: 'city', geonameId: 683844 });
      assert.equal(ensured.state, 'ready');
      if (ensured.state === 'ready') {
        assert.equal(ensured.meta.seed, true);
        assert.equal(ensured.bytes, entry.bytes);
        assert.equal(ensured.etag, `"${entry.sha256}"`);
        assert.deepEqual(ensured.meta.stats, entry.stats);
      }
    } finally {
      await service.shutdown();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('fixture bakes are byte-deterministic for the same generatedAt', async () => {
  const dir = await makeTempDir('sunlight-bake-');
  try {
    const outA = path.join(dir, 'a');
    const outB = path.join(dir, 'b');
    const args = ['--source', 'fixture', '--only', 'brasov,cluj-napoca', '--generated-at', FIXED_TIMESTAMP];
    await runBake([...args, '--out', outA]);
    await runBake([...args, '--out', outB]);

    const manifestA = JSON.parse(await readFile(path.join(outA, 'manifest.json'), 'utf8')) as SeedManifest;
    const manifestB = JSON.parse(await readFile(path.join(outB, 'manifest.json'), 'utf8')) as SeedManifest;
    assert.deepEqual(manifestA, manifestB);
    assert.equal(manifestA.cities.length, 2);
    for (const entry of manifestA.cities) {
      const a = await readFile(path.join(outA, entry.file));
      const b = await readFile(path.join(outB, entry.file));
      assert.deepEqual(a, b, `${entry.slug} bytes must be deterministic`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('re-baking reuses an up-to-date seed without fetching', async () => {
  const dir = await makeTempDir('sunlight-bake-');
  try {
    const outDir = path.join(dir, 'seeds');
    const args = [
      '--source',
      'fixture',
      '--out',
      outDir,
      '--only',
      'brasov',
      '--generated-at',
      FIXED_TIMESTAMP
    ];
    await runBake(args);
    const first = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
    const { stdout } = await runBake(args);
    assert.match(stdout, /up to date/);
    const second = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
    assert.equal(second, first);
  } finally {
    await removeTempDir(dir);
  }
});
