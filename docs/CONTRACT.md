# Sunlight — implementation contract

This file documents the module interfaces and responsibilities. Keep it in sync
when a contract changes.

## Ground rules

- TypeScript everywhere on both sides; Node runs `.ts` directly in development,
  esbuild bundles the server for production.
- Import relative `.ts` modules with the explicit extension, e.g.
  `import type { CityModel } from '../../shared/types.ts';`
- Only edit files inside your task's write scope. If a shared file must change,
  message the lead instead of editing it.
- No new runtime dependencies without asking the lead. Existing deps:
  `three`, `astronomy-engine`, `sax`, `earcut`, `tz-lookup`. Dev: Vite, esbuild,
  TypeScript, Playwright-core.
- Tests must never hit the network. Use fixture providers/fixtures.
- Keep deterministic generation: same inputs + version → same model bytes.

## Shared contracts

`shared/types.ts` — wire types for the model, sky payload, API responses.
`shared/constants.ts` — model/sky versions, radius, sizes, date range, seed list,
attributions.

All model coordinates and heights are **integer decimetres**. The client divides
by 10. Axes are `+X east`, `+Y up`, `−Z north`.

## Server: city service (`server/city/**`, city-engineer)

`server/city/service.ts` must export exactly:

```ts
import type { AppConfig } from '../config.ts';
import type {
  CityInfo, CityModel, CitySearchResponse, JobStatus, ModelMeta,
  ModelTarget, NearestCityResponse, SkyDay
} from '../../shared/types.ts';

export interface ResolvedTarget {
  key: string;                 // e.g. "gn-683844-r1500-v4"
  target: ModelTarget;
  city: CityInfo;
  seedSlug: string | null;
}

export interface ReadyModel {
  state: 'ready';
  resolved: ResolvedTarget;
  meta: ModelMeta;
  etag: string;                // strong ETag (sha256 hex, quoted)
  bytes: number;               // gzip payload size
  gzipped: Buffer;             // gzipped JSON bytes
}

export interface QueuedModel {
  state: 'queued';
  resolved: ResolvedTarget;
  jobId: string;
}

export type EnsureModelResult = ReadyModel | QueuedModel;

export interface CityService {
  init(): Promise<void>;
  search(query: string, limit?: number): CitySearchResponse;
  nearest(lat: number, lon: number): NearestCityResponse | null;
  resolve(target: ModelTarget): ResolvedTarget;
  ensureModel(target: ModelTarget): Promise<EnsureModelResult>;
  getJob(jobId: string): JobStatus | null;
  cancelJob(jobId: string): boolean;
  readModel(key: string): Promise<ReadyModel | null>;
  health(): CityServiceHealth; // cache/queue/providers/seeds + ready/degraded/worker/checks
  shutdown(): Promise<void>;
}

export class CityError extends Error {
  code: string;      // INVALID_TARGET | CITY_NOT_FOUND | MODEL_FAILED | NO_DATA | ...
  status: number;    // 400 | 404 | 422 | 502 | 503
  retryable: boolean;
  details?: unknown;
}

export function createCityService(config: AppConfig): CityService;
```

Requirements:

- Loads `server/data/cities.json.gz` (built by `scripts/build-city-index.mjs`)
  and the seed manifest from `server/data/seeds/`.
- Uses `tz-lookup` for arbitrary points and GeoNames timezone for cities.
- Builds the cache key with radius and `MODEL_VERSION`; seeds are keyed by
  GeoNames id.
- Seeds are served from disk without touch the network.
- Generation runs in a queue with dedupe, a progress callback, cancellation,
  and a `worker_threads` worker where practical. Cache reads/writes are
  asynchronous. Atomic writes.
- `ensureModel` returns immediately (`ready` or `queued`). It must never block
  for the duration of generation.
- Progress `percent` must be monotonic.
- `CityError` for all expected failures.
- Source provider chain per plan: Overpass → OSM API tiled fallback → fixture
  (`CITY_SOURCE=fixture`) / seeds. No network in tests.
- The worker entry lives at `server/city/worker.ts` and is bundled separately by
  `scripts/build-server.mjs`. Resolve it from `import.meta.url`, supporting both
  `worker.js` (production) and `worker.ts` (development).

## Server: sky (`server/sky/**`, sky-engineer)

`server/sky/day.ts` exports:

```ts
import type { SkyDay } from '../../shared/types.ts';

export function resolveTimezone(lat: number, lon: number): string;
export function validateLocalDate(date: string): void; // throws RangeError on invalid/out-of-range
export function computeSkyDay(lat: number, lon: number, date: string): SkyDay;
```

`server/sky/time.ts` exports the local↔UTC helpers used by the sky module and
tests:

```ts
export function localMinutesToUtc(date: string, minute: number, tz: string): Date;
export function utcOffsetMinutes(tz: string, instant: Date): number;
export function todayInTimezone(tz: string, now?: Date): string;
```

Requirements: 289 samples (5-minute local minute steps, 00:00…24:00), sun/moon
altitude+azimuth, almanac events, moon phase, polar flags, `SKY_VERSION`, tz.
Handle DST gaps/overlaps deterministically. No caching in the pure functions.

