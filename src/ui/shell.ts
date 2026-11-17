/**
 * Sunlight UI shell. Composes the top bar, time console, light panel, dialogs
 * and overlays, drives the CSS sky backdrop and owns the keyboard shortcuts.
 *
 * The shell renders exclusively from `AppState` (received through `update`) and
 * calls `ctx.actions` / `ctx.searchCities`; it never fetches and never imports
 * Three.js or scene code.
 */

import type { AppState } from '../app/state.ts';
import type { UIHandle, UIContext } from '../app/contracts.ts';
import { interpolateSky } from '../app/time.ts';
import type { CurrentLight } from '../app/contracts.ts';
import { resolveBackdrop } from './backdrop.ts';
import type { Mood } from './format.ts';
import { createErrorCard, createNotices, createProgressOverlay } from './overlays.ts';
import { createAboutDialog, type AboutDialogHandle } from './about.ts';
import { createLightPanel, type LightPanelHandle } from './light-panel.ts';
import { createSearchDialog, type SearchDialogHandle } from './search.ts';
import { createTimeConsole, type TimeConsoleHandle } from './time-console.ts';
import { createTopBar, type TopBarHandle } from './topbar.ts';
import { createCompass, type CompassHandle } from './compass.ts';
import { createFeatureTooltip, type FeatureTooltipHandle } from './tooltip.ts';
import { createAreaPickHint, type AreaPickHandle } from './area-pick.ts';
import { createDetailMinimap, type DetailMinimapHandle } from './minimap.ts';
import { createPatcher, el, on } from './dom.ts';
import { isShortcutBlocked, matchShortcut } from './shortcuts.ts';

