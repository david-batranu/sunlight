/**
 * Application bootstrap and integration. The lead owns this file.
 *
 * Responsibilities: URL/state plumbing, API calls and job polling, sky loading,
 * the time playback loop, scene/UI wiring, and the E2E debug handle.
 */

import './styles/tokens.css';
import './styles/app.css';

import type {
  CityModel,
  CitySearchResult,
  CreateModelResponse,
  ModelTarget,
  NearestCityResponse,
  SkyDay
} from '../shared/types.ts';
import { SEED_BY_GEONAME_ID, DEFAULT_CITY_GEONAME_ID } from '../shared/constants.ts';
import type { AppActions, CurrentLight, SceneHandle, UIContext } from './app/contracts.ts';
import { ApiRequestError, createApi } from './app/api.ts';
import { createInitialState, createStore, type AppState } from './app/state.ts';
import {
  addDays,
  clampDate,
  formatMinuteOfDay,
  interpolateSky,
  isValidDateString,
  minuteNowInTimezone,
  todayInTimezone
} from './app/time.ts';
import { parseUrlState, replaceUrl } from './app/url.ts';
import { createScene } from './scene/scene.ts';
import { createUI } from './ui/shell.ts';

const POLL_INTERVAL_MS = 700;
const SKY_PREFETCH_DELAY_MS = 1200;
const HOVER_THROTTLE_MS = 70;
const STICKY_TOOLTIP_MS = 5000;
const METRES_PER_DEGREE = 111_320;

interface LoadOptions {
  /** New-city selection: always jump to that city's current local date/time. */
  resetToNow?: boolean;
  /** Keep the currently displayed local date/time (area recentering). */
  preserveTime?: boolean;
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const uiRoot = document.querySelector<HTMLElement>('#ui');
const boot = document.querySelector<HTMLElement>('#boot');
if (!canvas || !uiRoot) throw new Error('Sunlight: missing #scene or #ui');

const api = createApi(import.meta.env.BASE_URL || '/');
const scene: SceneHandle = createScene(canvas);
const store = createStore(createInitialState());
const urlState = parseUrlState(window.location.search);

let explicitDate: string | null = urlState.date;
let explicitMinute: number | null = urlState.minute;
let activeTarget: ModelTarget = urlState.target ?? { kind: 'city', geonameId: DEFAULT_CITY_GEONAME_ID };
let activeJobId: string | null = null;
let loadToken = 0;
let skyToken = 0;
const MODEL_CACHE_LIMIT = 4;
const modelByKey = new Map<string, CityModel>();

function rememberModel(model: CityModel): void {
  modelByKey.delete(model.key);
  modelByKey.set(model.key, model);
  while (modelByKey.size > MODEL_CACHE_LIMIT) {
    const oldest = modelByKey.keys().next().value;
    if (oldest === undefined) break;
    modelByKey.delete(oldest);
  }
}

function recallModel(key: string): CityModel | undefined {
  const model = modelByKey.get(key);
  if (model) {
    modelByKey.delete(key);
    modelByKey.set(key, model);
  }
  return model;
}
let skyCache = new Map<string, SkyDay>();
let labelHint: string | null = null;
let userTouchedTime = urlState.date !== null || urlState.minute !== null;
let destroyed = false;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorFromUnknown(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ApiRequestError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) return { code: 'INTERNAL', message: error.message, retryable: true };
  return { code: 'INTERNAL', message: 'Something went wrong.', retryable: true };
}

function seedLabelForTarget(target: ModelTarget): string | null {
  if (target.kind === 'city') return SEED_BY_GEONAME_ID.get(target.geonameId)?.name ?? labelHint;
  return target.name ?? 'My location';
}

function targetFromSearchResult(result: CitySearchResult): ModelTarget {
  return { kind: 'city', geonameId: result.geonameId };
}

function skyCacheKey(city: { lat: number; lon: number }, date: string): string {
  return `${city.lat.toFixed(4)}|${city.lon.toFixed(4)}|${date}`;
}

function publishUrl(state: AppState): void {
  replaceUrl(activeTarget, state.date, state.minute);
}

