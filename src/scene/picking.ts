/**
 * Pure spatial picking math (PR-06 broad phase).
 *
 * Hover picking used to raycast every merged pick mesh (~218k triangles for a
 * normal city: 9 building chunks + the whole roads and areas meshes). This
 * module provides the two cheap spatial structures that keep exact nearest-hit
 * semantics while testing far fewer triangles:
 *
 *  1. {@link boundsForPositions} — XZ footprint + vertical extent per mesh
 *     (one per building chunk). A ray can only hit a vertical prism if its
 *     ground-plane intersection lies inside the footprint expanded by
 *     `maxAbsY · |dir.xz / dir.y|` (the horizontal travel of the ray while it
 *     crosses the mesh's height range). Selecting on that superset guarantees
 *     a hit is never missed, so the nearest visible surface (including unnamed
 *     blockers) is always resolved exactly as before.
 *
 *  2. {@link partitionForPicking} — splits a merged mesh's triangles into an
 *     n×n grid and emits a concatenated index buffer plus per-bucket feature
 *     indices. The scene turns each bucket into a pick-only `Mesh` that shares
 *     the rendered position buffer and uses `geometry.drawRange`, so the
 *     spatial index costs no vertex data (only ~4 bytes/triangle of indices)
 *     and no extra draw calls: proxy meshes are never rendered.
 *
 * Everything here is allocation-free after setup except for the return values
 * of the two builders, which run once per model load. Pure module (no
 * Three.js / DOM) so it is unit-testable in Node.
 */

import type { MeshBuffers } from './geometry.ts';

export interface PickBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Largest |y| of the source geometry (vertical half-extent of the prism). */
  maxAbsY: number;
}

export interface PickBucket {
  /** Start offset into {@link PartitionedPick.indices} (multiple of 3). */
  start: number;
  /** Index count of this bucket (multiple of 3). */
  count: number;
  bounds: PickBounds;
}

export interface PartitionedPick {
  /** Vertex indices of every source triangle, grouped bucket by bucket. */
  indices: Uint32Array;
  /** Feature index per triangle in partition order (`indices.length / 3`). */
  features: Int32Array;
  buckets: PickBucket[];
}

const EMPTY_BOUNDS: PickBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxAbsY: 0 };

/** Conservative XZ footprint + vertical extent of a non-indexed position buffer. */
export function boundsForPositions(positions: Float32Array): PickBounds {
  if (positions.length < 3) return { ...EMPTY_BOUNDS };
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let maxAbsY = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const absY = y < 0 ? -y : y;
    if (absY > maxAbsY) maxAbsY = absY;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return { ...EMPTY_BOUNDS };
  return { minX, maxX, minZ, maxZ, maxAbsY };
}

function emptyPartition(): PartitionedPick {
  return { indices: new Uint32Array(0), features: new Int32Array(0), buckets: [] };
}

/**
 * Partitions non-indexed triangles into a `grid × grid` XZ grid by triangle
 * centroid. Triangle order is preserved *within* a bucket and buckets are
 * emitted in row-major order, so `partition.features` is a pure reordering of
 * `buffers.featureIndices` (the scene uses it to resolve a proxy's `faceIndex`).
 */
