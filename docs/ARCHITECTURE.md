# Sunlight architecture

This document describes how Sunlight turns a city name into a lit, explorable diorama. It is the companion to [`docs/CONTRACT.md`](CONTRACT.md), which pins down module interfaces and ownership.

## 1. System overview

```
┌──────────────────────────── Browser SPA (Vite + TS) ────────────────────────────┐
│ city search / locate        time console + light panel                          │
│ POST /api/models → poll jobs → GET /api/models/:key                             │
│ GET /api/sky?lat&lon&date → 5-minute sun/moon track                             │
│ Three.js: orthographic diorama, merged meshes, sun/moon shadow lights            │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                    │ same origin (dev: Vite proxy)
┌───────────────────────────────────▼─────────────────────────────────────────────┐
│ Node application server (native node:http, no DB)                               │
│  HTTP/router/static/gzip/ETag/rate limit/security headers                       │
│  city service: GeoNames search + resolve + ensureModel                          │
│  job queue + worker_thread generation pipeline                                  │
│  providers: Overpass → official OSM API (adaptive tiles) → seeds → fixture       │
│  sky service: astronomy-engine day payloads (LRU)                               │
│  disk cache: models gz + meta, raw provider responses, seeds                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The server does every expensive step. The browser is a renderer plus a state machine.

## 2. Runtime topologies

| Mode | Frontend | API | Cache |
|---|---|---|---|
| Development | Vite on :5173 | `node --watch server/index.ts` on :8090 | `.cache/sunlight` |
| Production | `dist/` served by Node | same process on :8090 | `.cache/sunlight` |
| Docker | built into image | container :8090, non-root, healthcheck | named volume `/data/cache` |
| Tests (integration) | – | in-process `startSunlightApp()` on port 0 | temp dir per test run |
| Tests (E2E) | built `dist/` served by Node | isolated process, seed-only, free port | temp dir |

Port 8080 is deliberately avoided as a default because Docker Desktop commonly reserves it; Compose publishes `8090:8090`.

## 3. Request and data flows

### 3.1 Choosing a city

1. SPA parses the URL (`city=gn:<id>` or `point=lat,lon`) or falls back to `localStorage` / default Brașov.
2. Search is local to the server index: 64,727 GeoNames places (population >5k, excl. neighbourhoods) loaded from a committed gzip file. Matching is diacritic-insensitive and ranked by population; seed cities are flagged.
3. Geolocation (explicit button only) asks the nearest city. Within 80 km the nearest city is used; beyond that the SPA offers/creates an exact-point target.
4. `POST /api/models` resolves the canonical target key, then returns either:
   - `200 ready` when a seed or cache entry exists, or
   - `202 queued` with a job ID when generation is required.
5. The SPA polls `GET /api/jobs/:id` (~700 ms) and renders progress; on completion it fetches the model.

### 3.2 Time and light

1. The SPA stores a **city-local date + minute of day**, never a UTC timestamp. URL deep links therefore reproduce the same local moment.
2. `GET /api/sky?lat&lon&date` returns 289 samples at 5-minute local-minute steps, plus almanac events and moon phase. The server derives the IANA timezone from coordinates.
3. Each animation frame the SPA interpolates altitude/azimuth between samples (shortest-arc for azimuth), updates the sun/moon lights and their shadow directions. No network request is needed while scrubbing.
4. Day changes fetch the next sky payload; adjacent days are prefetched.

### 3.3 Generation

```
resolve target ─► seed key? ─► disk cache? ─► queue/dedupe ─► worker thread
                                                               │
  provider chain: Overpass ──fail──► OSM API tiles ──fail──► error/seed fallback
                                                               │
  parse (XML / Overpass JSON) ─► normalize buildings/roads/water/parks/rail
  ─► relation assembly (multipolygons + holes) ─► project to local metres
  ─► clip to 1.8 km square ─► RDP simplify ─► infer heights/types
  ─► cap 20k buildings ─► quantize decimeters ─► gzip JSON + meta
  ─► atomic cache write ─► job done
