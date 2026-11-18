/**
 * Combined choose-area / detail-window minimap.
 *
 * The map covers a 5 km radius around the city. Inside that, the loaded
 * high-detail model (3 km across by default) and a draggable detail window are
 * shown. The wider context comes from a one-time OSM raster overview (the
 * loaded model is used as an offline fallback). Moving the window never
 * reloads the model; "Load area" recenters/generates a new model when the
 * selected area is outside the current one.
 *
 * On narrow or short viewports the picker becomes a modal sheet with a backdrop
 * so the time console can never paint on top of it. The sheet mode and its
 * status copy are pure, unit-tested helpers at the top of this module.
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
import { createPatcher, el, focusEl, on, q, trapFocus } from './dom.ts';
import { icon } from './icons.ts';

const MAP_PIXELS = 480;
const MAP_PAD = 14;
const TILE_SIZE = 256;
const TILE_METRES_PER_PIXEL = 156_543.03392; // at zoom 0, equator
const TILE_TIMEOUT_MS = 8000;

/**
 * Above this width the picker can sit beside the time console; below it the
 * console would cover the map and actions, so the picker turns into a sheet.
 */
export const AREA_SHEET_MAX_WIDTH = 1180;
/** Below this height the picker always becomes a sheet (200 % zoom, landscape). */
export const AREA_SHEET_MAX_HEIGHT = 620;

export type AreaPanelMode = 'panel' | 'sheet';

/** Pure layout decision, shared by the CSS/JS layout switch and unit tests. */
export function areaPanelMode(viewportWidth: number, viewportHeight: number): AreaPanelMode {
  if (viewportWidth <= AREA_SHEET_MAX_WIDTH) return 'sheet';
  if (viewportHeight <= AREA_SHEET_MAX_HEIGHT) return 'sheet';
  return 'panel';
}

/** User-facing status line: whether the window is inside the loaded city. */
export function areaStatusText(inside: boolean): string {
  return inside
    ? 'Within the loaded city · Focus frames it; Load area is off'
    : 'Outside the loaded city · Load area builds it here';
}

/** Plain-language help under the panel title. */
export const AREA_HELP_TEXT =
  'Focus closes this panel and zooms the 3D view to the square; Load area rebuilds the city here. Drag or use arrows; Alt+arrows move in fine 1% steps.';

/** Canvas accessible name, including radius/footprint and what keys do. */
export function areaCanvasLabel(radiusM: number, inside: boolean): string {
  const where = inside ? 'inside the loaded city' : 'outside the loaded city';
  return (
    `Area overview. Window ${detailRadiusLabel(radiusM)}, ${detailFootprintLabel(radiusM)}, ${where}. ` +
    `Drag the frame or use the arrow keys to move the window.`
  );
}

/** Explains why "Load area" is unavailable while the window is inside the model. */
export function loadAreaTitle(inside: boolean): string {
  return inside
    ? 'This window is already inside the loaded city — use Focus to frame it'
    : 'Build a high-detail city model for this window';
}

/** Explains why "Focus" is unavailable while the window is outside the model. */
export function focusAreaTitle(inside: boolean): string {
  return inside
    ? 'Close the picker and zoom the 3D view to this square'
    : 'Focus is only available inside the loaded city — use Load area first';
}

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

