/* Placeholder scene — replaced by the scene workstream. */
import * as THREE from 'three';
import type { CityModel, SkyDay } from '../../shared/types.ts';
import type { SceneDebug, SceneHandle } from '../app/contracts.ts';

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e8dfcd');
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  camera.position.set(600, 600, 600);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.HemisphereLight('#fff4dd', '#5c5140', 1.6);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight('#fff0c9', 2.2);
  sun.position.set(400, 900, -600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -1200;
  sun.shadow.camera.right = 1200;
  sun.shadow.camera.top = 1200;
  sun.shadow.camera.bottom = -1200;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(1900, 40, 1900),
    new THREE.MeshLambertMaterial({ color: '#cfc4ad' })
  );
  ground.position.y = -20;
  ground.receiveShadow = true;
  scene.add(ground);

  let cityRoot: THREE.Group | null = null;
  let modelKey: string | null = null;
  let minute = 720;
  let sky: SkyDay | null = null;
  let frames = 0;
  let fps = 0;
  let fpsAt = performance.now();

  function resize(): void {
    const { clientWidth, clientHeight } = canvas.parentElement ?? document.body;
    const width = Math.max(1, clientWidth);
    const height = Math.max(1, clientHeight);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const span = 2300 / 2;
    camera.left = -span * aspect;
    camera.right = span * aspect;
    camera.top = span;
    camera.bottom = -span;
    camera.updateProjectionMatrix();
  }

  function setModel(model: CityModel): void {
    modelKey = model.key;
    if (cityRoot) {
      scene.remove(cityRoot);
      cityRoot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose?.();
      });
    }
    cityRoot = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color: '#e5d7bd' });
    for (const building of model.buildings.slice(0, 400)) {
      const ring = building.p;
      if (ring.length < 6) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]);
        maxX = Math.max(maxX, ring[i]);
        minZ = Math.min(minZ, ring[i + 1]);
        maxZ = Math.max(maxZ, ring[i + 1]);
      }
      const w = Math.max(2, (maxX - minX) / 10);
      const d = Math.max(2, (maxZ - minZ) / 10);
      const h = Math.max(2, building.h / 10);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set((minX + maxX) / 20, h / 2, (minZ + maxZ) / 20);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      cityRoot.add(mesh);
    }
    scene.add(cityRoot);
  }

  function setSky(next: SkyDay | null): void {
    sky = next;
  }

  function setTime(nextMinute: number): void {
    minute = nextMinute;
    if (sky) {
      const step = sky.track.stepMinutes;
      const index = Math.min(sky.track.sun.length - 1, Math.floor(nextMinute / step));
      const sample = sky.track.sun[index];
      if (sample) {
        const alt = (sample[0] * Math.PI) / 180;
        const az = (sample[1] * Math.PI) / 180;
        const distance = 2000;
        sun.position.set(
          Math.cos(alt) * Math.sin(az) * distance,
          Math.sin(alt) * distance,
          -Math.cos(alt) * Math.cos(az) * distance
        );
        sun.intensity = alt > 0 ? 2.2 * Math.sin(alt) + 0.15 : 0.05;
      }
    }
  }

  function loop(): void {
    renderer.render(scene, camera);
    frames += 1;
    const now = performance.now();
    if (now - fpsAt > 1000) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
    }
    requestAnimationFrame(loop);
  }

  resize();
  requestAnimationFrame(loop);

  return {
    setModel,
    setSky,
    setTime,
    setQuality() {},
    resetCamera() {
      camera.position.set(600, 600, 600);
      camera.lookAt(0, 0, 0);
    },
    resize,
    dispose() {
      renderer.dispose();
    },
    getDebug(): SceneDebug {
      const alt = Math.asin(Math.max(-1, Math.min(1, sun.position.clone().normalize().y)));
      return {
        camera: { azimuthDeg: 45, pitchDeg: 35.264, zoom: 1, target: [0, 0, 0] },
        light: {
          kind: alt > 0 ? 'sun' : 'none',
          direction: [sun.position.x, sun.position.y, sun.position.z],
          altitudeDeg: (alt * 180) / Math.PI,
          azimuthDeg: 180,
          intensity: sun.intensity,
          shadow: sun.castShadow
        },
        render: { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, fps },
        modelKey
      };
    }
  };
}
