/**
 * Unit tests for the picking broad phase (PR-06).
 *
 * The selection rule must be conservative: a triangle hit by a ray always has
 * its bucket selected, so filtering candidates before `Raycaster` cannot
 * change the nearest-hit result. Run with:
 *   node --test tests/unit/scene-*.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { emptyBuffers, type MeshBuffers } from '../../src/scene/geometry.ts';
import {
  boundsForPositions,
  partitionForPicking,
  selectPickCandidates,
  type PickBounds
} from '../../src/scene/picking.ts';

function triangle(
  x: number,
  z: number,
  feature: number,
  y = 0,
  size = 10
): { vertices: number[]; feature: number } {
  return {
    vertices: [x, y, z, x + size, y, z, x, y, z + size],
    feature
  };
}

function makeBuffers(
  triangles: Array<{ vertices: number[]; feature: number }>
): MeshBuffers {
  const positions: number[] = [];
  const colors: number[] = [];
  const features: number[] = [];
  for (const entry of triangles) {
    positions.push(...entry.vertices);
    colors.push(...Array.from({ length: 9 }, () => 0.5));
    features.push(entry.feature);
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    featureIndices: new Int32Array(features),
    triangles: features.length
  };
}

function select(
  bounds: readonly PickBounds[],
  origin: [number, number, number],
  direction: [number, number, number]
): number[] {
  const out = new Uint32Array(bounds.length);
  const count = selectPickCandidates(
    bounds,
    origin[0],
    origin[1],
    origin[2],
    direction[0],
    direction[1],
    direction[2],
    out
  );
  return Array.from(out.subarray(0, count));
}

const DOWN: [number, number, number] = [0, -1, 0];

/** Ray origin 2000 m above the given ground point for the given direction. */
function originAbove(
  groundX: number,
  groundZ: number,
  direction: readonly [number, number, number],
  height = 2000
): [number, number, number] {
  const t = -height / direction[1];
  return [groundX - direction[0] * t, height, groundZ - direction[2] * t];
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

test('boundsForPositions covers the XZ footprint and vertical extent', () => {
  const buffers = makeBuffers([
    triangle(-40, 20, 1, 3, 10),
    { vertices: [15, -7, -30, 25, 11, -18, 12, 4, -2], feature: 2 }
  ]);
  const bounds = boundsForPositions(buffers.positions);
  assert.deepEqual(bounds, {
    minX: -40,
    maxX: 25,
    minZ: -30,
    maxZ: 30,
    maxAbsY: 11
  });
  assert.deepEqual(boundsForPositions(emptyBuffers().positions), {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    maxAbsY: 0
  });
});

/* ------------------------------------------------------------------ */
/* Partitioning                                                        */
/* ------------------------------------------------------------------ */

test('partitionForPicking preserves every triangle, its feature and its bounds', () => {
  const entries: Array<{ vertices: number[]; feature: number }> = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      entries.push(triangle(column * 350 - 500, row * 350 - 500, row * 3 + column));
    }
  }
  const buffers = makeBuffers(entries);
  const partition = partitionForPicking(buffers, 3);
  assert.ok(partition.buckets.length > 1, 'synthetic grid should span several buckets');
  assert.equal(partition.indices.length, buffers.triangles * 3);
  assert.equal(partition.features.length, buffers.triangles);

  // Every source triangle appears exactly once, in bucket order, and its
  // feature index follows the reordering.
  const seen = new Uint8Array(buffers.triangles);
  for (const bucket of partition.buckets) {
    assert.equal(bucket.start % 3, 0);
    assert.equal(bucket.count % 3, 0);
    for (let i = bucket.start; i < bucket.start + bucket.count; i += 3) {
      const firstVertex = partition.indices[i];
      assert.equal(partition.indices[i + 1], firstVertex + 1);
      assert.equal(partition.indices[i + 2], firstVertex + 2);
      assert.equal(firstVertex % 3, 0, 'index must start a triangle');
      const sourceTriangle = firstVertex / 3;
      assert.equal(seen[sourceTriangle], 0, 'triangle listed twice');
      seen[sourceTriangle] = 1;
      assert.equal(
        partition.features[i / 3],
        buffers.featureIndices[sourceTriangle],
        'bucket feature indices must follow the reordered triangle'
      );
      // Bucket bounds must contain all three vertices.
      const offset = sourceTriangle * 9;
      for (let corner = 0; corner < 9; corner += 3) {
        const x = buffers.positions[offset + corner];
        const y = buffers.positions[offset + corner + 1];
        const z = buffers.positions[offset + corner + 2];
        assert.ok(x >= bucket.bounds.minX && x <= bucket.bounds.maxX);
        assert.ok(z >= bucket.bounds.minZ && z <= bucket.bounds.maxZ);
        assert.ok(Math.abs(y) <= bucket.bounds.maxAbsY);
      }
    }
  }
  assert.deepEqual(seen, new Uint8Array(buffers.triangles).fill(1));
});

