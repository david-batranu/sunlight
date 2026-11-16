# Sunlight — browser, visual, accessibility and performance QA

Date: 2026-11-16 · Verifier: qa-verifier (independent), extended by the lead after the v3 elevation pass.
Scope: real headless-Chrome E2E, visual QA, accessibility basics, performance smoke.

## Environment

- macOS (arm64, Apple M4 Pro), Node v26.13.1, dependencies installed.
- Google Chrome 157.0.8103.52, headless, WebGL2 via SwiftShader:
  `--enable-unsafe-swiftshader --use-angle=swiftshader`.
- Build under test: production `dist/` + `dist-server/`, served by the E2E runner on a random free port with `CITY_SOURCE=seed SEEDS_ONLY=1` and an isolated temp cache. External network is blocked in every browser context.
- Seeds: 8 baked Romanian models at model v3 / 1500 m radius, each with a 49 × 49 terrain heightfield from AWS Terrain Tiles. Brașov default: `gn-683844-r1500-v3`, 8,465 buildings, 2,671 roads, 289 areas, 224 named buildings, 1,112 named roads, 113.5 m of terrain relief (Tâmpa slopes).

## Commands

```bash
npm test                          # unit + integration, offline fixtures: 311/311
npm run test:e2e                  # build + seed-only server + Chrome: 23/23
E2E_SKIP_BUILD=1 npm run test:e2e # reuse current build (~53 s)
```

Tests: `tests/e2e/app.test.mjs` (functional), `tests/e2e/visual.test.mjs` (screenshots, visual, perf, a11y), helpers in `tests/e2e/helpers.mjs`; node:test + playwright-core.

## Result: GREEN — 23/23 E2E checks pass, 0 fail; 311/311 unit + integration tests pass

| # | Check | Result |
|---|-------|--------|
| 1 | Seeded first run: ready phase, Brașov chip, model key, non-blank WebGL canvas, merged draw calls | PASS |
| 2 | Deep link `2026-06-21 13:20` → sun altitude 67.8°, azimuth 180° S, sun light, shadows on | PASS |
| 3 | Slider 20:45 → golden mood, sun 3.1° WNW, long-shadow state | PASS |
| 4 | Slider 23:30 → night, sun −16°, moon light | PASS |
| 5 | Date input 2026-12-21 → different sunrise/sunset and max altitude | PASS |
| 6 | URL reload restores city, date and minute | PASS |
| 7 | Search → Cluj-Napoca switches chip/model/URL | PASS |
| 8 | Geolocation stub + Locate → nearest city Brașov | PASS |
| 9 | Pan/zoom/reset; light direction unchanged by camera | PASS |
| 10 | Play/pause advances and holds simulated time | PASS |
| 11 | Escape closes search and About dialogs | PASS |
| 12 | Mobile 390×844: controls visible/in-viewport, no horizontal overflow, touch targets | PASS |
| 13 | **Wide terrain model**: 1500 m radius → 5,000+ buildings, named landmarks/roads, 49×49 heightfield with 113.5 m relief; compass rose + caption rotate with camera and reset the view | PASS |
| 14 | **Feature tooltips**: hover shows the named feature under the pointer, click pins it with a close button, Escape dismisses | PASS |
| 15 | **Choose area**: button enables, pressed state, hint banner, body crosshair state, Cancel + Escape exit the mode | PASS (manual full recenter verified against the fixture provider: new `pt-…` model, city “Near Brașov”, date/time preserved) |
| 16 | **City switch → new city's local now**: historical deep link then switch to Cluj → local today and current minute | PASS |
| 17–19 | Canonical screenshots, mobile screenshot, brightness ordering | PASS |
| 20 | Performance smoke (9 draw calls, 437k triangles, terrain included) | PASS |
| 21 | A11y roles/names, slider `aria-valuetext`, date label, compass name, focus-visible | PASS |
| 22 | Dialog focus trap and Escape restore | PASS |
| 23 | Reduced-motion preference suppresses transitions | PASS |

No page errors or console errors in any of the 23 browser runs.

## Screenshots (`qa/shots/`)

| File | State |
|------|-------|
| `brasov-noon.png` | 2026-06-21 13:20, sun 67.8° S; wide diorama, terrain (Tâmpa on the left), compass, Choose area |
| `brasov-golden.png` | 20:45, sun 3.1° WNW, long shadows across the terrain |
| `brasov-night.png` | 23:30, sun −16°, moonlight |
| `brasov-mobile.png` | 390×844 @2×, noon, compass + bottom sheet |
| `brasov-morning.png` | 07:30, sun 18.4° ENE — opposite shadow direction evidence (re-run if present) |
| `feature-tooltip.png` | pinned tooltip for “Strada Poarta Șchei · Primary street” |


Visual review: composition and warm placard design remain coherent; panels do not clip at 1440×900; compass sits clear of the top bar/light panel/time console; tooltip is legible and flips/clamps at the viewport edge; no shadow acne, peter-panning or missing contact; noon shadows short/north, golden-hour shadows long/east, morning shadows opposite. Night is legible but intentionally dark.

## Performance smoke

- 1440×900, production build, SwiftShader: **9 draw calls, 437,405 triangles, ~22 fps**
  (SwiftShader is software rasterisation; FPS is not representative of a hardware GPU).
- Model: 367.4 KiB gzip for Brașov at 1500 m / 8,465 buildings including the 49 × 49 heightfield; sky payload ~4.3 KB gzip.
- Live generation verified separately: Sinaia v3 generated through the worker with a 160 m-clamped terrain relief sample (AWS tiles reachable).
- No geometry leak across city switches; draw calls stay merged.

## Defects and gaps

| Sev | Area | Issue |
|-----|------|-------|
| Minor | Visual, mobile | Portrait 390×844 fits the full wide base, so the diorama can read small with empty sky; portrait-specific framing is a follow-up. |
| Minor | Terrain | Terrain is a single 49 × 49 heightfield, 0.3× exaggerated and capped at 160 m; cliffs, bridges and precise summits outside the 3 km square are not modelled. |
| Minor | Perf | FPS must be re-checked on a hardware GPU; the SwiftShader number is a smoke test. |
| Info | E2E | Choose-area full recentering is verified manually against a fixture-capable server; the automated E2E server is seed-only, so the test covers the UI/mode contract only. |
| Info | Data | Heights are often inferred; some labels (e.g. cemetery areas) use broad kind names. |

## Recommendation

Accept the v3 pass: real elevation (Tâmpa now rises as a mountain rather than a flat park), wide 3 km models, landmark/road tooltips, orientation compass, choose-area recentering, and city-local-now switching are all integrated and verified. Remaining work is polish (portrait camera framing, hardware-GPU FPS pass) rather than functional defects.
