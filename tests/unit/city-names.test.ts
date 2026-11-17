/**
 * Landmark/road/area name metadata tests (task: tooltips).
 *
 * Covers the sanitize/label helpers, fixture names, unnamed features omitting
 * fields, the deterministic 1200-landmark cap, persisted-model validation and
 * radius-agnostic builds. No network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCityModel } from '../../server/city/build.ts';
import { MODEL_VERSION } from '../../shared/constants.ts';
import { MAX_NAME_LENGTH, MAX_NAMED_BUILDINGS } from '../../server/city/names.ts';
import {
  isNamedLandmark,
  osmName,
  sanitizeKind,
  sanitizeName,
  shortKindLabel
} from '../../server/city/names.ts';
import { validateCityModel } from '../../server/city/model-io.ts';
import { CityError } from '../../server/city/errors.ts';
import type { RawOsmData } from '../../server/city/raw.ts';
import type { BuildingRecord, CityModel } from '../../shared/types.ts';
import {
  BRASOV_CITY,
  buildFixtureModel,
  cityKey,
  fixtureBuildInput,
  loadRawCityFixture
} from './city-helpers.ts';

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BRASOV_CITY.lat * Math.PI) / 180);

/** Appends a rectangular named building way (node-referenced form) to raw data. */
function appendBuilding(
  raw: RawOsmData,
  tags: Record<string, string>,
  options: { east: number; north: number; halfSize?: number }
): void {
  const half = options.halfSize ?? 5;
  let nextNodeId = 1;
  for (const node of raw.nodes) nextNodeId = Math.max(nextNodeId, node.id + 1);
  let nextWayId = 1_000_000;
  for (const way of raw.ways) nextWayId = Math.max(nextWayId, way.id + 1);
  const corners: Array<[number, number]> = [
    [options.east - half, options.north - half],
    [options.east + half, options.north - half],
    [options.east + half, options.north + half],
    [options.east - half, options.north + half],
    [options.east - half, options.north - half]
  ];
  const refs: number[] = [];
  for (const [east, north] of corners) {
    raw.nodes.push({
      id: nextNodeId,
      lat: BRASOV_CITY.lat + north / M_PER_DEG_LAT,
      lon: BRASOV_CITY.lon + east / M_PER_DEG_LON
    });
    refs.push(nextNodeId);
    nextNodeId += 1;
  }
  raw.ways.push({ id: nextWayId, nodes: refs, tags: { ...tags } });
}

function named(model: CityModel): BuildingRecord[] {
  return model.buildings.filter((building) => building.n !== undefined);
}

function byName(model: CityModel, name: string): BuildingRecord | undefined {
  return model.buildings.find((building) => building.n === name);
}

/* ------------------------------------------------------------------ */
/* Sanitizers                                                          */
/* ------------------------------------------------------------------ */

test('sanitizeName trims, collapses whitespace, drops control chars and caps length', () => {
  assert.equal(sanitizeName('  Central   Park  '), 'Central Park');
  assert.equal(sanitizeName('Foo\u0000\u0007Bar'), 'Foo Bar');
  assert.equal(sanitizeName('Line\nBreak\tHere'), 'Line Break Here');
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(undefined), null);
  assert.equal(sanitizeName(42), null);
  const long = 'A'.repeat(MAX_NAME_LENGTH + 20);
  assert.equal(sanitizeName(long)?.length, MAX_NAME_LENGTH);
  const longWithSpaces = `${'word '.repeat(30)}tail`;
  assert.ok((sanitizeName(longWithSpaces)?.length ?? 0) <= MAX_NAME_LENGTH);
  assert.equal(sanitizeName(longWithSpaces)?.endsWith(' '), false);
});

test('osmName prefers name over name:en and ignores empty values', () => {
  assert.equal(osmName({ name: 'Brașov', 'name:en': 'Brasov' }), 'Brașov');
  assert.equal(osmName({ name: '', 'name:en': 'Brasov' }), 'Brasov');
  assert.equal(osmName({ name: '   ', 'name:en': 'Fallback Name' }), 'Fallback Name');
  assert.equal(osmName({}), null);
  assert.equal(osmName({ 'name:en': '' }), null);
});

