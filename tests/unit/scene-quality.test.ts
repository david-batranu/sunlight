/**
 * Unit tests for the quality-tier policy (pure module, no DOM/Three).
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTIVE_SAMPLE_FRAMES,
  QUALITY,
  SLOW_FRAME_INTERVAL_MS,
  degradeQualityForFrameTime,
  qualityForEnvironment
} from '../../src/scene/quality.ts';

test('quality tiers encode the documented renderer knobs', () => {
  assert.equal(QUALITY.high.dprCap, 2);
  assert.equal(QUALITY.high.shadowMapSize, 2048);
  assert.equal(QUALITY.high.showTrees, true);
  // Low tier: 1.25 DPR cap, 1024² shadows, no tree canopy mesh.
  assert.equal(QUALITY.low.dprCap, 1.25);
  assert.equal(QUALITY.low.shadowMapSize, 1024);
  assert.equal(QUALITY.low.showTrees, false);
  assert.ok(QUALITY.low.dprCap < QUALITY.high.dprCap);
  assert.ok(QUALITY.low.shadowMapSize < QUALITY.high.shadowMapSize);
});

test('coarse pointers and small screens start at the low tier', () => {
  assert.equal(
    qualityForEnvironment({ coarsePointer: true, viewportWidth: 1440, viewportHeight: 900 }),
    'low'
  );
  assert.equal(
    qualityForEnvironment({ coarsePointer: false, viewportWidth: 390, viewportHeight: 844 }),
    'low'
  );
  assert.equal(
    qualityForEnvironment({ coarsePointer: false, viewportWidth: 480, viewportHeight: 320 }),
    'low'
  );
  // A normal desktop window stays high; a narrow desktop window is not a phone.
  assert.equal(
    qualityForEnvironment({ coarsePointer: false, viewportWidth: 1440, viewportHeight: 900 }),
    'high'
  );
  assert.equal(
    qualityForEnvironment({ coarsePointer: false, viewportWidth: 1024, viewportHeight: 768 }),
    'high'
  );
});

test('qualityForEnvironment tolerates missing/zero viewport metrics', () => {
  assert.equal(
    qualityForEnvironment({ coarsePointer: false, viewportWidth: 0, viewportHeight: 0 }),
    'high'
  );
  assert.equal(
    qualityForEnvironment({
      coarsePointer: false,
      viewportWidth: Number.NaN,
      viewportHeight: Number.NaN
    }),
    'high'
  );
});

test('adaptive policy only steps high→low after a sustained slow run', () => {
  // Not enough samples yet: never degrade, however slow the frames.
  assert.equal(degradeQualityForFrameTime('high', 120, ADAPTIVE_SAMPLE_FRAMES - 1), null);
  // Sustained fast frames: stay high.
  assert.equal(degradeQualityForFrameTime('high', 16.7, ADAPTIVE_SAMPLE_FRAMES), null);
  assert.equal(
    degradeQualityForFrameTime('high', SLOW_FRAME_INTERVAL_MS, ADAPTIVE_SAMPLE_FRAMES),
    null,
    'exactly at the threshold is not slow enough'
  );
  // Sustained slow frames: one-way step to low.
  assert.equal(
    degradeQualityForFrameTime('high', SLOW_FRAME_INTERVAL_MS + 1, ADAPTIVE_SAMPLE_FRAMES),
    'low'
  );
  // Low never degrades further (and never auto-upgrades here).
  assert.equal(degradeQualityForFrameTime('low', 120, 1000), null);
  // Non-finite statistics are ignored.
  assert.equal(degradeQualityForFrameTime('high', Number.NaN, 1000), null);
});
