/**
 * Unit tests for feature picking helpers: label mapping, triangle → record
 * resolution, NDC conversion and ground-plane ray intersection.
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CityModel } from '../../shared/types.ts';
import {
  AREA_KIND_LABELS,
  BUILDING_FALLBACK_LABEL,
  ROAD_KIND_LABELS,
  areaKindLabel,
  buildingKindLabel,
  featureAt,
  featureIndexForFace,
  hitFeatureForFace,
  roadKindLabel
} from '../../src/scene/features.ts';
import {
  buildAreas,
  buildBuildings,
  buildRoads
} from '../../src/scene/geometry.ts';
import { groundPointFromRay, ndcFromClient } from '../../src/scene/camera.ts';
import { hitFeatureForFace as _hitFeatureForFace } from '../../src/scene/features.ts';

const EMPTY_META = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: 'fixture' as const,
  seed: true,
  radiusM: 900,
  stats: { buildings: 0, roads: 0, areas: 0, dropped: 0 },
  warnings: [] as string[],
  attribution: 'test'
};

function namedModel(): CityModel {
  return {
    v: 1,
    key: 'named-v1',
    city: { geonameId: null, name: 'Test', country: 'XX', lat: 0, lon: 0, tz: 'UTC' },
    meta: EMPTY_META,
    bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, maxHeight: 200 },
    buildings: [
      // Named landmark with kind + height (143 dm = 14.3 m).
      { p: [0, 0, 200, 0, 200, 100, 0, 100], h: 143, t: 2, r: 0, n: 'Black Church', k: 'Church' },
      // Unnamed building: not pickable.
      { p: [400, 0, 500, 0, 500, 80, 400, 80], h: 80, t: 0, r: 0 },
      // Named but without a kind label → Landmark fallback.
      { p: [600, 0, 800, 0, 800, 120, 600, 120], h: 120, t: 1, n: 'Hotel Aro' }
    ],
    roads: [
      { c: 1, p: [-900, 0, 900, 20], n: 'Republicii' },
      { c: 4, p: [-900, 300, 900, 320] }, // unnamed, not pickable
      { c: 9, p: [-900, 600, 900, 620], n: 'Rail line' }
    ],
    areas: [
      { k: 2, p: [200, -600, 600, -600, 600, -200, 200, -200], n: 'Central Park' },
      { k: 1, p: [-600, -600, -200, -600, -200, -200, -600, -200] }, // unnamed water
      { k: 4, p: [-600, 400, -200, 400, -200, 800, -600, 800], n: 'Piata Sfatului' },
      { k: 3, p: [200, 400, 600, 400, 600, 800, 200, 800], n: 'Forest Hill' }
    ]
  };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/model-mini.json', import.meta.url)), 'utf8')
) as CityModel;

/* ------------------------------------------------------------------ */
/* Label mapping                                                       */
/* ------------------------------------------------------------------ */

test('road class labels follow the contract mapping', () => {
  assert.equal(roadKindLabel(1), 'Main street'); // arterial
  assert.equal(roadKindLabel(2), 'Primary street');
  assert.equal(roadKindLabel(3), 'Street');
  assert.equal(roadKindLabel(4), 'Pedestrian street');
  assert.equal(roadKindLabel(9), 'Railway');
  assert.equal(roadKindLabel(0), 'Street', 'unknown classes fall back to Street');
  assert.equal(roadKindLabel(7), 'Street');
  assert.deepEqual(Object.keys(ROAD_KIND_LABELS).map(Number), [1, 2, 3, 4, 9]);
});

test('area kind labels follow the contract mapping', () => {
  assert.equal(areaKindLabel(1), 'Lake/River');
  assert.equal(areaKindLabel(2), 'Park');
  assert.equal(areaKindLabel(3), 'Forest');
  assert.equal(areaKindLabel(4), 'Square/Green');
  assert.equal(areaKindLabel(7), 'Square/Green', 'unknown kinds fall back');
  assert.deepEqual(Object.keys(AREA_KIND_LABELS).map(Number), [1, 2, 3, 4]);
});

test('building kind label uses the OSM-derived k, else Landmark', () => {
  assert.equal(buildingKindLabel({ k: 'Museum' }), 'Museum');
  assert.equal(buildingKindLabel({ k: '  Church  ' }), 'Church');
  assert.equal(buildingKindLabel({ k: '   ' }), BUILDING_FALLBACK_LABEL);
  assert.equal(buildingKindLabel({}), 'Landmark');
});

/* ------------------------------------------------------------------ */
/* Record resolution                                                   */
/* ------------------------------------------------------------------ */

test('featureAt resolves named buildings with height in metres', () => {
  const model = namedModel();
  const hit = featureAt(model, 'building', 0);
  assert.ok(hit);
  assert.deepEqual(hit, {
    kind: 'building',
    name: 'Black Church',
    kindLabel: 'Church',
    heightM: 14.3
  });

  const fallback = featureAt(model, 'building', 2);
  assert.ok(fallback);
  assert.equal(fallback.name, 'Hotel Aro');
  assert.equal(fallback.kindLabel, 'Landmark', 'building without k gets Landmark');
  assert.equal(fallback.heightM, 12);

  assert.equal(featureAt(model, 'building', 1), null, 'unnamed building is not pickable');
});