function setNotices(notices: string[]): void {
  store.setState({ notices: notices.slice(0, 4) });
}

function addNotice(message: string): void {
  const current = store.getState().notices;
  if (current.includes(message)) return;
  setNotices([...current, message]);
}

function hideBoot(): void {
  if (!boot || boot.classList.contains('booted')) return;
  boot.classList.add('booted');
  window.setTimeout(() => boot.remove(), reducedMotion ? 0 : 600);
}

function currentLightFor(sky: SkyDay | null, minute: number): CurrentLight | null {
  return interpolateSky(sky, minute);
}

function setCurrentFromSky(sky: SkyDay | null, minute: number): CurrentLight | null {
  return currentLightFor(sky, minute);
}

/* ------------------------------------------------------------------ */
/* Sky loading                                                        */
/* ------------------------------------------------------------------ */

async function fetchSky(city: { lat: number; lon: number }, date: string): Promise<SkyDay> {
  const cacheKey = skyCacheKey(city, date);
  const cached = skyCache.get(cacheKey);
  if (cached) return cached;
  const sky = await api.loadSky(city.lat, city.lon, date);
  skyCache.set(cacheKey, sky);
  if (skyCache.size > 24) {
    const first = skyCache.keys().next().value;
    if (first) skyCache.delete(first);
  }
  return sky;
}

function prefetchNeighborDays(city: { lat: number; lon: number }, date: string): void {
  window.setTimeout(() => {
    for (const offset of [1, -1]) {
      const neighbor = addDays(date, offset);
      if (neighbor < '1900-01-01' || neighbor > '2100-12-31') continue;
      void fetchSky(city, neighbor).catch(() => undefined);
    }
  }, SKY_PREFETCH_DELAY_MS);
}

async function applySky(date: string, token: number): Promise<void> {
  const state = store.getState();
  if (!state.city) return;
  const myToken = ++skyToken;
  try {
    const sky = await fetchSky(state.city, date);
    if (myToken !== skyToken || token !== loadToken || destroyed) return;
    const minute = store.getState().minute;
    store.setState({
      sky,
      current: setCurrentFromSky(sky, minute),
      phase: 'ready',
      error: null
    });
    scene.setSky(sky);
    scene.setTime(minute);
    prefetchNeighborDays(state.city, date);
    hideBoot();
  } catch (error) {
    const info = errorFromUnknown(error);
    if (myToken !== skyToken || token !== loadToken) return;
    store.setState({
      phase: 'ready',
      current: null,
      notices: [...store.getState().notices, `Sky data unavailable: ${info.message}`]
    });
    hideBoot();
  }
}

/* ------------------------------------------------------------------ */
/* Model loading                                                      */
/* ------------------------------------------------------------------ */

async function applyModel(model: CityModel, token: number, options: LoadOptions = {}): Promise<void> {
  if (token !== loadToken) return;
  rememberModel(model);
  const tz = model.city.tz;
  const state = store.getState();
  let date: string;
  let minute: number;
  if (options.resetToNow) {
    date = todayInTimezone(tz);
    minute = minuteNowInTimezone(tz);
    explicitDate = null;
    explicitMinute = null;
    userTouchedTime = false;
  } else if (options.preserveTime) {
    date = state.date;
    minute = state.minute;
    explicitDate = date;
    explicitMinute = Math.floor(minute);
  } else {
    date = explicitDate && isValidDateString(explicitDate) ? clampDate(explicitDate) : todayInTimezone(tz);
    minute =
      explicitMinute != null
        ? Math.max(0, Math.min(1439, explicitMinute))
        : userTouchedTime
          ? Math.max(0, Math.min(1439, state.minute))
          : minuteNowInTimezone(tz);
  }

  store.setState({
    city: model.city,
    model,
    sky: skyCache.get(skyCacheKey(model.city, date)) ?? null,
    date,
    minute,
    phase: 'loading',
    progress: null,
    generatingName: null,
    error: null,
    current: null,
    notices: state.notices
  });
  document.title = `Sunlight — ${model.city.name}`;
  publishUrl(store.getState());
  await applySky(date, token);
  if (token === loadToken) {
    store.setState({ phase: 'ready' });
  }
}

