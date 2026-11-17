/**
 * Combined choose-area / detail-window minimap.
 *
 * The map covers a 5 km radius around the city. Inside that, the loaded
 * high-detail model (3 km across by default) and a draggable detail window are
 * shown. The wider context comes from a one-time OSM raster overview (the
 * loaded model is used as an offline fallback). Moving the window never
 * reloads the model; "Load area" recenters/generates a new model when the
 * selected area is outside the current one.
 */

import type { AppState } from '../app/state.ts';
import type { DetailWindow, UIContext } from '../app/contracts.ts';
import {
  detailFootprintLabel,
  detailRadiusLabel,
  detailWindowInsideModel
} from '../app/detail.ts';
import {
  DETAIL_CONTEXT_RADIUS_M,
  DETAIL_CONTEXT_TILE_ZOOM,
  DETAIL_MAX_RADIUS_M,
  DETAIL_MIN_RADIUS_M
} from '../../shared/constants.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

const MAP_PIXELS = 480;
const MAP_PAD = 14;
const TILE_SIZE = 256;
const TILE_METRES_PER_PIXEL = 156_543.03392; // at zoom 0, equator
const TILE_TIMEOUT_MS = 8000;

interface MapFrame {
  centerX: number;
  centerZ: number;
  modelRadiusM: number;
  contextRadiusM: number;
}

interface MapPoint {
  x: number;
  y: number;
  scale: number;
}

function mapFrame(state: AppState): MapFrame | null {
  const model = state.model;
  if (!model) return null;
  return {
    centerX: (model.bounds.minX + model.bounds.maxX) / 20,
    centerZ: (model.bounds.minZ + model.bounds.maxZ) / 20,
    modelRadiusM: Math.max(1, model.meta.radiusM),
    contextRadiusM: DETAIL_CONTEXT_RADIUS_M
  };
}

function projectToMap(frame: MapFrame, xM: number, zM: number): MapPoint {
  const scale = (MAP_PIXELS - MAP_PAD * 2) / (frame.contextRadiusM * 2);
  return {
    x: MAP_PAD + (xM - (frame.centerX - frame.contextRadiusM)) * scale,
    y: MAP_PAD + (zM - (frame.centerZ - frame.contextRadiusM)) * scale,
    scale
  };
}

function unprojectFromMap(frame: MapFrame, x: number, y: number): { x: number; z: number } {
  const scale = (MAP_PIXELS - MAP_PAD * 2) / (frame.contextRadiusM * 2);
  return {
    x: frame.centerX - frame.contextRadiusM + (x - MAP_PAD) / scale,
    z: frame.centerZ - frame.contextRadiusM + (y - MAP_PAD) / scale
  };
}

function ringPath(ctx: CanvasRenderingContext2D, frame: MapFrame, ring: number[], holes: number[][] = []): void {
  if (ring.length < 6) return;
  ctx.beginPath();
  const drawRing = (points: number[]): void => {
    for (let i = 0; i + 1 < points.length; i += 2) {
      const point = projectToMap(frame, points[i] / 10, points[i + 1] / 10);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
  };
  drawRing(ring);
  for (const hole of holes) drawRing(hole);
}

function drawVectorFallback(
  ctx: CanvasRenderingContext2D,
  frame: MapFrame,
  model: NonNullable<AppState['model']>
): void {
  const areaColors = ['#b9c9ce', '#aebf8d', '#8ba175', '#c4c4a2'];
  ctx.globalAlpha = 0.9;
  for (const area of model.areas ?? []) {
    ringPath(ctx, frame, area.p, area.holes ?? []);
    ctx.fillStyle = areaColors[(area.k ?? 4) - 1] ?? '#c4c4a2';
    ctx.fill('evenodd');
  }
  ctx.globalAlpha = 1;

  const widths: Record<number, number> = { 1: 2.7, 2: 2, 3: 1.4, 4: 1, 5: 0.8, 9: 0.9 };
  const colors: Record<number, string> = {
    1: '#5d5344',
    2: '#635847',
    3: '#6d6150',
    4: '#81725e',
    5: '#8e6e47',
    9: '#5f5548'
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const road of model.roads ?? []) {
    if (!road.p || road.p.length < 4) continue;
    ringPath(ctx, frame, road.p);
    ctx.strokeStyle = colors[road.c] ?? '#81725e';
    ctx.lineWidth = widths[road.c] ?? 1;
    if (road.c === 5) ctx.setLineDash([3, 3]);
    else ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function mercatorWorld(lat: number, lon: number, zoom: number): { x: number; y: number; size: number } {
  const size = TILE_SIZE * 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * size,
    size
  };
}

function loadTile(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => reject(new Error('tile timeout')), TILE_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('tile failed'));
    };
    image.decoding = 'async';
    image.src = url;
  });
}

