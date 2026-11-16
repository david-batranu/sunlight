/**
 * Unit tests for the diorama's pure light/palette math.
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { SkyDay } from '../../shared/types.ts';
import {
  altitudeFromDirection,
  azimuthFromDirection,
  directionFromAltAz,
  fallbackSampleInto,
  panDeltaFromDrag,
  sampleFromAppHelper,
  sampleLight,
  sampleLightInto,
  shadowConfig,
  shortestArcLerp,
  createLightSample
} from '../../src/scene/light.ts';
import {
  computeLighting,
  createLightState,
  moonCanCastShadow,
  moonIntensityFor,
  sunColorFor,
  sunIntensityFor,
  updateLightState,
  MOON_SHADOW_MAX_SUN_ALTITUDE,
  SUN_SHADOW_MIN_ALTITUDE
} from '../../src/scene/palette.ts';
import { hexToRgb } from '../../src/scene/color.ts';

const sky = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/sky-brasov-2026-06-21.json', import.meta.url)), 'utf8')
) as SkyDay;

const EPS = 1e-6;

function close(actual: number, expected: number, tolerance = 1e-6, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (tol ${tolerance})`
  );
}

function unitLength(dir: readonly [number, number, number]): number {
  return Math.hypot(dir[0], dir[1], dir[2]);
}

/* ------------------------------------------------------------------ */
/* Direction math                                                      */
/* ------------------------------------------------------------------ */

test('directionFromAltAz maps the compass convention onto three.js axes', () => {
  const north = directionFromAltAz(0, 0);
  close(north[0], 0);
  close(north[1], 0);
  assert.ok(north[2] < -0.999, 'azimuth 0 must point toward -Z (north)');

  const east = directionFromAltAz(0, 90);
  assert.ok(east[0] > 0.999, 'azimuth 90 must point toward +X (east)');
  close(east[2], 0, 1e-9);

  const south = directionFromAltAz(0, 180);
  assert.ok(south[2] > 0.999, 'azimuth 180 must point toward +Z (south)');

  const west = directionFromAltAz(0, 270);
  assert.ok(west[0] < -0.999, 'azimuth 270 must point toward -X (west)');

  const zenith = directionFromAltAz(90, 123);
  assert.ok(zenith[1] > 0.999, 'altitude 90 must point up +Y');

  for (const [alt, az] of [
    [45, 37],
    [-12, 300],
    [0.5, 0],
    [80, 359]
  ]) {
    close(unitLength(directionFromAltAz(alt, az)), 1, 1e-9, `unit length at ${alt}/${az}`);
  }
});

test('altitude/azimuth round-trip through the direction vector', () => {
  for (const [alt, az] of [
    [62.6, 137.44],
    [0, 0],
    [-4.5, 359.5],
    [35, 270]
  ]) {
    const dir = directionFromAltAz(alt, az);
    close(altitudeFromDirection(dir), alt, 1e-9, 'altitude');
    close(azimuthFromDirection(dir), az % 360, 1e-9, 'azimuth');
  }
});

test('shortestArcLerp crosses north without taking the long way round', () => {
  close(shortestArcLerp(350, 10, 0.5), 0, 1e-9);
  close(shortestArcLerp(10, 350, 0.5), 0, 1e-9);
  close(shortestArcLerp(350, 10, 0), 350, 1e-9);
  close(shortestArcLerp(350, 10, 1), 10, 1e-9);
  close(shortestArcLerp(0, 90, 0.5), 45, 1e-9);
  // Half a degree-ish: shortest arc from 359 to 1 is 2 degrees clockwise.
  close(shortestArcLerp(359, 1, 0.25), 359.5, 1e-9);
});

/* ------------------------------------------------------------------ */
/* Sky sampling                                                        */
/* ------------------------------------------------------------------ */

test('sampleLightInto reproduces the fixture track at a sample boundary', () => {
  // minute 720 = sample index 144 of the 5-minute track.
  const sample = sampleLight(sky, 720);
  const expected = sky.track.sun[144];
  close(sample.sunAlt, expected[0], 1e-6, 'sun altitude');
  close(sample.sunAz, expected[1], 1e-6, 'sun azimuth');
  const moon = sky.track.moon[144];
  close(sample.moonAlt, moon[0], 1e-6, 'moon altitude');
  close(sample.moonAz, moon[1], 1e-6, 'moon azimuth');
});

