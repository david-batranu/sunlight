/**
 * Diorama camera controls (pointer + touch), independent of the store/UI.
 *
 * Interaction contract:
 *  - default view                 → isometric from the south-east, NW up
 *  - left-drag (mouse)            → pan on the ground plane
 *  - right/middle-drag, shift-drag → orbit (azimuth 0-360, pitch 18-72°)
 *  - wheel / trackpad-pinch / touch pinch → zoom (0.45x-8x)
 *  - two-finger drag              → pan while pinching
 *  - double-click / double-tap    → discrete reset to the isometric default
 *
 * All motion is damped toward a target state; `update(dt)` must be called once
 * per rendered frame. The scene owns the camera and projects this state.
 */

import {
  DEFAULT_AZIMUTH_DEG,
  DEFAULT_PITCH_DEG,
  DEFAULT_ZOOM,
  PITCH_MAX_DEG,
  PITCH_MIN_DEG,
  ZOOM_MAX,
  ZOOM_MIN,
  clampPitch,
  clampTarget,
  clampZoom,
  dampingAlpha,
  dragToPan,
  wrapAzimuth,
  type PanBounds
} from './camera.ts';

const ORBIT_DAMPING = 14;
const PITCH_DAMPING = 16;
const PAN_DAMPING = 22;
const ZOOM_DAMPING = 18;
const SNAP_EPSILON = 1e-3;

const ORBIT_SENSITIVITY_DEG = 0.32;
const PITCH_SENSITIVITY_DEG = 0.26;
const WHEEL_ZOOM_SENSITIVITY = 0.0012;
const TAP_TIMEOUT_MS = 320;
const TAP_SLOP_PX = 26;
const DRAG_SLOP_PX = 5;

interface PointerPosition {
  x: number;
  y: number;
}

export interface ControlsView {
  fitHalfHeight: number;
  viewportHeight: number;
}

type DragMode = 'none' | 'pan' | 'orbit' | 'pinch';

export class DioramaControls {
  private readonly element: HTMLElement;

  private desiredAzimuth = DEFAULT_AZIMUTH_DEG;
  private desiredPitch = DEFAULT_PITCH_DEG;
  private desiredZoom = DEFAULT_ZOOM;
  private desiredX = 0;
  private desiredZ = 0;

  private azimuth = DEFAULT_AZIMUTH_DEG;
  private pitch = DEFAULT_PITCH_DEG;
  private zoom = DEFAULT_ZOOM;
  private x = 0;
  private z = 0;

  private bounds: PanBounds = { centerX: 0, centerZ: 0, halfX: 900, halfZ: 900 };
  private view: ControlsView = { fitHalfHeight: 1000, viewportHeight: 800 };

  private readonly pointers = new Map<number, PointerPosition>();
  private mode: DragMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private dragged = false;
  private pinchDistance = 0;
  private pinchMidX = 0;
  private pinchMidY = 0;
  private lastTapAt = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private disposed = false;

  /** Reused object for the pure pan helper (no per-move allocation). */
  private readonly panView = {
    fitHalfHeight: 1000,
    zoom: 1,
    viewportHeight: 800,
    azimuthDeg: DEFAULT_AZIMUTH_DEG,
    pitchDeg: DEFAULT_PITCH_DEG
  };

