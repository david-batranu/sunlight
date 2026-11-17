/**
 * Minimap detail-window picker.
 *
 * The map is drawn from the already-loaded CityModel — no tiles, no API. The
 * draggable square controls which part of the loaded model stays at full
 * visual detail; everything outside is muted by the scene shader.
 */

import type { AppState } from '../app/state.ts';
import type { DetailWindow, UIContext } from '../app/contracts.ts';
import { detailFootprintLabel, detailRadiusLabel } from '../app/detail.ts';
import { DETAIL_MAX_RADIUS_M, DETAIL_MIN_RADIUS_M } from '../../shared/constants.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

const MAP_PIXELS = 480;
const MAP_PAD = 18;

interface MapFrame {
  centerX: number;
  centerZ: number;
  radiusM: number;
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
    radiusM: Math.max(1, model.meta.radiusM)
  };
}

function projectToMap(frame: MapFrame, xM: number, zM: number): MapPoint {
  const scale = (MAP_PIXELS - MAP_PAD * 2) / (frame.radiusM * 2);
  return {
    x: MAP_PAD + (xM - (frame.centerX - frame.radiusM)) * scale,
    y: MAP_PAD + (zM - (frame.centerZ - frame.radiusM)) * scale,
    scale
  };
}

function unprojectFromMap(frame: MapFrame, x: number, y: number): { x: number; z: number } {
  const scale = (MAP_PIXELS - MAP_PAD * 2) / (frame.radiusM * 2);
  return {
    x: frame.centerX - frame.radiusM + (x - MAP_PAD) / scale,
    z: frame.centerZ - frame.radiusM + (y - MAP_PAD) / scale
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

function drawBase(model: AppState['model']): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_PIXELS;
  canvas.height = MAP_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#efe6d3';
  ctx.fillRect(0, 0, MAP_PIXELS, MAP_PIXELS);
  if (!model) return canvas;
  const frame: MapFrame = {
    centerX: (model.bounds.minX + model.bounds.maxX) / 20,
    centerZ: (model.bounds.minZ + model.bounds.maxZ) / 20,
    radiusM: Math.max(1, model.meta.radiusM)
  };

  ctx.fillStyle = '#e9dfca';
  ctx.strokeStyle = 'rgba(70,54,36,0.18)';
  ctx.lineWidth = 2;
  const framePoint = projectToMap(frame, 0, 0);
  ctx.fillRect(
    MAP_PAD,
    MAP_PAD,
    MAP_PIXELS - MAP_PAD * 2,
    MAP_PIXELS - MAP_PAD * 2
  );
  ctx.strokeRect(MAP_PAD, MAP_PAD, MAP_PIXELS - MAP_PAD * 2, MAP_PIXELS - MAP_PAD * 2);
  void framePoint;

  const areaColors = ['#b9c9ce', '#aebf8d', '#8ba175', '#c4c4a2'];
  ctx.globalAlpha = 0.95;
  for (const area of model.areas ?? []) {
    const color = areaColors[(area.k ?? 4) - 1] ?? '#c4c4a2';
    ringPath(ctx, frame, area.p, area.holes ?? []);
    ctx.fillStyle = color;
    ctx.fill('evenodd');
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#d8c9af';
  for (const building of model.buildings ?? []) {
    ringPath(ctx, frame, building.p);
    ctx.fill();
  }

  const widths: Record<number, number> = { 1: 4.6, 2: 3.3, 3: 2.3, 4: 1.7, 5: 1.3, 9: 1.5 };
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
    ctx.lineWidth = widths[road.c] ?? 1.8;
    if (road.c === 5) ctx.setLineDash([5, 4]);
    else ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
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
        <span class="sl-eyebrow">Detail area</span>
        <strong class="sl-minimap-title">High-detail window</strong>
      </div>
      <button class="sl-btn sl-btn--icon sl-btn--quiet sl-minimap-close" type="button" data-testid="detail-close" aria-label="Close detail area">${icon('close')}</button>
    </header>
    <div class="sl-minimap-map">
      <canvas class="sl-minimap-canvas" data-testid="detail-canvas" width="${MAP_PIXELS}" height="${MAP_PIXELS}" tabindex="0" role="img" aria-label="Detail area map. Drag the frame, or use arrow keys, to move the high-detail area."></canvas>
      <span class="sl-minimap-north" aria-hidden="true">N</span>
    </div>
    <label class="sl-minimap-size">
      <span class="sl-minimap-label">Detail radius <output data-testid="detail-size">—</output></span>
      <input class="sl-range sl-minimap-range" type="range" min="${DETAIL_MIN_RADIUS_M}" max="${DETAIL_MAX_RADIUS_M}" step="50" value="750" data-testid="detail-size-input" aria-label="Detail area radius in metres" />
      <span class="sl-minimap-footprint" data-testid="detail-footprint">—</span>
    </label>
    <div class="sl-minimap-actions">
      <button class="sl-btn sl-btn--primary" type="button" data-testid="detail-focus">${icon('compass')}<span>Focus</span></button>
      <button class="sl-btn sl-btn--quiet" type="button" data-testid="detail-clear">Whole city</button>
    </div>
    <p class="sl-minimap-hint">Drag the frame. Outside it stays visible at lower detail.</p>
  `
  );
  element.hidden = true;
  element.dataset.testid = 'detail-panel';
  element.setAttribute('aria-label', 'Detail area picker');

  const canvas = q<HTMLCanvasElement>(element, '[data-testid="detail-canvas"]');
  const sizeInput = q<HTMLInputElement>(element, '[data-testid="detail-size-input"]');
  const sizeReadout = q<HTMLElement>(element, '[data-testid="detail-size"]');
  const footprintReadout = q<HTMLElement>(element, '[data-testid="detail-footprint"]');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="detail-close"]');
  const focusButton = q<HTMLButtonElement>(element, '[data-testid="detail-focus"]');
  const clearButton = q<HTMLButtonElement>(element, '[data-testid="detail-clear"]');

  let baseCanvas: HTMLCanvasElement | null = null;
  let baseKey: string | null = null;
  let dragging = false;

  const dispose = [
    on(closeButton, 'click', () => ctx.actions.closeDetailPanel()),
    on(clearButton, 'click', () => {
      ctx.actions.closeDetailPanel();
      ctx.actions.resetCamera();
    }),
    on(focusButton, 'click', () => ctx.actions.focusDetailWindow()),
    on(sizeInput, 'input', () => {
      const state = ctx.store.getState();
      if (!state.detailWindow) return;
      ctx.actions.setDetailWindow({ ...state.detailWindow, radiusM: Number(sizeInput.value) });
    }),
    on(sizeInput, 'change', () => ctx.actions.focusDetailWindow()),
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
      ctx.actions.focusDetailWindow();
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
      ctx.actions.focusDetailWindow();
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

  function redraw(state: AppState): void {
    const frame = mapFrame(state);
    const detail = state.detailWindow;
    if (!frame || !detail) {
      return;
    }
    const key = `${state.model?.key ?? ''}:${frame.radiusM}`;
    if (!baseCanvas || baseKey !== key) {
      baseCanvas = drawBase(state.model);
      baseKey = key;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, MAP_PIXELS, MAP_PIXELS);
    context.drawImage(baseCanvas, 0, 0);

    const topLeft = projectToMap(frame, detail.centerX - detail.radiusM, detail.centerZ - detail.radiusM);
    const bottomRight = projectToMap(frame, detail.centerX + detail.radiusM, detail.centerZ + detail.radiusM);
    const x = Math.min(topLeft.x, bottomRight.x);
    const y = Math.min(topLeft.y, bottomRight.y);
    const w = Math.abs(bottomRight.x - topLeft.x);
    const h = Math.abs(bottomRight.y - topLeft.y);

    context.fillStyle = 'rgba(255, 248, 232, 0.2)';
    context.fillRect(x, y, w, h);
    context.strokeStyle = '#c4572f';
    context.lineWidth = 2.5;
    context.setLineDash([]);
    context.strokeRect(x, y, w, h);
    context.fillStyle = '#fff6e6';
    const handle = 5;
    for (const [hx, hy] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ]) {
      context.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
    context.strokeStyle = 'rgba(70, 54, 36, 0.5)';
    context.lineWidth = 1;
    context.strokeRect(x, y, w, h);
  }

  function update(state: AppState): void {
    const visible = state.detailPanelOpen && state.model !== null && state.detailWindow !== null;
    patcher.hidden(element, !visible);
    if (!visible) return;
    const detail = state.detailWindow!;
    const maxRadius = Math.min(DETAIL_MAX_RADIUS_M, state.model!.meta.radiusM);
    patcher.attr(sizeInput, 'max', maxRadius);
    patcher.value(sizeInput, String(Math.round(detail.radiusM)));
    patcher.text(sizeReadout, detailRadiusLabel(detail.radiusM));
    patcher.attr(sizeInput, 'aria-valuetext', detailRadiusLabel(detail.radiusM));
    patcher.text(footprintReadout, detailFootprintLabel(detail.radiusM));
    redraw(state);
  }

  return {
    element,
    update,
    destroy(): void {
      dispose.forEach((disposeListener) => disposeListener());
    }
  };
}
