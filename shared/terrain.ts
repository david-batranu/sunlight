/**
 * Terrain heightfield sampling shared by the server (bounds/culling) and the
 * renderer (draping buildings, roads, areas and trees over the ground).
 *
 * All values in the wire model are integer decimetres; scene code works in
 * metres. Helpers are pure and cheap enough to call for every footprint.
 */

import type { TerrainRecord } from './types.ts';

const DM_PER_M = 10;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True when the record has a usable grid and height array. */
export function isValidTerrain(terrain: TerrainRecord | null | undefined): terrain is TerrainRecord {
  if (!terrain || typeof terrain !== 'object') return false;
  const cols = terrain.cols;
  const rows = terrain.rows;
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    rows >= 2 &&
    Number.isFinite(terrain.x0) &&
    Number.isFinite(terrain.z0) &&
    Number.isFinite(terrain.step) &&
    terrain.step > 0 &&
    Array.isArray(terrain.h) &&
    terrain.h.length === cols * rows
  );
}

export function terrainMaxHeightDm(terrain: TerrainRecord | null | undefined): number {
  if (!isValidTerrain(terrain)) return 0;
  let max = 0;
  for (let i = 0; i < terrain.h.length; i += 1) {
    const value = terrain.h[i];
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/**
 * Bilinear terrain height in decimetres at a model-space location.
 * Coordinates outside the grid are clamped to the nearest edge sample.
 */
export function terrainHeightDm(
  terrain: TerrainRecord | null | undefined,
  xDm: number,
  zDm: number
): number {
  if (!isValidTerrain(terrain)) return 0;
  const cols = terrain.cols;
  const rows = terrain.rows;
  const fx = (finiteOr(xDm, 0) - terrain.x0) / terrain.step;
  const fz = (finiteOr(zDm, 0) - terrain.z0) / terrain.step;
  const cx = Math.max(0, Math.min(cols - 1, fx));
  const cz = Math.max(0, Math.min(rows - 1, fz));
  const x0 = Math.min(cols - 2, Math.floor(cx));
  const z0 = Math.min(rows - 2, Math.floor(cz));
  const tx = Math.max(0, Math.min(1, cx - x0));
  const tz = Math.max(0, Math.min(1, cz - z0));
  const at = (ix: number, iz: number): number => {
    const value = terrain.h[iz * cols + ix];
    return Number.isFinite(value) ? value : 0;
  };
  const h00 = at(x0, z0);
  const h10 = at(x0 + 1, z0);
  const h01 = at(x0, z0 + 1);
  const h11 = at(x0 + 1, z0 + 1);
  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return h0 + (h1 - h0) * tz;
}

/** Terrain height in metres at a model-space location. */
export function terrainHeightM(
  terrain: TerrainRecord | null | undefined,
  xM: number,
  zM: number
): number {
  return terrainHeightDm(terrain, xM * DM_PER_M, zM * DM_PER_M) / DM_PER_M;
}

/** First/last grid coordinates in decimetres (for extents and meshing). */
export function terrainExtentDm(terrain: TerrainRecord): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxHeight: number;
} {
  const maxX = terrain.x0 + terrain.step * (terrain.cols - 1);
  const maxZ = terrain.z0 + terrain.step * (terrain.rows - 1);
  return {
    minX: terrain.x0,
    maxX,
    minZ: terrain.z0,
    maxZ,
    maxHeight: terrainMaxHeightDm(terrain)
  };
}
