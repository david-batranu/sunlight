import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentLight } from '../../src/app/contracts.ts';
import { moodForAltitude, paletteForAltitude, resolveBackdrop } from '../../src/ui/backdrop.ts';

const light = (sunAlt: number, sunAz: number, moonAlt = -20, moonAz = 0): CurrentLight => ({
  sunAlt,
  sunAz,
  moonAlt,
  moonAz
});

test('mood thresholds split day / golden / twilight / night', () => {
  assert.equal(moodForAltitude(45), 'day');
  assert.equal(moodForAltitude(6), 'day');
  assert.equal(moodForAltitude(5.9), 'golden');
  assert.equal(moodForAltitude(0), 'golden');
  assert.equal(moodForAltitude(-6), 'golden');
  assert.equal(moodForAltitude(-6.1), 'twilight');
  assert.equal(moodForAltitude(-12), 'twilight');
  assert.equal(moodForAltitude(-12.1), 'night');
  assert.equal(moodForAltitude(-40), 'night');
});

test('palette interpolation returns valid CSS colours and star coverage', () => {
  const day = paletteForAltitude(45);
  assert.match(day.top, /^rgb\(\d+, \d+, \d+\)$/);
  assert.match(day.horizon, /^rgb\(/);
  assert.equal(day.stars, 0);
  assert.ok(day.glowAlpha >= 0 && day.glowAlpha <= 1);

  const night = paletteForAltitude(-30);
  assert.equal(night.stars, 1);
  assert.match(night.base, /^rgb\(/);

  const golden = paletteForAltitude(1);
  assert.ok(golden.stars > 0 && golden.stars < 0.2);
});

test('backdrop css variables describe a day sky', () => {
  const backdrop = resolveBackdrop(light(42, 180), null, 720);
  assert.equal(backdrop.mood, 'day');
  assert.equal(backdrop.label, 'Daylight');
  assert.equal(backdrop.vars['--stars-alpha'], '0.00');
  assert.match(backdrop.vars['--sky-top'], /^rgb\(/);
  assert.match(backdrop.vars['--sky-glow-rgb'], /^\d+, \d+, \d+$/);
  assert.match(backdrop.vars['--sky-glow-x'], /%$/);
  assert.match(backdrop.vars['--sky-glow-y'], /%$/);
  assert.ok(Number(backdrop.vars['--sky-glow-alpha']) > 0);
});

test('backdrop follows the sun azimuth for the glow position', () => {
  const east = resolveBackdrop(light(20, 90), null, 480);
  const west = resolveBackdrop(light(20, 270), null, 960);
  assert.ok(Number.parseFloat(east.vars['--sky-glow-x']) > 50);
  assert.ok(Number.parseFloat(west.vars['--sky-glow-x']) < 50);
});

test('night backdrop brings out the stars and follows the moon when it is up', () => {
  const dark = resolveBackdrop(light(-25, 340, -25, 0), null, 60);
  assert.equal(dark.mood, 'night');
  assert.equal(dark.vars['--stars-alpha'], '1.00');

  const moonlit = resolveBackdrop(light(-25, 340, 35, 120), null, 60);
  assert.equal(moonlit.mood, 'night');
  assert.ok(Number.parseFloat(moonlit.vars['--sky-glow-x']) > 50);
});

test('missing light falls back to a neutral daytime backdrop', () => {
  const backdrop = resolveBackdrop(null, null, 0);
  assert.equal(backdrop.mood, 'day');
  assert.equal(backdrop.vars['--stars-alpha'], '0.00');
  assert.match(backdrop.vars['--sky-base'], /^rgb\(/);
});