test('partitionForPicking handles empty data and the single-bucket case', () => {
  assert.deepEqual(partitionForPicking(emptyBuffers(), 3).buckets, []);
  const buffers = makeBuffers([triangle(0, 0, 4)]);
  const partition = partitionForPicking(buffers, 3);
  assert.equal(partition.buckets.length, 1);
  assert.equal(partition.buckets[0].count, 3);
  assert.deepEqual(Array.from(partition.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(partition.features), [4]);
});

/* ------------------------------------------------------------------ */
/* Candidate selection                                                 */
/* ------------------------------------------------------------------ */

const BOX: PickBounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxAbsY: 5 };
const FAR: PickBounds = { minX: 100, maxX: 110, minZ: 100, maxZ: 110, maxAbsY: 5 };

test('a straight-down ray selects only the prisms under its ground point', () => {
  assert.deepEqual(select([BOX, FAR], [5, 2000, 5], DOWN), [0]);
  assert.deepEqual(select([BOX, FAR], [105, 2000, 105], DOWN), [1]);
  assert.deepEqual(select([BOX, FAR], [-50, 2000, -50], DOWN), []);
});

test('an oblique ray expands the footprint by height / tan(pitch)', () => {
  // Ground point 4 m west of the box; travelling east while descending.
  const direction: [number, number, number] = [1, -1, 0];
  assert.deepEqual(
    select([BOX], originAbove(-4, 5, direction), direction),
    [0],
    '5 m of height reaches in'
  );
  const shorter: PickBounds = { ...BOX, maxAbsY: 3 };
  assert.deepEqual(
    select([shorter], originAbove(-4, 5, direction), direction),
    [],
    '3 m of height cannot reach 4 m horizontally'
  );
  // The same margin applies on the Z axis with a northward ray.
  const southward: [number, number, number] = [0, -1, 1];
  assert.deepEqual(select([BOX], originAbove(5, -4, southward), southward), [0]);
});

test('degenerate rays fall back to every target instead of dropping hits', () => {
  assert.deepEqual(select([BOX, FAR], [5, 2000, 5], [1, 0, 0]), [0, 1]);
  assert.deepEqual(select([BOX, FAR], [5, 2000, 5], [0, 1, 0]), [0, 1]);
  assert.deepEqual(select([BOX, FAR], [Number.NaN, 2000, 5], DOWN), [0, 1]);
  assert.deepEqual(select([BOX, FAR], [5, 2000, 5], [0, -0, 0]), [0, 1]);
});

test('selection never overflows a short output buffer', () => {
  const short = new Uint32Array(1);
  const count = selectPickCandidates(
    [BOX, FAR],
    5,
    2000,
    5,
    0,
    -1,
    0,
    short
  );
  assert.ok(count <= short.length);
  assert.equal(count, 1);
});

/* ------------------------------------------------------------------ */
/* Conservative property: every hit triangle's bucket is selected      */
/* ------------------------------------------------------------------ */

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Double-sided Möller–Trumbore: any geometric hit counts (selection is
 *  independent of face orientation). */
