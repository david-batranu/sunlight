/**
 * Recent-city memory for the search dialog. The parsing/merging logic is pure
 * so it can be unit-tested; the dialog supplies the storage implementation.
 */

export interface RecentCity {
  geonameId: number;
  name: string;
  country: string;
  tz: string;
}

export const RECENT_STORAGE_KEY = 'sunlight.recent.v1';
export const RECENT_LIMIT = 6;

function isValidCity(value: unknown): value is RecentCity {
  if (!value || typeof value !== 'object') return false;
  const city = value as Record<string, unknown>;
  return (
    typeof city.geonameId === 'number' &&
    Number.isFinite(city.geonameId) &&
    typeof city.name === 'string' &&
    city.name.trim().length > 0 &&
    city.name.length <= 120 &&
    typeof city.country === 'string' &&
    typeof city.tz === 'string'
  );
}

/** Parses the stored JSON array, dropping malformed entries. Never throws. */
export function parseRecent(raw: string | null | undefined): RecentCity[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cleaned: RecentCity[] = [];
  for (const entry of parsed) {
    if (isValidCity(entry) && !cleaned.some((city) => city.geonameId === entry.geonameId)) {
      cleaned.push({
        geonameId: entry.geonameId,
        name: entry.name.trim(),
        country: entry.country.toUpperCase().slice(0, 2),
        tz: entry.tz
      });
    }
    if (cleaned.length >= RECENT_LIMIT) break;
  }
  return cleaned;
}

/** Adds a city to the front of the list, de-duplicating and capping the length. */
export function addRecent(list: readonly RecentCity[], city: RecentCity, limit = RECENT_LIMIT): RecentCity[] {
  const entry: RecentCity = {
    geonameId: city.geonameId,
    name: city.name.trim(),
    country: city.country.toUpperCase().slice(0, 2),
    tz: city.tz
  };
  return [entry, ...list.filter((item) => item.geonameId !== entry.geonameId)].slice(0, Math.max(1, limit));
}

export function serializeRecent(list: readonly RecentCity[]): string {
  return JSON.stringify(list.slice(0, RECENT_LIMIT));
}
