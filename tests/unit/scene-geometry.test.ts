/**
 * Unit tests for the merged-geometry builders.
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { BuildingRecord, CityModel } from '../../shared/types.ts';
import {
  AREA_LIFT_M,
  ROAD_LIFT_M,
  ROAD_WIDTH_M,
  areaColorFor,
  buildAreas,
  emptyBuffers,
  buildBuildings,
  buildModelBuffers,
  buildPlinth,
  buildRoads,
  buildTrees,
  buildingColor,
  hashString,
  hashUnit,
  mulberry32,
  pointInRing,
  roadColorFor,
  sampleTreeSites,
  shadowRadiusFor,
  treeColorFor
} from '../../src/scene/geometry.ts';
import { defaultExtents, modelExtentsFor, plinthProfile } from '../../src/scene/model.ts';

const model = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/model-mini.json', import.meta.url)), 'utf8')
) as CityModel;

const EMPTY_META = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: 'fixture' as const,
  seed: true,
  radiusM: 900,
  stats: { buildings: 0, roads: 0, areas: 0, dropped: 0 },
  warnings: [] as string[],
  attribution: 'test'
};

function syntheticModel(buildings: BuildingRecord[]): CityModel {
  return {
    v: 1,
    key: 'synthetic-v1',
    city: {
      geonameId: null,
      name: 'Test',
      country: 'XX',
      lat: 0,
      lon: 0,
      tz: 'UTC'
    },
    meta: EMPTY_META,
    bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, maxHeight: 200 },
    buildings,
    roads: [],
    areas: []
  };
}

/** XYZ triples from a buffer. */
function vertices(buffers: { positions: Float32Array }): Float32Array {
  return buffers.positions;
}

function triangleNormal(
  positions: Float32Array,
  triangleIndex: number
): [number, number, number] {
  const offset = triangleIndex * 9;
  const ax = positions[offset];
  const ay = positions[offset + 1];
  const az = positions[offset + 2];
  const bx = positions[offset + 3];
  const by = positions[offset + 4];
  const bz = positions[offset + 5];
  const cx = positions[offset + 6];
  const cy = positions[offset + 7];
  const cz = positions[offset + 8];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  return [
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx
  ];
}

test('hash helpers are deterministic and in range', () => {
  for (const value of [0, 1, -7, 123456, -987654]) {
    const a = hashUnit(value);
    assert.equal(a, hashUnit(value));
    assert.ok(a >= 0 && a < 1, `hashUnit(${value}) = ${a}`);
  }
  assert.equal(hashString('brasov'), hashString('brasov'));
  assert.notEqual(hashString('brasov'), hashString('sibiu'));

  const rngA = mulberry32(42);
  const rngB = mulberry32(42);
  for (let i = 0; i < 8; i += 1) {
    const a = rngA();
    assert.equal(a, rngB());
    assert.ok(a >= 0 && a < 1);
  }
});

test('building palette stays in gamut, deterministic and height-aware', () => {
  for (const type of [0, 1, 2, 3, 7]) {
    for (const variation of [0, 0.5, 1]) {
      const color = buildingColor(type, 120, variation);
      for (const channel of color) assert.ok(channel >= 0 && channel <= 1);
      const again = buildingColor(type, 120, variation);
      assert.deepEqual(color, again);
    }
  }
  const low = buildingColor(0, 50, 0.5);
  const tall = buildingColor(0, 500, 0.5);
  assert.ok(low[0] + low[1] + low[2] < tall[0] + tall[1] + tall[2], 'taller buildings are lighter');
  const residential = buildingColor(0, 100, 0.5);
  assert.ok(residential[0] > residential[2], 'warm plaster, red channel dominant');
});

test('road/area/tree palette helpers are deterministic and in gamut', () => {
  for (const roadClass of [1, 2, 3, 4, 5, 9, 99]) {
    const color = roadColorFor(roadClass, 0.3);
    for (const channel of color) assert.ok(channel >= 0 && channel <= 1);
  }
  for (const kind of [1, 2, 3, 4, 99]) {
    const color = areaColorFor(kind, 0.7);
    for (const channel of color) assert.ok(channel >= 0 && channel <= 1);
  }
  for (const index of [0, 1, 2, 3, -1]) {
    const color = treeColorFor(index);
    assert.ok(color[1] > color[0] && color[1] > color[2], 'canopy is green-dominant');
  }
  for (const value of Object.values(ROAD_WIDTH_M)) assert.ok(value > 2);
  assert.ok(ROAD_LIFT_M > AREA_LIFT_M[1]);
});