async function loadCity(target: ModelTarget, label?: string | null, options: LoadOptions = {}): Promise<void> {
  const token = ++loadToken;
  activeTarget = target;
  labelHint = label ?? null;
  activeJobId = null;
  skyToken += 1;

  const seedName = seedLabelForTarget(target);
  store.setState({
    phase: 'resolving',
    model: null,
    sky: null,
    current: null,
    progress: null,
    generatingName: seedName,
    error: null
  });
  hideBoot();

  try {
    const created: CreateModelResponse = await api.createModel(target);
    if (token !== loadToken) return;
    if (created.state === 'ready') {
      store.setState({ phase: 'loading' });
      const model = recallModel(created.key) ?? (await api.loadModel(created.key));
      await applyModel(model, token, options);
      return;
    }

    activeJobId = created.jobId;
    store.setState({
      phase: 'generating',
      progress: { step: 'fetch', label: 'Queued', percent: 2 }
    });
    await pollJob(created.jobId, created.key, token, options);
  } catch (error) {
    if (token !== loadToken) return;
    const info = errorFromUnknown(error);
    store.setState({
      phase: 'error',
      progress: null,
      generatingName: store.getState().generatingName ?? seedName,
      error: { ...info, targetName: seedName ?? undefined }
    });
    hideBoot();
  }
}

