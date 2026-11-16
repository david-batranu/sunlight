/**
 * Static guards for the scene module contract: the public surface, the
 * transparent-canvas rule, and the "no store / no UI imports" boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sceneDir = fileURLToPath(new URL('../../src/scene/', import.meta.url));

function sceneSources(): Array<{ name: string; source: string }> {
  return readdirSync(sceneDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(`${sceneDir}${name}`, 'utf8') }));
}

test('scene.ts exports createScene for main.ts', async () => {
  const module = await import('../../src/scene/scene.ts');
  assert.equal(typeof module.createScene, 'function');
  assert.deepEqual(Object.keys(module).sort(), ['createScene']);
});

test('the scene never imports the store, UI, API or main entry', () => {
  const forbidden = [
    "../app/state",
    "../app/api",
    "../app/url",
    "../ui/",
    "../main",
    "./state",
    "./ui"
  ];
  for (const { name, source } of sceneSources()) {
    for (const line of source.split('\n')) {
      if (!line.trim().startsWith('import')) continue;
      for (const needle of forbidden) {
        assert.ok(!line.includes(needle), `${name} must not import ${needle}: ${line.trim()}`);
      }
    }
  }
});

test('the canvas stays transparent: no scene.background paint', () => {
  const scene = sceneSources().find((file) => file.name === 'scene.ts');
  assert.ok(scene);
  assert.ok(scene.source.includes('alpha: true'), 'WebGLRenderer must be created with alpha');
  assert.ok(
    /setClearColor\(0x000000,\s*0\)/.test(scene.source),
    'clear colour must be fully transparent'
  );
  assert.ok(
    !/scene\.background\s*=/.test(scene.source),
    'scene.background must stay null so the CSS sky shows through'
  );
});

test('only the sun and moon may cast shadows (no extra shadow lights)', () => {
  const scene = sceneSources().find((file) => file.name === 'scene.ts');
  assert.ok(scene);
  const castShadowLights = scene.source.match(/new THREE\.DirectionalLight/g) ?? [];
  assert.equal(castShadowLights.length, 2, 'exactly two directional lights');
  assert.equal((scene.source.match(/new THREE\.HemisphereLight/g) ?? []).length, 1);
  assert.ok(!scene.source.includes('new THREE.PointLight'));
  assert.ok(!scene.source.includes('new THREE.SpotLight'));
});

test('scene implements the picking contract without painting the canvas', () => {
  const scene = sceneSources().find((file) => file.name === 'scene.ts');
  assert.ok(scene);
  for (const method of ['hitTest', 'getCameraAzimuth', 'getGroundPoint']) {
    assert.ok(
      new RegExp(`function ${method}\\(|${method}:`).test(scene.source),
      `scene.ts must implement ${method}`
    );
  }
  // The pickable meshes and their per-triangle feature tables are registered
  // when a model is built, and cleared again on dispose.
  assert.ok(scene.source.includes('registerPickMesh'), 'buildings/roads/areas registered');
  assert.ok(scene.source.includes('pickTargets'), 'raycast targets stored');
  assert.ok(scene.source.includes('pickInfo'), 'feature tables stored');
  assert.ok(scene.source.includes('hitFeatureForFace'), 'face → record resolution wired');
  // Raycast NDC + ground helpers come from the pure camera module.
  assert.ok(scene.source.includes('ndcFromClient'));
  assert.ok(scene.source.includes('groundPointFromRay'));
});
