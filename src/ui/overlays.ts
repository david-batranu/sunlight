/**
 * Blocking overlays and toasts: generation progress, the error card with seed
 * fallbacks, and the notices stack.
 */

import type { AppState } from '../app/state.ts';
import type { UIContext } from '../app/contracts.ts';
import { SEED_CITIES } from '../../shared/constants.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

export interface ProgressOverlayHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export interface ErrorCardHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export interface NoticesHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export function createProgressOverlay(ctx: UIContext, onSearch: () => void): ProgressOverlayHandle {
  const patcher = createPatcher();
  const element = el(
    'div',
    'sl-overlay sl-progress-overlay',
    `
    <div class="sl-progress-card" role="dialog" aria-modal="true" aria-labelledby="sl-progress-title">
      <div class="sl-progress-orbit" aria-hidden="true"><span class="sl-progress-sun"></span></div>
      <p class="sl-eyebrow" data-testid="progress-eyebrow">Building a city</p>
      <h2 class="sl-progress-city" id="sl-progress-title" data-testid="progress-city">—</h2>
      <p class="sl-progress-step" data-testid="progress-step">Starting…</p>
      <div class="sl-progress-meta">
        <span class="sl-progress-pct" data-testid="progress-percent">0%</span>
        <span class="sl-progress-detail" data-testid="progress-detail"></span>
      </div>
      <div class="sl-progress-bar" data-testid="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Starting">
        <span class="sl-progress-fill"></span>
      </div>
      <p class="sl-progress-note" data-testid="progress-note">First visit builds the city model. Ready-made cities load instantly.</p>
      <div class="sl-progress-actions">
        <button class="sl-btn sl-btn--danger" type="button" data-testid="cancel-generation" hidden>Cancel</button>
        <button class="sl-btn sl-btn--quiet" type="button" data-testid="progress-search">Search a city</button>
      </div>
    </div>
  `
  );
  element.hidden = true;
  element.dataset.testid = 'progress-overlay';
  const card = q<HTMLElement>(element, '.sl-progress-card');
  const title = q<HTMLElement>(element, '[data-testid="progress-city"]');
  const eyebrow = q<HTMLElement>(element, '[data-testid="progress-eyebrow"]');
  const step = q<HTMLElement>(element, '[data-testid="progress-step"]');
  const percent = q<HTMLElement>(element, '[data-testid="progress-percent"]');
  const detail = q<HTMLElement>(element, '[data-testid="progress-detail"]');
  const note = q<HTMLElement>(element, '[data-testid="progress-note"]');
  const bar = q<HTMLElement>(element, '[data-testid="progress-bar"]');
  const fill = q<HTMLElement>(element, '.sl-progress-fill');
  const cancel = q<HTMLButtonElement>(element, '[data-testid="cancel-generation"]');

  const cleanup = [
    on(cancel, 'click', () => ctx.actions.cancelGeneration()),
    on(q(element, '[data-testid="progress-search"]'), 'click', () => onSearch())
  ];

  function update(state: AppState): void {
    const resolving = state.phase === 'resolving';
    const generating = state.phase === 'generating';
    const loading = state.phase === 'loading';
    const visible = resolving || generating || loading;
    patcher.hidden(element, !visible);
    if (!visible) return;

    const progress = state.progress;
    const stepLabel = progress?.label ?? (resolving ? 'Resolving coordinates…' : loading ? 'Opening the model…' : 'Starting…');
    const currentPercent = Math.round(progress?.percent ?? (resolving ? 4 : loading ? 100 : 0));
    const label = generating ? 'Building a city' : loading ? 'Opening the model' : 'Locating the city';
    const name = state.generatingName ?? state.city?.name ?? 'Your city';

    patcher.text(eyebrow, label);
    patcher.text(title, name);
    patcher.text(step, stepLabel);
    patcher.text(detail, progress?.detail ?? '');
    patcher.text(
      note,
      generating
        ? 'Generation usually takes a few seconds to a minute, depending on the city.'
        : loading
          ? 'Almost there — preparing the diorama.'
          : 'Checking the atlas for your city.'
    );

    if (progress) {
      patcher.text(percent, `${currentPercent}%`);
      patcher.style(fill, 'width', `${Math.max(2, Math.min(100, currentPercent))}%`);
      patcher.attr(bar, 'aria-valuenow', currentPercent);
      patcher.attr(bar, 'aria-valuetext', `${stepLabel} ${currentPercent}%`);
      patcher.cls(bar, 'is-indeterminate', false);
    } else {
      patcher.text(percent, '');
      patcher.style(fill, 'width', '32%');
      patcher.attr(bar, 'aria-valuenow', null);
      patcher.attr(bar, 'aria-valuetext', stepLabel);
      patcher.cls(bar, 'is-indeterminate', true);
    }

    patcher.hidden(cancel, !generating);
    patcher.disabled(cancel, !generating);
    patcher.attr(card, 'aria-busy', 'true');
  }

