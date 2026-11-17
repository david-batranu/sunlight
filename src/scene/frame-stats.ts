/**
 * Rolling statistics for *rendered* frames (not rAF ticks).
 *
 * The old debug `fps` was an exponential moving average seeded from the first
 * frame, so it read ~23 fps for several seconds while the steady-state cadence
 * was 5.5 fps. This module keeps a fixed ring of the last N rendered-frame
 * intervals and reports the median/p95 without allocating per frame.
 *
 * Pure module (no DOM / Three.js) so it can be unit tested with plain numbers.
 * `scene.ts` owns the actual rAF loop and calls `push()` once per render.
 */

export const FRAME_STATS_CAPACITY = 120;

/**
 * Intervals longer than this are treated as "the scene was idle" rather than a
 * slow frame: on-demand rendering legitimately waits minutes between frames,
 * and those gaps must not drag the active-render rate down.
 */
export const MAX_SAMPLE_INTERVAL_MS = 1000;

export interface FrameStatsSnapshot {
  /** Number of interval samples currently in the rolling window. */
  samples: number;
  /** Lifetime rendered-frame count since the scene was created. */
  framesRendered: number;
  /** Median interval between rendered frames, in ms (0 with no samples). */
  medianMs: number;
  /** 95th-percentile interval between rendered frames, in ms. */
  p95Ms: number;
  /** Rendered frames in the trailing 1000 ms (0 while idle). */
  rendersPerSecond: number;
}

/** Percentile of an ascending-sorted slice (shared with the test suite). */
export function percentileFromSorted(sorted: ArrayLike<number>, percentile: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(100, percentile));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const fraction = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

export function medianFromSorted(sorted: ArrayLike<number>): number {
  return percentileFromSorted(sorted, 50);
}

export class FrameStats {
  private readonly intervals: Float64Array;
  private readonly renderTimes: Float64Array;
  private readonly scratch: Float64Array;
  private cursor = 0;
  private written = 0;
  private total = 0;

  constructor(capacity: number = FRAME_STATS_CAPACITY) {
    const size = Math.max(2, Math.floor(capacity));
    this.intervals = new Float64Array(size);
    this.renderTimes = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  get framesRendered(): number {
    return this.total;
  }

  /**
   * Records a rendered frame at `nowMs`, with the interval since the previous
   * rendered frame. Intervals outside (0, MAX_SAMPLE_INTERVAL_MS] are ignored
   * for cadence stats (idle gaps and clock quirks) but still count as a frame.
   */
  push(nowMs: number, intervalMs: number): void {
    this.total += 1;
    this.renderTimes[this.cursor] = nowMs;
    this.intervals[this.cursor] =
      Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= MAX_SAMPLE_INTERVAL_MS
        ? intervalMs
        : Number.NaN;
    this.written = Math.min(this.written + 1, this.intervals.length);
    this.cursor = (this.cursor + 1) % this.intervals.length;
  }

  /** Allocation-light snapshot; sorts a preallocated scratch buffer in place. */
  snapshot(nowMs: number): FrameStatsSnapshot {
    let sortedCount = 0;
    for (let i = 0; i < this.written; i += 1) {
      const value = this.intervals[i];
      if (Number.isFinite(value)) {
        this.scratch[sortedCount] = value;
        sortedCount += 1;
      }
    }
    // Insertion sort: N <= 120 and this runs only for debug snapshots.
    for (let i = 1; i < sortedCount; i += 1) {
      const value = this.scratch[i];
      let j = i - 1;
      while (j >= 0 && this.scratch[j] > value) {
        this.scratch[j + 1] = this.scratch[j];
        j -= 1;
      }
      this.scratch[j + 1] = value;
    }
    const window = this.scratch.subarray(0, sortedCount);
    const medianMs = sortedCount > 0 ? medianFromSorted(window) : 0;
    const p95Ms = sortedCount > 0 ? percentileFromSorted(window, 95) : 0;

    let rendersPerSecond = 0;
    const windowStart = nowMs - 1000;
    const scanCount = Math.min(this.total, this.renderTimes.length);
    for (let i = 0; i < scanCount; i += 1) {
      const timestamp = this.renderTimes[i];
      if (timestamp >= windowStart && timestamp <= nowMs) rendersPerSecond += 1;
    }
    return {
      samples: sortedCount,
      framesRendered: this.total,
      medianMs,
      p95Ms,
      rendersPerSecond
    };
  }
}
