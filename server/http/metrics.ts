/**
 * Small in-process HTTP metrics ring used by `/api/health`.
 *
 * Counters are intentionally cheap and bounded: no per-request allocation,
 * no logging unless `SUNLIGHT_LOG_LEVEL=info|debug`. The p95 is computed from a
 * 256-sample ring so operators get a rough latency signal without a metrics
 * service.
 */

const SAMPLE_CAPACITY = 256;

export interface HttpMetricsSnapshot {
  requests: number;
  errors: number;
  rateLimited: number;
  p95Ms: number;
}

export class HttpMetrics {
  private requests = 0;
  private errors = 0;
  private rateLimited = 0;
  private readonly samples = new Float64Array(SAMPLE_CAPACITY);
  private sampleCount = 0;
  private sampleCursor = 0;

  record(status: number, durationMs: number): void {
    this.requests += 1;
    if (status >= 500) this.errors += 1;
    if (status === 429) this.rateLimited += 1;
    this.samples[this.sampleCursor] = durationMs;
    this.sampleCursor = (this.sampleCursor + 1) % SAMPLE_CAPACITY;
    if (this.sampleCount < SAMPLE_CAPACITY) this.sampleCount += 1;
  }

  snapshot(): HttpMetricsSnapshot {
    if (this.sampleCount === 0) {
      return { requests: this.requests, errors: this.errors, rateLimited: this.rateLimited, p95Ms: 0 };
    }
    const sorted = Array.from(this.samples.subarray(0, this.sampleCount)).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      requests: this.requests,
      errors: this.errors,
      rateLimited: this.rateLimited,
      p95Ms: Math.round((sorted[index] ?? 0) * 10) / 10
    };
  }
}
