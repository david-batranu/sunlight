/**
 * Fixed-window per-client rate limiter for expensive endpoints.
 *
 * A limit of 0 disables limiting. Rejections report the exact number of seconds
 * until the window resets so the HTTP layer can emit a correct `Retry-After`.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still allowed in the current window (0 when rejected). */
  remaining: number;
  /** Seconds until the window resets; always >= 1 when rejected. */
  retryAfterSec: number;
  /** Effective per-minute limit (0 = disabled). */
  limit: number;
}

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(limitPerMinute: number, windowMs = 60_000) {
    this.limit = Math.max(0, Math.floor(limitPerMinute));
    this.windowMs = windowMs;
  }

  get perMinute(): number {
    return this.limit;
  }

  take(key: string, now = Date.now()): RateLimitResult {
    if (this.limit === 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0, limit: 0 };
    }
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 5000) this.prune(now);
      return { allowed: true, remaining: this.limit - 1, retryAfterSec: 0, limit: this.limit };
    }
    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        limit: this.limit
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      retryAfterSec: 0,
      limit: this.limit
    };
  }

  /** Test hook: drop all buckets. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test/diagnostic hook: number of tracked client buckets. */
  get tracked(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    while (this.buckets.size > 5000) {
      const first = this.buckets.keys().next().value;
      if (!first) break;
      this.buckets.delete(first);
    }
  }
}

/** Shared numeric knobs keep the routes and the tests in sync. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
