/**
 * Tiny DOM helpers shared by the UI modules.
 *
 * `createPatcher` is the workhorse: it caches the last value written to each
 * node/property so the 8 Hz state updates only touch the DOM when something
 * actually changed (no wholesale re-rendering, no layout reads).
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/** Query a required element; throws early when a template is out of sync. */
export function q<T extends Element = Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Sunlight UI: missing element "${selector}"`);
  return found;
}

export function qa<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Adds a listener and returns a disposer. */
export function on(
  target: EventTarget,
  type: string,
  handler: EventListener,
  options?: AddEventListenerOptions
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export interface Patcher {
  text(node: Node, value: string): void;
  attr(element: Element, name: string, value: string | number | null): void;
  cls(element: Element, name: string, active: boolean): void;
  style(element: HTMLElement | SVGElement, property: string, value: string): void;
  hidden(element: HTMLElement, value: boolean): void;
  disabled(element: Element, value: boolean): void;
  value(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void;
  cssVar(name: string, value: string): void;
  html(element: Element, value: string): void;
}

const TEXT_KEY = '\u0001text';

/** Cached property writer used by every UI module. */
export function createPatcher(root: HTMLElement = document.documentElement): Patcher {
  const attributes = new WeakMap<Element, Map<string, string>>();
  const values = new WeakMap<Element, string>();
  const cssValues = new Map<string, string>();

  function cacheFor(element: Element): Map<string, string> {
    let map = attributes.get(element);
    if (!map) {
      map = new Map();
      attributes.set(element, map);
    }
    return map;
  }

  function writeAttr(element: Element, name: string, value: string | null): void {
    const cache = cacheFor(element);
    if (cache.get(name) === (value ?? '\u0000removed')) return;
    cache.set(name, value ?? '\u0000removed');
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  return {
    text(node: Node, value: string): void {
      const cache = cacheFor(node as unknown as Element);
      if (cache.get(TEXT_KEY) === value) return;
      cache.set(TEXT_KEY, value);
      node.textContent = value;
    },

    attr(element: Element, name: string, value: string | number | null): void {
      writeAttr(element, name, value === null ? null : String(value));
    },

    cls(element: Element, name: string, active: boolean): void {
      const key = `class:${name}`;
      const cache = cacheFor(element);
      if (cache.get(key) === String(active)) return;
      cache.set(key, String(active));
      element.classList.toggle(name, active);
    },

    style(element: HTMLElement | SVGElement, property: string, value: string): void {
      const key = `style:${property}`;
      const cache = cacheFor(element);
      if (cache.get(key) === value) return;
      cache.set(key, value);
      element.style.setProperty(property, value);
    },

    hidden(element: HTMLElement, value: boolean): void {
      const key = 'hidden';
      const cache = cacheFor(element);
      if (cache.get(key) === String(value)) return;
      cache.set(key, String(value));
      element.hidden = value;
    },

    disabled(element: Element, value: boolean): void {
      if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        const key = 'disabled';
        const cache = cacheFor(element);
        if (cache.get(key) === String(value)) return;
        cache.set(key, String(value));
        element.disabled = value;
        return;
      }
      writeAttr(element, 'disabled', value ? '' : null);
      if (value) writeAttr(element, 'aria-disabled', 'true');
      else writeAttr(element, 'aria-disabled', null);
    },

    value(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
      const cache = cacheFor(element);
      if (cache.get('value') === value) return;
      cache.set('value', value);
      element.value = value;
    },

    cssVar(name: string, value: string): void {
      if (cssValues.get(name) === value) return;
      cssValues.set(name, value);
      root.style.setProperty(name, value);
    },

    html(element: Element, value: string): void {
      const cache = cacheFor(element);
      if (cache.get('html') === value) return;
      cache.set('html', value);
      element.innerHTML = value;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Focus management                                                    */
/* ------------------------------------------------------------------ */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

export function focusablesWithin(container: HTMLElement): HTMLElement[] {
  return qa<HTMLElement>(container, FOCUSABLE_SELECTOR).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

/** Keeps Tab / Shift+Tab cycling inside an open dialog. */
export function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = focusablesWithin(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

/** Focus an element without scrolling the page/panel. */
export function focusEl(target: HTMLElement | null | undefined): boolean {
  if (!target || !target.isConnected) return false;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  return document.activeElement === target;
}

/** First focusable descendant, or the container itself when it is focusable. */
export function firstFocusable(container: HTMLElement): HTMLElement | null {
  const list = focusablesWithin(container);
  return list.length > 0 ? list[0] : null;
}

/**
 * True when focus currently sits on the document body (or nowhere), i.e. the
 * user is in the "canvas context" where global shortcuts are allowed to fire.
 */
export function isBodyFocus(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

/** Sets/clears the native `inert` attribute. */
export function setInert(element: HTMLElement | null | undefined, inert: boolean): void {
  if (!element) return;
  element.inert = inert;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function localStore(): Storage | null {
  try {
    const storage = window.localStorage;
    const probe = '__sunlight_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
