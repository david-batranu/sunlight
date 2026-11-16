import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardinalLabelPosition,
  compassDirection,
  compassRotation,
  normalizeAngle,
  viewFromLabel
} from '../../src/ui/compass.ts';

test('angles normalize into [0, 360)', () => {
  assert.equal(normalizeAngle(0), 0);
  assert.equal(normalizeAngle(359), 359);
  assert.equal(normalizeAngle(360), 0);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(725), 5);
  assert.equal(normalizeAngle(Number.NaN), 0);
});

test('compass rotation follows (180 - azimuth) modulo 360', () => {
  const cases: Array<[number, number]> = [
    [45, 135],
    [0, 180],
    [90, 90],
    [180, 0],
    [270, 270],
    [360, 180],
    [-45, 225],
    [725, 175]
  ];
  for (const [azimuth, expected] of cases) {
    assert.equal(compassRotation(azimuth), expected, `azimuth ${azimuth}`);
    assert.equal(compassRotation(azimuth), ((180 - azimuth) % 360 + 360) % 360);
  }
});

test('compass direction uses the 16-wind rose', () => {
  assert.equal(compassDirection(0), 'N');
  assert.equal(compassDirection(22.5), 'NNE');
  assert.equal(compassDirection(45), 'NE');
  assert.equal(compassDirection(90), 'E');
  assert.equal(compassDirection(135), 'SE');
  assert.equal(compassDirection(180), 'S');
  assert.equal(compassDirection(225), 'SW');
  assert.equal(compassDirection(270), 'W');
  assert.equal(compassDirection(315), 'NW');
  assert.equal(compassDirection(350), 'N');
  assert.equal(viewFromLabel(135), 'View from SE');
  assert.equal(viewFromLabel(-45), 'View from NW');
});

test('cardinal labels orbit the rotating rose', () => {
  assert.deepEqual(cardinalLabelPosition(0, 0), { x: 48, y: 22 });
  assert.deepEqual(cardinalLabelPosition(1, 0), { x: 74, y: 48 });
  assert.deepEqual(cardinalLabelPosition(2, 0), { x: 48, y: 74 });
  assert.deepEqual(cardinalLabelPosition(3, 0), { x: 22, y: 48 });
  assert.deepEqual(cardinalLabelPosition(0, 90), { x: 74, y: 48 });
  assert.deepEqual(cardinalLabelPosition(0, 180), { x: 48, y: 74 });
  assert.deepEqual(cardinalLabelPosition(0, 270), { x: 22, y: 48 });
});
