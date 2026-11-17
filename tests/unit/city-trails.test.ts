/**
 * Pedestrian-path filtering: flat city footpaths are dropped, while steep or
 * explicitly tagged hiking trails survive as class 5.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCityModel } from '../../server/city/build.ts';
import {
  classifyRoad,
  hasHikingTags,
  hasNaturalPathSurface,
  isMinorPathWay
} from '../../server/city/classify.ts';
import type { RawOsmData, RawWay } from '../../server/city/raw.ts';
import type { TerrainRecord } from '../../shared/types.ts';
import { fixtureBuildInput, loadRawCityFixture } from './city-helpers.ts';

function pathWay(id: number, latStart: number, latEnd: number, tags: Record<string, string>): RawWay {
  return {
    id,
    nodes: [],
    geometry: [
      { lat: latStart, lon: 25.60613 },
      { lat: (latStart + latEnd) / 2, lon: 25.60613 },
      { lat: latEnd, lon: 25.60613 }
    ],
    tags
  };
}

function slopedTerrain(): TerrainRecord {
  const cols = 19;
  const h: number[] = [];
  for (let row = 0; row < cols; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      h.push(Math.max(0, (row - 9) * 40 + col * 2));
    }
  }
  return { x0: -9000, z0: -9000, step: 1000, cols, rows: cols, h, baseM: 500, source: 'test' };
}

test('road classification sends footpaths to the trail filter', () => {
  assert.equal(classifyRoad({ highway: 'footway' }), 0);
  assert.equal(classifyRoad({ highway: 'path' }), 0);
  assert.equal(classifyRoad({ highway: 'steps' }), 0);
  assert.equal(classifyRoad({ highway: 'pedestrian', name: 'Piața' }), 4);
  assert.equal(classifyRoad({ highway: 'service', name: 'Aleea' }), 4);
  assert.equal(classifyRoad({ highway: 'path', sac_scale: 'hiking' }), 0);
  assert.equal(isMinorPathWay({ highway: 'footway' }), true);
  assert.equal(isMinorPathWay({ highway: 'residential' }), false);
  assert.equal(hasHikingTags({ highway: 'path', sac_scale: 'mountain_hiking' }), true);
  assert.equal(hasHikingTags({ highway: 'path', route: 'hiking' }), true);
  assert.equal(hasHikingTags({ highway: 'path' }), false);
  assert.equal(hasNaturalPathSurface({ highway: 'path', surface: 'ground' }), true);
  assert.equal(hasNaturalPathSurface({ highway: 'footway', surface: 'asphalt' }), false);
});

test('flat city footpaths are dropped and climbing trails survive as class 5', async () => {
  const raw: RawOsmData = await loadRawCityFixture();
  const flatPath = pathWay(9001, 45.64861, 45.64761, { highway: 'footway', surface: 'asphalt' });
  const climbingPath = pathWay(9002, 45.64200, 45.63500, { highway: 'footway', surface: 'ground' });
  const taggedPath = pathWay(9003, 45.6480, 45.6470, { highway: 'path', sac_scale: 'hiking' });
  raw.ways.push(flatPath, climbingPath, taggedPath);
  const model = buildCityModel(
    raw,
    fixtureBuildInput({ terrain: slopedTerrain(), radiusM: 900 })
  );
  const trails = model.roads.filter((road) => road.c === 5);
  assert.ok(trails.length >= 2, `expected hiking trails, got ${trails.length}`);
  // The asphalt footpath near the centre must not be rendered.
  for (const road of model.roads) assert.notEqual(road.c, 4, 'no plain footpaths should remain');
  assert.ok(
    model.meta.warnings.some((warning) => warning.startsWith('dropped pedestrian paths')),
    'drop count should be reported'
  );
});
