/**
 * Merged, vertex-coloured geometry for the diorama.
 *
 * One buffer per feature class keeps the scene at ~5 draw calls for a normal
 * city (plinth, buildings, roads/rail, areas, trees) regardless of how many
 * footprints the model contains. Buildings are extruded prisms with earcut
 * roofs/caps, optional gable roofs, and flat-shaded per-face normals computed
 * by Three.js from the non-indexed buffers.
 *
 * This module is pure (no Three.js, no DOM) so unit tests can build geometry
 * straight from the dev fixtures.
 */

import earcut from 'earcut';
import type { CityModel, TerrainRecord } from '../../shared/types.ts';
import {
  isValidTerrain,
  terrainHeightM,
  terrainMaxHeightDm
} from '../../shared/terrain.ts';
import { lightenRgb, mixRgb, scaleRgb, writeLinearColor, type RGB } from './color.ts';
import {
  plinthProfile,
  plinthMargin,
  type ModelExtents,
  type PlinthProfile
} from './model.ts';

const DM_PER_M = 10;
const EPSILON = 1e-6;

/** Half a metre above the ground plate, then feature-class lift layers. */
export const ROAD_LIFT_M = 0.42;
export const TERRAIN_LIFT_M = 0.05;
export const AREA_LIFT_M: Readonly<Record<number, number>> = {
  1: 0.16, // water
  2: 0.26, // park
  3: 0.32, // forest
  4: 0.2 // grass / plaza
};
export const ROAD_WIDTH_M: Readonly<Record<number, number>> = {
  1: 16,
  2: 12,
  3: 9,
  4: 6,
  9: 4.5
};

export const MAX_TREES = 700;

export interface MeshBuffers {
  positions: Float32Array;
  colors: Float32Array;
  /**
   * One entry per triangle: index of the source record in the model array
   * (buildings / roads / areas), or -1 for untagged geometry (plinth, trees).
   * Raycast `faceIndex` indexes straight into this array.
   */
  featureIndices: Int32Array;
  triangles: number;
}

export function emptyBuffers(): MeshBuffers {
  return {
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    featureIndices: new Int32Array(0),
    triangles: 0
  };
}

/* ------------------------------------------------------------------ */
/* Palette (sRGB; converted to linear when written into buffers)       */
/* ------------------------------------------------------------------ */

const BUILDING_BASE: readonly RGB[] = [
  [0.86, 0.79, 0.66], // 0 residential: warm plaster
  [0.83, 0.71, 0.51], // 1 commercial: ochre
  [0.89, 0.83, 0.74], // 2 civic: pale stone
  [0.74, 0.71, 0.63] // 3 industrial: sage grey
];
const BUILDING_HIGHLIGHT: RGB = [0.94, 0.88, 0.76];
const ROOF_COLORS: readonly RGB[] = [
  [0.66, 0.33, 0.21],
  [0.72, 0.39, 0.24],
  [0.6, 0.3, 0.2]
];
const TREE_COLORS: readonly RGB[] = [
  [0.32, 0.41, 0.26],
  [0.38, 0.47, 0.3],
  [0.28, 0.37, 0.24]
];

const GROUND_TOP: RGB = [0.8, 0.72, 0.57];
const PLINTH_SIDE_TOP: RGB = [0.68, 0.47, 0.33];
const PLINTH_SIDE_BOTTOM: RGB = [0.4, 0.26, 0.17];

const ROAD_COLORS: Readonly<Record<number, RGB>> = {
  1: [0.27, 0.25, 0.23],
  2: [0.31, 0.28, 0.25],
  3: [0.35, 0.32, 0.28],
  4: [0.42, 0.38, 0.33],
  9: [0.29, 0.27, 0.26]
};

const AREA_COLORS: Readonly<Record<number, RGB>> = {
  1: [0.34, 0.45, 0.5], // water
  2: [0.55, 0.63, 0.44], // park
  3: [0.36, 0.45, 0.32], // forest
  4: [0.62, 0.66, 0.5] // grass / plaza
};

const TERRAIN_LOW: RGB = [0.62, 0.6, 0.46];
const TERRAIN_MID: RGB = [0.44, 0.51, 0.36];
const TERRAIN_HIGH: RGB = [0.56, 0.54, 0.49];
const TERRAIN_SOIL_TOP: RGB = [0.58, 0.45, 0.32];
const TERRAIN_SOIL_BOTTOM: RGB = [0.4, 0.28, 0.19];

/** Deterministic per-building palette (also unit-tested). */
export function buildingColor(
  type: number,
  heightDm: number,
  variation: number
): RGB {
  const base = BUILDING_BASE[Math.max(0, Math.min(BUILDING_BASE.length - 1, type | 0))];
  const heightFactor = Math.max(0, Math.min(1, heightDm / 500));
  const lit = mixRgb(base, BUILDING_HIGHLIGHT, heightFactor * 0.3);
  return scaleRgb(lit, 0.94 + 0.1 * Math.max(0, Math.min(1, variation)));
}

