/**
 * Fixed-window per-IP rate limiter for expensive endpoints.
 * A limit of 0 disables limiting.
 */

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(limitPerMinute: number, windowMs = 60_000) {
    this.limit = Math.max(0, Math.floor(limitPerMinute));
    this.windowMs = windowMs;
  }

  /** Returns remaining allowance, or null when the request should be rejected. */
  take(key: string, now = Date.now()): { remaining: number; retryAfterSec: number } | null {
    if (this.limit === 0) return { remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 };
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 5000) this.prune(now);
      return { remaining: this.limit - 1, retryAfterSec: 0 };
    }
    if (bucket.count >= this.limit) {
      return null;
    }
    bucket.count += 1;
    return { remaining: this.limit - bucket.count, retryAfterSec: 0 };
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