test('sanitizeKind title-cases tags and omits generic values', () => {
  assert.equal(sanitizeKind('place_of_worship'), 'Place Of Worship');
  assert.equal(sanitizeKind('town-hall'), 'Town Hall');
  assert.equal(sanitizeKind('MUSEUM'), 'Museum');
  for (const generic of ['yes', 'no', 'building', 'other', 'unknown', '', '   ']) {
    assert.equal(sanitizeKind(generic), null, `expected generic ${JSON.stringify(generic)} to be omitted`);
  }
  assert.equal(sanitizeKind(undefined), null);
  const longKind = sanitizeKind('a_very_long_value_that_is_definitely_longer_than_forty_chars_here');
  assert.ok(longKind && longKind.length <= 40, `kind label should stay short, got ${String(longKind)}`);
});

test('shortKindLabel prefers tourism, historic, amenity then building type', () => {
  assert.equal(shortKindLabel({ tourism: 'hotel', building: 'yes' }), 'Hotel');
  assert.equal(shortKindLabel({ historic: 'castle', building: 'yes' }), 'Castle');
  assert.equal(shortKindLabel({ amenity: 'museum', building: 'yes' }), 'Museum');
  assert.equal(shortKindLabel({ building: 'church' }), 'Church');
  assert.equal(shortKindLabel({ building: 'yes' }), null);
  assert.equal(shortKindLabel({ building: 'yes', shop: 'bakery' }), null);
  assert.equal(shortKindLabel({}), null);
});

test('isNamedLandmark applies the documented rules', () => {
  assert.equal(isNamedLandmark({ name: 'A', tourism: 'museum' }, 0, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', historic: 'castle' }, 0, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', amenity: 'school' }, 2, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', shop: 'bakery' }, 1, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', office: 'company' }, 1, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', leisure: 'sports_centre' }, 0, 8), true);
  assert.equal(isNamedLandmark({ name: 'A', building: 'house' }, 0, 25), true, '>= 25 m is a landmark');
  assert.equal(isNamedLandmark({ name: 'A', building: 'church' }, 2, 8), true, 'civic type is a landmark');
  assert.equal(isNamedLandmark({ name: 'A', building: 'apartments' }, 0, 24), false);
  assert.equal(isNamedLandmark({ building: 'house', tourism: 'museum' }, 0, 8), false, 'needs a name');
  assert.equal(isNamedLandmark({ name: '   ', building: 'church' }, 2, 8), false);
});

/* ------------------------------------------------------------------ */
/* Fixture names                                                       */
/* ------------------------------------------------------------------ */

test('fixture city carries landmark building, road and area names', async () => {
  const model = await buildFixtureModel();

  const school = byName(model, 'Școala Centrală');
  assert.ok(school, 'expected the named school');
  assert.equal(school.k, 'School');
  assert.equal(school.t, 2);

  // Named but not a landmark: no POI tags, residential, below the height bar.
  assert.equal(byName(model, 'Bloc A'), undefined);

  // Unnamed buildings omit both fields entirely.
  const church = model.buildings.find((building) => building.h === 300);
  assert.ok(church);
  assert.equal('n' in church, false);
  assert.equal('k' in church, false);

  const roads = model.roads.filter((road) => road.n !== undefined);
  assert.deepEqual(
    roads.map((road) => [road.c, road.n]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      [1, 'Bulevardul Eroilor'],
      [2, 'Strada Republicii'],
      [3, 'Strada Sforii']
    ]
  );
  const rail = model.roads.find((road) => road.c === 9);
  assert.ok(rail);
  assert.equal('n' in rail, false);

  const namedAreas = model.areas.filter((area) => area.n !== undefined).map((area) => area.n);
  assert.deepEqual(namedAreas.sort(), ['Lacul Mic', 'Lacul cu insulă', 'Parcul Central', 'Piața Sfatului', 'Piața Unirii'].sort());
  // Unnamed forest/grass areas omit the field.
  const unnamedAreas = model.areas.filter((area) => area.n === undefined);
  assert.equal(unnamedAreas.length, 2);
  for (const area of unnamedAreas) assert.equal('n' in area, false);
});

