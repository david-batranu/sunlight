import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AREA_PICK_BUTTON_LABEL,
  AREA_PICK_CANCEL_LABEL,
  AREA_PICK_HINT_TEXT,
  areaPickUiState,
  canPickArea
} from '../../src/ui/area-pick.ts';

test('area picking is only enabled once a model is ready', () => {
  assert.equal(canPickArea('ready', true), true);
  assert.equal(canPickArea('ready', false), false);
  assert.equal(canPickArea('boot', true), false);
  assert.equal(canPickArea('resolving', true), false);
  assert.equal(canPickArea('generating', true), false);
  assert.equal(canPickArea('loading', true), false);
  assert.equal(canPickArea('error', true), false);
});

test('area pick controls expose stable labels', () => {
  assert.equal(AREA_PICK_BUTTON_LABEL, 'Choose area');
  assert.equal(AREA_PICK_CANCEL_LABEL, 'Cancel');
  assert.match(AREA_PICK_HINT_TEXT, /Tap the city/);
  assert.match(AREA_PICK_HINT_TEXT, /move the model/);
});

test('inactive area pick state keeps the hint hidden', () => {
  const idle = areaPickUiState(false, 'ready', true);
  assert.equal(idle.disabled, false);
  assert.equal(idle.pressed, false);
  assert.equal(idle.hintVisible, false);
  assert.equal(idle.hintText, '');
  assert.equal(idle.buttonLabel, 'Choose area');
  assert.equal(idle.cancelLabel, 'Cancel');
  assert.ok(idle.cancelAriaLabel.length > 0);
});

test('active area pick state shows the hint and pressed toggle', () => {
  const active = areaPickUiState(true, 'ready', true);
  assert.equal(active.pressed, true);
  assert.equal(active.hintVisible, true);
  assert.equal(active.hintText, AREA_PICK_HINT_TEXT);
  assert.equal(active.disabled, false);
});

test('area pick is disabled when no model is available', () => {
  const loading = areaPickUiState(false, 'loading', false);
  assert.equal(loading.disabled, true);
  const error = areaPickUiState(false, 'error', false);
  assert.equal(error.disabled, true);
});
