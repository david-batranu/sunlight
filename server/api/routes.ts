/**
 * API routes. The lead owns this file.
 *
 * The city service owns OSM fetching/parsing/geometry/caching/jobs; this layer
 * validates input, applies rate limits and turns service errors into HTTP.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config.ts';
import type {
  CreateModelResponse,
  HealthResponse,
  JobStatus,
  ModelTarget
} from '../../shared/types.ts';
import { CityError, type CityService } from '../city/service.ts';
import { readJsonBody, requireObject } from '../http/body.ts';
import { HttpError } from '../http/http-error.ts';
import { FixedWindowRateLimiter } from '../http/rate-limit.ts';
import { sendCachedJson, sendError, sendJson } from '../http/respond.ts';
import { SkyDayCache } from './sky-cache.ts';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODEL_KEY_RE = /^[a-z0-9-]{1,96}$/;

export interface ApiDependencies {
  config: AppConfig;
  cityService: CityService;
  skyCache: SkyDayCache;
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

function handleApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof CityError) {
    sendError(res, error.status, error.code, error.message, {
      retryable: error.retryable,
      details: error.details
    });
    return;
  }
  if (error instanceof HttpError) {
    sendError(res, error.status, error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
      headers: error.status === 429 ? { 'Retry-After': '60' } : undefined
    });
    return;
  }
  console.error('[sunlight] api error', error);
  sendError(res, 500, 'INTERNAL', 'Internal server error.', { retryable: true });
}

export function createApiHandler(deps: ApiDependencies): ApiHandler {
  const { config, cityService, skyCache } = deps;
  const limiter = new FixedWindowRateLimiter(config.rateLimitPerMin);

  return async function handleApi(req, res, url): Promise<boolean> {
    const path = url.pathname;
    const method = req.method || 'GET';
    const ip = req.socket.remoteAddress || 'unknown';

    try {
      if (path === '/api/health') {
        if (method !== 'GET') return false;
        const cityHealth = cityService.health();
        const health: HealthResponse = {
          ok: true,
          version: '0.1.0',
          modelVersion: config.modelVersion,
          uptimeSec: Math.round(process.uptime()),
          cache: cityHealth.cache,
          queue: cityHealth.queue,
          providers: cityHealth.providers,
          seeds: cityHealth.seeds
        };
        sendJson(res, 200, { ...health, sky: skyCache.stats() });
        return true;
      }

      if (path === '/api/cities') {
        if (method !== 'GET') return false;
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 1 || q.length > 80) {
          throw new HttpError(400, 'INVALID_QUERY', 'q must be between 1 and 80 characters.');
        }
        const result = cityService.search(q, parseLimit(url.searchParams.get('limit')));
        sendJson(res, 200, result);
        return true;
      }

      if (path === '/api/cities/nearest') {
        if (method !== 'GET') return false;
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat', -90, 90);
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon', -180, 180);
        const nearest = cityService.nearest(lat, lon);
        if (!nearest) {
          throw new HttpError(404, 'CITY_NOT_FOUND', 'No nearby city found.');
        }
        sendJson(res, 200, nearest);
        return true;
      }

      if (path === '/api/models' && method === 'POST') {
        const budget = limiter.take(ip);
        if (!budget) {
          throw new HttpError(429, 'RATE_LIMITED', 'Too many city generation requests. Try again in a minute.', {
            retryable: true
          });
        }
        const body = await readJsonBody(req);
        const target = parseTarget(body);
        const resolved = cityService.resolve(target);
        const result = await cityService.ensureModel(target);
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

      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        if (!JOB_ID_RE.test(jobId)) {
          throw new HttpError(400, 'INVALID_JOB_ID', 'Invalid job id.');
        }
        if (method === 'GET') {
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
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or DELETE.');
      }

      const modelMatch = /^\/api\/models\/([^/]+)$/.exec(path);
      if (modelMatch) {
        if (method !== 'GET') return false;
        const key = decodeURIComponent(modelMatch[1]);
        if (!MODEL_KEY_RE.test(key)) {
          throw new HttpError(400, 'INVALID_MODEL_KEY', 'Invalid model key.');
        }
        const model = await cityService.readModel(key);
        if (!model) {
          throw new HttpError(404, 'MODEL_NOT_READY', 'This city model is not ready yet.', { retryable: true });
        }
        // Models are stored pre-compressed; always serve the gzip payload.
        const modelHeaders: Record<string, string> = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          ETag: model.etag,
          'Cache-Control': 'private, max-age=31536000, immutable',
          Vary: 'Accept-Encoding',
          'Content-Length': String(model.gzipped.length)
        };
        if (String(req.headers['if-none-match'] || '') === model.etag) {
          res.writeHead(304, modelHeaders);
          res.end();
          return true;
        }
        res.writeHead(200, modelHeaders);
        res.end(model.gzipped);
        return true;
      }

      if (path === '/api/sky') {
        if (method !== 'GET') return false;
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat', -90, 90);
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon', -180, 180);
        const date = (url.searchParams.get('date') || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new HttpError(400, 'INVALID_DATE', 'date must be YYYY-MM-DD.');
        }
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
