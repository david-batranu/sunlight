/**
 * Multipolygon relation assembly.
 *
 * Relation member ways are joined end-to-end into closed rings, inner rings are
 * attached to their containing outer ring, and genuinely incomplete geometry is
 * dropped rather than guessed (per the project architecture doc). All work
 * happens in projected metres; callers handle clipping/simplification.
 */

import { areaOf, dedupePoints, pointInPolygon, ringCentroid, samePoint, type Point } from '../geometry.ts';

/** Maximum distance between segment endpoints that are considered connected. */
const JOIN_EPSILON_M = 0.01;

/** Minimum ring area in m²; smaller artifacts are dropped. */
export const MIN_RING_AREA_M2 = 4;

export interface RelationMemberGeometry {
  /** `outer`/`inner` (empty roles are treated as outer, like OSM does). */
  role: string;
  /** Projected coordinates in order. */
  points: Point[];
}

export interface AssembledRing {
  outer: Point[];
  holes: Point[][];
}

export interface RingAssemblyStats {
  /** Rings whose segments could not be joined into a closed loop. */
  unclosed: number;
  /** Closed rings with fewer than three distinct points. */
  degenerate: number;
  /** Outer rings below `MIN_RING_AREA_M2`. */
  tooSmall: number;
  /** Holes that did not fall inside any outer ring. */
  unmatchedHoles: number;
  /** Holes below a quarter of the minimum area. */
  tinyHoles: number;
  /** Members with roles other than outer/inner/empty. */
  ignoredRoles: number;
}

export interface RingAssemblyResult {
  rings: AssembledRing[];
  stats: RingAssemblyStats;
}

interface JoinedRings {
  rings: Point[][];
  unclosed: number;
  degenerate: number;
}

function joinSegments(segments: Point[][]): JoinedRings {
  const items = segments
    .map((points) => {
      // A single closed way arrives with (or without) its first point repeated;
      // remember that before dedupePoints strips the closing duplicate.
      const inputClosed = points.length >= 3 && samePoint(points[0], points[points.length - 1], JOIN_EPSILON_M);
      return { points: dedupePoints(points), inputClosed, used: false };
    })
    .filter((item) => item.points.length >= 2);
  const rings: Point[][] = [];
  let unclosed = 0;
  let degenerate = 0;

  for (let i = 0; i < items.length; i += 1) {
    if (items[i].used) continue;
    items[i].used = true;
    let current = items[i].points.slice();
    let closed = items[i].inputClosed || samePoint(current[0], current[current.length - 1], JOIN_EPSILON_M);

    let guard = 0;
    while (!closed) {
      guard += 1;
      if (guard > items.length + 2) break;
      const tail = current[current.length - 1];
      let extended = false;
      for (const item of items) {
        if (item.used) continue;
        const points = item.points;
        if (samePoint(tail, points[0], JOIN_EPSILON_M)) {
          current = current.concat(points.slice(1));
          item.used = true;
          extended = true;
          break;
        }
        if (samePoint(tail, points[points.length - 1], JOIN_EPSILON_M)) {
          current = current.concat(points.slice(0, -1).reverse());
          item.used = true;
          extended = true;
          break;
        }
      }
      if (!extended) break;
      closed = samePoint(current[0], current[current.length - 1], JOIN_EPSILON_M);
    }

    if (!closed) {
      unclosed += 1;
      continue;
    }
    const ring = dedupePoints(current);
    if (ring.length < 3) {
      degenerate += 1;
      continue;
    }
    rings.push(ring);
  }
  return { rings, unclosed, degenerate };
}

/**
 * Assembles projected relation member geometry into outer rings with holes.
 *
 * @param members Resolved member geometries (ways/nodes already projected).
 */
export function assembleRelationRings(members: RelationMemberGeometry[]): RingAssemblyResult {
  const outerSegments: Point[][] = [];
  const innerSegments: Point[][] = [];
  let ignoredRoles = 0;

  for (const member of members) {
    if (member.points.length < 2) continue;
    switch (member.role) {
      case '':
      case 'outer':
        outerSegments.push(member.points);
        break;
      case 'inner':
        innerSegments.push(member.points);
        break;
      default:
        ignoredRoles += 1;
    }
  }

  const outerJoin = joinSegments(outerSegments);
  const innerJoin = joinSegments(innerSegments);

  const outers: Point[][] = [];
  let tooSmall = 0;
  for (const ring of outerJoin.rings) {
    if (areaOf(ring) < MIN_RING_AREA_M2) {
      tooSmall += 1;
      continue;
    }
    outers.push(ring);
  }

  const assigned: AssembledRing[] = outers.map((outer) => ({ outer, holes: [] }));
  let unmatchedHoles = 0;
  let tinyHoles = 0;
  for (const hole of innerJoin.rings) {
    if (areaOf(hole) < MIN_RING_AREA_M2 / 4) {
      tinyHoles += 1;
      continue;
    }
    const centroid = ringCentroid(hole);
    const probe = pointInPolygon(centroid, hole) ? centroid : hole[0];
    let target: AssembledRing | null = null;
    let targetArea = Number.POSITIVE_INFINITY;
    for (const candidate of assigned) {
      if (!pointInPolygon(probe, candidate.outer)) continue;
      const area = areaOf(candidate.outer);
      if (area < targetArea) {
        target = candidate;
        targetArea = area;
      }
    }
    if (target) target.holes.push(hole);
    else unmatchedHoles += 1;
  }

  return {
    rings: assigned,
    stats: {
      unclosed: outerJoin.unclosed + innerJoin.unclosed,
      degenerate: outerJoin.degenerate + innerJoin.degenerate,
      tooSmall,
      unmatchedHoles,
      tinyHoles,
      ignoredRoles
    }
  };
}
