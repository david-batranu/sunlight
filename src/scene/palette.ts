/**
 * Sky-driven lighting palette for the diorama.
 *
 * Everything here is pure math over altitude/azimuth samples from a SkyDay:
 * the scene asks for a {@link LightState} roughly once per frame and applies
 * colors/intensities to the Three.js lights. Keeping the curves here makes
 * them unit-testable and keeps the renderer free of magic numbers.
 *
 * Design intent: a warm collector's-diorama look. Daylight is warm ivory,
 * golden hour leans orange, moonlit nights are cool blue and never pitch
 * black (the CSS backdrop behind the transparent canvas does the heavy
 * lifting for the sky itself).
 */

import {
  clampNumber,
  directionFromAltAzInto,
  normalizeDegrees,
  type LightSample,
  type Vec3
} from './light.ts';

/** Sun must be at least this high before it casts shadows. */
export const SUN_SHADOW_MIN_ALTITUDE = 0.5;
/** Moon only casts shadows once the sun is well below the horizon. */
export const MOON_SHADOW_MAX_SUN_ALTITUDE = -2;
export const MOON_SHADOW_MIN_MOON_ALTITUDE = 5;
export const MOON_SHADOW_MIN_ILLUMINATION = 0.15;

export type LightKind = 'sun' | 'moon' | 'none';

export interface DirectionalLightState {
  direction: Vec3;
  altitudeDeg: number;
  azimuthDeg: number;
  /** 0xRRGGBB, authored in sRGB. */
  color: number;
  intensity: number;
  castShadow: boolean;
}

export interface AmbientState {
  /** 0xRRGGBB hemisphere sky color. */
  skyColor: number;
  /** 0xRRGGBB hemisphere ground-bounce color. */
  groundColor: number;
  intensity: number;
}

export interface LightState {
  sun: DirectionalLightState;
  moon: DirectionalLightState;
  /** Preallocated placeholder used when neither sun nor moon is active. */
  none: DirectionalLightState;
  ambient: AmbientState;
  /** ACES tone-mapping exposure multiplier. */
  exposure: number;
  kind: LightKind;
  /** Reference to the dominant light (`sun`, `moon` or `none`). */
  active: DirectionalLightState;
}

interface NumericStop {
  at: number;
  value: number;
}

interface ColorStop {
  at: number;
  color: number;
}

function sampleNumeric(stops: readonly NumericStop[], key: number): number {
  if (key <= stops[0].at) return stops[0].value;
  const last = stops[stops.length - 1];
  if (key >= last.at) return last.value;
  for (let i = 1; i < stops.length; i += 1) {
    const hi = stops[i];
    if (key <= hi.at) {
      const lo = stops[i - 1];
      const t = (key - lo.at) / (hi.at - lo.at);
      return lo.value + (hi.value - lo.value) * t;
    }
  }
  return last.value;
}

