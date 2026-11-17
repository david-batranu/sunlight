/**
 * OSM tag interpretation: which raw features become model features and how
 * they are typed/measured.
 */

import type { BuildingType, RoadRecord } from '../../shared/types.ts';
import type { OsmTags } from './raw.ts';

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

/** Values of `building` that must not produce a solid diorama building. */
const NON_BUILDING_VALUES = new Set(['no', 'construction', 'ruins']);

export function isBuilding(tags: OsmTags): boolean {
  const value = tags.building;
  if (typeof value !== 'string' || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (NON_BUILDING_VALUES.has(normalized)) return false;
  // Building parts are merged into their parent building's footprint.
  if (tags['building:part'] && tags['building:part'] !== 'no') return false;
  // Underground footprints are not visible in the diorama.
  if (tags.location === 'underground' || tags.underground === 'yes') return false;
  return true;
}

const CIVIC_BUILDINGS = new Set([
  'school',
  'university',
  'college',
  'hospital',
  'civic',
  'public',
  'government',
  'townhall',
  'city_hall',
  'courthouse',
  'fire_station',
  'police',
  'prison',
  'military',
  'church',
  'cathedral',
  'chapel',
  'mosque',
  'synagogue',
  'temple',
  'monastery',
  'shrine',
  'place_of_worship',
  'religious',
  'train_station',
  'transportation',
  'stadium',
  'sports_hall',
  'museum',
  'library',
  'community_centre',
  'kindergarten',
  'arts_centre',
  'theatre',
  'cinema',
  'conference_centre',
  'exhibition_centre',
  'planetarium'
]);

const CIVIC_AMENITIES = new Set([
  'school',
  'university',
  'college',
  'hospital',
  'clinic',
  'townhall',
  'courthouse',
  'fire_station',
  'police',
  'prison',
  'place_of_worship',
  'library',
  'museum',
  'community_centre',
  'kindergarten',
  'arts_centre',
  'theatre',
  'cinema',
  'conference_centre',
  'public_building',
  'government'
]);

const INDUSTRIAL_BUILDINGS = new Set([
  'industrial',
  'warehouse',
  'factory',
  'hangar',
  'manufacture',
  'depot',
  'garage',
  'garages',
  'service',
  'works',
  'shed',
  'greenhouse',
  'barn',
  'farm_auxiliary',
  'stable',
  'digester',
  'slurry_tank',
  'storage_tank',
  'silo',
  'transformer_tower'
]);

const COMMERCIAL_BUILDINGS = new Set([
  'commercial',
  'office',
  'retail',
  'hotel',
  'hostel',
  'motel',
  'supermarket',
  'mall',
  'shops',
  'kiosk',
  'restaurant',
  'cafe',
  'bank',
  'department_store'
]);

const INDUSTRIAL_LANDUSE = new Set(['industrial', 'railway', 'quarry', 'landfill', 'port']);
const COMMERCIAL_LANDUSE = new Set(['commercial', 'retail']);

/** Maps a building to the renderer palette code (0 residential … 3 industrial). */
export function classifyBuildingType(tags: OsmTags): BuildingType {
  const building = (tags.building ?? '').trim().toLowerCase();
  const amenity = (tags.amenity ?? '').trim().toLowerCase();
  const landuse = (tags.landuse ?? '').trim().toLowerCase();
  const tourism = (tags.tourism ?? '').trim().toLowerCase();

  if (CIVIC_BUILDINGS.has(building) || CIVIC_AMENITIES.has(amenity)) return 2;
  if (INDUSTRIAL_BUILDINGS.has(building) || INDUSTRIAL_LANDUSE.has(landuse)) return 3;
  if (
    COMMERCIAL_BUILDINGS.has(building) ||
    COMMERCIAL_LANDUSE.has(landuse) ||
    Boolean(tags.shop) ||
    Boolean(tags.office) ||
    tourism === 'hotel'
  ) {
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Areas                                                               */
/* ------------------------------------------------------------------ */

export type AreaKind = 1 | 2 | 3 | 4;

const PARK_LEISURE = new Set(['park', 'garden', 'nature_reserve']);
const GRASS_LEISURE = new Set(['pitch', 'playground', 'common', 'golf_course', 'dog_park']);
const GRASS_LANDUSE = new Set([
  'grass',
  'meadow',
  'village_green',
  'recreation_ground',
  'cemetery',
  'railway',
  'flowerbed'
]);
const PLAZA_PLACE = new Set(['square', 'plaza']);
const WATER_VALUES = new Set(['water', 'reservoir', 'basin']);

/** Classifies an OSM polygon as a model area (1 water, 2 park, 3 forest, 4 grass). */
export function classifyArea(tags: OsmTags): AreaKind | 0 {
  if (
    tags.natural === 'water' ||
    tags.water === 'river' ||
    tags.waterway === 'riverbank' ||
    tags.waterway === 'dock' ||
    (tags.landuse && WATER_VALUES.has(tags.landuse))
  ) {
    return 1;
  }
  if (tags.natural === 'wood' || tags.landuse === 'forest' || tags.landuse === 'orchard') return 3;
  if (tags.leisure && PARK_LEISURE.has(tags.leisure)) return 2;
  if (tags.leisure && GRASS_LEISURE.has(tags.leisure)) return 4;
  if (tags.landuse && GRASS_LANDUSE.has(tags.landuse)) return 4;
  if (tags.place && PLAZA_PLACE.has(tags.place)) return 4;
  if (tags.highway === 'pedestrian' && tags.area === 'yes') return 4;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Roads / rail                                                        */
/* ------------------------------------------------------------------ */

const RAIL_VALUES = new Set(['rail', 'light_rail', 'subway', 'tram', 'monorail', 'narrow_gauge', 'preserved']);
const EXCLUDED_HIGHWAY_VALUES = new Set([
  'proposed',
  'construction',
  'planned',
  'abandoned',
  'disused',
  'razed',
  'raceway',
  'bus_guideway'
]);

const ROAD_CLASSES: Record<string, RoadRecord['c']> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 1,
  trunk_link: 1,
  primary: 1,
  primary_link: 1,
  secondary: 2,
  secondary_link: 2,
  tertiary: 2,
  tertiary_link: 2,
  residential: 3,
  unclassified: 3,
  living_street: 3,
  road: 3,
  service: 4,
  track: 4,
  pedestrian: 4
};

/** Ways treated as candidate pedestrian paths and filtered after terrain sampling. */
const MINOR_PATH_HIGHWAYS = new Set([
  'footway',
  'path',
  'steps',
  'cycleway',
  'bridleway',
  'corridor',
  'platform'
]);

const HIKING_TAGS = ['sac_scale', 'trail_visibility', 'mtb:scale'] as const;

/**
 * True when the way is a pedestrian/footpath candidate rather than a street.
 * `classifyRoad` returns 0 for these; the builder keeps only the ones that look
 * like hiking trails (explicit hiking tags or natural surface on a climb).
 */
export function isMinorPathWay(tags: OsmTags): boolean {
  if (tags.tunnel === 'yes' || tags.tunnel === 'building_passage') return false;
  const highway = tags.highway;
  return Boolean(highway && MINOR_PATH_HIGHWAYS.has(highway));
}

/** Explicit hiking indicators that should survive even on flat terrain. */
export function hasHikingTags(tags: OsmTags): boolean {
  for (const key of HIKING_TAGS) {
    if (typeof tags[key] === 'string' && tags[key].trim() !== '') return true;
  }
  const route = tags.route;
  return typeof route === 'string' && /(^|;)\s*hiking\s*(;|$)/i.test(route);
}

/** Natural/unsurfaced paths are candidates for mountain trails. */
export function hasNaturalPathSurface(tags: OsmTags): boolean {
  const surface = (tags.surface ?? '').trim().toLowerCase();
  if (!surface) return true;
  return /ground|gravel|unpaved|dirt|earth|grass|rock|stone|wood|fine_gravel|compacted/.test(surface);
}

/**
 * Maps an OSM way to a model road class, or 0 when it is not drawn.
 *
 * Tunnels are omitted (invisible), bridges stay at ground level per the
 * architecture doc, and unnamed service roads are filtered out to keep the
 * diorama readable.
 */
export function classifyRoad(tags: OsmTags): RoadRecord['c'] | 0 {
  if (tags.tunnel === 'yes' || tags.tunnel === 'building_passage') return 0;
  if (isMinorPathWay(tags)) return 0;
  const railway = tags.railway;
  if (railway && RAIL_VALUES.has(railway)) return 9;
  const highway = tags.highway;
  if (!highway) return 0;
  if (EXCLUDED_HIGHWAY_VALUES.has(highway)) return 0;
  if (highway === 'service' && !tags.name) return 0;
  const roadClass = ROAD_CLASSES[highway];
  return roadClass ?? 0;
}

/* ------------------------------------------------------------------ */
/* Heights                                                             */
/* ------------------------------------------------------------------ */

const HEIGHT_METRES = /^([0-9]+(?:[.,][0-9]+)?)\s*(m|metres?|meters?)?$/;
const HEIGHT_FEET = /^([0-9]+(?:[.,][0-9]+)?)\s*(ft|feet|foot|')$/;
const HEIGHT_INCHES = /^([0-9]+(?:[.,][0-9]+)?)\s*(in|inch|inches|")$/;

/** Parses a raw length tag (`12`, `12 m`, `40 ft`, `30'`) into metres. */
export function parseLengthMeters(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  let match = HEIGHT_METRES.exec(value);
  if (match) {
    const metres = Number(match[1].replace(',', '.'));
    return Number.isFinite(metres) && metres > 0 ? metres : null;
  }
  match = HEIGHT_FEET.exec(value);
  if (match) {
    const feet = Number(match[1].replace(',', '.'));
    return Number.isFinite(feet) && feet > 0 ? feet * 0.3048 : null;
  }
  match = HEIGHT_INCHES.exec(value);
  if (match) {
    const inches = Number(match[1].replace(',', '.'));
    return Number.isFinite(inches) && inches > 0 ? (inches * 0.3048) / 12 : null;
  }
  return null;
}

/** Explicit `height` tag in metres, if present and parseable. */
export function explicitHeightM(tags: OsmTags): number | null {
  return parseLengthMeters(tags.height);
}

/** `building:levels` converted to metres (3 m per level, plus `roof:height`). */
export function levelsHeightM(tags: OsmTags): number | null {
  const raw = tags['building:levels'];
  if (!raw) return null;
  const match = /^([0-9]+(?:[.,][0-9]+)?)/.exec(raw.trim());
  if (!match) return null;
  const levels = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(levels) || levels <= 0 || levels > 200) return null;
  const roof = parseLengthMeters(tags['roof:height']) ?? 0;
  return levels * 3 + roof;
}

/** Height prior multiplier applied to the local median when no tag exists. */
export function heightPriorFactor(type: BuildingType): number {
  switch (type) {
    case 1:
      return 1.15;
    case 2:
      return 1.05;
    case 3:
      return 0.85;
    default:
      return 1;
  }
}

/** Absolute bounds for any inferred storey height, in metres. */
export const MIN_HEIGHT_M = 2;
export const MAX_HEIGHT_M = 400;

/**
 * Whether the renderer may add a simple pitched roof.
 *
 * Large civic/industrial blocks, towers and explicit flat roofs stay flat.
 */
export function roofEligible(tags: OsmTags, type: BuildingType, areaM2: number, heightM: number): 0 | 1 {
  const shape = (tags['roof:shape'] ?? '').trim().toLowerCase();
  if (shape === 'flat' || shape === 'skillion') return 0;
  if (type === 3) return 0;
  if (areaM2 < 20 || areaM2 > 500) return 0;
  if (heightM > 30) return 0;
  const building = (tags.building ?? '').trim().toLowerCase();
  if (building === 'apartments' || building === 'hotel' || building === 'office' || building === 'hospital') return 0;
  return 1;
}