export function createUI(root: HTMLElement, ctx: UIContext): UIHandle {
  const patcher = createPatcher(document.documentElement);
  const app = el('div', 'sl-app');
  app.dataset.phase = 'boot';
  app.dataset.mood = 'day';
  root.replaceChildren(app);

  let search: SearchDialogHandle | null = null;
  let about: AboutDialogHandle | null = null;
  let timeConsole: TimeConsoleHandle | null = null;
  let lightPanel: LightPanelHandle | null = null;

  function openSearch(): void {
    search?.open();
  }

  function openAbout(): void {
    about?.open();
  }

  function toggleLight(): void {
    lightPanel?.toggle();
  }

  function syncDialogAttribute(): void {
    if (search?.isOpen()) app.dataset.dialog = 'search';
    else if (about?.isOpen()) app.dataset.dialog = 'about';
    else delete app.dataset.dialog;
  }

  /* ------------------------------------------------------------------ */
  /* Chrome                                                             */
  /* ------------------------------------------------------------------ */

  const topbar: TopBarHandle = createTopBar(ctx, {
    onOpenSearch: openSearch,
    onOpenAbout: openAbout
  });

  const compass: CompassHandle = createCompass(ctx);
  const tooltip: FeatureTooltipHandle = createFeatureTooltip(ctx);
  const areaPick: AreaPickHandle = createAreaPickHint(ctx);
  const detailMinimap: DetailMinimapHandle = createDetailMinimap(ctx);

  const progress = createProgressOverlay(ctx, () => openSearch());
  const errorCard = createErrorCard(ctx, { onSearch: () => openSearch() });
  const notices = createNotices(ctx);

  lightPanel = createLightPanel({
    onOpenChange(open: boolean): void {
      app.dataset.light = open ? 'open' : 'closed';
      timeConsole?.setLightOpen(open);
    }
  });

  timeConsole = createTimeConsole(ctx, { onToggleLight: toggleLight });
  timeConsole.setLightOpen(lightPanel.isOpen());

  search = createSearchDialog(ctx, {
    onOpenChange(open: boolean): void {
      topbar.setSearchOpen(open);
      syncDialogAttribute();
    }
  });

  about = createAboutDialog(ctx, {
    onOpenChange(): void {
      syncDialogAttribute();
    }
  });

  app.append(
    topbar.element,
    compass.element,
    detailMinimap.element,
    lightPanel.element,
    lightPanel.scrim,
    timeConsole.element,
    tooltip.element,
    areaPick.element,
    notices.element,
    progress.element,
    errorCard.element,
    search.element,
    about.element
  );

  /* ------------------------------------------------------------------ */
  /* Keyboard shortcuts                                                 */
  /* ------------------------------------------------------------------ */

  function runAction(action: ReturnType<typeof matchShortcut>): void {
    switch (action) {
      case 'toggle-play':
        ctx.actions.togglePlay();
        break;
      case 'minute-back':
        ctx.actions.stepMinutes(-5);
        break;
      case 'minute-forward':
        ctx.actions.stepMinutes(5);
        break;
      case 'hour-back':
        ctx.actions.stepMinutes(-60);
        break;
      case 'hour-forward':
        ctx.actions.stepMinutes(60);
        break;
      case 'day-back':
        ctx.actions.stepDay(-1);
        break;
      case 'day-forward':
        ctx.actions.stepDay(1);
        break;
      case 'today':
        ctx.actions.goToday();
        break;
      case 'now':
        ctx.actions.setNow();
        break;
      case 'search':
        openSearch();
        break;
      case 'locate':
        void ctx.actions.locate();
        break;
      case 'reset-camera':
        ctx.actions.resetCamera();
        break;
      case 'about':
        openAbout();
        break;
      default:
        break;
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (search?.isOpen() || about?.isOpen()) return;
    if (isShortcutBlocked(event.target as HTMLElement | null)) return;
    const action = matchShortcut(event);
    if (!action) return;
    if (action === 'close') {
      const state = ctx.store.getState();
      if (state.detailPanelOpen) {
        event.preventDefault();
        ctx.actions.closeDetailPanel();
        return;
      }
      if (state.pickingArea) {
        event.preventDefault();
        ctx.actions.cancelAreaPick();
        return;
      }
      if (state.hover) {
        event.preventDefault();
        ctx.actions.dismissHover();
        return;
      }
      const panelOpen = lightPanel?.isOpen() ?? false;
      if (panelOpen && window.matchMedia('(max-width: 680px)').matches) {
        event.preventDefault();
        lightPanel?.close();
      }
      return;
    }
    event.preventDefault();
    runAction(action);
  };
  const disposeKeyboard = on(document, 'keydown', onKeyDown as EventListener);

  /* ------------------------------------------------------------------ */
  /* State rendering                                                    */
  /* ------------------------------------------------------------------ */

  let destroyed = false;
  let lastPhase = '';
  let lastMood = '';

  function resolveLight(state: AppState): CurrentLight | null {
    if (state.current) return state.current;
    return interpolateSky(state.sky, state.minute);
  }

  function applyBackdrop(state: AppState, light: CurrentLight | null): Mood {
    const backdrop = resolveBackdrop(light, state.sky, state.minute);
    for (const [name, value] of Object.entries(backdrop.vars)) patcher.cssVar(name, value);
    if (backdrop.mood !== lastMood) {
      lastMood = backdrop.mood;
      document.body.dataset.mood = backdrop.mood;
      app.dataset.mood = backdrop.mood;
    }
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      document.body.dataset.phase = state.phase;
      app.dataset.phase = state.phase;
    }
    return backdrop.mood;
  }

  function update(state: AppState): void {
    if (destroyed) return;
    const light = resolveLight(state);
    const mood = applyBackdrop(state, light);
    app.dataset.playing = state.playing ? 'true' : 'false';
    app.dataset.loading = state.phase === 'ready' ? 'false' : 'true';
    app.dataset.picking = state.pickingArea ? 'true' : 'false';
    document.body.dataset.picking = state.pickingArea ? 'true' : 'false';

    topbar.update(state);
    compass.update(state);
    detailMinimap.update(state);
    tooltip.update(state);
    areaPick.update(state);
    timeConsole?.update(state, light);
    lightPanel?.update(state, light, mood);
    progress.update(state);
    errorCard.update(state);
    notices.update(state);
    search?.update(state);
    about?.update(state);
  }

  return {
    update,
    destroy(): void {
      destroyed = true;
      disposeKeyboard();
      topbar.destroy();
      compass.destroy();
      detailMinimap.destroy();
      tooltip.destroy();
      areaPick.destroy();
      timeConsole?.destroy();
      lightPanel?.destroy();
      search?.destroy();
      about?.destroy();
      progress.destroy();
      errorCard.destroy();
      notices.destroy();
      root.replaceChildren();
      delete document.body.dataset.phase;
      delete document.body.dataset.mood;
      delete document.body.dataset.picking;
      delete app.dataset.phase;
      delete app.dataset.mood;
      delete app.dataset.picking;
    }
  };
}
