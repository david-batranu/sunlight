/**
 * Ultra-low-resolution OpenStreetMap context around the high-detail diorama.
 *
 * The surrounding 15 km × 15 km is a flat, unlit raster plane. It makes the
 * 3D view feel like a map when the camera is panned away from the current
 * tile and gives the user a target to click for loading a new high-detail
 * model. At zoom 13 the map is deliberately much coarser than the 3D city.
 *
 * Pure tile-planning math is exported for unit tests; DOM/image loading lives
 * in `loadContextMapTexture()`.
 */

export const CONTEXT_MAP_HALF_M = 7_500;
export const CONTEXT_MAP_SIZE_M = CONTEXT_MAP_HALF_M * 2;
export const CONTEXT_MAP_TILE_ZOOM = 13;
export const CONTEXT_MAP_CANVAS_PX = 768;
const TILE_SIZE = 256;
const EQUATOR_METRES_PER_PIXEL = 156_543.03392;

export interface ContextMapPoint {
  x: number;
  y: number;
}

export interface ContextMapPlan {
  zoom: number;
  canvasPx: number;
  /** Mercator pixel coordinates of the map centre. */
  center: ContextMapPoint;
  /** Width/height of the requested world in Mercator pixels at `zoom`. */
  spanPx: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  tiles: Array<{ x: number; y: number }>;
}

function mercatorPixel(lat: number, lon: number, zoom: number): ContextMapPoint {
  const size = TILE_SIZE * 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * size
  };
}

export function planContextMap(
  lat: number,
  lon: number,
  options: { zoom?: number; halfMetres?: number; canvasPx?: number } = {}
): ContextMapPlan {
  const zoom = Math.max(0, Math.min(19, Math.floor(options.zoom ?? CONTEXT_MAP_TILE_ZOOM)));
  const halfMetres = Math.max(1, options.halfMetres ?? CONTEXT_MAP_HALF_M);
  const canvasPx = Math.max(64, Math.floor(options.canvasPx ?? CONTEXT_MAP_CANVAS_PX));
  const metresPerPixel =
    (EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const spanPx = (halfMetres * 2) / Math.max(0.01, metresPerPixel);
  const center = mercatorPixel(lat, lon, zoom);
  const minTileX = Math.floor((center.x - spanPx / 2) / TILE_SIZE);
  const maxTileX = Math.floor((center.x + spanPx / 2) / TILE_SIZE);
  const minTileY = Math.floor((center.y - spanPx / 2) / TILE_SIZE);
  const maxTileY = Math.floor((center.y + spanPx / 2) / TILE_SIZE);
  const tiles: Array<{ x: number; y: number }> = [];
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) tiles.push({ x, y });
  }
  return { zoom, canvasPx, center, spanPx, minTileX, maxTileX, minTileY, maxTileY, tiles };
}

/** Where a tile's top-left corner lands in canvas pixels. */
export function tileCanvasPosition(
  plan: ContextMapPlan,
  tileX: number,
  tileY: number
): ContextMapPoint {
  const scale = plan.canvasPx / plan.spanPx;
  return {
    x: (tileX * TILE_SIZE - (plan.center.x - plan.spanPx / 2)) * scale,
    y: (tileY * TILE_SIZE - (plan.center.y - plan.spanPx / 2)) * scale
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('map tile failed'));
    image.src = url;
  });
}

/**
 * Loads the low-quality context map as a canvas texture source.
 *
 * Returns null (and lets the scene show its beige fallback) when tiles are
 * unavailable; the 3D city must remain usable offline.
 */
export async function loadContextMapTexture(
  city: { lat: number; lon: number }
): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined') return null;
  const plan = planContextMap(city.lat, city.lon);
  const canvas = document.createElement('canvas');
  canvas.width = plan.canvasPx;
  canvas.height = plan.canvasPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const maxTile = 2 ** plan.zoom;
  try {
    const images = await Promise.all(
      plan.tiles.map(async ({ x, y }) => {
        const wrappedX = ((x % maxTile) + maxTile) % maxTile;
        if (y < 0 || y >= maxTile) return null;
        const image = await loadImage(
          `https://tile.openstreetmap.org/${plan.zoom}/${wrappedX}/${y}.png`
        );
        return { x, y, image };
      })
    );
    const scale = plan.canvasPx / plan.spanPx;
    ctx.fillStyle = '#e7ddc9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const entry of images) {
      if (!entry) continue;
      const position = tileCanvasPosition(plan, entry.x, entry.y);
      ctx.drawImage(
        entry.image,
        position.x,
        position.y,
        TILE_SIZE * scale + 0.5,
        TILE_SIZE * scale + 0.5
      );
    }
    return canvas;
  } catch {
    return null;
  }
}
