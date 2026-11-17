/**
 * Detail-window math: radius/centre clamping and user-facing labels.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampDetailWindow,
  detailFootprintLabel,
  detailRadiusLabel
} from '../../src/app/detail.ts';
import {
  DETAIL_DEFAULT_RADIUS_M,
  DETAIL_MAX_RADIUS_M,
  DETAIL_MIN_RADIUS_M
} from '../../shared/constants.ts';

const frame = { centerX: 10, centerZ: -20, radiusM: 1500 };

test('detail windows clamp to the loaded model and size range', () => {
  const centred = clampDetailWindow(frame, null);
  assert.equal(centred.centerX, 10);
  assert.equal(centred.centerZ, -20);
  assert.equal(centred.radiusM, DETAIL_DEFAULT_RADIUS_M);

  const tiny = clampDetailWindow(frame, { centerX: 0, centerZ: 0, radiusM: 1 });
  assert.equal(tiny.radiusM, DETAIL_MIN_RADIUS_M);
  const huge = clampDetailWindow(frame, { centerX: 0, centerZ: 0, radiusM: 99_999 });
  assert.equal(huge.radiusM, DETAIL_MAX_RADIUS_M);

  // A 300 m window may move far from the centre, a 1500 m window cannot.
  const small = clampDetailWindow(frame, { centerX: 10_000, centerZ: -10_000, radiusM: 300 });
  assert.equal(small.centerX, 10 + (1500 - 300));
  assert.equal(small.centerZ, -20 - (1500 - 300));
  const full = clampDetailWindow(frame, { centerX: 10_000, centerZ: 10_000, radiusM: 1500 });
  assert.equal(full.centerX, 10);
  assert.equal(full.centerZ, -20);

  const tinyFrame = clampDetailWindow({ centerX: 0, centerZ: 0, radiusM: 600 }, { radiusM: 1500 });
  assert.equal(tinyFrame.radiusM, 600);
});

test('detail labels are compact and readable', () => {
  assert.equal(detailRadiusLabel(300), '300 m radius');
  assert.equal(detailRadiusLabel(1500), '1500 m radius');
  assert.equal(detailFootprintLabel(300), '600 × 600 m');
  assert.equal(detailFootprintLabel(750), '1.5 × 1.5 km');
  assert.equal(detailFootprintLabel(1500), '3 × 3 km');
});
