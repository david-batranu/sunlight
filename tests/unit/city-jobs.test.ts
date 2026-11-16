/**
 * Job queue tests: dedupe, FIFO/concurrency, monotonic progress, cancellation,
 * error mapping, TTL cleanup and shutdown.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CityError } from '../../server/city/errors.ts';
import { JobQueue } from '../../server/city/job-queue.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await delay(5);
  }
}

function controlledGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('dedupes active jobs by model key', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const gate = controlledGate();
    const first = queue.enqueue('gn-1-r900-v1', async () => {
      await gate.promise;
    });
    const second = queue.enqueue('gn-1-r900-v1', async () => undefined);
    assert.equal(second.deduped, true);
    assert.equal(second.jobId, first.jobId);
    assert.equal(queue.byKey('gn-1-r900-v1'), first.jobId);
    const other = queue.enqueue('gn-2-r900-v1', async () => undefined);
    assert.equal(other.deduped, false);
    assert.notEqual(other.jobId, first.jobId);
    gate.release();
    await waitFor(() => queue.get(first.jobId)?.state === 'done');
    await waitFor(() => queue.get(other.jobId)?.state === 'done');
    assert.equal(queue.byKey('gn-1-r900-v1'), null);
    assert.equal(queue.active, 0);
    assert.equal(queue.queued, 0);
  } finally {
    await queue.shutdown();
  }
});

test('runs jobs FIFO with the configured concurrency', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const started: string[] = [];
    const gate = controlledGate();
    queue.enqueue('gn-1-r900-v1', async () => {
      started.push('one');
      await gate.promise;
    });
    queue.enqueue('gn-2-r900-v1', async () => {
      started.push('two');
    });
    await waitFor(() => started.length === 1);
    assert.deepEqual(started, ['one']);
    assert.equal(queue.active, 1);
    assert.equal(queue.queued, 1);
    gate.release();
    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ['one', 'two']);
    assert.equal(queue.active, 0);
    assert.equal(queue.queued, 0);
  } finally {
    await queue.shutdown();
  }
});

test('enforces monotonic progress and finishes at 100%', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const seen: number[] = [];
    let released: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { jobId } = queue.enqueue('gn-1-r900-v1', async (context) => {
      for (const percent of [10, 50, 30, 150]) {
        context.report('fetch', percent, `step ${percent}`);
        seen.push(queue.get(context.jobId)?.progress.percent ?? -1);
      }
      await gate;
    });
    await waitFor(() => seen.length === 4);
    assert.deepEqual(seen, [10, 50, 50, 99]);
    released();
    await waitFor(() => queue.get(jobId)?.state === 'done');
    const status = queue.get(jobId);
    assert.ok(status);
    assert.equal(status.state, 'done');
    assert.equal(status.progress.percent, 100);
    assert.equal(status.progress.step, 'write');
    assert.equal(status.modelUrl, `/api/models/gn-1-r900-v1`);
    assert.equal(typeof status.startedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(status.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(status.updatedAt)));
  } finally {
    await queue.shutdown();
  }
});

test('cancelling a queued job frees its key without starting it', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const gate = controlledGate();
    const running = queue.enqueue('gn-1-r900-v1', async () => {
      await gate.promise;
    });
    const startedSecond: string[] = [];
    const queued = queue.enqueue('gn-2-r900-v1', async () => {
      startedSecond.push('two');
    });
    await waitFor(() => queue.active === 1);
    assert.equal(queue.cancel(queued.jobId), true);
    const status = queue.get(queued.jobId);
    assert.equal(status?.state, 'cancelled');
    assert.equal(queue.byKey('gn-2-r900-v1'), null);
    assert.equal(queue.queued, 0);
    assert.equal(queue.cancel(queued.jobId), false);
    gate.release();
    await waitFor(() => queue.get(running.jobId)?.state === 'done');
    await delay(20);
    assert.deepEqual(startedSecond, []);
    assert.equal(queue.cancel('unknown-job'), false);
    assert.equal(queue.get('unknown-job'), null);
  } finally {
    await queue.shutdown();
  }
});

test('cancelling a running job aborts its signal and marks it cancelled', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    let observedAbort = false;
    const { jobId } = queue.enqueue('gn-1-r900-v1', async (context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    });
    await waitFor(() => queue.active === 1);
    assert.equal(queue.cancel(jobId), true);
    await waitFor(() => queue.get(jobId)?.state === 'cancelled');
    await waitFor(() => queue.active === 0);
    assert.equal(observedAbort, true);
    assert.equal(queue.active, 0);
  } finally {
    await queue.shutdown();
  }
});

test('maps CityError failures onto structured job errors', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const { jobId } = queue.enqueue('gn-1-r900-v1', async () => {
      throw new CityError('NO_DATA', 'Nothing here.', 422, false, { radiusM: 900 });
    });
    await waitFor(() => queue.get(jobId)?.state === 'error');
    const status = queue.get(jobId);
    assert.ok(status);
    assert.equal(status.state, 'error');
    assert.equal(status.error?.code, 'NO_DATA');
    assert.equal(status.error?.message, 'Nothing here.');
    assert.equal(status.error?.retryable, false);
    assert.deepEqual(status.error?.details, { radiusM: 900 });
    assert.equal(status.progress.label, 'Generation failed');
  } finally {
    await queue.shutdown();
  }
});

test('maps unexpected failures to a retryable MODEL_FAILED error', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  try {
    const { jobId } = queue.enqueue('gn-1-r900-v1', async () => {
      throw new Error('boom');
    });
    await waitFor(() => queue.get(jobId)?.state === 'error');
    const status = queue.get(jobId);
    assert.equal(status?.error?.code, 'MODEL_FAILED');
    assert.equal(status?.error?.retryable, true);
    assert.equal(status?.error?.message, 'boom');
  } finally {
    await queue.shutdown();
  }
});

test('sweeps finished jobs after their TTL', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 10, ttlMs: 10 });
  try {
    const { jobId } = queue.enqueue('gn-1-r900-v1', async () => undefined);
    await waitFor(() => queue.get(jobId)?.state === 'done');
    await waitFor(() => queue.get(jobId) === null, 2000);
  } finally {
    await queue.shutdown();
  }
});

test('shutdown cancels outstanding jobs and resolves', async () => {
  const queue = new JobQueue({ concurrency: 1, sweepIntervalMs: 60_000 });
  const gate = controlledGate();
  const running = queue.enqueue('gn-1-r900-v1', async (context) => {
    await Promise.race([
      gate.promise,
      new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      })
    ]);
  });
  const queued = queue.enqueue('gn-2-r900-v1', async () => undefined);
  await waitFor(() => queue.active === 1);
  await queue.shutdown();
  assert.equal(queue.get(running.jobId)?.state, 'cancelled');
  assert.equal(queue.get(queued.jobId)?.state, 'cancelled');
  gate.release();
});
