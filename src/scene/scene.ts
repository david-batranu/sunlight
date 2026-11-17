/**
 * Sunlight diorama scene — the only Three.js entry point of the SPA.
 *
 * Owns the WebGL2 renderer, the orthographic isometric camera with its
 * pan/orbit/zoom controls, the merged warm low-poly city geometry, the
 * plinth, and the sky-driven sun/moon/hemisphere lighting with real shadows.
 *
 * The canvas is transparent (`alpha: true`, clear alpha 0): the time-of-day
 * CSS backdrop behind it belongs to the UI and must stay visible.
 *
 * This module does not import the store or the UI — the lead wires data in
 * through `SceneHandle` and reads `getDebug()` for E2E.
 */

import * as THREE from 'three';
import type { CityModel, SkyDay } from '../../shared/types.ts';
import type { DetailWindow, HitFeature, SceneDebug, SceneHandle } from '../app/contracts.ts';
import {
  CAMERA_DISTANCE_M,
  detailFocusZoom,
  fitBoxFor,
  fitHalfHeight,
  fitTargetY,
  groundPointFromRay,
  ndcFromClient,
  orthoFrustum,
  wrapAzimuth
} from './camera.ts';
import { DioramaControls } from './controls.ts';
import { FrameStats } from './frame-stats.ts';
import { splitMeshByGrid } from './chunks.ts';
import {
  buildModelBuffers,
  shadowRadiusFor,
  type MeshBuffers
} from './geometry.ts';
import {
  hitFeatureForFace,
  type FeatureKind,
  type FeatureMeshInfo
} from './features.ts';
import {
  createLightSample,
  sampleLightInto,
  shadowConfig,
  type ShadowConfig
} from './light.ts';
import {
  DEFAULT_RADIUS_M,
  modelExtentsFor,
  plinthProfile,
  type ModelExtents,
  type PlinthProfile
} from './model.ts';
import {
  createLightState,
  updateLightState,
  type DirectionalLightState,
  type LightState
} from './palette.ts';
import {
  ADAPTIVE_SAMPLE_FRAMES,
  QUALITY,
  degradeQualityForFrameTime,
  qualityForEnvironment,
  type SceneQuality
} from './quality.ts';

export type { SceneQuality } from './quality.ts';

/** Adaptive-policy frame intervals must be this close together to count as a
 *  continuous rendering run; interaction gaps end a run. */
const CONTINUOUS_RENDER_MAX_GAP_MS = 250;
const CAMERA_NEAR = 5;
const CAMERA_FAR = 14000;
const SHADOW_ALTITUDE_STEP = 0.5;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface ShadowRig {
  light: THREE.DirectionalLight;
  config: ShadowConfig;
  lastAltitude: number;
  mapSize: number;
}