async function buildTileBase(lat: number, lon: number): Promise<HTMLCanvasElement | null> {
  const zoom = DETAIL_CONTEXT_TILE_ZOOM;
  const canvas = document.createElement('canvas');
  canvas.width = MAP_PIXELS;
  canvas.height = MAP_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const center = mercatorWorld(lat, lon, zoom);
  const metresPerPixel = (TILE_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const spanPx = (DETAIL_CONTEXT_RADIUS_M * 2) / metresPerPixel;
  const scale = (MAP_PIXELS - MAP_PAD * 2) / spanPx;
  const minX = Math.floor((center.x - spanPx / 2) / TILE_SIZE);
  const maxX = Math.floor((center.x + spanPx / 2) / TILE_SIZE);
  const minY = Math.floor((center.y - spanPx / 2) / TILE_SIZE);
  const maxY = Math.floor((center.y + spanPx / 2) / TILE_SIZE);
  const maxTile = 2 ** zoom;
  const tiles: Array<{ x: number; y: number; image: HTMLImageElement }> = [];
  try {
    await Promise.all(
      Array.from({ length: (maxX - minX + 1) * (maxY - minY + 1) }, async (_, index) => {
        const width = maxX - minX + 1;
        const x = minX + (index % width);
        const y = minY + Math.floor(index / width);
        if (y < 0 || y >= maxTile) return;
        const wrappedX = ((x % maxTile) + maxTile) % maxTile;
        const image = await loadTile(
          `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`
        );
        tiles.push({ x, y, image });
      })
    );
  } catch {
    return null;
  }
  ctx.fillStyle = '#e8e0cf';
  ctx.fillRect(0, 0, MAP_PIXELS, MAP_PIXELS);
  for (const tile of tiles) {
    const left = MAP_PAD + (tile.x * TILE_SIZE - (center.x - spanPx / 2)) * scale;
    const top = MAP_PAD + (tile.y * TILE_SIZE - (center.y - spanPx / 2)) * scale;
    ctx.drawImage(tile.image, left, top, TILE_SIZE * scale + 0.6, TILE_SIZE * scale + 0.6);
  }
  return canvas;
}

export interface DetailMinimapHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export function createDetailMinimap(ctx: UIContext): DetailMinimapHandle {
  const patcher = createPatcher();
  const element = el(
    'section',
    'sl-minimap',
    `
    <header class="sl-minimap-head">
      <div>
        <span class="sl-eyebrow">Choose area</span>
        <strong class="sl-minimap-title">5 km radius</strong>
      </div>
      <button class="sl-btn sl-btn--icon sl-btn--quiet sl-minimap-close" type="button" data-testid="detail-close" aria-label="Close area picker">${icon('close')}</button>
    </header>
    <div class="sl-minimap-map">
      <canvas class="sl-minimap-canvas" data-testid="detail-canvas" width="${MAP_PIXELS}" height="${MAP_PIXELS}" tabindex="0" role="img" aria-label="Five kilometre area overview. Drag the detail frame, or use arrow keys, to choose a high-detail area."></canvas>
      <span class="sl-minimap-north" aria-hidden="true">N</span>
    </div>
    <p class="sl-minimap-status" data-testid="detail-status">Within the loaded city · instant preview</p>
    <label class="sl-minimap-size">
      <span class="sl-minimap-label">Detail radius <output data-testid="detail-size">—</output></span>
      <input class="sl-range sl-minimap-range" type="range" min="${DETAIL_MIN_RADIUS_M}" max="${DETAIL_MAX_RADIUS_M}" step="50" value="750" data-testid="detail-size-input" aria-label="Detail area radius in metres" />
      <span class="sl-minimap-footprint" data-testid="detail-footprint">—</span>
    </label>
    <div class="sl-minimap-actions">
      <button class="sl-btn" type="button" data-testid="detail-focus">${icon('compass')}<span>Focus</span></button>
      <button class="sl-btn sl-btn--primary" type="button" data-testid="detail-load">${icon('locate')}<span>Load area</span></button>
    </div>
    <p class="sl-minimap-attrib">Map context © OpenStreetMap contributors</p>
  `
  );
  element.hidden = true;
  element.dataset.testid = 'detail-panel';
  element.setAttribute('aria-label', 'Choose area picker');

  const canvas = q<HTMLCanvasElement>(element, '[data-testid="detail-canvas"]');
  const sizeInput = q<HTMLInputElement>(element, '[data-testid="detail-size-input"]');
  const sizeReadout = q<HTMLElement>(element, '[data-testid="detail-size"]');
  const footprintReadout = q<HTMLElement>(element, '[data-testid="detail-footprint"]');
  const statusReadout = q<HTMLElement>(element, '[data-testid="detail-status"]');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="detail-close"]');
  const focusButton = q<HTMLButtonElement>(element, '[data-testid="detail-focus"]');
  const loadButton = q<HTMLButtonElement>(element, '[data-testid="detail-load"]');

  let dragging = false;
  let tileKey: string | null = null;
  let tileStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let tileBase: HTMLCanvasElement | null = null;
  let destroyed = false;

  const dispose = [
    on(closeButton, 'click', () => ctx.actions.closeDetailPanel()),
    on(loadButton, 'click', () => ctx.actions.loadDetailArea()),
    on(focusButton, 'click', () => ctx.actions.focusDetailWindow()),
    on(sizeInput, 'input', () => {
      const state = ctx.store.getState();
      if (!state.detailWindow) return;
      ctx.actions.setDetailWindow({ ...state.detailWindow, radiusM: Number(sizeInput.value) });
    }),
    on(canvas, 'pointerdown', (event) => {
      const pointer = event as PointerEvent;
      const state = ctx.store.getState();
      const frame = mapFrame(state);
      if (!frame || !state.detailWindow) return;
      pointer.preventDefault();
      dragging = true;
      canvas.setPointerCapture(pointer.pointerId);
      moveWindow(pointer, state.detailWindow);
    }),
    on(canvas, 'pointermove', (event) => {
      if (!dragging) return;
      const state = ctx.store.getState();
      if (!state.detailWindow) return;
      moveWindow(event as PointerEvent, state.detailWindow);
    }),
    on(canvas, 'pointerup', (event) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture((event as PointerEvent).pointerId)) {
        canvas.releasePointerCapture((event as PointerEvent).pointerId);
      }
    }),
    on(canvas, 'pointercancel', () => {
      dragging = false;
    }),
    on(canvas, 'keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      const state = ctx.store.getState();
      if (!state.detailWindow) return;
      const step = Math.max(10, state.detailWindow.radiusM * 0.2);
      let dx = 0;
      let dz = 0;
      if (key === 'ArrowLeft') dx = -step;
      else if (key === 'ArrowRight') dx = step;
      else if (key === 'ArrowUp') dz = -step;
      else if (key === 'ArrowDown') dz = step;
      else return;
      event.preventDefault();
      ctx.actions.setDetailWindow({
        ...state.detailWindow,
        centerX: state.detailWindow.centerX + dx,
        centerZ: state.detailWindow.centerZ + dz
      });
    })
  ];

  function moveWindow(event: PointerEvent, current: DetailWindow): void {
    const state = ctx.store.getState();
    const frame = mapFrame(state);
    if (!frame) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * MAP_PIXELS;
    const y = ((event.clientY - rect.top) / rect.height) * MAP_PIXELS;
    const point = unprojectFromMap(frame, x, y);
    ctx.actions.setDetailWindow({
      centerX: point.x,
      centerZ: point.z,
      radiusM: current.radiusM
    });
  }

  function startTiles(state: AppState): void {
    const city = state.city;
    if (!city) return;
    const key = `${city.lat.toFixed(5)},${city.lon.toFixed(5)}`;
    if (tileKey === key && (tileStatus === 'loading' || tileStatus === 'ready' || tileStatus === 'failed')) {
      return;
    }
    tileKey = key;
    tileStatus = 'loading';
    tileBase = null;
    const requestKey = key;
    void buildTileBase(city.lat, city.lon)
      .then((base) => {
        if (destroyed || tileKey !== requestKey) return;
        tileBase = base;
        tileStatus = base ? 'ready' : 'failed';
        requestRedraw();
      })
      .catch(() => {
        if (destroyed || tileKey !== requestKey) return;
        tileStatus = 'failed';
        requestRedraw();
      });
  }

  let redrawQueued = false;
  function requestRedraw(): void {
    if (redrawQueued || destroyed) return;
    redrawQueued = true;
    window.requestAnimationFrame(() => {
      redrawQueued = false;
      if (!destroyed) redraw(ctx.store.getState());
    });
  }

  function redraw(state: AppState): void {
    const frame = mapFrame(state);
    const detail = state.detailWindow;
    const model = state.model;
    if (!frame || !detail || !model) return;
    startTiles(state);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, MAP_PIXELS, MAP_PIXELS);

    if (tileBase) {
      context.drawImage(tileBase, 0, 0);
    } else {
      context.fillStyle = '#e8e0cf';
      context.fillRect(0, 0, MAP_PIXELS, MAP_PIXELS);
      drawVectorFallback(context, frame, model);
    }

    // The cached high-detail footprint.
    const footprintTopLeft = projectToMap(
      frame,
      frame.centerX - frame.modelRadiusM,
      frame.centerZ - frame.modelRadiusM
    );
    const footprintBottomRight = projectToMap(
      frame,
      frame.centerX + frame.modelRadiusM,
      frame.centerZ + frame.modelRadiusM
    );
    const footprintX = Math.min(footprintTopLeft.x, footprintBottomRight.x);
    const footprintY = Math.min(footprintTopLeft.y, footprintBottomRight.y);
    const footprintW = Math.abs(footprintBottomRight.x - footprintTopLeft.x);
    const footprintH = Math.abs(footprintBottomRight.y - footprintTopLeft.y);
    context.fillStyle = 'rgba(255, 246, 228, 0.08)';
    context.fillRect(footprintX, footprintY, footprintW, footprintH);
    context.strokeStyle = 'rgba(90, 72, 48, 0.62)';
    context.lineWidth = 1.2;
    context.setLineDash([4, 3]);
    context.strokeRect(footprintX, footprintY, footprintW, footprintH);
    context.setLineDash([]);

    // The detail window.
    const topLeft = projectToMap(
      frame,
      detail.centerX - detail.radiusM,
      detail.centerZ - detail.radiusM
    );
    const bottomRight = projectToMap(
      frame,
      detail.centerX + detail.radiusM,
      detail.centerZ + detail.radiusM
    );
    const x = Math.min(topLeft.x, bottomRight.x);
    const y = Math.min(topLeft.y, bottomRight.y);
    const w = Math.abs(bottomRight.x - topLeft.x);
    const h = Math.abs(bottomRight.y - topLeft.y);

    context.fillStyle = 'rgba(255, 248, 232, 0.24)';
    context.fillRect(x, y, w, h);
    context.strokeStyle = '#c4572f';
    context.lineWidth = 2.2;
    context.strokeRect(x, y, w, h);
    context.fillStyle = '#fff6e6';
    const handle = 4.5;
    for (const [hx, hy] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ]) {
      context.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
  }

  function update(state: AppState): void {
    const visible = state.detailPanelOpen && state.model !== null && state.detailWindow !== null;
    patcher.hidden(element, !visible);
    if (!visible) return;
    const detail = state.detailWindow!;
    const frame = mapFrame(state)!;
    const maxRadius = Math.min(DETAIL_MAX_RADIUS_M, state.model!.meta.radiusM);
    const inside = detailWindowInsideModel(detail, frame);
    patcher.attr(sizeInput, 'max', maxRadius);
    patcher.value(sizeInput, String(Math.round(detail.radiusM)));
    patcher.text(sizeReadout, detailRadiusLabel(detail.radiusM));
    patcher.text(footprintReadout, detailFootprintLabel(detail.radiusM));
    patcher.attr(sizeInput, 'aria-valuetext', detailRadiusLabel(detail.radiusM));
    patcher.text(
      statusReadout,
      inside
        ? 'Within the loaded city · instant preview'
        : 'Outside loaded city · Load area to build it'
    );
    patcher.cls(statusReadout, 'is-outside', !inside);
    patcher.disabled(focusButton, !inside);
    redraw(state);
  }

  return {
    element,
    update,
    destroy(): void {
      destroyed = true;
      dispose.forEach((disposeListener) => disposeListener());
    }
  };
}
