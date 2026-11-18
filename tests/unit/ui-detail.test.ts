/**
 * Detail-window math: radius/centre clamping and user-facing labels.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampDetailWindow,
  detailFootprintLabel,
  detailRadiusLabel,
  detailWindowInsideModel,
  detailWindowToGeo,
  geoToModelPoint
} from '../../src/app/detail.ts';
import {
  DETAIL_DEFAULT_RADIUS_M,
  DETAIL_MAX_RADIUS_M,
  DETAIL_MIN_RADIUS_M
} from '../../shared/constants.ts';

const frame = { centerX: 10, centerZ: -20, modelRadiusM: 1500, contextRadiusM: 5000 };

test('detail windows clamp to the loaded model and size range', () => {
  const centred = clampDetailWindow(frame, null);
  assert.equal(centred.centerX, 10);
  assert.equal(centred.centerZ, -20);
  assert.equal(centred.radiusM, DETAIL_DEFAULT_RADIUS_M);

  const tiny = clampDetailWindow(frame, { centerX: 0, centerZ: 0, radiusM: 1 });
  assert.equal(tiny.radiusM, DETAIL_MIN_RADIUS_M);
  const huge = clampDetailWindow(frame, { centerX: 0, centerZ: 0, radiusM: 99_999 });
  assert.equal(huge.radiusM, DETAIL_MAX_RADIUS_M);

  // A 300 m window can move anywhere in the 5 km overview, a 1500 m window
  // can move within the overview but may leave the loaded 3 km city.
  const small = clampDetailWindow(frame, { centerX: 10_000, centerZ: -10_000, radiusM: 300 });
  assert.equal(small.centerX, 10 + (5000 - 300));
  assert.equal(small.centerZ, -20 - (5000 - 300));
  const full = clampDetailWindow(frame, { centerX: 10_000, centerZ: 10_000, radiusM: 1500 });
  assert.equal(full.centerX, 10 + (5000 - 1500));
  assert.equal(full.centerZ, -20 + (5000 - 1500));

  const tinyFrame = clampDetailWindow(
    { centerX: 0, centerZ: 0, modelRadiusM: 600, contextRadiusM: 5000 },
    { radiusM: 1500 }
  );
  assert.equal(tinyFrame.radiusM, 600);
  assert.equal(detailWindowInsideModel({ centerX: 0, centerZ: 0, radiusM: 300 }, frame), true);
  assert.equal(detailWindowInsideModel({ centerX: 4600, centerZ: 0, radiusM: 300 }, frame), false);
});

test('detail centre converts back to WGS84 for loading an area', () => {
  const city = { lat: 45.64861, lon: 25.60613 };
  const geo = detailWindowToGeo(city, { centerX: 0, centerZ: 0 });
  assert.equal(geo.lat, city.lat);
  assert.equal(geo.lon, city.lon);
  const north = detailWindowToGeo(city, { centerX: 0, centerZ: -1113.2 });
  assert.ok(Math.abs(north.lat - (city.lat + 0.01)) < 1e-9);
  const east = detailWindowToGeo(city, { centerX: 1113.2, centerZ: 0 });
  assert.ok(east.lon > city.lon);
  const model = geoToModelPoint(city, north.lat, east.lon);
  assert.ok(Math.abs(model.x - 1113.2) < 1e-6);
  assert.ok(Math.abs(model.z + 1113.2) < 1e-6);
});

test('detail labels are compact and readable', () => {
  assert.equal(detailRadiusLabel(300), '300 m radius');
  assert.equal(detailRadiusLabel(1500), '1500 m radius');
  assert.equal(detailFootprintLabel(300), '600 × 600 m');
  assert.equal(detailFootprintLabel(750), '1.5 × 1.5 km');
  assert.equal(detailFootprintLabel(1500), '3 × 3 km');
});