test('featureAt resolves named roads and areas with class labels', () => {
  const model = namedModel();
  assert.deepEqual(featureAt(model, 'road', 0), {
    kind: 'road',
    name: 'Republicii',
    kindLabel: 'Main street'
  });
  assert.equal(featureAt(model, 'road', 1), null, 'unnamed road');
  assert.deepEqual(featureAt(model, 'road', 2), {
    kind: 'road',
    name: 'Rail line',
    kindLabel: 'Railway'
  });

  assert.deepEqual(featureAt(model, 'area', 0), {
    kind: 'area',
    name: 'Central Park',
    kindLabel: 'Park'
  });
  assert.equal(featureAt(model, 'area', 1), null, 'unnamed water');
  assert.equal(featureAt(model, 'area', 3)?.kindLabel, 'Forest');
});

test('featureAt rejects invalid indices and missing data', () => {
  const model = namedModel();
  assert.equal(featureAt(null, 'building', 0), null);
  assert.equal(featureAt(model, 'building', -1), null);
  assert.equal(featureAt(model, 'building', 1.5), null);
  assert.equal(featureAt(model, 'building', 99), null);
  assert.equal(featureAt(model, 'road', 99), null);
  assert.equal(featureAt(model, 'area', 99), null);

  const blank: CityModel = { ...model, buildings: [], roads: [], areas: [] };
  assert.equal(featureAt(blank, 'building', 0), null);
});

test('fixture records resolve only when they carry an OSM name', () => {
  for (let index = 0; index < fixture.buildings.length; index += 1) {
    const record = fixture.buildings[index];
    const hit = featureAt(fixture, 'building', index);
    assert.equal(hit === null, !record.n?.trim(), `building ${index} named iff pickable`);
    if (hit) assert.equal(hit.name, record.n?.trim());
  }
  for (let index = 0; index < fixture.roads.length; index += 1) {
    const hit = featureAt(fixture, 'road', index);
    assert.equal(hit === null, !fixture.roads[index].n?.trim(), `road ${index}`);
  }
  for (let index = 0; index < fixture.areas.length; index += 1) {
    const hit = featureAt(fixture, 'area', index);
    assert.equal(hit === null, !fixture.areas[index].n?.trim(), `area ${index}`);
  }
});

test('featureIndexForFace handles tagged, untagged and invalid faces', () => {
  const indices = new Int32Array([3, -1, 0, 7]);
  assert.equal(featureIndexForFace(indices, 0), 3);
  assert.equal(featureIndexForFace(indices, 1), null, '-1 is untagged');
  assert.equal(featureIndexForFace(indices, 2), 0);
  assert.equal(featureIndexForFace(indices, 3), 7);
  assert.equal(featureIndexForFace(indices, 4), null, 'out of range');
  assert.equal(featureIndexForFace(indices, -1), null);
  assert.equal(featureIndexForFace(indices, 1.5), null);
  assert.equal(featureIndexForFace(indices, null), null);
  assert.equal(featureIndexForFace(new Int32Array(0), 0), null);
  assert.equal(featureIndexForFace(null, 0), null);
});

test('hitFeatureForFace resolves nearest hit info and blocks unnamed faces', () => {
  const model = namedModel();
  const info = { kind: 'building' as const, featureIndices: new Int32Array([1, 0, -1]) };
  assert.equal(hitFeatureForFace(model, info, 1)?.name, 'Black Church');
  assert.equal(hitFeatureForFace(model, info, 0), null, 'nearest unnamed building → null');
  assert.equal(hitFeatureForFace(model, info, 2), null, 'untagged face → null');
  assert.equal(hitFeatureForFace(model, null, 0), null);
  assert.equal(hitFeatureForFace(null, info, 1), null);
});

/* ------------------------------------------------------------------ */
/* End-to-end triangle → feature mapping                               */
/* ------------------------------------------------------------------ */

