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
import {
  DETAIL_CONTEXT_RADIUS_M,
  DETAIL_DEFAULT_RADIUS_M,
  MODEL_VERSION,
  SEED_BY_GEONAME_ID,
  SKY_VERSION,
  DEFAULT_CITY_GEONAME_ID
} from '../shared/constants.ts';
import type { AppActions, CurrentLight, DetailWindow, SceneHandle, UIContext } from './app/contracts.ts';
import { ApiRequestError, createApi } from './app/api.ts';
import { createInitialState, createStore, type AppState } from './app/state.ts';
import {
  clampDetailWindow as clampDetailWindowInFrame,
  detailWindowInsideModel,
  detailWindowToGeo,
  type DetailFrame
} from './app/detail.ts';
import {
  addDays,
  clampDate,
  formatMinuteOfDay,
  interpolateSky,
  isValidDateString,
  minuteNowInTimezone,
  todayInTimezone
} from './app/time.ts';
import { parseUrlState, pushUrl, replaceUrl } from './app/url.ts';
import { createScene } from './scene/scene.ts';
import { createUI } from './ui/shell.ts';

const POLL_INTERVAL_MS = 700;
const SKY_PREFETCH_DELAY_MS = 1200;
const HOVER_THROTTLE_MS = 70;

function currentModelDetailFrame(): DetailFrame | null {
  const model = store.getState().model;
  if (!model) return null;
  const bounds = model.bounds;
  return {
    centerX: (bounds.minX + bounds.maxX) / 20,
    centerZ: (bounds.minZ + bounds.maxZ) / 20,
    modelRadiusM: model.meta.radiusM,
    contextRadiusM: DETAIL_CONTEXT_RADIUS_M
  };
}

function clampDetailWindow(input: DetailWindow): DetailWindow | null {
  const frame = currentModelDetailFrame();
  if (!frame) return null;
  return clampDetailWindowInFrame(frame, input);
}

function defaultDetailWindow(): DetailWindow | null {
  const frame = currentModelDetailFrame();
  if (!frame) return null;
  const radiusM = Math.min(DETAIL_DEFAULT_RADIUS_M, frame.modelRadiusM);
  return clampDetailWindow({ centerX: frame.centerX, centerZ: frame.centerZ, radiusM });
}

interface LoadOptions {
  /** New-city selection: always jump to that city's current local date/time. */
  resetToNow?: boolean;
  /** Keep the currently displayed local date/time (area recentering). */
  preserveTime?: boolean;
  /** Push a browser-history entry instead of replacing the current one. */
  pushHistory?: boolean;
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const uiRoot = document.querySelector<HTMLElement>('#ui');
const boot = document.querySelector<HTMLElement>('#boot');
if (!canvas || !uiRoot) throw new Error('Sunlight: missing #scene or #ui');

function pageBasePath(): string {
  try {
    return new URL('.', document.baseURI).pathname;
  } catch {
    return '/';
  }
}

const api = createApi(pageBasePath());
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

let pendingHistoryMode: 'replace' | 'push' = 'replace';

function publishUrl(state: AppState): void {
  if (pendingHistoryMode === 'push') pushUrl(activeTarget, state.date, state.minute);
  else replaceUrl(activeTarget, state.date, state.minute);
  pendingHistoryMode = 'replace';
}

function setNotices(notices: string[]): void {
  store.setState({ notices: notices.slice(0, 4) });
}

function addNotice(message: string): void {
  const current = store.getState().notices;
  if (current.includes(message)) return;
  setNotices([...current, message]);
}

/** Teaches the click-to-load context map once per browser. */
function maybeShowMapHint(): void {
  try {
    if (window.localStorage.getItem('sunlight.contextMapHintSeen') === '1') return;
    window.localStorage.setItem('sunlight.contextMapHintSeen', '1');
  } catch {
    /* storage may be unavailable; don't nag every load */
    return;
  }
  addNotice('Drag to pan the map. Click the low-quality map outside the city to load that area.');
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
    if (sky.v !== SKY_VERSION) {
      throw new ApiRequestError(
        `Sky data version ${sky.v} does not match this app (${SKY_VERSION}). Refresh the page.`,
        409,
        'SKY_VERSION_MISMATCH',
        false
      );
    }
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
  if (model.v !== MODEL_VERSION) {
    store.setState({
      phase: 'error',
      progress: null,
      error: {
        code: 'MODEL_VERSION_MISMATCH',
        message: `This model is version ${model.v}, but this app expects version ${MODEL_VERSION}. Refresh the page or clear the cache.`,
        retryable: true,
        targetName: model.city?.name
      }
    });
    hideBoot();
    return;
  }
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
    notices: state.notices,
    detailWindow: null,
    detailPanelOpen: false
  });
  document.title = `Sunlight — ${model.city.name}`;
  publishUrl(store.getState());
  if (activeTarget.kind === 'point') {
    addNotice(`Loaded high-detail model: ${model.city.name}.`);
  }
  if (model.meta.degraded) {
    addNotice(
      `This city model is incomplete (${model.meta.degradedReasons?.join('; ') || 'terrain or map coverage degraded'}). It will refresh on the next generation.`
    );
  }
  await applySky(date, token);
  if (token === loadToken) {
    store.setState({ phase: 'ready' });
    maybeShowMapHint();
  }
}

