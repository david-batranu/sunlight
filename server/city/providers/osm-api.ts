/**
 * Official OpenStreetMap API `/api/0.6/map` provider — tiled fallback source.
 *
 * The API caps responses at 50k nodes. When a tile is too large it is split
 * into four overlapping quarters (10% overlap, so features crossing seams are
 * complete in at least one tile) and fetched recursively. Requests are spaced
 * by at least ~350 ms (public infrastructure etiquette), retried on transient
 * errors, and merged by element id.
 */

import { CityError, isAbortError } from '../errors.ts';
import { bboxSize, bboxesForRadius, type BoundingBox } from '../geometry.ts';
import { parseOsmXml } from '../osm/xml.ts';
import type { RawOsmData } from '../raw.ts';
import { dedupeWarnings, mergeRawOsmData } from '../raw.ts';
import { hostOf, isRetryableStatus, requestText, abortableSleep, backoffMs, type FetchLike } from './http.ts';
import { sharedTokenBucket, type TokenBucket } from './bucket.ts';
import type { CityDataProvider, ProviderFetchRequest, ProviderStatus } from './types.ts';

const DEFAULT_BASE_URL = 'https://api.openstreetmap.org/api/0.6/map';
const DEFAULT_SPACING_MS = 350;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_TILES = 128;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MIN_TILE_DEG = 0.001;
const DEFAULT_MAX_BODY_BYTES = 96 * 1024 * 1024;