export function roofColorFor(variation: number): RGB {
  const index = Math.max(
    0,
    Math.min(ROOF_COLORS.length - 1, Math.floor(variation * ROOF_COLORS.length))
  );
  return scaleRgb(ROOF_COLORS[index], 0.95 + 0.1 * variation);
}

export function roadColorFor(roadClass: number, variation: number): RGB {
  const base = ROAD_COLORS[roadClass] ?? ROAD_COLORS[4];
  return scaleRgb(base, 0.94 + 0.12 * variation);
}

export function areaColorFor(kind: number, variation: number): RGB {
  const base = AREA_COLORS[kind] ?? AREA_COLORS[4];
  return scaleRgb(base, 0.95 + 0.1 * variation);
}

export function treeColorFor(index: number): RGB {
  const color = TREE_COLORS[Math.abs(index) % TREE_COLORS.length];
  return color;
}

/* ------------------------------------------------------------------ */
/* Deterministic noise                                                 */
/* ------------------------------------------------------------------ */

/** Integer hash in [0, 1); identical across engines (no Math.sin tricks). */
export function hashUnit(value: number): number {
  let x = (value | 0) + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** FNV-1a hash of a string, returned as a signed 32-bit integer seed. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Buffer builder                                                      */
/* ------------------------------------------------------------------ */

class MeshBuilder {
  private positions: Float32Array;
  private colors: Float32Array;
  private features: Int32Array;
  private length = 0;
  private featuresWritten = 0;
  private feature = -1;

  constructor(initialFloats = 4096) {
    const capacity = Math.max(initialFloats, 96);
    this.positions = new Float32Array(capacity);
    this.colors = new Float32Array(capacity);
    this.features = new Int32Array(Math.ceil(capacity / 9));
  }

  get triangleCount(): number {
    return this.featuresWritten;
  }

  /** Tags every triangle emitted from now on with a source-record index. */
  setFeature(index: number): void {
    this.feature = Number.isFinite(index) ? index | 0 : -1;
  }

  private reserve(extraFloats: number): void {
    const needed = this.length + extraFloats;
    if (needed <= this.positions.length) return;
    let capacity = this.positions.length * 2;
    while (capacity < needed) capacity *= 2;
    const positions = new Float32Array(capacity);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Float32Array(capacity);
    colors.set(this.colors);
    this.colors = colors;
    const featureCapacity = Math.ceil(capacity / 9);
    if (featureCapacity > this.features.length) {
      const features = new Int32Array(featureCapacity);
      features.set(this.features.subarray(0, this.featuresWritten));
      this.features = features;
    }
  }

  private pushFeature(): void {
    const triangleIndex = this.featuresWritten;
    if (triangleIndex >= this.features.length) this.reserve(9);
    this.features[triangleIndex] = this.feature;
    this.featuresWritten += 1;
  }

  private vertex(x: number, y: number, z: number, color: RGB): void {
    this.reserve(3);
    const offset = this.length;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    writeLinearColor(this.colors, offset, color);
    this.length += 3;
  }

  /** Triangle a-b-c, wound so its normal points along (nx, ny, nz). */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    color: RGB,
    nx: number, ny: number, nz: number
  ): void {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < EPSILON) return;
    // Second triangle winding must be consistent; two calls keep it simple.
    if (crossX * nx + crossY * ny + crossZ * nz > 0) {
      this.vertex(ax, ay, az, color);
      this.vertex(bx, by, bz, color);
      this.vertex(cx, cy, cz, color);
    } else {
      this.vertex(ax, ay, az, color);
      this.vertex(cx, cy, cz, color);
      this.vertex(bx, by, bz, color);
    }
    this.pushFeature();
  }

  /**
   * Quad ring a→b→c→d (a,b are the "bottom" pair; c,d the "top" pair) wound so
   * its normal points along (nx, ny, nz). `topColor` lets vertical slabs fade.
   */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    color: RGB,
    nx: number, ny: number, nz: number,
    topColor: RGB = color
  ): void {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < EPSILON) return;
    const flip = crossX * nx + crossY * ny + crossZ * nz <= 0;
    const push = (x: number, y: number, z: number, c: RGB): void => this.vertex(x, y, z, c);
    if (!flip) {
      push(ax, ay, az, color); // t1: a,b,c
      push(bx, by, bz, color);
      push(cx, cy, cz, topColor);
      push(ax, ay, az, color); // t2: a,c,d
      push(cx, cy, cz, topColor);
      push(dx, dy, dz, topColor);
    } else {
      push(ax, ay, az, color); // t1: a,c,b
      push(cx, cy, cz, topColor);
      push(bx, by, bz, color);
      push(ax, ay, az, color); // t2: a,d,c
      push(dx, dy, dz, topColor);
      push(cx, cy, cz, topColor);
    }
    this.pushFeature(); // t1
    this.pushFeature(); // t2
  }

  /** Horizontal triangle at height y, normal up, robust to input winding. */
  triUp(
    x0: number, z0: number,
    x1: number, z1: number,
    x2: number, z2: number,
    y: number,
    color: RGB
  ): void {
    // n_y = (z1-z0)(x2-x0) - (x1-x0)(z2-z0); require > 0.
    const c = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0);
    if (Math.abs(c) < EPSILON) return;
    if (c <= 0) {
      this.vertex(x0, y, z0, color);
      this.vertex(x1, y, z1, color);
      this.vertex(x2, y, z2, color);
    } else {
      this.vertex(x0, y, z0, color);
      this.vertex(x2, y, z2, color);
      this.vertex(x1, y, z1, color);
    }
    this.pushFeature();
  }

  finish(): MeshBuffers {
    if (this.length === 0) return emptyBuffers();
    return {
      positions: this.positions.slice(0, this.length),
      colors: this.colors.slice(0, this.length),
      featureIndices: this.features.slice(0, this.featuresWritten),
      triangles: this.featuresWritten
    };
  }
}

