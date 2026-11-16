/**
 * Orientation compass overlay.
 *
 * The rose is rotated with `((180 - cameraAzimuthDeg) % 360 + 360) % 360` so the
 * N label points toward world north on screen. The camera azimuth is the
 * direction from the look target toward the camera, hence the 180° offset.
 *
 * The pure helpers at the top are DOM-free and unit-tested.
 */

import type { AppState } from '../app/state.ts';
import type { UIContext } from '../app/contracts.ts';
import { formatCompass } from './format.ts';
import { createPatcher, el, on, q } from './dom.ts';

/** Wraps any angle into [0, 360). */
export function normalizeAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/** Rose rotation in degrees for a camera azimuth; N points toward world north. */
export function compassRotation(cameraAzimuthDeg: number): number {
  return normalizeAngle(180 - cameraAzimuthDeg);
}

/** 16-wind direction the viewer is looking from, e.g. "NE". */
export function compassDirection(cameraAzimuthDeg: number): string {
  return formatCompass(cameraAzimuthDeg);
}

/** Caption for the compass, e.g. "View from NE". */
export function viewFromLabel(cameraAzimuthDeg: number): string {
  return `View from ${formatCompass(cameraAzimuthDeg)}`;
}

/** Screen position of a cardinal label on the rose for a given rotation. */
export function cardinalLabelPosition(
  cardinalIndex: number,
  rotationDeg: number,
  center = 48,
  radius = 26
): { x: number; y: number } {
  const angle = rotationDeg + cardinalIndex * 90;
  const radians = (angle * Math.PI) / 180;
  return {
    x: Math.round((center + radius * Math.sin(radians)) * 100) / 100,
    y: Math.round((center - radius * Math.cos(radians)) * 100) / 100
  };
}

export interface CompassHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

const CARDINALS = ['N', 'E', 'S', 'W'] as const;

function tickMarkup(): string {
  const lines: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    const angle = index * 15;
    const major = angle % 90 === 0;
    const inner = major ? 32 : 36;
    const radians = (angle * Math.PI) / 180;
    const x1 = (48 + inner * Math.sin(radians)).toFixed(2);
    const y1 = (48 - inner * Math.cos(radians)).toFixed(2);
    const x2 = (48 + 43 * Math.sin(radians)).toFixed(2);
    const y2 = (48 - 43 * Math.cos(radians)).toFixed(2);
    lines.push(
      `<line class="sl-compass-tick${major ? ' sl-compass-tick--major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
    );
  }
  return lines.join('');
}

function labelMarkup(): string {
  return CARDINALS.map((label, index) => {
    const position = cardinalLabelPosition(index, 0);
    return `<text class="sl-compass-label" data-cardinal="${label}" x="${position.x}" y="${position.y}">${label}</text>`;
  }).join('');
}

export function createCompass(ctx: UIContext): CompassHandle {
  const patcher = createPatcher();
  const element = el(
    'button',
    'sl-compass',
    `
    <span class="sl-compass-rose" aria-hidden="true">
      <svg viewBox="0 0 96 96" focusable="false">
        <circle class="sl-compass-ring" cx="48" cy="48" r="44"/>
        <circle class="sl-compass-face" cx="48" cy="48" r="34"/>
        <g class="sl-compass-rotor">
          ${tickMarkup()}
          <path class="sl-compass-needle-north" d="M48 19 L52.6 48 L43.4 48 Z"/>
          <path class="sl-compass-needle-south" d="M48 77 L52.6 48 L43.4 48 Z"/>
        </g>
        <circle class="sl-compass-face" cx="48" cy="48" r="26"/>
        ${labelMarkup()}
        <circle class="sl-compass-hub" cx="48" cy="48" r="2.4"/>
      </svg>
    </span>
    <span class="sl-compass-caption">${viewFromLabel(180)}</span>
  `
  );
  element.dataset.testid = 'compass';
  element.setAttribute('type', 'button');
  element.setAttribute('aria-label', 'Compass. Reset view to isometric');
  element.setAttribute('title', 'Compass — reset the view (R)');

  const rotor = q<SVGGElement>(element, '.sl-compass-rotor');
  const caption = q<HTMLElement>(element, '.sl-compass-caption');
  const viewDirection = document.createElement('b');
  viewDirection.dataset.testid = 'compass-view';
  viewDirection.textContent = compassDirection(180);
  caption.replaceChildren(document.createTextNode('View from '), viewDirection);
  const labels = Array.from(element.querySelectorAll<SVGTextElement>('.sl-compass-label'));

  const disposeClick = on(element, 'click', () => ctx.actions.resetCamera());

  let lastRotation = Number.NaN;
  let lastDirection = '';

  function applyAzimuth(azimuth: number): void {
    const rotation = compassRotation(azimuth);
    if (rotation !== lastRotation) {
      lastRotation = rotation;
      patcher.attr(rotor, 'transform', `rotate(${rotation.toFixed(2)} 48 48)`);
      labels.forEach((label, index) => {
        const position = cardinalLabelPosition(index, rotation);
        patcher.attr(label, 'x', position.x);
        patcher.attr(label, 'y', position.y);
      });
    }
    const direction = compassDirection(azimuth);
    if (direction !== lastDirection) {
      lastDirection = direction;
      patcher.text(viewDirection, direction);
      patcher.attr(element, 'title', `Compass — ${viewFromLabel(azimuth)}. Reset view (R)`);
      patcher.attr(element, 'aria-description', viewFromLabel(azimuth));
    }
  }

  function update(state: AppState): void {
    applyAzimuth(state.cameraAzimuthDeg);
  }

  applyAzimuth(180);

  return {
    element,
    update,
    destroy(): void {
      disposeClick();
    }
  };
}
