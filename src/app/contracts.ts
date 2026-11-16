/**
 * UI-facing client contracts. The lead owns this file.
 */

import type {
  ApiError,
  CityInfo,
  CityModel,
  CitySearchResponse,
  CitySearchResult,
  JobProgress,
  ModelTarget,
  NearestCityResponse,
  SkyDay
} from '../../shared/types.ts';
import type { AppState, AppStore } from './state.ts';

export type LoadPhase = 'boot' | 'resolving' | 'generating' | 'loading' | 'ready' | 'error';

export interface AppError extends ApiError {
  targetName?: string;
}

export interface CurrentLight {
  sunAlt: number;
  sunAz: number;
  moonAlt: number;
  moonAz: number;
}

export interface AppActions {
  selectCity(target: ModelTarget): void;
  selectSearchResult(result: CitySearchResult): void;
  locate(): Promise<void>;
  setDate(date: string): void;
  setMinute(minute: number): void;
  stepMinutes(delta: number): void;
  togglePlay(): void;
  setSpeed(minutesPerSecond: number): void;
  toggleLoop(): void;
  stepDay(delta: number): void;
  goToday(): void;
  setNow(): void;
  resetCamera(): void;
  retry(): void;
  cancelGeneration(): void;
  copyLink(): Promise<boolean>;
  dismissNotices(): void;
}

export interface SceneDebug {
  camera: {
    azimuthDeg: number;
    pitchDeg: number;
    zoom: number;
    target: [number, number, number];
  };
  light: {
    kind: 'sun' | 'moon' | 'none';
    direction: [number, number, number];
    altitudeDeg: number;
    azimuthDeg: number;
    intensity: number;
    shadow: boolean;
  };
  render: { drawCalls: number; triangles: number; fps: number };
  modelKey: string | null;
}

export interface SceneHandle {
  setModel(model: CityModel): void;
  setSky(sky: SkyDay | null): void;
  setTime(minute: number): void;
  setQuality(quality: 'high' | 'low'): void;
  resetCamera(): void;
  resize(): void;
  dispose(): void;
  getDebug(): SceneDebug;
}

export interface UIContext {
  store: AppStore;
  actions: AppActions;
  searchCities(query: string, limit?: number): Promise<CitySearchResponse>;
  nearestCity(lat: number, lon: number): Promise<NearestCityResponse>;
}

export interface UIHandle {
  update(state: AppState): void;
  destroy(): void;
}

export type { ApiError, CityInfo, CityModel, CitySearchResult, JobProgress, ModelTarget, SkyDay };
