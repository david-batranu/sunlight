/**
 * Terrain rendering tests: heightfield mesh, draped roads/areas, buildings and
 * trees grounded on the sampled terrain, plus camera extents. No WebGL/DOM.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CityModel, TerrainRecord } from '../../shared/types.ts';
import { terrainHeightM } from '../../shared/terrain.ts';
import {
  AREA_LIFT_M,
  ROAD_LIFT_M,
  TERRAIN_MESH_SUBDIVISIONS,
  buildAreas,
  buildBuildings,
  buildModelBuffers,
  buildRoads,
  buildTerrain,
  buildTrees,
  sampleTreeSites
} from '../../src/scene/geometry.ts';
import { modelExtentsFor } from '../../src/scene/model.ts';

const TERRAIN: TerrainRecord = {
  x0: -10000,
  z0: -10000,
  step: 10000,
  cols: 3,
  rows: 3,
  h: [0, 20, 40, 60, 80, 100, 120, 140, 160],
  baseM: 500,
  source: 'test'
};

function terrainModel(): CityModel {
  return {
    v: 3,
    key: 'terrain-test-v3',
    city: { geonameId: null, name: 'Terrain', country: 'XX', lat: 0, lon: 0, tz: 'UTC' },
    meta: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      seed: false,
      radiusM: 1000,
      stats: { buildings: 1, roads: 1, areas: 1, dropped: 0 },
      warnings: [],
      attribution: 'test · Elevation: AWS Terrain Tiles'
    },
    bounds: { minX: -10000, maxX: 10000, minZ: -10000, maxZ: 10000, maxHeight: 200 },
    terrain: TERRAIN,
    buildings: [{ p: [-2000, -2000, 2000, -2000, 2000, 2000, -2000, 2000], h: 100, t: 0, r: 0 }],
    roads: [{ c: 2, p: [-8000, 0, 8000, 0] }],
    areas: [{ k: 4, p: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000] }]
  };
}

function yRange(positions: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    min = Math.min(min, positions[i]);
    max = Math.max(max, positions[i]);
  }
  return { min, max };
}

test('buildTerrain meshes the heightfield and closes the perimeter', () => {
  const buffers = buildTerrain(terrainModel());
  assert.ok(buffers.triangles >= 8);
  const range = yRange(buffers.positions);
  // Highest sample is 160 dm = 16 m, plus the small render lift.
  assert.ok(range.max >= 16 && range.max <= 16.2, `max terrain y ${range.max}`);
  assert.ok(buffers.featureIndices.every((index) => index === -1));
  // No terrain → empty buffers.
  const flat = terrainModel();
  delete flat.terrain;
  assert.equal(buildTerrain(flat).triangles, 0);
});

test('buildings sit on the sampled ground and keep their full height', () => {
  const model = terrainModel();
  const buffers = buildBuildings(model);
  assert.ok(buffers.triangles > 0);
  const range = yRange(buffers.positions);
  const ground = terrainHeightM(TERRAIN, 0, 0);
  assert.ok(range.min <= ground, `wall base ${range.min} should reach the ground ${ground}`);
  assert.ok(range.min > ground - 1, 'wall foundation sinks only slightly');
  assert.ok(range.max >= ground + 10, 'building top should be ground + height');
});

test('roads and areas are draped over terrain', () => {
  const model = terrainModel();
  const road = buildRoads(model);
  const roadRange = yRange(road.positions);
  assert.ok(roadRange.min > ROAD_LIFT_M, 'roads should be lifted above the terrain');
  assert.ok(roadRange.max > roadRange.min, 'sloped road should vary in height');

  const area = buildAreas(model);
  const areaRange = yRange(area.positions);
  assert.ok(area.triangles > 0);
  assert.ok(areaRange.min >= AREA_LIFT_M[4], 'grass surface should stay above terrain');

  const buffers = buildModelBuffers(model, modelExtentsFor(model));
  assert.ok(buffers.terrain.triangles > 0);
});

test('steep forests are baked into terrain instead of floating overlays', () => {
  const model = terrainModel();
  model.areas = [{ k: 3, p: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000] }];
  assert.equal(buildAreas(model).triangles, 0, 'steep forest overlay should be skipped');
  // The terrain still exists (and receives the forest tint in its colours).
  assert.ok(buildTerrain(model).triangles > 0);
  // A flat forest remains a normal overlay.
  const flat = terrainModel();
  flat.terrain = { ...TERRAIN, h: new Array(9).fill(0) };
  flat.areas = [{ k: 3, p: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000] }];
  assert.ok(buildAreas(flat).triangles > 0);
});

test('trees use the terrain height and extents include the relief', () => {
  const model = terrainModel();
  model.areas = [{ k: 3, p: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000] }];
  const sites = sampleTreeSites(model);
  assert.ok(sites.length > 0);
  for (const site of sites) {
    const ground = terrainHeightM(TERRAIN, site.x, site.z);
    assert.ok(site.baseY >= ground, `tree at ${site.x},${site.z} should sit on terrain`);
  }
  const trees = buildTrees(sites);
  assert.ok(trees.triangles > 0);

  const extents = modelExtentsFor(model);
  assert.ok(extents.maxHeight >= 16, `extents must cover the terrain (${extents.maxHeight})`);
});

test('terrain mesh uses the compact subdivision and deterministic triangle budget', () => {
  // Performance fix PR-02: 4×4 subdivisions per wire cell were reduced to 2×2
  // (−20 % of all submitted triangles) while the wire heightfield still fully
  // drives road/area draping (sampled from terrainHeightM, not this mesh).
  assert.equal(TERRAIN_MESH_SUBDIVISIONS, 2);

  const model = terrainModel();
  model.terrain = { ...TERRAIN, h: new Array(TERRAIN.cols * TERRAIN.rows).fill(0) };
  const buffers = buildTerrain(model);

  const cells = (TERRAIN.cols - 1) * (TERRAIN.rows - 1);
  const sub = TERRAIN_MESH_SUBDIVISIONS;
  // Perimeter skirt: one quad per boundary edge segment (top+bottom+left+right).
  const skirtTriangles = ((TERRAIN.cols - 1) + (TERRAIN.rows - 1)) * 2 * 2;
  const expected = cells * sub * sub * 2 + skirtTriangles;
  assert.equal(buffers.triangles, expected, 'terrain triangle count follows subdivisions');
  assert.equal(buffers.positions.length, buffers.triangles * 9);
  assert.equal(buffers.colors.length, buffers.triangles * 9);
  assert.equal(buffers.featureIndices.length, buffers.triangles);

  // Deterministic: a rebuild of the same model produces byte-identical buffers.
  const again = buildTerrain(model);
  assert.deepEqual(Array.from(again.positions), Array.from(buffers.positions));
  assert.deepEqual(Array.from(again.colors), Array.from(buffers.colors));
});