test('built geometry triangles resolve back to the source records', () => {
  const model = namedModel();

  const buildings = buildBuildings(model);
  assert.equal(buildings.featureIndices.length, buildings.triangles);
  const buildingHits = new Set<string>();
  for (let face = 0; face < buildings.triangles; face += 1) {
    const featureIndex = buildings.featureIndices[face];
    assert.ok(featureIndex >= 0 && featureIndex < model.buildings.length);
    const hit = featureAt(model, 'building', featureIndex);
    if (featureIndex === 0) {
      assert.ok(hit);
      assert.equal(hit.name, 'Black Church');
      assert.equal(hit.heightM, 14.3);
      buildingHits.add(hit.name);
    } else if (featureIndex === 1) {
      assert.equal(hit, null, 'unnamed building resolves to null');
    } else {
      assert.equal(hit?.name, 'Hotel Aro');
    }
  }
  assert.deepEqual([...buildingHits], ['Black Church']);
  assert.equal(buildings.featureIndices[0], 0, 'first wall belongs to building 0');

  const roads = buildRoads(model);
  assert.equal(roads.featureIndices.length, roads.triangles);
  for (let face = 0; face < roads.triangles; face += 1) {
    const featureIndex = roads.featureIndices[face];
    if (featureIndex === 1) {
      assert.equal(featureAt(model, 'road', featureIndex), null, 'unnamed road null');
    } else if (featureIndex === 0) {
      assert.equal(featureAt(model, 'road', featureIndex)?.kindLabel, 'Main street');
    } else {
      assert.equal(featureAt(model, 'road', featureIndex)?.kindLabel, 'Railway');
    }
  }

  const areas = buildAreas(model);
  assert.equal(areas.featureIndices.length, areas.triangles);
  const areaLabels = new Set<string>();
  for (let face = 0; face < areas.triangles; face += 1) {
    const featureIndex = areas.featureIndices[face];
    const hit = featureAt(model, 'area', featureIndex);
    if (hit) areaLabels.add(`${hit.name}:${hit.kindLabel}`);
  }
  assert.deepEqual([...areaLabels].sort(), [
    'Central Park:Park',
    'Forest Hill:Forest',
    'Piata Sfatului:Square/Green'
  ]);
});

/* ------------------------------------------------------------------ */
/* Pointer helpers                                                     */
/* ------------------------------------------------------------------ */

test('ndcFromClient maps viewport pixels into clip space', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  assert.deepEqual(ndcFromClient(400, 300, rect), [0, 0]);
  assert.deepEqual(ndcFromClient(0, 0, rect), [-1, 1]);
  assert.deepEqual(ndcFromClient(800, 600, rect), [1, -1]);
  assert.deepEqual(ndcFromClient(200, 150, rect), [-0.5, 0.5]);

  const offset = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(ndcFromClient(200, 100, offset), [0, 0]);
  assert.equal(ndcFromClient(0, 0, { left: 0, top: 0, width: 0, height: 10 }), null);
  assert.equal(ndcFromClient(Number.NaN, 10, rect), null);
});

test('groundPointFromRay intersects the y=0 diorama ground plane', () => {
  assert.deepEqual(groundPointFromRay([0, 120, 0], [0, -1, 0]), { x: 0, z: 0 });
  assert.deepEqual(groundPointFromRay([10, 100, -20], [0, -0.5, 0.5]), { x: 10, z: 80 });
  assert.deepEqual(
    groundPointFromRay([-40, 250, 30], [0, -1, 0]),
    { x: -40, z: 30 },
    'orthographic vertical ray'
  );
  assert.equal(groundPointFromRay([0, 100, 0], [1, 0, 0]), null, 'parallel to ground');
  assert.equal(groundPointFromRay([0, 100, 0], [0, 1, 0]), null, 'pointing away');
  assert.equal(groundPointFromRay([Number.NaN, 100, 0], [0, -1, 0]), null);
  // Imported twice to prove the public barrel path stays stable.
  assert.equal(_hitFeatureForFace, hitFeatureForFace);
});

/* ------------------------------------------------------------------ */
/* Real Three.js raycast against merged buffers                        */
/* ------------------------------------------------------------------ */

test('three.js raycast faceIndex maps to the named source record', async () => {
  const THREE = await import('three');
  const model: CityModel = {
    ...namedModel(),
    // Single 40 m × 40 m landmark, walls + flat cap (14 + 2 triangles).
    buildings: [
      { p: [0, 0, 400, 0, 400, 400, 0, 400], h: 143, t: 2, r: 0, n: 'Black Church', k: 'Church' }
    ],
    roads: [],
    areas: []
  };
  const buffers = buildBuildings(model);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld(true);

  const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 1, 1000);
  camera.position.set(20, 300, 20);
  camera.up.set(0, 0, -1);
  camera.lookAt(20, 0, 20);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const intersections = raycaster.intersectObject(mesh, false);
  assert.ok(intersections.length > 0, 'ray must hit the building');
  const nearest = intersections[0];
  const faceIndex = nearest.faceIndex;
  assert.equal(typeof faceIndex, 'number');
  if (typeof faceIndex !== 'number') return;
  assert.ok(faceIndex >= 0 && faceIndex < buffers.triangles);

  const info = { kind: 'building' as const, featureIndices: buffers.featureIndices };
  const hit = hitFeatureForFace(model, info, faceIndex);
  assert.ok(hit, 'face must resolve to a named feature');
  assert.deepEqual(hit, {
    kind: 'building',
    name: 'Black Church',
    kindLabel: 'Church',
    heightM: 14.3
  });

  // The same face index resolves through the exact scene.ts path:
  // intersections[0] → pickInfo → featureIndices → featureAt.
  assert.equal(buffers.featureIndices[faceIndex], 0);
  geometry.dispose();
  material.dispose();
});
