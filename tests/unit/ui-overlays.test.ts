import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTICE_AUTO_DISMISS_MS, presentError } from '../../src/ui/overlays.ts';

const err = (code: string, message = 'internal text', retryable?: boolean) => ({ code, message, retryable });

test('notices auto-dismiss after a bounded delay', () => {
  assert.ok(Number.isFinite(NOTICE_AUTO_DISMISS_MS));
  assert.ok(NOTICE_AUTO_DISMISS_MS >= 4000, 'notices must stay long enough to read');
  assert.ok(NOTICE_AUTO_DISMISS_MS <= 10000, 'notices must not pile up forever');
});

test('user-facing error copy never shows raw server messages', () => {
  const cases: Array<[string, string]> = [
    ['SEED_UNAVAILABLE', 'available on this server'],
    ['NO_DATA', 'mapped data'],
    ['CITY_NOT_FOUND', 'atlas'],
    ['NETWORK', 'server'],
    ['CANCELLED', 'stopped'],
    ['MODEL_FAILED', 'built'],
    ['INTERNAL', 'Something went wrong'],
    ['MODEL_VERSION_MISMATCH', 'out of sync']
  ];
  for (const [code, needle] of cases) {
    const view = presentError(err(code, 'raw provider detail: 403 from overpass'));
    assert.equal(view.details.includes('raw provider detail'), true, `${code} keeps raw text behind details`);
    assert.equal(view.details.startsWith(code), true, `${code} details start with the code`);
    assert.equal(view.message.includes('raw provider detail'), false, `${code} message hides raw text`);
    assert.equal(view.message.includes(code), false, `${code} message hides the raw code`);
    assert.match(view.message, new RegExp(needle, 'i'), `${code} message is user language`);
    assert.ok(view.hint.length > 10, `${code} hint suggests a next step`);
  }
});

test('unknown errors fall back to generic copy with details kept', () => {
  const view = presentError(err('WEIRD_BACKEND_CODE', 'stack trace line 1'));
  assert.equal(view.message, "This city couldn't be opened.");
  assert.match(view.hint, /ready-made city/);
  assert.match(view.details, /WEIRD_BACKEND_CODE/);
  assert.match(view.details, /stack trace line 1/);
});

test('retryability follows the server verdict', () => {
  assert.equal(presentError(err('NETWORK', 'down')).retryable, true);
  assert.equal(presentError(err('SEED_UNAVAILABLE', 'no seed', false)).retryable, false);
  assert.equal(presentError(err('MODEL_FAILED', 'boom', true)).retryable, true);
});
