# Sunlight — independent E2E, visual, accessibility and performance QA

Date: 2026-11-16 · Verifier: qa-verifier (independent)
Scope: browser E2E, visual QA, accessibility basics, performance smoke. No feature work.

## Environment

- macOS 27.2.1 (arm64, Apple M4 Pro), Node v26.13.1, npm deps installed (no installs run).
- Google Chrome 157.0.8103.52, headless, WebGL2 via SwiftShader:
  `--enable-unsafe-swiftshader --use-angle=swiftshader`.
- App under test: production build (`dist/` + `dist-server/`) served by the E2E runner;
  `CITY_SOURCE=seed SEEDS_ONLY=1`, random free port, isolated temp cache
  (`.cache/e2e`), external network blocked in every browser context via
  `context.route(...)`.
- Seeds: 8 baked Romanian models (Brașov default: `gn-683844-r900-v1`, 2,872 buildings).

## Commands

```bash
npm run test:e2e                 # full: build SPA + server bundle, start seed-only server, run tests (~45 s)
E2E_SKIP_BUILD=1 npm run test:e2e  # reuse existing build (dev loop)
```

Tests: `tests/e2e/app.test.mjs` (functional), `tests/e2e/visual.test.mjs`
(screenshots/visual/perf/a11y), shared helpers in `tests/e2e/helpers.mjs`.
node:test + playwright-core; state-based waits on `window.__sunlight` only.

## Result: GREEN — 19/19 tests pass, 0 fail, ~43 s

| # | Check | Result |
|---|-------|--------|
| 1 | Seeded first run: phase ready, Brașov chip, model key, canvas non-blank (WebGL readPixels), ≤25 draw calls | PASS |
| 2 | Deep link `/?city=gn:683844&date=2026-06-21&time=13:20` → 13:20, sun alt 67.8°, az 180° S, kind `sun`, shadow on, sunrise 05:28 / sunset 21:10 | PASS |
| 3 | Slider 20:45 → golden mood, sun alt 3.1°, az 301° WNW, long-shadow state | PASS |
| 4 | Slider 23:30 → night mood, sun −16°, moonlight kind `moon` | PASS |
| 5 | Date input 2026-12-21 → sky reloaded, max altitude 19.4° vs 67.8°, sunrise/sunset differ | PASS |
| 6 | URL reload restores city + date + minute (URL round-trip) | PASS |
| 7 | Search “Cluj” → result click switches chip/model to Cluj-Napoca (`gn-681290`), dialog closes, URL updates | PASS |
| 8 | Geolocation stub + Locate → nearest city Brașov, chip/model switch, “Nearest city: Braşov (0 km)” notice | PASS |
| 9 | Pan changes camera target (light direction unchanged); wheel zoom 1→1.82→0.46; reset restores az 45°/pitch 35.26°/zoom 1 | PASS |
| 10 | Play advances minute, pause holds time, aria-pressed/label update | PASS |
| 11 | Escape closes search and About dialogs (`data-dialog` cleared) | PASS |
| 12 | Mobile 390×844: 9 key controls visible/in-viewport, no horizontal overflow, ≥40 px play target, controls usable | PASS |
| 13–15 | Canonical screenshots (noon/golden/night) + brightness ordering + mobile shot | PASS |
| 16 | Performance smoke (see numbers) | PASS |
| 17 | A11y basics: roles/names, slider `aria-valuetext`, date label, sun-path img name, h1, focus-visible ring | PASS |
| 18 | Dialog focus trap: focus enters search input / About, Tab stays trapped, Escape restores focus | PASS |
| 19 | `prefers-reduced-motion: reduce` suppresses transitions/animations | PASS |

No page errors or console errors in any of the 19 browser runs.

## Screenshots (`qa/shots/`, 1440×900 unless noted)

