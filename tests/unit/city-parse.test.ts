/**
 * OSM parsing + multipolygon assembly tests. No network involved.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CityError } from '../../server/city/errors.ts';
import { assembleRelationRings } from '../../server/city/osm/rings.ts';
import { parseOverpassJson, readOverpassRemark } from '../../server/city/osm/json.ts';
import { parseOsmXml } from '../../server/city/osm/xml.ts';
import { mergeRawOsmData } from '../../server/city/raw.ts';
import {
  FIXTURES_DIR,
  loadOsmXmlFixture,
  loadRawCityFixture
} from './city-helpers.ts';

test('parseOverpassJson parses the inline-geometry raw-city fixture', async () => {
  const raw = await loadRawCityFixture();
  assert.equal(raw.source, 'fixture');
  assert.equal(raw.ways.length, 26);
  assert.equal(raw.relations.length, 2);
  assert.equal(raw.nodes.length, 0);
  assert.deepEqual(raw.warnings, []);

  const house = raw.ways.find((way) => way.id === 1001);
  assert.ok(house, 'expected way 1001');
  assert.equal(house.tags.building, 'house');
  assert.equal(house.tags.height, '8');
  assert.ok(Array.isArray(house.geometry));
  assert.ok((house.geometry?.length ?? 0) >= 5, 'closed way geometry repeats the first point');
  assert.deepEqual(house.nodes, []);

  const water = raw.relations.find((relation) => relation.id === 2002);
  assert.ok(water);
  assert.equal(water.tags.natural, 'water');
  const roles = water.members.map((member) => member.role);
  assert.deepEqual(roles, ['outer', 'outer', 'inner']);
  assert.ok(water.members.every((member) => Array.isArray(member.geometry) && member.geometry.length >= 3));
});

test('parseOverpassJson supports node-referenced (out body; >) responses', () => {
  const payload = {
    version: 0.6,
    elements: [
      { type: 'node', id: 1, lat: 45.648, lon: 25.606 },
      { type: 'node', id: 2, lat: 45.649, lon: 25.606 },
      { type: 'node', id: 3, lat: 45.649, lon: 25.607 },
      { type: 'node', id: 4, lat: 45.648, lon: 25.607 },
      {
        type: 'way',
        id: 10,
        nodes: [1, 2, 3, 4, 1],
        tags: { building: 'yes', height: '12', amenity: 'school' }
      },
      {
        type: 'relation',
        id: 20,
        members: [{ type: 'way', ref: 10, role: 'outer' }],
        tags: { type: 'multipolygon', building: 'yes' }
      }
    ]
  };
  const raw = parseOverpassJson(JSON.stringify(payload), { source: 'overpass' });
  assert.equal(raw.nodes.length, 4);
  assert.equal(raw.ways.length, 1);
  assert.deepEqual(raw.ways[0].nodes, [1, 2, 3, 4, 1]);
  assert.equal(raw.ways[0].geometry, undefined);
  assert.equal(raw.relations.length, 1);
  assert.deepEqual(raw.relations[0].members, [{ type: 'way', ref: 10, role: 'outer' }]);
});

test('parseOverpassJson keeps only string tags and never pollutes prototypes', () => {
  const payload = {
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 45,
        lon: 25
      },
      {
        type: 'way',
        id: 2,
        nodes: [1, 1],
        tags: { building: 'yes', __proto__: 'polluted', numeric: 42, ignored: { nested: true } }
      }
    ]
  };
  const raw = parseOverpassJson(JSON.stringify(payload));
  const tags = raw.ways[0].tags;
  assert.equal(tags.building, 'yes');
  assert.equal(tags.numeric, '42');
  assert.equal(Object.prototype.hasOwnProperty.call(tags, 'ignored'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(tags), null);
});

test('parseOverpassJson reports malformed payloads as retryable CityError', () => {
  assert.throws(
    () => parseOverpassJson('<xml/>'),
    (error: unknown) => error instanceof CityError && error.code === 'PARSE_FAILED'
  );
  assert.throws(
    () => parseOverpassJson('{not json'),
    (error: unknown) => error instanceof CityError && error.code === 'PARSE_FAILED' && error.retryable
  );
  assert.throws(
    () => parseOverpassJson('{"elements": "nope"}'),
    (error: unknown) => error instanceof CityError && error.code === 'PARSE_FAILED'
  );
  assert.throws(
    () => parseOverpassJson('{"elements": [], "remark": "runtime error: Query timed out"}'),
    (error: unknown) => error instanceof CityError && error.code === 'PROVIDER_FAILED' && error.retryable
  );
});

test('readOverpassRemark extracts the remark string', () => {
  assert.equal(
    readOverpassRemark('{"version":0.6,"elements":[],"remark":"runtime error: Query timed out"}'),
    'runtime error: Query timed out'
  );
  assert.equal(readOverpassRemark('{"elements":[]}'), null);
});

test('parseOsmXml parses an OSM API map response', async () => {
  const raw = await loadOsmXmlFixture();
  assert.equal(raw.source, 'osm-api');
  assert.equal(raw.nodes.length, 12);
  assert.equal(raw.ways.length, 4);
  const house = raw.ways.find((way) => way.id === 6001);
  assert.ok(house);
  assert.deepEqual(house.nodes, [5001, 5002, 5003, 5004, 5001]);
  assert.equal(house.tags.building, 'house');
  assert.equal(house.tags.height, '9');
  const rail = raw.ways.find((way) => way.id === 6021);
  assert.equal(rail?.tags.railway, 'rail');
});

test('parseOsmXml rejects malformed XML with CityError', () => {
  assert.throws(
    () => parseOsmXml('<osm><node id="1" lat="45" lon="25"></osm>'),
    (error: unknown) => error instanceof CityError && error.code === 'PARSE_FAILED'
  );
  const empty = parseOsmXml('<osm version="0.6"></osm>');
  assert.equal(empty.ways.length, 0);
  assert.equal(empty.nodes.length, 0);
  assert.throws(
    () => parseOsmXml('{"elements": []}'),
    (error: unknown) => error instanceof CityError && error.code === 'PARSE_FAILED'
  );
});

test('mergeRawOsmData deduplicates tiled responses deterministically', () => {
  const xml = '<?xml version="1.0"?><osm version="0.6"><node id="1" lat="45" lon="25"/><node id="2" lat="45.1" lon="25.1"/><way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>';
  const a = parseOsmXml(xml, { source: 'osm-api' });
  const b = parseOsmXml(xml, { source: 'osm-api' });
  a.warnings.push('tile skipped');
  const merged = mergeRawOsmData([a, b], 'osm-api');
  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.ways.length, 1);
  assert.deepEqual(merged.warnings, ['tile skipped']);
  assert.equal(merged.source, 'osm-api');
});

test('assembleRelationRings joins split outer ways and assigns holes', () => {
  const outerA: Array<[number, number]> = [
    [0, 0],
    [100, 0],
    [100, 100]
  ];
  const outerB: Array<[number, number]> = [
    [100, 100],
    [0, 100],
    [0, 0]
  ];
  const hole: Array<[number, number]> = [
    [30, 30],
    [30, 70],
    [70, 70],
    [70, 30],
    [30, 30]
  ];
  const result = assembleRelationRings([
    { role: 'outer', points: outerA },
    { role: 'outer', points: outerB },
    { role: 'inner', points: hole }
  ]);
  assert.equal(result.rings.length, 1);
  assert.equal(result.rings[0].holes.length, 1);
  assert.equal(result.rings[0].outer.length, 4);
  assert.deepEqual(result.stats, {
    unclosed: 0,
    degenerate: 0,
    tooSmall: 0,
    unmatchedHoles: 0,
    tinyHoles: 0,
    ignoredRoles: 0
  });
});

test('assembleRelationRings drops unclosed rings and unmatched holes with stats', () => {
  const result = assembleRelationRings([
    { role: 'outer', points: [[0, 0], [10, 0], [10, 10]] },
    { role: 'inner', points: [[500, 500], [510, 500], [510, 510], [500, 510], [500, 500]] }
  ]);
  assert.equal(result.rings.length, 0);
  assert.equal(result.stats.unclosed, 1);
  assert.equal(result.stats.unmatchedHoles, 1);
});

test('assembleRelationRings handles a single already-closed way', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
    [0, 0]
  ];
  const result = assembleRelationRings([{ role: '', points: square }]);
  assert.equal(result.rings.length, 1);
  assert.equal(result.rings[0].outer.length, 4);
});

test('fixture files exist where the fixture provider expects them', async () => {
  const { access } = await import('node:fs/promises');
  await access(FIXTURES_DIR);
  await loadRawCityFixture();
});