  constructor(element: HTMLElement) {
    this.element = element;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('dblclick', this.onDoubleClick);
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  setModelBounds(bounds: PanBounds): void {
    this.bounds = {
      centerX: bounds.centerX,
      centerZ: bounds.centerZ,
      halfX: Math.max(1, bounds.halfX * 0.9),
      halfZ: Math.max(1, bounds.halfZ * 0.9)
    };
    const [x, z] = clampTarget(this.desiredX, this.desiredZ, this.bounds);
    this.desiredX = x;
    this.desiredZ = z;
    const [cx, cz] = clampTarget(this.x, this.z, this.bounds);
    this.x = cx;
    this.z = cz;
  }

  setViewMetrics(fitHalfHeight: number, viewportHeight: number): void {
    this.view.fitHalfHeight = Math.max(1, fitHalfHeight);
    this.view.viewportHeight = Math.max(1, viewportHeight);
  }

  /** Moves the camera target, optionally snapping (used on city switch). */
  setTarget(x: number, z: number, snap = false): void {
    const [cx, cz] = clampTarget(x, z, this.bounds);
    this.desiredX = cx;
    this.desiredZ = cz;
    if (snap) {
      this.x = cx;
      this.z = cz;
    }
  }

  reset(): void {
    this.desiredAzimuth = DEFAULT_AZIMUTH_DEG;
    this.desiredPitch = DEFAULT_PITCH_DEG;
    this.desiredZoom = DEFAULT_ZOOM;
    this.desiredX = this.bounds.centerX;
    this.desiredZ = this.bounds.centerZ;
    this.azimuth = this.desiredAzimuth;
    this.pitch = this.desiredPitch;
    this.zoom = this.desiredZoom;
    this.x = this.desiredX;
    this.z = this.desiredZ;
    this.mode = 'none';
    this.pointers.clear();
  }

  update(dt: number): void {
    if (this.disposed) return;
    const orbitAlpha = dampingAlpha(ORBIT_DAMPING, dt);
    const pitchAlpha = dampingAlpha(PITCH_DAMPING, dt);
    const panAlpha = dampingAlpha(PAN_DAMPING, dt);
    const zoomAlpha = dampingAlpha(ZOOM_DAMPING, dt);

    // Azimuth uses shortest-arc damping so a full turn never spins backwards.
    let azimuthDelta = (((this.desiredAzimuth - this.azimuth) % 360) + 540) % 360 - 180;
    if (Math.abs(azimuthDelta) < SNAP_EPSILON) {
      this.azimuth = this.desiredAzimuth;
    } else {
      this.azimuth = wrapAzimuth(this.azimuth + azimuthDelta * orbitAlpha);
    }

    this.pitch += (this.desiredPitch - this.pitch) * pitchAlpha;
    if (Math.abs(this.desiredPitch - this.pitch) < SNAP_EPSILON) this.pitch = this.desiredPitch;

    this.zoom += (this.desiredZoom - this.zoom) * zoomAlpha;
    if (Math.abs(this.desiredZoom - this.zoom) < 1e-4) this.zoom = this.desiredZoom;

    this.x += (this.desiredX - this.x) * panAlpha;
    this.z += (this.desiredZ - this.z) * panAlpha;
    if (Math.abs(this.desiredX - this.x) < 0.01) this.x = this.desiredX;
    if (Math.abs(this.desiredZ - this.z) < 0.01) this.z = this.desiredZ;
    const [cx, cz] = clampTarget(this.x, this.z, this.bounds);
    this.x = cx;
    this.z = cz;
  }

  get azimuthDeg(): number {
    return this.azimuth;
  }

  get pitchDeg(): number {
    return this.pitch;
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  get targetX(): number {
    return this.x;
  }

  get targetZ(): number {
    return this.z;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pointers.clear();
    const element = this.element;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('wheel', this.onWheel);
    element.removeEventListener('dblclick', this.onDoubleClick);
    element.removeEventListener('contextmenu', this.onContextMenu);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private applyPan(dxPixels: number, dyPixels: number): void {
    if (dxPixels === 0 && dyPixels === 0) return;
    this.panView.fitHalfHeight = this.view.fitHalfHeight;
    this.panView.zoom = Math.max(ZOOM_MIN, this.zoom);
    this.panView.viewportHeight = this.view.viewportHeight;
    this.panView.azimuthDeg = this.azimuth;
    this.panView.pitchDeg = this.pitch;
    const [dx, dz] = dragToPan(dxPixels, dyPixels, this.panView);
    const [x, z] = clampTarget(this.desiredX + dx, this.desiredZ + dz, this.bounds);
    this.desiredX = x;
    this.desiredZ = z;
  }

  private beginPinch(): void {
    if (this.pointers.size < 2) return;
    const positions = [...this.pointers.values()];
    const a = positions[0];
    const b = positions[1];
    this.pinchDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.pinchMidX = (a.x + b.x) / 2;
    this.pinchMidY = (a.y + b.y) / 2;
    this.lastX = this.pinchMidX;
    this.lastY = this.pinchMidY;
  }

  private capture(pointerId: number): void {
    try {
      this.element.setPointerCapture(pointerId);
    } catch {
      /* pointer capture is best-effort (synthetic events, older browsers) */
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.element.hasPointerCapture(pointerId)) {
        this.element.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.disposed) return;
    this.capture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.dragged = false;

    if (this.pointers.size === 1) {
      const orbit =
        event.button === 1 || event.button === 2 || (event.button === 0 && event.shiftKey);
      this.mode = orbit ? 'orbit' : 'pan';
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.downX = event.clientX;
      this.downY = event.clientY;
      if (event.button === 2) event.preventDefault();
    } else if (this.pointers.size === 2) {
      this.mode = 'pinch';
      this.beginPinch();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.disposed) return;
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.mode === 'pinch') {
      if (this.pointers.size >= 2) {
        const positions = [...this.pointers.values()];
        const a = positions[0];
        const b = positions[1];
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const ratio = distance / this.pinchDistance;
        this.pinchDistance = distance;
        this.desiredZoom = clampZoom(this.desiredZoom * ratio);
        this.applyPan(midX - this.pinchMidX, midY - this.pinchMidY);
        this.pinchMidX = midX;
        this.pinchMidY = midY;
        this.dragged = true;
      }
      return;
    }

    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    if (Math.abs(event.clientX - this.downX) + Math.abs(event.clientY - this.downY) > DRAG_SLOP_PX) {
      this.dragged = true;
    }
    this.lastX = event.clientX;
    this.lastY = event.clientY;

    if (this.mode === 'orbit') {
      this.desiredAzimuth = wrapAzimuth(
        this.desiredAzimuth + dx * ORBIT_SENSITIVITY_DEG
      );
      this.desiredPitch = clampPitch(this.desiredPitch - dy * PITCH_SENSITIVITY_DEG);
    } else if (this.mode === 'pan') {
      this.applyPan(dx, dy);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.disposed) return;
    this.release(event.pointerId);
    this.pointers.delete(event.pointerId);

    if (this.pointers.size === 1) {
      const [remaining] = this.pointers.values();
      this.mode = 'pan';
      this.lastX = remaining.x;
      this.lastY = remaining.y;
      this.downX = remaining.x;
      this.downY = remaining.y;
      this.dragged = true;
      return;
    }
    if (this.pointers.size > 1) {
      this.mode = 'pinch';
      this.beginPinch();
      return;
    }

    this.mode = 'none';
    // Double-tap reset for touch devices (mouse uses dblclick).
    if (event.pointerType === 'touch' && !this.dragged && event.type === 'pointerup') {
      const now = performance.now();
      const nearLast =
        Math.hypot(event.clientX - this.lastTapX, event.clientY - this.lastTapY) < TAP_SLOP_PX;
      if (now - this.lastTapAt < TAP_TIMEOUT_MS && nearLast) {
        this.reset();
        this.lastTapAt = 0;
      } else {
        this.lastTapAt = now;
        this.lastTapX = event.clientX;
        this.lastTapY = event.clientY;
      }
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.disposed) return;
    event.preventDefault();
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1; // lines / pages / pixels
    const delta = event.deltaY * unit;
    if (!Number.isFinite(delta) || delta === 0) return;
    this.desiredZoom = clampZoom(
      this.desiredZoom * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY)
    );
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.disposed) return;
    event.preventDefault();
    this.reset();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };
}
