/**
 * Thin browser client for the Sunlight API. The lead owns this file.
 */

import type {
  CityModel,
  CitySearchResponse,
  CreateModelResponse,
  HealthResponse,
  JobStatus,
  ModelTarget,
  NearestCityResponse,
  SkyDay
} from '../../shared/types.ts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, retryable = false, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface ApiClient {
  searchCities(query: string, limit?: number): Promise<CitySearchResponse>;
  nearestCity(lat: number, lon: number): Promise<NearestCityResponse>;
  createModel(target: ModelTarget): Promise<CreateModelResponse>;
  getJob(jobId: string): Promise<JobStatus>;
  cancelJob(jobId: string): Promise<void>;
  loadModel(key: string): Promise<CityModel>;
  loadSky(lat: number, lon: number, date: string): Promise<SkyDay>;
  health(): Promise<HealthResponse>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers || {}) }
    });
  } catch {
    throw new ApiRequestError('The city server is unreachable.', 0, 'NETWORK', true);
  }

  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    let message = response.statusText || 'Request failed';
    let retryable = response.status >= 500;
    let details: unknown;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } };
      if (body.error) {
        code = body.error.code || code;
        message = body.error.message || message;
        retryable = body.error.retryable ?? retryable;
        details = body.error.details;
      }
    } catch {
      /* not JSON */
    }
    throw new ApiRequestError(message, response.status, code, retryable, details);
  }

  return (await response.json()) as T;
}

export function createApi(baseUrl = ''): ApiClient {
  const base = baseUrl.replace(/\/$/, '');

  return {
    searchCities(query, limit = 8) {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      return request<CitySearchResponse>(`${base}/api/cities?${params}`);
    },
    nearestCity(lat, lon) {
      const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
      return request<NearestCityResponse>(`${base}/api/cities/nearest?${params}`);
    },
    createModel(target) {
      return request<CreateModelResponse>(`${base}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
    },
    getJob(jobId) {
      return request<JobStatus>(`${base}/api/jobs/${encodeURIComponent(jobId)}`);
    },
    async cancelJob(jobId) {
      const response = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new ApiRequestError('Could not cancel generation.', response.status, 'CANCEL_FAILED');
      }
    },
    loadModel(key) {
      return request<CityModel>(`${base}/api/models/${encodeURIComponent(key)}`);
    },
    loadSky(lat, lon, date) {
      const params = new URLSearchParams({ lat: String(lat), lon: String(lon), date });
      return request<SkyDay>(`${base}/api/sky?${params}`);
    },
    health() {
      return request<HealthResponse>(`${base}/api/health`);
    }
  };
}
