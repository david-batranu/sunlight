# Pre-baked seed models

The eight seed cities from `shared/constants.ts` are baked into this directory
by `npm run bake:seeds` (`scripts/bake-seeds.mjs`) and committed, so the default
city and the E2E/offline story work without any OSM traffic.

## Layout

```
server/data/seeds/
  manifest.json      # integrity + metadata for every baked seed
  brasov.json.gz     # gzipped CityModel JSON (meta.seed = true, meta.source = "seed")
  bucharest.json.gz
  ...
```

`manifest.json`:

```json
{
  "v": 1,
  "modelVersion": 4,
  "radiusM": 1500,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "attribution": "© OpenStreetMap contributors (ODbL 1.0)",
  "cities": [
    {
      "slug": "brasov",
      "geonameId": 683844,
      "name": "Brașov",
      "key": "gn-683844-r1500-v4",
      "file": "brasov.json.gz",
      "bytes": 351531,
      "sha256": "<lowercase hex sha256 of the gzipped bytes>",
      "modelVersion": 4,
      "radiusM": 1500,
      "source": "osm-api",
      "generatedAt": "2026-01-01T00:00:00.000Z",
      "stats": { "buildings": 8465, "roads": 1300, "areas": 289, "dropped": 0 }
    }
  ]
}
```

- Seeds are read-only at runtime; the service verifies `bytes` + `sha256` of
  every entry at startup and again before serving it. A corrupt seed is
  ignored (with a warning) and the city falls back to cache/live generation.
- A manifest whose `modelVersion` or `radiusM` does not match the running
  configuration is ignored as a whole (bump and re-bake when either changes).
- The manifest `source` records which provider produced the raw data; the
  served model itself reports `meta.source = "seed"` and `meta.seed = true`.
- Partially failed bakes preserve the previous valid file for any city that
  could not be re-fetched.

## Baking

```bash
npm run bake:seeds                       # Overpass → OSM API fallback
node scripts/bake-seeds.mjs --source osm-api
node scripts/bake-seeds.mjs --only brasov,bucharest --force
node scripts/bake-seeds.mjs --source fixture --out /tmp/seeds --generated-at 2026-01-01T00:00:00.000Z
```

The last form bakes deterministic models from `server/data/fixtures/raw-city.json`
without network access — useful as a smoke test of the seed/runtime path.
