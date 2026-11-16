import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HitFeature } from '../../src/app/contracts.ts';
import {
  formatHeightMeters,
  hoverKey,
  placeTooltip,
  tooltipContent
} from '../../src/ui/tooltip.ts';

const feature = (overrides: Partial<HitFeature> = {}): HitFeature => ({
  kind: 'building',
  name: 'St. Michael',
  kindLabel: 'Church',
  heightM: 42.4,
  ...overrides
});

test('building heights render in metres', () => {
  assert.equal(formatHeightMeters(42.4), '42 m tall');
  assert.equal(formatHeightMeters(42), '42 m tall');
  assert.equal(formatHeightMeters(0.4), '1 m tall');
  assert.equal(formatHeightMeters(1000), '1000 m tall');
  assert.equal(formatHeightMeters(null), null);
  assert.equal(formatHeightMeters(undefined), null);
  assert.equal(formatHeightMeters(Number.NaN), null);
});

test('tooltip content shows name, kind label and building height only', () => {
  assert.deepEqual(tooltipContent(feature()), {
    title: 'St. Michael',
    kind: 'Church',
    meta: '42 m tall'
  });
  assert.deepEqual(tooltipContent(feature({ name: '', kindLabel: '' })), {
    title: 'Unnamed building',
    kind: 'Building',
    meta: '42 m tall'
  });
  assert.deepEqual(tooltipContent(feature({ kind: 'road', name: 'Strada Lungă', kindLabel: 'Primary street', heightM: 5 })), {
    title: 'Strada Lungă',
    kind: 'Primary street',
    meta: null
  });
  assert.deepEqual(tooltipContent(feature({ kind: 'area', name: 'Parcul Central', kindLabel: 'Park' })), {
    title: 'Parcul Central',
    kind: 'Park',
    meta: null
  });
  assert.equal(tooltipContent(feature({ kind: 'area', name: ' ', kindLabel: '' })).title, 'Unnamed area');
});

test('hover keys only change with content or stickiness', () => {
  const a = hoverKey({ feature: feature(), x: 10, y: 20, sticky: false });
  const b = hoverKey({ feature: feature(), x: 400, y: 300, sticky: false });
  const sticky = hoverKey({ feature: feature(), x: 10, y: 20, sticky: true });
  assert.equal(a, b);
  assert.notEqual(a, sticky);
  assert.equal(hoverKey(null), '');
});

test('tooltip prefers above and flips below near the top edge', () => {
  const mid = placeTooltip(500, 400, 200, 80, 1000, 800);
  assert.equal(mid.placement, 'above');
  assert.equal(mid.top, 400 - 14 - 80);
  assert.equal(mid.left, 400);

  const nearTop = placeTooltip(500, 20, 200, 80, 1000, 800);
  assert.equal(nearTop.placement, 'below');
  assert.equal(nearTop.top, 34);
});

test('tooltip clamps horizontally and vertically into the viewport', () => {
  assert.equal(placeTooltip(50, 400, 200, 80, 1000, 800).left, 8);
  assert.equal(placeTooltip(980, 400, 200, 80, 1000, 800).left, 792);

  const tooTall = placeTooltip(500, 100, 200, 900, 1000, 800);
  assert.equal(tooTall.top, 8);

  const tiny = placeTooltip(10, 10, 100, 40, 120, 80);
  assert.equal(tiny.left, 8);
  assert.ok(tiny.top >= 8);
  assert.ok(tiny.left + 100 <= 120 - 8 + 1);
});

test('placement returns whole pixels', () => {
  const placed = placeTooltip(333.7, 222.2, 150.6, 61.4, 1000, 800);
  assert.equal(Number.isInteger(placed.left), true);
  assert.equal(Number.isInteger(placed.top), true);
});
