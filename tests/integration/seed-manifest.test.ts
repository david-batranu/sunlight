/**
 * Guard test for the committed seed manifest.
 *
 * The manifest is generated data, but it is coupled to runtime constants
 * (`MODEL_VERSION`, `CITY_RADIUS_M`) and the `SEED_CITIES` list. A silent bump
 * of any of them disables every bundled seed at runtime, so this test fails the
 * build instead. It also verifies the committed seed files are integrity-valid
 * and not degraded (the bake quality gate would re-bake those).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import type { SeedManifest } from '../../server/city/manifest-types.ts';
import { parseModelKey } from '../../server/city/keys.ts';
import { gunzipModel } from '../../server/city/model-io.ts';
import { SeedStore } from '../../server/city/seed-store.ts';
import { CITY_RADIUS_M, MODEL_VERSION, SEED_CITIES } from '../../shared/constants.ts';
import { REPO_ROOT } from '../unit/city-helpers.ts';

const SEEDS_DIR = path.join(REPO_ROOT, 'server', 'data', 'seeds');
const MANIFEST_PATH = path.join(SEEDS_DIR, 'manifest.json');

async function loadManifest(): Promise<SeedManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as SeedManifest;
}

test('committed seed manifest matches MODEL_VERSION, CITY_RADIUS_M and SEED_CITIES', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.v, 1);
  assert.equal(manifest.modelVersion, MODEL_VERSION);
  assert.equal(manifest.radiusM, CITY_RADIUS_M);
  assert.equal(manifest.cities.length, SEED_CITIES.length);
  assert.deepEqual(
    manifest.cities.map((entry) => entry.slug),
    SEED_CITIES.map((city) => city.slug)
  );

  const seenKeys = new Set<string>();
  for (const [index, entry] of manifest.cities.entries()) {
    const city = SEED_CITIES[index];
    assert.equal(entry.slug, city.slug);
    assert.equal(entry.geonameId, city.geonameId);
    assert.equal(entry.name, city.name);
    assert.equal(entry.key, `gn-${city.geonameId}-r${CITY_RADIUS_M}-v${MODEL_VERSION}`);
    assert.equal(entry.modelVersion, MODEL_VERSION);
    assert.equal(entry.radiusM, CITY_RADIUS_M);
    assert.equal(seenKeys.has(entry.key), false, `duplicate seed key ${entry.key}`);
    seenKeys.add(entry.key);
    const parsed = parseModelKey(entry.key);
    assert.deepEqual(parsed, { kind: 'city', radiusM: CITY_RADIUS_M, modelVersion: MODEL_VERSION });
    assert.equal(entry.degraded, undefined, `seed ${entry.slug} is degraded; re-bake it`);
  }
});

test('the runtime SeedStore verifies every committed seed file', async () => {
  const store = await SeedStore.load(SEEDS_DIR, { modelVersion: MODEL_VERSION, radiusM: CITY_RADIUS_M });
  assert.equal(store.count, SEED_CITIES.length);
  assert.equal(store.statusValue, 'up');
  assert.deepEqual(store.degradedSlugs, []);
  assert.deepEqual(store.warningList, []);
  assert.deepEqual(
    store.slugs,
    SEED_CITIES.map((city) => city.slug)
  );
});

test('committed seed models carry terrain and are not marked degraded', async () => {
  const store = await SeedStore.load(SEEDS_DIR, { modelVersion: MODEL_VERSION, radiusM: CITY_RADIUS_M });
  for (const entry of store.list()) {
    const ready = await store.read(entry);
    assert.ok(ready, `seed ${entry.slug} must load`);
    // Re-decode through the wire validator so the persisted format stays valid.
    const model = await gunzipModel(ready.gzipped);
    assert.equal(model.meta.seed, true);
    assert.equal(model.meta.degraded, undefined, `${entry.slug} is degraded; re-bake it`);
    assert.ok(model.terrain, `${entry.slug} has no terrain; the bake quality gate treats that as stale`);
  }
});
