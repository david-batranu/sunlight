/**
 * Process-wide token buckets for upstream OSM infrastructure.
 *
 * Public Overpass / OSM API instances are shared, donated infrastructure; the
 * application counts *generations*, not upstream requests, so a burst of tile
 * fan-out would otherwise be unbounded. The buckets below are singletons per
 * provider name so concurrent jobs share one budget.
 */

import { abortableSleep } from './http.ts';

export interface TokenBucketOptions {
  /** Sustained request rate per second. */
  ratePerSec: number;
  /** Maximum accumulated tokens (burst size). Defaults to 1. */
  burst?: number;
  /** Monotonic clock injection for tests. */
  now?: () => number;
  /** Sleep injection for tests (must support abort). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class TokenBucket {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private tokens: number;
  private lastRefillAt: number;
  private totalWaitMs = 0;

  constructor(options: TokenBucketOptions) {
    this.ratePerSec = Math.max(0.0001, options.ratePerSec);
    this.burst = Math.max(1, Math.floor(options.burst ?? 1));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => abortableSleep(ms, signal));
    this.tokens = this.burst;
    this.lastRefillAt = this.now();
  }

  /** Total time callers have spent waiting on this bucket (diagnostics/tests). */
  get waitedMs(): number {
    return this.totalWaitMs;
  }

  /**
   * Tries to reserve one token. Returns 0 when a token was immediately
   * available, otherwise the number of milliseconds after which one should be
   * earned (the caller sleeps and reserves again). Waiting does not mutate
   * bucket state, so concurrent callers serialise instead of draining future
   * tokens at once.
   */
  reserve(nowMs: number = this.now()): number {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillAt);
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.ratePerSec);
      this.lastRefillAt = nowMs;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    this.totalWaitMs += waitMs;
    return waitMs;
  }

  /**
   * Waits for a token, honouring caller cancellation. Bounded retry loop: a
   * heavily contested bucket can not stall a build forever.
   */
  async acquire(signal?: AbortSignal): Promise<number> {
    let waited = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const waitMs = this.reserve();
      if (waitMs === 0) return waited;
      waited += waitMs;
      await this.sleep(waitMs, signal);
    }
    return waited;
  }
}

const sharedBuckets = new Map<string, TokenBucket>();

/** Returns the process-wide bucket for a provider name, creating it on first use. */
export function sharedTokenBucket(
  name: string,
  ratePerSec: number,
  burst = 1,
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
): TokenBucket {
  const existing = sharedBuckets.get(name);
  if (existing) return existing;
  const bucket = new TokenBucket({ ratePerSec, burst, ...(sleep ? { sleep } : {}) });
  sharedBuckets.set(name, bucket);
  return bucket;
}

/** Test hook: forget every shared bucket. */
export function resetSharedTokenBuckets(): void {
  sharedBuckets.clear();
}
