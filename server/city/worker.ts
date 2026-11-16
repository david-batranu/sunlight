/**
 * Generation worker entry point.
 *
 * The service sends the already-parsed raw OSM data via `workerData`; this
 * thread runs the CPU-heavy geometry build, gzips the model and posts the bytes
 * back. Progress is forwarded while the build runs.
 *
 * This file is bundled separately by `scripts/build-server.mjs` and located by
 * the service from `import.meta.url` (supporting both `worker.js` in production
 * and `worker.ts` in development).
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { CityModel } from '../../shared/types.ts';
import { buildCityModel } from './build.ts';
import { CityError, isCityError } from './errors.ts';
import { gzipModel, modelEtag } from './model-io.ts';
import type { WorkerBuildRequest, WorkerResponse } from './worker-protocol.ts';

const port = parentPort;
if (!port) {
  throw new Error('server/city/worker.ts must be started as a worker thread.');
}

const request = workerData as WorkerBuildRequest;
if (!request || request.type !== 'build' || !request.raw || !request.input) {
  throw new Error('Generation worker started without a build request.');
}

const startedAt = Date.now();

function post(message: WorkerResponse): void {
  port?.postMessage(message);
}

void (async (): Promise<void> => {
  try {
    const model: CityModel = buildCityModel(request.raw, request.input, (event) => {
      const message: WorkerResponse = {
        type: 'progress',
        percent: event.percent,
        label: event.label
      };
      if (event.detail) message.detail = event.detail;
      post(message);
    });
    const gzipped = await gzipModel(model);
    post({
      type: 'done',
      gzipped,
      etag: modelEtag(gzipped),
      bytes: gzipped.length,
      meta: model.meta,
      stats: model.meta.stats,
      elapsedMs: Date.now() - startedAt
    });
  } catch (error) {
    const cityError: CityError = isCityError(error)
      ? error
      : new CityError(
          'MODEL_FAILED',
          `Model generation failed: ${error instanceof Error ? error.message : String(error)}`,
          502,
          true
        );
    post({
      type: 'error',
      code: cityError.code,
      message: cityError.message,
      status: cityError.status,
      retryable: cityError.retryable,
      ...(cityError.details !== undefined ? { details: cityError.details } : {})
    });
  } finally {
    port?.close();
  }
})();
