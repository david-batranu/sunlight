/**
 * City model builder: turns raw OSM data into the compact, deterministic,
 * decimetre-quantized `CityModel` consumed by the SPA.
 *
 * The builder is pure: same raw input + same `BuildInput` → byte-identical
 * model JSON. It is executed inside the generation worker (or in-process as a
 * fallback) and is also reused by `scripts/bake-seeds.mjs`.
 */

import { MAX_BUILDINGS, OSM_ATTRIBUTION } from '../../shared/constants.ts';
import type {
  AreaRecord,
  BuildingRecord,
  BuildingType,
  CityInfo,
  CityModel,
  CitySource,
  ModelBounds,
  ModelMeta,
  RoadRecord
} from '../../shared/types.ts';
import {
  classifyArea,
  classifyBuildingType,
  classifyRoad,
  explicitHeightM,
  heightPriorFactor,
  isBuilding,
  levelsHeightM,
  MAX_HEIGHT_M,
  MIN_HEIGHT_M,
  roofEligible,
  type AreaKind
} from './classify.ts';
import { CityError } from './errors.ts';
import {
  clampNumber,
  clipPolygonToSquare,
  clipPolylineToSquare,
  createProjection,
  dedupePoints,
  flatSignedArea,
  hash32,
  hashUnit,
  median,
  quantizePolyline,
  quantizeRing,
  simplifyPolyline,
  simplifyRing,
  type Point
} from './geometry.ts';
import { assembleRelationRings } from './osm/rings.ts';
import type { OsmTags, RawOsmData } from './raw.ts';
import { buildNodeIndex, dedupeWarnings, indexWays, memberCoordinates, wayCoordinates } from './raw.ts';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const BUILDING_TOLERANCE_M = 0.2;
const AREA_TOLERANCE_M = 0.3;
const ROAD_TOLERANCE_M = 0.6;

/** Minimum quantized footprint area in dm² (4 m²). */
const MIN_BUILDING_AREA_DM2 = 400;
/** Minimum quantized area polygon in dm² (8 m²). */
const MIN_AREA_DM2 = 800;
/** Minimum hole area in dm² (1 m²). */
const MIN_HOLE_DM2 = 100;
/** Minimum quantized road length in dm (1.5 m). */
const MIN_ROAD_LENGTH_DM = 15;
/** Spatial bucket size for the local median height prior, in metres. */
const HEIGHT_MEDIAN_CELL_M = 120;

/** Default storey height when a building carries no height tags at all. */
const FALLBACK_HEIGHT_M = 9;

export interface BuildProgressEvent {
  /** Local build progress, 0..100 (the worker maps it onto the job scale). */
  percent: number;
  label: string;
  detail?: string;
}

export type BuildProgressReporter = (event: BuildProgressEvent) => void;

export interface BuildInput {
  key: string;
  city: CityInfo;
  /** Projection centre (normally the city/target centre). */
  centerLat: number;
  centerLon: number;
  radiusM: number;
  modelVersion: number;
  source: CitySource;
  /** True when the model is written as a bundled pre-baked seed. */
  seed: boolean;
  generatedAt: string;
  attribution?: string;
  /** Warnings collected by providers (fallbacks etc). */
  warnings?: string[];
}

interface BuildingDraft {
  id: string;
  tags: OsmTags;
  flat: number[];
  areaDm2: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  hash: number;
  knownHeightM: number | null;
}

interface AreaDraft {
  id: string;
  kind: AreaKind;
  flat: number[];
  holes: number[][];
  minX: number;
  minZ: number;
  hash: number;
}

interface RoadDraft {
  id: string;
  cls: RoadRecord['c'];
  flat: number[];
  minX: number;
  minZ: number;
  hash: number;
}