test('pointInRing handles simple, concave and degenerate rings', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInRing(5, 5, square), true);
  assert.equal(pointInRing(15, 5, square), false);
  assert.equal(pointInRing(-1, 5, square), false);
  assert.equal(pointInRing(5, 5, []), false);
  // L-shaped concave polygon: (0,0) (10,0) (10,4) (4,4) (4,10) (0,10)
  const ell = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10];
  assert.equal(pointInRing(2, 2, ell), true);
  assert.equal(pointInRing(8, 2, ell), true);
  assert.equal(pointInRing(8, 8, ell), false, 'notch is outside');
  assert.equal(pointInRing(2, 8, ell), true);
});

test('buildBuildings merges the fixture into one buffer with outward walls', () => {
  const buffers = buildBuildings(model);
  assert.ok(buffers.triangles > 0);
  // 64 buildings: 4 wall quads (8 tris) + 1 earcut cap (2 tris) each.
  // 38 of them get a gable roof instead of the flat cap: 8 walls + 2 slope
  // quads (4 tris) + 2 gable triangles = 14 tris.
  assert.equal(buffers.triangles, 26 * 10 + 38 * 14);
  assert.equal(buffers.positions.length, buffers.triangles * 9);
  assert.equal(buffers.colors.length, buffers.triangles * 9);
  for (let i = 0; i < buffers.positions.length; i += 1) {
    assert.ok(Number.isFinite(buffers.positions[i]), 'finite positions');
    assert.ok(Number.isFinite(buffers.colors[i]), 'finite colors');
    assert.ok(buffers.colors[i] >= 0 && buffers.colors[i] <= 1, 'linear colors in gamut');
  }
  assert.equal(buffers.featureIndices.length, buffers.triangles, 'one feature per triangle');
  // 26 flat + 38 gable buildings: triangles stay contiguous per building.
  const perBuilding = new Map<number, number>();
  for (const feature of buffers.featureIndices) {
    assert.ok(feature >= 0 && feature < 64, `feature ${feature} maps to a building`);
    perBuilding.set(feature, (perBuilding.get(feature) ?? 0) + 1);
  }
  assert.equal(perBuilding.size, 64, 'every fixture building is tagged');
  let expectedFeature = 0;
  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    const feature = buffers.featureIndices[triangle];
    if (triangle > 0 && feature !== buffers.featureIndices[triangle - 1]) expectedFeature += 1;
    assert.equal(feature, expectedFeature, 'feature ranges are contiguous');
  }
  const extents = modelExtentsFor(model);
  for (let i = 0; i < buffers.positions.length; i += 3) {
    assert.ok(buffers.positions[i] >= -extents.halfX * 3, 'x inside model');
    assert.ok(buffers.positions[i + 2] >= -extents.halfZ * 3, 'z inside model');
    assert.ok(buffers.positions[i + 1] >= 0, 'walls start at ground');
  }
});

test('building walls point away from the footprint centre (CCW and CW rings)', () => {
  for (const ring of [
    [-100, -100, 100, -100, 100, 100, -100, 100], // CCW in (x,z)
    [-100, -100, -100, 100, 100, 100, 100, -100] // CW
  ]) {
    const source = syntheticModel([{ p: ring, h: 100, t: 0, r: 0 }]);
    const buffers = buildBuildings(source);
    assert.equal(buffers.triangles, 10, '4 walls + cap');
    const positions = vertices(buffers);
    // First 8 triangles are walls; triangle centroids should look outward from
    // the origin (convex square centred on 0,0).
    for (let triangle = 0; triangle < 8; triangle += 1) {
      const normal = triangleNormal(positions, triangle);
      const offset = triangle * 9;
      const cx = (positions[offset] + positions[offset + 3] + positions[offset + 6]) / 3;
      const cz = (positions[offset + 2] + positions[offset + 5] + positions[offset + 8]) / 3;
      assert.ok(
        normal[0] * cx + normal[2] * cz > 0,
        `wall ${triangle} normal points inward (ring order ${ring[0]})`
      );
      assert.ok(Math.abs(normal[1]) < 1e-6, 'walls are vertical');
    }
    // The final cap triangles face up.
    for (let triangle = 8; triangle < 10; triangle += 1) {
      assert.ok(triangleNormal(positions, triangle)[1] > 0, 'cap faces up');
    }
  }
});

