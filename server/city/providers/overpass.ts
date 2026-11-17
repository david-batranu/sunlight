/**
 * Overpass API provider (primary OSM source).
 *
 * - One filtered query per fetch using inline geometry (`out tags geom`), so no
 *   node-recursion round trip is needed.
 * - Multiple endpoints with rotation, retries with backoff, and a per-endpoint
 *   circuit breaker after repeated failures.
 * - Identifying User-Agent, per-request timeout, response size cap and caller
 *   cancellation support.
 */

import { CityError, isAbortError } from '../errors.ts';
import { bboxesForRadius } from '../geometry.ts';
import { parseOverpassJson } from '../osm/json.ts';
import type { RawOsmData } from '../raw.ts';
import { hostOf, isRetryableStatus, requestText, abortableSleep, backoffMs, type FetchLike } from './http.ts';
import { sharedTokenBucket, type TokenBucket } from './bucket.ts';
import type { CityDataProvider, ProviderFetchRequest, ProviderStatus } from './types.ts';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BODY_BYTES = 96 * 1024 * 1024;
const DEFAULT_FAILURES_BEFORE_DOWN = 3;
const DEFAULT_DOWN_COOLDOWN_MS = 60_000;

export interface OverpassProviderOptions {
  endpoints: string[];
  userAgent: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  failuresBeforeDown?: number;
  downCooldownMs?: number;
  retryBackoffMs?: number;
  /** Process-wide upstream budget (default 1 request/second, burst 1). */
  ratePerSec?: number;
  bucket?: TokenBucket;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface EndpointState {
  failures: number;
  downUntil: number;
  lastError: string | null;
}

export function createOverpassProvider(options: OverpassProviderOptions): CityDataProvider {
  const endpoints = options.endpoints.filter((endpoint) => typeof endpoint === 'string' && endpoint.trim() !== '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const failuresBeforeDown = options.failuresBeforeDown ?? DEFAULT_FAILURES_BEFORE_DOWN;
  const downCooldownMs = options.downCooldownMs ?? DEFAULT_DOWN_COOLDOWN_MS;
  const retryBackoffMs = options.retryBackoffMs ?? 400;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms));
  // Public Overpass instances are donated infrastructure: keep a process-wide
  // budget across all concurrent generation jobs.
  const bucket =
    options.bucket ??
    sharedTokenBucket(
      'overpass',
      options.ratePerSec ?? 1,
      1,
      options.sleep ? (ms) => options.sleep!(ms) : undefined
    );
  const state: EndpointState[] = endpoints.map(() => ({ failures: 0, downUntil: 0, lastError: null }));
  let lastOutcome: ProviderStatus = 'unknown';
  let cursor = 0;

  const markFailure = (index: number, message: string): void => {
    const endpointState = state[index];
    endpointState.failures += 1;
    endpointState.lastError = message;
    if (endpointState.failures >= failuresBeforeDown) {
      endpointState.downUntil = now() + downCooldownMs;
      endpointState.failures = 0;
    }
  };
  const markSuccess = (index: number): void => {
    const endpointState = state[index];
    endpointState.failures = 0;
    endpointState.downUntil = 0;
    endpointState.lastError = null;
  };

