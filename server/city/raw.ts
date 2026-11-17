/**
 * Intermediate representation of OSM data, shared by every provider/parser.
 *
 * The shape is intentionally flat and structured-clone friendly: it is sent to
 * the generation worker and merged across tiled OSM API responses.
 */

import type { CitySource } from '../../shared/types.ts';

export type OsmTags = Record<string, string>;

export interface RawCoord {
  lat: number;
  lon: number;
}

export interface RawNode {
  id: number;
  lat: number;
  lon: number;
}

export interface RawWay {
  id: number;
  /** Node ids, in order. Empty when `geometry` is embedded (Overpass `out geom`). */
  nodes: number[];
  /** Inline geometry from Overpass, or resolved from `nodes` for OSM XML. */
  geometry?: RawCoord[];
  tags: OsmTags;
}

export type RawMemberType = 'node' | 'way' | 'relation';

export interface RawRelationMember {
  type: RawMemberType;
  ref: number;
  role: string;
  /** Inline geometry for way members from Overpass `out geom`. */
  geometry?: RawCoord[];
  /** Coordinate for node members from Overpass `out geom`. */
  lat?: number;
  lon?: number;
}

export interface RawRelation {
  id: number;
  members: RawRelationMember[];
  tags: OsmTags;
}

export interface RawOsmData {
  source: CitySource;
  nodes: RawNode[];
  ways: RawWay[];
  relations: RawRelation[];
  /** Non-fatal issues surfaced by the provider/parser (deduped, bounded). */
  warnings: string[];
  /**
   * True when the provider knowingly returned incomplete coverage (e.g. a tile
   * budget was exhausted). The service marks such models as degraded.
   */
  partial?: boolean;
}

export function emptyRawOsmData(source: CitySource, warnings: string[] = []): RawOsmData {
  return { source, nodes: [], ways: [], relations: [], warnings: [...warnings] };
}

export function rawOsmElementCount(data: RawOsmData): number {
  return data.nodes.length + data.ways.length + data.relations.length;
}

/**
 * Merges tiled provider results, deduplicating by element id.
 *
 * Tile order is deterministic (providers fetch tiles in a fixed depth-first
 * order), and the first occurrence wins, so merged geometry is deterministic
 * for a given set of responses.
 */
export function mergeRawOsmData(parts: RawOsmData[], source: CitySource): RawOsmData {
  const nodes = new Map<number, RawNode>();
  const ways = new Map<number, RawWay>();
  const relations = new Map<number, RawRelation>();
  const warnings: string[] = [];
  for (const part of parts) {
    for (const node of part.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const way of part.ways) if (!ways.has(way.id)) ways.set(way.id, way);
    for (const relation of part.relations) if (!relations.has(relation.id)) relations.set(relation.id, relation);
    warnings.push(...part.warnings);
  }
  return {
    source,
    nodes: [...nodes.values()],
    ways: [...ways.values()],
    relations: [...relations.values()],
    warnings: dedupeWarnings(warnings, 24)
  };
}

export function dedupeWarnings(warnings: string[], limit = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const warning of warnings) {
    const text = String(warning ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.length > 300 ? `${text.slice(0, 299)}…` : text);
    if (out.length >= limit) break;
  }
  return out;
}

/** Builds an id → coordinate index for the node-based OSM XML representation. */
export function buildNodeIndex(data: RawOsmData): Map<number, RawCoord> {
  const index = new Map<number, RawCoord>();
  for (const node of data.nodes) index.set(node.id, { lat: node.lat, lon: node.lon });
  return index;
}

/**
 * Resolves the ordered coordinates of a way.
 *
 * Returns `null` when a node reference cannot be resolved (clipped tile edge),
 * so callers can drop the geometry deliberately instead of guessing.
 */
export function wayCoordinates(way: RawWay, nodeIndex: Map<number, RawCoord>): RawCoord[] | null {
  if (way.geometry && way.geometry.length >= 2) return way.geometry;
  if (way.nodes.length < 2) return null;
  const coords: RawCoord[] = [];
  for (const id of way.nodes) {
    const node = nodeIndex.get(id);
    if (!node) return null;
    coords.push(node);
  }
  return coords;
}

/** Resolves the ordered coordinates of a relation way member. */
export function memberCoordinates(
  member: RawRelationMember,
  wayIndex: Map<number, RawWay>,
  nodeIndex: Map<number, RawCoord>
): RawCoord[] | null {
  if (member.geometry && member.geometry.length >= 2) return member.geometry;
  if (member.type === 'node' && typeof member.lat === 'number' && typeof member.lon === 'number') {
    return [{ lat: member.lat, lon: member.lon }];
  }
  if (member.type !== 'way') return null;
  const way = wayIndex.get(member.ref);
  if (!way) return null;
  return wayCoordinates(way, nodeIndex);
}

export function indexWays(data: RawOsmData): Map<number, RawWay> {
  const index = new Map<number, RawWay>();
  for (const way of data.ways) index.set(way.id, way);
  return index;
}