function rayHitsTriangle(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number]
): boolean {
  const edge1: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const edge2: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const pvec = cross(direction, edge2);
  const det = dot(edge1, pvec);
  if (Math.abs(det) < 1e-9) return false;
  const inverse = 1 / det;
  const tvec: [number, number, number] = [
    origin[0] - a[0],
    origin[1] - a[1],
    origin[2] - a[2]
  ];
  const u = dot(tvec, pvec) * inverse;
  if (u < 0 || u > 1) return false;
  const qvec = cross(tvec, edge1);
  const v = dot(direction, qvec) * inverse;
  if (v < 0 || u + v > 1) return false;
  return dot(edge2, qvec) * inverse > 1e-9;
}

test('every triangle hit by a sampled ray belongs to a selected bucket', () => {
  // Deterministic pseudo-random generator keeps the property test reproducible.
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const entries: Array<{ vertices: number[]; feature: number }> = [];
  for (let i = 0; i < 320; i += 1) {
    const x = (random() - 0.5) * 600;
    const z = (random() - 0.5) * 600;
    const y = random() * 45;
    const width = 4 + random() * 55;
    const depth = 4 + random() * 55;
    entries.push({
      vertices: [x, y, z, x + width, y, z, x + width * 0.3, y, z + depth],
      feature: i
    });
  }
  const buffers = makeBuffers(entries);
  const partition = partitionForPicking(buffers, 3);

  // Map each source triangle to its bucket (via the partition index buffer).
  const bucketOfTriangle = new Int32Array(buffers.triangles).fill(-1);
  partition.buckets.forEach((bucket, bucketIndex) => {
    for (let i = bucket.start; i < bucket.start + bucket.count; i += 3) {
      bucketOfTriangle[partition.indices[i] / 3] = bucketIndex;
    }
  });

  const boundsForBuckets = partition.buckets.map((bucket) => bucket.bounds);
  let checkedHits = 0;
  for (let ray = 0; ray < 320; ray += 1) {
    const azimuth = random() * Math.PI * 2;
    const pitch = ((18 + random() * 54) * Math.PI) / 180; // controls clamp
    const direction: [number, number, number] = [
      Math.cos(pitch) * Math.sin(azimuth),
      -Math.sin(pitch),
      -Math.cos(pitch) * Math.cos(azimuth)
    ];
    // Camera-like origin 2500 m above the model, aimed so the ground point
    // lands inside the city square.
    const groundX = (random() - 0.5) * 500;
    const groundZ = (random() - 0.5) * 500;
    const origin = originAbove(groundX, groundZ, direction, 2500);
    const selected = new Set(select(boundsForBuckets, origin, direction));
    for (let triangleIndex = 0; triangleIndex < buffers.triangles; triangleIndex += 1) {
      const offset = triangleIndex * 9;
      const p = buffers.positions;
      const a = [p[offset], p[offset + 1], p[offset + 2]] as const;
      const b = [p[offset + 3], p[offset + 4], p[offset + 5]] as const;
      const c = [p[offset + 6], p[offset + 7], p[offset + 8]] as const;
      if (!rayHitsTriangle(origin, direction, a, b, c)) continue;
      checkedHits += 1;
      assert.ok(
        selected.has(bucketOfTriangle[triangleIndex]),
        `ray ${ray} hits triangle ${triangleIndex} but its bucket was not selected`
      );
    }
  }
  assert.ok(checkedHits > 30, `property test should exercise real hits (got ${checkedHits})`);
});

/* ------------------------------------------------------------------ */
/* Scene wiring                                                        */
/* ------------------------------------------------------------------ */

test('scene.ts routes hitTest through the broad phase and registered proxies', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/scene/scene.ts', import.meta.url)),
    'utf8'
  );
  assert.ok(source.includes("from './picking.ts'"));
  assert.ok(source.includes('selectPickCandidates('), 'hitTest must filter candidates');
  assert.ok(source.includes('registerPartitionedPick('), 'roads/areas use bucket proxies');
  assert.ok(source.includes('pickCandidateIndices'), 'candidate index buffer is persistent');
  assert.ok(
    !/raycaster\.intersectObjects\(pickTargets, false\)/.test(source),
    'hitTest must not raycast all pick targets'
  );
});
