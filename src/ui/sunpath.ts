/**
 * Sun-path compass geometry and time-slider band maths. Pure functions, no DOM.
 *
 * The compass is a zenith (polar) projection: the zenith sits at the centre,
 * the horizon is a ring, and altitudes below the horizon are pushed into an
 * outer ring so the "night half" of the sun's circuit stays visible.
 */

import type { SkyDay, SkyTrack } from '../../shared/types.ts';
import { instantToLocalMinute } from './format.ts';

export interface PathConfig {
  /** SVG viewBox size (square). */
  size: number;
  /** Radius of the horizon ring. */
  horizonR: number;
  /** Outer radius used for altitudes at or below -18°. */
  maxR: number;
}

export const SUN_PATH_CONFIG: PathConfig = { size: 240, horizonR: 84, maxR: 112 };

export interface ProjectedPoint {
  x: number;
  y: number;
}

const MIN_VISIBLE_ALT = -18;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Projects altitude/azimuth (degrees) onto the square compass viewBox. */
export function projectSkyPoint(
  altitudeDeg: number,
  azimuthDeg: number,
  config: PathConfig = SUN_PATH_CONFIG
): ProjectedPoint {
  const alt = clamp(Number.isFinite(altitudeDeg) ? altitudeDeg : 0, MIN_VISIBLE_ALT, 90);
  const az = Number.isFinite(azimuthDeg) ? azimuthDeg : 0;
  const center = config.size / 2;
  const radius =
    alt >= 0
      ? config.horizonR * (1 - alt / 90)
      : config.horizonR + (Math.min(-alt, 18) / 18) * (config.maxR - config.horizonR);
  const radians = (az * Math.PI) / 180;
  return {
    x: round2(center + radius * Math.sin(radians)),
    y: round2(center - radius * Math.cos(radians))
  };
}

