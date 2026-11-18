/**
 * Orthographic diorama camera math: isometric defaults, model-fit frustum,
 * pan clamping and screen-drag → ground-plane pan conversion.
 *
 * Pure module (no Three.js / DOM) so the numbers can be unit tested. The
 * scene owns the actual THREE.OrthographicCamera and applies these results.
 */

import type { ModelExtents } from './model.ts';
import { panDeltaFromDrag, type PanView } from './light.ts';

const DEG_TO_RAD = Math.PI / 180;

/** Default isometric azimuth (degrees clockwise from north): camera in the
 *  south-east, so world north-west points straight up on screen. */
export const DEFAULT_AZIMUTH_DEG = 135;
/**
 * Azimuth used when computing a conservative camera fit. A square base
 * projects widest at the 45° diagonal, so fitting there also covers the 180°
 * north-up default and any orbit angle.
 */
export const FIT_AZIMUTH_DEG = 45;
/** Classic isometric elevation: atan(1/√2) radians. */
export const DEFAULT_PITCH_DEG = 35.264389682754654;
export const PITCH_MIN_DEG = 18;
export const PITCH_MAX_DEG = 72;
export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 32;
export const DEFAULT_ZOOM = 1;
/** Margin around the projected model so nothing touches the viewport edge. */
export const FIT_PADDING = 1.1;
/** Camera distance for the orthographic rig (depth only; does not zoom). */
export const CAMERA_DISTANCE_M = 4200;

export interface CameraPose {
  azimuthDeg: number;
  pitchDeg: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export interface FrustumRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FitBox {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  minY: number;
  maxY: number;
}

export function clampPitch(pitchDeg: number): number {
  return pitchDeg < PITCH_MIN_DEG ? PITCH_MIN_DEG : pitchDeg > PITCH_MAX_DEG ? PITCH_MAX_DEG : pitchDeg;
}

export function clampZoom(zoom: number): number {
  return zoom < ZOOM_MIN ? ZOOM_MIN : zoom > ZOOM_MAX ? ZOOM_MAX : zoom;
}

/** Wraps an azimuth into [0, 360). */
export function wrapAzimuth(azimuthDeg: number): number {
  const wrapped = azimuthDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function defaultPose(centerX: number, targetY: number, centerZ: number): CameraPose {
  return {
    azimuthDeg: DEFAULT_AZIMUTH_DEG,
    pitchDeg: DEFAULT_PITCH_DEG,
    zoom: DEFAULT_ZOOM,
    targetX: centerX,
    targetY,
    targetZ: centerZ
  };
}

/**
 * World position of the orthographic camera for a pose. The camera looks at
 * the target, so `azimuth` is the direction *from the target toward the
 * camera* measured clockwise from north.
 */
export function cameraPosition(
  targetX: number,
  targetY: number,
  targetZ: number,
  azimuthDeg: number,
  pitchDeg: number,
  distance = CAMERA_DISTANCE_M
): [number, number, number] {
  const az = azimuthDeg * DEG_TO_RAD;
  const pitch = pitchDeg * DEG_TO_RAD;
  const horizontal = Math.cos(pitch) * distance;
  return [
    targetX + Math.sin(az) * horizontal,
    targetY + Math.sin(pitch) * distance,
    targetZ - Math.cos(az) * horizontal
  ];
}

/** Screen-right direction on the ground plane (unit, XZ). */
export function screenRightOnGround(azimuthDeg: number): [number, number] {
  const az = azimuthDeg * DEG_TO_RAD;
  return [-Math.cos(az), -Math.sin(az)];
}

/** Screen-up projected onto the ground plane (unit, XZ). */
export function screenUpOnGround(azimuthDeg: number): [number, number] {
  const az = azimuthDeg * DEG_TO_RAD;
  return [Math.sin(az), -Math.cos(az)];
}

export function orthoFrustum(halfHeight: number, aspect: number): FrustumRect {
  const width = halfHeight * Math.max(0.05, aspect);
  return { left: -width, right: width, top: halfHeight, bottom: -halfHeight };
}

/**
 * Half-height (in world metres) of the orthographic view needed to fit the
 * model with the default isometric orientation.
 *
 * Fitting against the widest 45° diagonal (rather than the current or default
 * orientation) keeps the zoom level stable while orbiting and guarantees the
 * 180° north-up pose and every orbit angle stay inside the frustum.
 */
export function fitHalfHeight(
  box: FitBox,
  aspect: number,
  azimuthDeg = FIT_AZIMUTH_DEG,
  pitchDeg = DEFAULT_PITCH_DEG,
  padding = FIT_PADDING
): number {
  const az = azimuthDeg * DEG_TO_RAD;
  const pitch = pitchDeg * DEG_TO_RAD;
  const rightX = -Math.cos(az);
  const rightZ = -Math.sin(az);
  const upX = -Math.sin(az) * Math.sin(pitch);
  const upY = Math.cos(pitch);
  const upZ = Math.cos(az) * Math.sin(pitch);

  let halfWidth = 0;
  let halfHeightWorld = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sy of [0, 1]) {
        const x = box.halfX * sx;
        const z = box.halfZ * sz;
        const y = sy === 0 ? box.minY : box.maxY;
        const screenX = x * rightX + z * rightZ;
        const screenY = x * upX + y * upY + z * upZ;
        if (Math.abs(screenX) > halfWidth) halfWidth = Math.abs(screenX);
        if (Math.abs(screenY) > halfHeightWorld) halfHeightWorld = Math.abs(screenY);
      }
    }
  }
  const needed = Math.max(halfHeightWorld, halfWidth / Math.max(0.05, aspect));
  return Math.max(80, needed * padding);
}

