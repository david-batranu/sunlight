/**
 * Parser for Overpass API JSON responses.
 *
 * Supports both response styles used by the city pipeline:
 *  - node-referenced output (`out body; >; out skel qt;`), and
 *  - inline geometry output (`out tags geom qt;`), where ways carry a
 *    `geometry` array and relation way members carry geometry too.
 */

import type { CitySource } from '../../../shared/types.ts';
import { CityError } from '../errors.ts';
import type { OsmTags, RawCoord, RawNode, RawOsmData, RawRelation, RawRelationMember, RawWay } from '../raw.ts';
import { dedupeWarnings } from '../raw.ts';
import { parseCoord, parseGeometryArray, parseNumberArray, parseOsmId, safeTags } from './util.ts';

export interface OverpassParseOptions {
  /** Source recorded on the parsed data (providers may label fixture data). */
  source?: CitySource;
  maxWarnings?: number;
}

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  tags?: unknown;
  nodes?: unknown;
  geometry?: unknown;
  members?: unknown;
  [key: string]: unknown;
}

/** Extracts the Overpass `remark` (errors/timeouts) from a response body. */
export function readOverpassRemark(text: string): string | null {
  // Only inspect the tail: remarks live at the end of the JSON object and the
  // geometry payload can be several megabytes.
  const tail = text.slice(Math.max(0, text.length - 4096));
  const match = /"remark"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tail);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

export function parseOverpassJson(text: string, options: OverpassParseOptions = {}): RawOsmData {
  const source = options.source ?? 'overpass';
  const maxWarnings = options.maxWarnings ?? 24;
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CityError('PARSE_FAILED', 'The OSM provider returned an empty response.', 502, true);
  }
  if (!trimmed.startsWith('{')) {
    throw new CityError('PARSE_FAILED', 'Expected an Overpass JSON object.', 502, true, {
      preview: trimmed.slice(0, 160)
    });
  }

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (error) {
    throw new CityError(
      'PARSE_FAILED',
      `Could not parse the Overpass JSON response: ${error instanceof Error ? error.message : String(error)}`,
      502,
      true
    );
  }
  if (!root || typeof root !== 'object') {
    throw new CityError('PARSE_FAILED', 'Overpass response was not a JSON object.', 502, true);
  }
  const record = root as { elements?: unknown; remark?: unknown };
  if (!Array.isArray(record.elements)) {
    throw new CityError('PARSE_FAILED', 'Overpass response is missing the elements array.', 502, true);
  }

  const warnings: string[] = [];
  const remark = typeof record.remark === 'string' ? record.remark.trim() : '';
  if (remark) {
    if (/runtime error|timed out|out of memory|load too high/i.test(remark)) {
      throw new CityError('PROVIDER_FAILED', `Overpass reported an error: ${remark.slice(0, 240)}`, 502, true);
    }
    warnings.push(`Overpass remark: ${remark.slice(0, 240)}`);
  }

  const nodes: RawNode[] = [];
  const ways: RawWay[] = [];
  const relations: RawRelation[] = [];
  let skipped = 0;

  for (const entry of record.elements as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    const element = entry as OverpassElement;
    const id = parseOsmId(element.id);
    if (id === null) {
      skipped += 1;
      continue;
    }
    switch (element.type) {
      case 'node': {
        const coord = parseCoord(element);
        if (!coord) {
          skipped += 1;
          break;
        }
        nodes.push({ id, lat: coord.lat, lon: coord.lon });
        break;
      }
      case 'way': {
        const geometry = parseGeometryArray(element.geometry) ?? undefined;
        const nodeIds = parseNumberArray(element.nodes);
        const tags = safeTags(element.tags);
        if (!geometry && nodeIds.length < 2) {
          skipped += 1;
          break;
        }
        const way: RawWay = { id, nodes: nodeIds, tags };
        if (geometry) way.geometry = geometry;
        ways.push(way);
        break;
      }
      case 'relation': {
        const tags = safeTags(element.tags);
        const members = parseRelationMembers(element.members);
        if (members.length === 0) {
          skipped += 1;
          break;
        }
        relations.push({ id, members, tags });
        break;
      }
      default:
        skipped += 1;
    }
  }

  if (skipped > 0) warnings.push(`skipped ${skipped} malformed Overpass element(s)`);
  return { source, nodes, ways, relations, warnings: dedupeWarnings(warnings, maxWarnings) };
}

function parseRelationMembers(value: unknown): RawRelationMember[] {
  if (!Array.isArray(value)) return [];
  const members: RawRelationMember[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { type?: unknown; ref?: unknown; role?: unknown; geometry?: unknown; lat?: unknown; lon?: unknown };
    const type = record.type;
    if (type !== 'node' && type !== 'way' && type !== 'relation') continue;
    const ref = parseOsmId(record.ref);
    if (ref === null) continue;
    const role = typeof record.role === 'string' ? record.role : '';
    const member: RawRelationMember = { type, ref, role };
    const geometry = parseGeometryArray(record.geometry);
    if (geometry) member.geometry = geometry;
    const nodeCoord = parseCoord(record);
    if (nodeCoord) {
      member.lat = nodeCoord.lat;
      member.lon = nodeCoord.lon;
    }
    members.push(member);
  }
  return members;
}

/** Exposed for tests: tag objects never inherit from Object.prototype. */
export function isSafeTags(tags: OsmTags): boolean {
  return Object.getPrototypeOf(tags) === null;
}

export type { RawCoord, OsmTags };
