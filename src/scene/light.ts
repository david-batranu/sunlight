/**
 * Pure light-direction and shadow-camera math for the diorama.
 *
 * World axes (matching the wire format, after the /10 client divide):
 *   +X = east, +Y = up, -Z = north.
 *
 * Sky azimuths are degrees clockwise from true north (0 = N, 90 = E), so a
 * point of altitude `alt` and azimuth `az` sits along the unit vector
 *
 *   [ cos(alt)·sin(az),  sin(alt),  -cos(alt)·cos(az) ]
 *
 * which is the same convention the server's SkyDay track uses.
 *
 * No Three.js / DOM imports: the unit tests (and the Node toolchain) import
 * this module directly.
 */

import type { SkyDay } from '../../shared/types.ts';
import { interpolateSky } from '../app/time.ts';

export type Vec3 = [number, number, number];

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface LightSample {
  sunAlt: number;
  sunAz: number;
  moonAlt: number;
  moonAz: number;
}

/** Allocates a reusable light sample (call once, then use sampleLightInto). */
export function createLightSample(): LightSample {
  return { sunAlt: 0, sunAz: 0, moonAlt: 0, moonAz: 0 };
}

export function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Normalizes an angle in degrees into [0, 360). */
export function normalizeDegrees(angle: number): number {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Unit vector pointing *toward* the light source (sun or moon). */
export function directionFromAltAz(altitudeDeg: number, azimuthDeg: number): Vec3 {
  const alt = altitudeDeg * DEG_TO_RAD;
  const az = azimuthDeg * DEG_TO_RAD;
  const cosAlt = Math.cos(alt);
  return [cosAlt * Math.sin(az), Math.sin(alt), -cosAlt * Math.cos(az)];
}

/** Allocation-free variant of {@link directionFromAltAz}. */
export function directionFromAltAzInto(
  out: Vec3,
  altitudeDeg: number,
  azimuthDeg: number
): Vec3 {
  const alt = altitudeDeg * DEG_TO_RAD;
  const az = azimuthDeg * DEG_TO_RAD;
  const cosAlt = Math.cos(alt);
  out[0] = cosAlt * Math.sin(az);
  out[1] = Math.sin(alt);
  out[2] = -cosAlt * Math.cos(az);
  return out;
}

export function altitudeFromDirection(direction: readonly [number, number, number]): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 1e-9)) return 0;
  return Math.asin(clampNumber(direction[1] / length, -1, 1)) * RAD_TO_DEG;
}

export function azimuthFromDirection(direction: readonly [number, number, number]): number {
  const horizontal = Math.hypot(direction[0], direction[2]);
  if (horizontal < 1e-9) return 0;
  // atan2(x, -z) because +X is east and -Z is north.
  return normalizeDegrees(Math.atan2(direction[0], -direction[2]) * RAD_TO_DEG);
}

/** Shortest-arc interpolation between two azimuths in degrees. */
export function shortestArcLerp(fromDeg: number, toDeg: number, t: number): number {
  const delta = ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
  return normalizeDegrees(fromDeg + delta * clampNumber(t, 0, 1));
}

/**
 * Smooth pseudo-sky used before the first SkyDay arrives (or if a payload is
 * malformed). A simple analytic arc keeps the diorama plausible while the
 * real ephemeris is being fetched.
 */
export function fallbackSampleInto(out: LightSample, minute: number): LightSample {
  const clamped = clampNumber(minute, 0, 1440);
  const phase = ((clamped - 360) / 720) * Math.PI;
  const sunAlt = 58 * Math.sin(phase);
  const sunAz = normalizeDegrees(90 + ((clamped - 360) / 720) * 180);
  out.sunAlt = sunAlt;
  out.sunAz = sunAz;
  out.moonAlt = -sunAlt * 0.85 + 6;
  out.moonAz = normalizeDegrees(sunAz + 195);
  return out;
}

/**
 * Fills `out` with the interpolated sun/moon positions for a local minute.
 * Allocation free: the animation loop calls this every frame.
 *
 * When a real SkyDay is present the interpolation mirrors
 * `interpolateSky()` from `src/app/time.ts` (5-minute samples, shortest-arc
 * azimuth), just written into a reusable object.
 */
