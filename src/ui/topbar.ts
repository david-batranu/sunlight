/**
 * Top bar: wordmark, city chip, search / locate / reset-view / copy / about.
 */

import type { AppState } from '../app/state.ts';
import type { UIContext } from '../app/contracts.ts';
import { countryName, formatCount, sourceLabel } from './format.ts';
import { createPatcher, el, focusEl, on, q } from './dom.ts';
import { icon } from './icons.ts';

export interface TopBarCallbacks {
  onOpenSearch(): void;
  onOpenAbout(): void;
}

export interface TopBarHandle {
  element: HTMLElement;
  update(state: AppState): void;
  setSearchOpen(open: boolean): void;
  /** Returns focus to the Area toggle after its panel closes. */
  focusAreaButton(): void;
  destroy(): void;
}

export function createTopBar(ctx: UIContext, callbacks: TopBarCallbacks): TopBarHandle {
  const patcher = createPatcher();
  const element = el(
    'header',
    'sl-topbar',
    `
    <div class="sl-brand">
      <span class="sl-brand-mark" aria-hidden="true">${icon('sun')}</span>
      <span class="sl-brand-text">
        <h1 class="sl-brand-name">Sunlight</h1>
        <span class="sl-brand-tag">cities in light</span>
      </span>
    </div>
    <button class="sl-city-chip" type="button" data-testid="city-chip" aria-haspopup="dialog" aria-expanded="false" title="Choose a city">
      <span class="sl-city-chip-pin" aria-hidden="true">${icon('pin')}</span>
      <span class="sl-city-chip-text">
        <span class="sl-city-chip-name" data-testid="city-name">Choose a city</span>
        <span class="sl-city-chip-meta" data-testid="city-meta">Search the atlas</span>
      </span>
      <span class="sl-city-chip-chevron" aria-hidden="true">${icon('chevron')}</span>
    </button>
    <div class="sl-topbar-actions">
      <button class="sl-btn sl-btn--icon" type="button" data-testid="open-search" aria-haspopup="dialog" aria-keyshortcuts="/" aria-label="Search cities" title="Search cities (/)">
        ${icon('search')}<span class="sl-btn-label">Search</span><kbd class="sl-kbd">/</kbd>
      </button>
      <button class="sl-btn sl-btn--icon" type="button" data-testid="locate" aria-keyshortcuts="L" aria-label="Use my location" title="Use my location (L)">
        ${icon('locate')}<span class="sl-btn-label">Locate</span>
      </button>
      <button class="sl-btn sl-btn--icon sl-btn--area" type="button" data-testid="area-pick" aria-pressed="false" aria-label="Choose area on the map" title="Choose a new area for the model">
        ${icon('areaPick')}<span class="sl-btn-label">Area</span>
      </button>
      <button class="sl-btn sl-btn--icon" type="button" data-testid="reset-camera" aria-keyshortcuts="R" aria-label="Reset the camera" title="Reset the camera (R)">
        ${icon('reset')}<span class="sl-btn-label">Reset view</span>
      </button>
      <button class="sl-btn sl-btn--icon sl-btn--secondary" type="button" data-testid="copy-link" aria-label="Copy a link to this moment" title="Copy a link to this moment">
        ${icon('link')}<span class="sl-btn-label">Copy link</span>
      </button>
      <button class="sl-btn sl-btn--icon" type="button" data-testid="about-open" aria-haspopup="dialog" aria-keyshortcuts="?" aria-label="About Sunlight" title="About Sunlight (?)">
        ${icon('info')}<span class="sl-btn-label">About</span>
      </button>
    </div>
  `
  );

  const cityChip = q<HTMLButtonElement>(element, '[data-testid="city-chip"]');
  const cityName = q<HTMLElement>(element, '[data-testid="city-name"]');
  const cityMeta = q<HTMLElement>(element, '[data-testid="city-meta"]');
  const openSearch = q<HTMLElement>(element, '[data-testid="open-search"]');
  const areaPickButton = q<HTMLButtonElement>(element, '[data-testid="area-pick"]');

  const cleanup = [
    on(cityChip, 'click', () => callbacks.onOpenSearch()),
    on(openSearch, 'click', () => callbacks.onOpenSearch()),
    on(q(element, '[data-testid="locate"]'), 'click', () => void ctx.actions.locate()),
    on(areaPickButton, 'click', () => ctx.actions.toggleDetailPanel()),
    on(q(element, '[data-testid="reset-camera"]'), 'click', () => ctx.actions.resetCamera()),
    on(q(element, '[data-testid="copy-link"]'), 'click', () => void ctx.actions.copyLink()),
    on(q(element, '[data-testid="about-open"]'), 'click', () => callbacks.onOpenAbout())
  ];

  function update(state: AppState): void {
    const city = state.city;
    const name = city?.name ?? 'Choose a city';
    patcher.text(cityName, name);

    let meta = 'Search the atlas';
    if (city) {
      const parts = [countryName(city.country) || '—', city.tz];
      if (state.sky) {
        const offset = state.sky.utcOffsetMinutes;
        const sign = offset >= 0 ? '+' : '−';
        const abs = Math.abs(offset);
        parts.push(`UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`);
      }
      meta = parts.join(' · ');
    }
    patcher.text(cityMeta, meta);

    let title = 'Choose a city';
    if (city) {
      title = `${city.name} — ${city.country || 'unknown country'} · ${city.tz}`;
      if (state.model) {
        const meta2 = state.model.meta;
        title += `\n${formatCount(meta2.stats.buildings)} buildings · ${formatCount(meta2.stats.roads)} roads · ${meta2.radiusM} m radius`;
        title += `\nSource: ${sourceLabel(meta2.source)}`;
        if (meta2.attribution) title += `\n${meta2.attribution}`;
      }
    }
    patcher.attr(cityChip, 'title', title);
    patcher.attr(cityChip, 'aria-label', city ? `City: ${city.name}. Change city` : 'Choose a city');

    const canPick = state.phase === 'ready' && state.model !== null;
    patcher.disabled(areaPickButton, !canPick);
    patcher.attr(areaPickButton, 'aria-pressed', state.detailPanelOpen ? 'true' : 'false');
    patcher.cls(areaPickButton, 'is-active', state.detailPanelOpen);
    patcher.attr(
      areaPickButton,
      'aria-label',
      state.detailPanelOpen ? 'Close area picker' : 'Open area picker'
    );
    patcher.attr(
      areaPickButton,
      'title',
      state.detailPanelOpen
        ? 'Close the area picker (Esc)'
        : 'Choose a 1.5–3 km area: focus the camera or rebuild the city there'
    );
  }

  return {
    element,
    update,
    setSearchOpen(open: boolean): void {
      patcher.attr(cityChip, 'aria-expanded', open ? 'true' : 'false');
      patcher.attr(openSearch, 'aria-expanded', open ? 'true' : 'false');
    },
    focusAreaButton(): void {
      focusEl(areaPickButton);
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