interface FeatureStats {
  buildingsIn: number;
  roadsIn: number;
  areasIn: number;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function buildCityModel(raw: RawOsmData, input: BuildInput, onProgress?: BuildProgressReporter): CityModel {
  validateInput(input);
  const report = (percent: number, label: string, detail?: string): void => {
    onProgress?.({ percent, label, detail });
  };

  report(0, 'Preparing geometry');
  const projection = createProjection(input.centerLat, input.centerLon);
  const nodeIndex = buildNodeIndex(raw);
  const wayIndex = indexWays(raw);
  const half = input.radiusM;

  const diagnostics = new Map<string, number>();
  const bump = (label: string): void => {
    diagnostics.set(label, (diagnostics.get(label) ?? 0) + 1);
  };

  const featureStats: FeatureStats = { buildingsIn: 0, roadsIn: 0, areasIn: 0 };

  /* -------------------------- relations ---------------------------- */
  report(4, 'Processing multipolygon relations');
  const buildingOuters: Array<{ id: string; tags: OsmTags; outer: Point[] }> = [];
  const areaOuters: Array<{ id: string; tags: OsmTags; kind: AreaKind; outer: Point[]; holes: Point[][] }> = [];
  const consumedWays = new Set<number>();

  for (const relation of raw.relations) {
    const tags = relation.tags;
    const relationType = (tags.type ?? '').trim();
    if (relationType && relationType !== 'multipolygon') continue;
    const buildingRelation = isBuilding(tags);
    const areaKind = buildingRelation ? 0 : classifyArea(tags);
    if (!buildingRelation && !areaKind) continue;

    const memberGeometry: Array<{ role: string; points: Point[] }> = [];
    const relationWays: number[] = [];
    for (const member of relation.members) {
      if (member.type === 'relation') {
        bump('ignored nested relation members');
        continue;
      }
      if (member.type === 'node') continue;
      const coords = memberCoordinates(member, wayIndex, nodeIndex);
      if (!coords) {
        bump('skipped relation members without resolved geometry');
        continue;
      }
      relationWays.push(member.ref);
      memberGeometry.push({
        role: member.role,
        points: coords.map((coord) => projection.project(coord.lat, coord.lon))
      });
    }

    const assembly = assembleRelationRings(memberGeometry);
    const stats = assembly.stats;
    if (stats.unclosed > 0) addCount(diagnostics, 'dropped unclosed multipolygon rings', stats.unclosed);
    if (stats.degenerate > 0) addCount(diagnostics, 'dropped degenerate multipolygon rings', stats.degenerate);
    if (stats.tooSmall > 0) addCount(diagnostics, 'dropped tiny multipolygon rings', stats.tooSmall);
    if (stats.unmatchedHoles > 0) {
      addCount(diagnostics, 'dropped multipolygon holes with no outer ring', stats.unmatchedHoles);
    }
    if (stats.tinyHoles > 0) addCount(diagnostics, 'dropped tiny multipolygon holes', stats.tinyHoles);
    if (stats.ignoredRoles > 0) {
      addCount(diagnostics, 'ignored multipolygon members with unsupported roles', stats.ignoredRoles);
    }

    for (let index = 0; index < assembly.rings.length; index += 1) {
      const ring = assembly.rings[index];
      if (buildingRelation) {
        if (ring.holes.length > 0) bump('ignored courtyard holes in building relations');
        buildingOuters.push({ id: `r${relation.id}:${index}`, tags, outer: ring.outer });
      } else {
        areaOuters.push({ id: `r${relation.id}:${index}`, tags, kind: areaKind as AreaKind, outer: ring.outer, holes: ring.holes });
      }
    }
    // Only consume member ways when the relation actually produced geometry;
    // otherwise the standalone ways can still be rendered.
    if (assembly.rings.length > 0) for (const wayId of relationWays) consumedWays.add(wayId);
  }

  /* ---------------------------- ways ------------------------------- */
  report(16, 'Processing building footprints', `${raw.ways.length} ways`);
  const buildingWays: Array<{ id: string; tags: OsmTags; outer: Point[] }> = [];
  const areaWayFeatures: Array<{ id: string; tags: OsmTags; kind: AreaKind; outer: Point[]; holes: Point[][] }> = [];
  const roadFeatures: Array<{ id: string; cls: RoadRecord['c']; points: Point[] }> = [];

  for (const way of raw.ways) {
    const tags = way.tags;
    const building = isBuilding(tags);
    const closedCandidate = building || classifyArea(tags) !== 0;
    const coords = closedCandidate || classifyRoad(tags) !== 0 ? wayCoordinates(way, nodeIndex) : null;
    if (!coords) {
      if (building || classifyArea(tags) !== 0 || classifyRoad(tags) !== 0) {
        bump('skipped ways without resolved node geometry');
      }
      continue;
    }
    const closed = coords.length >= 4 && coordsCoincide(coords[0], coords[coords.length - 1]);

    if (building) {
      if (!closed) {
        bump('dropped unclosed building ways');
        continue;
      }
      if (consumedWays.has(way.id)) continue;
      const points = coords.map((coord) => projection.project(coord.lat, coord.lon));
      buildingWays.push({ id: `w${way.id}`, tags, outer: points });
      continue;
    }

    if (closed && classifyArea(tags) !== 0) {
      if (consumedWays.has(way.id)) continue;
      const points = coords.map((coord) => projection.project(coord.lat, coord.lon));
      areaWayFeatures.push({ id: `w${way.id}`, tags, kind: classifyArea(tags) as AreaKind, outer: points, holes: [] });
      continue;
    }

    const roadClass = classifyRoad(tags);
    if (roadClass !== 0) {
      const points = coords.map((coord) => projection.project(coord.lat, coord.lon));
      roadFeatures.push({ id: `w${way.id}`, cls: roadClass, points });
    }
  }

  /* ------------------------- geometry pass ------------------------- */
  report(30, 'Clipping and simplifying geometry');

  const buildingDrafts: BuildingDraft[] = [];
  const allBuildingFeatures = [...buildingOuters, ...buildingWays];
  featureStats.buildingsIn = allBuildingFeatures.length;
  for (const feature of allBuildingFeatures) {
    const clipped = clipPolygonToSquare(dedupePoints(feature.outer), half);
    if (clipped.length < 3) {
      bump('dropped buildings outside the model area');
      continue;
    }
    const simplified = simplifyRing(clipped, BUILDING_TOLERANCE_M);
    const flat = quantizeRing(simplified, MIN_BUILDING_AREA_DM2, true);
    if (!flat) {
      bump('dropped buildings below the minimum footprint');
      continue;
    }
    const areaDm2 = Math.abs(flatSignedArea(flat));
    const box = flatBounds(flat);
    const centerX = (box.minX + box.maxX) / 20;
    const centerZ = (box.minZ + box.maxZ) / 20;
    buildingDrafts.push({
      id: feature.id,
      tags: feature.tags,
      flat,
      areaDm2,
      minX: box.minX,
      minZ: box.minZ,
      maxX: box.maxX,
      maxZ: box.maxZ,
      centerX,
      centerZ,
      hash: hash32(feature.id),
      knownHeightM: explicitHeightM(feature.tags) ?? levelsHeightM(feature.tags)
    });
  }

  const areaDrafts: AreaDraft[] = [];
  featureStats.areasIn = areaOuters.length + areaWayFeatures.length;
  for (const feature of [...areaOuters, ...areaWayFeatures]) {
    const clipped = clipPolygonToSquare(dedupePoints(feature.outer), half);
    if (clipped.length < 3) {
      bump('dropped areas outside the model area');
      continue;
    }
    const simplified = simplifyRing(clipped, AREA_TOLERANCE_M);
    const flat = quantizeRing(simplified, MIN_AREA_DM2, true);
    if (!flat) {
      bump('dropped areas below the minimum area');
      continue;
    }
    const holes: number[][] = [];
    for (const hole of feature.holes) {
      const clippedHole = clipPolygonToSquare(dedupePoints(hole), half);
      if (clippedHole.length < 3) continue;
      const simplifiedHole = simplifyRing(clippedHole, AREA_TOLERANCE_M);
      const flatHole = quantizeRing(simplifiedHole, MIN_HOLE_DM2, false);
      if (!flatHole) continue;
      if (!flatContainsPoint(flat, flatHole)) continue;
      holes.push(flatHole);
    }
    const box = flatBounds(flat);
    areaDrafts.push({ id: feature.id, kind: feature.kind, flat, holes, minX: box.minX, minZ: box.minZ, hash: hash32(feature.id) });
  }

  const roadDrafts: RoadDraft[] = [];
  featureStats.roadsIn = roadFeatures.length;
  for (const feature of roadFeatures) {
    const pieces = clipPolylineToSquare(feature.points, half);
    let anyPiece = false;
    for (const piece of pieces) {
      const simplified = simplifyPolyline(piece, ROAD_TOLERANCE_M);
      const flat = quantizePolyline(simplified, MIN_ROAD_LENGTH_DM);
      if (!flat) continue;
      anyPiece = true;
      const box = flatBounds(flat);
      roadDrafts.push({
        id: feature.id,
        cls: feature.cls,
        flat,
        minX: box.minX,
        minZ: box.minZ,
        hash: hash32(feature.id)
      });
    }
    if (!anyPiece) {
      if (pieces.length === 0) bump('dropped road segments outside the model area');
      else bump('dropped road segments shorter than the minimum length');
    }
  }

  report(72, 'Inferring building heights and types');
  const { buildings, dropped } = finalizeBuildings(buildingDrafts);

  const roads = finalizeRoads(roadDrafts);
  const areas = finalizeAreas(areaDrafts);

  if (buildings.length === 0 && roads.length === 0 && areas.length === 0) {
    throw new CityError(
      'NO_DATA',
      'No OpenStreetMap buildings, roads or areas were found in this area.',
      422,
      false,
      { radiusM: input.radiusM, source: input.source }
    );
  }

  const warnings: string[] = [...raw.warnings, ...(input.warnings ?? [])];
  for (const [label, count] of diagnostics) warnings.push(`${label}: ${count}`);
  if (dropped > 0) warnings.push(`capped the model at ${MAX_BUILDINGS} buildings; dropped ${dropped} smallest footprints`);

  report(92, 'Assembling model');
  const bounds = computeBounds(buildings, roads, areas);
  const meta: ModelMeta = {
    generatedAt: input.generatedAt,
    source: input.source,
    seed: input.seed,
    radiusM: input.radiusM,
    stats: {
      buildings: buildings.length,
      roads: roads.length,
      areas: areas.length,
      dropped
    },
    warnings: dedupeWarnings(warnings, 24),
    attribution: input.attribution ?? OSM_ATTRIBUTION
  };

  const model: CityModel = {
    v: input.modelVersion,
    key: input.key,
    city: input.city,
    meta,
    bounds,
    buildings,
    roads,
    areas
  };

  report(100, 'Model built', `${buildings.length} buildings · ${roads.length} roads · ${areas.length} areas`);
  return model;
}

/* ------------------------------------------------------------------ */
/* Finalization / ordering                                             */
/* ------------------------------------------------------------------ */

function finalizeBuildings(drafts: BuildingDraft[]): { buildings: BuildingRecord[]; dropped: number } {
  const knownHeightCells = new Map<string, number[]>();
  const allKnown: number[] = [];
  for (const draft of drafts) {
    if (draft.knownHeightM === null) continue;
    const value = clampNumber(draft.knownHeightM, MIN_HEIGHT_M, MAX_HEIGHT_M);
    allKnown.push(value);
    const key = heightCellKey(draft.centerX, draft.centerZ);
    const cell = knownHeightCells.get(key);
    if (cell) cell.push(value);
    else knownHeightCells.set(key, [value]);
  }
  const globalMedian = median(allKnown) ?? FALLBACK_HEIGHT_M;

  let selected = drafts;
  let dropped = 0;
  if (drafts.length > MAX_BUILDINGS) {
    const byArea = [...drafts].sort((a, b) => b.areaDm2 - a.areaDm2 || a.hash - b.hash || compareIds(a.id, b.id));
    const keep = new Set(byArea.slice(0, MAX_BUILDINGS).map((draft) => draft.id));
    selected = drafts.filter((draft) => keep.has(draft.id));
    dropped = drafts.length - MAX_BUILDINGS;
  }

  const records: Array<{ record: BuildingRecord; draft: BuildingDraft }> = [];
  for (const draft of selected) {
    const type: BuildingType = classifyBuildingType(draft.tags);
    const heightM = resolveHeightM(draft, type, knownHeightCells, globalMedian);
    const areaM2 = draft.areaDm2 / 100;
    const record: BuildingRecord = {
      p: draft.flat,
      h: Math.round(heightM * 10),
      t: type,
      r: roofEligible(draft.tags, type, areaM2, heightM)
    };
    records.push({ record, draft });
  }
  records.sort(
    (a, b) =>
      a.draft.minX - b.draft.minX ||
      a.draft.minZ - b.draft.minZ ||
      b.draft.areaDm2 - a.draft.areaDm2 ||
      a.draft.hash - b.draft.hash ||
      compareIds(a.draft.id, b.draft.id)
  );
  return { buildings: records.map((entry) => entry.record), dropped };
}

function resolveHeightM(
  draft: BuildingDraft,
  type: BuildingType,
  heightCells: Map<string, number[]>,
  globalMedian: number
): number {
  if (draft.knownHeightM !== null) {
    return clampNumber(draft.knownHeightM, MIN_HEIGHT_M, MAX_HEIGHT_M);
  }
  const local: number[] = [];
  const cellX = Math.floor(draft.centerX / HEIGHT_MEDIAN_CELL_M);
  const cellZ = Math.floor(draft.centerZ / HEIGHT_MEDIAN_CELL_M);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const cell = heightCells.get(`${cellX + dx},${cellZ + dz}`);
      if (cell) local.push(...cell);
    }
  }
  const base = median(local) ?? globalMedian;
  const jitter = 0.85 + 0.3 * hashUnit(draft.id, 'height');
  return clampNumber(base * heightPriorFactor(type) * jitter, MIN_HEIGHT_M, MAX_HEIGHT_M);
}

