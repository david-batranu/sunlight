/**
 * Keyboard shortcut matching, kept pure so the map can be unit-tested and the
 * About dialog can render the same table the handler uses.
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
  { id: 'toggle-play', keys: 'Space', label: 'Play / pause the day' },
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

/** True for shortcuts that should not fire while the user is typing. */
export function isShortcutBlocked(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable === true;
}
