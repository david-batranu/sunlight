/**
 * Time-of-day backdrop palette. Pure maths so the mood logic and gradient
 * interpolation can be unit-tested; the shell applies the CSS custom properties.
 */

import type { CurrentLight } from '../app/contracts.ts';
import type { SkyDay } from '../../shared/types.ts';
import { moodLabel, type Mood } from './format.ts';

type RGB = [number, number, number];

interface Palette {
  top: string;
  mid: string;
  horizon: string;
  base: string;
  glow: string;
  glowAlpha: number;
  stars: number;
}

interface Anchor extends Palette {
  alt: number;
}

/**
 * Palette anchors from deep night to high day. The sun altitude (degrees)
 * selects and interpolates between neighbours.
 */
const ANCHORS: readonly Anchor[] = [
  { alt: -90, top: '#050b15', mid: '#0b1626', horizon: '#1a2a42', base: '#050b15', glow: '#8aa7c8', glowAlpha: 0.1, stars: 1 },
  { alt: -18, top: '#071120', mid: '#101d31', horizon: '#22344e', base: '#071120', glow: '#9ab4d4', glowAlpha: 0.12, stars: 1 },
  { alt: -12, top: '#0d1a2e', mid: '#1b2c48', horizon: '#3a4a68', base: '#0d1a2e', glow: '#b7a2c8', glowAlpha: 0.16, stars: 0.95 },
  { alt: -6, top: '#1b2c4a', mid: '#3a466b', horizon: '#7a5f6c', base: '#1b2c4a', glow: '#e79a6a', glowAlpha: 0.26, stars: 0.55 },
  { alt: -2.5, top: '#28405f', mid: '#6b5c78', horizon: '#c98263', base: '#28405f', glow: '#ff9e63', glowAlpha: 0.4, stars: 0.18 },
  { alt: 0.8, top: '#3e5f83', mid: '#a97f76', horizon: '#f2a862', base: '#3e5f83', glow: '#ffb35e', glowAlpha: 0.5, stars: 0.05 },
  { alt: 4, top: '#5c86ad', mid: '#d6a878', horizon: '#ffcf8a', base: '#5c86ad', glow: '#ffc46a', glowAlpha: 0.45, stars: 0.01 },
  { alt: 10, top: '#7fa9cd', mid: '#c3d5e2', horizon: '#f0e2c9', base: '#7fa9cd', glow: '#fff0c6', glowAlpha: 0.3, stars: 0 },
  { alt: 25, top: '#6f9ec8', mid: '#b6cfe0', horizon: '#efe6d4', base: '#6f9ec8', glow: '#ffffff', glowAlpha: 0.22, stars: 0 },
  { alt: 60, top: '#6b9ac6', mid: '#b3ccdf', horizon: '#eee5d3', base: '#6b9ac6', glow: '#ffffff', glowAlpha: 0.18, stars: 0 }
];

export interface BackdropState {
  mood: Mood;
  label: string;
  vars: Record<string, string>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex: string): RGB {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ];
}

function mixRgb(from: RGB, to: RGB, t: number): RGB {
  const amount = clamp(t, 0, 1);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return [mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])];
}

