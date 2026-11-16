/**
 * SAX-based parser for OSM API 0.6 `map` XML responses.
 *
 * Only the elements the city pipeline needs are materialized; unknown tags and
 * attributes are ignored. Structural XML errors are reported as `CityError`
 * instead of being silently swallowed.
 */

import sax from 'sax';
import type { CitySource } from '../../../shared/types.ts';
import { CityError } from '../errors.ts';
import type { OsmTags, RawNode, RawOsmData, RawRelation, RawRelationMember, RawWay } from '../raw.ts';
import { dedupeWarnings } from '../raw.ts';
import { parseFiniteNumber, parseOsmId, safeTags } from './util.ts';

export interface OsmXmlParseOptions {
  source?: CitySource;
  maxWarnings?: number;
}

interface PendingNode {
  id: number;
  lat: number | null;
  lon: number | null;
  valid: boolean;
}

export function parseOsmXml(xml: string, options: OsmXmlParseOptions = {}): RawOsmData {
  const source = options.source ?? 'osm-api';
  const maxWarnings = options.maxWarnings ?? 24;
  const trimmed = xml.trimStart();
  if (!trimmed) {
    throw new CityError('PARSE_FAILED', 'The OSM API returned an empty response.', 502, true);
  }
  if (trimmed.startsWith('{')) {
    throw new CityError('PARSE_FAILED', 'Expected OSM XML but received JSON.', 502, true);
  }

  const nodes: RawNode[] = [];
  const ways: RawWay[] = [];
  const relations: RawRelation[] = [];
  let rootSeen = false;
  let skipped = 0;

  let pendingNode: PendingNode | null = null;
  let pendingWay: { id: number; nodes: number[]; tags: OsmTags } | null = null;
  let pendingRelation: { id: number; members: RawRelationMember[]; tags: OsmTags } | null = null;

  const saxParser = sax.parser(true, { trim: true, normalize: false });
  saxParser.onerror = (error: Error): void => {
    throw error;
  };

  saxParser.onopentag = (tag): void => {
    const name = tag.name;
    const attributes = tag.attributes as Record<string, string>;
    switch (name) {
      case 'osm':
        rootSeen = true;
        break;
      case 'node': {
        const id = parseOsmId(attributes.id);
        if (id === null) {
          skipped += 1;
          pendingNode = null;
          break;
        }
        pendingNode = {
          id,
          lat: parseFiniteNumber(attributes.lat),
          lon: parseFiniteNumber(attributes.lon),
          valid: true
        };
        break;
      }
      case 'way': {
        const id = parseOsmId(attributes.id);
        if (id === null) {
          skipped += 1;
          pendingWay = null;
          break;
        }
        pendingWay = { id, nodes: [], tags: Object.create(null) as OsmTags };
        break;
      }
      case 'relation': {
        const id = parseOsmId(attributes.id);
        if (id === null) {
          skipped += 1;
          pendingRelation = null;
          break;
        }
        pendingRelation = { id, members: [], tags: Object.create(null) as OsmTags };
        break;
      }
      case 'nd': {
        if (!pendingWay) break;
        const ref = parseOsmId(attributes.ref);
        if (ref === null) {
          skipped += 1;
          break;
        }
        pendingWay.nodes.push(ref);
        break;
      }
      case 'tag': {
        const target = pendingWay?.tags ?? pendingRelation?.tags;
        if (!target) break;
        const key = attributes.k;
        const value = attributes.v;
        if (typeof key === 'string' && key && typeof value === 'string') {
          if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') target[key] = value;
        }
        break;
      }
      case 'member': {
        if (!pendingRelation) break;
        const type = attributes.type;
        if (type !== 'node' && type !== 'way' && type !== 'relation') {
          skipped += 1;
          break;
        }
        const ref = parseOsmId(attributes.ref);
        if (ref === null) {
          skipped += 1;
          break;
        }
        pendingRelation.members.push({
          type,
          ref,
          role: typeof attributes.role === 'string' ? attributes.role : ''
        });
        break;
      }
      default:
        break;
    }
  };

  saxParser.onclosetag = (name: string): void => {
    switch (name) {
      case 'node': {
        const node = pendingNode;
        pendingNode = null;
        if (!node || node.lat === null || node.lon === null) {
          skipped += 1;
          break;
        }
        if (node.lat < -90 || node.lat > 90 || node.lon < -180 || node.lon > 180) {
          skipped += 1;
          break;
        }
        nodes.push({ id: node.id, lat: node.lat, lon: node.lon });
        break;
      }
      case 'way': {
        const way = pendingWay;
        pendingWay = null;
        if (!way || way.nodes.length < 2) {
          skipped += 1;
          break;
        }
        ways.push({ id: way.id, nodes: way.nodes, tags: way.tags });
        break;
      }
      case 'relation': {
        const relation = pendingRelation;
        pendingRelation = null;
        if (!relation || relation.members.length === 0) {
          skipped += 1;
          break;
        }
        relations.push({ id: relation.id, members: relation.members, tags: relation.tags });
        break;
      }
      default:
        break;
    }
  };

  try {
    saxParser.write(xml).end();
  } catch (error) {
    throw new CityError(
      'PARSE_FAILED',
      `Malformed OSM XML: ${error instanceof Error ? error.message : String(error)}`,
      502,
      true
    );
  }

  if (!rootSeen) {
    throw new CityError('PARSE_FAILED', 'OSM XML response is missing the <osm> root element.', 502, true);
  }

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`skipped ${skipped} malformed OSM XML element(s)`);
  return { source, nodes, ways, relations, warnings: dedupeWarnings(warnings, maxWarnings) };
}

/** Re-exported for tests so tag sanitization can be asserted. */
export { safeTags };