  return {
    element,
    update,
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}

export function createErrorCard(
  ctx: UIContext,
  callbacks: { onSearch: () => void }
): ErrorCardHandle {
  const patcher = createPatcher();
  const seeds = SEED_CITIES.slice(0, 4);
  const element = el(
    'div',
    'sl-overlay sl-error-overlay',
    `
    <div class="sl-error-card" data-testid="error-card" role="alertdialog" aria-modal="true" aria-labelledby="sl-error-title" aria-describedby="sl-error-message">
      <span class="sl-error-icon" aria-hidden="true">${icon('warning')}</span>
      <p class="sl-eyebrow">Something went wrong</p>
      <h2 class="sl-error-title" id="sl-error-title" data-testid="error-title">Couldn't open this city</h2>
      <p class="sl-error-message" id="sl-error-message" data-testid="error-message">—</p>
      <p class="sl-error-meta"><code data-testid="error-code">—</code><span data-testid="error-hint"></span></p>
      <div class="sl-error-actions">
        <button class="sl-btn sl-btn--primary" type="button" data-testid="retry">Retry</button>
        <button class="sl-btn" type="button" data-testid="error-search">Search another city</button>
      </div>
      <div class="sl-error-seeds">
        <h3 class="sl-error-seeds-title">Or explore a ready-made city</h3>
        <div class="sl-seed-grid" data-testid="error-seeds">
          ${seeds
            .map(
              (seed, index) =>
                `<button class="sl-seed" type="button" data-testid="error-seed-${index}" data-geoname-id="${seed.geonameId}">${icon('seed')}<span class="sl-seed-name">${seed.name}</span><span class="sl-seed-country">RO</span></button>`
            )
            .join('')}
        </div>
      </div>
    </div>
  `
  );
  element.hidden = true;
  const title = q<HTMLElement>(element, '[data-testid="error-title"]');
  const message = q<HTMLElement>(element, '[data-testid="error-message"]');
  const code = q<HTMLElement>(element, '[data-testid="error-code"]');
  const hint = q<HTMLElement>(element, '[data-testid="error-hint"]');
  const retry = q<HTMLButtonElement>(element, '[data-testid="retry"]');

  const seedButtons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-testid^="error-seed-"]'));

  const cleanup = [
    on(retry, 'click', () => ctx.actions.retry()),
    on(q(element, '[data-testid="error-search"]'), 'click', () => callbacks.onSearch()),
    ...seedButtons.map((button) =>
      on(button, 'click', () => {
        const geonameId = Number(button.dataset.geonameId);
        if (Number.isFinite(geonameId)) ctx.actions.selectCity({ kind: 'city', geonameId });
      })
    )
  ];

  function hintFor(codeValue: string): string {
    switch (codeValue) {
      case 'NO_DATA':
        return 'There is not enough mapped data here yet. Try a ready-made city below.';
      case 'CITY_NOT_FOUND':
        return 'That city is not in the atlas. Search for another place.';
      case 'NETWORK':
        return 'The city server is not responding. Check that it is running, then retry.';
      case 'CANCELLED':
        return 'Generation was stopped. Retry, or pick another city.';
      default:
        return 'You can retry, or choose from the ready-made cities below.';
    }
  }

  function update(state: AppState): void {
    const error = state.error;
    const visible = state.phase === 'error' && error !== null;
    patcher.hidden(element, !visible);
    if (!visible || !error) return;
    const name = error.targetName ?? state.city?.name ?? 'that city';
    patcher.text(title, `Couldn't open ${name}`);
    patcher.text(message, error.message || 'The city could not be loaded.');
    patcher.text(code, error.code || 'ERROR');
    patcher.text(hint, hintFor(error.code));
    patcher.disabled(retry, error.retryable === false);
    patcher.attr(retry, 'title', error.retryable === false ? 'This error is not retryable' : 'Try again');
    // Hide the current city from the seed suggestions when possible.
    const currentId = state.city?.geonameId ?? null;
    seedButtons.forEach((button) => {
      patcher.hidden(button, Number(button.dataset.geonameId) === currentId);
    });
  }

  return {
    element,
    update,
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}

export function createNotices(ctx: UIContext): NoticesHandle {
  const patcher = createPatcher();
  const element = el(
    'div',
    'sl-notices',
    `
    <ul class="sl-notice-list" data-testid="notice-list" aria-live="polite" aria-atomic="false"></ul>
    <button class="sl-notice-dismiss" type="button" data-testid="notices-dismiss" aria-label="Dismiss notices" hidden>${icon('close')}</button>
  `
  );
  element.hidden = true;
  const list = q<HTMLUListElement>(element, '[data-testid="notice-list"]');
  const dismiss = q<HTMLButtonElement>(element, '[data-testid="notices-dismiss"]');
  let lastSerialized = '';
  const cleanup = [on(dismiss, 'click', () => ctx.actions.dismissNotices())];

  function update(state: AppState): void {
    const notices = state.notices;
    const serialized = notices.join('\u0000');
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    list.replaceChildren();
    for (const notice of notices) {
      const item = document.createElement('li');
      item.className = 'sl-notice';
      item.textContent = notice;
      list.append(item);
    }
    patcher.hidden(element, notices.length === 0);
    patcher.hidden(dismiss, notices.length === 0);
  }

  return {
    element,
    update,
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
