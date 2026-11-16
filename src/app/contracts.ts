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
  beginAreaPick(): void;
  cancelAreaPick(): void;
  dismissHover(): void;
  retry(): void;
  cancelGeneration(): void;
  copyLink(): Promise<boolean>;
  dismissNotices(): void;
}

export interface HitFeature {
  kind: 'building' | 'road' | 'area';
  /** Display name from OSM, when the feature is named. */
  name: string;
  /** Short human label, e.g. "Church", "Primary street", "Park". */
  kindLabel: string;
  /** Building height in metres, when the hit feature is a building. */
  heightM?: number;
}

export interface HoverInfo {
  feature: HitFeature;
  /** Viewport-space pointer position in CSS pixels. */
  x: number;
  y: number;
  /** True for a tapped/clicked feature; false while hovering. */
  sticky: boolean;
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
  /** Raycasts the city meshes and returns the named feature under the pointer. */
  hitTest(clientX: number, clientY: number): HitFeature | null;
  /** Camera azimuth in degrees (direction from the look target toward the camera). */
  getCameraAzimuth(): number;
  /** Ground-plane point (metres, model space) under a viewport pixel. */
  getGroundPoint(clientX: number, clientY: number): { x: number; z: number } | null;
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
