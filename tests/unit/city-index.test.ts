/**
 * GeoNames city index tests (real bundled index; no network).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CityIndex, normalizeCityName } from '../../server/city/city-index.ts';
import { CITIES_INDEX_PATH } from './city-helpers.ts';

const index = await CityIndex.load(CITIES_INDEX_PATH);

test('loads the full bundled city index', () => {
  assert.equal(index.count, 64727);
  const brasov = index.get(683844);
  assert.ok(brasov);
  assert.equal(brasov.name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'Brasov');
  assert.equal(brasov.country, 'RO');
  assert.equal(brasov.tz, 'Europe/Bucharest');
  assert.ok(brasov.population > 200_000);
});

test('normalizeCityName folds diacritics, punctuation and case', () => {
  assert.equal(normalizeCityName('Brașov'), 'brasov');
  assert.equal(normalizeCityName('Braşov'), 'brasov'); // cedilla spelling
  assert.equal(normalizeCityName('Timișoara'), 'timisoara');
  assert.equal(normalizeCityName('Cluj-Napoca'), 'cluj napoca');
  assert.equal(normalizeCityName('  Iaşi '), 'iasi');
  assert.equal(normalizeCityName('SÃO PAULO'), 'sao paulo');
  assert.equal(normalizeCityName(''), '');
});

test('search is diacritic-insensitive and ranks exact matches first', () => {
  const byDiacritic = index.search('brasov', 5);
  assert.equal(byDiacritic[0].geonameId, 683844);
  assert.equal(byDiacritic[0].asciiName, 'Brasov');
  assert.equal(byDiacritic[0].countryName, 'Romania');

  const byPlain = index.search('Iasi', 5);
  assert.ok(byPlain.some((result) => result.geonameId === 675810), 'expected Iași');

  const cluj = index.search('cluj', 5);
  assert.equal(cluj[0].geonameId, 681290);

  const timisoara = index.search('timisoara', 5);
  assert.equal(timisoara[0].geonameId, 665087);
});

test('search returns an empty list for empty or unknown queries', () => {
  assert.deepEqual(index.search('', 10), []);
  assert.deepEqual(index.search('   ', 10), []);
  assert.deepEqual(index.search('zzzzqqqqnotacity', 10), []);
});

test('search respects the limit and is deterministic', () => {
  const first = index.search('a', 3).map((result) => result.geonameId);
  assert.equal(first.length, 3);
  const second = index.search('a', 3).map((result) => result.geonameId);
  assert.deepEqual(first, second);
  assert.equal(index.search('a', 0).length, 0);
});

test('search flags seeded cities via the lookup callback', () => {
  const results = index.search('brasov', 3, (id) => (id === 683844 ? 'brasov' : null));
  assert.equal(results[0].seed, true);
  assert.equal(results[0].seedSlug, 'brasov');
  const unseeded = index.search('paris', 3);
  assert.ok(unseeded.length > 0);
  assert.ok(unseeded.every((result) => result.seed === false));
});

test('nearest returns the closest indexed city with a haversine distance', () => {
  const exact = index.nearest(45.64861, 25.60613);
  assert.ok(exact);
  assert.equal(exact.record.geonameId, 683844);
  assert.ok(exact.distanceKm < 0.01);

  const nearby = index.nearest(45.66, 25.62);
  assert.equal(nearby?.record.geonameId, 683844);
  assert.ok((nearby?.distanceKm ?? 0) > 0.5 && (nearby?.distanceKm ?? 0) < 3);

  const buenosAires = index.nearest(-34.6037, -58.3816);
  assert.ok(buenosAires?.record.geonameId, 'expected a city near Buenos Aires');
  assert.ok((buenosAires?.distanceKm ?? 0) < 30);
});

test('country names resolve to English display names', () => {
  assert.equal(index.countryName('RO'), 'Romania');
  assert.equal(index.countryName('US'), 'United States');
  assert.equal(index.countryName(''), '');
  assert.equal(typeof index.countryName('ZZ'), 'string');
  assert.equal(index.toResult(index.get(683844)!).countryName, 'Romania');
});

test('search results carry the full public shape', () => {
  const [result] = index.search('brasov', 1);
  assert.deepEqual(Object.keys(result).sort(), [
    'asciiName',
    'country',
    'countryName',
    'geonameId',
    'lat',
    'lon',
    'name',
    'population',
    'seed',
    'tz'
  ]);
});