test('buildBuildings ignores degenerate or tiny footprints', () => {
  const source = syntheticModel([
    { p: [], h: 100, t: 0 },
    { p: [0, 0, 10, 0], h: 100, t: 0 }, // 1 edge
    { p: [0, 0, 1, 0, 0, 1], h: 100, t: 0 }, // ~0.005 m² sliver
    { p: [0, 0, 100, 0, 100, 100, 0, 100], h: Number.NaN, t: 2, r: 1 }
  ]);
  const buffers = buildBuildings(source);
  assert.ok(buffers.triangles > 0, 'valid building still emitted');
  assert.ok(buffers.triangles <= 12, 'invalid footprints skipped');
  for (const value of buffers.positions) assert.ok(Number.isFinite(value));
});

test('gable roofs add exactly six triangles over the renderable wall box', () => {
  const flat = syntheticModel([{ p: [-100, -100, 100, -100, 100, 100, -100, 100], h: 80, t: 0, r: 0 }]);
  const roofed = syntheticModel([{ p: [-100, -100, 100, -100, 100, 100, -100, 100], h: 80, t: 0, r: 1 }]);
  assert.equal(buildBuildings(flat).triangles, 10, '8 walls + 2 cap tris');
  assert.equal(buildBuildings(roofed).triangles, 14, '8 walls + 6 roof tris');
  // Roofed buildings have geometry above the wall height.
  const positions = vertices(buildBuildings(roofed));
  let maxY = 0;
  for (let i = 1; i < positions.length; i += 3) maxY = Math.max(maxY, positions[i]);
  assert.ok(maxY > 8, `roof ridge above 8 m, got ${maxY}`);
});

test('semantic tree-eligible building only roofs when flagged and low-rise', () => {
  const ring = [-100, -100, 100, -100, 100, 100, -100, 100];
  assert.equal(buildBuildings(syntheticModel([{ p: ring, h: 80, t: 0, r: 1 }])).triangles, 14);
  // r missing -> flat cap.
  assert.equal(buildBuildings(syntheticModel([{ p: ring, h: 80, t: 0 }])).triangles, 10);
  // Too tall for a "low-rise gable".
  assert.equal(buildBuildings(syntheticModel([{ p: ring, h: 400, t: 0, r: 1 }])).triangles, 10);
});

test('buildAreas triangulates polygons and holes with the right total area', () => {
  const outerArea = 1000 * 1000; // 1000 m square
  const holeArea = 400 * 400;
  const withHole = syntheticModel([]);
  withHole.areas = [
    {
      k: 2,
      p: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000],
      holes: [[-2000, -2000, 2000, -2000, 2000, 2000, -2000, 2000]]
    }
  ];
  const buffers = buildAreas(withHole);
  assert.ok(buffers.triangles >= 8, 'hole requires at least 8 triangles');
  let area = 0;
  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    const offset = triangle * 9;
    const p = buffers.positions;
    const x0 = p[offset];
    const z0 = p[offset + 2];
    const x1 = p[offset + 3];
    const z1 = p[offset + 5];
    const x2 = p[offset + 6];
    const z2 = p[offset + 8];
    area += Math.abs((x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0)) / 2;
  }
  assert.ok(
    Math.abs(area - (outerArea - holeArea)) < 1e-3,
    `triangulated area ${area} should be ${outerArea - holeArea}`
  );
  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    assert.ok(triangleNormal(buffers.positions, triangle)[1] > 0, 'area faces up');
    assert.ok(Math.abs(buffers.positions[triangle * 9 + 1] - AREA_LIFT_M[2]) < 1e-6, 'area lift');
  }
});

test('buildAreas handles the fixture and skips malformed rings', () => {
  const buffers = buildAreas(model);
  assert.ok(buffers.triangles > 0);
  assert.equal(buffers.positions.length, buffers.triangles * 9);
  assert.equal(buffers.featureIndices.length, buffers.triangles);
  const areaCounts = new Map<number, number>();
  for (const feature of buffers.featureIndices) {
    areaCounts.set(feature, (areaCounts.get(feature) ?? 0) + 1);
  }
  for (let area = 0; area < model.areas.length; area += 1) {
    assert.ok((areaCounts.get(area) ?? 0) > 0, `area ${area} tagged`);
  }
  const broken = syntheticModel([]);
  broken.areas = [
    { k: 1, p: [0, 0, 1, 0] },
    { k: 4, p: [0, 0, Number.NaN, 0, 10, 10] }
  ];
  assert.equal(buildAreas(broken).triangles, 0);
});

