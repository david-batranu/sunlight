/**
 * Shared Playwright helpers for the Sunlight browser E2E suite.
 *
 * The runner (scripts/e2e.mjs) starts a seed-only server on a random port and
 * exports BASE_URL, QA_SHOTS and CHROME_PATH. Every context blocks all
 * non-local network access so the suite can never reach the internet.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8090';
export const SHOTS = process.env.QA_SHOTS ?? path.resolve('qa/shots');
export const CHROME_PATH =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

export const BRASOV = { geonameId: 683844, name: 'Brașov', key: 'gn-683844-r1500-v4' };
export const CLUJ = { geonameId: 681290, name: 'Cluj-Napoca', key: 'gn-681290-r1500-v4' };
/** Brașov city centre (GeoNames) for the geolocation stub. */
export const BRASOV_COORDS = { latitude: 45.64861, longitude: 25.60613 };

const LAUNCH_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--mute-audio'
];

export async function launchBrowser() {
  assert.ok(fs.existsSync(CHROME_PATH), `Chrome not found at ${CHROME_PATH}`);
  return chromium.launch({ executablePath: CHROME_PATH, headless: true, args: LAUNCH_ARGS });
}

function isLocal(url) {
  return (
    url.startsWith(BASE_URL) ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('about:')
  );
}

/** Opens a fresh page in a context with network blocked; collects page errors. */
export async function openPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: DESKTOP,
    ...options
  });
  await context.route('**/*', (route) =>
    isLocal(route.request().url()) ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The QA browser deliberately blocks all external requests. Optional map
    // tiles surface as a benign net::ERR_FAILED console entry before the
    // minimap falls back to the loaded model; ignore those only.
    if (/net::ERR_FAILED/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return { context, page, errors };
}

export function pathWith(query) {
  return `${BASE_URL}/${query ? `?${query}` : ''}`;
}

/** Waits until the app reports a ready phase, a loaded model and rendered frames. */
export async function waitReady(page, timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const state = window.__sunlight?.getState();
      const debug = window.__sunlight?.getSceneDebug();
      return (
        state?.phase === 'ready' &&
        !!state.model &&
        !!debug?.modelKey &&
        debug?.render?.drawCalls > 0 &&
        debug?.render?.triangles > 0
      );
    },
    null,
    { timeout }
  );
}

export async function gotoReady(page, query = '', timeout = 30_000) {
  await page.goto(pathWith(query), { waitUntil: 'domcontentloaded' });
  await waitReady(page, timeout);
}

/** Small, JSON-serialisable projection of the (potentially huge) app state. */
export async function readState(page) {
  return page.evaluate(() => {
    const state = window.__sunlight.getState();
    const pick = (selector) => document.querySelector(selector);
    return {
      phase: state.phase,
      city: state.city
        ? { name: state.city.name, geonameId: state.city.geonameId, tz: state.city.tz }
        : null,
      date: state.date,
      minute: state.minute,
      playing: state.playing,
      speed: state.speed,
      error: state.error ? { code: state.error.code, message: state.error.message } : null,
      notices: state.notices.slice(),
      current: state.current,
      modelKey: state.model?.key ?? null,
      radiusM: state.model?.meta?.radiusM ?? null,
      terrain: state.model?.terrain
        ? {
            cols: state.model.terrain.cols,
            rows: state.model.terrain.rows,
            baseM: state.model.terrain.baseM,
            maxReliefM: Math.max(...state.model.terrain.h) / 10
          }
        : null,
      stats: state.model?.meta?.stats ?? null,
      namedBuildings: state.model?.buildings?.filter((building) => !!building.n).length ?? 0,
      namedRoads: state.model?.roads?.filter((road) => !!road.n).length ?? 0,
      namedAreas: state.model?.areas?.filter((area) => !!area.n).length ?? 0,
      cameraAzimuthDeg: state.cameraAzimuthDeg,
      hover: state.hover ? { name: state.hover.feature.name, kind: state.hover.feature.kind, sticky: state.hover.sticky } : null,
      pickingArea: state.pickingArea,
      detailPanelOpen: state.detailPanelOpen,
      detailWindow: state.detailWindow ? { ...state.detailWindow } : null,
      sky: state.sky
        ? {
            sun: state.sky.sun,
            moon: state.sky.moon,
            utcOffsetMinutes: state.sky.utcOffsetMinutes,
            dayStartUtc: state.sky.dayStartUtc,
            dayEndUtc: state.sky.dayEndUtc,
            polarDay: state.sky.polarDay,
            polarNight: state.sky.polarNight
          }
        : null,
      mood: document.body.dataset.mood ?? null,
      phaseAttr: document.body.dataset.phase ?? null,
      dialog: document.querySelector('.sl-app')?.dataset.dialog ?? null,
      chip: pick('[data-testid="city-name"]')?.textContent ?? null,
      meta: pick('[data-testid="city-meta"]')?.textContent ?? null,
      readout: pick('[data-testid="time-readout"]')?.textContent ?? null,
      dateReadout: pick('[data-testid="date-readout"]')?.textContent ?? null,
      tzReadout: pick('[data-testid="tz-readout"]')?.textContent ?? null,
      rise: pick('[data-testid="rise-readout"]')?.textContent ?? null,
      set: pick('[data-testid="set-readout"]')?.textContent ?? null,
      quality: pick('[data-testid="light-quality"]')?.textContent ?? null,
      sliderValue: pick('[data-testid="time-slider"]')?.value ?? null,
      sliderText: pick('[data-testid="time-slider"]')?.getAttribute('aria-valuetext') ?? null,
      dateInputValue: pick('[data-testid="date-input"]')?.value ?? null,
      moodAttr: document.body.dataset.mood ?? null
    };
  });
}