export function partitionForPicking(buffers: MeshBuffers, gridSize = 3): PartitionedPick {
  const triangles = buffers.triangles;
  if (triangles <= 0 || buffers.positions.length < 9) return emptyPartition();
  const grid = Math.max(1, Math.floor(gridSize));
  if (grid === 1) {
    const indices = new Uint32Array(triangles * 3);
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      const vertex = triangle * 3;
      indices[vertex] = vertex;
      indices[vertex + 1] = vertex + 1;
      indices[vertex + 2] = vertex + 2;
    }
    return {
      indices,
      features: buffers.featureIndices.slice(0, triangles),
      buckets: [
        {
          start: 0,
          count: triangles * 3,
          bounds: boundsForPositions(buffers.positions)
        }
      ]
    };
  }

  const source = boundsForPositions(buffers.positions);
  const spanX = source.maxX - source.minX;
  const spanZ = source.maxZ - source.minZ;
  const cellX = Math.max(1, spanX / grid);
  const cellZ = Math.max(1, spanZ / grid);
  const cellCount = grid * grid;

  // Count first so the index buffer can be filled in one pass without copies.
  const counts = new Uint32Array(cellCount);
  const triangleCell = new Uint32Array(triangles);
  const positions = buffers.positions;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const vertex = triangle * 9;
    const cx = (positions[vertex] + positions[vertex + 3] + positions[vertex + 6]) / 3;
    const cz = (positions[vertex + 2] + positions[vertex + 5] + positions[vertex + 8]) / 3;
    const column = Math.max(0, Math.min(grid - 1, Math.floor((cx - source.minX) / cellX)));
    const row = Math.max(0, Math.min(grid - 1, Math.floor((cz - source.minZ) / cellZ)));
    const cell = row * grid + column;
    triangleCell[triangle] = cell;
    counts[cell] += 1;
  }

  const indices = new Uint32Array(triangles * 3);
  const features = new Int32Array(triangles);
  const buckets: PickBucket[] = [];
  let cursor = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    const count = counts[cell];
    if (count === 0) continue;
    const start = cursor;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let maxAbsY = 0;
    let featureCursor = start / 3;
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      if (triangleCell[triangle] !== cell) continue;
      const vertex = triangle * 9;
      for (let corner = 0; corner < 9; corner += 3) {
        const x = positions[vertex + corner];
        const y = positions[vertex + corner + 1];
        const z = positions[vertex + corner + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        const absY = y < 0 ? -y : y;
        if (absY > maxAbsY) maxAbsY = absY;
      }
      indices[cursor] = vertex / 3;
      indices[cursor + 1] = vertex / 3 + 1;
      indices[cursor + 2] = vertex / 3 + 2;
      cursor += 3;
      features[featureCursor] = buffers.featureIndices[triangle] ?? -1;
      featureCursor += 1;
    }
    buckets.push({
      start,
      count: count * 3,
      bounds: { minX, maxX, minZ, maxZ, maxAbsY }
    });
  }
  return { indices, features, buckets };
}

/**
 * Selects candidate pick targets for a picking ray. Returns the number of
 * indices written to `out`; `out[i]` indexes the `bounds` array.
 *
 * Conservative by construction: every target whose vertical prism can be hit
 * by the ray is included, so intersecting only the candidates cannot change
 * the nearest-hit result. A ray that cannot be projected onto the ground plane
 * (horizontal/upward, degenerate) selects every target.
 */
export function selectPickCandidates(
  bounds: readonly PickBounds[],
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  out: Uint32Array
): number {
  const total = bounds.length;
  if (total === 0) return 0;
  const writeAll = (): number => {
    const count = Math.min(total, out.length);
    for (let i = 0; i < count; i += 1) out[i] = i;
    return count;
  };
  if (!(dirY < -1e-6) || !Number.isFinite(originY)) return writeAll();
  const t = -originY / dirY;
  if (!Number.isFinite(t) || t < 0) return writeAll();
  const groundX = originX + dirX * t;
  const groundZ = originZ + dirZ * t;
  if (!Number.isFinite(groundX) || !Number.isFinite(groundZ)) return writeAll();
  const slopeX = Math.abs(dirX / dirY);
  const slopeZ = Math.abs(dirZ / dirY);
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    if (count >= out.length) return count;
    const target = bounds[i];
    const marginX = target.maxAbsY * slopeX;
    const marginZ = target.maxAbsY * slopeZ;
    if (
      groundX >= target.minX - marginX &&
      groundX <= target.maxX + marginX &&
      groundZ >= target.minZ - marginZ &&
      groundZ <= target.maxZ + marginZ
    ) {
      out[count] = i;
      count += 1;
    }
  }
  return count;
}