export interface OsmApiProviderOptions {
  baseUrl?: string;
  userAgent: string;
  spacingMs?: number;
  timeoutMs?: number;
  retries?: number;
  maxTiles?: number;
  maxDepth?: number;
  minTileSizeDeg?: number;
  maxBodyBytes?: number;
  /** Process-wide upstream budget (default 2 requests/second, burst 2). */
  ratePerSec?: number;
  bucket?: TokenBucket;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type TileResult = RawOsmData | 'too-large';

export function createOsmApiProvider(options: OsmApiProviderOptions): CityDataProvider {
  const baseUrl = options.baseUrl ?? process.env.OSM_API_URL ?? DEFAULT_BASE_URL;
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxTiles = options.maxTiles ?? DEFAULT_MAX_TILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const minTileSizeDeg = options.minTileSizeDeg ?? DEFAULT_MIN_TILE_DEG;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms));
  // The official OSM API is shared infrastructure: cap total tile throughput
  // process-wide on top of the per-tile spacing.
  const bucket =
    options.bucket ??
    sharedTokenBucket(
      'osm-api',
      options.ratePerSec ?? 2,
      2,
      options.sleep ? (ms) => options.sleep!(ms) : undefined
    );
  let lastOutcome: ProviderStatus = 'unknown';

  return {
    id: 'osm-api',
    source: 'osm-api',
    status(): ProviderStatus {
      return lastOutcome;
    },
    async fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData> {
      const boxes = bboxesForRadius(request.center.lat, request.center.lon, request.radiusM);
      const parts: RawOsmData[] = [];
      const warnings: string[] = [];
      let requests = 0;
      let completed = 0;
      let skipped = 0;
      let lastRequestAt = 0;

      const requestTile = async (box: BoundingBox): Promise<TileResult | 'budget'> => {
        if (requests >= maxTiles) return 'budget';
        if (requests > 0) {
          const wait = spacingMs - (now() - lastRequestAt);
          if (wait > 0) await sleep(wait);
        }
        await bucket.acquire(request.signal);
        lastRequestAt = now();
        requests += 1;
        const url = `${baseUrl}?bbox=${formatDeg(box.west)},${formatDeg(box.south)},${formatDeg(box.east)},${formatDeg(box.north)}`;
        request.onProgress?.(
          Math.min(50, 10 + completed * 3 + skipped),
          'Fetching OSM API tiles',
          `${hostOf(baseUrl)} · ${requests} request(s)`
        );

        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          if (request.signal.aborted) throw abortFromSignal();
          try {
            const response = await requestText({
              url,
              headers: { Accept: 'application/xml', 'User-Agent': options.userAgent },
              timeoutMs,
              signal: request.signal,
              fetchImpl,
              maxBodyBytes
            });
            if (!response.ok) {
              const tooLarge = isTooLargeResponse(response.status, response.text);
              if (tooLarge) return 'too-large';
              if (isRetryableStatus(response.status) && attempt < retries) {
                lastError = new CityError(
                  'PROVIDER_FAILED',
                  `OSM API returned HTTP ${response.status} for a tile.`,
                  502,
                  true
                );
                await sleep(response.retryAfterMs ?? backoffMs(attempt));
                continue;
              }
              throw new CityError(
                'PROVIDER_FAILED',
                `OSM API returned HTTP ${response.status}.`,
                502,
                isRetryableStatus(response.status),
                { status: response.status, body: response.text.slice(0, 300) }
              );
            }
            const data = parseOsmXml(response.text, { source: 'osm-api' });
            completed += 1;
            return data;
          } catch (error) {
            if (isAbortError(error)) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
            const retryable = !(error instanceof CityError) || error.retryable;
            if (attempt < retries && retryable) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }
        }
        throw lastError ?? new CityError('PROVIDER_FAILED', 'OSM API tile request failed.', 502, true);
      };

      const walk = async (box: BoundingBox, depth: number): Promise<void> => {
        const result = await requestTile(box);
        if (result === 'budget') {
          skipped += 1;
          warnings.push('OSM API tile budget reached; part of the area was not fetched');
          return;
        }
        if (result === 'too-large') {
          const { width, height } = bboxSize(box);
          if (depth < maxDepth && Math.max(width, height) > minTileSizeDeg * 2) {
            for (const child of quarterBoxes(box)) await walk(child, depth + 1);
          } else {
            skipped += 1;
            warnings.push('OSM API tile exceeded the node limit and could not be split further');
          }
          return;
        }
        parts.push(result);
      };

      try {
        for (const box of boxes) await walk(box, 0);
      } catch (error) {
        lastOutcome = 'down';
        if (isAbortError(error)) throw error;
        const cityError =
          error instanceof CityError
            ? error
            : new CityError('PROVIDER_FAILED', error instanceof Error ? error.message : String(error), 502, true);
        throw new CityError(
          'PROVIDER_FAILED',
          `OSM API fallback failed: ${cityError.message}`,
          502,
          true,
          { provider: 'osm-api', requests, completed, skipped }
        );
      }

      if (parts.length === 0) {
        lastOutcome = 'down';
        throw new CityError('PROVIDER_FAILED', 'The OSM API returned no usable tiles.', 502, true, {
          provider: 'osm-api',
          requests,
          skipped
        });
      }

      lastOutcome = 'up';
      request.onProgress?.(58, 'Merging OSM API tiles', `${completed} tile(s)`);
      const merged = mergeRawOsmData(parts, 'osm-api');
      merged.warnings = dedupeWarnings([...warnings, ...merged.warnings], 24);
      // Coverage is incomplete when the tile budget or splittable-depth limit
      // stopped us; the service marks the resulting model as degraded.
      if (skipped > 0) merged.partial = true;
      return merged;
    }
  };
}

function formatDeg(value: number): string {
  return value.toFixed(6);
}

function isTooLargeResponse(status: number, body: string): boolean {
  if (status === 413 || status === 509) return true;
  if (status !== 400) return false;
  return /too many nodes|maximum number of nodes|too large|too many elements/i.test(body);
}

/** Splits a bbox into four quarters with a 10% overlap around the seams. */
export function quarterBoxes(box: BoundingBox): BoundingBox[] {
  const { width, height } = bboxSize(box);
  const middleLon = box.west + width / 2;
  const middleLat = box.south + height / 2;
  const overlapLon = width * 0.1;
  const overlapLat = height * 0.1;
  return [
    { south: box.south, west: box.west, north: middleLat + overlapLat, east: middleLon + overlapLon },
    { south: box.south, west: middleLon - overlapLon, north: middleLat + overlapLat, east: box.east },
    { south: middleLat - overlapLat, west: box.west, north: box.north, east: middleLon + overlapLon },
    { south: middleLat - overlapLat, west: middleLon - overlapLon, north: box.north, east: box.east }
  ];
}

function abortFromSignal(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}
