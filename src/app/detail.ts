/**
 * Pure helpers for the high-detail window inside the loaded city model.
 * Shared by the main-thread actions, minimap UI and unit tests.
 */

import { DETAIL_DEFAULT_RADIUS_M, DETAIL_MAX_RADIUS_M, DETAIL_MIN_RADIUS_M } from '../../shared/constants.ts';
import type { DetailWindow } from './contracts.ts';

export interface DetailFrame {
  centerX: number;
  centerZ: number;
  /** Half-size of the loaded model square, in metres. */
  radiusM: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamps a detail window to the loaded model frame and the allowed size range. */
export function clampDetailWindow(frame: DetailFrame, input: Partial<DetailWindow> | null | undefined): DetailWindow {
  const maxRadius = Math.max(DETAIL_MIN_RADIUS_M, Math.min(DETAIL_MAX_RADIUS_M, frame.radiusM));
  const radiusM = Math.max(
    DETAIL_MIN_RADIUS_M,
    Math.min(maxRadius, finite(input?.radiusM, DETAIL_DEFAULT_RADIUS_M))
  );
  const offset = Math.max(0, frame.radiusM - radiusM);
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
