import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AREA_HELP_TEXT,
  AREA_SHEET_MAX_HEIGHT,
  AREA_SHEET_MAX_WIDTH,
  areaCanvasLabel,
  areaPanelMode,
  areaStatusText,
  focusAreaTitle,
  loadAreaTitle
} from '../../src/ui/minimap.ts';

test('the area picker switches to a sheet before the time console can cover it', () => {
  // Wide desktop stays a non-modal panel.
  assert.equal(areaPanelMode(1440, 900), 'panel');
  assert.equal(areaPanelMode(1366, 768), 'panel');
  assert.equal(areaPanelMode(1181, 768), 'panel');
  // 200 % zoom, laptop widths and short windows become a modal sheet.
  assert.equal(areaPanelMode(720, 450), 'sheet');
  assert.equal(areaPanelMode(1024, 768), 'sheet');
  assert.equal(areaPanelMode(768, 1024), 'sheet');
  assert.equal(areaPanelMode(390, 844), 'sheet');
  assert.equal(areaPanelMode(844, 390), 'sheet');
  // Exactly at the thresholds the safe layout wins.
  assert.equal(areaPanelMode(AREA_SHEET_MAX_WIDTH, 900), 'sheet');
  assert.equal(areaPanelMode(1440, AREA_SHEET_MAX_HEIGHT), 'sheet');
});

test('area status names the loaded-city vs outside case', () => {
  const inside = areaStatusText(true);
  const outside = areaStatusText(false);
  assert.match(inside, /Within the loaded city/);
  assert.match(inside, /Focus/);
  assert.match(outside, /Outside the loaded city/);
  assert.match(outside, /Load area/);
  assert.notEqual(inside, outside);
});

test('canvas label includes the window size and keyboard instructions', () => {
  const label = areaCanvasLabel(750, true);
  assert.match(label, /750 m radius/);
  assert.match(label, /1\.5 × 1\.5 km/);
  assert.match(label, /inside the loaded city/);
  assert.match(label, /arrow keys/);
  assert.match(areaCanvasLabel(100, false), /outside the loaded city/);
});

test('load/focus explanations flip with the loaded-model context', () => {
  assert.match(loadAreaTitle(true), /already inside the loaded city/);
  assert.match(loadAreaTitle(true), /Focus/);
  assert.match(loadAreaTitle(false), /Build/);
  assert.match(focusAreaTitle(true), /Frame/);
  assert.match(focusAreaTitle(false), /Load area/);
  assert.match(AREA_HELP_TEXT, /Focus frames the square/);
  assert.match(AREA_HELP_TEXT, /Load area rebuilds the city/);
});
