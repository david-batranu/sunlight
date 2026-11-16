/**
 * In-memory generation job queue.
 *
 * - Dedupes active jobs by model key.
 * - Runs at most `concurrency` jobs; FIFO otherwise.
 * - Reports monotonic progress and supports cancellation (via `AbortSignal`).
 * - Keeps terminal jobs for a TTL so the client can poll after completion.
 */

import { randomUUID } from 'node:crypto';
import type { ApiError, GenerationStep, JobProgress, JobState, JobStatus } from '../../shared/types.ts';
import { CityError, isAbortError } from './errors.ts';

export interface JobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  /** Reports progress; `percent` is clamped to be monotonic and below 100. */
  report(step: GenerationStep, percent: number, label: string, detail?: string): void;
}

export type JobRunner = (context: JobContext) => Promise<void>;

export interface JobQueueOptions {
  concurrency: number;
  /** How long finished jobs stay queryable (ms). */
  ttlMs?: number;
  /** Interval of the TTL sweeper (ms). */
  sweepIntervalMs?: number;
  now?: () => Date;
  onRunnerError?: (error: unknown, jobId: string) => void;
}

export interface EnqueueResult {
  jobId: string;
  deduped: boolean;
}

interface JobRecord {
  jobId: string;
  key: string;
  state: JobState;
  progress: JobProgress;
  startedAt: string;
  updatedAt: string;
  modelUrl?: string;
  error?: ApiError;
  controller: AbortController;
  runner: JobRunner;
  promise: Promise<void> | null;
  lastPercent: number;
  settledAt: number | null;
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['done', 'error', 'cancelled']);
const MAX_RETAINED_JOBS = 500;
const DEFAULT_TTL_MS = 15 * 60_000;

