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

/** Default isometric azimuth (degrees clockwise from north). */
export const DEFAULT_AZIMUTH_DEG = 45;
/** Classic isometric elevation: atan(1/√2) radians. */
export const DEFAULT_PITCH_DEG = 35.264389682754654;
export const PITCH_MIN_DEG = 18;
export const PITCH_MAX_DEG = 72;
export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 3.2;
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
 * Fitting against the default orientation (rather than the current one) keeps
 * the zoom level stable while orbiting: the 45° diagonal is the widest the
 * square base ever projects to, so a fit computed there also fits at 0°/90°.
 */
export function fitHalfHeight(
  box: FitBox,
  aspect: number,
  azimuthDeg = DEFAULT_AZIMUTH_DEG,
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