/* ------------------------------------------------------------------ */
/* Ring helpers                                                        */
/* ------------------------------------------------------------------ */

interface Ring2D {
  xs: number[];
  zs: number[];
}

function loadRing2D(ring: readonly number[] | undefined, out: Ring2D): number {
  out.xs.length = 0;
  out.zs.length = 0;
  if (!ring) return 0;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const x = ring[i] / DM_PER_M;
    const z = ring[i + 1] / DM_PER_M;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const n = out.xs.length;
    if (n > 0 && Math.abs(out.xs[n - 1] - x) < 1e-4 && Math.abs(out.zs[n - 1] - z) < 1e-4) {
      continue; // collapse consecutive duplicates
    }
    out.xs.push(x);
    out.zs.push(z);
  }
  return out.xs.length;
}

function signedArea2(ring: Ring2D, count: number): number {
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    area += ring.xs[i] * ring.zs[j] - ring.xs[j] * ring.zs[i];
  }
  return area;
}

/** Even-odd point-in-polygon test on a flat [x, z, ...] ring. */
export function pointInRing(x: number, z: number, ring: readonly number[]): boolean {
  const count = Math.floor(ring.length / 2);
  if (count < 3) return false;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z) {
      const xCross = ((xj - xi) * (z - zi)) / (zj - zi) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------------------------------------------ */
/* Terrain heightfield                                                */
/* ------------------------------------------------------------------ */

function terrainColor(heightM: number, maxHeightM: number, variation: number): RGB {
  const t = maxHeightM > 0.5 ? Math.max(0, Math.min(1, heightM / maxHeightM)) : 0;
  const base =
    t <= 0.5
      ? mixRgb(TERRAIN_LOW, TERRAIN_MID, t * 2)
      : mixRgb(TERRAIN_MID, TERRAIN_HIGH, (t - 0.5) * 2);
  return scaleRgb(base, 0.94 + 0.1 * Math.max(0, Math.min(1, variation)));
}

/**
 * Builds the terrain heightfield mesh plus perimeter skirt walls.
 * Returns empty buffers when the model has no usable terrain.
 */
export function buildTerrain(model: CityModel | null): MeshBuffers {
  const terrain = model?.terrain;
  if (!isValidTerrain(terrain)) return emptyBuffers();

  const builder = new MeshBuilder(12288);
  builder.setFeature(-1);
  const cols = terrain.cols;
  const rows = terrain.rows;
  const x0 = terrain.x0 / DM_PER_M;
  const z0 = terrain.z0 / DM_PER_M;
  const step = terrain.step / DM_PER_M;
  const maxHeightM = terrainMaxHeightDm(terrain) / DM_PER_M;
  const heightAt = (col: number, row: number): number =>
    terrain.h[row * cols + col] / DM_PER_M + TERRAIN_LIFT_M;

  for (let row = 0; row + 1 < rows; row += 1) {
    const za = z0 + row * step;
    const zb = za + step;
    for (let col = 0; col + 1 < cols; col += 1) {
      const xa = x0 + col * step;
      const xb = xa + step;
      const h00 = heightAt(col, row);
      const h10 = heightAt(col + 1, row);
      const h01 = heightAt(col, row + 1);
      const h11 = heightAt(col + 1, row + 1);
      const variance = hashUnit(row * 92821 + col * 68917 + 7);
      const colorA = terrainColor((h00 + h10 + h11) / 3, maxHeightM, variance);
      const colorB = terrainColor((h00 + h11 + h01) / 3, maxHeightM, hashUnit(variance * 9973));
      builder.tri(xa, h00, za, xb, h10, za, xb, h11, zb, colorA, 0, 1, 0);
      builder.tri(xa, h00, za, xb, h11, zb, xa, h01, zb, colorB, 0, 1, 0);
    }
  }

  // Perimeter skirt: hides the open underside when terrain is elevated at
  // the model edge (common for hill towns).
  const pushSkirt = (
    ax: number, az: number, ah: number,
    bx: number, bz: number, bh: number,
    nx: number, nz: number
  ): void => {
    if (ah < 0.02 && bh < 0.02) return;
    builder.quad(
      ax, 0, az,
      bx, 0, bz,
      bx, bh, bz,
      ax, ah, az,
      TERRAIN_SOIL_BOTTOM,
      nx, 0, nz,
      TERRAIN_SOIL_TOP
    );
  };
  for (let col = 0; col + 1 < cols; col += 1) {
    const xa = x0 + col * step;
    const xb = xa + step;
    pushSkirt(xa, z0, heightAt(col, 0), xb, z0, heightAt(col + 1, 0), 0, -1);
    const zs = z0 + (rows - 1) * step;
    pushSkirt(xa, zs, heightAt(col, rows - 1), xb, zs, heightAt(col + 1, rows - 1), 0, 1);
  }
  for (let row = 0; row + 1 < rows; row += 1) {
    const za = z0 + row * step;
    const zb = za + step;
    pushSkirt(x0, za, heightAt(0, row), x0, zb, heightAt(0, row + 1), -1, 0);
    const xe = x0 + (cols - 1) * step;
    pushSkirt(xe, za, heightAt(cols - 1, row), xe, zb, heightAt(cols - 1, row + 1), 1, 0);
  }

  return builder.finish();
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

function pushGableRoof(
  builder: MeshBuilder,
  ring: Ring2D,
  wallTopY: number,
  roofColor: RGB,
  gableColor: RGB
): void {
  const ax = ring.xs[0];
  const az = ring.zs[0];
  const bx = ring.xs[1];
  const bz = ring.zs[1];
  const cx = ring.xs[2];
  const cz = ring.zs[2];
  const dx = ring.xs[3];
  const dz = ring.zs[3];

  const ab = Math.hypot(bx - ax, bz - az);
  const bc = Math.hypot(cx - bx, cz - bz);
  const cd = Math.hypot(dx - cx, dz - cz);
  const da = Math.hypot(ax - dx, az - dz);
  if (Math.min(ab, bc, cd, da) < 1.2) return;

  const centerX = (ax + bx + cx + dx) / 4;
  const centerZ = (az + bz + cz + dz) / 4;

  const mid = (
    x0: number, z0: number, x1: number, z1: number
  ): [number, number] => [(x0 + x1) / 2, (z0 + z1) / 2];

  if (ab + cd >= bc + da) {
    // Ridge parallel to the a-b / c-d pair.
    const [r0x, r0z] = mid(dx, dz, ax, az);
    const [r1x, r1z] = mid(bx, bz, cx, cz);
    const [maX, maZ] = mid(ax, az, bx, bz);
    const [mcX, mcZ] = mid(cx, cz, dx, dz);
    const span = Math.hypot(mcX - maX, mcZ - maZ);
    const roofH = Math.max(1.2, Math.min(9, span * 0.32));
    const ridgeY = wallTopY + roofH;
    // Front slope a,b,R1,R0; back slope c,d,R0,R1.
    builder.quad(
      ax, wallTopY, az, bx, wallTopY, bz, r1x, ridgeY, r1z, r0x, ridgeY, r0z,
      roofColor, 0, 1, 0
    );
    builder.quad(
      cx, wallTopY, cz, dx, wallTopY, dz, r0x, ridgeY, r0z, r1x, ridgeY, r1z,
      roofColor, 0, 1, 0
    );
    const outLeftX = r0x - centerX;
    const outLeftZ = r0z - centerZ;
    builder.tri(dx, wallTopY, dz, ax, wallTopY, az, r0x, ridgeY, r0z, gableColor, outLeftX, 0, outLeftZ);
    const outRightX = r1x - centerX;
    const outRightZ = r1z - centerZ;
    builder.tri(bx, wallTopY, bz, cx, wallTopY, cz, r1x, ridgeY, r1z, gableColor, outRightX, 0, outRightZ);
  } else {
    // Ridge parallel to the b-c / d-a pair.
    const [r0x, r0z] = mid(ax, az, bx, bz);
    const [r1x, r1z] = mid(cx, cz, dx, dz);
    const [maX, maZ] = mid(bx, bz, cx, cz);
    const [mcX, mcZ] = mid(dx, dz, ax, az);
    const span = Math.hypot(mcX - maX, mcZ - maZ);
    const roofH = Math.max(1.2, Math.min(9, span * 0.32));
    const ridgeY = wallTopY + roofH;
    builder.quad(
      bx, wallTopY, bz, cx, wallTopY, cz, r1x, ridgeY, r1z, r0x, ridgeY, r0z,
      roofColor, 0, 1, 0
    );
    builder.quad(
      dx, wallTopY, dz, ax, wallTopY, az, r0x, ridgeY, r0z, r1x, ridgeY, r1z,
      roofColor, 0, 1, 0
    );
    const outX0 = r0x - centerX;
    const outZ0 = r0z - centerZ;
    builder.tri(ax, wallTopY, az, bx, wallTopY, bz, r0x, ridgeY, r0z, gableColor, outX0, 0, outZ0);
    const outX1 = r1x - centerX;
    const outZ1 = r1z - centerZ;
    builder.tri(cx, wallTopY, cz, dx, wallTopY, dz, r1x, ridgeY, r1z, gableColor, outX1, 0, outZ1);
  }
}

export function buildBuildings(model: CityModel): MeshBuffers {
  const builder = new MeshBuilder(16384);
  const terrain = isValidTerrain(model.terrain) ? model.terrain : null;
  const ring: Ring2D = { xs: [], zs: [] };
  const flat: number[] = [];
  const buildings = model.buildings ?? [];
  for (let index = 0; index < buildings.length; index += 1) {
    builder.setFeature(index);
    const building = buildings[index];
    const count = loadRing2D(building.p, ring);
    if (count < 3) continue;
    const area2 = signedArea2(ring, count);
    if (Math.abs(area2) < 2) continue; // footprint smaller than ~1 m²

    const height = Math.max(0.8, (Number.isFinite(building.h) ? building.h : 0) / DM_PER_M);
    let groundY = 0;
    if (terrain) {
      let sumX = 0;
      let sumZ = 0;
      for (let i = 0; i < count; i += 1) {
        sumX += ring.xs[i];
        sumZ += ring.zs[i];
      }
      groundY = terrainHeightM(terrain, sumX / count, sumZ / count);
    }
    const wallTop = groundY + height;
    const baseBottom = terrain ? groundY - 0.6 : 0;
    const variation = hashUnit(index * 2 + 17);
    const wallColor = buildingColor(building.t ?? 0, building.h ?? 0, variation);
    const roofColor = roofColorFor(hashUnit(index * 3 + 29));
    const orientation = area2 > 0 ? 1 : -1;

    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      const ax = ring.xs[i];
      const az = ring.zs[i];
      const bx = ring.xs[j];
      const bz = ring.zs[j];
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 0.05) continue;
      const nx = (orientation * dz) / length;
      const nz = (-orientation * dx) / length;
      builder.quad(
        ax, baseBottom, az,
        bx, baseBottom, bz,
        bx, wallTop, bz,
        ax, wallTop, az,
        wallColor, nx, 0, nz
      );
    }

    const roofEligible =
      building.r === 1 && count === 4 && (building.h ?? 0) <= 300 && Math.abs(area2) > 12;

    if (roofEligible) {
      pushGableRoof(builder, ring, wallTop, roofColor, wallColor);
    } else {
      flat.length = 0;
      for (let i = 0; i < count; i += 1) {
        flat.push(ring.xs[i], ring.zs[i]);
      }
      let triangles: number[] = [];
      try {
        triangles = earcut(flat, null, 2);
      } catch {
        triangles = [];
      }
      const capColor = lightenRgb(wallColor, 0.05);
      for (let t = 0; t + 2 < triangles.length; t += 3) {
        const i0 = triangles[t];
        const i1 = triangles[t + 1];
        const i2 = triangles[t + 2];
        builder.triUp(
          ring.xs[i0], ring.zs[i0],
          ring.xs[i1], ring.zs[i1],
          ring.xs[i2], ring.zs[i2],
          wallTop,
          capColor
        );
      }
    }

    // Sink the footprint slightly below the sampled ground to hide seams on
    // slopes; on flat models this is hidden by the plinth top.
  }
  return builder.finish();
}

