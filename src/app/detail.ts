/**
 * Pure helpers for the choose-area / high-detail window inside the loaded
 * city model. Shared by the main-thread actions, minimap UI and unit tests.
 */

import {
  DETAIL_CONTEXT_RADIUS_M,
  DETAIL_DEFAULT_RADIUS_M,
  DETAIL_MAX_RADIUS_M,
  DETAIL_MIN_RADIUS_M
} from '../../shared/constants.ts';
import type { DetailWindow } from './contracts.ts';

const METRES_PER_DEGREE = 111_320;

export interface DetailFrame {
  /** Centre of the loaded model / overview, in model metres. */
  centerX: number;
  centerZ: number;
  /** Half-size of the loaded high-detail model, in metres. */
  modelRadiusM: number;
  /** Half-size of the choose-area overview footprint, in metres. */
  contextRadiusM: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamps a detail window to the 5 km overview and the allowed size range. */
export function clampDetailWindow(frame: DetailFrame, input: Partial<DetailWindow> | null | undefined): DetailWindow {
  const maxRadius = Math.max(
    DETAIL_MIN_RADIUS_M,
    Math.min(DETAIL_MAX_RADIUS_M, frame.modelRadiusM, DETAIL_CONTEXT_RADIUS_M)
  );
  const radiusM = Math.max(
    DETAIL_MIN_RADIUS_M,
    Math.min(maxRadius, finite(input?.radiusM, DETAIL_DEFAULT_RADIUS_M))
  );
  const offset = Math.max(0, frame.contextRadiusM - radiusM);
  const centerX = Math.max(
    frame.centerX - offset,
    Math.min(frame.centerX + offset, finite(input?.centerX, frame.centerX))
  );
  const centerZ = Math.max(
    frame.centerZ - offset,
    Math.min(frame.centerZ + offset, finite(input?.centerZ, frame.centerZ))
  );
  return { centerX, centerZ, radiusM };
}

/** Converts a model-space detail-window centre to WGS84 for the point API. */
export function detailWindowToGeo(
  city: { lat: number; lon: number },
  window: Pick<DetailWindow, 'centerX' | 'centerZ'>
): { lat: number; lon: number } {
  return {
    lat: city.lat - window.centerZ / METRES_PER_DEGREE,
    lon:
      city.lon +
      window.centerX / (METRES_PER_DEGREE * Math.cos((city.lat * Math.PI) / 180))
  };
}

/** True when the whole detail square lies inside the loaded high-detail model. */
export function detailWindowInsideModel(
  window: DetailWindow,
  frame: Pick<DetailFrame, 'centerX' | 'centerZ' | 'modelRadiusM'>
): boolean {
  return (
    window.centerX - window.radiusM >= frame.centerX - frame.modelRadiusM &&
    window.centerX + window.radiusM <= frame.centerX + frame.modelRadiusM &&
    window.centerZ - window.radiusM >= frame.centerZ - frame.modelRadiusM &&
    window.centerZ + window.radiusM <= frame.centerZ + frame.modelRadiusM
  );
}

/** User-facing label, e.g. "750 m radius". */
export function detailRadiusLabel(radiusM: number): string {
  const value = Math.round(finite(radiusM, DETAIL_DEFAULT_RADIUS_M));
  return `${value} m radius`;
}

/** User-facing footprint label, e.g. "1.5 × 1.5 km". */
export function detailFootprintLabel(radiusM: number): string {
  const side = Math.max(0, finite(radiusM, 0)) * 2;
  if (side >= 1000) {
    const km = side / 1000;
    return `${km.toFixed(km >= 10 ? 0 : 1).replace(/\.0$/, '')} × ${km.toFixed(km >= 10 ? 0 : 1).replace(/\.0$/, '')} km`;
  }
  return `${Math.round(side)} × ${Math.round(side)} m`;
}

export { DETAIL_CONTEXT_RADIUS_M };