test('buildRoads ribbons the fixture and rises above areas', () => {
  const buffers = buildRoads(model);
  // 20 segments × 2 tris + 12 interior joints × 2 tris.
  assert.equal(buffers.triangles, 20 * 2 + 12 * 2);
  assert.equal(buffers.featureIndices.length, buffers.triangles);
  // Per-road triangle counts: 4-point roads = 3 segments + 2 joints (10 tris);
  // 2-point roads = a single segment (2 tris); the rail road has no joints.
  const expectedRoadTris = [10, 10, 10, 10, 10, 10, 2, 2];
  const counts = new Map<number, number>();
  for (const feature of buffers.featureIndices) {
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }
  for (let road = 0; road < expectedRoadTris.length; road += 1) {
    assert.equal(counts.get(road), expectedRoadTris[road], `road ${road} triangles`);
  }
  assert.ok(!counts.has(-1), 'every road triangle is tagged');
  const y = buffers.positions[1];
  assert.ok(y > AREA_LIFT_M[4], 'roads draw over areas');
  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    assert.ok(triangleNormal(buffers.positions, triangle)[1] > 0, 'roads face up');
  }
});

test('buildPlinth makes the stepped diorama base', () => {
  const extents = modelExtentsFor(model);
  const buffers = buildPlinth(extents);
  // 3 layers × (top face 2 + 4 sides × 2) triangles.
  assert.equal(buffers.triangles, 3 * 10);
  const profile = plinthProfile(extents);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < buffers.positions.length; i += 3) {
    minY = Math.min(minY, buffers.positions[i]);
    maxY = Math.max(maxY, buffers.positions[i]);
  }
  assert.ok(Math.abs(minY - profile.bottomY) < 1e-6, `bottom ${minY} vs ${profile.bottomY}`);
  assert.equal(maxY, 0, 'ground plate sits at y=0');
  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    const normal = triangleNormal(buffers.positions, triangle);
    assert.ok(Math.hypot(...normal) > 0, 'no degenerate plinth triangles');
  }
  assert.equal(buffers.featureIndices.length, buffers.triangles);
  assert.ok(
    buffers.featureIndices.every((feature) => feature === -1),
    'plinth is untagged'
  );
});

test('tree sites are deterministic, inside parks/forests and capped', () => {
  const first = sampleTreeSites(model);
  const second = sampleTreeSites(model);
  assert.ok(first.length > 0, 'fixture has park/forest areas');
  assert.ok(first.length <= 700);
  assert.deepEqual(first, second, 'deterministic tree placement');

  const parkRings: number[][] = [];
  for (const area of model.areas) {
    if (area.k !== 2 && area.k !== 3) continue;
    parkRings.push(area.p.map((value) => value / 10));
  }
  for (const site of first) {
    const inside = parkRings.some((ring) => pointInRing(site.x, site.z, ring));
    assert.ok(inside, `tree at (${site.x.toFixed(1)}, ${site.z.toFixed(1)}) outside park`);
    assert.ok(site.height > 0 && site.radius > 0);
    assert.ok(site.baseY > 0);
  }

  const treeBuffers = buildTrees(first);
  assert.equal(treeBuffers.triangles, first.length * 12);
  assert.equal(treeBuffers.positions.length, treeBuffers.triangles * 9);
  assert.equal(treeBuffers.featureIndices.length, treeBuffers.triangles);
  assert.ok(treeBuffers.featureIndices.every((feature) => feature === -1), 'trees untagged');
});

test('tree placement is capped even across many dense park polygons', () => {
  const dense = syntheticModel([]);
  const areas = [];
  for (let i = 0; i < 12; i += 1) {
    const x = (i % 4) * 3000;
    const z = Math.floor(i / 4) * 3000;
    areas.push({ k: 3 as const, p: [x, z, x + 2000, z, x + 2000, z + 2000, x, z + 2000] });
  }
  dense.areas = areas;
  const sites = sampleTreeSites(dense);
  assert.equal(sites.length, 700, 'hard tree cap');
  assert.equal(buildTrees(sites).triangles, 700 * 12);
});

test('empty and untagged buffers carry empty feature maps', () => {
  assert.equal(emptyBuffers().featureIndices.length, 0);
  const emptyBuildings = buildBuildings(syntheticModel([]));
  assert.equal(emptyBuildings.triangles, 0);
  assert.equal(emptyBuildings.featureIndices.length, 0);
  const emptyRoads = buildRoads(syntheticModel([]));
  assert.equal(emptyRoads.triangles, 0);
  assert.equal(emptyRoads.featureIndices.length, 0);
  const emptyAreas = buildAreas(syntheticModel([]));
  assert.equal(emptyAreas.triangles, 0);
  assert.equal(emptyAreas.featureIndices.length, 0);
});

