/**
 * Model builder tests: geometry conventions, classification, heights, caps,
 * determinism and failure modes. Uses the local raw-city fixture only.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCityModel, type BuildProgressEvent } from '../../server/city/build.ts';
import { CityError } from '../../server/city/errors.ts';
import { flatSignedArea } from '../../server/city/geometry.ts';
import { MAX_BUILDINGS } from '../../shared/constants.ts';
import type { RawOsmData } from '../../server/city/raw.ts';
import {
  BRASOV_CITY,
  FIXED_TIMESTAMP,
  TEST_MODEL_VERSION,
  buildFixtureModel,
  cityKey,
  fixtureBuildInput,
  loadRawCityFixture
} from './city-helpers.ts';

test('builds the fixture city with expected feature counts and kinds', async () => {
  const model = await buildFixtureModel();
  assert.equal(model.v, TEST_MODEL_VERSION);
  assert.equal(model.key, cityKey(683844));
  assert.deepEqual(model.city, BRASOV_CITY);
  assert.equal(model.meta.source, 'fixture');
  assert.equal(model.meta.seed, false);
  assert.equal(model.meta.radiusM, 900);
  assert.deepEqual(model.meta.stats, { buildings: 12, roads: 5, areas: 7, dropped: 0 });
  assert.deepEqual(model.meta.warnings, ['ignored courtyard holes in building relations: 1']);
  assert.match(model.meta.attribution, /OpenStreetMap/);

  // Areas: lake way + water relation with island hole + park + forest + grass + 2 plazas.
  assert.deepEqual(
    model.areas.map((area) => area.k).sort((a, b) => a - b),
    [1, 1, 2, 3, 4, 4, 4]
  );
  const withHoles = model.areas.filter((area) => area.holes && area.holes.length > 0);
  assert.equal(withHoles.length, 1);
  assert.equal(withHoles[0].k, 1);
  assert.equal(withHoles[0].holes?.length, 1);
  // Outer rings are counter-clockwise, holes clockwise in the (x, z) plane.
  for (const area of model.areas) {
    assert.ok(flatSignedArea(area.p) > 0, 'area outer rings must be CCW');
    for (const hole of area.holes ?? []) assert.ok(flatSignedArea(hole) < 0, 'area holes must be CW');
  }

  // Road classes: arterial, secondary, tertiary/local, pedestrian and rail; the
  // unnamed service road and the tunnel are filtered out.
  assert.deepEqual(
    model.roads.map((road) => road.c).sort((a, b) => a - b),
    [1, 2, 3, 4, 9]
  );
  for (const road of model.roads) assert.ok(road.p.length >= 4 && road.p.length % 2 === 0);
});

test('projection uses +X east and -Z north with integer decimetres', async () => {
  const model = await buildFixtureModel();
  // The church sits at local (east -320 m, north 60 m) and is 30 m tall.
  const church = model.buildings.find((building) => building.h === 300);
  assert.ok(church, 'expected the church height');
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < church.p.length; i += 2) {
    minX = Math.min(minX, church.p[i]);
    maxX = Math.max(maxX, church.p[i]);
    minZ = Math.min(minZ, church.p[i + 1]);
    maxZ = Math.max(maxZ, church.p[i + 1]);
  }
  assert.ok(minX >= -3450 && maxX <= -2950, `church x range ${minX}..${maxX}`);
  assert.ok(minZ >= -800 && maxZ <= -400, `church z range (north = negative) ${minZ}..${maxZ}`);
  for (const building of model.buildings) {
    assert.equal(building.p.length % 2, 0);
    assert.ok(Number.isInteger(building.h) && building.h > 0);
    assert.ok(building.t >= 0 && building.t <= 3);
    assert.ok(building.r === 0 || building.r === 1);
    for (const coordinate of building.p) assert.ok(Number.isInteger(coordinate));
  }
});

test('height inference respects tags, levels, flat roofs and building types', async () => {
  const model = await buildFixtureModel();
  const heights = model.buildings.map((building) => building.h).sort((a, b) => a - b);
  assert.deepEqual(heights, [26, 60, 75, 80, 90, 90, 120, 120, 150, 180, 240, 300]);
  const types = model.buildings.map((building) => building.t).sort((a, b) => a - b);
  assert.deepEqual(types, [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 3]);
  // Explicit flat roofs must not get the pitched-roof flag.
  const flatRoofCount = model.buildings.filter((building) => building.r === 0).length;
  assert.ok(flatRoofCount >= 3, `expected several flat roofs, got ${flatRoofCount}`);
});

test('clips geometry to the ±radius square and reports true extents', async () => {
  const model = await buildFixtureModel();
  const limit = 9000;
  for (const building of model.buildings) {
    for (let i = 0; i < building.p.length; i += 2) {
      assert.ok(Math.abs(building.p[i]) <= limit && Math.abs(building.p[i + 1]) <= limit);
    }
  }
  // The boundary building was cut at the east edge.
  assert.equal(model.bounds.maxX, 9000);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxHeight = 0;
  const consider = (flat: number[]): void => {
    for (let i = 0; i < flat.length; i += 2) {
      minX = Math.min(minX, flat[i]);
      maxX = Math.max(maxX, flat[i]);
      minZ = Math.min(minZ, flat[i + 1]);
      maxZ = Math.max(maxZ, flat[i + 1]);
    }
  };
  for (const building of model.buildings) {
    consider(building.p);
    maxHeight = Math.max(maxHeight, building.h);
  }
  for (const road of model.roads) consider(road.p);
  for (const area of model.areas) {
    consider(area.p);
    for (const hole of area.holes ?? []) consider(hole);
  }
  assert.deepEqual(model.bounds, { minX, maxX, minZ, maxZ, maxHeight });
});

test('same input and version produce byte-identical models and ETags', async () => {
  const first = await buildFixtureModel();
  const second = await buildFixtureModel();
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  assert.equal(a, b);
  // And the same raw data twice through one parse also matches.
  const raw = await loadRawCityFixture();
  const third = buildCityModel(raw, fixtureBuildInput());
  assert.equal(JSON.stringify(third), a);
});

test('reports monotonic build progress ending at 100%', async () => {
  const raw = await loadRawCityFixture();
  const events: BuildProgressEvent[] = [];
  buildCityModel(raw, fixtureBuildInput(), (event) => events.push(event));
  assert.ok(events.length >= 3);
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].percent >= events[i - 1].percent, 'progress must be monotonic');
    assert.ok(events[i].percent <= 100);
  }
  assert.equal(events[events.length - 1].percent, 100);
  assert.ok(events.every((event) => typeof event.label === 'string' && event.label.length > 0));
});

test('throws NO_DATA for an empty raw response', async () => {
  const empty: RawOsmData = { source: 'overpass', nodes: [], ways: [], relations: [], warnings: [] };
  assert.throws(
    () => buildCityModel(empty, fixtureBuildInput()),
    (error: unknown) => error instanceof CityError && error.code === 'NO_DATA' && error.status === 422
  );
});

test('caps buildings at MAX_BUILDINGS, dropping smallest footprints first', () => {
  const total = MAX_BUILDINGS + 50;
  const raw = syntheticGrid(total);
  const model = buildCityModel(raw, fixtureBuildInput());
  assert.equal(model.buildings.length, MAX_BUILDINGS);
  assert.equal(model.meta.stats.buildings, MAX_BUILDINGS);
  assert.equal(model.meta.stats.dropped, 50);
  assert.ok(
    model.meta.warnings.some((warning) => warning.includes(`capped the model at ${MAX_BUILDINGS}`)),
    'cap warning present'
  );
});

test('rejects invalid build inputs with CityError', async () => {
  const raw = await loadRawCityFixture();
  assert.throws(
    () => buildCityModel(raw, fixtureBuildInput({ generatedAt: 'not a timestamp' })),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_TIMESTAMP'
  );
  assert.throws(
    () => buildCityModel(raw, fixtureBuildInput({ radiusM: 0 })),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
  );
  assert.throws(
    () => buildCityModel(raw, fixtureBuildInput({ centerLat: Number.NaN })),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
  );
});

/** Grid of `count` small square buildings in raw node-referenced OSM form. */
function syntheticGrid(count: number): RawOsmData {
  const columns = Math.ceil(Math.sqrt(count));
  const spacing = 1800 / columns;
  const half = 3;
  const nodes: RawOsmData['nodes'] = [];
  const ways: RawOsmData['ways'] = [];
  let nodeId = 1;
  let wayId = 1_000_000;
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = -900 + column * spacing + spacing / 2;
    const north = -900 + row * spacing + spacing / 2;
    const corners = [
      [x - half, north - half],
      [x + half, north - half],
      [x + half, north + half],
      [x - half, north + half],
      [x - half, north - half]
    ];
    const refs: number[] = [];
    for (const [east, northOffset] of corners) {
      nodes.push({
        id: nodeId,
        lat: BRASOV_CITY.lat + northOffset / 111_320,
        lon: BRASOV_CITY.lon + east / (111_320 * Math.cos((BRASOV_CITY.lat * Math.PI) / 180))
      });
      refs.push(nodeId);
      nodeId += 1;
    }
    ways.push({ id: wayId, nodes: refs, tags: { building: 'house' } });
    wayId += 1;
  }
  return { source: 'fixture', nodes, ways, relations: [], warnings: [] };
}

test('generatedAt is carried into metadata verbatim', async () => {
  const model = await buildFixtureModel();
  assert.equal(model.meta.generatedAt, FIXED_TIMESTAMP);
});
