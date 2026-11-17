/**
 * Unit tests for diorama camera/extents math.
 * Run with: node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CityModel } from '../../shared/types.ts';
import {
  CAMERA_DISTANCE_M,
  DETAIL_MODEL_HEIGHT_FRACTION,
  DEFAULT_AZIMUTH_DEG,
  DEFAULT_PITCH_DEG,
  FIT_AZIMUTH_DEG,
  DEFAULT_ZOOM,
  PITCH_MAX_DEG,
  PITCH_MIN_DEG,
  ZOOM_MAX,
  ZOOM_MIN,
  cameraPosition,
  clampPitch,
  clampTarget,
  clampZoom,
  dampingAlpha,
  defaultPose,
  detailFocusZoom,
  dragToPan,
  fitBoxFor,
  fitHalfHeight,
  fitTargetY,
  orthoFrustum,
  wrapAzimuth
} from '../../src/scene/camera.ts';
import {
  DEFAULT_RADIUS_M,
  defaultExtents,
  modelExtentsFor,
  plinthProfile
} from '../../src/scene/model.ts';

const model = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/model-mini.json', import.meta.url)), 'utf8')
) as CityModel;

const DEG = Math.PI / 180;

function close(actual: number, expected: number, tolerance = 1e-6, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (tol ${tolerance})`
  );
}

test('default isometric pose looks south-east with NW up (135° azimuth) / 35.264° pitch / 1x zoom', () => {
  const pose = defaultPose(12, 4, -9);
  assert.equal(pose.azimuthDeg, 135);
  close(pose.pitchDeg, 35.264389682754654, 1e-9);
  assert.equal(pose.zoom, DEFAULT_ZOOM);
  assert.deepEqual([pose.targetX, pose.targetY, pose.targetZ], [12, 4, -9]);
});

test('clamp helpers enforce contract ranges', () => {
  assert.equal(clampPitch(-70), PITCH_MIN_DEG);
  assert.equal(clampPitch(89), PITCH_MAX_DEG);
  assert.equal(clampPitch(35), 35);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  close(zoomRoundTrip(), DEFAULT_ZOOM);
  assert.equal(wrapAzimuth(-90), 270);
  assert.equal(wrapAzimuth(450), 90);
  assert.equal(wrapAzimuth(360), 0);
  assert.equal(wrapAzimuth(0), 0);
});

function zoomRoundTrip(): number {
  return clampZoom(1);
}

test('cameraPosition orbits around the target at the contract distance', () => {
  const target = [10, 5, -20] as const;
  for (const [az, pitch] of [
    [45, 35.264],
    [0, 45],
    [180, 30],
    [300, 72]
  ]) {
    const position = cameraPosition(target[0], target[1], target[2], az, pitch);
    const dx = position[0] - target[0];
    const dy = position[1] - target[1];
    const dz = position[2] - target[2];
    close(Math.hypot(dx, dy, dz), CAMERA_DISTANCE_M, 1e-6, 'orbit radius');
    close(Math.asin(dy / CAMERA_DISTANCE_M) / DEG, pitch, 1e-9, 'elevation');
    // Horizontal direction is (sin az, -cos az): azimuth clockwise from north.
    const horizontal = Math.hypot(dx, dz);
    close(dx / horizontal, Math.sin(az * DEG), 1e-9, 'azimuth x');
    close(dz / horizontal, -Math.cos(az * DEG), 1e-9, 'azimuth z');
  }

  const north = cameraPosition(0, 0, 0, 0, 0);
  assert.ok(north[2] < 0, 'azimuth 0 places the camera north (-Z)');
  const east = cameraPosition(0, 0, 0, 90, 0);
  assert.ok(east[0] > 0, 'azimuth 90 places the camera east (+X)');
});

test('orthoFrustum keeps the requested aspect ratio', () => {
  for (const aspect of [0.5, 1, 16 / 9, 3]) {
    const rect = orthoFrustum(500, aspect);
    assert.equal(rect.top, 500);
    assert.equal(rect.bottom, -500);
    close((rect.right - rect.left) / (rect.top - rect.bottom), aspect, 1e-12);
  }
});

function projectBoxCorners(
  box: { halfX: number; halfZ: number; minY: number; maxY: number },
  azimuthDeg: number,
  pitchDeg: number
): { halfWidth: number; halfHeight: number } {
  const az = azimuthDeg * DEG;
  const pitch = pitchDeg * DEG;
  const rightX = -Math.cos(az);
  const rightZ = -Math.sin(az);
  const upX = -Math.sin(az) * Math.sin(pitch);
  const upY = Math.cos(pitch);
  const upZ = Math.cos(az) * Math.sin(pitch);
  let halfWidth = 0;
  let halfHeight = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const y of [box.minY, box.maxY]) {
        const x = box.halfX * sx;
        const z = box.halfZ * sz;
        halfWidth = Math.max(halfWidth, Math.abs(x * rightX + z * rightZ));
        halfHeight = Math.max(halfHeight, Math.abs(x * upX + y * upY + z * upZ));
      }
    }
  }
  return { halfWidth, halfHeight };
}

test('fitHalfHeight frames the whole diorama at every aspect ratio', () => {
  const extents = defaultExtents();
  const profile = plinthProfile(extents);
  const box = {
    halfX: profile.outerHalfX,
    halfZ: profile.outerHalfZ,
    minY: profile.bottomY,
    maxY: extents.maxY
  };
  for (const aspect of [0.55, 1, 16 / 9, 2.5]) {
    const halfHeight = fitHalfHeight(
      { centerX: 0, centerZ: 0, ...box },
      aspect
    );
    const fitted = projectBoxCorners(box, FIT_AZIMUTH_DEG, DEFAULT_PITCH_DEG);
    assert.ok(fitted.halfHeight <= halfHeight + 1e-6, `vertical fit @${aspect}`);
    assert.ok(fitted.halfWidth <= halfHeight * aspect + 1e-6, `horizontal fit @${aspect}`);
  }

  // A portrait viewport needs a larger world half-height than a landscape one.
  const narrow = fitHalfHeight({ centerX: 0, centerZ: 0, ...box }, 0.6);
  const wide = fitHalfHeight({ centerX: 0, centerZ: 0, ...box }, 2.2);
  assert.ok(narrow > wide, `portrait ${narrow} should exceed landscape ${wide}`);

  // The fitted half-height tracks the fallback diorama size (DEFAULT_RADIUS_M).
  const landscape = fitHalfHeight({ centerX: 0, centerZ: 0, ...box }, 16 / 9);
  assert.ok(
    landscape > DEFAULT_RADIUS_M * 0.8 && landscape < DEFAULT_RADIUS_M * 1.8,
    `sanity fit ${landscape} for radius ${DEFAULT_RADIUS_M}`
  );
});

test('modelExtentsFor unions bounds with actual fixture geometry', () => {
  const extents = modelExtentsFor(model);
  // Fixture bounds claim ±900 dm, but footprints reach ±6500 dm; the actual
  // geometry must win so the plinth and camera fit contain everything.
  close(extents.halfX, 653.6, 1e-6, 'halfX');
  close(extents.halfZ, 583.25, 1e-6, 'halfZ');
  assert.ok(extents.radius > 600);
  assert.ok(extents.maxHeight >= 64.3, `maxHeight ${extents.maxHeight}`);
  assert.ok(extents.minY < 0, 'plinth extends below ground');
  close(extents.minY, -extents.plinthDepth, 1e-9);
  close(extents.centerX, (6578 - 6494) / 20, 1e-6);
  close(extents.centerZ, (7712 - 3953) / 20, 1e-6);

  const profile = plinthProfile(extents);
  assert.equal(profile.layers.length, 3);
  for (let i = 1; i < profile.layers.length; i += 1) {
    assert.ok(profile.layers[i].halfX > profile.layers[i - 1].halfX, 'stepped plinth widens');
    assert.ok(profile.layers[i].halfZ > profile.layers[i - 1].halfZ);
  }
  close(profile.bottomY, extents.minY, 1e-9);
  close(profile.outerHalfX, profile.layers[2].halfX, 1e-9);
  assert.ok(profile.outerHalfX > extents.halfX);
});

test('defaultExtents are a sane pre-model fallback', () => {
  const extents = defaultExtents();
  assert.equal(extents.radius, DEFAULT_RADIUS_M);
  assert.ok(extents.maxHeight > 60);
  assert.ok(extents.minY < 0);
  const profile = plinthProfile(extents);
  assert.ok(profile.outerHalfX > DEFAULT_RADIUS_M);
  assert.ok(
    profile.outerHalfX < DEFAULT_RADIUS_M * 1.2,
    `plinth should stay compact, got ${profile.outerHalfX}`
  );
});

test('fitTargetY centres the plinth vertically', () => {
  const extents = defaultExtents();
  const profile = plinthProfile(extents);
  close(fitTargetY(extents, profile.bottomY), (extents.maxY + profile.bottomY) / 2, 1e-9);
});

test('clampTarget keeps the camera over the diorama', () => {
  const bounds = { centerX: 10, centerZ: -5, halfX: 100, halfZ: 50 };
  assert.deepEqual(clampTarget(10, -5, bounds), [10, -5]);
  assert.deepEqual(clampTarget(-500, -500, bounds), [-90, -55]);
  assert.deepEqual(clampTarget(500, 500, bounds), [110, 45]);
});

test('dragToPan is the sign-consistent wrapper around the pan helper', () => {
  const view = {
    fitHalfHeight: 1000,
    zoom: 1,
    viewportHeight: 1000,
    azimuthDeg: 0,
    pitchDeg: 35.264
  };
  const [dxEast, dz ] = dragToPan(10, 0, view);
  assert.ok(dxEast > 0, 'drag right pans east at azimuth 0');
  close(dz, 0, 1e-12);
});

test('dampingAlpha is framerate independent and bounded', () => {
  assert.equal(dampingAlpha(10, 0), 1);
  const short = dampingAlpha(12, 1 / 120);
  const long = dampingAlpha(12, 1 / 30);
  assert.ok(short > 0 && short < long && long <= 1);
  close(dampingAlpha(5, 0.2), 1 - Math.exp(-1), 1e-9);
});

/* ------------------------------------------------------------------ */
/* Detail-window focus math                                            */
/* ------------------------------------------------------------------ */