/* ------------------------------------------------------------------ */
/* Roads and rail                                                      */
/* ------------------------------------------------------------------ */

export function buildRoads(model: CityModel): MeshBuffers {
  const builder = new MeshBuilder(8192);
  const terrain = isValidTerrain(model.terrain) ? model.terrain : null;
  const ring: Ring2D = { xs: [], zs: [] };
  const roads = model.roads ?? [];
  for (let index = 0; index < roads.length; index += 1) {
    builder.setFeature(index);
    const road = roads[index];
    const count = loadRing2D(road.p, ring);
    if (count < 2) continue;
    const width = ROAD_WIDTH_M[road.c] ?? 7;
    const half = width / 2;
    const color = roadColorFor(road.c, hashUnit(index * 5 + 101));
    const lift = ROAD_LIFT_M + (road.c === 9 ? -0.03 : 0);
    const groundAt = (x: number, z: number): number =>
      lift + (terrain ? terrainHeightM(terrain, x, z) : 0);

    for (let i = 0; i + 1 < count; i += 1) {
      const ax = ring.xs[i];
      const az = ring.zs[i];
      const bx = ring.xs[i + 1];
      const bz = ring.zs[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 0.2) continue;
      const nx = (-dz / length) * half;
      const nz = (dx / length) * half;
      // Quad a-left, b-left, b-right, a-right (draped over terrain).
      builder.quad(
        ax + nx, groundAt(ax + nx, az + nz), az + nz,
        bx + nx, groundAt(bx + nx, bz + nz), bz + nz,
        bx - nx, groundAt(bx - nx, bz - nz), bz - nz,
        ax - nx, groundAt(ax - nx, az - nz), az - nz,
        color, 0, 1, 0
      );
    }

    // Fill small gaps at polyline joints (same colour, so overdraw is
    // invisible) — keeps corners from looking notched on long roads.
    if (road.c !== 9) {
      for (let i = 0; i < count; i += 1) {
        if (i === 0 || i === count - 1) continue;
        const x = ring.xs[i];
        const z = ring.zs[i];
        const e = half * 0.62;
        builder.quad(
          x - e, groundAt(x - e, z - e), z - e,
          x + e, groundAt(x + e, z - e), z - e,
          x + e, groundAt(x + e, z + e), z + e,
          x - e, groundAt(x - e, z + e), z + e,
          color, 0, 1, 0
        );
      }
    }
  }
  return builder.finish();
}