function mixHex(a: number, b: number, t: number): number {
  const k = clampNumber(t, 0, 1);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

function sampleColor(stops: readonly ColorStop[], key: number): number {
  if (key <= stops[0].at) return stops[0].color;
  const last = stops[stops.length - 1];
  if (key >= last.at) return last.color;
  for (let i = 1; i < stops.length; i += 1) {
    const hi = stops[i];
    if (key <= hi.at) {
      const lo = stops[i - 1];
      return mixHex(lo.color, hi.color, (key - lo.at) / (hi.at - lo.at));
    }
  }
  return last.color;
}

/* ------------------------------------------------------------------ */
/* Sun                                                                 */
/* ------------------------------------------------------------------ */

const SUN_INTENSITY: readonly NumericStop[] = [
  { at: -8, value: 0 },
  { at: -2, value: 0.03 },
  { at: 0, value: 1.8 },
  { at: 2, value: 3.6 },
  { at: 4, value: 4.2 },
  { at: 8, value: 3.8 },
  { at: 14, value: 3.3 },
  { at: 20, value: 3.2 },
  { at: 35, value: 3.3 },
  { at: 60, value: 3.55 },
  { at: 90, value: 3.6 }
];

const SUN_COLOR: readonly ColorStop[] = [
  { at: -6, color: 0xff6a24 },
  { at: -2, color: 0xff8a3c },
  { at: 0, color: 0xffa457 },
  { at: 3, color: 0xffb770 },
  { at: 6, color: 0xffc98a },
  { at: 12, color: 0xffdcae },
  { at: 20, color: 0xffe8c6 },
  { at: 35, color: 0xfff0d8 },
  { at: 65, color: 0xfff5e6 }
];

export function sunIntensityFor(altitudeDeg: number): number {
  return Math.max(0, sampleNumeric(SUN_INTENSITY, altitudeDeg));
}

export function sunColorFor(altitudeDeg: number): number {
  return sampleColor(SUN_COLOR, altitudeDeg);
}

/* ------------------------------------------------------------------ */
/* Moon                                                                */
/* ------------------------------------------------------------------ */

const MOON_COLOR: readonly ColorStop[] = [
  { at: -4, color: 0x93a4bf },
  { at: 2, color: 0xb6c7e0 },
  { at: 15, color: 0xc6d6ee },
  { at: 45, color: 0xd2e0f5 },
  { at: 90, color: 0xd8e5f8 }
];

export function moonColorFor(altitudeDeg: number, illumination: number): number {
  const lit = clampNumber(illumination, 0, 1);
  const color = sampleColor(MOON_COLOR, altitudeDeg);
  // Dim redder/moon-dust tint for a thin crescent, cool white for a full moon.
  return mixHex(color, 0x9fb2cf, (1 - lit) * 0.3);
}

/**
 * Cool moonlight intensity. Zero below the horizon, phase-scaled by the
 * illuminated fraction and suppressed while the sun is still up.
 */
export function moonIntensityFor(
  moonAltitudeDeg: number,
  illumination: number,
  sunAltitudeDeg: number
): number {
  const visibility = smoothstepLocal(-1.5, 7, moonAltitudeDeg);
  const night = 1 - smoothstepLocal(-3, 2.5, sunAltitudeDeg);
  const phase = 0.55 + 1.35 * clampNumber(illumination, 0, 1);
  return clampNumber(visibility * night * phase, 0, 1.9);
}

function smoothstepLocal(edge0: number, edge1: number, value: number): number {
  const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function moonCanCastShadow(
  moonAltitudeDeg: number,
  illumination: number,
  sunAltitudeDeg: number
): boolean {
  return (
    sunAltitudeDeg < MOON_SHADOW_MAX_SUN_ALTITUDE &&
    moonAltitudeDeg > MOON_SHADOW_MIN_MOON_ALTITUDE &&
    illumination > MOON_SHADOW_MIN_ILLUMINATION
  );
}

/* ------------------------------------------------------------------ */
/* Ambient + exposure                                                  */
/* ------------------------------------------------------------------ */

const AMBIENT_SKY: readonly ColorStop[] = [
  { at: -18, color: 0x59709a },
  { at: -12, color: 0x647aa2 },
  { at: -6, color: 0x8f8199 },
  { at: 0, color: 0xe6bd9c },
  { at: 6, color: 0xdcc9b6 },
  { at: 20, color: 0xcfe0ea },
  { at: 45, color: 0xd7e7f2 }
];

const AMBIENT_GROUND: readonly ColorStop[] = [
  { at: -18, color: 0x333949 },
  { at: -12, color: 0x3b4254 },
  { at: -6, color: 0x4f4849 },
  { at: 0, color: 0x7a654f },
  { at: 6, color: 0x867254 },
  { at: 20, color: 0x8a7354 },
  { at: 45, color: 0x907a58 }
];

const AMBIENT_INTENSITY: readonly NumericStop[] = [
  { at: -18, value: 1.02 },
  { at: -12, value: 1.08 },
  { at: -6, value: 1.02 },
  { at: 0, value: 0.98 },
  { at: 6, value: 1.12 },
  { at: 20, value: 1.32 },
  { at: 45, value: 1.42 }
];

const EXPOSURE: readonly NumericStop[] = [
  { at: -18, value: 1.62 },
  { at: -12, value: 1.58 },
  { at: -6, value: 1.46 },
  { at: 0, value: 1.38 },
  { at: 6, value: 1.3 },
  { at: 15, value: 1.12 },
  { at: 40, value: 1.0 }
];

export function ambientColorFor(sunAltitudeDeg: number): {
  skyColor: number;
  groundColor: number;
} {
  return {
    skyColor: sampleColor(AMBIENT_SKY, sunAltitudeDeg),
    groundColor: sampleColor(AMBIENT_GROUND, sunAltitudeDeg)
  };
}

export function ambientIntensityFor(sunAltitudeDeg: number): number {
  return sampleNumeric(AMBIENT_INTENSITY, sunAltitudeDeg);
}

export function exposureFor(sunAltitudeDeg: number): number {
  return sampleNumeric(EXPOSURE, sunAltitudeDeg);
}

/* ------------------------------------------------------------------ */
/* State assembly                                                      */
/* ------------------------------------------------------------------ */

function createDirectionalLightState(): DirectionalLightState {
  return {
    direction: [0, 1, 0],
    altitudeDeg: 0,
    azimuthDeg: 0,
    color: 0xffffff,
    intensity: 0,
    castShadow: false
  };
}

export function createLightState(): LightState {
  const sun = createDirectionalLightState();
  const moon = createDirectionalLightState();
  const none = createDirectionalLightState();
  return {
    sun,
    moon,
    none,
    ambient: { skyColor: 0xffffff, groundColor: 0x888888, intensity: 1 },
    exposure: 1,
    kind: 'none',
    active: none
  };
}

/**
 * Fills a reusable {@link LightState} from a sampled sky.
 * Allocation free so the per-frame playback path stays GC-clean.
 */
export function updateLightState(
  state: LightState,
  sample: LightSample,
  moonIllumination: number
): LightState {
  const illumination = clampNumber(moonIllumination, 0, 1);

  // --- Sun ---------------------------------------------------------
  const sun = state.sun;
  directionFromAltAzInto(sun.direction, sample.sunAlt, sample.sunAz);
  sun.altitudeDeg = sample.sunAlt;
  sun.azimuthDeg = normalizeDegrees(sample.sunAz);
  sun.color = sunColorFor(sample.sunAlt);
  sun.intensity = sunIntensityFor(sample.sunAlt);
  sun.castShadow = sample.sunAlt > SUN_SHADOW_MIN_ALTITUDE;

  // --- Moon --------------------------------------------------------
  const moon = state.moon;
  directionFromAltAzInto(moon.direction, sample.moonAlt, sample.moonAz);
  moon.altitudeDeg = sample.moonAlt;
  moon.azimuthDeg = normalizeDegrees(sample.moonAz);
  moon.color = moonColorFor(sample.moonAlt, illumination);
  moon.intensity = moonIntensityFor(sample.moonAlt, illumination, sample.sunAlt);
  moon.castShadow =
    !sun.castShadow && moonCanCastShadow(sample.moonAlt, illumination, sample.sunAlt);

  // --- Ambient + exposure -----------------------------------------
  const skyColor = sampleColor(AMBIENT_SKY, sample.sunAlt);
  const groundColor = sampleColor(AMBIENT_GROUND, sample.sunAlt);
  state.ambient.skyColor = skyColor;
  state.ambient.groundColor = groundColor;
  state.ambient.intensity = ambientIntensityFor(sample.sunAlt);
  state.exposure = exposureFor(sample.sunAlt);

  // --- Dominant light ----------------------------------------------
  const none = state.none;
  none.direction[0] = sun.direction[0];
  none.direction[1] = sun.direction[1];
  none.direction[2] = sun.direction[2];
  none.altitudeDeg = sun.altitudeDeg;
  none.azimuthDeg = sun.azimuthDeg;
  none.color = sun.color;
  none.intensity = 0;
  none.castShadow = false;

  if (sun.intensity >= 0.05) {
    state.kind = 'sun';
    state.active = sun;
  } else if (moon.intensity >= 0.03) {
    state.kind = 'moon';
    state.active = moon;
  } else {
    state.kind = 'none';
    state.active = none;
  }
  return state;
}

/** Allocating convenience wrapper for tests and one-off callers. */
export function computeLighting(sample: LightSample, moonIllumination: number): LightState {
  return updateLightState(createLightState(), sample, moonIllumination);
}