test('buildModelBuffers returns one buffer per feature class', () => {
  const extents = modelExtentsFor(model);
  const buffers = buildModelBuffers(model, extents);
  assert.ok(buffers.plinth.triangles > 0);
  assert.ok(buffers.buildings.triangles > 0);
  assert.ok(buffers.roads.triangles > 0);
  assert.ok(buffers.areas.triangles > 0);
  assert.ok(buffers.trees.triangles > 0);
  assert.equal(buffers.treeCount, buffers.trees.triangles / 12);

  const empty = buildModelBuffers(null, defaultExtents());
  assert.ok(empty.plinth.triangles > 0);
  assert.equal(empty.buildings.triangles, 0);
  assert.equal(empty.trees.triangles, 0);
});

test('shadowRadiusFor covers the widest plinth plus margin', () => {
  const extents = defaultExtents();
  const profile = plinthProfile(extents);
  const radius = shadowRadiusFor(extents);
  assert.ok(radius > profile.outerHalfX);
  assert.ok(radius < profile.outerHalfX * 1.2);
});

test('gable roofs on rotated footprints face up and gables point outward', () => {
  // Rotated quadrilateral (decimetres): ridge logic must not assume axis alignment.
  const ring = [0, 0, 400, 100, 300, 500, -100, 400];
  const source = syntheticModel([{ p: ring, h: 80, t: 0, r: 1 }]);
  const buffers = buildBuildings(source);
  assert.equal(buffers.triangles, 14);
  const positions = buffers.positions;
  // 8 wall triangles, then 2 slope quads (4 tris) and 2 gable triangles.
  for (let triangle = 8; triangle < 12; triangle += 1) {
    assert.ok(triangleNormal(positions, triangle)[1] > 0, `slope ${triangle} faces up`);
  }
  // Footprint centroid in metres.
  const xs = [0, 40, 30, -10];
  const zs = [0, 10, 50, 40];
  const centerX = xs.reduce((a, b) => a + b, 0) / 4;
  const centerZ = zs.reduce((a, b) => a + b, 0) / 4;
  for (let triangle = 12; triangle < 14; triangle += 1) {
    const normal = triangleNormal(positions, triangle);
    assert.ok(Math.abs(normal[1]) < 1e-6, 'gable is vertical');
    const offset = triangle * 9;
    const mx = (positions[offset] + positions[offset + 3] + positions[offset + 6]) / 3;
    const mz = (positions[offset + 2] + positions[offset + 5] + positions[offset + 8]) / 3;
    assert.ok(
      normal[0] * (mx - centerX) + normal[2] * (mz - centerZ) > 0,
      'gable normal points away from the building'
    );
  }
});

test('concave (L-shaped) building walls point outside the footprint', () => {
  // L-shaped footprint in decimetres.
  const ring = [0, 0, 400, 0, 400, 200, 200, 200, 200, 400, 0, 400];
  const source = syntheticModel([{ p: ring, h: 60, t: 2, r: 0 }]);
  const buffers = buildBuildings(source);
  assert.equal(buffers.triangles, 6 * 2 + 4, '6 walls (2 tris each) + 4 cap tris');
  const ringMetres = ring.map((value) => value / 10);
  const positions = buffers.positions;
  const wallTriangles = 6 * 2;
  for (let triangle = 0; triangle < wallTriangles; triangle += 1) {
    const normal = triangleNormal(positions, triangle);
    const length = Math.hypot(normal[0], normal[2]);
    assert.ok(length > 0, 'wall normal is horizontal');
    const offset = triangle * 9;
    const mx = (positions[offset] + positions[offset + 3] + positions[offset + 6]) / 3;
    const mz = (positions[offset + 2] + positions[offset + 5] + positions[offset + 8]) / 3;
    const probeX = mx + (normal[0] / length) * 0.5;
    const probeZ = mz + (normal[2] / length) * 0.5;
    assert.equal(
      pointInRing(probeX, probeZ, ringMetres),
      false,
      `wall ${triangle} normal points into the footprint`
    );
  }
  // All cap triangles face up.
  for (let triangle = wallTriangles; triangle < buffers.triangles; triangle += 1) {
    assert.ok(triangleNormal(positions, triangle)[1] > 0, 'cap faces up');
  }
});
