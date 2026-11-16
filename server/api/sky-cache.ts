/**
 * Cached sky-day service. The heavy astronomy work lives in server/sky/day.ts;
 * this module adds the HTTP-facing cache and ETag material.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { SkyDay } from '../../shared/types.ts';
import { computeSkyDay, resolveTimezone, validateLocalDate } from '../sky/day.ts';
import { HttpError } from '../http/http-error.ts';

export interface CachedSkyDay {
  sky: SkyDay;
  etag: string;
  json: Buffer;
  gzip: Buffer;
  createdAt: number;
}

function cacheKey(lat: number, lon: number, date: string): string {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}|${date}`;
}

export class SkyDayCache {
  private readonly entries = new Map<string, CachedSkyDay>();
  private readonly maxEntries = 128;

  get(lat: number, lon: number, date: string): CachedSkyDay {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new HttpError(400, 'INVALID_COORDINATES', 'lat and lon must be finite numbers.');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new HttpError(400, 'INVALID_COORDINATES', 'lat must be within -90..90 and lon within -180..180.');
    }
    try {
      validateLocalDate(date);
    } catch (error) {
      throw new HttpError(400, 'INVALID_DATE', (error as Error).message);
    }

    const key = cacheKey(lat, lon, date);
    const existing = this.entries.get(key);
    if (existing) {
      // Refresh LRU position.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const tz = resolveTimezone(lat, lon);
    const sky = computeSkyDay(lat, lon, date);
    if (sky.tz !== tz) sky.tz = tz;
    const json = Buffer.from(JSON.stringify(sky));
    const etag = `W/"sky-${createHash('sha256').update(json).digest('hex').slice(0, 24)}"`;
    const gzip = gzipSync(json, { level: 6 });
    const entry: CachedSkyDay = { sky, etag, json, gzip, createdAt: Date.now() };
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
    return entry;
  }

  stats(): { entries: number } {
    return { entries: this.entries.size };
  }
}
