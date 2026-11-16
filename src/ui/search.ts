/**
 * Full-screen city search dialog: debounced server search, recent cities, the
 * eight ready-made Romanian seeds and a "use my location" shortcut.
 */

import type { AppState } from '../app/state.ts';
import type { UIContext } from '../app/contracts.ts';
import { SEED_CITIES } from '../../shared/constants.ts';
import type { CitySearchResult } from '../../shared/types.ts';
import { formatPopulation } from './format.ts';
import {
  addRecent,
  parseRecent,
  serializeRecent,
  RECENT_STORAGE_KEY,
  type RecentCity
} from './recent.ts';
import { createPatcher, el, localStore, on, q, trapFocus } from './dom.ts';
import { icon } from './icons.ts';

export interface SearchDialogCallbacks {
  onOpenChange(open: boolean): void;
}

export interface SearchDialogHandle {
  element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  update(state: AppState): void;
  destroy(): void;
}

const DEBOUNCE_MS = 200;
const MAX_RESULTS = 8;

export function createSearchDialog(ctx: UIContext, callbacks: SearchDialogCallbacks): SearchDialogHandle {
  const patcher = createPatcher();
  const storage = localStore();
  const element = el(
    'div',
    'sl-modal',
    `
    <div class="sl-dialog sl-search-dialog" data-testid="search-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-search-heading">
      <header class="sl-search-head">
        <span class="sl-search-icon" aria-hidden="true">${icon('search')}</span>
        <div class="sl-search-field">
          <label class="sl-sr-only" for="sl-search-input">Search cities</label>
          <h2 class="sl-sr-only" id="sl-search-heading">Search cities</h2>
          <input
            id="sl-search-input"
            class="sl-search-input"
            type="text"
            data-testid="search-input"
            placeholder="Search a city — try Cluj, Lisbon or Kyoto"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
            aria-controls="sl-search-results"
          />
        </div>
        <kbd class="sl-kbd sl-search-kbd">Esc</kbd>
        <button class="sl-icon-btn" type="button" data-testid="search-close" aria-label="Close search">
          ${icon('close')}
        </button>
      </header>
      <div class="sl-search-body">
        <p class="sl-search-status" data-testid="search-status" role="status" aria-live="polite"></p>
        <ul class="sl-results" id="sl-search-results" data-testid="search-results" role="listbox" aria-label="City results" hidden></ul>
        <section class="sl-search-section" data-testid="recent-section">
          <h3 class="sl-search-section-title">Recent</h3>
          <div class="sl-recent-list" data-testid="recent-list"></div>
        </section>
        <section class="sl-search-section" data-testid="seed-section">
          <h3 class="sl-search-section-title">Ready-made cities <span class="sl-chip">Instant</span></h3>
          <div class="sl-seed-grid" data-testid="seed-grid"></div>
        </section>
        <section class="sl-search-section">
          <button class="sl-btn sl-btn--wide sl-locate-modal" type="button" data-testid="locate-modal">
            ${icon('locate')}<span>Use my location</span>
          </button>
          <p class="sl-search-hint">Your coordinates are only used to find the nearest city.</p>
        </section>
      </div>
      <footer class="sl-search-foot">
        <span class="sl-search-keys"><kbd class="sl-kbd">↑</kbd><kbd class="sl-kbd">↓</kbd> browse · <kbd class="sl-kbd">Enter</kbd> open · <kbd class="sl-kbd">Esc</kbd> close</span>
        <span class="sl-search-count" data-testid="search-count"></span>
      </footer>
    </div>
  `
  );

  element.hidden = true;
  const dialog = q<HTMLElement>(element, '.sl-search-dialog');
  const input = q<HTMLInputElement>(element, '[data-testid="search-input"]');
  const resultsList = q<HTMLUListElement>(element, '[data-testid="search-results"]');
  const status = q<HTMLElement>(element, '[data-testid="search-status"]');
  const recentSection = q<HTMLElement>(element, '[data-testid="recent-section"]');
  const recentList = q<HTMLElement>(element, '[data-testid="recent-list"]');
  const seedGrid = q<HTMLElement>(element, '[data-testid="seed-grid"]');
  const count = q<HTMLElement>(element, '[data-testid="search-count"]');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="search-close"]');
  const locateButton = q<HTMLButtonElement>(element, '[data-testid="locate-modal"]');

  let isOpen = false;
  let results: CitySearchResult[] = [];
  let activeIndex = -1;
  let loading = false;
  let searchError: string | null = null;
  let query = '';
  let token = 0;
  let debounceTimer: number | null = null;
  let previousFocus: HTMLElement | null = null;
  let recent: RecentCity[] = parseRecent(storage?.getItem(RECENT_STORAGE_KEY) ?? null);
  let recentSerialized = serializeRecent(recent);

  /* ---------------------------------------------------------------- */
  /* Recent cities                                                     */
  /* ---------------------------------------------------------------- */

  function persistRecent(): void {
    const serialized = serializeRecent(recent);
    if (serialized === recentSerialized) return;
    recentSerialized = serialized;
    try {
      storage?.setItem(RECENT_STORAGE_KEY, serialized);
    } catch {
      /* storage may be full or blocked */
    }
    renderRecent();
  }

  function rememberCity(city: { geonameId: number | null; name: string; country: string; tz: string }): void {
    if (city.geonameId === null) return;
    recent = addRecent(recent, {
      geonameId: city.geonameId,
      name: city.name,
      country: city.country,
      tz: city.tz
    });
    persistRecent();
  }

  function rememberResult(result: CitySearchResult): void {
    rememberCity({
      geonameId: result.geonameId,
      name: result.name,
      country: result.country,
      tz: result.tz
    });
  }

  function renderRecent(): void {
    recentList.replaceChildren();
    if (recent.length === 0) {
      patcher.hidden(recentSection, true);
      return;
    }
    patcher.hidden(recentSection, false);
    for (const city of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sl-recent';
      button.dataset.geonameId = String(city.geonameId);
      button.innerHTML = `${icon('clock')}<span class="sl-recent-name">${escapeHtml(city.name)}</span><span class="sl-recent-country">${escapeHtml(city.country)}</span>`;
      button.addEventListener('click', () => {
        rememberCity(city);
        close();
        ctx.actions.selectCity({ kind: 'city', geonameId: city.geonameId });
      });
      recentList.append(button);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Seed shortcuts                                                    */
  /* ---------------------------------------------------------------- */

  SEED_CITIES.forEach((seed, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sl-seed';
    button.dataset.testid = `seed-shortcut-${index}`;
    button.dataset.geonameId = String(seed.geonameId);
    button.innerHTML = `${icon('seed')}<span class="sl-seed-name">${escapeHtml(seed.name)}</span><span class="sl-seed-country">RO</span>`;
    button.title = `${seed.name} — ready-made model, loads instantly`;
    button.addEventListener('click', () => {
      rememberCity({
        geonameId: seed.geonameId,
        name: seed.name,
        country: 'RO',
        tz: seed.tz
      });
      close();
      ctx.actions.selectCity({ kind: 'city', geonameId: seed.geonameId });
    });
    seedGrid.append(button);
  });

  /* ---------------------------------------------------------------- */
  /* Results rendering                                                 */
  /* ---------------------------------------------------------------- */

  function setStatus(message: string): void {
    patcher.text(status, message);
    patcher.attr(status, 'hidden', message ? null : '');
  }

  function renderResults(): void {
    resultsList.replaceChildren();
    const hasQuery = query.length > 0;
    patcher.hidden(resultsList, !hasQuery);
    patcher.attr(input, 'aria-expanded', hasQuery ? 'true' : 'false');
    patcher.hidden(recentSection, hasQuery || recent.length === 0);
    patcher.text(count, hasQuery && results.length > 0 ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : '');

    if (!hasQuery) {
      setStatus('Search the GeoNames atlas or jump to a ready-made city.');
      activeIndex = -1;
      updateActiveDescendant();
      return;
    }
    if (loading) {
      setStatus('Searching…');
      resultsList.append(renderSkeleton());
      activeIndex = -1;
      updateActiveDescendant();
      return;
    }
    if (searchError) {
      setStatus(`Search failed: ${searchError}`);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'sl-btn sl-btn--quiet sl-search-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        void runSearch(query);
      });
      resultsList.append(retry);
      activeIndex = -1;
      updateActiveDescendant();
      return;
    }
    if (results.length === 0) {
      setStatus(`No cities found for “${query}”. Try another spelling or a seed city below.`);
      activeIndex = -1;
      updateActiveDescendant();
      return;
    }

    setStatus(`${results.length} ${results.length === 1 ? 'city' : 'cities'} found.`);
    results.forEach((result, index) => {
      const item = document.createElement('li');
      item.className = 'sl-result';
      item.id = `sl-search-option-${index}`;
      item.dataset.testid = `search-result-${index}`;
      item.dataset.index = String(index);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      const countryName = result.countryName || result.country || 'Unknown';
      const population = formatPopulation(result.population);
      const ariaParts = [result.name, countryName];
      if (result.population > 0) ariaParts.push(`population ${formatCountForAria(result.population)}`);
      if (result.seed) ariaParts.push('ready-made seed');
      item.setAttribute('aria-label', ariaParts.join(', '));
      item.innerHTML = `
        <span class="sl-result-main">
          <span class="sl-result-name">${escapeHtml(result.name)}${result.asciiName && result.asciiName !== result.name ? ` <span class="sl-result-ascii">${escapeHtml(result.asciiName)}</span>` : ''}</span>
          <span class="sl-result-sub">${escapeHtml(countryName)}${result.country ? ` · ${escapeHtml(result.country)}` : ''}${result.population > 0 ? ` · ${population}` : ''}</span>
        </span>
        <span class="sl-result-side">
          ${result.seed ? '<span class="sl-result-seed">Seed</span>' : ''}
          <span class="sl-result-pop">${result.population > 0 ? population : ''}</span>
        </span>
      `;
      item.addEventListener('click', () => chooseResult(index));
      resultsList.append(item);
    });
    activeIndex = results.length > 0 ? 0 : -1;
    applyActive();
  }

  function renderSkeleton(): HTMLElement {
    const item = document.createElement('li');
    item.className = 'sl-result sl-result--skeleton';
    item.setAttribute('aria-hidden', 'true');
    item.innerHTML = '<span class="sl-result-main"><span class="sl-skeleton-line"></span><span class="sl-skeleton-line sl-skeleton-line--short"></span></span>';
    return item;
  }

  function resultsElements(): HTMLElement[] {
    return Array.from(resultsList.querySelectorAll<HTMLElement>('.sl-result[data-index]'));
  }

  function applyActive(): void {
    resultsElements().forEach((item, index) => {
      item.classList.toggle('is-active', index === activeIndex);
      item.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
    });
    updateActiveDescendant();
  }

  function updateActiveDescendant(): void {
    patcher.attr(
      input,
      'aria-activedescendant',
      activeIndex >= 0 ? `sl-search-option-${activeIndex}` : null
    );
  }

  function moveActive(delta: number): void {
    const total = results.length;
    if (total === 0) return;
    activeIndex = (activeIndex + delta + total) % total;
    applyActive();
    const selected = resultsList.querySelector<HTMLElement>(`#sl-search-option-${activeIndex}`);
    selected?.scrollIntoView({ block: 'nearest' });
  }

  function chooseResult(index: number): void {
    const result = results[index];
    if (!result) return;
    rememberResult(result);
    close();
    ctx.actions.selectSearchResult(result);
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCountForAria(value: number): string {
    return Math.round(value).toLocaleString('en-GB');
  }

  /* ---------------------------------------------------------------- */
  /* Search flow                                                       */
  /* ---------------------------------------------------------------- */

  async function runSearch(value: string): Promise<void> {
    const myToken = ++token;
    query = value;
    if (!query) {
      results = [];
      loading = false;
      searchError = null;
      renderResults();
      return;
    }
    loading = true;
    searchError = null;
    renderResults();
    try {
      const response = await ctx.searchCities(query, MAX_RESULTS);
      if (myToken !== token || !isOpen) return;
      results = Array.isArray(response.results) ? response.results.slice(0, MAX_RESULTS) : [];
      loading = false;
      searchError = null;
      activeIndex = results.length > 0 ? 0 : -1;
      renderResults();
    } catch (error) {
      if (myToken !== token) return;
      loading = false;
      results = [];
      searchError = error instanceof Error ? error.message : 'Unable to search right now.';
      renderResults();
    }
  }

  function scheduleSearch(value: string): void {
    query = value;
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    if (query.length === 0) {
      token += 1;
      results = [];
      loading = false;
      searchError = null;
      renderResults();
      return;
    }
    loading = true;
    searchError = null;
    renderResults();
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void runSearch(query);
    }, DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.hidden = false;
    query = '';
    results = [];
    loading = false;
    searchError = null;
    activeIndex = -1;
    token += 1;
    input.value = '';
    renderRecent();
    renderResults();
    callbacks.onOpenChange(true);
    window.setTimeout(() => {
      if (isOpen) input.focus({ preventScroll: true });
    }, 0);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    token += 1;
    element.hidden = true;
    callbacks.onOpenChange(false);
    const focusTarget = previousFocus;
    previousFocus = null;
    if (focusTarget && focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  const cleanup = [
    on(closeButton, 'click', () => close()),
    on(locateButton, 'click', () => {
      close();
      void ctx.actions.locate();
    }),
    on(element, 'click', (event) => {
      if (event.target === element) close();
    }),
    on(input, 'input', () => {
      scheduleSearch(input.value.trim());
    }),
    on(input, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'ArrowDown') {
        keyboardEvent.preventDefault();
        moveActive(1);
      } else if (keyboardEvent.key === 'ArrowUp') {
        keyboardEvent.preventDefault();
        moveActive(-1);
      } else if (keyboardEvent.key === 'Enter') {
        keyboardEvent.preventDefault();
        if (results.length > 0) chooseResult(activeIndex >= 0 ? activeIndex : 0);
      }
    }),
    on(dialog, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        close();
        return;
      }
      trapFocus(keyboardEvent, dialog);
    })
  ];

  renderRecent();
  renderResults();

  return {
    element,
    open,
    close,
    isOpen(): boolean {
      return isOpen;
    },
    update(state: AppState): void {
      if (state.phase === 'ready' && state.city) rememberCity(state.city);
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    }
  };
}
