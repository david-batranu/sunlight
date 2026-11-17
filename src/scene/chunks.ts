/**
 * Pure spatial partitioning for merged feature meshes.
 *
 * The wide-view diorama keeps one mesh per category; buildings account for the
 * majority of triangles, so splitting only that mesh into a small N×N grid lets
 * Three.js frustum-cull whole chunks when the camera zooms into a detail
 * window, while the wide view stays well under the draw-call budget.
 */

import { emptyBuffers, type MeshBuffers } from './geometry.ts';

function bucketRange(values: Float32Array, stride: number): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += stride) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { min: 0, max: 1 };
  return { min, max };
}

/** Splits non-indexed triangle buffers into an n×n grid by triangle centroid. */
export function splitMeshByGrid(buffers: MeshBuffers, gridSize = 3): MeshBuffers[] {
  const grid = Math.max(1, Math.floor(gridSize));
  if (buffers.triangles <= 0 || grid === 1) return buffers.triangles > 0 ? [buffers] : [];
  const { min: minX, max: maxX } = bucketRange(buffers.positions, 3);
  const { min: minZ, max: maxZ } = bucketRange(buffers.positions.subarray(2), 3);
  const cellX = Math.max(1, (maxX - minX) / grid);
  const cellZ = Math.max(1, (maxZ - minZ) / grid);
  const buckets: Array<{ positions: number[]; colors: number[]; features: number[] }> = Array.from(
    { length: grid * grid },
    () => ({ positions: [], colors: [], features: [] })
  );

  for (let triangle = 0; triangle < buffers.triangles; triangle += 1) {
    const vertex = triangle * 9;
    const color = triangle * 9;
    const cx =
      (buffers.positions[vertex] + buffers.positions[vertex + 3] + buffers.positions[vertex + 6]) / 3;
    const cz =
      (buffers.positions[vertex + 2] + buffers.positions[vertex + 5] + buffers.positions[vertex + 8]) / 3;
    const col = Math.max(0, Math.min(grid - 1, Math.floor((cx - minX) / cellX)));
    const row = Math.max(0, Math.min(grid - 1, Math.floor((cz - minZ) / cellZ)));
    const bucket = buckets[row * grid + col];
    for (let i = 0; i < 9; i += 1) {
      bucket.positions.push(buffers.positions[vertex + i]);
      bucket.colors.push(buffers.colors[color + i]);
    }
    bucket.features.push(buffers.featureIndices[triangle] ?? -1);
  }

  const chunks: MeshBuffers[] = [];
  for (const bucket of buckets) {
    if (bucket.features.length === 0) continue;
    chunks.push({
      positions: new Float32Array(bucket.positions),
      colors: new Float32Array(bucket.colors),
      featureIndices: new Int32Array(bucket.features),
      triangles: bucket.features.length
    });
  }
  return chunks.length > 0 ? chunks : [emptyBuffers()];
}