/** Builds the fit box (world metres) for a model's extents + plinth. */
export function fitBoxFor(extents: ModelExtents, outerHalfX: number, outerHalfZ: number, bottomY: number): FitBox {
  return {
    centerX: extents.centerX,
    centerZ: extents.centerZ,
    halfX: outerHalfX,
    halfZ: outerHalfZ,
    minY: bottomY,
    maxY: extents.maxY
  };
}

/** Camera target Y that vertically centres the diorama in the fitted view. */
export function fitTargetY(extents: ModelExtents, bottomY: number): number {
  return (extents.maxY + bottomY) * 0.5;
}

/* ------------------------------------------------------------------ */
/* Detail-window focus                                                  */
/* ------------------------------------------------------------------ */

/**
 * Breathing room around a focused detail window: the view is
 * `DETAIL_CONTEXT_FACTOR ×` the window's diameter tall. A small margin keeps
 * the selection from touching the edges without turning the surrounding city
 * into the subject of the shot.
 */
export const DETAIL_CONTEXT_FACTOR = 1.06;
/**
 * A focused view is capped at this fraction of the model diameter. It prevents
 * "Focus" on a huge window from pulling the camera out to empty space.
 */
export const DETAIL_MODEL_HEIGHT_FRACTION = 1;

/**
 * Zoom that frames a detail window with context.
 *
 * `fitHalfHeightWorld` is the world half-height of the fitted view at zoom 1
 * (see {@link fitHalfHeight}), so the fitted model view is `2×` that tall.
 *
 * The target view height is the smaller of the window's diameter × context
 * factor and {@link DETAIL_MODEL_HEIGHT_FRACTION} of the model diameter. The
 * result is always at least zoom 1 — focusing a window that is already visible
 * in (or larger than) the model-fit view must never zoom *out* and expose the
 * empty space around the diorama. Within that bound, the zoom changes with the
 * selected window size: small windows fill the viewport like a close-up, large
 * windows show the whole city.
 */
export function detailFocusZoom(
  fitHalfHeightWorld: number,
  modelRadiusM: number,
  windowRadiusM: number
): number {
  const fittedHeight = fitHalfHeightWorld > 0 && Number.isFinite(fitHalfHeightWorld)
    ? fitHalfHeightWorld * 2
    : 0;
  if (!(fittedHeight > 0)) return DEFAULT_ZOOM;
  const windowHeight =
    (Number.isFinite(windowRadiusM) ? Math.max(0, windowRadiusM) : 0) * 2 * DETAIL_CONTEXT_FACTOR;
  const modelHeight =
    (Number.isFinite(modelRadiusM) ? Math.max(1, modelRadiusM) : 1) *
    2 *
    DETAIL_MODEL_HEIGHT_FRACTION;
  const desiredHeight = Math.min(windowHeight, modelHeight);
  if (!(desiredHeight > 0)) return ZOOM_MAX;
  return Math.max(DEFAULT_ZOOM, Math.min(ZOOM_MAX, fittedHeight / desiredHeight));
}

export interface PanBounds {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
}

export function clampTarget(
  x: number,
  z: number,
  bounds: PanBounds
): [number, number] {
  const limitX = Math.max(bounds.halfX, 1);
  const limitZ = Math.max(bounds.halfZ, 1);
  return [
    Math.max(bounds.centerX - limitX, Math.min(bounds.centerX + limitX, x)),
    Math.max(bounds.centerZ - limitZ, Math.min(bounds.centerZ + limitZ, z))
  ];
}

/**
 * Converts a screen-space drag into a ground-plane camera-target translation.
 * Thin wrapper over {@link panDeltaFromDrag} so callers keep the camera math
 * in one place.
 */
export function dragToPan(
  dxPixels: number,
  dyPixels: number,
  view: PanView
): [number, number] {
  return panDeltaFromDrag(dxPixels, dyPixels, view);
}

/** Smoothing factor for exponential damping: 1 - e^(-k·dt). */
export function dampingAlpha(k: number, dt: number): number {
  if (dt <= 0) return 1;
  return 1 - Math.exp(-k * Math.min(dt, 0.25));
}

/* ------------------------------------------------------------------ */
/* Pointer → NDC and ground-plane picking                              */
/* ------------------------------------------------------------------ */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Converts a client-space pointer position into normalised device coordinates
 * for the canvas rect. Returns null for degenerate rects.
 */
export function ndcFromClient(
  clientX: number,
  clientY: number,
  rect: ViewportRect
): [number, number] | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    return null;
  }
  return [
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  ];
}

/**
 * Intersects a ray with the diorama ground plane (y = 0, the plinth top).
 * Returns model-space metres, or null when the ray is parallel to the ground
 * or points away from it.
 */
export function groundPointFromRay(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number]
): { x: number; z: number } | null {
  const dy = direction[1];
  if (!Number.isFinite(dy) || Math.abs(dy) < 1e-9) return null;
  const t = -origin[1] / dy;
  if (!Number.isFinite(t) || t < 0) return null;
  const x = origin[0] + direction[0] * t;
  const z = origin[2] + direction[2] * t;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}
