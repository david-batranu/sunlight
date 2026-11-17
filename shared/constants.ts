/**
 * Values shared by the Node server, the SPA and the tests.
 * Keep this module free of Node and DOM globals.
 */

/** Bumped whenever the persisted model schema or generation semantics change. */
export const MODEL_VERSION = 4;

/** Sky payload schema version. */
export const SKY_VERSION = 1;

/** Half-size of the generated city core, in meters. */
export const CITY_RADIUS_M = 1500;

/** Hard cap on generated footprints. */
export const MAX_BUILDINGS = 20_000;

/** Sun/moon track sampling step, in minutes of local wall-clock time. */
export const SKY_STEP_MINUTES = 5;

export const DATE_MIN = '1900-01-01';
export const DATE_MAX = '2100-12-31';

export const MIN_MINUTE = 0;
export const MAX_MINUTE = 24 * 60; // exclusive upper bound of the local day

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0)';
export const GEONAMES_ATTRIBUTION = 'GeoNames (CC BY 4.0)';

export const DEFAULT_CITY_SLUG = 'brasov';
export const DEFAULT_CITY_GEONAME_ID = 683844;

export interface SeedCityDefinition {
  slug: string;
  geonameId: number;
  /** Curated display name with correct Romanian diacritics. */
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

/**
 * Pre-baked cities, in bake priority order. Brașov is the default and is baked first.
 * Coordinates are GeoNames city centers.
 */
export const SEED_CITIES: readonly SeedCityDefinition[] = [
  { slug: 'brasov', geonameId: 683844, name: 'Brașov', lat: 45.64861, lon: 25.60613, tz: 'Europe/Bucharest' },
  { slug: 'bucharest', geonameId: 683506, name: 'București', lat: 44.43225, lon: 26.10626, tz: 'Europe/Bucharest' },
  { slug: 'cluj-napoca', geonameId: 681290, name: 'Cluj-Napoca', lat: 46.76667, lon: 23.6, tz: 'Europe/Bucharest' },
  { slug: 'timisoara', geonameId: 665087, name: 'Timișoara', lat: 45.75372, lon: 21.22571, tz: 'Europe/Bucharest' },
  { slug: 'iasi', geonameId: 675810, name: 'Iași', lat: 47.16667, lon: 27.6, tz: 'Europe/Bucharest' },
  { slug: 'constanta', geonameId: 680963, name: 'Constanța', lat: 44.18073, lon: 28.63432, tz: 'Europe/Bucharest' },
  { slug: 'sibiu', geonameId: 667268, name: 'Sibiu', lat: 45.8, lon: 24.15, tz: 'Europe/Bucharest' },
  { slug: 'oradea', geonameId: 671768, name: 'Oradea', lat: 47.0458, lon: 21.91833, tz: 'Europe/Bucharest' }
];

export const SEED_BY_GEONAME_ID: ReadonlyMap<number, SeedCityDefinition> = new Map(
  SEED_CITIES.map((city) => [city.geonameId, city])
);

export const SEED_BY_SLUG: ReadonlyMap<string, SeedCityDefinition> = new Map(
  SEED_CITIES.map((city) => [city.slug, city])
);

/* ------------------------------------------------------------------ */
/* Elevation                                                           */
/* ------------------------------------------------------------------ */

/** Number of heightfield samples per side (49 × 49 over the model square). */
export const TERRAIN_GRID_SAMPLES = 49;
/** Vertical exaggeration for the low-poly diorama. */
export const TERRAIN_EXAGGERATION = 0.3;
/** Clamp above the lowest sampled point, keeping extreme alpine cities sane. */
export const TERRAIN_MAX_REL_M = 160;
/** Terrarium terrain tile zoom used by the server provider. */
export const TERRAIN_TILE_ZOOM = 14;
/** Attribution appended to models that contain elevation data. */
export const TERRAIN_ATTRIBUTION = 'Elevation: AWS Terrain Tiles';

/* ------------------------------------------------------------------ */
/* Detail window                                                       */
/* ------------------------------------------------------------------ */

export const DETAIL_MIN_RADIUS_M = 100;
export const DETAIL_MAX_RADIUS_M = 1500;
export const DETAIL_DEFAULT_RADIUS_M = 750;
