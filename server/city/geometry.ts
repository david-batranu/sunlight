/**
 * Geometry helpers for city generation.
 *
 * Conventions:
 *  - Local model space is metres: +X east, -Z north (so +Z south).
 *  - Rings are stored as open point arrays (`[[x,z], ...]`, first point is not
 *    repeated at the end).
 *  - Persisted decimetre rings are flat `[x0, z0, x1, z1, ...]` integer arrays
 *    with outer rings counter-clockwise in the (x, z) plane and holes
 *    clockwise.
 */

import { CityError } from './errors.ts';

export type Point = [number, number];

/** Metres per degree of latitude (spherical Earth, plenty for a 2 km diorama). */
export const METRES_PER_DEG_LAT = 111_320;

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Projection {
  readonly centerLat: number;
  readonly centerLon: number;
  /** Projects WGS84 lat/lon to local metres (+X east, -Z north). */
  project(lat: number, lon: number): Point;
}

export function createProjection(centerLat: number, centerLon: number): Projection {
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new CityError('INVALID_TARGET', 'Projection centre must be finite.', 400);
  }
  const cosLat = Math.max(0.0001, Math.cos((centerLat * Math.PI) / 180));
  const metresPerDegLon = METRES_PER_DEG_LAT * cosLat;
  return {
    centerLat,
    centerLon,
    project(lat: number, lon: number): Point {
      return [(lon - centerLon) * metresPerDegLon, -(lat - centerLat) * METRES_PER_DEG_LAT];
    }
  };
}

/* ------------------------------------------------------------------ */
/* Geography                                                           */
/* ------------------------------------------------------------------ */

/** Great-circle distance in kilometres. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Square-ish lat/lon bounding boxes covering the requested radius.
 *
 * Returns two boxes when the range crosses the antimeridian so providers can
 * query both halves; results are deterministic (eastern half first).
 */
export function bboxesForRadius(centerLat: number, centerLon: number, radiusM: number): BoundingBox[] {
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon) || !Number.isFinite(radiusM) || radiusM <= 0) {
    throw new CityError('INVALID_TARGET', 'Invalid coordinates or radius for a bounding box.', 400);
  }
  const latHalf = radiusM / METRES_PER_DEG_LAT;
  const cosLat = Math.max(0.0001, Math.cos((centerLat * Math.PI) / 180));
  const lonHalf = radiusM / (METRES_PER_DEG_LAT * cosLat);
  const south = clamp(centerLat - latHalf, -89.9999, 89.9999);
  const north = clamp(centerLat + latHalf, -89.9999, 89.9999);

  const rawWest = centerLon - lonHalf;
  const rawEast = centerLon + lonHalf;
  if (rawEast - rawWest >= 360) {
    return [{ south, west: -180, north, east: 180 }];
  }

  const ranges: Array<[number, number]> = [];
  if (rawWest < -180) {
    ranges.push([rawWest + 360, 180]);
    ranges.push([-180, rawEast]);
  } else if (rawEast > 180) {
    ranges.push([rawWest, 180]);
    ranges.push([-180, rawEast - 360]);
  } else {
    ranges.push([rawWest, rawEast]);
  }
  return ranges.map(([west, east]) => ({ south, west, north, east }));
}

export function bboxSize(box: BoundingBox): { width: number; height: number } {
  return { width: box.east - box.west, height: box.north - box.south };
}

/** Expands a bbox by `fraction` of its own size on every edge. */
export function expandBBox(box: BoundingBox, fraction: number): BoundingBox {
  if (!(fraction > 0)) return box;
  const { width, height } = bboxSize(box);
  return {
    south: box.south - height * fraction,
    west: box.west - width * fraction,
    north: box.north + height * fraction,
    east: box.east + width * fraction
  };
}

export function bboxCenter(box: BoundingBox): { lat: number; lon: number } {
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
}

/* ------------------------------------------------------------------ */
/* Polygon / polyline utilities                                        */
/* ------------------------------------------------------------------ */

