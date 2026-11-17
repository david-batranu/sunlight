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
  fitBoxFor,
  fitHalfHeight,
  fitTargetY,
  groundPointFromRay,
  ndcFromClient,
  orthoFrustum,
  wrapAzimuth
} from './camera.ts';
import { DioramaControls } from './controls.ts';
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

export type SceneQuality = 'high' | 'low';

interface QualitySettings {
  dprCap: number;
  shadowMapSize: number;
  showTrees: boolean;
}

const QUALITY: Readonly<Record<SceneQuality, QualitySettings>> = {
  high: { dprCap: 2, shadowMapSize: 2048, showTrees: true },
  low: { dprCap: 1.25, shadowMapSize: 1024, showTrees: false }
};

const CAMERA_NEAR = 5;
const CAMERA_FAR = 14000;
const FPS_WINDOW_MS = 500;
const SHADOW_ALTITUDE_STEP = 0.5;

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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  let quality: SceneQuality = 'high';
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
  /* Rendering loop                                                    */
  /* ---------------------------------------------------------------- */

  let animationFrame = 0;
  let lastFrameAt = 0;
  let fpsFrames = 0;
  let fpsSince = 0;
  let fps = 0;

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
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3));
    geometry.computeVertexNormals();
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

  function resize(): void {
    const width = Math.max(
      1,
      Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth)
    );
    const height = Math.max(
      1,
      Math.round(canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight)
    );
    aspect = width / height;
    viewportHeight = height;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[quality].dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    halfHeight = fitHalfHeight(fitBox, aspect);
    applyProjection();
    controls.setViewMetrics(halfHeight, height);
    updateCamera();
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
    buildingsMesh = addMesh(buffers.buildings, true, true);
    roadsMesh = addMesh(buffers.roads, false, true);
    areasMesh = addMesh(buffers.areas, false, true);
    treesMesh = addMesh(buffers.trees, true, true);
    registerPickMesh(buildingsMesh, 'building', buffers.buildings);
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
    detailWindow = nextDetailWindow;
    if (nextDetailWindow) {
      detailUniforms.uDetailEnabled.value = 1;
      detailUniforms.uDetailCenter.value.set(nextDetailWindow.centerX, nextDetailWindow.centerZ);
      detailUniforms.uDetailHalf.value.set(nextDetailWindow.radiusM, nextDetailWindow.radiusM);
    } else {
      detailUniforms.uDetailEnabled.value = 0;
    }
  }

  function focusDetailWindow(window: DetailWindow): void {
    if (disposed) return;
    // Show the selected square with surrounding context, but never pull the
    // camera so far back that it shows empty space beyond the loaded model.
    const modelRadius = currentModel?.meta.radiusM ?? 1500;
    const desiredHeight = Math.min(
      Math.max(360, window.radiusM * 2 * 2.4),
      modelRadius * 2 * 1.05
    );
    const zoom = Math.max(0.45, Math.min(32, (halfHeight * 2) / desiredHeight));
    controls.setFocus(window.centerX, window.centerZ, zoom);
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

  function getDebug(): SceneDebug {
    const kind = lightState.kind;
    const active =
      kind === 'sun' ? lightState.sun : kind === 'moon' ? lightState.moon : lightState.none;
    const loop = currentFps();
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
      render: {
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        fps: loop
      },
      modelKey
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    window.removeEventListener('resize', resize);
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
  /* FPS + frame loop                                                  */
  /* ---------------------------------------------------------------- */

  function currentFps(): number {
    return fps > 0 ? Math.round(fps) : 0;
  }

  function frame(now: number): void {
    if (disposed) return;
    animationFrame = requestAnimationFrame(frame);
    const dt = lastFrameAt > 0 ? Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000)) : 1 / 60;
    lastFrameAt = now;
    if (fps === 0) {
      // Give E2E/debug consumers a sane number before the first full window.
      fps = Math.min(240, 1 / Math.max(dt, 1 / 240));
    }
    controls.update(dt);
    updateCamera();
    renderer.render(scene, camera);

    fpsFrames += 1;
    if (fpsSince === 0) {
      fpsSince = now;
    } else if (now - fpsSince >= FPS_WINDOW_MS) {
      const sample = (fpsFrames * 1000) / (now - fpsSince);
      fps = fps > 0 ? fps * 0.7 + sample * 0.3 : sample;
      fpsFrames = 0;
      fpsSince = now;
    }
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
    renderer.render(scene, camera);
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);
  window.addEventListener('resize', resize, { passive: true });

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
    resetCamera,
    resize,
    dispose,
    getDebug,
    hitTest,
    getCameraAzimuth,
    getGroundPoint
  };
}