export async function readDebug(page) {
  return page.evaluate(() => window.__sunlight.getSceneDebug());
}

/** Sets the range slider like a user would and waits for the state to settle. */
export async function setMinute(page, minute) {
  await page.locator('[data-testid="time-slider"]').fill(String(minute));
  await page.waitForFunction(
    (target) => Math.abs((window.__sunlight?.getState().minute ?? -1) - target) < 1.5,
    minute,
    { timeout: 5000 }
  );
}

/** Fills the native date input and waits for the new sky payload to arrive. */
export async function setDate(page, date, previousMaxAltitude) {
  await page.locator('[data-testid="date-input"]').fill(date);
  await page.waitForFunction(
    ({ target, previous }) => {
      const state = window.__sunlight?.getState();
      return (
        state?.date === target &&
        !!state.sky &&
        Math.abs(state.sky.sun.maxAltitudeDeg - previous) > 1
      );
    },
    { target: date, previous: previousMaxAltitude },
    { timeout: 20_000 }
  );
}

/** Takes a screenshot into QA_SHOTS (1440x900 viewport unless overridden). */
export async function screenshot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, animations: 'disabled' });
  return file;
}

/**
 * Decodes a PNG screenshot inside the browser and returns luminance/colour
 * statistics. This lets us assert "non-blank" and day-vs-night brightness
 * without adding an image-decoding dependency to the project.
 */
export async function imageStats(page, buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Set();
    let sum = 0;
    let sumSquares = 0;
    let samples = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSquares += luminance * luminance;
      samples += 1;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
    const mean = sum / samples;
    return {
      width: image.width,
      height: image.height,
      mean,
      stdDev: Math.sqrt(Math.max(0, sumSquares / samples - mean * mean)),
      colors: colors.size
    };
  }, buffer.toString('base64'));
}

/**
 * Reads the WebGL2 framebuffer inside requestAnimationFrame, after the app has
 * rendered its frame. Proves the 3D canvas has actual geometry pixels rather
 * than being a blank/transparent surface.
 */
export async function canvasPixelStats(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        requestAnimationFrame(() => {
          try {
            const canvas = document.getElementById('scene');
            const gl = canvas.getContext('webgl2');
            if (!gl) throw new Error('no webgl2 context');
            const size = 160;
            const x = Math.max(0, Math.floor((canvas.width - size) / 2));
            const y = Math.max(0, Math.floor((canvas.height - size) / 2));
            const pixels = new Uint8Array(size * size * 4);
            gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const colors = new Set();
            let opaque = 0;
            let sum = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              colors.add(
                ((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3)
              );
              if (pixels[i + 3] > 0) opaque += 1;
              sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
            }
            resolve({
              colors: colors.size,
              opaque,
              total: size * size,
              meanColor: sum / (size * size * 3)
            });
          } catch (error) {
            reject(error);
          }
        });
      })
  );
}

/** Asserts no uncaught page errors / console errors were collected. */
export function assertNoErrors(errors, context = '') {
  assert.deepEqual(errors, [], `${context} expected no page/console errors, got: ${errors.join(' | ')}`);
}

export async function closePage(handle) {
  await handle.context.close();
}
