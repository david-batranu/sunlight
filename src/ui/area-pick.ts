/**
 * "Choose area" mode UI: the top-bar toggle, the hint banner and the pure
 * state/label helpers used by the shell and unit tests.
 */

import type { AppState } from '../app/state.ts';
import type { LoadPhase, UIContext } from '../app/contracts.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

export const AREA_PICK_BUTTON_LABEL = 'Choose area';
export const AREA_PICK_HINT_TEXT = 'Tap the city to move the model there.';
export const AREA_PICK_CANCEL_LABEL = 'Cancel';

/** Area picking only makes sense once a model is on screen. */
export function canPickArea(phase: LoadPhase, hasModel: boolean): boolean {
  return phase === 'ready' && hasModel;
}

export interface AreaPickUiState {
  disabled: boolean;
  pressed: boolean;
  hintVisible: boolean;
  hintText: string;
  buttonLabel: string;
  cancelLabel: string;
  cancelAriaLabel: string;
}

/** Derives all label/visibility flags for the choose-area controls. */
export function areaPickUiState(
  picking: boolean,
  phase: LoadPhase,
  hasModel: boolean
): AreaPickUiState {
  const enabled = canPickArea(phase, hasModel);
  return {
    disabled: !enabled,
    pressed: picking,
    hintVisible: picking,
    hintText: picking ? AREA_PICK_HINT_TEXT : '',
    buttonLabel: AREA_PICK_BUTTON_LABEL,
    cancelLabel: AREA_PICK_CANCEL_LABEL,
    cancelAriaLabel: 'Cancel choosing an area'
  };
}

export interface AreaPickHandle {
  element: HTMLElement;
  update(state: AppState): void;
  destroy(): void;
}

export function createAreaPickHint(ctx: UIContext): AreaPickHandle {
  const patcher = createPatcher();
  const element = el(
    'div',
    'sl-area-pick',
    `
    <span class="sl-area-pick-icon" aria-hidden="true">${icon('areaPick')}</span>
    <span class="sl-area-pick-text">
      <strong class="sl-area-pick-title">Choose a new area</strong>
      <span class="sl-area-pick-message" data-testid="area-pick-text">${AREA_PICK_HINT_TEXT}</span>
    </span>
    <span class="sl-area-pick-esc"><kbd class="sl-kbd">Esc</kbd> to cancel</span>
    <button class="sl-area-pick-cancel" type="button" data-testid="area-pick-cancel">${AREA_PICK_CANCEL_LABEL}</button>
  `
  );
  element.dataset.testid = 'area-pick-hint';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  const cancelButton = q<HTMLButtonElement>(element, '[data-testid="area-pick-cancel"]');
  cancelButton.setAttribute('aria-label', 'Cancel choosing an area');

  const cleanup = [on(cancelButton, 'click', () => ctx.actions.cancelAreaPick())];

  function update(state: AppState): void {
    const ui = areaPickUiState(state.pickingArea, state.phase, state.model !== null);
    patcher.hidden(element, !ui.hintVisible);
  }

  return {
    element,
    update,
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