export function samePoint(a: Point, b: Point, epsilon = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

/** Removes consecutive duplicate points (including the closing duplicate). */
export function dedupePoints(points: Point[], epsilon = 1e-6): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || !samePoint(last, point, epsilon)) out.push([point[0], point[1]]);
  }
  while (out.length >= 2 && samePoint(out[0], out[out.length - 1], epsilon)) out.pop();
  return out;
}

/** Signed area in m²; positive means counter-clockwise in the (x, z) plane. */
export function signedArea(points: Point[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % n];
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

export function areaOf(points: Point[]): number {
  return Math.abs(signedArea(points));
}

/** Returns a ring wound counter-clockwise (`counterClockwise`) in (x, z). */
export function ensureWinding(points: Point[], counterClockwise: boolean): Point[] {
  const ccw = signedArea(points) > 0;
  return ccw === counterClockwise ? points : [...points].reverse();
}

export function pointInPolygon(point: Point, ring: Point[]): boolean {
  const [x, z] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function ringCentroid(points: Point[]): Point {
  const signed = signedArea(points);
  if (Math.abs(signed) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const [x, z] of points) {
      sx += x;
      sz += z;
    }
    return [sx / points.length, sz / points.length];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    const cross = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  return [cx / (6 * signed), cz / (6 * signed)];
}

export function polylineLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

/** Ramer–Douglas–Peucker simplification (iterative, no recursion limits). */
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  const n = points.length;
  if (!(tolerance > 0) || n <= 2) return points.slice();
  const tolSq = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last - first < 2) continue;
    const [x1, z1] = points[first];
    const [x2, z2] = points[last];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const lenSq = dx * dx + dz * dz;
    let maxDistSq = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, pz] = points[i];
      let distSq: number;
      if (lenSq === 0) {
        const ddx = px - x1;
        const ddz = pz - z1;
        distSq = ddx * ddx + ddz * ddz;
      } else {
        const cross = (px - x1) * dz - (pz - z1) * dx;
        distSq = (cross * cross) / lenSq;
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        index = i;
      }
    }
    if (maxDistSq > tolSq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/** Simplifies a ring, keeping it closed. */
export function simplifyRing(points: Point[], tolerance: number): Point[] {
  if (!(tolerance > 0) || points.length <= 3) return points.slice();
  const closed: Point[] = [...points, points[0]];
  const simplified = simplifyPolyline(closed, tolerance);
  simplified.pop();
  return simplified;
}

/** Sutherland–Hodgman clip of a ring against the square [-half, half]². */
export function clipPolygonToSquare(points: Point[], half: number): Point[] {
  type Clip = (input: Point[]) => Point[];
  const intersectX = (a: Point, b: Point, x: number): Point => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  const intersectZ = (a: Point, b: Point, z: number): Point => {
    const t = (z - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), z];
  };
  const passes: Clip[] = [
    (input) => clipEdge(input, (p) => p[0] >= -half, (a, b) => intersectX(a, b, -half)),
    (input) => clipEdge(input, (p) => p[0] <= half, (a, b) => intersectX(a, b, half)),
    (input) => clipEdge(input, (p) => p[1] >= -half, (a, b) => intersectZ(a, b, -half)),
    (input) => clipEdge(input, (p) => p[1] <= half, (a, b) => intersectZ(a, b, half))
  ];
  let output = points;
  for (const pass of passes) {
    output = pass(output);
    if (output.length < 3) return [];
  }
  return dedupePoints(output, 1e-7);
}

function clipEdge(input: Point[], inside: (p: Point) => boolean, intersect: (a: Point, b: Point) => Point): Point[] {
  const output: Point[] = [];
  if (input.length === 0) return output;
  let previous = input[input.length - 1];
  let previousInside = inside(previous);
  for (const current of input) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) output.push(intersect(previous, current));
    if (currentInside) output.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

