import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dayOfYear,
  formatAltitude,
  formatAzimuth,
  countryName,
  formatCompass,
  formatCoords,
  formatCount,
  formatIllumination,
  formatPopulation,
  formatShadowMultiplier,
  formatSpeed,
  instantToLocalMinute,
  moodLabel,
  moonPhaseGeometry,
  phaseNameForAngle,
  sourceLabel
} from '../../src/ui/format.ts';

test('compass abbreviations use the 16-wind rose', () => {
  assert.equal(formatCompass(0), 'N');
  assert.equal(formatCompass(22.5), 'NNE');
  assert.equal(formatCompass(45), 'NE');
  assert.equal(formatCompass(90), 'E');
  assert.equal(formatCompass(135), 'SE');
  assert.equal(formatCompass(180), 'S');
  assert.equal(formatCompass(225), 'SW');
  assert.equal(formatCompass(270), 'W');
  assert.equal(formatCompass(315), 'NW');
  assert.equal(formatCompass(350), 'N');
  assert.equal(formatCompass(-90), 'W');
  assert.equal(formatCompass(450), 'E');
  assert.equal(formatCompass(Number.NaN), 'N');
});

test('counts and populations are grouped with metric suffixes', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(4812), '4,812');
  assert.equal(formatCount(20000), '20,000');
  assert.equal(formatCount(-1234), '-1,234');
  assert.equal(formatPopulation(0), '—');
  assert.equal(formatPopulation(null), '—');
  assert.equal(formatPopulation(8450), '8,450');
  assert.equal(formatPopulation(12_000), '12 k');
  assert.equal(formatPopulation(315_400), '315 k');
  assert.equal(formatPopulation(1_234_567), '1.2 M');
  assert.equal(formatPopulation(2_000_000), '2 M');
});

test('altitude, azimuth and shadow readouts are UI-ready', () => {
  assert.equal(formatAltitude(12.44), '+12.4°');
  assert.equal(formatAltitude(-3.26), '-3.3°');
  assert.equal(formatAltitude(0), '0.0°');
  assert.equal(formatAzimuth(127.4), '127° SE');
  assert.equal(formatAzimuth(359.6), '0° N');
  assert.equal(formatShadowMultiplier(45), '1.0 × height');
  assert.equal(formatShadowMultiplier(10), '5.7 × height');
  assert.equal(formatShadowMultiplier(0), '—');
  assert.equal(formatShadowMultiplier(-4), '—');
  assert.equal(formatShadowMultiplier(0.52), '>99 × height');
});

test('moon phase names and geometry', () => {
  assert.equal(phaseNameForAngle(0), 'New moon');
  assert.equal(phaseNameForAngle(40), 'Waxing crescent');
  assert.equal(phaseNameForAngle(90), 'First quarter');
  assert.equal(phaseNameForAngle(140), 'Waxing gibbous');
  assert.equal(phaseNameForAngle(180), 'Full moon');
  assert.equal(phaseNameForAngle(220), 'Waning gibbous');
  assert.equal(phaseNameForAngle(270), 'Last quarter');
  assert.equal(phaseNameForAngle(320), 'Waning crescent');

  const newMoon = moonPhaseGeometry(0, 10, 0, 0);
  assert.equal(newMoon.path, null);
  assert.equal(newMoon.illumination, 0);
  assert.equal(newMoon.waxing, true);

  const fullMoon = moonPhaseGeometry(180, 10, 0, 0);
  assert.ok(fullMoon.path && fullMoon.path.startsWith('M '));
  assert.ok(fullMoon.path.includes(' A '));
  assert.equal(fullMoon.illumination, 1);

  const firstQuarter = moonPhaseGeometry(90, 10, 0, 0);
  assert.ok(Math.abs(firstQuarter.illumination - 0.5) < 1e-9);
  assert.equal(firstQuarter.waxing, true);
  assert.ok(firstQuarter.path && firstQuarter.path.startsWith('M '));

  const lastQuarter = moonPhaseGeometry(270, 10, 0, 0);
  assert.equal(lastQuarter.waxing, false);
  assert.ok(lastQuarter.path);

  assert.equal(formatIllumination(0.826), '83%');
  assert.equal(formatIllumination(Number.NaN), '—');
});

test('ISO instants convert to local wall-clock minutes', () => {
  assert.equal(instantToLocalMinute('2026-06-21T03:30:00.000Z', 'Europe/Bucharest'), 6 * 60 + 30);
  assert.equal(instantToLocalMinute('2026-01-15T10:30:00.000Z', 'Europe/Bucharest'), 12 * 60 + 30);
  assert.equal(instantToLocalMinute('2026-06-21T12:00:00.000Z', 'UTC'), 12 * 60);
  assert.equal(instantToLocalMinute(null, 'UTC'), null);
  assert.equal(instantToLocalMinute('not-a-date', 'UTC'), null);
  assert.equal(instantToLocalMinute('2026-06-21T03:30:00.000Z', 'Not/AZone'), null);
});

test('country codes resolve to English display names', () => {
  assert.equal(countryName('RO'), 'Romania');
  assert.equal(countryName('de'), 'Germany');
  assert.equal(countryName('US'), 'United States');
  assert.equal(countryName(''), '');
  assert.equal(countryName(null), '');
  assert.equal(countryName('ZZ'), 'ZZ');
});

test('coordinates, day of year, speed labels and source labels', () => {
  assert.equal(formatCoords(45.64861, 25.60613), '45.6486° N, 25.6061° E');
  assert.equal(formatCoords(-33.8688, -151.2093), '33.8688° S, 151.2093° W');
  assert.equal(dayOfYear('2026-01-01'), 1);
  assert.equal(dayOfYear('2026-06-21'), 172);
  assert.equal(dayOfYear('2024-12-31'), 366);
  assert.equal(formatSpeed(5), '5 min/s');
  assert.equal(formatSpeed(1.5), '1.5 min/s');
  assert.equal(sourceLabel('seed'), 'Pre-baked seed');
  assert.equal(sourceLabel('overpass'), 'OpenStreetMap · live');
  assert.equal(moodLabel('golden'), 'Golden hour');
  assert.equal(moodLabel('night'), 'Night');
});