/* ------------------------------------------------------------------ */
/* Areas (water / parks / forests / grass, with holes)                 */
/* ------------------------------------------------------------------ */

export function buildAreas(model: CityModel): MeshBuffers {
  const builder = new MeshBuilder(8192);
  const terrain = isValidTerrain(model.terrain) ? model.terrain : null;
  const flat: number[] = [];
  const holeIndices: number[] = [];
  const areas = model.areas ?? [];
  for (let index = 0; index < areas.length; index += 1) {
    builder.setFeature(index);
    const area = areas[index];
    flat.length = 0;
    holeIndices.length = 0;
    const ring = area.p;
    if (!ring || ring.length < 6) continue;

    let vertexCount = 0;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const x = ring[i] / DM_PER_M;
      const z = ring[i + 1] / DM_PER_M;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      flat.push(x, z);
      vertexCount += 1;
    }
    if (vertexCount < 3) continue;

    if (area.holes) {
      for (const hole of area.holes) {
        if (!hole || hole.length < 6) continue;
        const start = flat.length / 2;
        let added = 0;
        for (let i = 0; i + 1 < hole.length; i += 2) {
          const x = hole[i] / DM_PER_M;
          const z = hole[i + 1] / DM_PER_M;
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
          flat.push(x, z);
          added += 1;
        }
        if (added >= 3) holeIndices.push(start);
      }
    }

    let triangles: number[] = [];
    try {
      triangles = earcut(flat, holeIndices.length > 0 ? holeIndices : null, 2);
    } catch {
      continue;
    }
    const kind = area.k ?? 4;
    // Keep draped areas below the road layer (roads stay readable on slopes).
    const lift = (AREA_LIFT_M[kind] ?? 0.22) + (terrain ? 0.06 : 0);
    const color = areaColorFor(kind, hashUnit(index * 7 + 211));
    let emitted = 0;

    const pushTriangle = (
      ax: number, az: number,
      bx: number, bz: number,
      cx: number, cz: number,
      depth: number
    ): void => {
      if (!terrain) {
        builder.triUp(ax, az, bx, bz, cx, cz, lift, color);
        return;
      }
      const ya = terrainHeightM(terrain, ax, az) + lift;
      const yb = terrainHeightM(terrain, bx, bz) + lift;
      const yc = terrainHeightM(terrain, cx, cz) + lift;
      const ab = Math.hypot(bx - ax, bz - az);
      const bc = Math.hypot(cx - bx, cz - bz);
      const ca = Math.hypot(ax - cx, az - cz);
      const maxEdge = Math.max(ab, bc, ca);
      const centerY = terrainHeightM(terrain, (ax + bx + cx) / 3, (az + bz + cz) / 3) + lift;
      const linearY = (ya + yb + yc) / 3;
      const error = Math.abs(centerY - linearY);
      if ((maxEdge > 22 || error > 0.12) && depth < 6 && emitted < 3000) {
        const mabx = (ax + bx) / 2;
        const mabz = (az + bz) / 2;
        const mbcx = (bx + cx) / 2;
        const mbcz = (bz + cz) / 2;
        const mcax = (cx + ax) / 2;
        const mcaz = (cz + az) / 2;
        pushTriangle(ax, az, mabx, mabz, mcax, mcaz, depth + 1);
        pushTriangle(mabx, mabz, bx, bz, mbcx, mbcz, depth + 1);
        pushTriangle(mcax, mcaz, mbcx, mbcz, cx, cz, depth + 1);
        pushTriangle(mabx, mabz, mbcx, mbcz, mcax, mcaz, depth + 1);
        return;
      }
      builder.tri(ax, ya, az, bx, yb, bz, cx, yc, cz, color, 0, 1, 0);
      emitted += 1;
    };

    for (let t = 0; t + 2 < triangles.length; t += 3) {
      const i0 = triangles[t];
      const i1 = triangles[t + 1];
      const i2 = triangles[t + 2];
      pushTriangle(
        flat[i0 * 2], flat[i0 * 2 + 1],
        flat[i1 * 2], flat[i1 * 2 + 1],
        flat[i2 * 2], flat[i2 * 2 + 1],
        0
      );
    }
  }
  return builder.finish();
}

