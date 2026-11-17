/**
 * Light panel: sun-path compass, sun/moon readouts, shadow multiplier and the
 * model/attribution footer. Collapses to a drawer on tablets and to a bottom
 * sheet on phones.
 */

import type { AppState } from '../app/state.ts';
import type { InterpolatedLight } from '../app/time.ts';
import {
  formatDuration,
  formatInstant,
  formatUtcOffset,
  sunLightLabel
} from '../app/time.ts';
import type { SkyDay } from '../../shared/types.ts';
import {
  SUN_PATH_CONFIG,
  buildTrackPaths,
  horizonMarkers,
  projectSkyPoint
} from './sunpath.ts';
import {
  formatAltitude,
  formatAzimuth,
  formatCoords,
  formatCount,
  formatIllumination,
  formatShadowMultiplier,
  sourceLabel
} from './format.ts';
import type { Mood } from './format.ts';
import { createPatcher, el, focusEl, on, q, trapFocus } from './dom.ts';
import { icon, moonPhaseIcon } from './icons.ts';

export interface LightPanelCallbacks {
  onOpenChange(open: boolean): void;
}

export interface LightPanelHandle {
  element: HTMLElement;
  /** Dims the scene behind the phone bottom sheet. */
  scrim: HTMLElement;
  update(state: AppState, light: InterpolatedLight | null, mood: Mood): void;
  toggle(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const CARDINALS = [
  { label: 'N', x: 120, y: 22 },
  { label: 'E', x: 224, y: 124 },
  { label: 'S', x: 120, y: 234 },
  { label: 'W', x: 16, y: 124 }
] as const;

function svgGradientDefs(): string {
  return `
    <defs>
      <radialGradient id="sl-sunpath-sky" cx="50%" cy="88%" r="82%">
        <stop offset="0" stop-color="#2e476b"/>
        <stop offset="1" stop-color="#0c1524"/>
      </radialGradient>
      <linearGradient id="sl-sunpath-arc" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#e2a13b"/>
        <stop offset="0.58" stop-color="#f4c56f"/>
        <stop offset="1" stop-color="#fff0c9"/>
      </linearGradient>
    </defs>
  `;
}

function compassSvg(): string {
  const spokes: string[] = [];
  for (let angle = 0; angle < 360; angle += 45) {
    const point = projectSkyPoint(0, angle);
    spokes.push(`<line x1="120" y1="120" x2="${point.x}" y2="${point.y}"/>`);
  }
  return `
    <svg class="sl-sunpath" data-testid="sun-path" viewBox="0 0 240 240" role="img" aria-label="Sun path around the horizon">
      <title>Sun and moon path for the selected date</title>
      ${svgGradientDefs()}
      <circle class="sl-sunpath-disc" cx="120" cy="120" r="112"/>
      <circle class="sl-sunpath-ground" cx="120" cy="120" r="98"/>
      <circle class="sl-sunpath-horizon" cx="120" cy="120" r="84"/>
      <g class="sl-sunpath-grid">
        <circle cx="120" cy="120" r="28"/>
        <circle cx="120" cy="120" r="56"/>
        ${spokes.join('')}
      </g>
      <g class="sl-sunpath-cardinals">
        ${CARDINALS.map((cardinal) => `<text x="${cardinal.x}" y="${cardinal.y}">${cardinal.label}</text>`).join('')}
      </g>
      <path class="sl-sunpath-moon" d=""/>
      <path class="sl-sunpath-sun-below" d=""/>
      <path class="sl-sunpath-sun-above" d=""/>
      <g class="sl-sunpath-rise-set">
        <circle class="sl-sunpath-rs sl-sunpath-rs--rise" r="3.2" cx="120" cy="36"/>
        <circle class="sl-sunpath-rs sl-sunpath-rs--set" r="3.2" cx="120" cy="36"/>
      </g>
      <g class="sl-sunpath-axis"><line x1="120" y1="120" x2="120" y2="120"/></g>
      <circle class="sl-sunpath-halo" r="10" cx="120" cy="120"/>
      <circle class="sl-sunpath-sun" r="5" cx="120" cy="120"/>
      <circle class="sl-sunpath-moon-dot" r="3.4" cx="120" cy="120"/>
      <circle class="sl-sunpath-center" r="1.7" cx="120" cy="120"/>
    </svg>
  `;
}

function stat(label: string, testId: string, wide = false): string {
  return `<div class="sl-stat${wide ? ' sl-stat--wide' : ''}"><dt>${label}</dt><dd data-testid="${testId}">—</dd></div>`;
}

export function createLightPanel(callbacks: LightPanelCallbacks): LightPanelHandle {
  const patcher = createPatcher();
  const element = el(
    'aside',
    'sl-panel sl-light',
    `
    <header class="sl-panel-head sl-light-head">
      <div class="sl-light-title">
        <span class="sl-eyebrow">Light</span>
        <span class="sl-phase-icon" data-testid="phase-icon" aria-hidden="true"></span>
        <span class="sl-light-label" data-testid="light-label">—</span>
      </div>
      <button class="sl-icon-btn sl-light-collapse" type="button" data-testid="light-collapse" aria-expanded="true" aria-controls="sl-light-body" aria-label="Collapse the light panel">
        <span class="sl-light-collapse-chevron">${icon('chevron')}</span>
        <span class="sl-light-collapse-x">${icon('close')}</span>
      </button>
    </header>
    <div class="sl-light-body" id="sl-light-body">
      <div class="sl-sunpath-wrap">
        ${compassSvg()}
        <span class="sl-compass-caption">Sun path · selected day</span>
      </div>
      <div class="sl-polar-flag" data-testid="polar-flag" hidden></div>
      <dl class="sl-readouts">
        ${stat('Sun altitude', 'sun-altitude')}
        ${stat('Sun azimuth', 'sun-azimuth')}
        ${stat('Shadows', 'shadow-ratio')}
        ${stat('Sunlight', 'light-quality-detail')}
        ${stat('Sunrise', 'sunrise-readout')}
        ${stat('Sunset', 'sunset-readout')}
        ${stat('Golden hour AM', 'golden-am')}
        ${stat('Golden hour PM', 'golden-pm')}
        ${stat('Day length', 'day-length')}
        ${stat('UTC offset', 'utc-offset')}
        <div class="sl-stat sl-stat--wide">
          <dt>Moon</dt>
          <dd data-testid="moon-phase"><span class="sl-moon-phase-glyph"></span><span class="sl-moon-phase-text">—</span></dd>
        </div>
        ${stat('Moonrise', 'moonrise-readout')}
        ${stat('Moonset', 'moonset-readout')}
        <div class="sl-stat sl-stat--wide"><dt>Coordinates</dt><dd data-testid="coords">—</dd></div>
      </dl>
      <footer class="sl-light-foot">
        <p class="sl-model-line" data-testid="model-meta">No model loaded yet.</p>
        <p class="sl-model-source" data-testid="model-source"></p>
        <button class="sl-named-toggle" type="button" data-testid="named-toggle" aria-expanded="false" aria-controls="sl-named-panel">
          Named places <span class="sl-named-count" data-testid="named-count">0</span>
        </button>
        <div class="sl-named-panel" id="sl-named-panel" data-testid="named-panel" hidden>
          <label class="sl-sr-only" for="sl-named-filter">Filter named places</label>
          <input class="sl-named-filter" id="sl-named-filter" data-testid="named-filter" type="search" placeholder="Filter named places…" autocomplete="off" />
          <p class="sl-named-note" data-testid="named-note">Names from the loaded model, readable without the map.</p>
          <ul class="sl-named-list" data-testid="named-list"></ul>
        </div>
      </footer>
    </div>
    <div class="sl-light-foot-actions">
      <button class="sl-btn sl-btn--quiet sl-light-close-phone" type="button" data-testid="light-close">Close</button>
    </div>
  `
  );

  element.dataset.testid = 'light-panel';
  element.setAttribute('aria-label', 'Sun and moon light');

  const scrim = el('div', 'sl-sheet-scrim');
  scrim.hidden = true;

  const phaseIcon = q<HTMLElement>(element, '[data-testid="phase-icon"]');
  const lightLabel = q<HTMLElement>(element, '[data-testid="light-label"]');
  const collapseButton = q<HTMLButtonElement>(element, '[data-testid="light-collapse"]');
  const closePhoneButton = q<HTMLButtonElement>(element, '[data-testid="light-close"]');
  const svg = q<SVGSVGElement>(element, '[data-testid="sun-path"]');
  const sunAbove = q<SVGPathElement>(svg, '.sl-sunpath-sun-above');
  const sunBelow = q<SVGPathElement>(svg, '.sl-sunpath-sun-below');
  const moonPath = q<SVGPathElement>(svg, '.sl-sunpath-moon');
  const riseMarker = q<SVGCircleElement>(svg, '.sl-sunpath-rs--rise');
  const setMarker = q<SVGCircleElement>(svg, '.sl-sunpath-rs--set');
  const sunDot = q<SVGCircleElement>(svg, '.sl-sunpath-sun');
  const sunHalo = q<SVGCircleElement>(svg, '.sl-sunpath-halo');
  const moonDot = q<SVGCircleElement>(svg, '.sl-sunpath-moon-dot');
  const axis = q<SVGLineElement>(svg, '.sl-sunpath-axis line');
  const polarFlag = q<HTMLElement>(element, '[data-testid="polar-flag"]');
  const moonPhase = q<HTMLElement>(element, '[data-testid="moon-phase"]');
  const moonGlyph = q<HTMLElement>(moonPhase, '.sl-moon-phase-glyph');
  const moonText = q<HTMLElement>(moonPhase, '.sl-moon-phase-text');
  const modelMeta = q<HTMLElement>(element, '[data-testid="model-meta"]');
  const modelSource = q<HTMLElement>(element, '[data-testid="model-source"]');
  const namedToggle = q<HTMLButtonElement>(element, '[data-testid="named-toggle"]');
  const namedCount = q<HTMLElement>(element, '[data-testid="named-count"]');
  const namedPanel = q<HTMLElement>(element, '[data-testid="named-panel"]');
  const namedFilter = q<HTMLInputElement>(element, '[data-testid="named-filter"]');
  const namedNote = q<HTMLElement>(element, '[data-testid="named-note"]');
  const namedList = q<HTMLElement>(element, '[data-testid="named-list"]');
  let namedOpen = false;
  let namedModelKey: string | null = null;
  let namedEntries: Array<{ name: string; kind: string; detail: string }> = [];
  const readout = (id: string): HTMLElement => q<HTMLElement>(element, `[data-testid="${id}"]`);

  const shadowLabel = ((): HTMLElement | null => {
    const stat = readout('shadow-ratio').closest('.sl-stat');
    return stat ? stat.querySelector('dt') : null;
  })();

  const values = {
    sunAltitude: readout('sun-altitude'),
    sunAzimuth: readout('sun-azimuth'),
    shadow: readout('shadow-ratio'),
    sunlight: readout('light-quality-detail'),
    sunrise: readout('sunrise-readout'),
    sunset: readout('sunset-readout'),
    goldenAm: readout('golden-am'),
    goldenPm: readout('golden-pm'),
    dayLength: readout('day-length'),
    utcOffset: readout('utc-offset'),
    moonrise: readout('moonrise-readout'),
    moonset: readout('moonset-readout'),
    coords: readout('coords')
  };

  /* ---------------------------------------------------------------- */
  /* Responsive open / collapsed state                                */
  /* ---------------------------------------------------------------- */

  const phoneQuery = window.matchMedia('(max-width: 680px)');
  const compactQuery = window.matchMedia('(max-width: 980px)');

  let open = !compactQuery.matches;
  let collapsed = compactQuery.matches;
  let previousFocus: HTMLElement | null = null;
  let sheetWasOpen = false;

  function isPhone(): boolean {
    return phoneQuery.matches;
  }

  function isSheetOpen(): boolean {
    return isPhone() && open && !collapsed;
  }

  function restoreSheetFocus(): void {
    const target =
      previousFocus && previousFocus.isConnected
        ? previousFocus
        : element.ownerDocument.querySelector<HTMLElement>('[data-testid="light-toggle"]');
    previousFocus = null;
    focusEl(target);
  }

  function syncAttributes(): void {
    const phone = isPhone();
    const sheetOpen = isSheetOpen();
    element.dataset.open = open ? 'true' : 'false';
    element.dataset.collapsed = collapsed ? 'true' : 'false';
    scrim.hidden = !(phone && open);
    patcher.attr(collapseButton, 'aria-expanded', collapsed ? 'false' : 'true');
    patcher.attr(
      collapseButton,
      'aria-label',
      phone
        ? open
          ? 'Close sun and moon details'
          : 'Open sun and moon details'
        : collapsed
          ? 'Expand the light panel'
          : 'Collapse the light panel'
    );
    patcher.attr(
      collapseButton,
      'title',
      phone ? (open ? 'Close' : 'Open') : collapsed ? 'Expand' : 'Collapse'
    );
    patcher.cls(collapseButton, 'is-collapsed', collapsed);
    // The phone sheet is a modal dialog over the whole UI; the desktop panel is
    // a plain complementary region.
    if (phone) {
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', sheetOpen ? 'true' : 'false');
    } else {
      element.removeAttribute('role');
      element.removeAttribute('aria-modal');
    }
    if (sheetOpen && !sheetWasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.setTimeout(() => {
        if (isSheetOpen()) focusEl(collapseButton);
      }, 0);
    } else if (!sheetOpen && sheetWasOpen && phone) {
      restoreSheetFocus();
    }
    sheetWasOpen = sheetOpen;
    callbacks.onOpenChange(open);
  }

  function resetForViewport(): void {
    if (isPhone()) {
      open = false;
      collapsed = false;
    } else if (compactQuery.matches) {
      open = true;
      collapsed = true;
    } else {
      open = true;
      collapsed = false;
    }
    syncAttributes();
  }

  const onPhoneChange = (): void => resetForViewport();
  const onCompactChange = (): void => resetForViewport();
  phoneQuery.addEventListener('change', onPhoneChange);
  compactQuery.addEventListener('change', onCompactChange);

  const cleanup = [
    on(scrim, 'click', () => {
      open = false;
      syncAttributes();
    }),
    on(collapseButton, 'click', () => {
      if (isPhone()) open = !open;
      else collapsed = !collapsed;
      syncAttributes();
    }),
    on(closePhoneButton, 'click', () => {
      open = false;
      syncAttributes();
    }),
    on(namedToggle, 'click', () => toggleNamedPlaces()),
    on(namedFilter, 'input', () => renderNamedPlaces()),
    on(element, 'keydown', (event) => {
      if (!isSheetOpen()) return;
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'Escape') {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        open = false;
        syncAttributes();
        return;
      }
      trapFocus(keyboard, element);
    })
  ];

  function roadKindLabel(c: number): string {
    switch (c) {
      case 1: return 'Main street';
      case 2: return 'Primary street';
      case 3: return 'Street';
      case 4: return 'Local street';
      case 5: return 'Hiking trail';
      case 9: return 'Railway';
      default: return 'Street';
    }
  }

  function areaKindLabel(k: number): string {
    switch (k) {
      case 1: return 'Water';
      case 2: return 'Park';
      case 3: return 'Forest';
      default: return 'Green space';
    }
  }

  function collectNamedPlaces(state: AppState): Array<{ name: string; kind: string; detail: string }> {
    const model = state.model;
    if (!model) return [];
    const entries: Array<{ name: string; kind: string; detail: string }> = [];
    for (const building of model.buildings ?? []) {
      if (!building.n) continue;
      entries.push({
        name: building.n,
        kind: building.k ?? 'Building',
        detail: `${Math.round(building.h / 10)} m tall`
      });
    }
    for (const road of model.roads ?? []) {
      if (!road.n) continue;
      entries.push({ name: road.n, kind: roadKindLabel(road.c), detail: '' });
    }
    for (const area of model.areas ?? []) {
      if (!area.n) continue;
      entries.push({ name: area.n, kind: areaKindLabel(area.k), detail: '' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  function renderNamedPlaces(): void {
    const query = namedFilter.value.trim().toLocaleLowerCase();
    const filtered = query
      ? namedEntries.filter((entry) => `${entry.name} ${entry.kind}`.toLocaleLowerCase().includes(query))
      : namedEntries;
    const shown = filtered.slice(0, 200);
    namedList.replaceChildren();
    for (const entry of shown) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const kind = document.createElement('span');
      kind.textContent = entry.detail ? `${entry.kind} · ${entry.detail}` : entry.kind;
      item.append(name, kind);
      namedList.append(item);
    }
    namedNote.textContent =
      filtered.length > shown.length
        ? `Showing ${shown.length} of ${filtered.length} named places. Use the filter to narrow the list.`
        : filtered.length === 0
          ? 'No named places match this filter.'
          : `${filtered.length} named place${filtered.length === 1 ? '' : 's'} in this model.`;
  }

  function toggleNamedPlaces(): void {
    namedOpen = !namedOpen;
    namedPanel.hidden = !namedOpen;
    namedToggle.setAttribute('aria-expanded', String(namedOpen));
    if (namedOpen) {
      namedFilter.focus();
      renderNamedPlaces();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fonts of truth                                                    */
  /* ---------------------------------------------------------------- */

  let lastSky: SkyDay | null | undefined;
  let lastMood = '';
  let lastCompassLabel = '';

  if (isPhone()) resetForViewport();
  else syncAttributes();

  function updateCompass(sky: SkyDay | null): void {
    if (sky === lastSky) return;
    lastSky = sky;
    if (!sky) {
      patcher.attr(sunAbove, 'd', '');
      patcher.attr(sunBelow, 'd', '');
      patcher.attr(moonPath, 'd', '');
      patcher.attr(riseMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--rise is-hidden');
      patcher.attr(setMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--set is-hidden');
      return;
    }
    const paths = buildTrackPaths(sky.track);
    const markers = horizonMarkers(sky.track);
    patcher.attr(sunAbove, 'd', paths.above);
    patcher.attr(sunBelow, 'd', paths.below);
    patcher.attr(moonPath, 'd', paths.moon);
    if (markers.rise) {
      patcher.attr(riseMarker, 'cx', markers.rise.x);
      patcher.attr(riseMarker, 'cy', markers.rise.y);
      patcher.attr(riseMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--rise');
    } else {
      patcher.attr(riseMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--rise is-hidden');
    }
    if (markers.set) {
      patcher.attr(setMarker, 'cx', markers.set.x);
      patcher.attr(setMarker, 'cy', markers.set.y);
      patcher.attr(setMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--set');
    } else {
      patcher.attr(setMarker, 'class', 'sl-sunpath-rs sl-sunpath-rs--set is-hidden');
    }
    const phaseHtml = sky.moon.phaseAngleDeg;
    patcher.html(moonGlyph, moonPhaseIcon(phaseHtml, 22));
  }

  function phaseIconMarkup(mood: string): string {
    if (mood === 'night') return icon('moon');
    if (mood === 'twilight') return icon('twilight');
    if (mood === 'golden') return icon('sunset');
    return icon('sun');
  }

  function update(state: AppState, light: InterpolatedLight | null, mood: Mood): void {
    const sky = state.sky;
    updateCompass(sky);

    const label = light ? sunLightLabel(light.sunAlt, sky?.sun ?? null, light.moonAlt) : 'No sky data';
    patcher.text(lightLabel, label);
    if (mood !== lastMood) {
      lastMood = mood;
      patcher.html(phaseIcon, phaseIconMarkup(mood));
      element.dataset.mood = mood;
    }

    const tz = sky?.tz ?? state.city?.tz ?? state.viewerTz;
    const sunAlt = light?.sunAlt ?? null;
    const sunAz = light?.sunAz ?? null;
    const moonAlt = light?.moonAlt ?? null;
    const moonAz = light?.moonAz ?? null;
    const altText = formatAltitude(sunAlt ?? Number.NaN);
    const azText = formatAzimuth(sunAz ?? Number.NaN);
    const sunUp = sunAlt !== null && sunAlt > 0.5;
    const moonUp = moonAlt !== null && moonAlt > 5;
    patcher.text(values.sunAltitude, sunAlt === null ? '—' : altText);
    patcher.text(values.sunAzimuth, sunAz === null ? '—' : azText);
    if (sunUp) {
      if (shadowLabel) patcher.text(shadowLabel, 'Shadows');
      patcher.text(values.shadow, formatShadowMultiplier(sunAlt));
    } else if (moonUp) {
      if (shadowLabel) patcher.text(shadowLabel, 'Moon shadows');
      patcher.text(values.shadow, formatShadowMultiplier(moonAlt));
    } else {
      if (shadowLabel) patcher.text(shadowLabel, 'Shadows');
      patcher.text(values.shadow, '—');
    }
    const sunBelow = sunAlt !== null && sunAlt < -12;
    patcher.text(values.sunlight, sunBelow && moonUp ? 'Moonlight' : label);

    patcher.text(values.sunrise, formatInstant(sky?.sun.rise, tz));
    patcher.text(values.sunset, formatInstant(sky?.sun.set, tz));
    patcher.text(values.goldenAm, formatWindow(sky?.sun.goldenHourMorning, tz));
    patcher.text(values.goldenPm, formatWindow(sky?.sun.goldenHourEvening, tz));
    patcher.text(values.dayLength, formatDayLength(sky));
    patcher.text(values.utcOffset, sky ? formatUtcOffset(sky.utcOffsetMinutes) : '—');
    patcher.text(values.moonrise, formatInstant(sky?.moon.rise, tz));
    patcher.text(values.moonset, formatInstant(sky?.moon.set, tz));
    patcher.text(
      moonText,
      sky ? `${sky.moon.phaseName} · ${formatIllumination(sky.moon.illumination)}` : '—'
    );
    patcher.text(
      values.coords,
      state.city ? formatCoords(state.city.lat, state.city.lon) : '—'
    );

    if (sky && (sky.polarDay || sky.polarNight)) {
      patcher.hidden(polarFlag, false);
      patcher.text(polarFlag, sky.polarDay ? 'Polar day — the sun never sets' : 'Polar night — the sun never rises');
    } else {
      patcher.hidden(polarFlag, true);
    }

    // Current sun and moon markers.
    if (light) {
      const sunPoint = projectSkyPoint(light.sunAlt, light.sunAz);
      patcher.attr(sunDot, 'cx', sunPoint.x);
      patcher.attr(sunDot, 'cy', sunPoint.y);
      patcher.attr(sunHalo, 'cx', sunPoint.x);
      patcher.attr(sunHalo, 'cy', sunPoint.y);
      patcher.cls(sunDot, 'is-hidden', false);
      patcher.cls(sunHalo, 'is-hidden', false);
      patcher.cls(moonDot, 'is-hidden', false);
      patcher.cls(axis, 'is-hidden', false);
      patcher.cls(sunDot, 'is-below', light.sunAlt < 0);
      patcher.cls(sunHalo, 'is-below', light.sunAlt < 0);

      const moonPoint = projectSkyPoint(light.moonAlt, light.moonAz);
      patcher.attr(moonDot, 'cx', moonPoint.x);
      patcher.attr(moonDot, 'cy', moonPoint.y);
      patcher.cls(moonDot, 'is-below', light.moonAlt < 0);

      const axisSource = light.sunAlt >= -0.5 ? sunPoint : moonPoint;
      patcher.attr(axis, 'x2', axisSource.x);
      patcher.attr(axis, 'y2', axisSource.y);
      patcher.cls(axis, 'is-below', light.sunAlt < -0.5 && light.moonAlt < 0);

      const compassLabel =
        `Sun altitude ${altText}, azimuth ${azText}. ` +
        `Moon ${moonAlt === null ? 'position unknown' : `altitude ${formatAltitude(moonAlt)}, azimuth ${formatAzimuth(moonAz ?? 0)}`}` +
        (sky ? `, ${formatIllumination(sky.moon.illumination)} illuminated.` : '.');
      if (compassLabel !== lastCompassLabel) {
        lastCompassLabel = compassLabel;
        patcher.attr(svg, 'aria-label', compassLabel);
      }
    } else {
      patcher.cls(sunDot, 'is-hidden', true);
      patcher.cls(sunHalo, 'is-hidden', true);
      patcher.cls(moonDot, 'is-hidden', true);
      patcher.cls(axis, 'is-hidden', true);
    }

    // Accessible named-place list: an alternative to pointer-only map tooltips.
    if (state.model?.key !== namedModelKey) {
      namedModelKey = state.model?.key ?? null;
      namedEntries = collectNamedPlaces(state);
      namedCount.textContent = String(namedEntries.length);
      if (namedOpen) renderNamedPlaces();
    }

    // Model footer.
    const model = state.model;
    if (model) {
      const stats = model.meta.stats;
      patcher.text(
        modelMeta,
        `${formatCount(stats.buildings)} buildings · ${formatCount(stats.roads)} roads · ` +
          `${formatCount(stats.areas)} areas · ${model.meta.radiusM} m radius`
      );
      const sourceParts = [sourceLabel(model.meta.source)];
      if (model.meta.seed) sourceParts.push('ready-made seed');
      patcher.text(modelSource, sourceParts.join(' · '));
    } else {
      patcher.text(modelMeta, state.phase === 'error' ? 'No model available.' : 'Building the model…');
      patcher.text(modelSource, '');
    }
  }

  return {
    element,
    scrim,
    update,
    toggle(): void {
      if (isPhone()) open = !open;
      else collapsed = !collapsed;
      syncAttributes();
    },
    close(): void {
      open = false;
      syncAttributes();
    },
    isOpen(): boolean {
      return open && !collapsed;
    },
    destroy(): void {
      phoneQuery.removeEventListener('change', onPhoneChange);
      compactQuery.removeEventListener('change', onCompactChange);
      cleanup.forEach((dispose) => dispose());
    }
  };
}

function formatWindow(window: [string, string] | null | undefined, tz: string): string {
  if (!window) return '—';
  return `${formatInstant(window[0], tz)}–${formatInstant(window[1], tz)}`;
}

function formatDayLength(sky: SkyDay | null | undefined): string {
  if (!sky) return '—';
  if (sky.polarDay) return '24 h';
  if (sky.polarNight) return '0 h';
  if (!sky.sun.rise || !sky.sun.set) return '—';
  const rise = new Date(sky.sun.rise).getTime();
  const set = new Date(sky.sun.set).getTime();
  if (!Number.isFinite(rise) || !Number.isFinite(set) || set <= rise) return '—';
  return formatDuration((set - rise) / 1000);
}