test('detailFocusZoom never zooms out below the model-fit view', () => {
  const extents = defaultExtents();
  const profile = plinthProfile(extents);
  const fitBox = fitBoxFor(extents, profile.outerHalfX, profile.outerHalfZ, profile.bottomY);
  const halfHeight = fitHalfHeight(fitBox, 16 / 9);

  // The reported UX bug: at the default 750 m window Focus used to zoom *out*
  // (measured 1.00 → 0.972). Reconstruct the old formula to prove it zoomed
  // out, then check the new one frames the window without going below fit.
  const fittedHeight = halfHeight * 2;
  const oldDesiredHeight = Math.min(
    Math.max(360, 750 * 2 * 2.4),
    extents.radius * 2 * 1.05
  );
  const oldZoom = fittedHeight / oldDesiredHeight;
  assert.ok(oldZoom < 1, `old formula should reproduce the zoom-out (${oldZoom})`);
  const defaultWindowZoom = detailFocusZoom(halfHeight, extents.radius, 750);
  assert.ok(defaultWindowZoom >= 1, `default window zoom ${defaultWindowZoom} must be >= 1`);
  assert.ok(
    defaultWindowZoom > oldZoom,
    `new zoom ${defaultWindowZoom} must beat the old ${oldZoom}`
  );

  // A small window zooms in and stays within the public zoom limits.
  const smallZoom = detailFocusZoom(halfHeight, extents.radius, 100);
  assert.ok(smallZoom > defaultWindowZoom, `100 m window should zoom in (${smallZoom})`);
  assert.ok(smallZoom <= ZOOM_MAX);

  // A window larger than the model is capped at the model-height fraction and
  // falls back toward the fitted view instead of showing empty space.
  const cappedZoom = Math.max(
    1,
    fittedHeight / (extents.radius * 2 * DETAIL_MODEL_HEIGHT_FRACTION)
  );
  close(
    detailFocusZoom(halfHeight, extents.radius, extents.radius * 2),
    cappedZoom,
    1e-9,
    'oversized window clamps to the model-cap zoom'
  );

  // Monotone in window radius and always inside [1, ZOOM_MAX].
  let previous = Infinity;
  for (const radius of [1, 10, 100, 250, 500, 750, 1000, 1500, 3000, 10000]) {
    const zoom = detailFocusZoom(halfHeight, extents.radius, radius);
    assert.ok(zoom >= 1 && zoom <= ZOOM_MAX, `zoom(${radius}) = ${zoom} outside [1, ${ZOOM_MAX}]`);
    assert.ok(zoom <= previous + 1e-12, `zoom must not grow with a larger window (${radius})`);
    previous = zoom;
  }
});

test('detailFocusZoom handles degenerate inputs without NaN/infinity', () => {
  assert.equal(detailFocusZoom(0, 1500, 750), DEFAULT_ZOOM);
  assert.equal(detailFocusZoom(Number.NaN, 1500, 750), DEFAULT_ZOOM);
  assert.equal(detailFocusZoom(1000, 1500, 0), ZOOM_MAX, 'point window clamps to max zoom');
  assert.equal(detailFocusZoom(1000, Number.NaN, 750), ZOOM_MAX, 'missing model radius');
  for (const zoom of [
    detailFocusZoom(-5, 1500, 750),
    detailFocusZoom(1000, -10, 750),
    detailFocusZoom(1000, 1500, -100)
  ]) {
    assert.ok(Number.isFinite(zoom) && zoom >= 1 && zoom <= ZOOM_MAX);
  }
});