function finalizeRoads(drafts: RoadDraft[]): RoadRecord[] {
  drafts.sort(
    (a, b) => a.cls - b.cls || a.minX - b.minX || a.minZ - b.minZ || a.hash - b.hash || compareIds(a.id, b.id)
  );
  return drafts.map((draft) => ({ c: draft.cls, p: draft.flat }));
}

function finalizeAreas(drafts: AreaDraft[]): AreaRecord[] {
  drafts.sort(
    (a, b) => a.kind - b.kind || a.minX - b.minX || a.minZ - b.minZ || a.hash - b.hash || compareIds(a.id, b.id)
  );
  return drafts.map((draft) => {
    const record: AreaRecord = { k: draft.kind, p: draft.flat };
    if (draft.holes.length > 0) record.holes = draft.holes;
    return record;
  });
}

function computeBounds(buildings: BuildingRecord[], roads: RoadRecord[], areas: AreaRecord[]): ModelBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let maxHeight = 0;
  const include = (flat: number[]): void => {
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] < minX) minX = flat[i];
      if (flat[i] > maxX) maxX = flat[i];
      if (flat[i + 1] < minZ) minZ = flat[i + 1];
      if (flat[i + 1] > maxZ) maxZ = flat[i + 1];
    }
  };
  for (const building of buildings) {
    include(building.p);
    if (building.h > maxHeight) maxHeight = building.h;
  }
  for (const road of roads) include(road.p);
  for (const area of areas) {
    include(area.p);
    if (area.holes) for (const hole of area.holes) include(hole);
  }
  if (!Number.isFinite(minX)) {
    throw new CityError('NO_DATA', 'The generated model contains no geometry.', 422, false);
  }
  return { minX, maxX, minZ, maxZ, maxHeight };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function validateInput(input: BuildInput): void {
  if (!Number.isFinite(input.centerLat) || !Number.isFinite(input.centerLon)) {
    throw new CityError('INVALID_TARGET', 'The generation centre must be a finite coordinate.', 400);
  }
  if (!Number.isFinite(input.radiusM) || input.radiusM <= 0) {
    throw new CityError('INVALID_TARGET', 'The city radius must be a positive number.', 400);
  }
  if (!Number.isSafeInteger(input.modelVersion) || input.modelVersion < 1) {
    throw new CityError('INVALID_MODEL_VERSION', 'The model version must be a positive integer.', 500);
  }
  if (!input.key || typeof input.key !== 'string') {
    throw new CityError('INVALID_MODEL_KEY', 'The model key must be a non-empty string.', 500);
  }
  if (Number.isNaN(Date.parse(input.generatedAt))) {
    throw new CityError('INVALID_TIMESTAMP', 'generatedAt must be an ISO-8601 timestamp.', 500);
  }
}

function coordsCoincide(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

function flatBounds(flat: number[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < minX) minX = flat[i];
    if (flat[i] > maxX) maxX = flat[i];
    if (flat[i + 1] < minZ) minZ = flat[i + 1];
    if (flat[i + 1] > maxZ) maxZ = flat[i + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** Tests whether a hole ring's first vertex lies inside a flat outer ring. */
function flatContainsPoint(outer: number[], hole: number[]): boolean {
  const px = hole[0];
  const pz = hole[1];
  let inside = false;
  for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
    const xi = outer[i];
    const zi = outer[i + 1];
    const xj = outer[j];
    const zj = outer[j + 1];
    const intersects = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function heightCellKey(x: number, z: number): string {
  return `${Math.floor(x / HEIGHT_MEDIAN_CELL_M)},${Math.floor(z / HEIGHT_MEDIAN_CELL_M)}`;
}

function addCount(diagnostics: Map<string, number>, label: string, count: number): void {
  diagnostics.set(label, (diagnostics.get(label) ?? 0) + count);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
