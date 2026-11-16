/**
 * Message protocol between the city service (main thread) and
 * `server/city/worker.ts` (generation worker).
 */

import type { ModelMeta, ModelStats } from '../../shared/types.ts';
import type { BuildInput } from './build.ts';
import type { RawOsmData } from './raw.ts';

export interface WorkerBuildRequest {
  type: 'build';
  raw: RawOsmData;
  input: BuildInput;
}

export type WorkerRequest = WorkerBuildRequest;

export interface WorkerProgressMessage {
  type: 'progress';
  /** Local build progress 0..100 (the service maps it onto the job scale). */
  percent: number;
  label: string;
  detail?: string;
}

export interface WorkerDoneMessage {
  type: 'done';
  /** Gzipped model JSON (transferred as a plain Uint8Array). */
  gzipped: Uint8Array;
  /** Strong ETag of `gzipped`. */
  etag: string;
  bytes: number;
  meta: ModelMeta;
  stats: ModelStats;
  elapsedMs: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
}

export type WorkerResponse = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;