async function pollJob(jobId: string, key: string, token: number, options: LoadOptions = {}): Promise<void> {
  while (token === loadToken && !destroyed) {
    let job;
    try {
      job = await api.getJob(jobId);
    } catch (error) {
      const info = errorFromUnknown(error);
      store.setState({
        phase: 'error',
        progress: null,
        error: { ...info, targetName: store.getState().generatingName ?? undefined }
      });
      return;
    }
    if (token !== loadToken) return;

    if (job.state === 'done' && job.modelUrl !== undefined) {
      activeJobId = null;
      store.setState({ phase: 'loading', progress: { step: 'write', label: 'Ready', percent: 100 } });
      try {
        const model = await api.loadModel(key);
        await applyModel(model, token, options);
      } catch (error) {
        if (token !== loadToken) return;
        const info = errorFromUnknown(error);
        store.setState({
          phase: 'error',
          progress: null,
          error: { ...info, targetName: store.getState().generatingName ?? undefined }
        });
      }
      return;
    }
    if (job.state === 'error' || job.state === 'cancelled') {
      activeJobId = null;
      store.setState({
        phase: 'error',
        progress: null,
        error: {
          code: job.error?.code ?? (job.state === 'cancelled' ? 'CANCELLED' : 'MODEL_FAILED'),
          message: job.error?.message ?? (job.state === 'cancelled' ? 'Generation cancelled.' : 'Could not build this city.'),
          retryable: job.error?.retryable ?? true,
          details: job.error?.details,
          targetName: store.getState().generatingName ?? undefined
        }
      });
      return;
    }
    store.setState({ progress: job.progress });
    await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/* ------------------------------------------------------------------ */
/* Date / time actions                                                */
/* ------------------------------------------------------------------ */

async function changeDate(nextDate: string, opts: { keepMinute?: boolean } = {}): Promise<void> {
  if (!isValidDateString(nextDate)) return;
  const date = clampDate(nextDate);
  explicitDate = date;
  const state = store.getState();
  if (!state.city) {
    store.setState({ date });
    return;
  }
  const minute = opts.keepMinute === false ? 0 : state.minute;
  store.setState({ date, minute, current: setCurrentFromSky(state.sky, minute) });
  publishUrl(store.getState());
  await applySky(date, loadToken);
  scene.setTime(store.getState().minute);
}

function setMinute(nextMinute: number, opts: { rollDay?: boolean } = {}): void {
  const state = store.getState();
  let minute = nextMinute;
  let date = state.date;
  let dayChanged = false;
  if (opts.rollDay !== false) {
    while (minute < 0) {
      minute += 1440;
      date = addDays(date, -1);
      dayChanged = true;
    }
    while (minute >= 1440) {
      minute -= 1440;
      date = addDays(date, 1);
      dayChanged = true;
    }
  }
  minute = Math.max(0, Math.min(1439.999, minute));
  if (dayChanged) {
    explicitDate = date;
    store.setState({
      date,
      minute,
      current: setCurrentFromSky(state.sky, minute)
    });
    void applySky(date, loadToken);
  } else {
    store.setState({ minute, current: setCurrentFromSky(state.sky, minute) });
  }
  publishUrl(store.getState());
  scene.setTime(minute);
}

/* ------------------------------------------------------------------ */
/* Playback loop                                                      */
/* ------------------------------------------------------------------ */

let playheadDate = store.getState().date;
let playheadMinute = store.getState().minute;
let lastPublishedMinute = playheadMinute;
let lastPublishedDate = playheadDate;
let lastFrameAt = performance.now();
let lastCommitAt = 0;

function playbackTick(now: number): void {
  if (destroyed) return;
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const state = store.getState();

  // Adopt externally changed time (slider, deep link, date change).
  if (state.minute !== lastPublishedMinute) {
    playheadMinute = state.minute;
    lastPublishedMinute = state.minute;
  }
  if (state.date !== lastPublishedDate) {
    playheadDate = state.date;
    lastPublishedDate = state.date;
  }

  if (state.playing && state.sky) {
    playheadMinute += dt * state.speed;
    if (playheadMinute >= 1440) {
      if (state.loopDay) {
        playheadMinute %= 1440;
      } else {
        playheadDate = addDays(playheadDate, 1);
        playheadMinute %= 1440;
        explicitDate = playheadDate;
        lastPublishedDate = playheadDate;
        store.setState({ date: playheadDate });
        publishUrl(store.getState());
        void applySky(playheadDate, loadToken);
      }
    }
  } else {
    playheadMinute = state.minute;
  }

  scene.setTime(playheadMinute);

  if (now - lastCommitAt > 120) {
    lastCommitAt = now;
    lastPublishedMinute = playheadMinute;
    const current = setCurrentFromSky(store.getState().sky, playheadMinute);
    const cameraAzimuthDeg = scene.getCameraAzimuth();
    const previousAzimuth = store.getState().cameraAzimuthDeg;
    store.setState({
      minute: playheadMinute,
      current,
      ...(Math.abs(cameraAzimuthDeg - previousAzimuth) > 0.2 ? { cameraAzimuthDeg } : {})
    });
  }

  requestAnimationFrame(playbackTick);
}

/* ------------------------------------------------------------------ */
/* Actions                                                           */
/* ------------------------------------------------------------------ */

const actions: AppActions = {
  selectCity(target) {
    void loadCity(target, undefined, { resetToNow: true });
  },

  selectSearchResult(result) {
    void loadCity(targetFromSearchResult(result), result.name, { resetToNow: true });
  },

  async locate() {
    if (!navigator.geolocation) {
      addNotice('This browser cannot determine your location.');
      return;
    }
    addNotice('Locating you…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        void (async () => {
          try {
            const nearest: NearestCityResponse = await api.nearestCity(latitude, longitude);
            setNotices([`Nearest city: ${nearest.city.name} (${Math.round(nearest.distanceKm)} km)`]);
            if (nearest.distanceKm <= 80) {
              void loadCity(
                { kind: 'city', geonameId: nearest.city.geonameId },
                nearest.city.name,
                { resetToNow: true }
              );
            } else {
              void loadCity(
                { kind: 'point', lat: latitude, lon: longitude, name: 'My location' },
                'My location',
                { resetToNow: true }
              );
            }
          } catch (error) {
            const info = errorFromUnknown(error);
            addNotice(`Could not resolve your location: ${info.message}`);
          }
        })();
      },
      (error) => {
        addNotice(
          error.code === error.PERMISSION_DENIED
            ? 'Location permission was denied. Pick a city instead.'
            : 'Could not determine your location.'
        );
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 }
    );
  },

  setDate(date) {
    void changeDate(date);
  },

  setMinute(minute) {
    userTouchedTime = true;
    explicitMinute = Math.max(0, Math.min(1439, minute));
    setMinute(explicitMinute, { rollDay: false });
  },

  stepMinutes(delta) {
    userTouchedTime = true;
    setMinute(store.getState().minute + delta);
    explicitMinute = store.getState().minute;
  },

  togglePlay() {
    const state = store.getState();
    if (!state.sky) return;
    userTouchedTime = true;
    explicitMinute = Math.floor(state.minute);
    store.setState({ playing: !state.playing });
    lastFrameAt = performance.now();
    if (!state.playing) lastPublishedMinute = playheadMinute;
  },

  setSpeed(speed) {
    store.setState({ speed: Math.max(0.1, Math.min(3600, speed)) });
  },

  toggleLoop() {
    store.setState({ loopDay: !store.getState().loopDay });
  },

  stepDay(delta) {
    userTouchedTime = true;
    const date = addDays(store.getState().date, delta);
    void changeDate(date);
  },

  goToday() {
    const city = store.getState().city;
    if (!city) return;
    const date = todayInTimezone(city.tz);
    const minute = minuteNowInTimezone(city.tz);
    userTouchedTime = true;
    explicitDate = date;
    explicitMinute = minute;
    store.setState({ date, minute, current: setCurrentFromSky(store.getState().sky, minute) });
    publishUrl(store.getState());
    scene.setTime(minute);
    void applySky(date, loadToken);
  },

  setNow() {
    actions.goToday();
  },

  resetCamera() {
    scene.resetCamera();
    store.setState({ cameraAzimuthDeg: scene.getCameraAzimuth() });
  },

  retry() {
    if (activeTarget) void loadCity(activeTarget, store.getState().generatingName);
  },

  cancelGeneration() {
    if (!activeJobId) return;
    const jobId = activeJobId;
    activeJobId = null;
    void api.cancelJob(jobId).catch(() => undefined);
    loadToken += 1;
    store.setState({
      phase: 'error',
      progress: null,
      error: {
        code: 'CANCELLED',
        message: 'City generation was cancelled.',
        retryable: true,
        targetName: store.getState().generatingName ?? undefined
      }
    });
  },

  async copyLink() {
    publishUrl(store.getState());
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      addNotice('Link copied.');
      return true;
    } catch {
      addNotice('Copy failed — the address bar has the link.');
      return false;
    }
  },

  beginAreaPick() {
    const state = store.getState();
    if (state.phase !== 'ready' || !state.model) return;
    store.setState({ pickingArea: true, hover: null });
    addNotice('Tap or click the city to move the model there. Esc cancels.');
  },

  cancelAreaPick() {
    if (store.getState().pickingArea) store.setState({ pickingArea: false });
  },

  dismissHover() {
    if (store.getState().hover) store.setState({ hover: null });
  },

  dismissNotices() {
    setNotices([]);
  }
};

