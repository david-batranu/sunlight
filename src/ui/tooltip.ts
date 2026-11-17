/**
 * Floating feature tooltip (placard) for `state.hover`.
 *
 * Pure placement/content helpers live at the top (DOM-free, unit-tested); the
 * handle renders from state and calls `actions.dismissHover()` for sticky pins.
 */

import type { AppState } from '../app/state.ts';
import type { HitFeature, HoverInfo, UIContext } from '../app/contracts.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

export const TOOLTIP_MARGIN = 8;
export const TOOLTIP_OFFSET = 14;

export interface TooltipPlacement {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Places a fixed-size tooltip near the pointer: centered above it when there is
 * room, flipped below near the top edge, and clamped into the viewport.
 */
export function placeTooltip(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = TOOLTIP_MARGIN,
  offset = TOOLTIP_OFFSET
): TooltipPlacement {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const h = Number.isFinite(height) ? Math.max(0, height) : 0;
  const vw = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const vh = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;

  let placement: 'above' | 'below' = 'above';
  let top = anchorY - offset - h;
  if (top < margin) {
    placement = 'below';
    top = anchorY + offset;
  }
  const maxTop = vh - margin - h;
  top = clamp(top, margin, Math.max(margin, maxTop));

  const maxLeft = vw - margin - w;
  const left = w + margin * 2 > vw ? margin : clamp(anchorX - w / 2, margin, Math.max(margin, maxLeft));

  return {
    left: Math.floor(left),
    top: Math.floor(top),
    placement
  };
}

const FALLBACK_NAMES: Record<HitFeature['kind'], string> = {
  building: 'Unnamed building',
  road: 'Unnamed road',
  area: 'Unnamed area'
};

const FALLBACK_KINDS: Record<HitFeature['kind'], string> = {
  building: 'Building',
  road: 'Road',
  area: 'Area'
};

/** Formats a building height in metres, e.g. "42 m tall". */
export function formatHeightMeters(heightM: number | null | undefined): string | null {
  if (heightM === null || heightM === undefined || !Number.isFinite(heightM)) return null;
  const metres = Math.max(1, Math.round(heightM));
  return `${metres} m tall`;
}

export interface TooltipContent {
  title: string;
  kind: string;
  meta: string | null;
}

/** Display strings for a hit feature: name, kind label and height (buildings). */
export function tooltipContent(feature: HitFeature): TooltipContent {
  const name = typeof feature.name === 'string' ? feature.name.trim() : '';
  const kindLabel = typeof feature.kindLabel === 'string' ? feature.kindLabel.trim() : '';
  return {
    title: name || FALLBACK_NAMES[feature.kind],
    kind: kindLabel || FALLBACK_KINDS[feature.kind],
    meta: feature.kind === 'building' ? formatHeightMeters(feature.heightM) : null
  };
}

/** Stable cache key so the placard only rebuilds its markup when content changes. */
export function hoverKey(hover: HoverInfo | null): string {
  if (!hover) return '';
  const content = tooltipContent(hover.feature);
  return `${hover.sticky ? 'sticky' : 'hover'}|${content.kind}|${content.title}|${content.meta ?? ''}`;
}

export interface FeatureTooltipHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export function createFeatureTooltip(ctx: UIContext): FeatureTooltipHandle {
  const patcher = createPatcher();
  const element = el(
    'div',
    'sl-feature-tooltip',
    `
    <div class="sl-tooltip-body">
      <span class="sl-tooltip-kind" data-testid="tooltip-kind"></span>
      <strong class="sl-tooltip-name" data-testid="tooltip-name"></strong>
      <span class="sl-tooltip-meta" data-testid="tooltip-meta"></span>
    </div>
    <button class="sl-tooltip-close" type="button" data-testid="tooltip-close" aria-label="Dismiss feature details" hidden>
      ${icon('close')}
    </button>
  `
  );
  element.dataset.testid = 'feature-tooltip';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  const kindElement = q<HTMLElement>(element, '[data-testid="tooltip-kind"]');
  const nameElement = q<HTMLElement>(element, '[data-testid="tooltip-name"]');
  const metaElement = q<HTMLElement>(element, '[data-testid="tooltip-meta"]');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="tooltip-close"]');

  const cleanup = [on(closeButton, 'click', () => ctx.actions.dismissHover())];

  let lastKey = '';
  let measuredWidth = 0;
  let measuredHeight = 0;

  function measure(): void {
    measuredWidth = element.offsetWidth;
    measuredHeight = element.offsetHeight;
  }

  function update(state: AppState): void {
    const hover = state.hover;
    if (!hover) {
      patcher.hidden(element, true);
      lastKey = '';
      return;
    }

    const content = tooltipContent(hover.feature);
    const key = hoverKey(hover);
    const wasHidden = element.hidden;
    if (key !== lastKey || wasHidden) {
      lastKey = key;
      patcher.text(kindElement, content.kind);
      patcher.text(nameElement, content.title);
      patcher.text(metaElement, content.meta ?? '');
      patcher.hidden(metaElement, content.meta === null);
      patcher.cls(element, 'is-sticky', hover.sticky);
      patcher.hidden(closeButton, !hover.sticky);
      patcher.hidden(element, false);
      measure();
    }

    const placement = placeTooltip(
      hover.x,
      hover.y,
      measuredWidth,
      measuredHeight,
      window.innerWidth,
      window.innerHeight
    );
    patcher.style(element, 'left', `${placement.left}px`);
    patcher.style(element, 'top', `${placement.top}px`);
    patcher.attr(element, 'data-placement', placement.placement);
  }

  return {
    element,
    update,
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