test('sampleLightInto matches the app interpolateSky helper between samples', () => {
  for (const minute of [0, 82.5, 431.25, 900, 1200, 1440]) {
    const fast = sampleLight(sky, minute);
    const app = sampleFromAppHelper(sky, minute);
    assert.ok(app, 'app helper should interpolate');
    close(fast.sunAlt, app.sunAlt, 1e-9, `sun alt @${minute}`);
    close(fast.sunAz, app.sunAz, 1e-9, `sun az @${minute}`);
    close(fast.moonAlt, app.moonAlt, 1e-9, `moon alt @${minute}`);
    close(fast.moonAz, app.moonAz, 1e-9, `moon az @${minute}`);
  }
});

test('azimuth interpolation takes the short arc across 360/0 (dawn fixture)', () => {
  // Fixture sun azimuth jumps 358.95 -> 0.18 between samples 15 and 16.
  const sample = sampleLight(sky, 15 * 5 + 2.5);
  assert.ok(
    sample.sunAz > 355 || sample.sunAz < 5,
    `azimuth should stay near north, got ${sample.sunAz}`
  );
  assert.ok(Math.abs(sample.sunAz - 359.565) < 0.05, `expected ~359.565, got ${sample.sunAz}`);
});

test('fallback sky is finite and daytime at noon', () => {
  const out = createLightSample();
  fallbackSampleInto(out, 720);
  assert.ok(out.sunAlt > 40, `fallback noon altitude ${out.sunAlt}`);
  assert.ok(out.moonAlt < 0, 'fallback moon should be below horizon at noon');
  fallbackSampleInto(out, 0);
  assert.ok(out.sunAlt < 0, 'fallback midnight sun should be below horizon');
  assert.ok(out.moonAlt > 0, 'fallback midnight moon should be above horizon');
  for (const key of ['sunAlt', 'sunAz', 'moonAlt', 'moonAz'] as const) {
    assert.ok(Number.isFinite(out[key]), `${key} finite`);
  }

  const sample = sampleLightInto(createLightSample(), null, 720);
  assert.ok(sample.sunAlt > 40);
});

/* ------------------------------------------------------------------ */
/* Shadow camera math                                                  */
/* ------------------------------------------------------------------ */

test('shadowConfig grows with low sun and covers the model', () => {
  const high = shadowConfig(70, 1000, 70);
  const low = shadowConfig(2, 1000, 70);
  assert.ok(low.halfSize > high.halfSize, 'low sun needs a larger shadow camera');
  assert.ok(high.halfSize >= 1000 * 1.0, 'shadow camera must cover the plinth');
  for (const config of [high, low]) {
    assert.ok(config.near > 0, 'near plane positive');
    assert.ok(config.near < config.distance && config.distance < config.far, 'depth ordering');
    assert.ok(config.distance > config.halfSize, 'light outside the model');
    assert.ok(config.normalBias > 0);
  }
});

test('shadowConfig clamps below-horizon input and never returns non-finite values', () => {
  const below = shadowConfig(-30, 900, 50);
  const above = shadowConfig(90, 900, 50);
  assert.ok(Number.isFinite(below.halfSize) && Number.isFinite(below.far));
  assert.ok(below.halfSize >= above.halfSize);
});

/* ------------------------------------------------------------------ */
/* Pan math                                                            */
/* ------------------------------------------------------------------ */

test('panDeltaFromDrag matches the ground-plane geometry', () => {
  const view = {
    fitHalfHeight: 900,
    zoom: 1,
    viewportHeight: 900,
    azimuthDeg: 0,
    pitchDeg: 35.264
  };
  const s = (2 * 900) / (1 * 900); // 2 metres per pixel

  const right = panDeltaFromDrag(10, 0, view);
  close(right[0], 10 * s * Math.cos(0), 1e-9, 'drag right moves target east');
  close(right[1], 0, 1e-9, 'no Z component for horizontal drag at az 0');

  const down = panDeltaFromDrag(0, 10, view);
  close(down[0], 0, 1e-9);
  close(down[1], (10 * s) / Math.sin((35.264 * Math.PI) / 180), 1e-9, 'drag down moves target south');

  // General invariants: horizontal drag is perpendicular to the camera
  // horizontal direction, vertical drag is parallel to it.
  for (const az of [0, 45, 120, 300]) {
    const v = { ...view, azimuthDeg: az };
    const azRad = (az * Math.PI) / 180;
    const h = [Math.sin(azRad), -Math.cos(azRad)];
    const dx = panDeltaFromDrag(7, 0, v);
    close(dx[0] * h[0] + dx[1] * h[1], 0, 1e-9, `horizontal drag ⟂ h @${az}`);
    const dy = panDeltaFromDrag(0, 7, v);
    const parallel = dy[0] * h[0] + dy[1] * h[1];
    assert.ok(parallel < 0, 'dragging down moves the target toward the camera side');
  }
});