/* ------------------------------------------------------------------ */
/* Diorama pointer interaction: tooltips + choose-area               */
/* ------------------------------------------------------------------ */

let pointerDownAt: { x: number; y: number } | null = null;
let lastHoverAt = 0;
let stickyTimer: number | null = null;

function clearStickyTimer(): void {
  if (stickyTimer !== null) {
    window.clearTimeout(stickyTimer);
    stickyTimer = null;
  }
}

function hideHover(force = false): void {
  const hover = store.getState().hover;
  if (!hover) return;
  if (!force && hover.sticky) return;
  clearStickyTimer();
  store.setState({ hover: null });
}

function scheduleStickyHide(): void {
  clearStickyTimer();
  stickyTimer = window.setTimeout(() => {
    stickyTimer = null;
    if (store.getState().hover?.sticky) store.setState({ hover: null });
  }, STICKY_TOOLTIP_MS);
}

function showTooltip(clientX: number, clientY: number, sticky: boolean): void {
  const feature = scene.hitTest(clientX, clientY);
  if (!feature) {
    hideHover(true);
    return;
  }
  store.setState({ hover: { feature, x: clientX, y: clientY, sticky } });
  if (sticky) scheduleStickyHide();
  else clearStickyTimer();
}

/** Inverse of the server's local equirectangular projection (metres → WGS84). */
function latLonFromGround(x: number, z: number): { lat: number; lon: number } | null {
  const city = store.getState().city;
  if (!city) return null;
  const cosLat = Math.max(0.0001, Math.cos((city.lat * Math.PI) / 180));
  return {
    lat: city.lat - z / METRES_PER_DEGREE,
    lon: city.lon + x / (METRES_PER_DEGREE * cosLat)
  };
}

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
  const state = store.getState();
  if (state.pickingArea || state.phase !== 'ready') return;
  const now = performance.now();
  if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
  lastHoverAt = now;
  const current = state.hover;
  if (current?.sticky) return;
  showTooltip(event.clientX, event.clientY, false);
});

