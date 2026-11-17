/**
 * Inline SVG icon set. Everything is drawn locally — no external assets or
 * icon fonts — and inherits `currentColor`.
 */

import { moonPhaseGeometry } from './format.ts';

const PATHS = {
  sun:
    '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/>',
  moon: '<path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z"/>',
  sunset:
    '<path d="M3 18h18"/><path d="M6.4 18a5.6 5.6 0 0 1 11.2 0"/><path d="M12 3.4v6"/><path d="m8.8 6.6 3.2-3.2 3.2 3.2"/><path d="M2.4 21h19.2"/>',
  twilight:
    '<path d="M3 17h18"/><path d="M7.2 17a4.8 4.8 0 0 1 9.6 0"/><path d="M12 5.4v3.2"/><path d="M5.6 8.6l2.2 2.2M18.4 8.6l-2.2 2.2"/><path d="M2.4 20.4h19.2"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m16 16 4.4 4.4"/>',
  locate:
    '<circle cx="12" cy="12" r="6.4"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2.4v3.2M12 18.4v3.2M2.4 12h3.2M18.4 12h3.2"/>',
  compass: '<circle cx="12" cy="12" r="8.6"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z"/>',
  reset: '<path d="M4.4 10.2a8 8 0 1 1 .9 6.4"/><path d="M4.4 4.6v5.6H10"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5.4"/><circle cx="12" cy="7.9" r=".9" fill="currentColor" stroke="none"/>',
  map: '<path d="m3.6 6.4 5.2-2 6.4 2 5.2-2v13.2l-5.2 2-6.4-2-5.2 2V6.4Z"/><path d="M8.8 4.4v13.2M15.2 6.4v13.2"/>',
  link: '<path d="M10.2 13.8a3.4 3.4 0 0 0 4.8 0l2.6-2.6a3.4 3.4 0 0 0-4.8-4.8l-1.3 1.3"/><path d="M13.8 10.2a3.4 3.4 0 0 0-4.8 0l-2.6 2.6a3.4 3.4 0 0 0 4.8 4.8l1.3-1.3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5.2v13.6L19 12 8 5.2Z"/>',
  pause: '<path d="M8 5.5h3.4v13H8zM12.6 5.5H16v13h-3.4z"/>',
  loop: '<path d="M4.2 11.4A7.8 7.8 0 0 1 18 6.6l2 2"/><path d="M19.8 12.6A7.8 7.8 0 0 1 6 17.4l-2-2"/><path d="M20 4.4v4.2h-4.2M4 19.6v-4.2h4.2"/>',
  sunrise: '<path d="M3 18h18"/><path d="M6.4 18a5.6 5.6 0 0 1 11.2 0"/><path d="M12 9.4V3.2"/><path d="m8.8 6.2 3.2 3.2 3.2-3.2"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2.2"/>',
  pin: '<path d="M12 21s6.4-5.4 6.4-10.2a6.4 6.4 0 1 0-12.8 0C5.6 15.6 12 21 12 21Z"/><circle cx="12" cy="10.6" r="2.2"/>',
  globe:
    '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8M12 3.4c2.4 2.5 3.6 5.4 3.6 8.6S14.4 18.1 12 20.6c-2.4-2.5-3.6-5.4-3.6-8.6S9.6 5.9 12 3.4Z"/>',
  warning: '<path d="M12 3.6 21 19.4H3l9-15.8Z"/><path d="M12 9.4v4.4"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/>',
  seed: '<path d="M12 20.4c0-4.8 3.4-8.4 8-8.4 0 4.8-3.4 8.4-8 8.4Z"/><path d="M12 20.4C12 15.6 8.6 12 4 12c0 4.8 3.4 8.4 8 8.4Z"/><path d="M12 20.4V9.4"/>',
  location: '<path d="M12 21s6.4-5.4 6.4-10.2a6.4 6.4 0 1 0-12.8 0C5.6 15.6 12 21 12 21Z"/>',
  areaPick:
    '<path d="M4.2 8V5.6a1.4 1.4 0 0 1 1.4-1.4H8M16 4.2h2.4a1.4 1.4 0 0 1 1.4 1.4V8M19.8 16v2.4a1.4 1.4 0 0 1-1.4 1.4H16M8 19.8H5.6a1.4 1.4 0 0 1-1.4-1.4V16"/><circle cx="12" cy="12" r="2.7"/><path d="M12 6.6v1.4M12 16v1.4M6.6 12H8M16 12h1.4"/>'
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'pause']);

/** Returns the markup for an inline icon. */
export function icon(name: IconName, className = ''): string {
  const filled = FILLED.has(name);
  const classes = `sl-ic${filled ? ' sl-ic--fill' : ''}${className ? ` ${className}` : ''}`;
  return `<svg class="${classes}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">${PATHS[name]}</svg>`;
}

/** Renders a moon-phase glyph for the readouts. */
export function moonPhaseIcon(phaseAngleDeg: number, size = 22): string {
  const radius = size / 2 - 1.6;
  const center = size / 2;
  const geometry = moonPhaseGeometry(phaseAngleDeg, radius, center, center);
  const lit = geometry.path ? `<path d="${geometry.path}" fill="#f4e9cf"/>` : '';
  return (
    `<svg class="sl-moon-glyph" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<circle cx="${center}" cy="${center}" r="${radius}" fill="#3d4d68"/>` +
    lit +
    `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(247,241,229,.55)" stroke-width="0.8"/>` +
    '</svg>'
  );
}
