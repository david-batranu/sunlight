/**
 * Time console: the large local clock, date navigation, the coloured time
 * slider, playback transport and the phone "Sun & Moon" sheet opener.
 */

import type { AppState } from '../app/state.ts';
import type { UIContext } from '../app/contracts.ts';
import type { InterpolatedLight } from '../app/time.ts';
import {
  formatDateLong,
  formatInstant,
  formatMinuteOfDay,
  formatUtcOffset,
  sunLightLabel
} from '../app/time.ts';
import { DATE_MAX, DATE_MIN } from '../../shared/constants.ts';
import type { SkyDay } from '../../shared/types.ts';
import { bandGradient, dayMarkers } from './sunpath.ts';
import { dayOfYear, formatSpeed, moodLabel } from './format.ts';
import { createPatcher, el, on, q } from './dom.ts';
import { icon } from './icons.ts';

export interface TimeConsoleCallbacks {
  onToggleLight(): void;
}

export interface TimeConsoleHandle {
  element: HTMLElement;
  update(state: AppState, light: InterpolatedLight | null): void;
  setLightOpen(open: boolean): void;
  destroy(): void;
}

const SPEEDS = [1, 5, 15, 60] as const;

export function createTimeConsole(ctx: UIContext, callbacks: TimeConsoleCallbacks): TimeConsoleHandle {
  const patcher = createPatcher();
  const element = el(
    'section',
    'sl-panel sl-time',
    `
    <div class="sl-time-head">
      <div class="sl-clock">
        <time class="sl-clock-value" data-testid="time-readout" aria-label="Local time">--:--</time>
        <span class="sl-clock-unit">local</span>
      </div>
      <div class="sl-date">
        <span class="sl-date-long" data-testid="date-readout">—</span>
        <span class="sl-date-meta" data-testid="tz-readout">—</span>
      </div>
    </div>

    <div class="sl-date-row">
      <button class="sl-icon-btn" type="button" data-testid="date-prev" aria-label="Previous day" title="Previous day (Page ↑)">
        ${icon('arrowLeft')}
      </button>
      <label class="sl-date-field">
        <span class="sl-sr-only">Date</span>
        <input class="sl-date-input" type="date" data-testid="date-input" min="${DATE_MIN}" max="${DATE_MAX}" />
      </label>
      <button class="sl-icon-btn" type="button" data-testid="date-next" aria-label="Next day" title="Next day (Page ↓)">
        ${icon('arrowRight')}
      </button>
      <button class="sl-btn sl-btn--quiet" type="button" data-testid="today" aria-keyshortcuts="T" title="Go to today (T)">Today</button>
      <button class="sl-btn sl-btn--quiet" type="button" data-testid="set-now" aria-keyshortcuts="N" title="Jump to now (N)">Now</button>
    </div>

    <div class="sl-slider-block">
      <div class="sl-slider">
        <div class="sl-slider-rail" aria-hidden="true">
          <div class="sl-slider-bands"></div>
          <span class="sl-slider-tick sl-slider-tick--rise"></span>
          <span class="sl-slider-tick sl-slider-tick--set"></span>
        </div>
        <input
          class="sl-range"
          type="range"
          data-testid="time-slider"
          min="0"
          max="1439"
          step="1"
          value="0"
          aria-label="Time of day"
        />
      </div>
      <div class="sl-scale" aria-hidden="true">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
      <div class="sl-sun-row" data-testid="sun-times">
        <span class="sl-sun-rise">${icon('sunrise')}<span data-testid="rise-readout">—</span></span>
        <span class="sl-sun-set">${icon('sunset')}<span data-testid="set-readout">—</span></span>
        <span class="sl-light-quality" data-testid="light-quality">—</span>
      </div>
    </div>

    <div class="sl-transport">
      <button class="sl-play" type="button" data-testid="play-toggle" aria-pressed="false" aria-label="Play the day" title="Play / pause (Space)">
        <span class="sl-play-ic sl-play-ic--play">${icon('play')}</span>
        <span class="sl-play-ic sl-play-ic--pause" hidden>${icon('pause')}</span>
      </button>
      <label class="sl-speed">
        <span class="sl-speed-label">Speed</span>
        <select class="sl-select" data-testid="speed-select" aria-label="Playback speed">
          ${SPEEDS.map((speed) => `<option value="${speed}">${formatSpeed(speed)}</option>`).join('')}
        </select>
      </label>
      <button class="sl-btn sl-btn--ghost sl-loop" type="button" data-testid="loop-toggle" aria-pressed="false" aria-label="Loop the same day" title="Loop the same day">
        ${icon('loop')}<span class="sl-btn-label">Loop day</span>
      </button>
      <button class="sl-btn sl-btn--ghost sl-light-toggle-phone" type="button" data-testid="light-toggle" aria-expanded="false" aria-controls="sl-light-body" aria-label="Open sun and moon details" title="Sun &amp; Moon">
        ${icon('sun')}<span class="sl-btn-label">Sun &amp; Moon</span>
      </button>
      <span class="sl-mode-hint" data-testid="mode-hint">Paused</span>
    </div>
  `
  );
  element.setAttribute('aria-label', 'Time and date controls');

  const clock = q<HTMLElement>(element, '[data-testid="time-readout"]');
  const dateReadout = q<HTMLElement>(element, '[data-testid="date-readout"]');
  const tzReadout = q<HTMLElement>(element, '[data-testid="tz-readout"]');
  const dateInput = q<HTMLInputElement>(element, '[data-testid="date-input"]');
  const slider = q<HTMLInputElement>(element, '[data-testid="time-slider"]');
  const bands = q<HTMLElement>(element, '.sl-slider-bands');
  const riseTick = q<HTMLElement>(element, '.sl-slider-tick--rise');
  const setTick = q<HTMLElement>(element, '.sl-slider-tick--set');
  const riseReadout = q<HTMLElement>(element, '[data-testid="rise-readout"]');
  const setReadout = q<HTMLElement>(element, '[data-testid="set-readout"]');
  const quality = q<HTMLElement>(element, '[data-testid="light-quality"]');
  const playButton = q<HTMLButtonElement>(element, '[data-testid="play-toggle"]');
  const playIcon = q<HTMLElement>(element, '.sl-play-ic--play');
  const pauseIcon = q<HTMLElement>(element, '.sl-play-ic--pause');
  const speedSelect = q<HTMLSelectElement>(element, '[data-testid="speed-select"]');
  const loopButton = q<HTMLButtonElement>(element, '[data-testid="loop-toggle"]');
  const modeHint = q<HTMLElement>(element, '[data-testid="mode-hint"]');
  const lightToggle = q<HTMLButtonElement>(element, '[data-testid="light-toggle"]');

  let lastSky: SkyDay | null = null;
  let scrubbing = false;
  let customSpeedOption: HTMLOptionElement | null = null;

  const cleanup = [
    on(q(element, '[data-testid="date-prev"]'), 'click', () => ctx.actions.stepDay(-1)),
    on(q(element, '[data-testid="date-next"]'), 'click', () => ctx.actions.stepDay(1)),
    on(q(element, '[data-testid="today"]'), 'click', () => ctx.actions.goToday()),
    on(q(element, '[data-testid="set-now"]'), 'click', () => ctx.actions.setNow()),
    on(playButton, 'click', () => ctx.actions.togglePlay()),
    on(loopButton, 'click', () => ctx.actions.toggleLoop()),
    on(lightToggle, 'click', () => callbacks.onToggleLight()),
    on(dateInput, 'change', () => {
      const value = dateInput.value;
      if (value && value !== ctx.store.getState().date) ctx.actions.setDate(value);
    }),
    on(slider, 'pointerdown', () => {
      scrubbing = true;
    }),
    on(slider, 'pointerup', () => {
      scrubbing = false;
    }),
    on(slider, 'pointercancel', () => {
      scrubbing = false;
    }),
    on(slider, 'blur', () => {
      scrubbing = false;
    }),
    on(slider, 'input', () => {
      const minute = Number(slider.value);
      if (Number.isFinite(minute)) ctx.actions.setMinute(minute);
    }),
    on(slider, 'change', () => {
      scrubbing = false;
    }),
    on(speedSelect, 'change', () => {
      const speed = Number(speedSelect.value);
      if (Number.isFinite(speed) && speed > 0) ctx.actions.setSpeed(speed);
    })
  ];

  function updateSliderTrack(sky: SkyDay | null): void {
    if (sky === lastSky) return;
    lastSky = sky;
    patcher.style(bands, 'background-image', bandGradient(sky));
    const markers = dayMarkers(sky);
    const place = (tick: HTMLElement, minute: number | null, label: string): void => {
      patcher.hidden(tick, minute === null);
      if (minute === null) return;
      patcher.style(tick, 'left', `${((minute / 1440) * 100).toFixed(2)}%`);
      patcher.attr(tick, 'title', `${label} ${formatMinuteOfDay(minute)}`);
    };
    place(riseTick, markers.rise, 'Sunrise');
    place(setTick, markers.set, 'Sunset');
  }

  function update(state: AppState, light: InterpolatedLight | null): void {
    const minute = state.minute;
    const roundedMinute = Math.round(minute);
    patcher.text(clock, formatMinuteOfDay(roundedMinute));
    patcher.attr(clock, 'datetime', `${state.date}T${formatMinuteOfDay(roundedMinute)}`);
    patcher.text(dateReadout, formatDateLong(state.date));

    const tz = state.city?.tz ?? state.viewerTz;
    const tzParts: string[] = [tz];
    if (state.sky) tzParts.push(formatUtcOffset(state.sky.utcOffsetMinutes));
    const day = dayOfYear(state.date);
    if (day > 0) tzParts.push(`Day ${day}`);
    patcher.text(tzReadout, tzParts.join(' · '));

    patcher.value(dateInput, state.date);
    if (!scrubbing) patcher.value(slider, String(Math.max(0, Math.min(1439, roundedMinute))));

    const qualityLabel = light ? sunLightLabel(light.sunAlt, state.sky?.sun ?? null, light.moonAlt) : '—';
    patcher.text(quality, qualityLabel);
    patcher.attr(
      slider,
      'aria-valuetext',
      `${formatMinuteOfDay(roundedMinute)} local, ${light ? qualityLabel : moodLabel('day')}`
    );

    updateSliderTrack(state.sky);

    const skyTz = state.sky?.tz ?? tz;
    patcher.text(riseReadout, formatInstant(state.sky?.sun.rise, skyTz));
    patcher.text(setReadout, formatInstant(state.sky?.sun.set, skyTz));

    const playing = state.playing;
    patcher.attr(playButton, 'aria-pressed', playing ? 'true' : 'false');
    patcher.attr(playButton, 'aria-label', playing ? 'Pause the day' : 'Play the day');
    patcher.disabled(playButton, !state.sky);
    patcher.hidden(playIcon, playing);
    patcher.hidden(pauseIcon, !playing);

    patcher.attr(loopButton, 'aria-pressed', state.loopDay ? 'true' : 'false');
    patcher.cls(loopButton, 'is-active', state.loopDay);

    const speeds: number[] = SPEEDS.slice();
    if (!speeds.includes(state.speed)) {
      if (!customSpeedOption) {
        customSpeedOption = document.createElement('option');
        customSpeedOption.dataset.custom = 'true';
        speedSelect.append(customSpeedOption);
      }
      customSpeedOption.value = String(state.speed);
      customSpeedOption.textContent = formatSpeed(state.speed);
    }
    patcher.value(speedSelect, String(state.speed));

    patcher.text(
      modeHint,
      playing ? `Playing · ${formatSpeed(state.speed)}` : state.loopDay ? 'Loop on' : 'Paused'
    );
  }

  return {
    element,
    update,
    setLightOpen(open: boolean): void {
      patcher.attr(lightToggle, 'aria-expanded', open ? 'true' : 'false');
      patcher.cls(lightToggle, 'is-active', open);
    },
    destroy(): void {
      cleanup.forEach((dispose) => dispose());
    }
  };
}
