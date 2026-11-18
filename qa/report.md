# Sunlight QA report

**Date:** 2026-11-18 · **Version:** 0.2.4
**Environment:** macOS arm64 (Apple M4 Pro), Node v26.13.1, Chrome headless + SwiftShader for E2E.
**Result:** GREEN — **422/422** unit + integration tests, **29/29** browser E2E checks, typecheck clean, production build clean.

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | pass (web + server + tests) |
| `npm test` | **422/422** pass, offline fixtures, ~12 s |
| `npm run build` | pass; SPA JS ~687 kB raw / ~184 kB gzip, CSS ~53 kB / ~11 kB gzip |
| `npm run test:e2e` | **29/29** pass, ~76 s, seed-only server, isolated cache, external browser traffic blocked |
| `docker compose config` | pass (compose v2; read-only container, cache volume, hardened options) |

## What this QA pass covers

### Security / operations
- Proxy-aware rate limits (`TRUST_PROXY`, validated `X-Forwarded-For`, IPv6 `/64` buckets); generation/read/sky limits; 429 + `Retry-After`.
- Generation rate limit counted after validation; health/readiness exempt.
- Worker boot-crash fallback, truthful `/api/health` (`ok/ready/degraded/status/checks/build/worker/http`) and `/api/ready` (200/503).
- Degraded models (terrain/partial coverage) use short cache, are flagged in metadata and are re-baked by the seed quality gate.
- Cache version/radius pruning, positive `CACHE_MAX_MB=0` semantics, seed-manifest/constants guard.
- Queue-depth, per-client, queued-age and negative-cache limits; process-wide upstream token buckets; Retry-After handling.
- HEAD model requests, bad-model-key 400, single-gzip responses, error redaction, HSTS and hardened container settings.
- CI now runs typecheck + unit/integration + browser E2E before any image publish.

### Rendering / performance
- On-demand render scheduler: paused/settled scene renders **0 frames/s** and does not rebuild shadows.
- Explicit PCF shadow map; shadows invalidated by lighting/model/quality only.
- Adaptive low quality on coarse-pointer/small screens; DPR 1.25, 1024 shadows, no trees.
- Terrain subdivision reduced, unused vertex normals removed, vertex colours packed to Uint8: ~45% less VBO/upload volume.
- Debug exposes `framesRendered`, median/p95 frame interval, rendered frames/s, quality and DPR.

Measured E2E (1440×900, SwiftShader): last frame **26 draw calls / 439,469 triangles** including the shadow pass and the low-quality context plane; settled wide main pass **15 draws / 245,147 triangles**; a focused 100 m window renders **13 draws / 223,371 triangles** after 3×3 building-chunk frustum culling; idle render **0/s**. Hardware GPU steady state remains 60 fps vsync; true SwiftShader steady cadence is ~5.7 fps (the transient `fps` EMA is replaced by rolling median/p95).

### Usability / accessibility
- Area picker now becomes a modal sheet at ≤1180 px wide or ≤620 px tall, so the time console cannot cover it; map is 1:1 and unclipped at 320–430 px widths and 200% zoom.
- Larger Area panel and map (400 px / 366 px map on desktop, 280 px map on phones); map drag-to-pan, wheel/pinch zoom and buttons down to 625 m radius; 100 m window becomes ~25 CSS px at max zoom; footprint and numeric centre shown; Alt+arrow fine steps (1% radius).
- Focus now crops the rendered diorama to the selected square (fragment discard plus cut-edge skirt and clipped shadow depth), frames it tightly (size maps to rendered extent: 100 m close-up tile → 1500 m whole city), closes the picker so the result is visible, keeps the selection for reopening, and never zooms out below the model-fit view. The grey context mask is gone; only the selected high-detail square is rendered, surrounded by the low-quality OSM context map.
- Space activates focused controls (global playback shortcut is suppressed); Enter works; Escape closes the Area panel even from inputs and restores focus to Area.
- Progress/error overlays focus and trap correctly, background is inert; mobile light sheet is a proper dialog.
- Keyboard diorama navigation: focus `#scene`, arrows pan (Shift larger), `+`/`-` zoom.
- Filterable **Named places** list in the light panel is an accessible alternative to pointer-only tooltips; pinned tooltips no longer auto-hide.
- Primary action contrast ≥4.5:1; micro-labels raised to 11 px where feasible; 44 px coarse-pointer targets.
- Persistent OSM attribution in the time console/Area picker; the main view loads low-resolution OSM context tiles and the About privacy copy discloses both the context and Area tile requests plus coordinate deep links. Cached point areas are listed through a bounded nearby query and shown as anonymous footprints.
- Cached custom areas are reused by exact cache key from the context-map footprints; a fixture-server test verifies that clicking a listed footprint issues no POST/generation and opens the cached key.
- Notices auto-dismiss with hover/focus pause; raw error codes are behind “Technical details”.

### Recent E2E checks added
- Seeded first run / canvas readback with the on-demand renderer.
- Deep link date/sun position; date/time controls; city search, geolocation and city switching.
- Camera pan/orbit/zoom/reset; compass; tooltips; playback.
- Area picker open, default Focus crop + tight frame + picker close + selection restore, resize-without-camera, drag without reload, Escape/close/focus return.
- 200%-zoom and 375×667 Area sheet/map layout; Space-on-controls; Today-preserves-time vs Now; overview map zoom; keyboard pan/zoom; Named places list; mobile layout and reduced motion.

## Screenshots

`qa/shots/` is regenerated by `npm run test:e2e`:

- `brasov-noon.png`, `brasov-golden.png`, `brasov-night.png`, `brasov-mobile.png`
- `detail-area.png` (offline E2E fallback; production also loads OSM context tiles)
- `docs/screenshots/cached-areas.webp` shows the optional cached custom-area footprints (captured against the fixture cache).
- `feature-tooltip.png`

## Known limitations / remaining work

- Buildings are split into a 3×3 grid for frustum culling (wide view 26 shadow-inclusive draws including the context plane, 100 m focus 13 draws / 223k triangles); terrain/roads/areas remain merged, so very high zoom still submits most non-building geometry. Full detail-tile LOD and camera-fitted shadow LOD remain architectural follow-ups.
- Hover picking uses a conservative spatial broad phase: sampled p95 is ≤1.77 ms in the benchmark harness with **0 mismatches over 10,080 rays**; unnamed blockers still block correctly.
- Cold load still uploads the full merged geometry; off-main-thread geometry building/transferables are future work. Camera-fitted shadow LOD and full detail-tile terrain LOD are deliberately deferred after a measured cost/benefit analysis (orbit-invariant fit would only gain ~1.35–1.7× texel density and risks wide-view shadow regressions).
- Real VoiceOver/NVDA/TalkBack, Safari/Firefox, physical touch devices and forced-colors/HCM were not tested in this automated pass.
- Shadow maps are crisp at mid/high sun; within a few degrees of the horizon the direct sun contribution is small relative to ambient, so the advertised long shadows are visually subtle in the flat-shaded palette. A dedicated long-range shadow strategy or stronger golden-hour grading is a follow-up, not an automated QA failure.
- The Area picker still fetches a handful of OSM raster tiles directly from the browser (disclosed in About); an operator running at scale should proxy/self-host or use a commercial tile provider.
- Screenshots are generated locally under ignored `qa/shots/` and uploaded as a CI artefact; the README uses small WebP copies in `docs/screenshots/`.
