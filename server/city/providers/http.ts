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
  /** Parsed `Retry-After` (capped at 60 s), when the upstream sent one. */
  retryAfterMs?: number;
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

  // Bound the read before buffering: a hostile/broken upstream must not force
  // a 96 MB allocation (or worse) before the size check. Prefer Content-Length
  // when present, then enforce the same cap while streaming the body.
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > request.maxBodyBytes) {
    throw new CityError(
      'PROVIDER_TOO_LARGE',
      `The response from ${hostOf(request.url)} exceeded ${Math.round(request.maxBodyBytes / 1e6)} MB.`,
      502,
      false
    );
  }
  let text: string;
  try {
    const body = response.body;
    if (!body) {
      text = await response.text();
    } else {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > request.maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw new CityError(
            'PROVIDER_TOO_LARGE',
            `The response from ${hostOf(request.url)} exceeded ${Math.round(request.maxBodyBytes / 1e6)} MB.`,
            502,
            false
          );
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(merged);
    }
  } catch (error) {
    if (error instanceof CityError) throw error;
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
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  return {
    status: response.status,
    ok: response.ok,
    text,
    ...(retryAfterMs !== null ? { retryAfterMs } : {})
  };
}

export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date), capped at 60 s so
 * a misbehaving upstream can not stall a generation indefinitely.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
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