/* ------------------------------------------------------------------ */
/* Palette curves                                                      */
/* ------------------------------------------------------------------ */

test('sun intensity stays strong through golden hour and is zero at night', () => {
  // Stylised curve: the sun is deliberately kept bright while it is above the
  // horizon so the diorama reads as warmly lit with visible long shadows.
  for (let alt = -20; alt <= 90; alt += 1) {
    assert.ok(sunIntensityFor(alt) >= 0, `non-negative at ${alt}`);
  }
  close(sunIntensityFor(-10), 0, 1e-9);
  // Above the golden peak the curve stays on a stable day plateau (the small
  // artistic down-step keeps 4-20° bright without clipping the noon look).
  for (let alt = 14; alt <= 90; alt += 1) {
    const intensity = sunIntensityFor(alt);
    assert.ok(intensity >= 3.0 && intensity <= 3.7, `day plateau at ${alt}: ${intensity}`);
  }
  assert.ok(sunIntensityFor(3.1) > 3, `golden hour direct sun ${sunIntensityFor(3.1)}`);
  assert.ok(sunIntensityFor(0) > 1.5, 'sunrise still lights the walls');
  assert.ok(sunIntensityFor(45) > 3, 'daylight sun is strong');
  close(sunIntensityFor(90), 3.6, 1e-9, 'noon endpoint unchanged');
});

test('golden-hour lighting is bright and shadowed (lead visual fix)', () => {
  const state = computeLighting({ sunAlt: 3.1, sunAz: 290, moonAlt: -25, moonAz: 40 }, 0.4);
  assert.equal(state.kind, 'sun');
  assert.equal(state.sun.castShadow, true);
  assert.equal(state.moon.castShadow, false);
  assert.ok(state.sun.intensity > 3, `golden direct intensity ${state.sun.intensity}`);
  assert.ok(state.exposure > 1.3, `golden exposure ${state.exposure}`);
  assert.ok(
    state.sun.intensity + state.ambient.intensity > 4,
    'combined direct + ambient must lift the whole diorama'
  );
  const color = hexToRgb(state.sun.color);
  assert.ok(color[0] > 0.9 && color[1] > 0.5, 'golden light is warm but luminous');
});

test('moonlit night is readable, cool and still casts a shadow (lead visual fix)', () => {
  // Exact scenario from the lead's headless screenshots: sun -16°,
  // moon 15.2° / 45% illuminated.
  const state = computeLighting(
    { sunAlt: -16, sunAz: 20, moonAlt: 15.2, moonAz: 250 },
    0.4465
  );
  assert.equal(state.kind, 'moon');
  assert.equal(state.active, state.moon);
  assert.equal(state.moon.castShadow, true);
  assert.equal(state.sun.castShadow, false);
  assert.ok(state.moon.intensity > 1.0, `night moon intensity ${state.moon.intensity}`);
  assert.ok(state.ambient.intensity > 1.0, `night ambient ${state.ambient.intensity}`);
  assert.ok(state.exposure > 1.5, `night exposure ${state.exposure}`);
  const sky = hexToRgb(state.ambient.skyColor);
  assert.ok(sky[2] > sky[0], 'night hemisphere is blue');
  assert.ok(sky[0] + sky[1] + sky[2] > 0.6, 'night hemisphere floor is lifted, not black');
});

test('sun color is warm at the horizon and near-white high in the sky', () => {
  const horizon = hexToRgb(sunColorFor(1));
  assert.ok(horizon[0] > horizon[1] && horizon[1] > horizon[2], 'warm orange ordering');
  const noon = hexToRgb(sunColorFor(50));
  assert.ok(noon[0] > 0.9 && noon[1] > 0.85 && noon[2] > 0.75, 'pale warm white');
  const night = hexToRgb(sunColorFor(-6));
  assert.ok(night[0] > night[2], 'sunset color stays warm even below the horizon');
});

