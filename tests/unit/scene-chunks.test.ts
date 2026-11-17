import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyBuffers, type MeshBuffers } from '../../src/scene/geometry.ts';
import { splitMeshByGrid } from '../../src/scene/chunks.ts';

function triangle(x: number, z: number, feature: number): number[] {
  return [x, 0, z, x + 10, 0, z, x, 0, z + 10];
}

function makeBuffers(triangles: Array<[number, number, number]>): MeshBuffers {
  const positions: number[] = [];
  const colors: number[] = [];
  const features: number[] = [];
  for (const [x, z, feature] of triangles) {
    positions.push(...triangle(x, z, feature));
    colors.push(...Array.from({ length: 9 }, () => 0.5));
    features.push(feature);
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    featureIndices: new Int32Array(features),
    triangles: features.length
  };
}

test('grid splitting preserves every triangle exactly once', () => {
  const source = makeBuffers([
    [-900, -900, 1],
    [-100, -100, 2],
    [450, -200, 3],
    [800, 800, 4],
    [0, 0, 5]
  ]);
  const chunks = splitMeshByGrid(source, 3);
  assert.ok(chunks.length > 1);
  const triangleCount = chunks.reduce((sum, chunk) => sum + chunk.triangles, 0);
  assert.equal(triangleCount, source.triangles);
  const features = chunks.flatMap((chunk) => Array.from(chunk.featureIndices)).sort((a, b) => a - b);
  assert.deepEqual(features, [1, 2, 3, 4, 5]);
  for (const chunk of chunks) {
    assert.equal(chunk.positions.length, chunk.triangles * 9);
    assert.equal(chunk.colors.length, chunk.triangles * 9);
  }
});

test('empty and one-cell meshes are handled', () => {
  assert.deepEqual(splitMeshByGrid(emptyBuffers(), 3), []);
  const single = makeBuffers([[0, 0, 7]]);
  assert.deepEqual(splitMeshByGrid(single, 1), [single]);
});
