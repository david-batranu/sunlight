import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RECENT_LIMIT,
  addRecent,
  parseRecent,
  serializeRecent,
  type RecentCity
} from '../../src/ui/recent.ts';

const city = (geonameId: number, name: string): RecentCity => ({
  geonameId,
  name,
  country: 'RO',
  tz: 'Europe/Bucharest'
});

test('recent cities parse defensively', () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent(''), []);
  assert.deepEqual(parseRecent('nonsense'), []);
  assert.deepEqual(parseRecent('{"not":"an array"}'), []);
  assert.deepEqual(
    parseRecent('[{"geonameId":683844,"name":"Brașov","country":"RO","tz":"Europe/Bucharest"}]'),
    [{ geonameId: 683844, name: 'Brașov', country: 'RO', tz: 'Europe/Bucharest' }]
  );
  assert.deepEqual(
    parseRecent('[{"geonameId":"bad","name":"X"},{"geonameId":1,"name":"","country":"RO","tz":"UTC"},{"name":"Y"}]'),
    []
  );
});

test('recent cities are de-duplicated and capped', () => {
  let list: RecentCity[] = [];
  for (let index = 1; index <= RECENT_LIMIT + 3; index += 1) {
    list = addRecent(list, city(index, `City ${index}`));
  }
  assert.equal(list.length, RECENT_LIMIT);
  assert.equal(list[0].name, `City ${RECENT_LIMIT + 3}`);

  const promoted = addRecent(list, city(2, 'Updated City'));
  assert.equal(promoted.length, RECENT_LIMIT);
  assert.equal(promoted[0].geonameId, 2);
  assert.equal(promoted[0].name, 'Updated City');
  assert.equal(promoted.filter((entry) => entry.geonameId === 2).length, 1);
});

test('recent cities round-trip through storage', () => {
  const list = [city(683844, 'Brașov'), city(683506, 'București')];
  const raw = serializeRecent(list);
  assert.deepEqual(parseRecent(raw), list);
});
