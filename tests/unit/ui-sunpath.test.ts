import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkyDay, SkyTrack } from '../../shared/types.ts';
import {
  BAND_COLORS,
  SUN_PATH_CONFIG,
  bandForAltitude,
  bandGradient,
  buildTrackPaths,
  dayMarkers,
  findHorizonCrossings,
  horizonMarkers,
  projectSkyPoint
} from '../../src/ui/sunpath.ts';

const track = (sun: Array<[number, number]>, moon: Array<[number, number]> = [], stepMinutes = 5): SkyTrack => ({
  stepMinutes,
  sun,
  moon: moon.length > 0 ? moon : sun
});

const skyDay = (overrides: Partial<SkyDay> = {}): SkyDay => ({
  v: 1,
  date: '2026-06-21',
  tz: 'Europe/Bucharest',
  lat: 45.64861,
  lon: 25.60613,
  utcOffsetMinutes: 180,
  dayStartUtc: '2026-06-20T21:00:00.000Z',
  dayEndUtc: '2026-06-21T21:00:00.000Z',
  track: track([
    [-18, 0],
    [-12, 30],
    [-6, 60],
    [-0.5, 90],
    [10, 120],
    [30, 150],
    [10, 210],
    [-0.5, 240],
    [-6, 270],
    [-12, 300],
    [-18, 330]
  ]),
  sun: {
    rise: null,
    set: null,
    civilDawn: null,
    civilDusk: null,
    solarNoon: null,
    maxAltitudeDeg: 30,
    goldenHourMorning: null,
    goldenHourEvening: null
  },
  moon: { rise: null, set: null, phaseAngleDeg: 180, illumination: 1, phaseName: 'Full moon' },
  polarDay: false,
  polarNight: false,
  ...overrides
});

test('zenith projection maps altitude and azimuth consistently', () => {
  const center = SUN_PATH_CONFIG.size / 2;
  const zenith = projectSkyPoint(90, 0);
  assert.equal(zenith.x, center);
  assert.equal(zenith.y, center);

  const northHorizon = projectSkyPoint(0, 0);
  assert.equal(northHorizon.x, center);
  assert.equal(northHorizon.y, center - SUN_PATH_CONFIG.horizonR);

  const eastHorizon = projectSkyPoint(0, 90);
  assert.equal(eastHorizon.x, center + SUN_PATH_CONFIG.horizonR);
  assert.equal(eastHorizon.y, center);

  const southHorizon = projectSkyPoint(0, 180);
  assert.equal(southHorizon.x, center);
  assert.equal(southHorizon.y, center + SUN_PATH_CONFIG.horizonR);

  const westHorizon = projectSkyPoint(0, 270);
  assert.equal(westHorizon.x, center - SUN_PATH_CONFIG.horizonR);
  assert.equal(westHorizon.y, center);

  const deepNight = projectSkyPoint(-18, 0);
  assert.equal(deepNight.y, center - SUN_PATH_CONFIG.maxR);

  const clamped = projectSkyPoint(120, 90);
  assert.equal(clamped.x, center);
  assert.equal(clamped.y, center);
});

test('track paths split above and below the horizon', () => {
  const paths = buildTrackPaths(track([[-10, 10], [-5, 20], [1, 30], [5, 40], [1, 50], [-4, 60]]));
  assert.ok(paths.above.startsWith('M '));
  assert.ok(paths.below.startsWith('M '));
  assert.equal(paths.above.includes(' L '), true);
  assert.ok(paths.moon.length > 0);
  assert.equal(buildTrackPaths(null).above, '');
});

test('horizon crossings interpolate azimuth and minute', () => {
  const crossings = findHorizonCrossings(
    track([[-5, 80], [-2, 85], [1, 90], [4, 100], [1, 110], [-2, 115]], [], 5)
  );
  assert.ok(crossings.rise);
  assert.ok(crossings.set);
  assert.ok(crossings.rise && crossings.rise.az > 85 && crossings.rise.az < 90);
  assert.ok(crossings.set && crossings.set.az > 110 && crossings.set.az < 115);
  assert.ok(crossings.rise && crossings.rise.minute > 5 && crossings.rise.minute < 10);

  const markers = horizonMarkers(track([[-5, 80], [5, 90]]));
  assert.ok(markers.rise);
  assert.equal(markers.set, null);
});

test('day markers prefer almanac instants and fall back to the track', () => {
  const fromTrack = dayMarkers(skyDay());
  assert.ok(fromTrack.rise !== null && fromTrack.set !== null);
  assert.ok(fromTrack.rise !== null && fromTrack.rise > 0 && fromTrack.rise < 1440);

  const fromAlmanac = dayMarkers(
    skyDay({
      sun: {
        ...skyDay().sun,
        rise: '2026-06-21T03:30:00.000Z',
        set: '2026-06-21T18:00:00.000Z'
      }
    })
  );
  assert.equal(fromAlmanac.rise, 390);
  assert.equal(fromAlmanac.set, 1260);
  assert.deepEqual(dayMarkers(null), { rise: null, set: null });
});

test('band classification and slider gradient', () => {
  assert.equal(bandForAltitude(20), 'day');
  assert.equal(bandForAltitude(3), 'golden');
  assert.equal(bandForAltitude(-4), 'twilight');
  assert.equal(bandForAltitude(-20), 'night');

  const fallback = bandGradient(null);
  assert.ok(fallback.startsWith('linear-gradient(90deg, '));
  assert.ok(fallback.includes(BAND_COLORS.night));
  assert.ok(fallback.includes(BAND_COLORS.day));
  assert.ok(fallback.includes('0.00%'));
  assert.ok(fallback.includes('100.00%'));

  const fromTrack = bandGradient(skyDay());
  assert.ok(fromTrack.startsWith('linear-gradient(90deg, '));
  const percentages = [...fromTrack.matchAll(/([\d.]+)%/g)].map((match) => Number.parseFloat(match[1]));
  assert.ok(percentages.length >= 4);
  for (let index = 1; index < percentages.length; index += 1) {
    assert.ok(percentages[index] >= percentages[index - 1], 'gradient stops are monotonic');
  }
});