canvas.addEventListener('pointerleave', () => {
  hideHover();
  pointerDownAt = null;
});

canvas.addEventListener('pointerdown', (event) => {
  pointerDownAt = { x: event.clientX, y: event.clientY };
  hideHover();
});

canvas.addEventListener('pointercancel', () => {
  pointerDownAt = null;
  hideHover(true);
});

canvas.addEventListener('pointerup', (event) => {
  const start = pointerDownAt;
  pointerDownAt = null;
  if (!start) return;
  const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  if (moved > 8) return;

  const state = store.getState();
  if (state.pickingArea) {
    const ground = scene.getGroundPoint(event.clientX, event.clientY);
    if (!ground) {
      store.setState({ pickingArea: false });
      addNotice('Could not read that point on the model. Try again.');
      return;
    }
    const latLon = latLonFromGround(ground.x, ground.z);
    if (!latLon) {
      store.setState({ pickingArea: false });
      return;
    }
    const name = `Near ${state.city?.name ?? 'here'}`;
    store.setState({ pickingArea: false, hover: null });
    addNotice(`Moving the model to ${latLon.lat.toFixed(4)}, ${latLon.lon.toFixed(4)}…`);
    void loadCity({ kind: 'point', lat: latLon.lat, lon: latLon.lon, name }, name, {
      preserveTime: true
    });
    return;
  }

  if (state.phase === 'ready') showTooltip(event.clientX, event.clientY, true);
});

/* ------------------------------------------------------------------ */
/* UI + subscription                                                  */
/* ------------------------------------------------------------------ */

const uiContext: UIContext = {
  store,
  actions,
  searchCities: (query, limit) => api.searchCities(query, limit),
  nearestCity: (lat, lon) => api.nearestCity(lat, lon)
};

const ui = createUI(uiRoot, uiContext);
ui.update(store.getState());

store.subscribe((state, previous) => {
  if (state.model !== previous.model && state.model) {
    if (state.hover || state.pickingArea) {
      clearStickyTimer();
      store.setState({ hover: null, pickingArea: false });
    }
    scene.setModel(state.model);
    scene.setTime(state.minute);
  }
  if (state.sky !== previous.sky) {
    scene.setSky(state.sky);
  }
  if (state.date !== previous.date || state.minute !== previous.minute) {
    scene.setTime(state.minute);
  }
  ui.update(state);
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

void loadCity(activeTarget, seedLabelForTarget(activeTarget));
requestAnimationFrame(playbackTick);

// Debug handle for E2E and manual inspection.
declare global {
  interface Window {
    __sunlight?: {
      getState: () => AppState;
      getSceneDebug: () => ReturnType<SceneHandle['getDebug']>;
      actions: AppActions;
      loadCity: (target: ModelTarget, label?: string | null, options?: LoadOptions) => Promise<void>;
      hitTest: (x: number, y: number) => ReturnType<SceneHandle['hitTest']>;
      getGroundPoint: (x: number, y: number) => ReturnType<SceneHandle['getGroundPoint']>;
      api: typeof api;
      formatMinuteOfDay: typeof formatMinuteOfDay;
    };
  }
}
window.__sunlight = {
  getState: () => store.getState(),
  getSceneDebug: () => scene.getDebug(),
  actions,
  loadCity,
  hitTest: (x, y) => scene.hitTest(x, y),
  getGroundPoint: (x, y) => scene.getGroundPoint(x, y),
  api,
  formatMinuteOfDay
};