interface Segment {
  a: Point;
  b: Point;
  t0: number;
  t1: number;
}

/** Liang–Barsky clip of one segment to the square [-half, half]². */
function clipSegment(a: Point, b: Point, half: number): [Point, Point] | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [a[0] + half, half - a[0], a[1] + half, half - a[1]];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t0 > t1) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz]
  ];
}

/** Clips a polyline to the square, returning one or more contiguous pieces. */
export function clipPolylineToSquare(points: Point[], half: number): Point[][] {
  const output: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => {
    if (current.length >= 2) output.push(current);
    current = [];
  };
  for (let i = 1; i < points.length; i += 1) {
    const segment = clipSegment(points[i - 1], points[i], half);
    if (!segment) {
      flush();
      continue;
    }
    const [start, end] = segment;
    if (samePoint(start, end, 1e-9)) continue;
    const last = current[current.length - 1];
    if (last && samePoint(last, start, 1e-6)) {
      current.push(end);
    } else {
      flush();
      current = [start, end];
    }
  }
  flush();
  return output;
}

/* ------------------------------------------------------------------ */
/* Decimetre quantization                                              */
/* ------------------------------------------------------------------ */

export function roundDm(metres: number): number {
  return Math.round(metres * 10);
}

/** Signed area of a flat decimetre ring (dm²); positive = CCW. */
export function flatSignedArea(flat: number[]): number {
  let sum = 0;
  const count = flat.length;
  for (let i = 0; i < count; i += 2) {
    const j = (i + 2) % count;
    sum += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
  }
  return sum / 2;
}

export function ensureFlatWinding(flat: number[], counterClockwise: boolean): number[] {
  const ccw = flatSignedArea(flat) > 0;
  if (ccw === counterClockwise) return flat;
  const reversed: number[] = new Array(flat.length);
  const pairs = flat.length / 2;
  for (let i = 0; i < flat.length; i += 2) {
    const target = 2 * (pairs - 1 - i / 2);
    reversed[target] = flat[i];
    reversed[target + 1] = flat[i + 1];
  }
  return reversed;
}

function quantizePoints(points: Point[]): number[] {
  const flat: number[] = [];
  for (const [x, z] of points) {
    const qx = Math.round(x * 10);
    const qz = Math.round(z * 10);
    const n = flat.length;
    if (n >= 2 && flat[n - 2] === qx && flat[n - 1] === qz) continue;
    flat.push(qx, qz);
  }
  while (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) {
    flat.length -= 2;
  }
  return flat;
}

/**
 * Quantizes a ring to integer decimetres.
 *
 * Returns `null` when the result degenerates or is smaller than `minAreaDm2`.
 * Outer rings are normalized counter-clockwise in (x, z), holes clockwise.
 */
export function quantizeRing(points: Point[], minAreaDm2 = 1, counterClockwise = true): number[] | null {
  const flat = quantizePoints(points);
  if (flat.length < 6) return null;
  if (Math.abs(flatSignedArea(flat)) < minAreaDm2) return null;
  return ensureFlatWinding(flat, counterClockwise);
}

/** Quantizes a polyline to integer decimetres; `null` when too short/degenerate. */
export function quantizePolyline(points: Point[], minLengthDm = 1): number[] | null {
  const flat = quantizePoints(points);
  if (flat.length < 4) return null;
  let length = 0;
  for (let i = 2; i < flat.length; i += 2) {
    length += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
  }
  if (length < minLengthDm) return null;
  return flat;
}

/** Closes a ring if needed (returns flat points with the first pair repeated). */
export function closeFlatRing(flat: number[]): number[] {
  if (flat.length < 4) return flat;
  return [...flat, flat[0], flat[1]];
}

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash; deterministic across platforms/runs. */
export function hash32(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic pseudo-random value in [0, 1) derived from a string. */
export function hashUnit(text: string, salt = ''): number {
  return hash32(`${salt}|${text}`) / 0x1_0000_0000;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
