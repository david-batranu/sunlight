/**
 * Elevation provider for the city diorama.
 *
 * Samples the public AWS “Terrain Tiles” (Terrarium PNGs, derived from
 * Mapzen/SRTM and friends) and resamples them into a compact model-space
 * heightfield. The wire model stores non-negative decimetres relative to the
 * lowest sample; the renderer applies the low-poly exaggeration.
 *
 * Network failure is never fatal: callers may keep a flat model and surface a
 * warning. Terrain tiles are cached in process memory for the bake duration.
 */

import type { TerrainRecord } from '../../shared/types.ts';
import {
  TERRAIN_EXAGGERATION,
  TERRAIN_GRID_SAMPLES,
  TERRAIN_MAX_REL_M,
  TERRAIN_TILE_ZOOM
} from '../../shared/constants.ts';
import { METRES_PER_DEG_LAT } from './geometry.ts';
import { decodePng } from './png.ts';

const TILE_ENDPOINT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;
const MAX_TERRAIN_TILE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const TILE_CACHE_LIMIT = 96;

interface Tile {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}

const tileCache = new Map<string, Tile>();

function tileKey(x: number, y: number): string {
  return `${TERRAIN_TILE_ZOOM}/${x}/${y}`;
}

function wrapTileX(x: number): number {
  const count = 2 ** TERRAIN_TILE_ZOOM;
  return ((x % count) + count) % count;
}

function clampTileY(y: number): number {
  const max = 2 ** TERRAIN_TILE_ZOOM - 1;
  return Math.max(0, Math.min(max, y));
}

/** Web-Mercator pixel coordinates at the terrain zoom. */
function mercatorPixel(lat: number, lon: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** TERRAIN_TILE_ZOOM;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * scale;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  return { x, y };
}

async function fetchTile(x: number, y: number, signal?: AbortSignal): Promise<Tile> {
  const key = tileKey(x, y);
  const cached = tileCache.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('terrain tile timeout')), FETCH_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(`${TILE_ENDPOINT}/${key}.png`, {
      signal: controller.signal,
      headers: { Accept: 'image/png' }
    });
    if (!response.ok) {
      throw new Error(`Terrain tile ${key} returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TERRAIN_TILE_BYTES) {
      throw new Error('terrain tile response is too large');
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_TERRAIN_TILE_BYTES) throw new Error('terrain tile response is too large');
    const bytes = body;
    const png = decodePng(bytes);
    if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) {
      throw new Error(`Terrain tile ${key} has unexpected dimensions ${png.width}×${png.height}`);
    }
    const tile: Tile = { width: png.width, height: png.height, channels: png.channels, pixels: png.pixels };
    if (tileCache.size >= TILE_CACHE_LIMIT) {
      const oldest = tileCache.keys().next().value;
      if (oldest !== undefined) tileCache.delete(oldest);
    }
    tileCache.set(key, tile);
    return tile;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Terrarium elevation in metres from a decoded tile pixel. */
function tileElevation(tile: Tile, px: number, py: number): number {
  const x = Math.max(0, Math.min(tile.width - 1, px));
  const y = Math.max(0, Math.min(tile.height - 1, py));
  const offset = (y * tile.width + x) * tile.channels;
  const r = tile.pixels[offset];
  const g = tile.pixels[offset + 1];
  const b = tile.pixels[offset + 2];
  return r * 256 + g + b / 256 - 32768;
}

export interface FetchTerrainOptions {
  centerLat: number;
  centerLon: number;
  radiusM: number;
  signal?: AbortSignal;
  samples?: number;
}

/**
 * Fetches and resamples elevation for the model square.
 * Throws when the network/tiles are unavailable; callers decide whether to
 * continue with a flat model.
 */
export async function fetchTerrain(options: FetchTerrainOptions): Promise<TerrainRecord> {
  const { centerLat, centerLon, radiusM, signal } = options;
  const samples = Math.max(2, Math.round(options.samples ?? TERRAIN_GRID_SAMPLES));
  const stepM = (radiusM * 2) / (samples - 1);
  const metresPerDegLon = METRES_PER_DEG_LAT * Math.max(0.0001, Math.cos((centerLat * Math.PI) / 180));

  const points: Array<{ lat: number; lon: number; px: number; py: number; tx: number; ty: number }> = [];
  const tiles = new Set<string>();
  for (let row = 0; row < samples; row += 1) {
    const northOffset = radiusM - row * stepM; // row 0 = north edge
    const lat = centerLat + northOffset / METRES_PER_DEG_LAT;
    for (let col = 0; col < samples; col += 1) {
      const lon = centerLon + (-radiusM + col * stepM) / metresPerDegLon;
      const pixel = mercatorPixel(lat, lon);
      const tx = Math.floor(pixel.x / TILE_SIZE);
      const ty = Math.floor(pixel.y / TILE_SIZE);
      tiles.add(`${wrapTileX(tx)}/${clampTileY(ty)}`);
      points.push({
        lat,
        lon,
        px: pixel.x - tx * TILE_SIZE,
        py: pixel.y - ty * TILE_SIZE,
        tx: wrapTileX(tx),
        ty: clampTileY(ty)
      });
    }
  }

  const loaded = new Map<string, Tile>();
  const tileList = [...tiles];
  const concurrency = 4;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tileList.length) }, async () => {
    while (cursor < tileList.length) {
      const entry = tileList[cursor];
      cursor += 1;
      const [x, y] = entry.split('/').map(Number);
      loaded.set(entry, await fetchTile(x, y, signal));
    }
  });
  await Promise.all(workers);

  const elevations = new Float64Array(points.length);
  let minElevation = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const tile = loaded.get(`${point.tx}/${point.ty}`);
    if (!tile) throw new Error('Terrain tile was not loaded');
    const elevation = tileElevation(tile, Math.floor(point.px), Math.floor(point.py));
    elevations[i] = elevation;
    if (elevation < minElevation) minElevation = elevation;
  }
  if (!Number.isFinite(minElevation)) throw new Error('Terrain sampling returned no elevations');

  const baseM = Math.round(minElevation);
  const heights: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const relativeM = Math.max(0, Math.min(TERRAIN_MAX_REL_M, (elevations[i] - baseM) * TERRAIN_EXAGGERATION));
    heights[i] = Math.round(relativeM * 10);
  }

  return {
    x0: -Math.round(radiusM * 10),
    z0: -Math.round(radiusM * 10),
    step: Math.round((radiusM * 2 * 10) / (samples - 1)),
    cols: samples,
    rows: samples,
    h: heights,
    baseM,
    source: 'AWS Terrain Tiles'
  };
}
