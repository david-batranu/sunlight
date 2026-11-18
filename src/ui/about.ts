/**
 * About / attribution dialog: the story, keyboard shortcuts, data licences and
 * the privacy note.
 */

import type { UIContext } from '../app/contracts.ts';
import type { AppState } from '../app/state.ts';
import { GEONAMES_ATTRIBUTION, OSM_ATTRIBUTION, TERRAIN_ATTRIBUTION } from '../../shared/constants.ts';
import { SHORTCUT_TABLE } from './shortcuts.ts';
import { el, on, q, trapFocus } from './dom.ts';
import { icon } from './icons.ts';

export interface AboutDialogCallbacks {
  onOpenChange(open: boolean): void;
}

export interface AboutDialogHandle {
  element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  update(state: AppState): void;
  destroy(): void;
}

function shortcutRow(keys: string, label: string): string {
  const parts = keys.split(' + ');
  const rendered = parts.map((part) => `<kbd class="sl-kbd">${part}</kbd>`).join(' + ');
  return `<div class="sl-key-row"><dt>${rendered}</dt><dd>${label}</dd></div>`;
}

export function createAboutDialog(ctx: UIContext, callbacks: AboutDialogCallbacks): AboutDialogHandle {
  const element = el(
    'div',
    'sl-modal',
    `
    <div class="sl-dialog sl-about-dialog" data-testid="about-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-about-heading">
      <header class="sl-about-head">
        <span class="sl-eyebrow">About</span>
        <h2 id="sl-about-heading">Sunlight</h2>
        <p class="sl-about-lede">
          A small study of light and shadow. Pick a city, scrub the day, and watch the
          diorama turn as the real sun and moon move over it.
        </p>
        <button class="sl-icon-btn sl-about-close" type="button" data-testid="about-close" aria-label="Close about">
          ${icon('close')}
        </button>
      </header>
      <div class="sl-about-body">
        <section class="sl-about-section">
          <h3>The idea</h3>
          <p>
            City footprints come from OpenStreetMap and are rebuilt as a compact low-poly model.
            Sun and moon positions are computed for the city's own timezone on the selected date,
            so sunrise, golden hour and night all match the place you are looking at.
          </p>
        </section>
        <section class="sl-about-section">
          <h3>Keyboard</h3>
          <p class="sl-about-note" data-testid="about-keyboard-note">
            Space and Enter activate the focused control. Global shortcuts pause while a
            control or text field has focus; Escape always closes the open panel or dialog.
          </p>
          <dl class="sl-keys">
            ${SHORTCUT_TABLE.map((entry) => shortcutRow(entry.keys, entry.label)).join('')}
          </dl>
        </section>
        <section class="sl-about-section">
          <h3>Data &amp; attribution</h3>
          <ul class="sl-attrib-list">
            <li><strong>City geometry</strong> — ${OSM_ATTRIBUTION}. Buildings, roads, water, parks and rail are derived from OpenStreetMap data. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap copyright</a></li>
            <li><strong>Map context</strong> — the low-quality map surrounding the diorama and the Area panel's overview load raster tiles from <a href="https://tile.openstreetmap.org" target="_blank" rel="noopener noreferrer">tile.openstreetmap.org</a>; the diorama itself works without them.</li>
            <li><strong>Elevation</strong> — ${TERRAIN_ATTRIBUTION} (Mapzen terrain tiles, derived from SRTM and other public DEMs).</li>
            <li><strong>City index</strong> — ${GEONAMES_ATTRIBUTION}. Search covers populated places from the GeoNames cities5000 index.</li>
            <li><strong>Sun &amp; moon</strong> — altazimuth positions from standard astronomical ephemerides, sampled every five minutes of city-local wall-clock time.</li>
            <li><strong>Timezone</strong> — times are shown in the city's IANA timezone with a 24-hour clock; distances are metric (metres and kilometres).</li>
            <li data-testid="about-data-notes" hidden><strong>Data notes</strong> — <span data-testid="about-warnings"></span></li>
          </ul>
        </section>
        <section class="sl-about-section">
          <h3>Privacy</h3>
          <p data-testid="about-privacy">
            No accounts and no analytics. Your location is only requested when you press
            <em>Locate</em>, and it is used once to find the nearest city.
          </p>
          <p data-testid="about-privacy-tiles">
            The main view loads low-resolution PNG map tiles for the surrounding context from
            <a href="https://tile.openstreetmap.org" target="_blank" rel="noopener noreferrer">tile.openstreetmap.org</a>,
            and the <em>Area</em> panel loads higher-zoom tiles for its overview. Those requests
            share your IP address and approximate area with OpenStreetMap. No other third-party
            requests are made.
          </p>
          <p data-testid="about-privacy-cache">
            On a shared deployment, generated custom areas are cached server-side. Their
            approximate centres appear as anonymous footprints on the context map so any
            visitor can reopen a cached area instead of generating a near-duplicate. No
            account, name or personal profile is stored with them.
          </p>
          <p>
            Deep links carry the city, date and time; picking a custom area adds its centre
            coordinates to the link. Sunlight is set in the city's IANA timezone with a
            24-hour clock and metric distances.
          </p>
        </section>
      </div>
      <footer class="sl-about-foot">
        <button class="sl-btn" type="button" data-testid="copy-link-about">
          ${icon('link')}<span>Copy link to this moment</span>
        </button>
        <span class="sl-about-status" data-testid="about-status" role="status" aria-live="polite"></span>
        <button class="sl-btn sl-btn--primary" type="button" data-testid="about-done">Close</button>
      </footer>
    </div>
  `
  );

  element.hidden = true;
  const dialog = q<HTMLElement>(element, '.sl-about-dialog');
  const closeButton = q<HTMLButtonElement>(element, '[data-testid="about-done"]');
  const copyButton = q<HTMLButtonElement>(element, '[data-testid="copy-link-about"]');
  const status = q<HTMLElement>(element, '[data-testid="about-status"]');
  const dataNotes = q<HTMLElement>(element, '[data-testid="about-data-notes"]');
  const warningsText = q<HTMLElement>(element, '[data-testid="about-warnings"]');
  let open = false;
  let previousFocus: HTMLElement | null = null;

  function openDialog(): void {
    if (open) return;
    open = true;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.hidden = false;
    status.textContent = '';
    callbacks.onOpenChange(true);
    window.setTimeout(() => {
      if (open) closeButton.focus({ preventScroll: true });
    }, 0);
  }

  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
    callbacks.onOpenChange(false);
    const target = previousFocus;
    previousFocus = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  }

  const cleanup = [
    on(closeButton, 'click', () => close()),
    on(q(element, '[data-testid="about-close"]'), 'click', () => close()),
    on(element, 'click', (event) => {
      if (event.target === element) close();
    }),
    on(copyButton, 'click', () => {
      void ctx.actions.copyLink().then((copied) => {
        status.textContent = copied ? 'Link copied.' : 'Copy failed — the address bar has the link.';
      });
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

  return {
    element,
    open: openDialog,
    close,
    isOpen(): boolean {
      return open;
    },
    update(state: AppState): void {
      const warnings = state.model?.meta.warnings ?? [];
      if (warnings.length > 0) {
        warningsText.textContent = `${warnings.length} import warning${warnings.length === 1 ? '' : 's'} recorded while building this model. They are kept with the model metadata and do not affect the scene.`;
        dataNotes.hidden = false;
      } else {
        warningsText.textContent = '';
        dataNotes.hidden = true;
      }
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