function createRig(
  light: THREE.DirectionalLight,
  shadowRadius: number,
  maxHeight: number
): ShadowRig {
  return {
    light,
    config: shadowConfig(45, shadowRadius, maxHeight),
    lastAltitude: Number.NEGATIVE_INFINITY,
    mapSize: 0
  };
}

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  /* ---------------------------------------------------------------- */
  /* Renderer (transparent over the CSS sky)                           */
  /* ---------------------------------------------------------------- */

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    stencil: false,
    powerPreference: 'high-performance'
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  // Three 0.187 removed PCFSoftShadowMap (it warned and silently used PCF).
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Shadows depend on the light rig/model, not the camera: rebuild them only
  // when lighting/geometry/quality invalidates them (see invalidateShadows()).
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // Deliberately no scene.background: the CSS gradient must show through.

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
  camera.up.set(0, 1, 0);

  /** Shared by every merged mesh; vertex colours carry the palette. */
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.02,
    flatShading: true
  });

  /** Detail-window mask: full colour inside, muted context outside. */
  const detailUniforms = {
    uDetailEnabled: { value: 0 },
    uDetailCenter: { value: new THREE.Vector2(0, 0) },
    uDetailHalf: { value: new THREE.Vector2(0, 0) }
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, detailUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vDetailWorld;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDetailWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uDetailEnabled;\nuniform vec2 uDetailCenter;\nuniform vec2 uDetailHalf;\nvarying vec3 vDetailWorld;'
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uDetailEnabled > 0.5) {
          vec2 detailDelta = abs(vDetailWorld.xz - uDetailCenter) - uDetailHalf;
          float detailOutside = smoothstep(-1.0, 8.0, max(detailDelta.x, detailDelta.y));
          float detailLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 detailMuted = mix(vec3(detailLuma), diffuseColor.rgb, 0.22) * 0.64;
          diffuseColor.rgb = mix(detailMuted, diffuseColor.rgb, 1.0 - detailOutside);
        }`
      );
  };

  /* ---------------------------------------------------------------- */
  /* Lights                                                            */
  /* ---------------------------------------------------------------- */

  const hemisphere = new THREE.HemisphereLight(0xcfdde8, 0x8a7354, 1.3);
  scene.add(hemisphere);

  const sunLight = new THREE.DirectionalLight(0xfff0d5, 3);
  sunLight.castShadow = true;
  sunLight.shadow.bias = -0.0002;
  sunLight.shadow.normalBias = 0.8;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const moonLight = new THREE.DirectionalLight(0xb9cbe4, 0);
  moonLight.castShadow = false;
  moonLight.shadow.bias = -0.0002;
  moonLight.shadow.normalBias = 0.8;
  scene.add(moonLight);
  scene.add(moonLight.target);

  /* ---------------------------------------------------------------- */
  /* Model + camera state                                              */
  /* ---------------------------------------------------------------- */

  const modelRoot = new THREE.Group();
  modelRoot.name = 'city';
  scene.add(modelRoot);

  const controls = new DioramaControls(canvas);

  /** Initial tier: phones/small screens start low so their first seconds are
   *  not spent at full DPR before the adaptive policy has any data. */
  function initialQuality(): SceneQuality {
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    return qualityForEnvironment({
      coarsePointer,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    });
  }

  let quality: SceneQuality = initialQuality();
  let extents: ModelExtents = modelExtentsFor(null);
  let profile: PlinthProfile = plinthProfile(extents);
  let fitBox = fitBoxFor(extents, profile.outerHalfX, profile.outerHalfZ, profile.bottomY);
  let shadowRadius = shadowRadiusFor(extents);
  let targetY = fitTargetY(extents, profile.bottomY);
  let halfHeight = 900;
  let aspect = 1;
  let viewportHeight = 800;
  let terrainMesh: THREE.Mesh | null = null;
  let treesMesh: THREE.Mesh | null = null;
  let buildingsMesh: THREE.Mesh | null = null;
  let roadsMesh: THREE.Mesh | null = null;
  let areasMesh: THREE.Mesh | null = null;
  let modelKey: string | null = null;
  let currentModel: CityModel | null = null;
  let detailWindow: DetailWindow | null = null;
  let disposed = false;

  /** Raycast targets for feature picking (buildings, roads, areas). */
  const pickTargets: THREE.Mesh[] = [];
  const pickInfo = new Map<THREE.Mesh, FeatureMeshInfo>();
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  const sunRig = createRig(sunLight, shadowRadius, extents.maxHeight);
  const moonRig = createRig(moonLight, shadowRadius, extents.maxHeight);

  /* ---------------------------------------------------------------- */
  /* Sky / time state                                                  */
  /* ---------------------------------------------------------------- */

  let sky: SkyDay | null = null;
  let minute = 12 * 60;
  let moonIllumination = 0.5;
  let lightingDirty = true;
  let lastAppliedMinute = Number.NaN;
  let lastAppliedSky: SkyDay | null | undefined;

  const lightSample = createLightSample();
  const lightState: LightState = createLightState();

  /* ---------------------------------------------------------------- */
  /* On-demand rendering scheduler                                     */
  /* ---------------------------------------------------------------- */

  /** Rendered-frame statistics for getDebug()/E2E (median/p95 cadence). */
  const frameStats = new FrameStats();

  /** Set when the visible scene must be re-rendered (lighting/model/UI/…). */
  let needsRender = true;
  let animationFrame = 0;
  let lastRenderAt = 0;
  let lastLoopAt = 0;
  let lastRafIntervalMs = 0;

  /**
   * Pose/matrix state of the last rendered frame. Comparing six numbers each
   * rAF tick detects camera motion exactly (damping converges to the exact
   * target) and lets the loop stop calling `renderer.render` once settled —
   * without allocating or subscribing to control events.
   */
  const renderedPose = {
    azimuth: Number.NaN,
    pitch: Number.NaN,
    zoom: Number.NaN,
    targetX: Number.NaN,
    targetZ: Number.NaN,
    targetY: Number.NaN
  };

  /** Consecutive rendered frames close enough together to be a live run. */
  let continuousFrames = 0;

  /** Coalesced resize: observers only flag; the frame loop applies it once. */
  let resizePending = false;
  let appliedWidth = 0;
  let appliedHeight = 0;
  let appliedDpr = 0;

  /* ---------------------------------------------------------------- */
  /* Geometry helpers                                                  */
  /* ---------------------------------------------------------------- */

  function addMesh(
    buffers: MeshBuffers,
    castShadow: boolean,
    receiveShadow: boolean
  ): THREE.Mesh | null {
    if (buffers.triangles <= 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    // Colours are authored as linear floats; normalized Uint8 halves the
    // attribute bandwidth with no visible difference at 8 bits/channel.
    const packedColors = new Uint8Array(buffers.colors.length);
    for (let i = 0; i < buffers.colors.length; i += 1) {
      packedColors[i] = Math.round(Math.max(0, Math.min(1, buffers.colors[i] ?? 0)) * 255);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(packedColors, 3, true));
    // No normal attribute: the shared material is flat-shaded, so Three derives
    // per-face normals in the fragment shader (dFdx/dFdy). This drops a third of
    // the vertex data (~10 MB per city) and keeps the flat look; the normal is
    // never sampled in the fragment stage.
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    modelRoot.add(mesh);
    return mesh;
  }

  function disposeModel(): void {
    for (const child of modelRoot.children.slice()) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
    }
    modelRoot.clear();
    terrainMesh = null;
    treesMesh = null;
    buildingsMesh = null;
    roadsMesh = null;
    areasMesh = null;
    pickTargets.length = 0;
    pickInfo.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                            */
  /* ---------------------------------------------------------------- */

  function applyProjection(): void {
    const rect = orthoFrustum(halfHeight, aspect);
    camera.left = rect.left;
    camera.right = rect.right;
    camera.top = rect.top;
    camera.bottom = rect.bottom;
    camera.near = CAMERA_NEAR;
    camera.far = CAMERA_FAR;
    camera.updateProjectionMatrix();
  }

  function updateCamera(): void {
    const zoom = controls.zoomLevel;
    if (Math.abs(camera.zoom - zoom) > 1e-5) {
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
    // Inlined cameraPosition() to stay allocation-free in the frame loop.
    const azimuth = (controls.azimuthDeg * Math.PI) / 180;
    const pitch = (controls.pitchDeg * Math.PI) / 180;
    const horizontal = Math.cos(pitch) * CAMERA_DISTANCE_M;
    camera.position.set(
      controls.targetX + Math.sin(azimuth) * horizontal,
      targetY + Math.sin(pitch) * CAMERA_DISTANCE_M,
      controls.targetZ - Math.cos(azimuth) * horizontal
    );
    camera.lookAt(controls.targetX, targetY, controls.targetZ);
  }

  function currentDpr(): number {
    return Math.min(window.devicePixelRatio || 1, QUALITY[quality].dprCap);
  }

  /**
   * Applies the current canvas size/DPR, early-outing when the drawing buffer
   * would not change (ResizeObserver + window resize both funnel here, and the
   * common URL-bar animation fires many identical callbacks).
   * Returns true when the renderer state was actually updated.
   */
  function applyResize(): boolean {
    const width = Math.max(
      1,
      Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth)
    );
    const height = Math.max(
      1,
      Math.round(canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight)
    );
    const dpr = currentDpr();
    if (width === appliedWidth && height === appliedHeight && dpr === appliedDpr) return false;
    appliedWidth = width;
    appliedHeight = height;
    appliedDpr = dpr;
    aspect = width / height;
    viewportHeight = height;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    halfHeight = fitHalfHeight(fitBox, aspect);
    applyProjection();
    controls.setViewMetrics(halfHeight, height);
    updateCamera();
    needsRender = true;
    return true;
  }

  /** Coalesces observer bursts into a single resize on the next rAF tick. */
  function scheduleResize(): void {
    resizePending = true;
  }

  /** Public resize (SceneHandle): applied immediately for direct callers. */
  function resize(): void {
    resizePending = false;
    applyResize();
  }

  function refitCamera(): void {
    fitBox = fitBoxFor(extents, profile.outerHalfX, profile.outerHalfZ, profile.bottomY);
    targetY = fitTargetY(extents, profile.bottomY);
    halfHeight = fitHalfHeight(fitBox, aspect);
    applyProjection();
    controls.setViewMetrics(halfHeight, viewportHeight);
    controls.setModelBounds({
      centerX: extents.centerX,
      centerZ: extents.centerZ,
      halfX: profile.outerHalfX,
      halfZ: profile.outerHalfZ
    });
    controls.setTarget(extents.centerX, extents.centerZ, true);
    updateCamera();
  }

  /* ---------------------------------------------------------------- */
  /* Lighting                                                          */
  /* ---------------------------------------------------------------- */

  function updateLightTargets(): void {
    sunLight.target.position.set(extents.centerX, 0, extents.centerZ);
    moonLight.target.position.set(extents.centerX, 0, extents.centerZ);
  }

  function applyRig(
    rig: ShadowRig,
    state: DirectionalLightState,
    mapSize: number
  ): void {
    const light = rig.light;
    light.color.setHex(state.color);
    light.intensity = state.intensity;

    if (state.castShadow) {
      const altitude = Math.max(state.altitudeDeg, 0.25);
      if (rig.mapSize !== mapSize) {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        light.shadow.mapSize.set(mapSize, mapSize);
        rig.mapSize = mapSize;
        rig.lastAltitude = Number.NEGATIVE_INFINITY;
      }
      if (Math.abs(altitude - rig.lastAltitude) > SHADOW_ALTITUDE_STEP) {
        rig.config = shadowConfig(altitude, shadowRadius, extents.maxHeight);
        rig.lastAltitude = altitude;
        const shadowCamera = light.shadow.camera;
        shadowCamera.left = -rig.config.halfSize;
        shadowCamera.right = rig.config.halfSize;
        shadowCamera.top = rig.config.halfSize;
        shadowCamera.bottom = -rig.config.halfSize;
        shadowCamera.near = rig.config.near;
        shadowCamera.far = rig.config.far;
        shadowCamera.updateProjectionMatrix();
        light.shadow.bias = rig.config.bias;
        light.shadow.normalBias = rig.config.normalBias;
      }
      if (!light.castShadow) light.castShadow = true;
    } else {
      light.castShadow = false;
      rig.lastAltitude = Number.NEGATIVE_INFINITY;
    }

    const distance = rig.config.distance;
    light.position.set(
      extents.centerX + state.direction[0] * distance,
      state.direction[1] * distance,
      extents.centerZ + state.direction[2] * distance
    );
  }

  /** Marks the shadow depth map for a one-off rebuild on the next render. */
  function invalidateShadows(): void {
    renderer.shadowMap.needsUpdate = true;
    needsRender = true;
  }

  function applyLighting(): void {
    sampleLightInto(lightSample, sky, minute);
    updateLightState(lightState, lightSample, moonIllumination);

    const settings = QUALITY[quality];
    applyRig(sunRig, lightState.sun, settings.shadowMapSize);
    applyRig(moonRig, lightState.moon, settings.shadowMapSize);

    hemisphere.color.setHex(lightState.ambient.skyColor);
    hemisphere.groundColor.setHex(lightState.ambient.groundColor);
    hemisphere.intensity = lightState.ambient.intensity;
    renderer.toneMappingExposure = lightState.exposure;
    // Sun/moon direction (or shadow camera fit) changed: the depth pass is only
    // valid for the previous rig. Camera-only motion never reaches this path.
    invalidateShadows();
  }

  function applyLightingIfNeeded(force = false): void {
    const unchanged =
      !force &&
      !lightingDirty &&
      minute === lastAppliedMinute &&
      sky === lastAppliedSky;
    if (unchanged) return;
    applyLighting();
    lastAppliedMinute = minute;
    lastAppliedSky = sky;
    lightingDirty = false;
  }

  /* ---------------------------------------------------------------- */
  /* Feature picking                                                   */
  /* ---------------------------------------------------------------- */

  function registerPickMesh(
    mesh: THREE.Mesh | null,
    kind: FeatureKind,
    buffers: MeshBuffers
  ): void {
    if (!mesh || buffers.featureIndices.length === 0) return;
    pickTargets.push(mesh);
    pickInfo.set(mesh, { kind, featureIndices: buffers.featureIndices });
  }

  function hitTest(clientX: number, clientY: number): HitFeature | null {
    if (disposed || !currentModel || pickTargets.length === 0) return null;
    const ndc = ndcFromClient(clientX, clientY, canvas.getBoundingClientRect());
    if (!ndc) return null;
    pointerNdc.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointerNdc, camera);
    const intersections = raycaster.intersectObjects(pickTargets, false);
    if (intersections.length === 0) return null;
    // Nearest surface wins; an unnamed face blocks fall-through to features behind.
    const nearest = intersections[0];
    const info = pickInfo.get(nearest.object as THREE.Mesh) ?? null;
    return hitFeatureForFace(currentModel, info, nearest.faceIndex);
  }

  function getGroundPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    if (disposed) return null;
    const ndc = ndcFromClient(clientX, clientY, canvas.getBoundingClientRect());
    if (!ndc) return null;
    pointerNdc.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointerNdc, camera);
    const ray = raycaster.ray;
    return groundPointFromRay(
      [ray.origin.x, ray.origin.y, ray.origin.z],
      [ray.direction.x, ray.direction.y, ray.direction.z]
    );
  }

  function getCameraAzimuth(): number {
    return wrapAzimuth(controls.azimuthDeg);
  }

  /* ---------------------------------------------------------------- */
  /* SceneHandle                                                       */
  /* ---------------------------------------------------------------- */

  function setModel(model: CityModel): void {
    if (disposed) return;
    extents = modelExtentsFor(model);
    profile = plinthProfile(extents);
    shadowRadius = shadowRadiusFor(extents);

    disposeModel();
    currentModel = model;
    const buffers = buildModelBuffers(model, extents);
    addMesh(buffers.plinth, false, true);
    terrainMesh = addMesh(buffers.terrain, true, true);
    // Buildings dominate the triangle count. Partitioning them into a 3×3
    // grid keeps the wide-view draw budget under 25 while allowing frustum
    // culling to drop most of the city at detail-window zoom levels.
    const buildingChunks = splitMeshByGrid(buffers.buildings, 3);
    buildingsMesh = null;
    for (const chunk of buildingChunks) {
      const mesh = addMesh(chunk, true, true);
      if (mesh) {
        if (!buildingsMesh) buildingsMesh = mesh;
        registerPickMesh(mesh, 'building', chunk);
      }
    }
    roadsMesh = addMesh(buffers.roads, false, true);
    areasMesh = addMesh(buffers.areas, false, true);
    treesMesh = addMesh(buffers.trees, true, true);
    registerPickMesh(roadsMesh, 'road', buffers.roads);
    registerPickMesh(areasMesh, 'area', buffers.areas);
    if (treesMesh) treesMesh.visible = QUALITY[quality].showTrees;

    modelKey = model.key;
    updateLightTargets();
    sunRig.config = shadowConfig(45, shadowRadius, extents.maxHeight);
    sunRig.lastAltitude = Number.NEGATIVE_INFINITY;
    moonRig.config = shadowConfig(45, shadowRadius, extents.maxHeight);
    moonRig.lastAltitude = Number.NEGATIVE_INFINITY;
    refitCamera();
    lightingDirty = true;
    applyLightingIfNeeded(true);
  }

  function setDetailWindow(nextDetailWindow: DetailWindow | null): void {
    if (disposed) return;
    const previous = detailWindow;
    const unchanged =
      previous === null && nextDetailWindow === null
        ? true
        : previous !== null &&
          nextDetailWindow !== null &&
          previous.centerX === nextDetailWindow.centerX &&
          previous.centerZ === nextDetailWindow.centerZ &&
          previous.radiusM === nextDetailWindow.radiusM;
    if (unchanged) return;
    detailWindow = nextDetailWindow;
    if (nextDetailWindow) {
      detailUniforms.uDetailEnabled.value = 1;
      detailUniforms.uDetailCenter.value.set(nextDetailWindow.centerX, nextDetailWindow.centerZ);
      detailUniforms.uDetailHalf.value.set(nextDetailWindow.radiusM, nextDetailWindow.radiusM);
    } else {
      detailUniforms.uDetailEnabled.value = 0;
    }
    // Uniform-only change: redraw the frame, but the shadow rig is unaffected.
    needsRender = true;
  }

  function focusDetailWindow(window: DetailWindow): void {
    if (disposed) return;
    // Frame the selected square with surrounding context. The pure helper keeps
    // zoom >= the model-fit view, so Focus never pulls back into empty space
    // (the default 750 m window used to zoom *out* from 1.00 to 0.97).
    const modelRadius = currentModel?.meta.radiusM ?? DEFAULT_RADIUS_M;
    const zoom = detailFocusZoom(halfHeight, modelRadius, window.radiusM);
    controls.setFocus(window.centerX, window.centerZ, zoom);
    if (prefersReducedMotion()) {
      controls.snap();
      needsRender = true;
    }
  }

  function panBy(dx: number, dz: number): void {
    if (disposed) return;
    controls.panBy(dx, dz);
  }

  function zoomBy(factor: number): void {
    if (disposed) return;
    controls.zoomBy(factor);
  }

  function setSky(nextSky: SkyDay | null): void {
    if (disposed) return;
    sky = nextSky;
    const illumination = nextSky?.moon?.illumination;
    moonIllumination = Number.isFinite(illumination)
      ? Math.max(0, Math.min(1, illumination as number))
      : 0.5;
    lightingDirty = true;
    applyLightingIfNeeded();
  }

  function setTime(nextMinute: number): void {
    if (disposed) return;
    minute = Number.isFinite(nextMinute)
      ? Math.max(0, Math.min(1440, nextMinute))
      : minute;
    applyLightingIfNeeded();
  }

  function setQuality(nextQuality: SceneQuality): void {
    if (disposed) return;
    if (nextQuality !== 'high' && nextQuality !== 'low') return;
    if (nextQuality === quality) return;
    quality = nextQuality;
    continuousFrames = 0;
    sunRig.mapSize = 0;
    moonRig.mapSize = 0;
    if (treesMesh) treesMesh.visible = QUALITY[quality].showTrees;
    resize();
    lightingDirty = true;
    applyLightingIfNeeded(true);
  }

  function resetCamera(): void {
    if (disposed) return;
    controls.reset();
    updateCamera();
  }

  /**
   * Debug payload for E2E/manual inspection. Draw calls/triangles come from the
   * most recent render, which is the settled main pass once shadows are on
   * demand (e.g. 6 draws / ~245k triangles for the Brașov seed); `fps` is the
   * steady-state rendered-frame rate (median cadence) instead of the old
   * first-frame EMA. The rolling interval fields and `framesRendered` make
   * idle gating observable. `quality`/`dpr` are additive (contracts.ts pending).
   */
  function getDebug(): SceneDebug {
    const kind = lightState.kind;
    const active =
      kind === 'sun' ? lightState.sun : kind === 'moon' ? lightState.moon : lightState.none;
    const snapshot = frameStats.snapshot(debugNow());
    const fps =
      snapshot.medianMs > 0
        ? Math.min(240, 1000 / snapshot.medianMs)
        : lastRafIntervalMs > 0
          ? Math.min(240, 1000 / Math.max(lastRafIntervalMs, 1000 / 240))
          : 0;
    const render: SceneDebug['render'] & {
      framesRendered: number;
      frameIntervalMedianMs: number;
      frameIntervalP95Ms: number;
      rendersPerSecond: number;
      quality: SceneQuality;
      dpr: number;
    } = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: Math.round(fps * 10) / 10,
      framesRendered: snapshot.framesRendered,
      frameIntervalMedianMs: Math.round(snapshot.medianMs * 100) / 100,
      frameIntervalP95Ms: Math.round(snapshot.p95Ms * 100) / 100,
      rendersPerSecond: snapshot.rendersPerSecond,
      quality,
      dpr: currentDpr()
    };
    return {
      camera: {
        azimuthDeg: wrapAzimuth(controls.azimuthDeg),
        pitchDeg: controls.pitchDeg,
        zoom: controls.zoomLevel,
        target: [controls.targetX, targetY, controls.targetZ]
      },
      light: {
        kind,
        direction: [active.direction[0], active.direction[1], active.direction[2]],
        altitudeDeg: active.altitudeDeg,
        azimuthDeg: wrapAzimuth(active.azimuthDeg),
        intensity: active.intensity,
        shadow: active.castShadow
      },
      render,
      modelKey
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    controls.dispose();
    disposeModel();
    currentModel = null;
    sunLight.shadow.map?.dispose();
    moonLight.shadow.map?.dispose();
    sunLight.dispose();
    moonLight.dispose();
    hemisphere.dispose();
    material.dispose();
    renderer.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Render stats + frame loop                                         */
  /* ---------------------------------------------------------------- */

  function debugNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** True when the camera state differs from the pose used for the last render. */
  function cameraPoseChanged(): boolean {
    return (
      controls.azimuthDeg !== renderedPose.azimuth ||
      controls.pitchDeg !== renderedPose.pitch ||
      controls.zoomLevel !== renderedPose.zoom ||
      controls.targetX !== renderedPose.targetX ||
      controls.targetZ !== renderedPose.targetZ ||
      targetY !== renderedPose.targetY
    );
  }

  function markPoseRendered(): void {
    renderedPose.azimuth = controls.azimuthDeg;
    renderedPose.pitch = controls.pitchDeg;
    renderedPose.zoom = controls.zoomLevel;
    renderedPose.targetX = controls.targetX;
    renderedPose.targetZ = controls.targetZ;
    renderedPose.targetY = targetY;
  }

  /**
   * Steps the tier down when a sustained continuous-render run misses the
   * frame budget. One-way and sample-gated (90 frames) so brief hitches or
   * slow CI rasterisers cannot flip the tier mid-screenshot.
   */
  function adaptQualityIfNeeded(): void {
    if (quality !== 'high' || continuousFrames < ADAPTIVE_SAMPLE_FRAMES) return;
    // Evaluate in fixed-size blocks so the window sort never runs per frame.
    continuousFrames = 0;
    const snapshot = frameStats.snapshot(debugNow());
    const next = degradeQualityForFrameTime(quality, snapshot.medianMs, snapshot.samples);
    if (!next) return;
    setQuality(next);
  }

  /**
   * Lightweight loop: runs every rAF tick (so damping and the debug cadence
   * stay live) but only calls `renderer.render` when something visible changed.
   * A settled scene — paused time, still camera, no UI changes — renders 0
   * frames/s while the tab is visible and 0 while it is hidden.
   */
  /** Forces one render synchronously; used by pixel-readback tests. */
  function renderNow(): void {
    if (disposed) return;
    updateCamera();
    renderer.render(scene, camera);
    needsRender = false;
    markPoseRendered();
    lastRenderAt = debugNow();
    lastLoopAt = lastRenderAt;
    frameStats.push(lastRenderAt, 0);
  }

  function frame(now: number): void {
    if (disposed) return;
    animationFrame = requestAnimationFrame(frame);
    if (document.hidden) {
      lastLoopAt = now;
      lastRafIntervalMs = 0;
      continuousFrames = 0;
      return;
    }
    const dt = lastLoopAt > 0 ? Math.min(0.1, Math.max(0, (now - lastLoopAt) / 1000)) : 1 / 60;
    if (lastLoopAt > 0 && now > lastLoopAt) lastRafIntervalMs = Math.min(1000, now - lastLoopAt);
    lastLoopAt = now;

    if (resizePending) {
      resizePending = false;
      applyResize();
    }

    controls.update(dt);
    const cameraMoved = cameraPoseChanged();
    if (!cameraMoved && !needsRender) return;
    if (cameraMoved) updateCamera();
    renderer.render(scene, camera);
    needsRender = false;
    markPoseRendered();

    const interval = lastRenderAt > 0 ? now - lastRenderAt : 0;
    lastRenderAt = now;
    frameStats.push(now, interval);
    if (interval > 0 && interval <= CONTINUOUS_RENDER_MAX_GAP_MS) {
      continuousFrames += 1;
    } else if (interval > CONTINUOUS_RENDER_MAX_GAP_MS) {
      continuousFrames = 0;
    }
    adaptQualityIfNeeded();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  function onContextLost(event: Event): void {
    event.preventDefault();
  }

  function onContextRestored(): void {
    if (disposed) return;
    resize();
    invalidateShadows();
    needsRender = true;
    renderer.render(scene, camera);
    needsRender = false;
    markPoseRendered();
    lastRenderAt = debugNow();
    lastLoopAt = lastRenderAt;
  }

  function onVisibilityChange(): void {
    if (disposed) return;
    if (document.hidden) {
      // Nothing may render off-screen; suspend cadence bookkeeping.
      lastLoopAt = 0;
      lastRafIntervalMs = 0;
      continuousFrames = 0;
      return;
    }
    // Coming back may have missed lighting/model changes while parked: render
    // one guaranteed frame, then let the normal dirty tracking take over.
    needsRender = true;
    lastLoopAt = 0;
    lastRenderAt = 0;
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  // One coalesced resize path: both observers only flag, the frame loop applies
  // at most one resize per rAF and early-outs when the drawing buffer size is
  // unchanged. The window listener is kept for DPR changes that do not alter
  // the canvas CSS box (e.g. dragging the window between monitors).
  const resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(canvas);
  window.addEventListener('resize', scheduleResize, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  resize();
  updateLightTargets();
  applyLightingIfNeeded(true);
  updateCamera();
  animationFrame = requestAnimationFrame(frame);

  return {
    setModel,
    setSky,
    setTime,
    setQuality,
    setDetailWindow,
    focusDetailWindow,
    panBy,
    zoomBy,
    renderNow,
    resetCamera,
    resize,
    dispose,
    getDebug,
    hitTest,
    getCameraAzimuth,
    getGroundPoint
  };
}