/* ------------------------------------------------------------------ */
/* Plinth (diorama base)                                               */
/* ------------------------------------------------------------------ */

function sideColorAt(profile: PlinthProfile, fraction: number): RGB {
  void profile;
  return mixRgb(PLINTH_SIDE_TOP, PLINTH_SIDE_BOTTOM, Math.max(0, Math.min(1, fraction)));
}

export function buildPlinth(extents: ModelExtents): MeshBuffers {
  const builder = new MeshBuilder(512);
  const profile = plinthProfile(extents);
  const centerX = extents.centerX;
  const centerZ = extents.centerZ;
  const depth = Math.max(1, extents.plinthDepth);

  profile.layers.forEach((layer, layerIndex) => {
    const topY = layer.topY;
    const bottomY = topY - layer.height;
    const halfX = layer.halfX;
    const halfZ = layer.halfZ;
    const isGround = layerIndex === 0;
    const topColor = isGround
      ? GROUND_TOP
      : mixRgb(PLINTH_SIDE_TOP, PLINTH_SIDE_BOTTOM, Math.min(0.85, -topY / depth) * 0.9);
    const sideTopColor = sideColorAt(profile, -topY / depth);
    const sideBottomColor = sideColorAt(profile, -bottomY / depth);

    // Top face — the ground plate for the top layer, a visible ledge below.
    builder.quad(
      centerX - halfX, topY, centerZ - halfZ,
      centerX + halfX, topY, centerZ - halfZ,
      centerX + halfX, topY, centerZ + halfZ,
      centerX - halfX, topY, centerZ + halfZ,
      topColor, 0, 1, 0
    );

    // Four vertical sides, outward-facing.
    builder.quad(
      centerX - halfX, bottomY, centerZ + halfZ,
      centerX + halfX, bottomY, centerZ + halfZ,
      centerX + halfX, topY, centerZ + halfZ,
      centerX - halfX, topY, centerZ + halfZ,
      sideBottomColor, 0, 0, 1, sideTopColor
    );
    builder.quad(
      centerX + halfX, bottomY, centerZ - halfZ,
      centerX - halfX, bottomY, centerZ - halfZ,
      centerX - halfX, topY, centerZ - halfZ,
      centerX + halfX, topY, centerZ - halfZ,
      sideBottomColor, 0, 0, -1, sideTopColor
    );
    builder.quad(
      centerX + halfX, bottomY, centerZ + halfZ,
      centerX + halfX, bottomY, centerZ - halfZ,
      centerX + halfX, topY, centerZ - halfZ,
      centerX + halfX, topY, centerZ + halfZ,
      sideBottomColor, 1, 0, 0, sideTopColor
    );
    builder.quad(
      centerX - halfX, bottomY, centerZ - halfZ,
      centerX - halfX, bottomY, centerZ + halfZ,
      centerX - halfX, topY, centerZ + halfZ,
      centerX - halfX, topY, centerZ - halfZ,
      sideBottomColor, -1, 0, 0, sideTopColor
    );
  });

  return builder.finish();
}