| File | State | Luminance mean / std |
|------|-------|----------------------|
| `brasov-noon.png` | 2026-06-21 13:20, sun 67.8° S | 182.8 / 60.9 |
| `brasov-morning.png` | 2026-06-21 07:30, sun 18.4° ENE (extra shadow evidence) | 174.8 / 65.6 |
| `brasov-golden.png` | 20:45, sun 3.1° WNW, 18× shadows | 148.8 / 73.2 |
| `brasov-night.png` | 23:30, sun −16°, moon 15.2° WSW | 104.3 / 89.6 |
| `brasov-mobile.png` | 390×844 @2×, noon | 201.0 / 41.6 |

Visual review (read_image): composition and warm placard design are coherent; panels do
not clip content at 1440×900; no shadow acne, peter-panning or missing shadow contact;
noon shadows are short and cast northward (sun due S); golden-hour shadows are clearly
long and cast eastward (sun WNW); morning shadows fall opposite the evening ones, all
consistent with the reported sun azimuth track. Night scene is legible but very dark
(building sides near-black) — stylistically acceptable.

## Performance smoke

- `getSceneDebug().render` at 1440×900: **drawCalls 7, triangles 149,829, fps 18.0**
  (SwiftShader; observed range 11–42 depending on load — software rasteriser, not
  representative of GPU hardware; no assertion on absolute fps).
- Model: 130,816 B gzip / 383,795 B decoded for Brașov; sky payload ~4.3 KB gzip.
- Camera: az 45°, pitch 35.26°, zoom 1, target Y 15.25.
- Heap after 3 city loads: 30 → 51 → 73 MB, then back to 42 MB after revisit; draw
  calls stay at 7 — no geometry leak or explosion.

## Defects and gaps (no blockers; app is acceptance-ready)

| Sev | Area | Issue / repro |
|-----|------|----------------|
| Minor | Visual, mobile | Portrait 390×844: diorama occupies a small central band with a large empty sky; camera does not re-fit for narrow aspect (repro: mobile viewport, default load → `brasov-mobile.png`). Consider a portrait-specific fit. |
| Minor | A11y | No `<main>` landmark and no skip link; panels are `<section>`s without accessible names. Repro: DOM query `document.querySelector('main') === null`. |
| Minor | A11y, contrast | Micro-labels use `--ink-400 #94816a` on cream (`#fcf8ef`): 3.53:1 — below WCAG AA 4.5:1 — at 8.5–9 px uppercase (`.sl-seed-country`, `.sl-date-meta`). |
| Minor | Semantic | 23:30 shows “Astronomical twilight” in the time console while the light panel shows “Moonlight / moon shadows”. Both true (sun −16°, moon dominant) but reads inconsistent; consider an explicit moonlight label. |
| Info | Memory | `modelByKey` keeps every visited city model for the session (heap grows ~20 MB per switch, unbounded for many cities). Fine for normal use; add an LRU if long multi-city sessions matter. |
| Info | Perf | FPS must be re-checked on a hardware GPU; SwiftShader numbers are for smoke only. |

## Recommendation

Accept the build for the E2E/visual/accessibility contract: 19/19 green, no high-severity
defects, visual identity and solar/lunar lighting correct across day/golden/night,
149,829 triangles in 7 draw calls. Recommended follow-ups: mobile camera re-fit,
`<main>`/skip-link and contrast fixes on micro-labels, and a hardware-GPU perf pass.

## Lead follow-ups applied after this QA pass

- Added a `<main>` landmark and a keyboard skip link to the SPA shell.
- Darkened micro-label token `--ink-400` from `#94816a` (3.53:1) to `#7a6753` (5.09:1 on cream), meeting AA for small text.
- Night light labels now account for the moon: “Moonlight / Moonlit night / Moonlit twilight” instead of “Astronomical twilight” when the moon is up and dominant.
- Client model cache is now capped at 4 entries (LRU) instead of retaining every visited city.
- Mobile portrait camera framing remains a documented follow-up (no code change); all other QA checks re-ran green after the fixes: 261 unit/integration tests and 19/19 E2E.