  return {
    id: 'overpass',
    source: 'overpass',
    status(): ProviderStatus {
      return lastOutcome;
    },
    async fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData> {
      if (endpoints.length === 0) {
        throw new CityError('PROVIDER_UNAVAILABLE', 'No Overpass endpoints are configured.', 503, false);
      }
      const query = buildOverpassQuery(request);
      const maxAttempts = Math.max(2, endpoints.length * 2);
      const attemptErrors: Array<{ endpoint: string; error: string }> = [];
      let lastError: CityError | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (request.signal.aborted) throw abortFromSignal(request.signal);
        const index = (cursor + attempt) % endpoints.length;
        const endpoint = endpoints[index];
        const endpointState = state[index];
        const nowMs = now();
        if (endpointState.downUntil > nowMs) {
          attemptErrors.push({ endpoint: hostOf(endpoint), error: 'circuit breaker open' });
          continue;
        }

        request.onProgress?.(Math.min(40, 8 + attempt * 6), 'Fetching OpenStreetMap data', `Overpass · ${hostOf(endpoint)}`);
        try {
          await bucket.acquire(request.signal);
          const response = await requestText({
            url: endpoint,
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
              'User-Agent': options.userAgent
            },
            body: new URLSearchParams({ data: query }).toString(),
            timeoutMs,
            signal: request.signal,
            fetchImpl,
            maxBodyBytes
          });

          if (!response.ok) {
            const retryable = isRetryableStatus(response.status);
            lastError = new CityError(
              'PROVIDER_FAILED',
              `Overpass endpoint ${hostOf(endpoint)} returned HTTP ${response.status}.`,
              retryable ? 502 : 502,
              retryable,
              { provider: 'overpass', endpoint: hostOf(endpoint), status: response.status, body: response.text.slice(0, 300) }
            );
            markFailure(index, `${response.status}`);
            attemptErrors.push({ endpoint: hostOf(endpoint), error: `HTTP ${response.status}` });
            if (!retryable) break;
            // Never sleep after the final attempt: the loop is about to fail.
            if (attempt + 1 < maxAttempts) {
              await sleep(response.retryAfterMs ?? backoffMs(attempt, retryBackoffMs));
            }
            continue;
          }

          request.onProgress?.(45, 'Parsing OSM data', `Overpass · ${hostOf(endpoint)}`);
          const data = parseOverpassJson(response.text, { source: 'overpass' });
          markSuccess(index);
          cursor = index;
          lastOutcome = 'up';
          request.onProgress?.(60, 'OSM data ready', `${data.ways.length} ways · ${data.relations.length} relations`);
          return data;
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (error instanceof CityError && !error.retryable) {
            // A deterministic failure (e.g. malformed response) should not be
            // hammered against every endpoint, but trying one alternative
            // endpoint is still reasonable; break only after recording it.
            markFailure(index, error.message);
            lastError = error;
            attemptErrors.push({ endpoint: hostOf(endpoint), error: error.message });
            break;
          }
          const cityError =
            error instanceof CityError
              ? error
              : new CityError('PROVIDER_FAILED', error instanceof Error ? error.message : String(error), 502, true);
          lastError = cityError;
          markFailure(index, cityError.message);
          attemptErrors.push({ endpoint: hostOf(endpoint), error: cityError.message });
          request.onProgress?.(Math.min(45, 12 + attempt * 6), 'Overpass endpoint unavailable', cityError.message);
          if (attempt + 1 < maxAttempts) await sleep(backoffMs(attempt, retryBackoffMs));
        }
      }

      lastOutcome = 'down';
      const failure = lastError ?? new CityError('PROVIDER_FAILED', 'All Overpass endpoints failed.', 502, true);
      throw new CityError(
        failure.code === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_FAILED',
        `Overpass is unavailable: ${failure.message}`,
        failure.code === 'PROVIDER_UNAVAILABLE' ? 503 : 502,
        failure.retryable || failure.code === 'PROVIDER_UNAVAILABLE',
        { provider: 'overpass', attempts: attemptErrors.slice(-6) }
      );
    }
  };
}

function abortFromSignal(signal: AbortSignal): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  // Preserve an optional reason for logs without leaking internals.
  if (signal.reason instanceof Error && signal.reason.message) error.message = signal.reason.message;
  return error;
}


/**
 * Builds the Overpass QL query for the requested square.
 *
 * The tag filters intentionally match the builder's classification rules so the
 * download contains what the diorama can actually render.
 */
export function buildOverpassQuery(request: ProviderFetchRequest): string {
  const boxes = bboxesForRadius(request.center.lat, request.center.lon, request.radiusM);
  const timeoutSeconds = 25;
  const clauses: string[] = [];
  for (const box of boxes) {
    const bbox = `(${formatDeg(box.south)},${formatDeg(box.west)},${formatDeg(box.north)},${formatDeg(box.east)})`;
    clauses.push(
      `way["building"]${bbox};`,
      `relation["building"]${bbox};`,
      `way["highway"]${bbox};`,
      `way["railway"]${bbox};`,
      `way["natural"~"^(water|wood)$"]${bbox};`,
      `way["waterway"~"^(riverbank|dock)$"]${bbox};`,
      `way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|cemetery|orchard|reservoir|basin|flowerbed|railway)$"]${bbox};`,
      `way["leisure"~"^(park|garden|playground|pitch|common|golf_course|dog_park)$"]${bbox};`,
      `relation["natural"~"^(water|wood)$"]${bbox};`,
      `relation["waterway"="riverbank"]${bbox};`,
      `relation["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|cemetery|orchard|reservoir|basin)$"]${bbox};`,
      `relation["leisure"~"^(park|garden|playground|pitch|common|golf_course)$"]${bbox};`
    );
  }
  return `[out:json][timeout:${timeoutSeconds}];\n(\n  ${clauses.join('\n  ')}\n);\nout tags geom qt;`;
}

function formatDeg(value: number): string {
  return value.toFixed(6);
}