/* ------------------------------------------------------------------ */
/* Trees                                                               */
/* ------------------------------------------------------------------ */

export interface TreeSite {
  x: number;
  z: number;
  baseY: number;
  height: number;
  radius: number;
  colorIndex: number;
}

function loadFlatRingMetres(ring: readonly number[] | undefined, out: number[]): number {
  out.length = 0;
  if (!ring) return 0;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const x = ring[i] / DM_PER_M;
    const z = ring[i + 1] / DM_PER_M;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    out.push(x, z);
  }
  return out.length / 2;
}

function insideArea(x: number, z: number, rings: readonly number[][]): boolean {
  if (rings.length === 0 || !pointInRing(x, z, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(x, z, rings[i])) return false;
  }
  return true;
}

/** Deterministic low-poly tree placement inside parks and forests. */
export function sampleTreeSites(model: CityModel): TreeSite[] {
  const sites: TreeSite[] = [];
  const modelSeed = hashString(model.key ?? 'sunlight');
  const areas = model.areas ?? [];
  const outer: number[] = [];
  const holes: number[][] = [];
  let areaIndex = 0;

  for (const area of areas) {
    if (sites.length >= MAX_TREES) break;
    const kind = area.k ?? 4;
    if (kind !== 2 && kind !== 3) continue;
    const count = loadFlatRingMetres(area.p, outer);
    areaIndex += 1;
    if (count < 3) continue;

    holes.length = 0;
    if (area.holes) {
      for (const hole of area.holes) {
        const flatHole: number[] = [];
        if (loadFlatRingMetres(hole, flatHole) >= 3) holes.push(flatHole);
      }
    }
    const rings = [outer, ...holes];

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i + 1 < outer.length; i += 2) {
      if (outer[i] < minX) minX = outer[i];
      if (outer[i] > maxX) maxX = outer[i];
      if (outer[i + 1] < minZ) minZ = outer[i + 1];
      if (outer[i + 1] > maxZ) maxZ = outer[i + 1];
    }
    if (!Number.isFinite(minX) || maxX - minX < 1 || maxZ - minZ < 1) continue;

    const step = kind === 3 ? 11 : 13;
    const rng = mulberry32((modelSeed ^ Math.imul(areaIndex + 3, 0x9e3779b9)) | 0);
    const lift = AREA_LIFT_M[kind] ?? 0.26;

    outerLoop: for (let gz = minZ + step * 0.5; gz < maxZ; gz += step) {
      for (let gx = minX + step * 0.5; gx < maxX; gx += step) {
        const x = gx + (rng() - 0.5) * step * 0.7;
        const z = gz + (rng() - 0.5) * step * 0.7;
        const jitterA = rng();
        const jitterB = rng();
        const colorJitter = rng();
        if (!insideArea(x, z, rings)) continue;
        sites.push({
          x,
          z,
          baseY: lift + (isValidTerrain(model.terrain) ? terrainHeightM(model.terrain, x, z) : 0),
          height: 6.5 + jitterA * 6,
          radius: 2.3 + jitterB * 1.5,
          colorIndex: Math.floor(colorJitter * TREE_COLORS.length)
        });
        if (sites.length >= MAX_TREES) break outerLoop;
      }
    }
  }
  return sites;
}