test('synthetic landmark tags produce predictable names and kind labels', async () => {
  const raw = await loadRawCityFixture();
  appendBuilding(raw, { building: 'yes', tourism: 'museum', name: 'Muzeul de Artă' }, { east: 100, north: 100 });
  appendBuilding(raw, { building: 'yes', tourism: 'hotel', 'name:en': 'Sunrise Hotel' }, { east: 140, north: 100 });
  appendBuilding(raw, { building: 'yes', historic: 'castle', name: 'Cetățuia' }, { east: 180, north: 100 });
  appendBuilding(raw, { building: 'house', name: 'Turnul Alb', height: '30' }, { east: 220, north: 100 });
  appendBuilding(raw, { building: 'church', name: 'Biserica Neagră', height: '18' }, { east: 260, north: 100 });
  appendBuilding(raw, { building: 'yes', shop: 'bakery', name: 'Brutăria de Aur' }, { east: 300, north: 100 });
  appendBuilding(raw, { building: 'yes', amenities: 'nonsense', name: '   ' }, { east: 340, north: 100 });
  appendBuilding(raw, { building: 'yes', tourism: 'attraction', name: '  Foo\u0000  Bar  ' }, { east: 380, north: 100 });
  appendBuilding(raw, { building: 'yes', tourism: 'attraction', name: 'L'.repeat(MAX_NAME_LENGTH + 30) }, { east: 420, north: 100 });

  const model = buildCityModel(raw, fixtureBuildInput());

  const museum = byName(model, 'Muzeul de Artă');
  assert.ok(museum);
  assert.equal(museum.k, 'Museum');

  const hotel = byName(model, 'Sunrise Hotel');
  assert.ok(hotel, 'name:en fallback should be used');
  assert.equal(hotel.k, 'Hotel');

  const castle = byName(model, 'Cetățuia');
  assert.ok(castle);
  assert.equal(castle.k, 'Castle');

  const tall = byName(model, 'Turnul Alb');
  assert.ok(tall, 'tall named houses are landmarks');
  assert.equal(tall.k, 'House');

  const civic = byName(model, 'Biserica Neagră');
  assert.ok(civic, 'civic buildings are landmarks even when short');
  assert.equal(civic.k, 'Church');

  const shop = byName(model, 'Brutăria de Aur');
  assert.ok(shop, 'shops are landmarks');
  assert.equal('k' in shop, false, 'no generic kind label for building=yes shops');

  const sanitized = byName(model, 'Foo Bar');
  assert.ok(sanitized, 'control characters and whitespace are sanitized');

  const truncated = model.buildings.filter((building) => building.n !== undefined && building.n.length === MAX_NAME_LENGTH);
  assert.equal(truncated.length, 1);
  assert.ok(truncated[0].n?.startsWith('LLL'));

  // Unnamed / whitespace-named features never emit a label.
  for (const building of model.buildings) {
    if (building.n === undefined) assert.equal('k' in building, false);
    else assert.ok(building.n.length <= MAX_NAME_LENGTH);
    if (building.k !== undefined) assert.ok(building.k.length <= 40);
  }
  assert.equal(named(model).length, 9);
});

