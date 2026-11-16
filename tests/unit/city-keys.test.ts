/**
 * Model key formatting/validation tests.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CityError } from '../../server/city/errors.ts';
import {
  assertValidModelKey,
  cityModelKey,
  formatCoordinate,
  isValidModelKey,
  modelKeyForTarget,
  pointModelKey
} from '../../server/city/keys.ts';

test('city keys include GeoNames id, radius and model version', () => {
  assert.equal(cityModelKey(683844, 900, 1), 'gn-683844-r900-v1');
  assert.equal(cityModelKey(1, 1500, 3), 'gn-1-r1500-v3');
  assert.throws(
    () => cityModelKey(0, 900, 1),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
  );
});

test('point keys are deterministic and round coordinates to five decimals', () => {
  assert.equal(pointModelKey(45.64861, 25.60613, 900, 1), 'pt-45.64861_25.60613-r900-v1');
  assert.equal(pointModelKey(-33.9249, -70.6403, 900, 1), 'pt--33.92490_-70.64030-r900-v1');
  assert.equal(pointModelKey(45.648614, 25.606134, 900, 1), pointModelKey(45.648611, 25.606131, 900, 1));
});

test('formatCoordinate never emits negative zero', () => {
  assert.equal(formatCoordinate(-0, 5), '0.00000');
  assert.equal(formatCoordinate(0, 5), '0.00000');
  assert.equal(formatCoordinate(-1.5, 2), '-1.50');
  assert.throws(
    () => formatCoordinate(Number.NaN),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_TARGET'
  );
});

test('modelKeyForTarget dispatches on target kind', () => {
  assert.equal(modelKeyForTarget({ kind: 'city', geonameId: 683844 }, 900, 1), 'gn-683844-r900-v1');
  assert.equal(
    modelKeyForTarget({ kind: 'point', lat: 45.64861, lon: 25.60613 }, 900, 1),
    'pt-45.64861_25.60613-r900-v1'
  );
});

test('isValidModelKey accepts canonical keys and rejects anything else', () => {
  assert.equal(isValidModelKey('gn-683844-r900-v1'), true);
  assert.equal(isValidModelKey('pt--33.92490_-70.64030-r900-v1'), true);
  for (const invalid of [
    '',
    'gn-683844',
    'gn-0-r900-v1',
    'gn-683844-r90-v1',
    'gn-683844-r900-v0',
    '../etc/passwd',
    'gn-683844-r900-v1/../../x',
    'gn-683844-r900-v1\n',
    'pt-45.64861_25.60613-r900-v01',
    'x'.repeat(200)
  ]) {
    assert.equal(isValidModelKey(invalid), false, `expected invalid: ${JSON.stringify(invalid)}`);
  }
});

test('assertValidModelKey throws a 400 CityError for bad keys', () => {
  assert.equal(assertValidModelKey('gn-683844-r900-v1'), 'gn-683844-r900-v1');
  assert.throws(
    () => assertValidModelKey('../../etc/passwd'),
    (error: unknown) => error instanceof CityError && error.code === 'INVALID_KEY' && error.status === 400
  );
});