export function buildTrees(sites: readonly TreeSite[]): MeshBuffers {
  const builder = new MeshBuilder(2048);
  const SIDES = 6;
  for (const site of sites) {
    const mainColor = treeColorFor(site.colorIndex);
    const topColor = lightenRgb(mainColor, 0.035);
    const x = site.x;
    const z = site.z;
    const baseY = site.baseY;
    const height = site.height;
    const radius = site.radius;

    const pushCone = (
      baseRadius: number,
      baseHeight: number,
      coneHeight: number,
      color: RGB
    ): void => {
      const apexY = baseHeight + coneHeight;
      for (let side = 0; side < SIDES; side += 1) {
        const a0 = (side / SIDES) * Math.PI * 2;
        const a1 = ((side + 1) / SIDES) * Math.PI * 2;
        const x0 = x + Math.cos(a0) * baseRadius;
        const z0 = z + Math.sin(a0) * baseRadius;
        const x1 = x + Math.cos(a1) * baseRadius;
        const z1 = z + Math.sin(a1) * baseRadius;
        const midAngle = (a0 + a1) / 2;
        // Outward-up face normal.
        const nx = Math.cos(midAngle) * coneHeight * 0.8 + Math.cos(midAngle) * baseRadius;
        const nz = Math.sin(midAngle) * coneHeight * 0.8 + Math.sin(midAngle) * baseRadius;
        const ny = Math.max(0.2, baseRadius * 0.6);
        builder.tri(x, apexY, z, x0, baseHeight, z0, x1, baseHeight, z1, color, nx, ny, nz);
      }
    };

    pushCone(radius, baseY, height * 0.72, mainColor);
    pushCone(radius * 0.62, baseY + height * 0.5, height * 0.5, topColor);
  }
  return builder.finish();
}

/** Convenience for placing a model: all merged buffers in one call. */
export interface ModelBuffers {
  plinth: MeshBuffers;
  terrain: MeshBuffers;
  buildings: MeshBuffers;
  roads: MeshBuffers;
  areas: MeshBuffers;
  trees: MeshBuffers;
  treeCount: number;
}

export function buildModelBuffers(model: CityModel | null, extents: ModelExtents): ModelBuffers {
  if (!model) {
    return {
      plinth: buildPlinth(extents),
      terrain: emptyBuffers(),
      buildings: emptyBuffers(),
      roads: emptyBuffers(),
      areas: emptyBuffers(),
      trees: emptyBuffers(),
      treeCount: 0
    };
  }
  const treeSites = sampleTreeSites(model);
  return {
    plinth: buildPlinth(extents),
    terrain: buildTerrain(model),
    buildings: buildBuildings(model),
    roads: buildRoads(model),
    areas: buildAreas(model),
    trees: buildTrees(treeSites),
    treeCount: treeSites.length
  };
}

/** Radius used for shadow-camera sizing (widest plinth ledge + margin). */
export function shadowRadiusFor(extents: ModelExtents): number {
  const profile = plinthProfile(extents);
  return Math.max(profile.outerHalfX, profile.outerHalfZ) + plinthMargin(extents.radius) + 16;
}
