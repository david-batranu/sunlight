/**
 * Small abort-aware HTTP helpers shared by the network providers.
 */

import { CityError, isAbortError } from '../errors.ts';

export type FetchLike = typeof fetch;

export interface TextRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Caller cancellation (job cancellation / shutdown). */
  signal: AbortSignal;
  fetchImpl: FetchLike;
  /** Hard cap on the response body size. */
  maxBodyBytes: number;
}

export interface TextResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** Abortable sleep; rejects with an `AbortError` when cancelled. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortLike('Operation aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortLike('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortLike(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Performs an HTTP request with a timeout and caller cancellation, returning
 * the body as text regardless of HTTP status.
 *
 * Throws `CityError` for network/timeout/size failures; abort errors propagate
 * as `AbortError` so the job queue can mark the job cancelled.
 */
export async function requestText(request: TextRequest): Promise<TextResponse> {
  if (request.signal.aborted) throw abortLike('Operation aborted');

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  request.signal.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  let response: Response;
  try {
    response = await request.fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (error) {
    if (isAbortError(error) && request.signal.aborted) throw abortLike('Operation aborted');
    if (timedOut) {
      throw new CityError('PROVIDER_TIMEOUT', `The request to ${hostOf(request.url)} timed out.`, 502, true);
    }
    throw new CityError(
      'PROVIDER_NETWORK',
      `Could not reach ${hostOf(request.url)}: ${error instanceof Error ? error.message : String(error)}`,
      502,
      true
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onCallerAbort);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error) && request.signal.aborted) throw abortLike('Operation aborted');
    throw new CityError('PROVIDER_NETWORK', 'The response body could not be read.', 502, true);
  }
  if (text.length > request.maxBodyBytes) {
    throw new CityError(
      'PROVIDER_TOO_LARGE',
      `The response from ${hostOf(request.url)} exceeded ${Math.round(request.maxBodyBytes / 1e6)} MB.`,
      502,
      false
    );
  }
  return { status: response.status, ok: response.ok, text };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True for HTTP statuses that are worth retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function backoffMs(attempt: number, base = 400, max = 4000): number {
  return Math.min(max, base * 2 ** attempt);
}
