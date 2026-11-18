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
import { terrainHeightM } from '../../shared/terrain.ts';
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
  boundsForPositions,
  partitionForPicking,
  selectPickCandidates,
  type PickBounds
} from './picking.ts';
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

  /** Focus crop: discard every fragment outside the selected square. */
  const focusUniforms = {
    uFocusEnabled: { value: 0 },
    uFocusCenter: { value: new THREE.Vector2(0, 0) },
    uFocusHalf: { value: new THREE.Vector2(0, 0) }
  };

  function installFocusDiscard(shader: THREE.WebGLProgramParametersWithUniforms): void {
    Object.assign(shader.uniforms, focusUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFocusWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFocusWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uFocusEnabled;\nuniform vec2 uFocusCenter;\nuniform vec2 uFocusHalf;\nvarying vec3 vFocusWorld;'
      )
      .replace(
        'void main() {',
        `void main() {
        if (uFocusEnabled > 0.5) {
          vec2 focusDelta = abs(vFocusWorld.xz - uFocusCenter) - uFocusHalf;
          if (max(focusDelta.x, focusDelta.y) > 0.0) discard;
        }`
      );
  }

  material.onBeforeCompile = installFocusDiscard;

  const focusDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  focusDepthMaterial.onBeforeCompile = installFocusDiscard;
  const focusSkirtMaterial = new THREE.MeshStandardMaterial({
    color: 0x6b4a33,
    roughness: 0.96,
    metalness: 0.01,
    flatShading: true,
    side: THREE.DoubleSide
  });

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
  let focusCrop: DetailWindow | null = null;
  let focusRoot: THREE.Group | null = null;
  let disposed = false;

  /**
   * Picking broad phase (PR-06). Every pick target registers its XZ footprint
   * and vertical extent; hitTest selects only the targets whose prism the ray
   * can reach before raycasting. Roads/areas are split into pick-only
   * drawRange proxies that share the rendered position buffer, so the spatial
   * index costs no vertex data and no draw calls (proxies are never rendered).
   */
  const PICK_GRID = 3;
  const pickTargets: THREE.Mesh[] = [];
  const pickBounds: PickBounds[] = [];
  const pickProxies: THREE.Mesh[] = [];
  const pickInfo = new Map<THREE.Mesh, FeatureMeshInfo>();
  /** Persistent candidate buffers: hitTest must not allocate per pointer move. */
  let pickCandidateIndices = new Uint32Array(0);
  const pickCandidateMeshes: THREE.Mesh[] = [];
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
    pickBounds.length = 0;
    // Pick proxies share the rendered position attributes and were never
    // rendered, so dropping the references is enough (no GL buffers to free).
    pickProxies.length = 0;
    pickCandidateMeshes.length = 0;
    pickCandidateIndices = new Uint32Array(0);
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

  function registerPickTarget(mesh: THREE.Mesh, info: FeatureMeshInfo, bounds: PickBounds): void {
    pickTargets.push(mesh);
    pickBounds.push(bounds);
    pickInfo.set(mesh, info);
  }

  function registerPickMesh(
    mesh: THREE.Mesh | null,
    kind: FeatureKind,
    buffers: MeshBuffers
  ): void {
    if (!mesh || buffers.featureIndices.length === 0) return;
    registerPickTarget(
      mesh,
      { kind, featureIndices: buffers.featureIndices },
      boundsForPositions(buffers.positions)
    );
  }

  /**
   * Conservative bounding sphere for a pick bucket: the bucket XZ bounds are a
   * superset of its vertices, so the sphere cannot reject a real hit.
   */
  function pickBucketSphere(bounds: PickBounds): THREE.Sphere {
    const centerX = (bounds.minX + bounds.maxX) * 0.5;
    const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
    const halfX = (bounds.maxX - bounds.minX) * 0.5;
    const halfZ = (bounds.maxZ - bounds.minZ) * 0.5;
    return new THREE.Sphere(
      new THREE.Vector3(centerX, 0, centerZ),
      Math.hypot(halfX, halfZ, bounds.maxAbsY)
    );
  }

  /**
   * Registers a merged mesh as pick targets through an n×n grid of pick-only
   * proxies: each proxy shares the rendered position attribute + triangle
   * index and limits `Raycaster` to its bucket with `geometry.drawRange`.
   * `faceIndex` is the global triangle index in that index buffer, so it maps
   * through the reordered feature table. Proxies are never rendered, so draw
   * calls and rendering are unchanged.
   */
  function registerPartitionedPick(
    mesh: THREE.Mesh | null,
    kind: FeatureKind,
    buffers: MeshBuffers
  ): void {
    if (!mesh || buffers.featureIndices.length === 0) return;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const partition = position ? partitionForPicking(buffers, PICK_GRID) : null;
    if (!position || !partition || partition.buckets.length <= 1) {
      registerPickMesh(mesh, kind, buffers);
      return;
    }
    const indexAttribute = new THREE.BufferAttribute(partition.indices, 1);
    for (const bucket of partition.buckets) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', position);
      geometry.setIndex(indexAttribute);
      geometry.setDrawRange(bucket.start, bucket.count);
      geometry.boundingSphere = pickBucketSphere(bucket.bounds);
      const proxy = new THREE.Mesh(geometry, material);
      proxy.matrixAutoUpdate = false;
      proxy.updateMatrix();
      pickProxies.push(proxy);
      // `faceIndex` for an indexed geometry is the global triangle index in
      // the shared index buffer (drawRange offsets it), so every bucket maps
      // through the full reordered feature table.
      registerPickTarget(proxy, { kind, featureIndices: partition.features }, bucket.bounds);
    }
  }

  function hitTest(clientX: number, clientY: number): HitFeature | null {
    if (disposed || !currentModel || pickTargets.length === 0) return null;
    const ndc = ndcFromClient(clientX, clientY, canvas.getBoundingClientRect());
    if (!ndc) return null;
    pointerNdc.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointerNdc, camera);
    // Broad phase before the raycast: a candidate mesh can only be hit when the
    // ray's ground-plane intersection falls inside its XZ footprint expanded by
    // maxAbsY·|dir.xz/dir.y|. Conservative, so the nearest surface (including
    // unnamed blocking geometry) is always resolved exactly as before.
    const ray = raycaster.ray;
    const candidateCount = selectPickCandidates(
      pickBounds,
      ray.origin.x,
      ray.origin.y,
      ray.origin.z,
      ray.direction.x,
      ray.direction.y,
      ray.direction.z,
      pickCandidateIndices
    );
    if (candidateCount === 0) return null;
    for (let i = 0; i < candidateCount; i += 1) {
      pickCandidateMeshes[i] = pickTargets[pickCandidateIndices[i]];
    }
    pickCandidateMeshes.length = candidateCount;
    const intersections = raycaster.intersectObjects(pickCandidateMeshes, false);
    if (intersections.length === 0) return null;
    // Nearest surface wins; an unnamed face blocks fall-through to features behind.
    const nearest = intersections[0];
    if (focusCrop) {
      const point = nearest.point;
      if (
        Math.abs(point.x - focusCrop.centerX) > focusCrop.radiusM ||
        Math.abs(point.z - focusCrop.centerZ) > focusCrop.radiusM
      ) {
        return null;
      }
    }
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
    // Roads/areas are thin but city-wide; pick-only bucket proxies let the
    // broad phase raycast the handful of buckets near the pointer instead of
    // their merged ~50k triangles (rendering stays at two draw calls).
    registerPartitionedPick(roadsMesh, 'road', buffers.roads);
    registerPartitionedPick(areasMesh, 'area', buffers.areas);
    pickCandidateIndices = new Uint32Array(pickTargets.length);
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

  function setDetailWindow(_next: DetailWindow | null): void {
    // Selection lives in the picker/store; the 3D scene only reacts to explicit
    // Focus actions, which frame the chosen square. Nothing in the rendered
    // city is muted or discarded outside it.
  }

  function clearFocusSkirt(): void {
    if (!focusRoot) return;
    for (const child of focusRoot.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    scene.remove(focusRoot);
    focusRoot = null;
  }

  function buildFocusSkirt(window: DetailWindow): void {
    clearFocusSkirt();
    if (!currentModel) return;
    const half = Math.max(1, window.radiusM);
    const cx = window.centerX;
    const cz = window.centerZ;
    const bottomY = extents.minY - 2;
    const segments = Math.max(12, Math.min(64, Math.round(half / 24)));
    const positions: number[] = [];
    const terrain = currentModel.terrain;
    const topAt = (x: number, z: number): number =>
      Math.max(0, Number.isFinite(terrainHeightM(terrain, x, z)) ? terrainHeightM(terrain, x, z) : 0) + 0.12;
    const addWall = (
      ax: number,
      az: number,
      bx: number,
      bz: number
    ): void => {
      const topA = topAt(ax, az);
      const topB = topAt(bx, bz);
      positions.push(
        ax, bottomY, az,
        bx, bottomY, bz,
        bx, topB, bz,
        ax, bottomY, az,
        bx, topB, bz,
        ax, topA, az
      );
    };
    for (let i = 0; i < segments; i += 1) {
      const a = cx - half + (i / segments) * half * 2;
      const b = cx - half + ((i + 1) / segments) * half * 2;
      addWall(a, cz + half, b, cz + half);
      addWall(a, cz - half, b, cz - half);
    }
    for (let i = 0; i < segments; i += 1) {
      const a = cz - half + (i / segments) * half * 2;
      const b = cz - half + ((i + 1) / segments) * half * 2;
      addWall(cx + half, a, cx + half, b);
      addWall(cx - half, a, cx - half, b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry, focusSkirtMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    focusRoot = new THREE.Group();
    focusRoot.name = 'focus-crop';
    focusRoot.add(mesh);
    scene.add(focusRoot);
  }

  function setFocusCrop(next: DetailWindow | null): void {
    const wasActive = focusCrop !== null;
    focusCrop = next;
    if (next) {
      focusUniforms.uFocusEnabled.value = 1;
      focusUniforms.uFocusCenter.value.set(next.centerX, next.centerZ);
      focusUniforms.uFocusHalf.value.set(next.radiusM, next.radiusM);
      buildFocusSkirt(next);
      for (const child of modelRoot.children) {
        if (child instanceof THREE.Mesh) child.customDepthMaterial = focusDepthMaterial;
      }
    } else {
      focusUniforms.uFocusEnabled.value = 0;
      clearFocusSkirt();
      for (const child of modelRoot.children) {
        if (child instanceof THREE.Mesh) child.customDepthMaterial = undefined;
      }
    }
    if (wasActive || next) {
      invalidateShadows();
      needsRender = true;
    }
  }

  function focusDetailWindow(window: DetailWindow): void {
    if (disposed) return;
    // Frame the selected square with surrounding context. The pure helper keeps
    // zoom >= the model-fit view, so Focus never pulls back into empty space
    // (the default 750 m window used to zoom *out* from 1.00 to 0.97).
    const modelRadius = currentModel?.meta.radiusM ?? DEFAULT_RADIUS_M;
    const zoom = detailFocusZoom(halfHeight, modelRadius, window.radiusM);
    setFocusCrop(window);
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
    setFocusCrop(null);
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
      modelKey,
      focus: focusCrop
        ? { centerX: focusCrop.centerX, centerZ: focusCrop.centerZ, radiusM: focusCrop.radiusM }
        : null
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setFocusCrop(null);
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
    focusDepthMaterial.dispose();
    focusSkirtMaterial.dispose();
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
