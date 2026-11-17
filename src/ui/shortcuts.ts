/**
 * Keyboard shortcut matching, kept pure so the map can be unit-tested and the
 * About dialog can render the same table the handler uses.
 *
 * Global shortcuts are deliberately suppressed whenever a button, link or
 * form control has focus: Space and Enter must keep their native activation
 * behaviour on controls, and arrow keys must keep adjusting sliders. Escape is
 * the exception — it is never swallowed by the focus guard so it can always
 * close the active panel/dialog, even from inside a text field.
 */

export type ShortcutAction =
  | 'toggle-play'
  | 'minute-back'
  | 'minute-forward'
  | 'hour-back'
  | 'hour-forward'
  | 'day-back'
  | 'day-forward'
  | 'today'
  | 'now'
  | 'search'
  | 'locate'
  | 'reset-camera'
  | 'about'
  | 'close';

export interface KeyInfo {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface ShortcutDefinition {
  id: ShortcutAction;
  keys: string;
  label: string;
}

/** Table shown in the About dialog. Kept in the same order as the handler. */
export const SHORTCUT_TABLE: readonly ShortcutDefinition[] = [
  { id: 'toggle-play', keys: 'Space', label: 'Play / pause the day (when the page, not a control, has focus)' },
  { id: 'minute-back', keys: '← ↓', label: 'Back 5 minutes' },
  { id: 'minute-forward', keys: '→ ↑', label: 'Forward 5 minutes' },
  { id: 'hour-back', keys: 'Shift + ← ↓', label: 'Back 1 hour' },
  { id: 'hour-forward', keys: 'Shift + → ↑', label: 'Forward 1 hour' },
  { id: 'day-back', keys: 'Page ↑', label: 'Previous day' },
  { id: 'day-forward', keys: 'Page ↓', label: 'Next day' },
  { id: 'today', keys: 'T', label: 'Jump to today' },
  { id: 'now', keys: 'N', label: 'Jump to the current time' },
  { id: 'search', keys: '/', label: 'Search for a city' },
  { id: 'locate', keys: 'L', label: 'Use my location' },
  { id: 'reset-camera', keys: 'R', label: 'Reset the camera' },
  { id: 'about', keys: '?', label: 'About Sunlight' },
  { id: 'close', keys: 'Esc', label: 'Close dialog / panel' }
];

/** Maps a keyboard event to an action, or null when the key is unbound. */
export function matchShortcut(event: KeyInfo): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const shift = event.shiftKey === true;
  switch (event.key) {
    case ' ':
    case 'Spacebar':
      return 'toggle-play';
    case 'ArrowLeft':
    case 'ArrowDown':
      return shift ? 'hour-back' : 'minute-back';
    case 'ArrowRight':
    case 'ArrowUp':
      return shift ? 'hour-forward' : 'minute-forward';
    case 'PageUp':
      return 'day-back';
    case 'PageDown':
      return 'day-forward';
    case 'Escape':
      return 'close';
    case '?':
      return 'about';
    case '/':
      return 'search';
    default:
      break;
  }
  const letter = event.key.length === 1 ? event.key.toLowerCase() : '';
  switch (letter) {
    case 't':
      return 'today';
    case 'n':
      return 'now';
    case 'r':
      return 'reset-camera';
    case 'l':
      return 'locate';
    default:
      return null;
  }
}

export interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
  getAttribute?: ((name: string) => string | null) | null;
}

const EDITABLE_TAGS = new Set(['input', 'textarea', 'select']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'combobox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab'
]);

/** True for shortcuts that should not fire while the user is typing. */
export function isEditableTarget(target: ShortcutTarget | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (EDITABLE_TAGS.has(tag)) return true;
  return target.isContentEditable === true;
}

/**
 * True when the event target is any focusable control (button, link, form
 * control, ARIA widget). Canvas/body focus is not interactive.
 */
export function isInteractiveTarget(target: ShortcutTarget | null | undefined): boolean {
  if (!target) return false;
  if (isEditableTarget(target)) return true;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'iframe') return true;
  if (tag === 'audio' || tag === 'video') return true;
  const role = (target.getAttribute?.('role') ?? '').toLowerCase();
  return INTERACTIVE_ROLES.has(role);
}

/**
 * Global shortcuts must not fire on a focused control; Escape is allowed
 * everywhere so panels can always be dismissed (also from a text field).
 */
export function shouldSuppressShortcut(
  action: ShortcutAction,
  target: ShortcutTarget | null | undefined
): boolean {
  if (action === 'close') return false;
  return isInteractiveTarget(target);
}

/** Backwards-compatible name: only typing targets block shortcuts. */
export function isShortcutBlocked(target: ShortcutTarget | null | undefined): boolean {
  return isEditableTarget(target);
}
