/**
 * Pure color helpers for the diorama renderer.
 *
 * Design colors are authored as sRGB hex/floats (the palettes in `palette.ts`
 * and `geometry.ts`). Three.js renders in the linear-sRGB working space, so
 * vertex colors are converted once with {@link writeLinearColor} while the
 * merged buffers are built. Keeping this module free of Three.js and DOM
 * imports lets the unit tests exercise it directly under Node.
 */

/** An sRGB color with channels in the 0..1 range. */
export type RGB = readonly [number, number, number];

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Converts a single sRGB channel (0..1) to linear-sRGB. */
export function srgbToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Converts a single linear-sRGB channel (0..1) to sRGB. */
export function linearToSrgb(channel: number): number {
  const c = channel <= 0 ? 0 : channel >= 1 ? 1 : channel;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Converts a 0xRRGGBB hex number to sRGB floats. */
export function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** Converts sRGB floats to a 0xRRGGBB hex number. */
export function rgbToHex(rgb: RGB): number {
  const channel = (value: number): number => Math.round(clamp01(value) * 255) & 0xff;
  return (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2]);
}

/** Linear interpolation between two sRGB colors. */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Multiplies every channel by `factor`, clamped to 0..1. */
export function scaleRgb(rgb: RGB, factor: number): RGB {
  return [clamp01(rgb[0] * factor), clamp01(rgb[1] * factor), clamp01(rgb[2] * factor)];
}

/** Converts an sRGB color to linear-sRGB (new tuple, not for hot loops). */
export function rgbToLinear(rgb: RGB): RGB {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

/**
 * Writes one vertex color (linear-sRGB) into a packed Float32Array.
 * Used by the merged geometry builders; allocation free.
 */
export function writeLinearColor(target: Float32Array, offset: number, rgb: RGB): void {
  target[offset] = srgbToLinear(rgb[0]);
  target[offset + 1] = srgbToLinear(rgb[1]);
  target[offset + 2] = srgbToLinear(rgb[2]);
}

/** Adds `lift` to each sRGB channel (used for lit tops). */
export function lightenRgb(rgb: RGB, lift: number): RGB {
  return [clamp01(rgb[0] + lift), clamp01(rgb[1] + lift), clamp01(rgb[2] + lift)];
}
