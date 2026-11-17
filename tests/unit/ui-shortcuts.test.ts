import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHORTCUT_TABLE,
  isEditableTarget,
  isInteractiveTarget,
  isShortcutBlocked,
  matchShortcut,
  shouldSuppressShortcut,
  type KeyInfo,
  type ShortcutTarget
} from '../../src/ui/shortcuts.ts';

const key = (value: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({ key: value, ...extra });

test('playback and time-travel shortcuts', () => {
  assert.equal(matchShortcut(key(' ')), 'toggle-play');
  assert.equal(matchShortcut(key('ArrowLeft')), 'minute-back');
  assert.equal(matchShortcut(key('ArrowRight')), 'minute-forward');
  assert.equal(matchShortcut(key('ArrowUp')), 'minute-forward');
  assert.equal(matchShortcut(key('ArrowDown')), 'minute-back');
  assert.equal(matchShortcut(key('ArrowLeft', { shiftKey: true })), 'hour-back');
  assert.equal(matchShortcut(key('ArrowUp', { shiftKey: true })), 'hour-forward');
  assert.equal(matchShortcut(key('PageUp')), 'day-back');
  assert.equal(matchShortcut(key('PageDown')), 'day-forward');
  assert.equal(matchShortcut(key('t')), 'today');
  assert.equal(matchShortcut(key('N')), 'now');
  assert.equal(matchShortcut(key('r')), 'reset-camera');
});

test('dialog and city shortcuts', () => {
  assert.equal(matchShortcut(key('/')), 'search');
  assert.equal(matchShortcut(key('?', { shiftKey: true })), 'about');
  assert.equal(matchShortcut(key('Escape')), 'close');
  assert.equal(matchShortcut(key('l')), 'locate');
});

test('modified keys and unknown keys are left to the browser', () => {
  assert.equal(matchShortcut(key('r', { metaKey: true })), null);
  assert.equal(matchShortcut(key('t', { ctrlKey: true })), null);
  assert.equal(matchShortcut(key('ArrowLeft', { altKey: true })), null);
  assert.equal(matchShortcut(key('x')), null);
  assert.equal(matchShortcut(key('F5')), null);
  assert.equal(matchShortcut(key('Shift')), null);
});

test('shortcut table documents every handled action', () => {
  const ids = SHORTCUT_TABLE.map((entry) => entry.id);
  assert.ok(ids.includes('toggle-play'));
  assert.ok(ids.includes('search'));
  assert.ok(ids.includes('close'));
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of SHORTCUT_TABLE) {
    assert.ok(entry.keys.length > 0);
    assert.ok(entry.label.length > 0);
  }
});

test('editable targets block global shortcuts', () => {
  assert.equal(isShortcutBlocked({ tagName: 'INPUT' }), true);
  assert.equal(isShortcutBlocked({ tagName: 'textarea' }), true);
  assert.equal(isShortcutBlocked({ tagName: 'SELECT' }), true);
  assert.equal(isShortcutBlocked({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isShortcutBlocked({ tagName: 'BUTTON' }), false);
  assert.equal(isShortcutBlocked(null), false);
});

const target = (tagName: string, extra: Partial<ShortcutTarget> = {}): ShortcutTarget => ({
  tagName,
  ...extra
});

test('interactive targets are detected for buttons, links and ARIA widgets', () => {
  assert.equal(isInteractiveTarget(target('BUTTON')), true);
  assert.equal(isInteractiveTarget(target('A')), true);
  assert.equal(isInteractiveTarget(target('SUMMARY')), true);
  assert.equal(isInteractiveTarget(target('INPUT')), true);
  assert.equal(isInteractiveTarget(target('SELECT')), true);
  assert.equal(isInteractiveTarget(target('TEXTAREA')), true);
  assert.equal(
    isInteractiveTarget(target('DIV', { getAttribute: (name) => (name === 'role' ? 'slider' : null) })),
    true
  );
  assert.equal(
    isInteractiveTarget(target('DIV', { getAttribute: (name) => (name === 'role' ? 'presentation' : null) })),
    false
  );
  assert.equal(isInteractiveTarget(target('CANVAS')), false);
  assert.equal(isInteractiveTarget(target('BODY')), false);
  assert.equal(isInteractiveTarget(null), false);
});

test('global shortcuts are suppressed on controls but Escape always works', () => {
  assert.equal(shouldSuppressShortcut('toggle-play', target('BUTTON')), true);
  assert.equal(shouldSuppressShortcut('minute-forward', target('BUTTON')), true);
  assert.equal(shouldSuppressShortcut('toggle-play', target('CANVAS')), false);
  assert.equal(shouldSuppressShortcut('toggle-play', target('BODY')), false);
  assert.equal(shouldSuppressShortcut('toggle-play', null), false);
  assert.equal(shouldSuppressShortcut('close', target('BUTTON')), false);
  assert.equal(shouldSuppressShortcut('close', target('INPUT')), false);
  assert.equal(shouldSuppressShortcut('search', target('INPUT')), true);
  assert.equal(isEditableTarget(target('BUTTON')), false);
});