function mapFrame(
  state: AppState,
  view?: { centerX: number; centerZ: number; contextRadiusM: number }
): MapFrame | null {
  const model = state.model;
  if (!model) return null;
  const centerX = (model.bounds.minX + model.bounds.maxX) / 20;
  const centerZ = (model.bounds.minZ + model.bounds.maxZ) / 20;
  return {
    centerX: view?.centerX ?? centerX,
    centerZ: view?.centerZ ?? centerZ,
    modelRadiusM: Math.max(1, model.meta.radiusM),
    contextRadiusM: view?.contextRadiusM ?? DETAIL_CONTEXT_RADIUS_M
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

async function buildTileBase(
  lat: number,
  lon: number,
  contextRadiusM: number,
  zoom: number
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_PIXELS;
  canvas.height = MAP_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const center = mercatorWorld(lat, lon, zoom);
  const metresPerPixel = (TILE_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const spanPx = (contextRadiusM * 2) / metresPerPixel;
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
  /** Dims and blocks the UI behind the picker while it is a modal sheet. */
  backdrop: HTMLElement;
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
      <div class="sl-minimap-heading">
        <span class="sl-eyebrow">Area</span>
        <strong class="sl-minimap-title" id="sl-area-heading">Choose an area</strong>
      </div>
      <button class="sl-btn sl-btn--icon sl-btn--quiet sl-minimap-close" type="button" data-testid="detail-close" aria-label="Close area picker" title="Close area picker (Esc)">${icon('close')}</button>
    </header>
    <p class="sl-minimap-help" id="sl-area-help">${AREA_HELP_TEXT}</p>
    <div class="sl-minimap-map">
      <canvas class="sl-minimap-canvas" data-testid="detail-canvas" width="${MAP_PIXELS}" height="${MAP_PIXELS}" tabindex="0" role="img" aria-describedby="sl-area-help" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" aria-label="Five kilometre area overview"></canvas>
      <span class="sl-minimap-north" aria-hidden="true">N</span>
    </div>
    <div class="sl-minimap-zoom" role="group" aria-label="Map zoom">
      <button type="button" class="sl-minimap-zoom-btn" data-testid="detail-map-zoom-out" aria-label="Zoom the overview map out">−</button>
      <span class="sl-minimap-zoom-label" data-testid="detail-map-scale">5 km radius</span>
      <button type="button" class="sl-minimap-zoom-btn" data-testid="detail-map-zoom-in" aria-label="Zoom the overview map in">+</button>
    </div>
    <div class="sl-minimap-tiles-row">
      <p class="sl-minimap-tiles" data-testid="detail-tiles" aria-live="polite">Map context loading…</p>
      <button class="sl-minimap-retry" type="button" data-testid="detail-tile-retry" hidden>Retry map</button>
    </div>
    <p class="sl-minimap-status" id="sl-area-status" data-testid="detail-status" aria-live="polite" aria-atomic="true">Within the loaded city · instant preview</p>
    <p class="sl-minimap-position" data-testid="detail-position">Centre —</p>
    <label class="sl-minimap-size">
      <span class="sl-minimap-label"><span>Window radius</span><output data-testid="detail-size">—</output></span>
      <input class="sl-range sl-minimap-range" type="range" min="${DETAIL_MIN_RADIUS_M}" max="${DETAIL_MAX_RADIUS_M}" step="50" value="750" data-testid="detail-size-input" aria-label="Detail window radius in metres" aria-describedby="sl-area-help" />
      <span class="sl-minimap-footprint" data-testid="detail-footprint">—</span>
    </label>
    <div class="sl-minimap-actions">
      <button class="sl-btn sl-btn--primary" type="button" data-testid="detail-focus" title="Close the picker and zoom the 3D view to this square">${icon('compass')}<span>Focus</span></button>
      <button class="sl-btn" type="button" data-testid="detail-load" aria-describedby="sl-area-status">${icon('locate')}<span>Load area</span></button>
    </div>
    <p class="sl-minimap-attrib">Map context © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></p>
  `
  );
  element.hidden = true;
  element.dataset.testid = 'detail-panel';
  element.dataset.mode = 'panel';
  element.setAttribute('role', 'region');
  element.setAttribute('aria-labelledby', 'sl-area-heading');

  const backdrop = el('div', 'sl-area-backdrop');
  backdrop.hidden = true;
  backdrop.dataset.testid = 'detail-backdrop';

  const canvas = q<HTMLCanvasElement>(element, '[data-testid="detail-canvas"]');
  const sizeInput = q<HTMLInputElement>(element, '[data-testid="detail-size-input"]');
  const sizeReadout = q<HTMLElement>(element, '[data-testid="detail-size"]');
  const footprintReadout = q<HTMLElement>(element, '[data-testid="detail-footprint"]');
  const positionReadout = q<HTMLElement>(element, '[data-testid="detail-position"]');
  const statusReadout = q<HTMLElement>(element, '[data-testid="detail-status"]');
  const tilesReadout = q<HTMLElement>(element, '[data-testid="detail-tiles"]');
  const retryTiles = q<HTMLButtonElement>(element, '[data-testid="detail-tile-retry"]');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="detail-close"]');
  const focusButton = q<HTMLButtonElement>(element, '[data-testid="detail-focus"]');
  const loadButton = q<HTMLButtonElement>(element, '[data-testid="detail-load"]');
  const mapZoomIn = q<HTMLButtonElement>(element, '[data-testid="detail-map-zoom-in"]');
  const mapZoomOut = q<HTMLButtonElement>(element, '[data-testid="detail-map-zoom-out"]');
  const mapScale = q<HTMLElement>(element, '[data-testid="detail-map-scale"]');

  let dragging = false;
  let mapZoom = 1;
  let mapCenterX = 0;
  let mapCenterZ = 0;
  let mapModelKey: string | null = null;
  let tileKey: string | null = null;
  let tileStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let tileBase: HTMLCanvasElement | null = null;
  let destroyed = false;
  let wasVisible = false;
  let compact = false;

  const sheetQuery = window.matchMedia(
    `(max-width: ${AREA_SHEET_MAX_WIDTH}px), (max-height: ${AREA_SHEET_MAX_HEIGHT}px)`
  );

  function syncMode(): void {
    const nextCompact = sheetQuery.matches;
    if (nextCompact === compact && element.dataset.mode === (nextCompact ? 'sheet' : 'panel')) return;
    compact = nextCompact;
    element.dataset.mode = compact ? 'sheet' : 'panel';
    element.setAttribute('role', compact ? 'dialog' : 'region');
    if (compact) element.setAttribute('aria-modal', 'true');
    else element.removeAttribute('aria-modal');
    backdrop.hidden = !(compact && wasVisible);
  }

  function contextRadiusM(): number {
    return DETAIL_CONTEXT_RADIUS_M / mapZoom;
  }

  function currentFrame(state: AppState): MapFrame | null {
    const base = mapFrame(state);
    if (!base) return null;
    return {
      ...base,
      centerX: mapZoom === 1 ? base.centerX : mapCenterX,
      centerZ: mapZoom === 1 ? base.centerZ : mapCenterZ,
      contextRadiusM: contextRadiusM()
    };
  }

  function syncMapZoomUi(): void {
    const contextKm = contextRadiusM() / 1000;
    patcher.text(
      mapScale,
      contextKm >= 1
        ? `${contextKm.toFixed(contextKm >= 10 ? 0 : 1).replace(/\.0$/, '')} km radius`
        : `${Math.round(contextRadiusM())} m radius`
    );
    patcher.disabled(mapZoomOut, mapZoom <= 1);
    patcher.disabled(mapZoomIn, mapZoom >= 8);
  }

  function setMapZoom(nextZoom: number, state: AppState): void {
    const detail = state.detailWindow;
    const base = mapFrame(state);
    if (!detail || !base) return;
    const next = Math.max(1, Math.min(8, nextZoom));
    if (next === mapZoom) return;
    mapZoom = next;
    if (next === 1) {
      mapCenterX = base.centerX;
      mapCenterZ = base.centerZ;
    } else {
      mapCenterX = detail.centerX;
      mapCenterZ = detail.centerZ;
    }
    tileKey = null;
    tileBase = null;
    tileStatus = 'idle';
    syncMapZoomUi();
    requestRedraw();
  }

  const dispose = [
    on(closeButton, 'click', () => ctx.actions.closeDetailPanel()),
    on(backdrop, 'click', () => ctx.actions.closeDetailPanel()),
    on(loadButton, 'click', () => ctx.actions.loadDetailArea()),
    on(focusButton, 'click', () => ctx.actions.focusDetailWindow()),
    on(retryTiles, 'click', () => retryTileBase()),
    on(mapZoomIn, 'click', () => setMapZoom(mapZoom * 2, ctx.store.getState())),
    on(mapZoomOut, 'click', () => setMapZoom(mapZoom / 2, ctx.store.getState())),
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
      const keyboard = event as KeyboardEvent;
      const state = ctx.store.getState();
      if (!state.detailWindow) return;
      const baseStep = Math.max(1, state.detailWindow.radiusM * 0.2);
      const step = keyboard.altKey
        ? Math.max(1, state.detailWindow.radiusM * 0.01)
        : keyboard.shiftKey
          ? baseStep * 2.5
          : baseStep;
      let dx = 0;
      let dz = 0;
      if (keyboard.key === 'ArrowLeft') dx = -step;
      else if (keyboard.key === 'ArrowRight') dx = step;
      else if (keyboard.key === 'ArrowUp') dz = -step;
      else if (keyboard.key === 'ArrowDown') dz = step;
      else return;
      keyboard.preventDefault();
      ctx.actions.setDetailWindow({
        ...state.detailWindow,
        centerX: state.detailWindow.centerX + dx,
        centerZ: state.detailWindow.centerZ + dz
      });
    }),
    on(element, 'keydown', (event) => {
      // Escape is intentionally left to bubble to the shell, which closes the
      // picker and returns focus to the Area button. Tab stays inside the modal
      // sheet so focus can never wander behind the backdrop.
      if (compact) trapFocus(event as KeyboardEvent, element);
    })
  ];
  sheetQuery.addEventListener('change', syncMode);
  syncMode();

  function moveWindow(event: PointerEvent, current: DetailWindow): void {
    const state = ctx.store.getState();
    const frame = currentFrame(state);
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

  function syncTileUi(): void {
    const failed = tileStatus === 'failed';
    patcher.hidden(retryTiles, !failed);
    patcher.cls(tilesReadout, 'is-error', failed);
    patcher.text(
      tilesReadout,
      failed
        ? 'Map unavailable — using the loaded city.'
        : tileStatus === 'ready'
          ? 'Map context loaded from OpenStreetMap.'
          : 'Loading map context from OpenStreetMap…'
    );
  }

  function startTiles(state: AppState): void {
    syncTileUi();
    const city = state.city;
    const base = mapFrame(state);
    if (!city || !base) return;
    const frame = currentFrame(state);
    if (!frame) return;
    const tileZoom = Math.max(
      12,
      Math.min(16, DETAIL_CONTEXT_TILE_ZOOM + Math.round(Math.log2(mapZoom)))
    );
    const centreLat = city.lat - (frame.centerZ - base.centerZ) / 111_320;
    const centreLon =
      city.lon +
      (frame.centerX - base.centerX) /
        (111_320 * Math.cos((city.lat * Math.PI) / 180));
    const key = `${centreLat.toFixed(5)},${centreLon.toFixed(5)},${Math.round(frame.contextRadiusM)},${tileZoom}`;
    if (tileKey === key && (tileStatus === 'loading' || tileStatus === 'ready' || tileStatus === 'failed')) {
      return;
    }
    tileKey = key;
    tileStatus = 'loading';
    tileBase = null;
    syncTileUi();
    const requestKey = key;
    void buildTileBase(centreLat, centreLon, frame.contextRadiusM, tileZoom)
      .then((base) => {
        if (destroyed || tileKey !== requestKey) return;
        tileBase = base;
        tileStatus = base ? 'ready' : 'failed';
        syncTileUi();
        requestRedraw();
      })
      .catch(() => {
        if (destroyed || tileKey !== requestKey) return;
        tileStatus = 'failed';
        syncTileUi();
        requestRedraw();
      });
  }

  function retryTileBase(): void {
    if (tileStatus === 'loading') return;
    tileKey = null;
    tileStatus = 'idle';
    tileBase = null;
    syncTileUi();
    const state = ctx.store.getState();
    startTiles(state);
    requestRedraw();
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
    const frame = currentFrame(state);
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
    if (visible && !wasVisible) {
      // A previous tile failure gets one fresh attempt per opening.
      if (tileStatus === 'failed') {
        tileKey = null;
        tileStatus = 'idle';
        tileBase = null;
      }
      element.hidden = false;
      backdrop.hidden = !compact;
      window.setTimeout(() => {
        if (wasVisible && !dragging) focusEl(canvas);
      }, 0);
    } else if (!visible && wasVisible) {
      element.hidden = true;
      backdrop.hidden = true;
    }
    wasVisible = visible;
    if (!visible) {
      backdrop.hidden = true;
      return;
    }
    const detail = state.detailWindow!;
    if (state.model?.key !== mapModelKey) {
      mapModelKey = state.model?.key ?? null;
      mapZoom = 1;
      mapCenterX = 0;
      mapCenterZ = 0;
      tileKey = null;
      tileBase = null;
      tileStatus = 'idle';
    }
    const frame = currentFrame(state)!;
    const maxRadius = Math.min(DETAIL_MAX_RADIUS_M, state.model!.meta.radiusM);
    const inside = detailWindowInsideModel(detail, frame);
    patcher.attr(sizeInput, 'max', maxRadius);
    patcher.value(sizeInput, String(Math.round(detail.radiusM)));
    patcher.text(sizeReadout, detailRadiusLabel(detail.radiusM));
    patcher.text(footprintReadout, `Footprint ${detailFootprintLabel(detail.radiusM)}`);
    patcher.text(
      positionReadout,
      `Centre ${Math.round(detail.centerX)} m east · ${Math.round(-detail.centerZ)} m north · Alt+arrows = 1% steps`
    );
    patcher.attr(sizeInput, 'aria-valuetext', `${detailRadiusLabel(detail.radiusM)}, ${detailFootprintLabel(detail.radiusM)}`);
    patcher.text(statusReadout, areaStatusText(inside));
    patcher.cls(statusReadout, 'is-outside', !inside);
    patcher.attr(canvas, 'aria-label', areaCanvasLabel(detail.radiusM, inside));
    syncMapZoomUi();

    // Focus rebuilds nothing and stays available inside the model; Load area
    // only makes sense outside it, so the primary action follows the context.
    patcher.disabled(focusButton, !inside);
    patcher.attr(focusButton, 'title', focusAreaTitle(inside));
    patcher.disabled(loadButton, inside);
    patcher.attr(loadButton, 'title', loadAreaTitle(inside));
    patcher.attr(
      loadButton,
      'aria-label',
      inside ? 'Load area (unavailable: window already inside the loaded city)' : 'Load area'
    );
    patcher.cls(loadButton, 'sl-btn--primary', !inside);
    patcher.cls(focusButton, 'sl-btn--primary', inside);
    patcher.cls(focusButton, 'sl-btn--secondary', !inside);
    syncTileUi();
    redraw(state);
  }

  return {
    element,
    backdrop,
    update,
    destroy(): void {
      destroyed = true;
      sheetQuery.removeEventListener('change', syncMode);
      dispose.forEach((disposeListener) => disposeListener());
    }
  };
}