```

Progress is monotonic and coarse-grained (`fetch`, `parse`, `build`, `write`) with a detail string. Jobs are deduped by model key, cancellable, and survive page reloads because the server keeps working; finished models are on disk.

## 4. City data pipeline

### 4.1 Providers

| Provider | Role | Notes |
|---|---|---|
| Overpass | Preferred | Filtered tag query with inline geometry (`out tags geom`), multiple endpoints, retry/circuit breaker. |
| Official OSM API | Fallback | `api/0.6/map` with adaptive ~600 m tiles (splits on the 50k-node error), 10% overlap, ≥350 ms spacing, retries, identifying User-Agent. |
| Seed | Bundled | Eight baked Romanian city cores, verified by manifest SHA-256; also the fallback for seed-city generation failures. |
| Fixture | Tests/dev | Deterministic local raw-city fixture; no network. Selected with `CITY_SOURCE=fixture`. |

Raw provider responses are cached gzipped for 30 days, which makes retries cheap and reduces load on public OSM infrastructure.

### 4.2 Normalization

- **Buildings**: closed ways and multipolygon relations; outer rings with holes; skip building parts, construction, underground, and `building=no`.
- **Roads**: motorway through living street/pedestrian, skipping tunnels; bridges stay at ground level in the diorama; service roads only when named.
- **Areas**: water, reservoir/riverbank, parks, grass, forest, plazas.
- **Rail**: surface railway lines rendered as thin tracks.
- Relations are assembled from member ways by role; incomplete geometries are dropped rather than guessed.

### 4.3 Projection and geometry

- Local equirectangular projection around the city centre: `x = (lon − lon0) · cos(lat0)`, `z = −(lat − lat0)` scaled to metres. World axes are +X east, +Y up, −Z north.
- All geometry is clipped to a square of ±`CITY_RADIUS_M` (default 900 m), simplified with Ramer–Douglas–Peucker (~0.5 m), cleaned, and oriented consistently.
- Coordinates and heights are quantized to integer decimetres to keep the JSON small and deterministic.

### 4.4 Heights and character

OSM height tags are sparse, so heights are inferred:

1. Explicit `height` (m/ft), `building:levels` × 3.0 m, `roof:height`, clamped to 2–400 m.
2. Otherwise, a local median of tagged heights within ~120 m blended with a building-type prior (house/apartments/commercial/civic/industrial).
3. Deterministic ±15% variation from the OSM id hash, so caches are reproducible and skylines feel varied but stable.

Each building stores a type code for the palette and a `roofEligible` flag for the renderer’s optional pitched-roof pass.

### 4.5 Caps and failure

- At most 20,000 buildings; above that the smallest footprints are dropped and the count recorded in model metadata.
- No data at all (ocean/rural point) → `NO_DATA` with nearest-city suggestions in the UI.
- Provider outage → retryable error; seed cities can fall back to their bundled model.
- Antimeridian bboxes are split/wrapped.

## 5. Persisted model format

Stored gzipped at `CACHE_DIR/models/<key>.json.gz`; see `shared/types.ts` for the exact TypeScript shape.

```json
{
  "v": 1,
  "key": "gn-683844-r900-v1",
  "city": { "geonameId": 683844, "name": "Brașov", "country": "RO", "lat": 45.64861, "lon": 25.60613, "tz": "Europe/Bucharest" },
  "meta": { "generatedAt": "...", "source": "overpass", "seed": false, "radiusM": 900,
            "stats": { "buildings": 4812, "roads": 530, "areas": 44, "dropped": 0 },
            "warnings": [], "attribution": "© OpenStreetMap contributors (ODbL 1.0)" },
  "bounds": { "minX": -900, "maxX": 900, "minZ": -900, "maxZ": 900, "maxHeight": 650 },
  "buildings": [ { "p": [x,z,...], "h": 128, "t": 0, "r": 1 } ],
  "roads": [ { "c": 3, "p": [x,z,...] } ],
  "areas": [ { "k": 1, "p": [x,z,...], "holes": [[x,z,...]] } ]
}
```

- Units: decimetres; the renderer divides by 10.
- Key: `<city-or-point>-r<radius>-v<model version>`.
- Metadata includes source, stats, warnings, attribution and generation timings.
- Strong ETag (SHA-256) + immutable cache headers; version bumps invalidate naturally.

## 6. Cache and jobs

- **Model cache**: atomic temp-file → rename writes, sidecar meta, ETag, startup corruption scan, LRU eviction above `CACHE_MAX_MB`.
- **Hot cache**: recent model buffers/sky payloads are kept in memory.
- **Raw cache**: provider tile/query responses with TTL.
- **Seeds**: bundled, SHA-verified, read-only; served before cache/generation.
- **Jobs**: in-memory FIFO queue, one worker by default, dedupe by key, monotonic progress, cancellation, TTL cleanup. A finished job writes the model; after a restart the cache still serves it.
- **Versioning**: `MODEL_VERSION` in `shared/constants.ts`; bump + `npm run cache:clear` for format changes.

## 7. Ephemeris and time model

- `astronomy-engine` computes sun and moon topocentric altitude/azimuth using an `Observer` at the city coordinates and `Equator` + `Horizon` with normal refraction.
- 289 samples at 5-minute **local wall-clock** steps. The server converts local time to UTC with a two-pass `Intl` offset algorithm and deterministic handling of DST gaps/overlaps.
- Almanac: sunrise/sunset, civil dawn/dusk, solar noon, max altitude, golden-hour windows (sun at +6° and −4°), moonrise/moonset, phase angle/illuminated fraction/name, polar-day/night flags.
- Payload is versioned (`SKY_VERSION`), cached by rounded coordinates + date with an ETag.
- Accuracy is more than sufficient visually; dates outside 1900–2100 are rejected, and pre-1970 timezone data is limited by tzdb.
- Moonlight uses illuminated fraction; shadows from the moon only appear when the sun is well below the horizon and the moon is sufficiently high and bright.

## 8. Rendering and lighting

- **Camera**: orthographic, true isometric default (azimuth 45°, pitch 35.264°), fit to the ~1.96 km base. Pan on the ground plane, orbit, zoom, reset; damped and clamped. Sun direction is world-fixed and independent of the camera.
- **Geometry**: merged vertex-coloured, flat-shaded building mesh; merged road/rail ribbons; earcut-triangulated areas with holes; a warm clay-edged plinth. One draw call per material family, no per-frame allocations.
- **Lights**: sun and moon `DirectionalLight`s + hemisphere ambient. Sun shadows during the day; moon shadows at night under the thresholds above; adaptive orthographic shadow camera for long low-sun shadows; PCFSoft 2048 (1024 low quality).
- **Palette**: smooth altitude-based interpolation between night / astronomical / nautical / blue hour / golden / day states for background, ambient, fog and light colour. The canvas is transparent over a CSS sky backdrop updated by the UI, so the chrome and the sky always agree.
- **UI readouts**: sun-path compass with horizon and N/E/S/W, current sun/moon markers, day/night shading, sunrise/sunset ticks, altitude/azimuth, moon phase icon, shadow-length multiplier, timezone offset.

## 9. HTTP API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Version, cache/queue stats, provider state, seeds |
| GET | `/api/cities?q=&limit=` | Local GeoNames search |
| GET | `/api/cities/nearest?lat=&lon=` | Nearest indexed city |
| POST | `/api/models` | Resolve/queue a city or point model |
| GET | `/api/jobs/:id` | Poll generation status |
| DELETE | `/api/jobs/:id` | Cancel generation |
| GET | `/api/models/:key` | Gzipped model JSON + ETag |
| GET | `/api/sky?lat=&lon=&date=` | Sun/moon track + almanac |
| GET | `/*` | Static SPA + history fallback |

Errors are structured (`{error:{code,message,retryable,details?}}`). Request bodies are capped at 16 KB, coordinates/date/limits are validated, and generation is rate-limited per IP.

## 10. Security and operations

- Same-origin only; no CORS surface, no cookies, no analytics.
- Security headers: CSP (self assets, inline styles for SVG), nosniff, referrer policy, geolocation-only permission policy, frame denial, CORP.
- Static server prevents path traversal, serves immutable hashed assets, gzips text, and sets an SPA fallback only for extensionless routes.
- Model keys and job IDs are strictly validated; no user-controlled filesystem paths.
- Docker runtime is non-root, with a healthcheck and a persistent cache volume. The image is multi-stage and contains only the built bundles, static assets, seeds and city index.
- Logging is minimal and structured on stdout. No personal data is stored; geolocation is used only to resolve the nearest city.

## 11. Performance budgets

- SPA initial payload target < 300 KB gzipped (Three.js + app).
- Model seed target ≤ 500 KB gzipped; a 20k-building cap and decimetre quantization keep payloads predictable.
- Rendering: <25 draw calls and <400k triangles for a normal city; 55–60 fps on an M-series Mac at 1440×900 with 2048 shadows; adaptive DPR/shadow quality on slower devices.
- Search latency <100 ms server-side; sky computed in milliseconds and cached; model cache hits served as pre-compressed bytes.
- First generation target under 60 s with Overpass, under ~2 minutes with the tiled OSM fallback; seeds are instant.

## 12. Testing strategy

- **Unit** (`node --test`): projection/clipping/simplification, parsers and relation assembly, height inference, cache/job state, search normalization/ranking, DST/timezone conversion, ephemeris values and polar cases, lighting-direction math, URL/time helpers, UI formatters.
- **Integration**: in-process app with the fixture provider and a temp cache — job lifecycle, cache hits, ETag/304, concurrent dedupe, validation errors, sky payload.
- **E2E** (Playwright-core + system Chrome): seed-only server, blocked external network, fixed dates/times, screenshots for noon/golden hour/night/mobile, assertions on labels, sun direction, camera interactions and responsive layout.
- **Visual review**: screenshots in `qa/shots/` inspected for diorama quality, shadow direction/artifacts, palette transitions and mobile layout.
- **Ops**: `docker compose up --build` smoke test, `/api/health`, cache persistence across restarts.

## 13. Extension points

- **Commercial map provider**: implement the provider interface (`fetch(center, radius) → RawCityData`) for Mapbox/Overture and select it with an env var; the rest of the pipeline is provider-agnostic.
- **Terrain**: add elevation sampling and displace the ground/plinth; the model schema has no terrain field yet, so this is a model-version bump.
- **More detail**: stricter building-part handling, landmark models, park trees, night window glow — all renderer-only or additive fields with a version bump.
- **Multi-instance**: replace the in-memory job queue/cache locking with a shared queue + object store; the HTTP contract stays the same.