function pathFrom(points: ProjectedPoint[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  let path = `M ${first.x} ${first.y}`;
  for (const point of rest) path += ` L ${point.x} ${point.y}`;
  return path;
}

export interface TrackPaths {
  /** Continuous path of the sun while it is above the horizon. */
  above: string;
  /** Dashed path of the sun while it is below the horizon. */
  below: string;
  /** Faint path of the moon around the same day. */
  moon: string;
}

/** Builds the SVG paths for the sun and moon tracks. */
export function buildTrackPaths(
  track: SkyTrack | null | undefined,
  config: PathConfig = SUN_PATH_CONFIG
): TrackPaths {
  const aboveSegments: ProjectedPoint[][] = [];
  const belowSegments: ProjectedPoint[][] = [];
  const sun = track?.sun ?? [];
  let currentSegment: ProjectedPoint[] | null = null;
  let currentAbove: boolean | null = null;

  for (const [altitude, azimuth] of sun) {
    const isAbove = altitude >= 0;
    const point = projectSkyPoint(altitude, azimuth, config);
    if (isAbove !== currentAbove) {
      currentSegment = [point];
      currentAbove = isAbove;
      (isAbove ? aboveSegments : belowSegments).push(currentSegment);
    } else if (currentSegment) {
      currentSegment.push(point);
    }
  }

  const above = aboveSegments.map(pathFrom).filter(Boolean).join(' ');
  const below = belowSegments.map(pathFrom).filter(Boolean).join(' ');

  const moonPoints: ProjectedPoint[] = [];
  for (const [altitude, azimuth] of track?.moon ?? []) {
    moonPoints.push(projectSkyPoint(altitude, azimuth, config));
  }

  return { above, below, moon: pathFrom(moonPoints) };
}

export interface HorizonMarkers {
  /** Azimuth where the sun rises, if it does. */
  riseAz: number | null;
  /** Azimuth where the sun sets, if it does. */
  setAz: number | null;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Finds the horizon crossings (azimuth and interpolated minute) of the sun track. */
export function findHorizonCrossings(track: SkyTrack | null | undefined): {
  rise: { az: number; minute: number } | null;
  set: { az: number; minute: number } | null;
} {
  const sun = track?.sun ?? [];
  const step = track?.stepMinutes ?? 5;
  let rise: { az: number; minute: number } | null = null;
  let set: { az: number; minute: number } | null = null;
  for (let index = 1; index < sun.length; index += 1) {
    const previous = sun[index - 1];
    const current = sun[index];
    const previousAlt = previous[0];
    const currentAlt = current[0];
    if (previousAlt < 0 && currentAlt >= 0 && rise === null) {
      const t = currentAlt === previousAlt ? 0 : -previousAlt / (currentAlt - previousAlt);
      rise = {
        az: Math.round(lerp(previous[1], current[1], t) * 100) / 100,
        minute: Math.round((index - 1) * step + step * t)
      };
    }
    if (previousAlt >= 0 && currentAlt < 0 && set === null) {
      const t = previousAlt === currentAlt ? 0 : previousAlt / (previousAlt - currentAlt);
      set = {
        az: Math.round(lerp(previous[1], current[1], t) * 100) / 100,
        minute: Math.round((index - 1) * step + step * t)
      };
    }
  }
  return { rise, set };
}

/** Azimuth markers that sit on the horizon ring of the compass. */
export function horizonMarkers(
  track: SkyTrack | null | undefined,
  config: PathConfig = SUN_PATH_CONFIG
): { rise: ProjectedPoint | null; set: ProjectedPoint | null } {
  const crossings = findHorizonCrossings(track);
  return {
    rise: crossings.rise ? projectSkyPoint(0, crossings.rise.az, config) : null,
    set: crossings.set ? projectSkyPoint(0, crossings.set.az, config) : null
  };
}

/**
 * Sunrise/sunset as local minutes-of-day. Prefers the almanac instants, then
 * falls back to the sampled track, so the slider ticks work even for old dates.
 */
export function dayMarkers(sky: SkyDay | null | undefined): {
  rise: number | null;
  set: number | null;
} {
  if (!sky) return { rise: null, set: null };
  let rise = instantToLocalMinute(sky.sun.rise, sky.tz);
  let set = instantToLocalMinute(sky.sun.set, sky.tz);
  if (rise === null || set === null) {
    const crossings = findHorizonCrossings(sky.track);
    rise = rise ?? (crossings.rise ? clamp(crossings.rise.minute, 0, 1439) : null);
    set = set ?? (crossings.set ? clamp(crossings.set.minute, 0, 1439) : null);
  }
  return { rise, set };
}

export type SkyBand = 'night' | 'twilight' | 'golden' | 'day';

export const BAND_COLORS: Record<SkyBand, string> = {
  night: '#22365a',
  twilight: '#54688f',
  golden: '#d9903f',
  day: '#e7c983'
};

/** Classifies a sun altitude into one of the four slider bands. */
export function bandForAltitude(altitudeDeg: number): SkyBand {
  if (altitudeDeg >= 6) return 'day';
  if (altitudeDeg >= -0.833) return 'golden';
  if (altitudeDeg >= -12) return 'twilight';
  return 'night';
}

const FALLBACK_RUNS: Array<{ band: SkyBand; from: number; to: number }> = [
  { band: 'night', from: 0, to: 4.5 },
  { band: 'twilight', from: 4.5, to: 6 },
  { band: 'golden', from: 6, to: 7.5 },
  { band: 'day', from: 7.5, to: 17 },
  { band: 'golden', from: 17, to: 18.5 },
  { band: 'twilight', from: 18.5, to: 20 },
  { band: 'night', from: 20, to: 24 }
];

function runsToGradient(runs: Array<{ band: SkyBand; start: number; end: number }>): string {
  const stops: string[] = [];
  for (const run of runs) {
    if (run.end <= run.start) continue;
    const startPercent = (run.start / 1440) * 100;
    const endPercent = (run.end / 1440) * 100;
    stops.push(`${BAND_COLORS[run.band]} ${startPercent.toFixed(2)}%`, `${BAND_COLORS[run.band]} ${endPercent.toFixed(2)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * A hard-stop gradient for the time slider track, derived from the sun track so
 * the coloured bands match the actual day (polar days, winter, DST and all).
 */
export function bandGradient(sky: SkyDay | null | undefined): string {
  const sun = sky?.track?.sun;
  const step = sky?.track?.stepMinutes ?? 5;
  if (!sun || sun.length < 2) {
    return runsToGradient(FALLBACK_RUNS.map((run) => ({ band: run.band, start: run.from * 60, end: run.to * 60 })));
  }
  const runs: Array<{ band: SkyBand; start: number; end: number }> = [];
  for (let index = 0; index < sun.length; index += 1) {
    const minute = Math.min(index * step, 1440);
    const band = bandForAltitude(sun[index][0]);
    const last = runs[runs.length - 1];
    if (last && last.band === band) {
      last.end = Math.max(last.end, minute);
    } else {
      runs.push({ band, start: minute, end: minute });
    }
  }
  if (runs.length > 0) runs[runs.length - 1].end = 1440;
  return runsToGradient(runs);
}