async function loadCity(target: ModelTarget, label?: string | null, options: LoadOptions = {}): Promise<void> {
  const token = ++loadToken;
  activeTarget = target;
  pendingHistoryMode = options.pushHistory ? 'push' : 'replace';
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
    error: null,
    detailWindow: null,
    detailPanelOpen: false
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
    void loadCity(target, undefined, { resetToNow: true, pushHistory: true });
  },

  selectSearchResult(result) {
    void loadCity(targetFromSearchResult(result), result.name, { resetToNow: true, pushHistory: true });
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
                { resetToNow: true, pushHistory: true }
              );
            } else {
              void loadCity(
                { kind: 'point', lat: latitude, lon: longitude, name: 'My location' },
                'My location',
                { resetToNow: true, pushHistory: true }
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
    const state = store.getState();
    const city = state.city;
    if (!city) return;
    const date = todayInTimezone(city.tz);
    const minute = state.minute;
    userTouchedTime = true;
    explicitDate = date;
    explicitMinute = Math.floor(minute);
    store.setState({ date, current: setCurrentFromSky(state.sky, minute) });
    publishUrl(store.getState());
    scene.setTime(minute);
    void applySky(date, loadToken);
  },

  setNow() {
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

  toggleDetailPanel() {
    const state = store.getState();
    if (state.phase !== 'ready' || !state.model) return;
    if (state.detailPanelOpen) {
      actions.closeDetailPanel();
      return;
    }
    const window = state.detailWindow ?? defaultDetailWindow();
    if (!window) return;
    store.setState({ detailPanelOpen: true, detailWindow: window, hover: null });
    scene.setDetailWindow(window);
  },

  closeDetailPanel() {
    if (!store.getState().detailPanelOpen && !store.getState().detailWindow) return;
    store.setState({ detailPanelOpen: false, detailWindow: null });
    scene.setDetailWindow(null);
  },

  setDetailWindow(window) {
    const clamped = clampDetailWindow(window);
    if (!clamped) return;
    store.setState({ detailWindow: clamped });
  },

  focusDetailWindow() {
    const state = store.getState();
    const window = state.detailWindow ?? defaultDetailWindow();
    if (!window) return;
    scene.setDetailWindow(window);
    scene.focusDetailWindow(window);
    // Take the picker out of the way so the user sees the framed square. Keep
    // detailWindow in the store so reopening Area resumes the same selection.
    store.setState({ detailPanelOpen: false });
  },

  loadDetailArea() {
    const state = store.getState();
    const frame = currentModelDetailFrame();
    if (state.phase !== 'ready' || !state.model || !state.city || !state.detailWindow || !frame) {
      return;
    }
    // The loaded model already contains everything inside it; generating the
    // same data again would only cost time. Focus is the correct action there.
    if (detailWindowInsideModel(state.detailWindow, frame)) {
      actions.focusDetailWindow();
      addNotice('That area is already loaded — Focus zooms to it without rebuilding.');
      return;
    }
    const geo = detailWindowToGeo(state.city, state.detailWindow);
    const name = `Near ${state.city.name}`;
    addNotice(`Building a high-detail model near ${state.city.name}…`);
    void loadCity(
      { kind: 'point', lat: geo.lat, lon: geo.lon, name },
      name,
      { preserveTime: true, pushHistory: true }
    );
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

function updateMapCursor(clientX: number, clientY: number): void {
  if (!canvas) return;
  const frame = currentModelDetailFrame();
  if (!frame) {
    canvas.style.cursor = '';
    return;
  }
  const point = scene.getMapPoint(clientX, clientY);
  const outside =
    point !== null &&
    (Math.abs(point.x - frame.centerX) > frame.modelRadiusM ||
      Math.abs(point.z - frame.centerZ) > frame.modelRadiusM);
  canvas.style.cursor = outside ? 'crosshair' : '';
}
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

function showTooltip(clientX: number, clientY: number, sticky: boolean): void {
  const feature = scene.hitTest(clientX, clientY);
  if (!feature) {
    hideHover(true);
    return;
  }
  store.setState({ hover: { feature, x: clientX, y: clientY, sticky } });
  // Pinned tooltips stay until dismissed or another feature is activated, so
  // keyboard/screen-reader users have time to read them.
  clearStickyTimer();
}

canvas.addEventListener('keydown', (event) => {
  const state = store.getState();
  if (state.phase !== 'ready') return;
  const step = event.shiftKey ? 320 : 90;
  const azimuth = (scene.getCameraAzimuth() * Math.PI) / 180;
  // Screen-aligned pan: forward is toward the top of the viewport.
  const forwardX = -Math.sin(azimuth);
  const forwardZ = Math.cos(azimuth);
  const rightX = Math.cos(azimuth);
  const rightZ = Math.sin(azimuth);
  let dx = 0;
  let dz = 0;
  switch (event.key) {
    case 'ArrowUp':
      dx = forwardX * step;
      dz = forwardZ * step;
      break;
    case 'ArrowDown':
      dx = -forwardX * step;
      dz = -forwardZ * step;
      break;
    case 'ArrowLeft':
      dx = -rightX * step;
      dz = -rightZ * step;
      break;
    case 'ArrowRight':
      dx = rightX * step;
      dz = rightZ * step;
      break;
    case '+':
    case '=':
      event.preventDefault();
      event.stopPropagation();
      scene.zoomBy(1.2);
      return;
    case '-':
    case '_':
      event.preventDefault();
      event.stopPropagation();
      scene.zoomBy(1 / 1.2);
      return;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  hideHover();
  scene.panBy(dx, dz);
});

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
  const state = store.getState();
  if (state.phase !== 'ready') return;
  updateMapCursor(event.clientX, event.clientY);
  const now = performance.now();
  if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
  lastHoverAt = now;
  const current = state.hover;
  if (current?.sticky) return;
  showTooltip(event.clientX, event.clientY, false);
});

canvas.addEventListener('pointerleave', () => {
  hideHover();
  canvas.style.cursor = '';
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
  if (state.phase === 'ready') {
    showTooltip(event.clientX, event.clientY, true);
    maybeLoadContextMapPoint(event.clientX, event.clientY);
  }
});

/**
 * A single click on the low-quality OSM context map loads a fresh high-detail
 * model at that point. Clicks on the already-loaded high-detail tile are left
 * to the normal tooltip/selection path.
 */
function maybeLoadContextMapPoint(clientX: number, clientY: number): void {
  const state = store.getState();
  if (state.phase !== 'ready' || !state.model || !state.city || state.detailPanelOpen) return;
  const frame = currentModelDetailFrame();
  if (!frame) return;
  const point = scene.getMapPoint(clientX, clientY);
  if (!point) return;
  if (
    Math.abs(point.x - frame.centerX) <= frame.modelRadiusM &&
    Math.abs(point.z - frame.centerZ) <= frame.modelRadiusM
  ) {
    return;
  }
  const geo = detailWindowToGeo(state.city, { centerX: point.x, centerZ: point.z });
  const name = `Near ${state.city.name}`;
  addNotice(`Loading a high-detail area near ${state.city.name}…`);
  void loadCity(
    { kind: 'point', lat: geo.lat, lon: geo.lon, name },
    name,
    { pushHistory: true }
  );
}

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
    if (state.hover) {
      clearStickyTimer();
      store.setState({ hover: null });
    }
    scene.setModel(state.model);
    scene.setTime(state.minute);
    scene.setDetailWindow(state.detailWindow);
  }
  if (state.detailWindow !== previous.detailWindow) {
    scene.setDetailWindow(state.detailWindow);
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

// Browser Back/Forward returns to a previous city/area or point deep link.
// The model is normally already in the cache, so this is a fast reload.
window.addEventListener('popstate', () => {
  const parsed = parseUrlState(window.location.search);
  if (!parsed.target) return;
  const targetKey = JSON.stringify(parsed.target);
  if (targetKey === JSON.stringify(activeTarget)) return;
  if (parsed.date) explicitDate = parsed.date;
  if (parsed.minute != null) explicitMinute = parsed.minute;
  userTouchedTime = parsed.minute != null;
  pendingHistoryMode = 'replace';
  void loadCity(parsed.target, seedLabelForTarget(parsed.target), { preserveTime: false });
});

// Debug handle for E2E and manual inspection.
declare global {
  interface Window {
    __sunlight?: {
      getState: () => AppState;
      getSceneDebug: () => ReturnType<SceneHandle['getDebug']>;
      renderNow: () => void;
      actions: AppActions;
      loadCity: (target: ModelTarget, label?: string | null, options?: LoadOptions) => Promise<void>;
      hitTest: (x: number, y: number) => ReturnType<SceneHandle['hitTest']>;
      getGroundPoint: (x: number, y: number) => ReturnType<SceneHandle['getGroundPoint']>;
      getMapPoint: (x: number, y: number) => ReturnType<SceneHandle['getMapPoint']>;
      api: typeof api;
      formatMinuteOfDay: typeof formatMinuteOfDay;
    };
  }
}
window.__sunlight = {
  getState: () => store.getState(),
  getSceneDebug: () => scene.getDebug(),
  renderNow: () => scene.renderNow(),
  actions,
  loadCity,
  hitTest: (x, y) => scene.hitTest(x, y),
  getGroundPoint: (x, y) => scene.getGroundPoint(x, y),
  getMapPoint: (x, y) => scene.getMapPoint(x, y),
  api,
  formatMinuteOfDay
};
