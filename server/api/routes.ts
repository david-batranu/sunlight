/**
 * API routes.
 *
 * The city service owns OSM fetching/parsing/geometry/caching/jobs; this layer
 * validates input, applies per-client rate limits and turns service errors into
 * HTTP.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config.ts';
import type { CreateModelResponse, HealthResponse, JobStatus, ModelTarget } from '../../shared/types.ts';
import { isValidModelKey } from '../city/keys.ts';
import { CityError, type CityService } from '../city/service.ts';
import { readJsonBody, requireObject } from '../http/body.ts';
import { clientRateKey } from '../http/client-ip.ts';
import { HttpError } from '../http/http-error.ts';
import { FixedWindowRateLimiter } from '../http/rate-limit.ts';
import { sendCachedJson, sendError, sendJson } from '../http/respond.ts';
import { buildHealthResponse, healthHttpStatus } from './health.ts';
import { SkyDayCache } from './sky-cache.ts';
import type { HttpMetrics } from '../http/metrics.ts';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const GET_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Cache profile for fully valid models (content-addressed, immutable bytes). */
const MODEL_CACHE_IMMUTABLE = 'private, max-age=31536000, immutable';
/**
 * Degraded models are usable but incomplete (terrain/coverage failure). They
 * must be refreshable: a permanent immutable cache would pin a temporary blip
 * for a year.
 */
const MODEL_CACHE_DEGRADED = 'private, max-age=300';

export interface ApiDependencies {
  config: AppConfig;
  cityService: CityService;
  skyCache: SkyDayCache;
  httpMetrics?: HttpMetrics;
}

