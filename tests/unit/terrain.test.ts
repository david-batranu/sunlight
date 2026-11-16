/**
 * Elevation tests: PNG decoding (all five filter types), shared heightfield
 * sampling, bounds and persisted-model validation. No network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCityModel } from '../../server/city/build.ts';
import { decodePng } from '../../server/city/png.ts';
import { validateCityModel } from '../../server/city/model-io.ts';
import type { TerrainRecord } from '../../shared/types.ts';
import {
  isValidTerrain,
  terrainExtentDm,
  terrainHeightDm,
  terrainHeightM,
  terrainMaxHeightDm
} from '../../shared/terrain.ts';
import {
  FIXED_TIMESTAMP,
  TEST_MODEL_VERSION,
  cityKey,
  fixtureBuildInput,
  loadRawCityFixture
} from './city-helpers.ts';

/** 4×4 RGB PNG, each scanline using a different PNG filter (0–4). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKElEQVR4nD3CwREAIAjAsFIcyWFE3X8OP5y54MLCjYfwQnQZ/BkTsj9TXgIkoWgMsAAAAABJRU5ErkJggg==';

function sampleTerrain(): TerrainRecord {
  return {
    x0: -200,
    z0: -200,
    step: 200,
    cols: 3,
    rows: 3,
    // row-major: north row first (z0), increasing south
    h: [0, 10, 20, 30, 40, 50, 60, 70, 80],
    baseM: 500,
    source: 'test'
  };
}

test('PNG decoder handles all standard filters and Terrarium heights', () => {
  const png = decodePng(Buffer.from(PNG_BASE64, 'base64'));
  assert.equal(png.width, 4);
  assert.equal(png.height, 4);
  assert.equal(png.channels, 3);
  // The fixture encodes consecutive synthetic Terrarium values.
  const elevation = (index: number): number => {
    const offset = index * 3;
    return png.pixels[offset] * 256 + png.pixels[offset + 1] + png.pixels[offset + 2] / 256 - 32768;
  };
  for (let i = 0; i < 16; i += 1) assert.equal(elevation(i), -32168 + i);
});

test('terrain sampling is bilinear and clamps outside the grid', () => {
  const terrain = sampleTerrain();
  assert.ok(isValidTerrain(terrain));
  assert.equal(terrainHeightDm(terrain, -200, -200), 0);
  assert.equal(terrainHeightDm(terrain, 0, 0), 40);
  assert.equal(terrainHeightDm(terrain, -100, -100), 20); // average of corners
  assert.equal(terrainHeightDm(terrain, 0, -200), 10);
  assert.equal(terrainHeightM(terrain, 0, 0), 4);
  // Clamp outside.
  assert.equal(terrainHeightDm(terrain, -9999, 9999), 60);
  assert.equal(terrainHeightDm(terrain, 9999, -9999), 20);
  assert.equal(terrainMaxHeightDm(terrain), 80);
  assert.deepEqual(terrainExtentDm(terrain), {
    minX: -200,
    maxX: 200,
    minZ: -200,
    maxZ: 200,
    maxHeight: 80
  });
});

test('terrain validation rejects ragged/invalid grids', () => {
  assert.equal(isValidTerrain(null), false);
  assert.equal(isValidTerrain({ ...sampleTerrain(), h: [1, 2, 3] }), false);
  assert.equal(isValidTerrain({ ...sampleTerrain(), cols: 1 }), false);
  assert.equal(isValidTerrain({ ...sampleTerrain(), step: 0 }), false);
});

test('build folds terrain into bounds, attribution and wire validation', async () => {
  const raw = await loadRawCityFixture();
  const terrain: TerrainRecord = {
    x0: -9000,
    z0: -9000,
    step: 1000,
    cols: 19,
    rows: 19,
    h: Array.from({ length: 19 * 19 }, (_, index) => (index % 19) * 20),
    baseM: 550,
    source: 'test'
  };
  const model = buildCityModel(
    raw,
    fixtureBuildInput({ key: cityKey(683844), radiusM: 900, terrain })
  );
  assert.equal(model.v, TEST_MODEL_VERSION);
  assert.ok(model.terrain);
  assert.equal(model.terrain?.cols, 19);
  assert.match(model.meta.attribution, /Elevation: AWS Terrain Tiles/);
  assert.equal(model.bounds.minX, -9000);
  assert.equal(model.bounds.maxX, 9000);
  assert.equal(model.bounds.minZ, -9000);
  assert.equal(model.bounds.maxZ, 9000);
  assert.ok(model.bounds.maxHeight > 300, 'terrain relief must contribute to bounds');
  // The persisted wire model accepts terrain and remains deterministic.
  const again = buildCityModel(
    raw,
    fixtureBuildInput({ key: cityKey(683844), radiusM: 900, terrain })
  );
  assert.deepEqual(again, model);
  assert.doesNotThrow(() => validateCityModel(model));
  const broken = structuredClone(model);
  if (broken.terrain) broken.terrain.h = [1, 2, 3];
  assert.throws(() => validateCityModel(broken), /terrain\.h/);
  assert.equal(FIXED_TIMESTAMP.length > 0, true);
});

test('flat builds remain byte-compatible and omit terrain', async () => {
  const raw = await loadRawCityFixture();
  const model = buildCityModel(raw, fixtureBuildInput({ key: cityKey(683844), radiusM: 900 }));
  assert.equal(model.terrain, undefined);
  assert.doesNotMatch(model.meta.attribution, /Elevation/);
});