## Client state and actions

`src/app/state.ts`: `AppState`, `CurrentLight`, `createStore`, `createInitialState`.
`src/app/contracts.ts`: `LoadPhase`, `AppActions`, `SceneHandle`, `SceneDebug`,
`UIContext`, `UIHandle`.
`src/app/api.ts`: `ApiClient` (`searchCities`, `nearestCity`, `createModel`,
`getJob`, `cancelJob`, `loadModel`, `loadSky`).
`src/app/time.ts`: pure client helpers (date math, formatting, sky track
interpolation).
`src/app/url.ts`: URL state round-trip.

## Scene (`src/scene/**`)

`src/scene/scene.ts` exports:

```ts
export function createScene(canvas: HTMLCanvasElement): SceneHandle;
```

The scene owns Three.js renderer, orthographic camera controls, model meshes,
plinth, lighting, shadow maps, background-driven palette hooks (canvas is
transparent; the CSS backdrop is updated by the UI from the same sky state).
It must not import the store or UI. It receives data through `SceneHandle`:

```ts
setModel(model: CityModel): void;
setSky(sky: SkyDay | null): void;
setTime(minute: number): void;          // local minute 0..1440, called every frame
setQuality(quality: 'high' | 'low'): void;
resetCamera(): void;
resize(): void;
dispose(): void;
getDebug(): SceneDebug;
hitTest(clientX: number, clientY: number): HitFeature | null;
getCameraAzimuth(): number;
getGroundPoint(clientX: number, clientY: number): { x: number; z: number } | null;
```

`HitFeature` describes a named building/road/area hit (name, kindLabel, building
height). `getGroundPoint` returns model-space metres on the y=0 plane for the
choose-area interaction. `SceneDebug` is used by E2E: camera azimuth/pitch/zoom, active light
(kind, direction, altitude/azimuth, intensity, shadow on/off), draw calls,
triangles, FPS, model key. `window.__sunlight` is installed by `main.ts`.

## UI (`src/ui/**`, `src/styles/**`, ui-engineer)

`src/ui/shell.ts` exports:

```ts
export function createUI(root: HTMLElement, ctx: UIContext): UIHandle;
```

`AppActions` additionally exposes `toggleDetailPanel()`, `closeDetailPanel()`,
`setDetailWindow()`, `focusDetailWindow()`, `loadDetailArea()`, `dismissHover()` and
`dismissHover()`. `AppState` carries `cameraAzimuthDeg`, `hover` (HoverInfo) and
`pickingArea` for the compass, tooltips and choose-area hint. `UIContext`
contains the store, actions, `searchCities(query)` and `nearestCity(lat, lon)`. The UI owns all DOM, search modal, generation overlay,
time console, light panel, sun-path SVG, About dialog, keyboard shortcuts and
responsive layout. It must not import Three.js or scene modules. It renders from
state and calls actions; no direct fetches.

The UI also updates CSS custom properties for the time-of-day backdrop based on
the current sky/lighting (day/twilight/night gradients) so the transparent
WebGL canvas sits over a living sky.

## `/api` HTTP layer (lead)

- `POST /api/models` → ready (200) or queued (202)
- `GET /api/jobs/:id`, `DELETE /api/jobs/:id`
- `GET /api/models/:key` (gzip + ETag)
- `GET /api/cities?q=&limit=`, `GET /api/cities/nearest?lat=&lon=`
- `GET /api/sky?lat=&lon=&date=`
- `GET /api/health`

The lead wires the city service, sky service and static SPA serving.

## Testing

- Unit tests in `tests/unit/*.test.ts`, run with `node --test` (TS native).
- Integration tests in `tests/integration/*.test.ts` (spawn the server with a
  fixture provider and a temp cache).
- E2E in `tests/e2e/*.test.mjs` driven by `scripts/e2e.mjs` with Playwright-core.
- Browser tests must block external network and use seed models.

## Accepted plan deviations

- In-process generation is acceptable if worker_threads proves flaky, provided
  the async job API and progress behave identically.
- Raw provider responses are not cached between generation attempts in v1;
  only generated models and seeds are persisted.
- `bounds` describe actual geometry extents, not the requested square.
- Courtyard holes on building relations are ignored with a warning.
- Optional polish (gable roofs, park trees, night window glow) is not
  acceptance-critical; only add it if core budgets are met.

### Area picker

`AppActions.toggleDetailPanel()` opens the combined 5 km overview / detail
window; `setDetailWindow({centerX,centerZ,radiusM})` updates it; `focusDetailWindow()`
fits the camera; and `loadDetailArea()` recentres/generates a new 3 km model at
the window centre. `SceneHandle.setDetailWindow()` records the picker selection;
`SceneHandle.focusDetailWindow()` crops the rendered city to the square and
frames it (snapping under reduced motion). `panBy()`/`zoomBy()` power keyboard
navigation, and `renderNow()` lets
tests force a readback frame while on-demand rendering is settled. Model-space window
coordinates are metres relative to the model centre; `detailWindowToGeo()`
converts the centre back to WGS84.