export interface ApiHandler {
  (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

function modelUrl(key: string): string {
  return `/api/models/${encodeURIComponent(key)}`;
}

function parseCoordinate(value: string | null, name: string, min: number, max: number): number {
  if (value === null || value.trim() === '') {
    throw new HttpError(400, 'INVALID_COORDINATES', `Missing ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'INVALID_COORDINATES', `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseLimit(value: string | null): number {
  if (value === null) return 8;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new HttpError(400, 'INVALID_LIMIT', 'limit must be an integer between 1 and 20.');
  }
  return parsed;
}

function parseTarget(value: unknown): ModelTarget {
  const body = requireObject(value);
  const target = requireObject(body.target, 'INVALID_TARGET');
  if (target.kind === 'city') {
    const id = target.geonameId;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 10_000_000_000) {
      throw new HttpError(400, 'INVALID_TARGET', 'geonameId must be a positive integer.');
    }
    return { kind: 'city', geonameId: id };
  }
  if (target.kind === 'point') {
    const lat = target.lat;
    const lon = target.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new HttpError(400, 'INVALID_TARGET', 'Point targets require finite lat and lon.');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new HttpError(400, 'INVALID_TARGET', 'lat must be within -90..90 and lon within -180..180.');
    }
    let name: string | undefined;
    if (typeof target.name === 'string') {
      const cleaned = target.name.trim().slice(0, 80);
      if (cleaned) name = cleaned;
    }
    return { kind: 'point', lat, lon, ...(name ? { name } : {}) };
  }
  throw new HttpError(400, 'INVALID_TARGET', 'target.kind must be "city" or "point".');
}

function targetName(target: ModelTarget): string {
  return target.kind === 'city' ? `city ${target.geonameId}` : target.name || 'your location';
}

function isGetOrHead(method: string): boolean {
  return GET_METHODS.has(method);
}

function methodNotAllowed(allowed: string): HttpError {
  return new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed}.`, { headers: { Allow: allowed } });
}

function retryAfterHeaders(retryAfterSec: number | undefined): Record<string, string> | undefined {
  if (retryAfterSec === undefined) return undefined;
  return { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) };
}

function handleApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof CityError) {
    // Retry-After only makes sense for unavailability responses (queue caps,
    // negative cache); deterministic 4xx errors must not invite retries.
    const retryAfter = error.status === 503 ? error.retryAfterSec ?? 5 : undefined;
    sendError(res, error.status, error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
      headers: retryAfterHeaders(retryAfter)
    });
    return;
  }
  if (error instanceof HttpError) {
    const retryAfterSec = error.retryAfterSec ?? (error.status === 429 ? 60 : undefined);
    sendError(res, error.status, error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
      headers: { ...(retryAfterHeaders(retryAfterSec) ?? {}), ...(error.headers ?? {}) }
    });
    return;
  }
  console.error('[sunlight] api error', error);
  sendError(res, 500, 'INTERNAL', 'Internal server error.', { retryable: true });
}

export function createApiHandler(deps: ApiDependencies): ApiHandler {
  const { config, cityService, skyCache } = deps;
  // Generation is expensive; reads are cheap but hot; sky is CPU-heavy and
  // trivially cache-bustable. Health/readiness is always exempt.
  const generationLimiter = new FixedWindowRateLimiter(config.rateLimitPerMin);
  const readLimiter = new FixedWindowRateLimiter(config.readRateLimitPerMin);
  const skyLimiter = new FixedWindowRateLimiter(config.skyRateLimitPerMin);

  const clientKey = (req: IncomingMessage): string =>
    clientRateKey(req, {
      trustProxy: config.trustProxy,
      ...(config.trustedProxyCidrs.length > 0 ? { trustedProxyCidrs: config.trustedProxyCidrs } : {})
    });

  const enforce = (limiter: FixedWindowRateLimiter, req: IncomingMessage, message: string): void => {
    const result = limiter.take(clientKey(req));
    if (result.allowed) return;
    throw new HttpError(429, 'RATE_LIMITED', message, {
      retryable: true,
      retryAfterSec: result.retryAfterSec
    });
  };

  return async function handleApi(req, res, url): Promise<boolean> {
    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      if (path === '/api/health' || path === '/api/ready') {
        if (!isGetOrHead(method)) throw methodNotAllowed('GET, HEAD');
        const health: HealthResponse = buildHealthResponse(
          config,
          cityService.health(),
          skyCache.stats(),
          deps.httpMetrics?.snapshot()
        );
        // `/api/health` reports degraded deployments truthfully but stays 200
        // so container orchestration does not restart a serving instance;
        // `/api/ready` is the strict 200/503 probe.
        if (path === '/api/ready') {
          sendJson(res, healthHttpStatus(health), health);
        } else {
          sendJson(res, 200, health);
        }
        return true;
      }

      if (path === '/api/cities') {
        if (!isGetOrHead(method)) throw methodNotAllowed('GET, HEAD');
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 1 || q.length > 80) {
          throw new HttpError(400, 'INVALID_QUERY', 'q must be between 1 and 80 characters.');
        }
        const limit = parseLimit(url.searchParams.get('limit'));
        enforce(readLimiter, req, 'Too many city searches. Try again in a minute.');
        const result = cityService.search(q, limit);
        sendJson(res, 200, result);
        return true;
      }

      if (path === '/api/cities/nearest') {
        if (!isGetOrHead(method)) throw methodNotAllowed('GET, HEAD');
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat', -90, 90);
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon', -180, 180);
        enforce(readLimiter, req, 'Too many city lookups. Try again in a minute.');
        const nearest = cityService.nearest(lat, lon);
        if (!nearest) {
          throw new HttpError(404, 'CITY_NOT_FOUND', 'No nearby city found.');
        }
        sendJson(res, 200, nearest);
        return true;
      }

      if (path === '/api/models' && method === 'POST') {
        // Validate first: rejected payloads must not consume generation quota.
        const body = await readJsonBody(req);
        const target = parseTarget(body);
        enforce(generationLimiter, req, 'Too many city generation requests. Try again in a minute.');
        const resolved = cityService.resolve(target);
        const result = await cityService.ensureModel(target, {
          clientId: clientKey(req),
          resolved
        });
        if (result.state === 'ready') {
          const response: CreateModelResponse = {
            state: 'ready',
            key: result.resolved.key,
            modelUrl: modelUrl(result.resolved.key)
          };
          sendJson(res, 200, response);
        } else {
          const response: CreateModelResponse = {
            state: 'queued',
            key: result.resolved.key,
            jobId: result.jobId,
            statusUrl: `/api/jobs/${encodeURIComponent(result.jobId)}`
          };
          res.setHeader('Retry-After', '1');
          sendJson(res, 202, response);
        }
        console.log(
          `[sunlight] model ${result.state} key=${result.resolved.key} target=${targetName(target)}`
        );
        return true;
      }

      if (path === '/api/models') {
        throw methodNotAllowed('POST');
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        if (!JOB_ID_RE.test(jobId)) {
          throw new HttpError(400, 'INVALID_JOB_ID', 'Invalid job id.');
        }
        if (method === 'GET' || method === 'HEAD') {
          const job = cityService.getJob(jobId);
          if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Unknown generation job.');
          const status: JobStatus = { ...job };
          if (status.state === 'done') status.modelUrl = modelUrl(status.key);
          sendJson(res, 200, status);
          return true;
        }
        if (method === 'DELETE') {
          const cancelled = cityService.cancelJob(jobId);
          if (!cancelled) throw new HttpError(404, 'JOB_NOT_FOUND', 'Unknown or already finished job.');
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
        throw methodNotAllowed('GET, HEAD, DELETE');
      }

      const modelMatch = /^\/api\/models\/([^/]+)$/.exec(path);
      if (modelMatch) {
        if (!isGetOrHead(method)) throw methodNotAllowed('GET, HEAD');
        const key = decodeURIComponent(modelMatch[1]);
        // Strict key grammar: an unparseable key is a client error (400), not a
        // "not generated yet" 404 that invites retries.
        if (!isValidModelKey(key)) {
          throw new HttpError(400, 'INVALID_MODEL_KEY', 'Invalid model key.');
        }
        const model = await cityService.readModel(key);
        if (!model) {
          throw new HttpError(404, 'MODEL_NOT_READY', 'This city model is not ready yet.', { retryable: true });
        }
        // Models are stored pre-compressed; always serve the gzip payload.
        const degraded = model.meta.degraded === true;
        const modelHeaders: Record<string, string> = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          ETag: model.etag,
          'Cache-Control': degraded ? MODEL_CACHE_DEGRADED : MODEL_CACHE_IMMUTABLE,
          Vary: 'Accept-Encoding',
          'Content-Length': String(model.gzipped.length)
        };
        if (degraded) modelHeaders['X-Model-Degraded'] = '1';
        if (String(req.headers['if-none-match'] || '') === model.etag) {
          res.writeHead(304, modelHeaders);
          res.end();
          return true;
        }
        res.writeHead(200, modelHeaders);
        if (method === 'HEAD') {
          res.end();
          return true;
        }
        res.end(model.gzipped);
        return true;
      }

      if (path === '/api/sky') {
        if (!isGetOrHead(method)) throw methodNotAllowed('GET, HEAD');
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat', -90, 90);
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon', -180, 180);
        const date = (url.searchParams.get('date') || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new HttpError(400, 'INVALID_DATE', 'date must be YYYY-MM-DD.');
        }
        enforce(skyLimiter, req, 'Too many sky requests. Try again in a minute.');
        const entry = skyCache.get(lat, lon, date);
        sendCachedJson(
          res,
          { json: entry.json, gzip: entry.gzip, etag: entry.etag },
          'public, max-age=3600'
        );
        return true;
      }

      if (path.startsWith('/api/')) {
        throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
      }

      return false;
    } catch (error) {
      handleApiError(res, error);
      return true;
    }
  };
}

export { CityError };

/** Exported for tests that assert the exact cache profiles. */
export { MODEL_CACHE_DEGRADED, MODEL_CACHE_IMMUTABLE };