function rgbCss(rgb: RGB): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function rgbTriplet(rgb: RGB): string {
  return `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
}

export interface ResolvedPalette {
  top: string;
  mid: string;
  horizon: string;
  base: string;
  glowRgb: string;
  glowAlpha: number;
  stars: number;
}

/** Interpolates the backdrop palette for a sun altitude in degrees. */
export function paletteForAltitude(altitudeDeg: number): ResolvedPalette {
  const alt = Number.isFinite(altitudeDeg) ? altitudeDeg : 20;
  const first = ANCHORS[0];
  const last = ANCHORS[ANCHORS.length - 1];
  let lower = first;
  let upper = first;
  if (alt >= last.alt) {
    lower = last;
    upper = last;
  } else if (alt > first.alt) {
    for (let index = 1; index < ANCHORS.length; index += 1) {
      if (alt <= ANCHORS[index].alt) {
        lower = ANCHORS[index - 1];
        upper = ANCHORS[index];
        break;
      }
    }
  }
  const span = upper.alt - lower.alt;
  const t = span === 0 ? 0 : (alt - lower.alt) / span;
  const from = (key: 'top' | 'mid' | 'horizon' | 'base'): RGB => hexToRgb(lower[key]);
  const to = (key: 'top' | 'mid' | 'horizon' | 'base'): RGB => hexToRgb(upper[key]);
  return {
    top: rgbCss(mixRgb(from('top'), to('top'), t)),
    mid: rgbCss(mixRgb(from('mid'), to('mid'), t)),
    horizon: rgbCss(mixRgb(from('horizon'), to('horizon'), t)),
    base: rgbCss(mixRgb(from('base'), to('base'), t)),
    glowRgb: rgbTriplet(mixRgb(hexToRgb(lower.glow), hexToRgb(upper.glow), t)),
    glowAlpha: Math.round((lower.glowAlpha + (upper.glowAlpha - lower.glowAlpha) * clamp(t, 0, 1)) * 1000) / 1000,
    stars: Math.round((lower.stars + (upper.stars - lower.stars) * clamp(t, 0, 1)) * 100) / 100
  };
}

/**
 * Four-way mood used for `body[data-mood]` and the phase icon:
 * sunlight above +6°, golden hour down to -6°, twilight to -12°, then night.
 */
export function moodForAltitude(altitudeDeg: number): Mood {
  if (altitudeDeg >= 6) return 'day';
  if (altitudeDeg >= -6) return 'golden';
  if (altitudeDeg >= -12) return 'twilight';
  return 'night';
}

/**
 * Builds the CSS custom properties for the living backdrop. When the sun is
 * well below the horizon and the moon is up, the glow follows the moon so the
 * night sky reads as moonlit rather than warm.
 */
export function resolveBackdrop(
  light: CurrentLight | null,
  sky: SkyDay | null,
  minute: number
): BackdropState {
  void sky;
  void minute;
  if (!light) {
    const palette = paletteForAltitude(14);
    return {
      mood: 'day',
      label: moodLabel('day'),
      vars: backdropVars(palette, 50, 76)
    };
  }
  const moonLit = light.sunAlt < -6 && light.moonAlt > 0.5;
  const sourceAlt = moonLit ? light.moonAlt : light.sunAlt;
  const sourceAz = moonLit ? light.moonAz : light.sunAz;
  const palette = paletteForAltitude(light.sunAlt);
  const mood = moodForAltitude(light.sunAlt);
  const glowAlpha = moonLit
    ? Math.min(0.55, palette.glowAlpha * 0.75 + 0.08)
    : palette.glowAlpha;
  const azimuthRadians = (sourceAz * Math.PI) / 180;
  const glowX = 50 + 45 * Math.sin(azimuthRadians);
  const glowY = clamp(92 - sourceAlt * 0.85, 6, 94);
  return {
    mood,
    label: moodLabel(mood),
    vars: backdropVars({ ...palette, stars: palette.stars, glowAlpha }, glowX, glowY)
  };
}

function backdropVars(palette: ResolvedPalette, glowX: number, glowY: number): Record<string, string> {
  return {
    '--sky-top': palette.top,
    '--sky-mid': palette.mid,
    '--sky-horizon': palette.horizon,
    '--sky-base': palette.base,
    '--sky-glow-rgb': palette.glowRgb,
    '--sky-glow-alpha': palette.glowAlpha.toFixed(3),
    '--sky-horizon-alpha': (palette.glowAlpha * 0.7).toFixed(3),
    '--sky-glow-x': `${glowX.toFixed(1)}%`,
    '--sky-glow-y': `${glowY.toFixed(1)}%`,
    '--stars-alpha': palette.stars.toFixed(2)
  };
}
