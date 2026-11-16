/**
 * Model extents and diorama plinth proportions.
 *
 * The wire model stores integer decimetres; the renderer converts to metres
 * (`/10`) once here. Bounds are trusted but unioned with the actual geometry
 * because fixtures/degenerate payloads occasionally disagree — the plinth,
 * camera fit and shadow frustum must always contain everything drawn.
 *
 * Pure module (no Three.js / DOM) so unit tests can read the dev fixtures.
 */

import type { CityModel } from '../../shared/types.ts';

const DECIMETRES_PER_METRE = 10;

export interface ModelExtents {
  /** World-space model centre (metres). */
  centerX: number;
  centerZ: number;
  /** Half width / depth of the actual city geometry (metres). */
  halfX: number;
  halfZ: number;
  /** Tallest point above ground, including a roof allowance (metres). */
  maxHeight: number;
  maxY: number;
  /** Lowest point of the plinth (negative, metres). */
  minY: number;
  radius: number;
  /** Depth of the stepped plinth below y = 0. */
  plinthDepth: number;
}

export interface PlinthLayer {
  halfX: number;
  halfZ: number;
  /** Layer height in metres. */
  height: number;
  /** World Y of the layer's top face. */
  topY: number;
}

export interface PlinthProfile {
  layers: readonly PlinthLayer[];
  /** Half extents of the widest (bottom) layer. */
  outerHalfX: number;
  outerHalfZ: number;
  bottomY: number;
  topY: number;
}

export const DEFAULT_RADIUS_M = 1500;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Plinth margin around the city footprint, in metres. */
export function plinthMargin(radiusM: number): number {
  return clamp(radiusM * 0.018, 8, 22);
}

/** Vertical thickness of the diorama base, in metres. */
export function plinthDepthFor(radiusM: number): number {
  return clamp(radiusM * 0.05, 18, 52);
}

/** Fallback extents used before the first model arrives. */
export function defaultExtents(): ModelExtents {
  const radius = DEFAULT_RADIUS_M;
  const plinthDepth = plinthDepthFor(radius);
  return {
    centerX: 0,
    centerZ: 0,
    halfX: radius,
    halfZ: radius,
    maxHeight: 74,
    maxY: 86,
    minY: -plinthDepth,
    radius,
    plinthDepth
  };
}

/** Builds extents (metres) from a wire model (decimetres). */
export function modelExtentsFor(model: CityModel | null): ModelExtents {
  if (!model) return defaultExtents();

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxHeightM = 0;

  const consumePoint = (xdm: number, zdm: number): void => {
    if (!Number.isFinite(xdm) || !Number.isFinite(zdm)) return;
    const x = xdm / DECIMETRES_PER_METRE;
    const z = zdm / DECIMETRES_PER_METRE;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  const consumeRing = (ring: readonly number[] | undefined): void => {
    if (!ring) return;
    for (let i = 0; i + 1 < ring.length; i += 2) consumePoint(ring[i], ring[i + 1]);
  };

  const bounds = model.bounds;
  if (bounds) {
    consumePoint(finiteOr(bounds.minX, 0), finiteOr(bounds.minZ, 0));
    consumePoint(finiteOr(bounds.maxX, 0), finiteOr(bounds.maxZ, 0));
    const height = finiteOr(bounds.maxHeight, 0) / DECIMETRES_PER_METRE;
    if (height > maxHeightM) maxHeightM = height;
  }

  for (const building of model.buildings ?? []) {
    consumeRing(building.p);
    const height = finiteOr(building.h, 0) / DECIMETRES_PER_METRE;
    if (height > maxHeightM) maxHeightM = height;
  }
  for (const road of model.roads ?? []) consumeRing(road.p);
  for (const area of model.areas ?? []) {
    consumeRing(area.p);
    if (area.holes) for (const hole of area.holes) consumeRing(hole);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return defaultExtents();
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  // Guard against a degenerate/empty city: keep at least a few hundred metres
  // of diorama base so the camera and shadows stay stable.
  const halfX = Math.max((maxX - minX) / 2, 40);
  const halfZ = Math.max((maxZ - minZ) / 2, 40);
  const radius = Math.max(halfX, halfZ, 60);
  const plinthDepth = plinthDepthFor(radius);
  // A little headroom for gable roofs / future antennae; keeps the shadow
  // camera and camera fit from clipping the tallest geometry.
  const maxHeight = Math.max(maxHeightM, 6) + 8;

  return {
    centerX,
    centerZ,
    halfX,
    halfZ,
    maxHeight,
    maxY: maxHeight,
    minY: -plinthDepth,
    radius,
    plinthDepth
  };
}

/**
 * Stepped plinth proportions: a thin top plate (the "ground"), then two
 * progressively wider clay ledges. The layers are listed top to bottom.
 */
export function plinthProfile(extents: ModelExtents): PlinthProfile {
  const radius = Math.max(extents.radius, 10);
  const depth = Math.max(extents.plinthDepth, 6);
  const marginX = plinthMargin(radius);
  const marginZ = plinthMargin(radius);

  const ledge1 = clamp(radius * 0.016, 6, 20);
  const ledge2 = clamp(radius * 0.028, 12, 32);

  const h1 = depth * 0.16;
  const h2 = depth * 0.38;
  const h3 = depth - h1 - h2;

  const topHalfX = extents.halfX + marginX;
  const topHalfZ = extents.halfZ + marginZ;

  const layers: PlinthLayer[] = [
    { halfX: topHalfX, halfZ: topHalfZ, height: h1, topY: 0 },
    { halfX: topHalfX + ledge1, halfZ: topHalfZ + ledge1, height: h2, topY: -h1 },
    {
      halfX: topHalfX + ledge1 + ledge2,
      halfZ: topHalfZ + ledge1 + ledge2,
      height: h3,
      topY: -h1 - h2
    }
  ];

  const bottom = layers[layers.length - 1];
  return {
    layers,
    outerHalfX: bottom.halfX,
    outerHalfZ: bottom.halfZ,
    bottomY: bottom.topY - bottom.height,
    topY: 0
  };
}
