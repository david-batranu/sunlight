/**
 * Tiny observable application store. The lead owns this file.
 */

import type { AppError, CurrentLight, HoverInfo, LoadPhase } from './contracts.ts';
import type { CityInfo, CityModel, JobProgress, SkyDay } from '../../shared/types.ts';
import { DEFAULT_CITY_GEONAME_ID, SEED_BY_GEONAME_ID } from '../../shared/constants.ts';

export interface AppState {
  phase: LoadPhase;
  /** Active city (resolved from the model or the target while loading). */
  city: CityInfo | null;
  model: CityModel | null;
  sky: SkyDay | null;
  /** City-local calendar date, YYYY-MM-DD. */
  date: string;
  /** City-local wall-clock minute, 0..1439.999. */
  minute: number;
  playing: boolean;
  /** Simulated minutes per real second. */
  speed: number;
  loopDay: boolean;
  progress: JobProgress | null;
  /** Human label while resolving/generating. */
  generatingName: string | null;
  error: AppError | null;
  current: CurrentLight | null;
  /** Camera azimuth in degrees, used by the orientation compass. */
  cameraAzimuthDeg: number;
  /** Feature under the pointer / tapped feature, or null. */
  hover: HoverInfo | null;
  /** True while the user is choosing a new model centre on the diorama. */
  pickingArea: boolean;
  notices: string[];
  viewerTz: string;
}

export type StoreListener = (state: AppState, previous: AppState) => void;

export interface AppStore {
  getState(): AppState;
  setState(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void;
  subscribe(listener: StoreListener): () => void;
}

export function createStore(initial: AppState): AppStore {
  let state = initial;
  const listeners = new Set<StoreListener>();

  return {
    getState() {
      return state;
    },
    setState(patch) {
      const previous = state;
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (Object.keys(next).length === 0) return;
      state = { ...state, ...next };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function todayLocalInViewer(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function minuteOfDayLocal(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

export function createInitialState(): AppState {
  const defaultSeed = SEED_BY_GEONAME_ID.get(DEFAULT_CITY_GEONAME_ID);
  return {
    phase: 'boot',
    city: defaultSeed
      ? {
          geonameId: defaultSeed.geonameId,
          name: defaultSeed.name,
          country: 'RO',
          lat: defaultSeed.lat,
          lon: defaultSeed.lon,
          tz: defaultSeed.tz
        }
      : null,
    model: null,
    sky: null,
    date: todayLocalInViewer(),
    minute: minuteOfDayLocal(),
    playing: false,
    speed: 5,
    loopDay: false,
    progress: null,
    generatingName: null,
    error: null,
    current: null,
    cameraAzimuthDeg: 45,
    hover: null,
    pickingArea: false,
    notices: [],
    viewerTz: viewerTimezone()
  };
}
