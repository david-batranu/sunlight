/**
 * Feature picking helpers.
 *
 * The merged geometry carries one source-record index per triangle
 * (`MeshBuffers.featureIndices`). A raycast returns `faceIndex`, which the
 * scene resolves back through this module into a display-ready `HitFeature`.
 *
 * Only *named* features are pickable (hover tooltips + area recentering); an
 * unnamed surface under the pointer blocks fall-through and yields null.
 *
 * Pure module (no Three.js / DOM) so label mapping and record resolution are
 * unit-testable.
 */

import type { AreaRecord, BuildingRecord, CityModel, RoadRecord } from '../../shared/types.ts';
import type { HitFeature } from '../app/contracts.ts';

export type FeatureKind = 'building' | 'road' | 'area';

/** Fallback for arterial/unknown classes. */
export const ROAD_KIND_LABELS: Readonly<Record<number, string>> = {
  1: 'Main street', // arterial
  2: 'Primary street',
  3: 'Street',
  4: 'Pedestrian street',
  9: 'Railway'
};

export const AREA_KIND_LABELS: Readonly<Record<number, string>> = {
  1: 'Lake/River', // water
  2: 'Park',
  3: 'Forest',
  4: 'Square/Green'
};

export const BUILDING_FALLBACK_LABEL = 'Landmark';

/** Human label for a road class (1 arterial … 9 rail). */
export function roadKindLabel(roadClass: number): string {
  return ROAD_KIND_LABELS[roadClass] ?? 'Street';
}

/** Human label for an area kind (1 water, 2 park, 3 forest, 4 grass/plaza). */
export function areaKindLabel(areaKind: number): string {
  return AREA_KIND_LABELS[areaKind] ?? 'Square/Green';
}

/** Human label for a named building: OSM-derived `k`, else "Landmark". */
export function buildingKindLabel(building: Pick<BuildingRecord, 'k'>): string {
  const label = building.k?.trim();
  return label ? label : BUILDING_FALLBACK_LABEL;
}

function cleanName(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves a source-record index to a pickable named feature.
 * Returns null for untagged indices (-1), missing records and unnamed records.
 */
export function featureAt(
  model: CityModel | null,
  kind: FeatureKind,
  featureIndex: number
): HitFeature | null {
  if (!model || !Number.isInteger(featureIndex) || featureIndex < 0) return null;

  if (kind === 'building') {
    const record: BuildingRecord | undefined = model.buildings?.[featureIndex];
    if (!record) return null;
    const name = cleanName(record.n);
    if (!name) return null;
    return {
      kind: 'building',
      name,
      kindLabel: buildingKindLabel(record),
      heightM: Math.max(0, record.h) / 10
    };
  }

  if (kind === 'road') {
    const record: RoadRecord | undefined = model.roads?.[featureIndex];
    if (!record) return null;
    const name = cleanName(record.n);
    if (!name) return null;
    return { kind: 'road', name, kindLabel: roadKindLabel(record.c) };
  }

  const record: AreaRecord | undefined = model.areas?.[featureIndex];
  if (!record) return null;
  const name = cleanName(record.n);
  if (!name) return null;
  return { kind: 'area', name, kindLabel: areaKindLabel(record.k) };
}

/** Labels for the three merged pickable meshes, in scene raycast order. */
export interface FeatureMeshInfo {
  kind: FeatureKind;
  featureIndices: Int32Array;
}

/**
 * Maps a raycast face index through a mesh's per-triangle feature table.
 * Returns null for out-of-range/untagged faces.
 */
export function featureIndexForFace(
  featureIndices: Int32Array | null | undefined,
  faceIndex: number | null | undefined
): number | null {
  if (!featureIndices || faceIndex == null) return null;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= featureIndices.length) {
    return null;
  }
  const featureIndex = featureIndices[faceIndex];
  return featureIndex >= 0 ? featureIndex : null;
}

/** Resolves a raycast hit (mesh info + faceIndex) to a named feature. */
export function hitFeatureForFace(
  model: CityModel | null,
  info: FeatureMeshInfo | null,
  faceIndex: number | null | undefined
): HitFeature | null {
  if (!model || !info) return null;
  const featureIndex = featureIndexForFace(info.featureIndices, faceIndex);
  if (featureIndex === null) return null;
  return featureAt(model, info.kind, featureIndex);
}