export function sampleLightInto(
  out: LightSample,
  sky: SkyDay | null,
  minute: number
): LightSample {
  const sunTrack = sky?.track?.sun;
  const moonTrack = sky?.track?.moon;
  if (!sky || !sunTrack || !moonTrack || sunTrack.length === 0 || moonTrack.length === 0) {
    return fallbackSampleInto(out, minute);
  }
  const step = sky.track.stepMinutes || 5;
  const maxIndex = Math.min(sunTrack.length, moonTrack.length) - 1;
  if (maxIndex < 0) return fallbackSampleInto(out, minute);
  const rawIndex = clampNumber(minute, 0, 1440) / step;
  const index = Math.min(Math.max(maxIndex - 1, 0), Math.floor(rawIndex));
  const fraction = clampNumber(rawIndex - index, 0, 1);
  const sunA = sunTrack[index];
  const sunB = sunTrack[Math.min(maxIndex, index + 1)];
  const moonA = moonTrack[index];
  const moonB = moonTrack[Math.min(maxIndex, index + 1)];
  if (!sunA || !sunB || !moonA || !moonB) return fallbackSampleInto(out, minute);

  out.sunAlt = sunA[0] + (sunB[0] - sunA[0]) * fraction;
  out.sunAz = shortestArcLerp(sunA[1], sunB[1], fraction);
  out.moonAlt = moonA[0] + (moonB[0] - moonA[0]) * fraction;
  out.moonAz = shortestArcLerp(moonA[1], moonB[1], fraction);
  return out;
}

/** Allocating convenience wrapper (tests, one-off math). */
export function sampleLight(sky: SkyDay | null, minute: number): LightSample {
  return sampleLightInto(createLightSample(), sky, minute);
}

/**
 * Interpolates the app's canonical `interpolateSky()` output into the same
 * shape; exposed so tests can prove both paths agree.
 */
export function sampleFromAppHelper(sky: SkyDay | null, minute: number): LightSample | null {
  const helper = interpolateSky(sky, minute);
  if (!helper) return null;
  return {
    sunAlt: helper.sunAlt,
    sunAz: helper.sunAz,
    moonAlt: helper.moonAlt,
    moonAz: helper.moonAz
  };
}

export interface ShadowConfig {
  /** Half-size of the square orthographic shadow camera, in metres. */
  halfSize: number;
  near: number;
  far: number;
  /** Distance of the directional light from the model centre, in metres. */
  distance: number;
  bias: number;
  normalBias: number;
}

/**
 * Adaptive shadow-camera sizing.
 *
 * A directional shadow tilt of `alt` makes casters of height H sweep across
 * `H / tan(alt)` of ground, but all receivers stay inside the plinth. The
 * orthographic shadow camera therefore has to include the plinth half-span
 * plus the projected height of casters perpendicular to the light direction
 * (`H · cos(alt)`), which is largest at sunrise/sunset. This keeps shadow
 * texels square at every sun elevation instead of clipping long dawn shadows.
 */
export function shadowConfig(
  altitudeDeg: number,
  halfSpanM: number,
  maxHeightM: number
): ShadowConfig {
  const alt = clampNumber(altitudeDeg, 0, 90);
  const cosAlt = Math.cos(alt * DEG_TO_RAD);
  const halfSize =
    Math.max(halfSpanM, 1) * 1.045 + Math.max(maxHeightM, 0) * Math.max(0.08, cosAlt) * 1.7 + 14;
  const depthSlack = halfSize * 2.2 + Math.max(maxHeightM, 0) * 2 + 120;
  const distance = halfSize * 3.2 + Math.max(maxHeightM, 0) * 2 + 500;
  return {
    halfSize,
    near: Math.max(10, distance - depthSlack),
    far: distance + depthSlack,
    distance,
    bias: -0.00045,
    normalBias: 0.85
  };
}

export interface PanView {
  /** Half of the visible world height at zoom 1, in metres. */
  fitHalfHeight: number;
  zoom: number;
  /** Canvas height in CSS pixels. */
  viewportHeight: number;
  azimuthDeg: number;
  pitchDeg: number;
}

/**
 * Converts a screen-space drag (pixels, down-positive Y) into a world-space
 * ground-plane translation of the camera target.
 *
 * Derivation for an orthographic camera whose screen-right on the ground
 * plane is `R = (-cos az, 0, -sin az)` and screen-up projected onto the ground
 * is `-h` with `h = (sin az, 0, -cos az)` (the horizontal direction from the
 * target toward the camera):
 *
 *   T = dx·s·E - dy·(s / sin pitch)·h,  E = (cos az, 0, sin az)
 *   s = 2·fitHalfHeight / (zoom · viewportHeight)
 *
 * The result is clamped by the caller to the model extents.
 */
export function panDeltaFromDrag(
  dxPixels: number,
  dyPixels: number,
  view: PanView
): [number, number] {
  const s = (2 * view.fitHalfHeight) / (view.zoom * Math.max(1, view.viewportHeight));
  const az = view.azimuthDeg * DEG_TO_RAD;
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const pitch = clampNumber(view.pitchDeg, 5, 89) * DEG_TO_RAD;
  const verticalScale = s / Math.max(0.12, Math.sin(pitch));
  return [
    dxPixels * s * cosAz - dyPixels * verticalScale * sinAz,
    dxPixels * s * sinAz + dyPixels * verticalScale * cosAz
  ];
}