export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly activeByKey = new Map<string, string>();
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly onRunnerError: ((error: unknown, jobId: string) => void) | null;
  private readonly sweeper: NodeJS.Timeout;
  private running = 0;
  private shuttingDown = false;

  constructor(options: JobQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.onRunnerError = options.onRunnerError ?? null;
    this.sweeper = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.sweeper.unref?.();
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  enqueue(key: string, runner: JobRunner): EnqueueResult {
    const existing = this.activeByKey.get(key);
    if (existing) {
      const job = this.jobs.get(existing);
      if (job && !TERMINAL_STATES.has(job.state)) return { jobId: existing, deduped: true };
      this.activeByKey.delete(key);
    }
    const jobId = randomUUID();
    const timestamp = this.now().toISOString();
    const record: JobRecord = {
      jobId,
      key,
      state: 'queued',
      progress: { step: 'resolve', percent: 0, label: 'Queued for generation' },
      startedAt: timestamp,
      updatedAt: timestamp,
      controller: new AbortController(),
      runner,
      promise: null,
      lastPercent: 0,
      settledAt: null
    };
    this.jobs.set(jobId, record);
    this.activeByKey.set(key, jobId);
    this.queue.push(jobId);
    queueMicrotask(() => this.pump());
    return { jobId, deduped: false };
  }

  /** Job id of the active (queued/running) job for a model key, if any. */
  byKey(key: string): string | null {
    const jobId = this.activeByKey.get(key);
    if (!jobId) return null;
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATES.has(job.state)) {
      this.activeByKey.delete(key);
      return null;
    }
    return jobId;
  }

  get(jobId: string): JobStatus | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    const status: JobStatus = {
      jobId: record.jobId,
      key: record.key,
      state: record.state,
      progress: { ...record.progress },
      startedAt: record.startedAt,
      updatedAt: record.updatedAt
    };
    if (record.modelUrl) status.modelUrl = record.modelUrl;
    if (record.error) status.error = { ...record.error };
    return status;
  }

  cancel(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record || TERMINAL_STATES.has(record.state)) return false;
    const wasQueued = record.state === 'queued';
    record.state = 'cancelled';
    record.progress = { ...record.progress, label: 'Cancelled' };
    record.updatedAt = this.now().toISOString();
    record.settledAt = Date.now();
    if (this.activeByKey.get(record.key) === jobId) this.activeByKey.delete(record.key);
    if (wasQueued) {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) this.queue.splice(index, 1);
    }
    record.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const jobId of [...this.jobs.keys()]) this.cancel(jobId);
  }

  async shutdown(timeoutMs = 2000): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.sweeper);
    const pending: Array<Promise<void>> = [];
    for (const record of this.jobs.values()) {
      if (!TERMINAL_STATES.has(record.state)) this.cancel(record.jobId);
      if (record.promise) pending.push(record.promise);
    }
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled(pending), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pump(): void {
    if (this.shuttingDown) return;
    while (this.running < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;
      const record = this.jobs.get(jobId);
      if (!record || record.state !== 'queued') continue;
      this.start(record);
    }
  }

  private start(record: JobRecord): void {
    record.state = 'running';
    record.updatedAt = this.now().toISOString();
    this.running += 1;

    const report = (step: GenerationStep, percent: number, label: string, detail?: string): void => {
      if (TERMINAL_STATES.has(record.state)) return;
      const clamped = Math.max(record.lastPercent, Math.min(99, Math.max(0, Math.round(percent))));
      record.lastPercent = clamped;
      const progress: JobProgress = { step, percent: clamped, label };
      if (detail) progress.detail = detail;
      record.progress = progress;
      record.updatedAt = this.now().toISOString();
    };

    const context: JobContext = {
      jobId: record.jobId,
      signal: record.controller.signal,
      report
    };

    record.promise = (async (): Promise<void> => {
      try {
        await record.runner(context);
        this.finish(record, 'done');
      } catch (error) {
        if (record.state === 'cancelled' || isAbortError(error)) {
          if (record.state !== 'cancelled') {
            record.state = 'cancelled';
            record.progress = { ...record.progress, label: 'Cancelled' };
            record.updatedAt = this.now().toISOString();
            record.settledAt = Date.now();
          }
        } else {
          this.finishWithError(record, error);
        }
      } finally {
        this.running -= 1;
        if (this.activeByKey.get(record.key) === record.jobId) this.activeByKey.delete(record.key);
        this.pump();
      }
    })();
  }

  private finish(record: JobRecord, state: 'done'): void {
    if (record.state === 'cancelled') return;
    record.state = state;
    record.progress = { step: 'write', percent: 100, label: 'Model ready' };
    record.modelUrl = `/api/models/${record.key}`;
    record.updatedAt = this.now().toISOString();
    record.settledAt = Date.now();
  }

  private finishWithError(record: JobRecord, error: unknown): void {
    if (record.state === 'cancelled') return;
    record.state = 'error';
    const apiError: ApiError = isCityErrorLike(error)
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      : {
          code: 'MODEL_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        };
    record.error = apiError;
    record.progress = { ...record.progress, label: 'Generation failed' };
    record.updatedAt = this.now().toISOString();
    record.settledAt = Date.now();
    this.onRunnerError?.(error, record.jobId);
  }

  private sweep(): void {
    const nowMs = Date.now();
    const terminal: JobRecord[] = [];
    for (const record of this.jobs.values()) {
      if (!TERMINAL_STATES.has(record.state)) continue;
      terminal.push(record);
      if (record.settledAt !== null && nowMs - record.settledAt > this.ttlMs) {
        this.jobs.delete(record.jobId);
      }
    }
    if (this.jobs.size > MAX_RETAINED_JOBS) {
      terminal.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
      for (const record of terminal) {
        if (this.jobs.size <= MAX_RETAINED_JOBS) break;
        this.jobs.delete(record.jobId);
      }
    }
  }
}

function isCityErrorLike(value: unknown): value is CityError {
  return (
    value instanceof CityError ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { code?: unknown }).code === 'string' &&
      typeof (value as { message?: unknown }).message === 'string' &&
      typeof (value as { retryable?: unknown }).retryable === 'boolean')
  );
}
