/**
 * Unit tests for the rolling rendered-frame statistics used by getDebug().
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FrameStats,
  MAX_SAMPLE_INTERVAL_MS,
  medianFromSorted,
  percentileFromSorted
} from '../../src/scene/frame-stats.ts';

function close(actual: number, expected: number, tolerance = 1e-9, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (tol ${tolerance})`
  );
}

test('empty stats report zeroed snapshot', () => {
  const stats = new FrameStats();
  const snapshot = stats.snapshot(1000);
  assert.equal(snapshot.samples, 0);
  assert.equal(snapshot.framesRendered, 0);
  assert.equal(snapshot.medianMs, 0);
  assert.equal(snapshot.p95Ms, 0);
  assert.equal(snapshot.rendersPerSecond, 0);
});

test('median and p95 track the rolling rendered-interval window', () => {
  const stats = new FrameStats(8);
  // Frames at 10 ms intervals 1..8 (first interval is ignored: no previous frame).
  stats.push(0, 0);
  for (let i = 1; i <= 8; i += 1) stats.push(i * 10, i);
  const snapshot = stats.snapshot(90);
  assert.equal(snapshot.framesRendered, 9);
  assert.equal(snapshot.samples, 8);
  close(snapshot.medianMs, 4.5, 1e-9, 'median of 1..8');
  close(snapshot.p95Ms, 7.65, 1e-9, 'p95 of 1..8');
});

test('percentile helper interpolates and clamps like the snapshot path', () => {
  assert.equal(percentileFromSorted([], 50), 0);
  assert.equal(percentileFromSorted([42], 95), 42);
  const values = [1, 2, 3, 4, 5];
  close(medianFromSorted(values), 3);
  close(percentileFromSorted(values, 0), 1);
  close(percentileFromSorted(values, 100), 5);
  close(percentileFromSorted(values, -10), 1);
  close(percentileFromSorted(values, 200), 5);
});

test('ring buffer keeps only the newest capacity intervals', () => {
  const stats = new FrameStats(4);
  stats.push(0, 0);
  // Intervals 1..10; only the last four (7, 8, 9, 10) stay in the window.
  for (let i = 1; i <= 10; i += 1) stats.push(i * 10, i);
  const snapshot = stats.snapshot(120);
  assert.equal(snapshot.framesRendered, 11);
  assert.equal(snapshot.samples, 4);
  close(snapshot.medianMs, 8.5, 1e-9);
});

test('idle gaps do not pollute the active-render cadence', () => {
  const stats = new FrameStats();
  stats.push(0, 0);
  stats.push(16, 16);
  // A long idle pause: the interval is recorded as a rendered frame, but not
  // as a cadence sample (on-demand rendering may wait minutes between frames).
  stats.push(MAX_SAMPLE_INTERVAL_MS + 1, MAX_SAMPLE_INTERVAL_MS + 1);
  const snapshot = stats.snapshot(MAX_SAMPLE_INTERVAL_MS + 2);
  assert.equal(snapshot.framesRendered, 3);
  assert.equal(snapshot.samples, 1);
  close(snapshot.medianMs, 16, 1e-9);
});

test('ignored idle intervals do not leave stale samples in the ring', () => {
  const stats = new FrameStats(3);
  stats.push(0, 0); // first frame: no interval
  stats.push(100, 100); // sample 100 ms
  stats.push(5000, 4900); // idle gap: ignored as a cadence sample
  stats.push(5016, 16); // sample 16 ms
  const snapshot = stats.snapshot(5016);
  assert.equal(snapshot.framesRendered, 4);
  assert.equal(snapshot.samples, 2, 'only the two live intervals are sampled');
  close(snapshot.medianMs, 58, 1e-9, 'median of {16, 100}');
});

test('rendersPerSecond counts only rendered frames in the trailing second', () => {
  const stats = new FrameStats();
  stats.push(0, 0);
  for (let t = 100; t <= 900; t += 100) stats.push(t, 100);
  // Frames at 0,100,...,900 → all inside the trailing 1000 ms at now=1000.
  assert.equal(stats.snapshot(1000).rendersPerSecond, 10);
  // Two seconds later with no new renders: idle.
  assert.equal(stats.snapshot(3000).rendersPerSecond, 0);
  // A rendered frame at now=3000 counts again.
  stats.push(3000, 2000);
  assert.equal(stats.snapshot(3000).rendersPerSecond, 1);
});
