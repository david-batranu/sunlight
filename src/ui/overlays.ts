/**
 * Blocking overlays and toasts: generation progress, the error card with seed
 * fallbacks, and the notices stack.
 *
 * Both blocking overlays are real dialogs for assistive technology: focus moves
 * into the card when it appears, Tab is trapped while it is open, the background
 * is made inert by the shell, and focus returns to the invoking control when the
 * overlay disappears.
 */

import type { AppState } from '../app/state.ts';
import type { AppError, UIContext } from '../app/contracts.ts';
import { SEED_CITIES } from '../../shared/constants.ts';
import { createPatcher, el, firstFocusable, focusEl, on, q, trapFocus } from './dom.ts';
import { icon } from './icons.ts';

export interface ProgressOverlayHandle {
  element: HTMLElement;
  update(state: AppState): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface ErrorCardHandle {
  element: HTMLElement;
  update(state: AppState): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface NoticesHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

/** How long transient notices stay on screen before auto-dismissing. */
export const NOTICE_AUTO_DISMISS_MS = 6000;

/* ------------------------------------------------------------------ */
/* User-facing error presentation                                      */
/* ------------------------------------------------------------------ */

export interface ErrorPresentation {
  /** Plain-language headline (without the city name). */
  message: string;
  /** What the user can do next. */
  hint: string;
  /** Whether the Retry action is meaningful for this error. */
  retryable: boolean;
  /** Raw server text, only shown behind a "Technical details" disclosure. */
  details: string;
}

const GENERIC_RECOVERY = 'Try again, or explore a ready-made city below.';

/**
 * Maps backend error codes to user language. Raw server messages/codes are
 * never shown in the primary copy — they live behind the details disclosure.
 */
export function presentError(error: Pick<AppError, 'code' | 'message' | 'retryable'>): ErrorPresentation {
  const retryable = error.retryable !== false;
  const raw = `${error.code || 'ERROR'}${error.message ? `: ${error.message}` : ''}`;
  switch (error.code) {
    case 'SEED_UNAVAILABLE':
      return {
        message: "This place isn't available on this server yet.",
        hint: 'Pick one of the ready-made cities below to keep exploring.',
        retryable,
        details: raw
      };
    case 'NO_DATA':
      return {
        message: "There isn't enough mapped data here to build a model.",
        hint: 'Try a ready-made city, or search for a larger place nearby.',
        retryable,
        details: raw
      };
    case 'CITY_NOT_FOUND':
      return {
        message: "We couldn't find that city in the atlas.",
        hint: 'Check the spelling, or search for another place.',
        retryable,
        details: raw
      };
    case 'NETWORK':
    case 'OFFLINE':
      return {
        message: "The city server isn't responding right now.",
        hint: 'Check your connection, then try again.',
        retryable,
        details: raw
      };
    case 'CANCELLED':
      return {
        message: 'Building this city was stopped.',
        hint: 'Try again, or pick another city.',
        retryable,
        details: raw
      };
    case 'MODEL_VERSION_MISMATCH':
    case 'SKY_VERSION_MISMATCH':
      return {
        message: 'The app and the city data are out of sync.',
        hint: 'Reload the page to load the matching version.',
        retryable,
        details: raw
      };
    case 'MODEL_FAILED':
      return {
        message: "This city couldn't be built right now.",
        hint: GENERIC_RECOVERY,
        retryable,
        details: raw
      };
    case 'INTERNAL':
      return {
        message: 'Something went wrong while opening this city.',
        hint: GENERIC_RECOVERY,
        retryable,
        details: raw
      };
    default:
      return {
        message: "This city couldn't be opened.",
        hint: GENERIC_RECOVERY,
        retryable,
        details: raw
      };
  }
}

/* ------------------------------------------------------------------ */
/* Focus helpers                                                       */
/* ------------------------------------------------------------------ */

function rememberFocus(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function restoreFocus(target: HTMLElement | null): void {
  if (target && focusEl(target)) return;
  const fallback = document.querySelector<HTMLElement>('[data-testid="open-search"]');
  focusEl(fallback);
}

/* ------------------------------------------------------------------ */
/* Progress overlay                                                    */
/* ------------------------------------------------------------------ */

export function createProgressOverlay(ctx: UIContext, onSearch: () => void): ProgressOverlayHandle {
  const patcher = createPatcher();
  const element = el(
    'div',
    'sl-overlay sl-progress-overlay',
    `
    <div class="sl-progress-card" role="dialog" aria-modal="true" aria-labelledby="sl-progress-title" aria-describedby="sl-progress-step" tabindex="-1">
      <div class="sl-progress-orbit" aria-hidden="true"><span class="sl-progress-sun"></span></div>
      <p class="sl-eyebrow" data-testid="progress-eyebrow">Building a city</p>
      <h2 class="sl-progress-city" id="sl-progress-title" data-testid="progress-city">—</h2>
      <p class="sl-progress-step" id="sl-progress-step" data-testid="progress-step" aria-live="polite" aria-atomic="true">Starting…</p>
      <div class="sl-progress-meta">
        <span class="sl-progress-pct" data-testid="progress-percent" aria-hidden="true">0%</span>
        <span class="sl-progress-detail" data-testid="progress-detail"></span>
      </div>
      <div class="sl-progress-bar" data-testid="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Starting" aria-labelledby="sl-progress-title">
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

  let wasVisible = false;
  let previousFocus: HTMLElement | null = null;

  const cleanup = [
    on(cancel, 'click', () => ctx.actions.cancelGeneration()),
    on(q(element, '[data-testid="progress-search"]'), 'click', () => onSearch()),
    on(card, 'keydown', (event) => trapFocus(event as KeyboardEvent, card))
  ];

  function update(state: AppState): void {
    const resolving = state.phase === 'resolving';
    const generating = state.phase === 'generating';
    const loading = state.phase === 'loading';
    const visible = resolving || generating || loading;
    if (visible && !wasVisible) {
      previousFocus = rememberFocus();
      element.hidden = false;
      window.setTimeout(() => {
        if (wasVisible) focusEl(card);
      }, 0);
    } else if (!visible && wasVisible) {
      element.hidden = true;
      const target = previousFocus;
      previousFocus = null;
      restoreFocus(target);
    }
    wasVisible = visible;
    if (!visible) return;

    const progress = state.progress;
    const stepLabel =
      progress?.label ?? (resolving ? 'Resolving coordinates…' : loading ? 'Opening the model…' : 'Starting…');
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
    // Keep the dialog name/step in sync for assistive tech after updates.
    patcher.attr(card, 'aria-label', `${label}: ${name}`);
  }

  return {
    element,
    update,
    isOpen(): boolean {
      return wasVisible;
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}

/* ------------------------------------------------------------------ */
/* Error overlay                                                       */
/* ------------------------------------------------------------------ */

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
    <div class="sl-error-card" data-testid="error-card" role="alertdialog" aria-modal="true" aria-labelledby="sl-error-title" aria-describedby="sl-error-message sl-error-hint" tabindex="-1">
      <span class="sl-error-icon" aria-hidden="true">${icon('warning')}</span>
      <p class="sl-eyebrow">Something went wrong</p>
      <h2 class="sl-error-title" id="sl-error-title" data-testid="error-title">Couldn't open this city</h2>
      <p class="sl-error-message" id="sl-error-message" data-testid="error-message">—</p>
      <p class="sl-error-hint" id="sl-error-hint" data-testid="error-hint"></p>
      <details class="sl-error-details" data-testid="error-details">
        <summary>Technical details</summary>
        <p class="sl-error-raw" data-testid="error-raw">—</p>
      </details>
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
  const card = q<HTMLElement>(element, '.sl-error-card');
  const title = q<HTMLElement>(element, '[data-testid="error-title"]');
  const message = q<HTMLElement>(element, '[data-testid="error-message"]');
  const hint = q<HTMLElement>(element, '[data-testid="error-hint"]');
  const raw = q<HTMLElement>(element, '[data-testid="error-raw"]');
  const retry = q<HTMLButtonElement>(element, '[data-testid="retry"]');

  const seedButtons = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-testid^="error-seed-"]'));

  let wasVisible = false;
  let previousFocus: HTMLElement | null = null;

  const cleanup = [
    on(retry, 'click', () => ctx.actions.retry()),
    on(q(element, '[data-testid="error-search"]'), 'click', () => callbacks.onSearch()),
    on(card, 'keydown', (event) => trapFocus(event as KeyboardEvent, card)),
    ...seedButtons.map((button) =>
      on(button, 'click', () => {
        const geonameId = Number(button.dataset.geonameId);
        if (Number.isFinite(geonameId)) ctx.actions.selectCity({ kind: 'city', geonameId });
      })
    )
  ];

  function update(state: AppState): void {
    const error = state.error;
    const visible = state.phase === 'error' && error !== null;
    if (visible && !wasVisible) {
      previousFocus = rememberFocus();
      element.hidden = false;
      window.setTimeout(() => {
        if (!wasVisible) return;
        const target = retry.hidden ? firstFocusable(card) : retry;
        focusEl(target ?? card);
      }, 0);
    } else if (!visible && wasVisible) {
      element.hidden = true;
      const target = previousFocus;
      previousFocus = null;
      restoreFocus(target);
    }
    wasVisible = visible;
    if (!visible || !error) return;

    const presentation = presentError(error);
    const name = error.targetName ?? null;
    patcher.text(title, name ? `Couldn't open ${name}` : "Couldn't open this city");
    patcher.text(message, presentation.message);
    patcher.text(hint, presentation.hint);
    patcher.text(raw, presentation.details);
    patcher.hidden(retry, !presentation.retryable);
    patcher.disabled(retry, !presentation.retryable);
    patcher.attr(
      retry,
      'title',
      presentation.retryable ? 'Try loading this city again' : 'This error cannot be retried'
    );
    patcher.hidden(q<HTMLElement>(element, '[data-testid="error-details"]'), false);
    // Hide the current city from the seed suggestions when possible.
    const currentId = state.city?.geonameId ?? null;
    seedButtons.forEach((button) => {
      patcher.hidden(button, Number(button.dataset.geonameId) === currentId);
    });
  }

  return {
    element,
    update,
    isOpen(): boolean {
      return wasVisible;
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

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
  let timer: number | null = null;
  let paused = false;

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleDismiss(): void {
    clearTimer();
    if (element.hidden) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (paused || document.hidden) {
        scheduleDismiss();
        return;
      }
      ctx.actions.dismissNotices();
    }, NOTICE_AUTO_DISMISS_MS);
  }

  const cleanup = [
    on(dismiss, 'click', () => ctx.actions.dismissNotices()),
    on(element, 'pointerenter', () => {
      paused = true;
      clearTimer();
    }),
    on(element, 'pointerleave', () => {
      paused = false;
      scheduleDismiss();
    }),
    on(element, 'focusin', () => {
      paused = true;
      clearTimer();
    }),
    on(element, 'focusout', () => {
      if (!element.contains(document.activeElement)) {
        paused = false;
        scheduleDismiss();
      }
    })
  ];

  function update(state: AppState): void {
    const notices = state.notices;
    const serialized = notices.join('\u0000');
    if (serialized !== lastSerialized) {
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
      if (notices.length === 0) clearTimer();
      else scheduleDismiss();
    }
  }

  return {
    element,
    update,
    destroy(): void {
      clearTimer();
      cleanup.forEach((dispose) => dispose());
    }
  };
}