test('caps landmark names deterministically, dropping smallest footprints first', () => {
  const raw: RawOsmData = { source: 'fixture', nodes: [], ways: [], relations: [], warnings: [] };
  const total = MAX_NAMED_BUILDINGS + 100;
  // 100 tiny named hotels first (smallest), then MAX named larger hotels.
  for (let index = 0; index < total; index += 1) {
    const tiny = index < 100;
    const half = tiny ? 2 : 6;
    const east = -800 + (index % 40) * 40;
    const north = -800 + Math.floor(index / 40) * 40;
    appendBuilding(
      raw,
      { building: 'yes', tourism: 'hotel', name: `Hotel ${index}` },
      { east, north, halfSize: half }
    );
  }
  const model = buildCityModel(raw, fixtureBuildInput());
  assert.equal(named(model).length, MAX_NAMED_BUILDINGS);
  assert.ok(
    model.meta.warnings.some((warning) => warning.includes('dropped landmark names above the cap')),
    'expected a cap warning'
  );

  // The tiny hotels are the ones dropped: every surviving named footprint is large.
  for (const building of named(model)) {
    const xs = building.p.filter((_, index) => index % 2 === 0);
    const width = Math.max(...xs) - Math.min(...xs);
    assert.ok(width >= 100, `named building should be a large footprint, got width ${width}`);
    assert.ok(building.k === 'Hotel');
  }
  assert.equal(model.buildings.length - named(model).length, 100);
});

/* ------------------------------------------------------------------ */
/* Persistence + payload                                               */
/* ------------------------------------------------------------------ */

test('persisted-model validation accepts names and rejects malformed ones', async () => {
  const model = await buildFixtureModel();
  const roundTripped = validateCityModel(JSON.parse(JSON.stringify(model)));
  assert.equal(byName(roundTripped, 'Școala Centrală')?.k, 'School');

  const withBadBuildingName = JSON.parse(JSON.stringify(model));
  withBadBuildingName.buildings[0].n = '';
  assert.throws(
    () => validateCityModel(withBadBuildingName),
    (error: unknown) => error instanceof CityError && error.code === 'MODEL_CORRUPT'
  );

  const withLongName = JSON.parse(JSON.stringify(model));
  withLongName.buildings[0].n = 'x'.repeat(MAX_NAME_LENGTH + 1);
  assert.throws(() => validateCityModel(withLongName), /at most 80/);

  const withBadRoadName = JSON.parse(JSON.stringify(model));
  withBadRoadName.roads[0].n = 42;
  assert.throws(() => validateCityModel(withBadRoadName), /road\.n/);

  const withBadAreaName = JSON.parse(JSON.stringify(model));
  withBadAreaName.areas[0].n = '   ';
  assert.throws(() => validateCityModel(withBadAreaName), /area\.n/);
});

test('names keep model bytes deterministic', async () => {
  const first = await buildFixtureModel();
  const second = await buildFixtureModel();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const raw = await loadRawCityFixture();
  appendBuilding(raw, { building: 'yes', tourism: 'museum', name: 'Muzeul Unu' }, { east: 120, north: -120 });
  const modelA = buildCityModel(raw, fixtureBuildInput());
  const modelB = buildCityModel(raw, fixtureBuildInput());
  assert.equal(JSON.stringify(modelA), JSON.stringify(modelB));
  assert.ok(byName(modelA, 'Muzeul Unu'));
});

test('build stays radius-agnostic (600 m and 1500 m both work)', async () => {
  const raw = await loadRawCityFixture();
  const clipped = buildCityModel(raw, fixtureBuildInput({ radiusM: 600, key: 'gn-683844-r600-v2' }));
  const wide = buildCityModel(raw, fixtureBuildInput({ radiusM: 1500, key: 'gn-683844-r1500-v3' }));

  assert.equal(clipped.meta.radiusM, 600);
  assert.equal(wide.meta.radiusM, 1500);
  for (const model of [clipped, wide]) {
    for (const building of model.buildings) {
      for (let index = 0; index < building.p.length; index += 2) {
        assert.ok(Math.abs(building.p[index]) <= model.meta.radiusM * 10);
        assert.ok(Math.abs(building.p[index + 1]) <= model.meta.radiusM * 10);
      }
    }
  }
  assert.ok(clipped.buildings.length < 12, 'the boundary building is clipped away at 600 m');
  assert.equal(wide.buildings.length, 12);
  assert.equal(byName(wide, 'Școala Centrală')?.n, 'Școala Centrală');
  assert.equal(cityKey(683844), `gn-683844-r900-v${MODEL_VERSION}`);
});