test('moonlight scales with phase and is suppressed during the day', () => {
  const full = moonIntensityFor(40, 1, -20);
  const crescent = moonIntensityFor(40, 0.2, -20);
  assert.ok(full > crescent && crescent > 0, 'illuminated fraction scales moonlight');
  close(moonIntensityFor(40, 1, 30), 0, 1e-9, 'no moonlight in daylight');
  close(moonIntensityFor(-5, 1, -20), 0, 1e-9, 'no moonlight below the horizon');
  assert.ok(full < 2.0);
});

test('moon shadow rule requires dark sky, high moon and a lit phase', () => {
  assert.equal(moonCanCastShadow(30, 0.8, -10), true);
  assert.equal(moonCanCastShadow(30, 0.8, MOON_SHADOW_MAX_SUN_ALTITUDE + 0.1), false);
  assert.equal(moonCanCastShadow(2, 0.8, -10), false);
  assert.equal(moonCanCastShadow(30, 0.1, -10), false);
});

test('computeLighting picks sun by day and moon by a moonlit night', () => {
  const daySample = sampleLight(sky, 720); // solar noon
  const day = computeLighting(daySample, sky.moon.illumination);
  assert.equal(day.kind, 'sun');
  assert.equal(day.active, day.sun);
  assert.equal(day.sun.castShadow, true);
  assert.ok(day.sun.altitudeDeg > SUN_SHADOW_MIN_ALTITUDE);
  assert.equal(day.moon.castShadow, false);
  close(unitLength(day.sun.direction), 1, 1e-9);
  assert.ok(day.ambient.intensity > 1);
  assert.ok(day.exposure <= 1.05);

  const night = computeLighting(
    { sunAlt: -25, sunAz: 350, moonAlt: 42, moonAz: 160 },
    0.85
  );
  assert.equal(night.kind, 'moon');
  assert.equal(night.active, night.moon);
  assert.equal(night.sun.castShadow, false);
  assert.equal(night.moon.castShadow, true);
  assert.ok(night.moon.intensity > 0.2, `moon intensity ${night.moon.intensity}`);
  close(unitLength(night.moon.direction), 1, 1e-9);
  assert.ok(night.ambient.intensity < day.ambient.intensity, 'night ambient is darker');
  assert.ok(night.exposure > day.exposure, 'night exposure is lifted');
  const nightSky = hexToRgb(night.ambient.skyColor);
  const daySky = hexToRgb(day.ambient.skyColor);
  assert.ok(
    nightSky[0] + nightSky[1] + nightSky[2] < daySky[0] + daySky[1] + daySky[2],
    'night hemisphere color is darker'
  );
});

test('moon turning off leaves a black-sky night with kind none', () => {
  const state = computeLighting({ sunAlt: -30, sunAz: 0, moonAlt: -20, moonAz: 90 }, 0.4);
  assert.equal(state.kind, 'none');
  assert.equal(state.active, state.none);
  assert.equal(state.active.intensity, 0);
  assert.equal(state.active.castShadow, false);
  assert.ok(Number.isFinite(state.active.direction[1]));
});

test('exactly one light may cast shadows at any sky state (no double shadow)', () => {
  const state = createLightState();
  for (let sunAlt = -30; sunAlt <= 80; sunAlt += 5) {
    for (let moonAlt = -20; moonAlt <= 70; moonAlt += 10) {
      for (const illumination of [0.05, 0.5, 1]) {
        updateLightState(state, { sunAlt, sunAz: 120, moonAlt, moonAz: 200 }, illumination);
        assert.ok(
          !(state.sun.castShadow && state.moon.castShadow),
          `double shadow at sun ${sunAlt}, moon ${moonAlt}`
        );
        close(unitLength(state.sun.direction), 1, 1e-9, 'sun unit direction');
        close(unitLength(state.moon.direction), 1, 1e-9, 'moon unit direction');
      }
    }
  }
});

test('updateLightState is allocation-free reusable state', () => {
  const state = createLightState();
  const before = state.sun.direction;
  updateLightState(state, { sunAlt: 30, sunAz: 120, moonAlt: -20, moonAz: 300 }, 0.5);
  assert.equal(state.sun.direction, before, 'direction tuple reused');
  assert.equal(state.kind, 'sun');
});
