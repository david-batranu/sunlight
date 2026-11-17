/**
 * Sunlight E2E — functional behaviour in a real headless Chrome.
 *
 * Covers the seeded first run, deep links, time-of-day/date changes, city
 * search + geolocation switching, camera controls, playback, dialogs and the
 * mobile layout. All assertions read the public `window.__sunlight` state /
 * debug hooks and the documented `data-testid` selectors.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRASOV,
  BRASOV_COORDS,
  CLUJ,
  MOBILE,
  SHOTS,
  assertNoErrors,
  canvasPixelStats,
  gotoReady,
  launchBrowser,
  openPage,
  readDebug,
  readState,
  setDate,
  setMinute
} from './helpers.mjs';

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
});

async function withPage(fn, options = {}) {
  const handle = await openPage(browser, options);
  try {
    await fn(handle);
  } finally {
    assertNoErrors(handle.errors);
    await handle.context.close();
  }
}

test('seeded first run: Brașov loads, canvas is non-blank, chip is correct', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page);
    const state = await readState(page);
    const debug = await readDebug(page);
    const pixels = await canvasPixelStats(page);

    assert.equal(state.phaseAttr, 'ready');
    assert.equal(state.city?.geonameId, BRASOV.geonameId);
    assert.equal(state.chip, BRASOV.name);
    assert.equal(debug.modelKey, BRASOV.key);
    assert.match(state.meta ?? '', /Romania/);
    assert.match(state.meta ?? '', /Europe\/Bucharest/);
    assert.equal(state.dateInputValue, state.date);
    assert.ok(pixels.colors > 40, `canvas center has too few colours (${pixels.colors})`);
    assert.ok(
      pixels.opaque > pixels.total * 0.5,
      `canvas center is mostly transparent (${pixels.opaque}/${pixels.total} opaque)`
    );
    assert.ok(debug.render.drawCalls <= 25, `draw calls should stay merged (${debug.render.drawCalls})`);
  });
});

test('deep link 2026-06-21 13:20 → summer solar noon (~67.8°) with sun light', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const state = await readState(page);
    const debug = await readDebug(page);

    assert.equal(state.date, '2026-06-21');
    assert.equal(Math.round(state.minute), 800);
    assert.equal(state.readout, '13:20');
    assert.match(state.dateReadout ?? '', /21 Jun 2026/);
    assert.equal(debug.light.kind, 'sun');
    assert.ok(
      Math.abs(debug.light.altitudeDeg - 67.8) < 0.6,
      `sun altitude ${debug.light.altitudeDeg}° should be ~67.8°`
    );
    assert.ok(debug.light.intensity > 1, `daylight intensity low (${debug.light.intensity})`);
    assert.equal(debug.light.shadow, true);
    // 13:20 local is solar noon in Brașov: the sun is due south, high in the sky.
    assert.ok(
      Math.abs(debug.light.azimuthDeg - 180) < 6,
      `solar-noon azimuth ${debug.light.azimuthDeg}° should be ~south`
    );
    assert.ok(debug.light.direction[1] > 0.85, 'sun direction should point nearly straight up');
    assert.equal(state.sliderText, '13:20 local, Daylight');
    // Sunrise/sunset readouts come from the real ephemeris.
    assert.match(state.rise ?? '', /^05:2\d$/);
    assert.match(state.set ?? '', /^21:1\d$/);
  });
});

test('slider 20:45 → golden hour, sun ~3° in the west, long shadows on', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await setMinute(page, 1245);
    const state = await readState(page);
    const debug = await readDebug(page);

    assert.equal(state.readout, '20:45');
    assert.equal(state.quality, 'Golden hour');
    assert.equal(state.mood, 'golden');
    assert.equal(debug.light.kind, 'sun');
    assert.ok(
      Math.abs(debug.light.altitudeDeg - 3.1) < 1.2,
      `golden-hour altitude ${debug.light.altitudeDeg}° should be ~3°`
    );
    assert.ok(debug.light.shadow, 'a low sun must still cast shadows');
    // Low evening sun: light comes from the west/north-west, shadows point east.
    assert.ok(
      debug.light.direction[0] < -0.5,
      `evening light x-direction ${debug.light.direction[0]} should be strongly west`
    );
    assert.equal(state.sliderValue, '1245');
  });
});

test('slider 23:30 → night mood and moonlight (sun below the horizon)', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await setMinute(page, 1410);
    const state = await readState(page);
    const debug = await readDebug(page);

    assert.equal(state.readout, '23:30');
    assert.equal(state.mood, 'night');
    assert.ok(state.current.sunAlt < -10, `sun should be below the horizon (${state.current.sunAlt}°)`);
    assert.equal(debug.light.kind, 'moon');
    assert.ok(debug.light.altitudeDeg > 2, 'the moon should be up on 2026-06-21 23:30');
    assert.ok(debug.light.intensity > 0, 'moonlight intensity should be positive');
  });
});

test('date change 2026-06-21 → 2026-12-21 reloads the sky (different rise/set and max altitude)', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const before = await readState(page);
    assert.ok(Math.abs(before.sky.sun.maxAltitudeDeg - 67.8) < 0.6);

    await setDate(page, '2026-12-21', before.sky.sun.maxAltitudeDeg);
    const after = await readState(page);
    assert.equal(after.date, '2026-12-21');
    assert.equal(after.dateInputValue, '2026-12-21');
    assert.match(after.dateReadout ?? '', /21 Dec 2026/);
    assert.ok(
      after.sky.sun.maxAltitudeDeg < 25,
      `winter solstice max altitude ${after.sky.sun.maxAltitudeDeg}° should be low`
    );
    assert.notEqual(after.sky.sun.rise, before.sky.sun.rise, 'sunrise should change with the date');
    assert.notEqual(after.sky.sun.set, before.sky.sun.set, 'sunset should change with the date');
    assert.match(after.rise ?? '', /^07:5\d$/);
    assert.match(after.set ?? '', /^16:[34]\d$/);
  });
});

test('URL reload restores city, date and time', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await setMinute(page, 1245);
    await page.waitForFunction(() => /time=20%3A45|time=20:45/.test(location.search), null, {
      timeout: 5000
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__sunlight?.getState().phase === 'ready' && window.__sunlight.getState().sky,
      null,
      { timeout: 30_000 }
    );
    await page.waitForFunction(
      () => window.__sunlight.getSceneDebug().render.drawCalls > 0,
      null,
      { timeout: 30_000 }
    );
    const state = await readState(page);
    assert.equal(state.city?.geonameId, BRASOV.geonameId);
    assert.equal(state.date, '2026-06-21');
    assert.equal(Math.round(state.minute), 1245);
    assert.equal(state.readout, '20:45');
    assert.match(await page.evaluate(() => location.search), /city=gn(%3A|:)683844/);
  });
});

test('search + switch to Cluj-Napoca seed updates city chip and model', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page);
    await page.locator('[data-testid="open-search"]').click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="search-dialog"]');
      return dialog && dialog.checkVisibility();
    });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'search-input',
      null,
      { timeout: 3000 }
    );
    await page.locator('[data-testid="search-input"]').fill('Cluj');
    await page.waitForFunction(() => document.querySelector('[data-testid="search-result-0"]'), null, {
      timeout: 15_000
    });
    const firstResult = await page
      .locator('[data-testid="search-result-0"]')
      .textContent();
    assert.match(firstResult ?? '', /Cluj-Napoca/);

    await page.locator('[data-testid="search-result-0"]').click();
    await page.waitForFunction(
      (key) => window.__sunlight.getSceneDebug().modelKey === key,
      CLUJ.key,
      { timeout: 30_000 }
    );
    const state = await readState(page);
    const debug = await readDebug(page);
    assert.equal(state.city?.geonameId, CLUJ.geonameId);
    assert.equal(state.chip, CLUJ.name);
    assert.equal(debug.modelKey, CLUJ.key);
    assert.ok(debug.render.drawCalls > 0 && debug.render.triangles > 50_000);
    assert.equal(await page.locator('[data-testid="search-dialog"]').isVisible(), false);
    assert.match(await page.evaluate(() => location.search), /city=gn(%3A|:)681290/);
  });
});

test('geolocation stub + Locate resolves Brașov and switches back from Cluj', async () => {
  await withPage(
    async ({ page }) => {
      await gotoReady(page, 'city=gn:681290&date=2026-06-21&time=13:20');
      assert.equal((await readState(page)).city?.geonameId, CLUJ.geonameId);

      await page.locator('[data-testid="locate"]').click();
      await page.waitForFunction(
        (id) => window.__sunlight.getState().city?.geonameId === id,
        BRASOV.geonameId,
        { timeout: 20_000 }
      );
      await page.waitForFunction(
        (key) => window.__sunlight.getSceneDebug().modelKey === key,
        BRASOV.key,
        { timeout: 30_000 }
      );
      const state = await readState(page);
      assert.equal(state.chip, BRASOV.name);
      assert.ok(
        state.notices.some((notice) => /Nearest city: Bra/i.test(notice)),
        `expected a nearest-city notice, got ${JSON.stringify(state.notices)}`
      );
    },
    { geolocation: BRASOV_COORDS, permissions: ['geolocation'] }
  );
});

test('pan changes camera target without changing light; wheel zoom changes zoom; reset restores', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const box = await page.locator('#scene').boundingBox();
    assert.ok(box && box.width > 1000 && box.height > 600, 'scene canvas should cover the viewport');

    const before = await readDebug(page);
    await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.55, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(
      (target) => {
        const camera = window.__sunlight.getSceneDebug().camera;
        return Math.hypot(camera.target[0] - target[0], camera.target[2] - target[2]) > 20;
      },
      before.camera.target,
      { timeout: 5000 }
    );
    const afterPan = await readDebug(page);
    assert.notDeepEqual(afterPan.camera.target, before.camera.target);
    assert.deepEqual(
      afterPan.light.direction,
      before.light.direction,
      'panning must not move the sun'
    );

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction(
      (startZoom) => window.__sunlight.getSceneDebug().camera.zoom > startZoom + 0.1,
      afterPan.camera.zoom,
      { timeout: 5000 }
    );
    const zoomedIn = await readDebug(page);
    assert.ok(zoomedIn.camera.zoom > afterPan.camera.zoom);

    await page.locator('[data-testid="reset-camera"]').click();
    await page.waitForFunction(
      () => Math.abs(window.__sunlight.getSceneDebug().camera.zoom - 1) < 0.01,
      null,
      { timeout: 5000 }
    );
    const reset = await readDebug(page);
    assert.ok(Math.abs(reset.camera.azimuthDeg - 135) < 0.5);
    assert.ok(Math.abs(reset.camera.pitchDeg - 35.264) < 0.5);
    assert.ok(Math.hypot(reset.camera.target[0], reset.camera.target[2]) < 1);
  });
});

test('play/pause advances simulated time and then holds still', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const startMinute = (await readState(page)).minute;

    await page.locator('[data-testid="play-toggle"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().playing === true);
    assert.equal(await page.locator('[data-testid="play-toggle"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(
      (start) => window.__sunlight.getState().minute > start + 1,
      startMinute,
      { timeout: 8000 }
    );
    const playingMinute = (await readState(page)).minute;
    assert.ok(playingMinute > startMinute + 1, `playback should advance (${startMinute} → ${playingMinute})`);

    await page.locator('[data-testid="play-toggle"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().playing === false);
    const paused = (await readState(page)).minute;
    await page.waitForTimeout(700);
    const later = (await readState(page)).minute;
    assert.ok(Math.abs(later - paused) < 1, `paused time should hold (${paused} → ${later})`);
    assert.equal(await page.locator('[data-testid="play-toggle"]').getAttribute('aria-label'), 'Play the day');
  });
});

test('Escape closes the search dialog and the About dialog', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page);

    await page.locator('[data-testid="open-search"]').click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('[data-testid="search-dialog"]').isVisible(), true);
    assert.equal((await readState(page)).dialog, 'search');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-testid="search-dialog"]').isVisible(), false);
    assert.equal((await readState(page)).dialog, null);

    await page.locator('[data-testid="about-open"]').click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('[data-testid="about-dialog"]').isVisible(), true);
    assert.equal((await readState(page)).dialog, 'about');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-testid="about-dialog"]').isVisible(), false);
    assert.equal((await readState(page)).dialog, null);
  });
});

test('mobile 390x844: key controls visible, usable, no horizontal overflow', async () => {
  await withPage(
    async ({ page }) => {
      await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');

      const layout = await page.evaluate(() => {
        const viewport = { width: innerWidth, height: innerHeight };
        const visible = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, found: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            found: true,
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            inViewport:
              rect.left >= -1 &&
              rect.top >= -1 &&
              rect.right <= viewport.width + 1 &&
              rect.bottom <= viewport.height + 1,
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        };
        const selectors = [
          '[data-testid="city-chip"]',
          '[data-testid="open-search"]',
          '[data-testid="locate"]',
          '[data-testid="area-pick"]',
          '[data-testid="about-open"]',
          '[data-testid="time-readout"]',
          '[data-testid="date-input"]',
          '[data-testid="time-slider"]',
          '[data-testid="play-toggle"]',
          '[data-testid="speed-select"]'
        ];
        return {
          viewport,
          scrollWidth: document.documentElement.scrollWidth,
          controls: selectors.map(visible)
        };
      });

      assert.ok(
        layout.scrollWidth <= layout.viewport.width + 1,
        `horizontal overflow: ${layout.scrollWidth}px > ${layout.viewport.width}px`
      );
      for (const control of layout.controls) {
        assert.ok(control.found, `${control.selector} is missing on mobile`);
        assert.ok(control.visible, `${control.selector} should be visible on mobile`);
        assert.ok(control.inViewport, `${control.selector} should be inside the mobile viewport`);
      }
      const play = layout.controls.find((control) => control.selector.includes('play-toggle'));
      assert.ok(play.width >= 40 && play.height >= 40, 'play button should be a >=40px touch target');

      // Controls still work on mobile.
      await page.locator('[data-testid="play-toggle"]').click();
      await page.waitForFunction(() => window.__sunlight.getState().playing === true);
      await page.locator('[data-testid="play-toggle"]').click();

      await page.locator('[data-testid="open-search"]').click();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('[data-testid="search-dialog"]').isVisible(), true);
      await page.keyboard.press('Escape');
    },
    { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  );
});

test('detail area minimap: drag, resize and focus without reloading the city', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');

    await page.locator('[data-testid="area-pick"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true);
    assert.equal(await page.locator('[data-testid="detail-panel"]').isVisible(), true);
    const opened = await readState(page);
    assert.ok(opened.detailWindow, 'opening the panel should create a detail window');
    assert.ok(opened.detailWindow.radiusM >= 100 && opened.detailWindow.radiusM <= 1500);
    const openedZoom = await page.evaluate(() => window.__sunlight.getSceneDebug().camera.zoom);
    assert.equal(openedZoom, 1, 'opening the area picker should keep the wide context view');

    // Focus at the default 750m window must zoom in, not out (UX P1-5).
    await page.locator('[data-testid="detail-focus"]').click();
    await page.waitForFunction(() => window.__sunlight.getSceneDebug().camera.zoom > 1, null, {
      timeout: 5000
    });
    // Return to the wide view for the resize/Focus sequence.
    await page.locator('[data-testid="reset-camera"]').click();
    await page.waitForFunction(() => window.__sunlight.getSceneDebug().camera.zoom === 1, null, {
      timeout: 5000
    });

    // Resizing only changes the window; Focus explicitly moves the camera.
    await page.locator('[data-testid="detail-size-input"]').evaluate((input) => {
      input.value = '300';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__sunlight.getState().detailWindow?.radiusM === 300);
    assert.equal(
      await page.evaluate(() => window.__sunlight.getSceneDebug().camera.zoom),
      openedZoom,
      'resizing must not move the camera before Focus'
    );
    await page.locator('[data-testid="detail-focus"]').click();
    await page.waitForFunction(() => window.__sunlight.getSceneDebug().camera.zoom > 1.1, null, {
      timeout: 5000
    });
    const resized = await readState(page);
    assert.equal(resized.detailWindow?.radiusM, 300);

    // Drag the minimap frame, which updates the window without an API reload.
    const canvas = page.locator('[data-testid="detail-canvas"]');
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.42, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const dragged = await readState(page);
    assert.notEqual(dragged.detailWindow?.centerX, resized.detailWindow?.centerX);
    assert.equal(dragged.modelKey, resized.modelKey, 'dragging must not reload the model');

    await page.screenshot({ path: `${SHOTS}/detail-area.png` });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === false);
    assert.equal(await page.locator('[data-testid="detail-panel"]').isVisible(), false);
  });
});

test('Space activates focused controls instead of toggling playback', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const area = page.locator('[data-testid="area-pick"]');
    await area.focus();
    const before = await readState(page);
    assert.equal(before.playing, false);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true, null, {
      timeout: 3000
    });
    const after = await readState(page);
    assert.equal(after.playing, false, 'Space on a focused button must not toggle playback');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === false, null, {
      timeout: 3000
    });
    assert.equal(await area.evaluate((el) => el === document.activeElement), true, 'focus should return to Area');
    // Space on the non-interactive page still toggles playback.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__sunlight.getState().playing === true, null, {
      timeout: 3000
    });
  });
});

test('Today preserves the time-of-day; Now restores both date and time', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-20&time=10:15');
    const todayCity = await page.evaluate(() =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date())
    );
    await page.locator('[data-testid="today"]').click();
    await page.waitForFunction((date) => window.__sunlight.getState().date === date, todayCity);
    const afterToday = await readState(page);
    assert.equal(Math.floor(afterToday.minute ?? -1), 615, 'Today must preserve the current time-of-day');
    await page.locator('[data-testid="set-now"]').click();
    await page.waitForTimeout(300);
    const afterNow = await readState(page);
    const now = await page.evaluate(() => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(new Date());
      const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      return { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date()), minute: get('hour') * 60 + get('minute') };
    });
    assert.equal(afterNow.date, now.date);
    assert.ok(Math.abs((afterNow.minute ?? 0) - now.minute) < 3, 'Now must restore the current minute');
  });
});

test('Area picker reflows to a sheet at 200% zoom and small phones without clipping', async () => {
  await withPage(async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 450 });
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await page.locator('[data-testid="area-pick"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true);
    const zoomed = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="detail-panel"]').getBoundingClientRect();
      const map = document.querySelector('.sl-minimap-map').getBoundingClientRect();
      const canvas = document.querySelector('[data-testid="detail-canvas"]').getBoundingClientRect();
      const focus = document.querySelector('[data-testid="detail-focus"]').getBoundingClientRect();
      const load = document.querySelector('[data-testid="detail-load"]').getBoundingClientRect();
      const inside = (r) => r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
      return {
        mode: document.querySelector('[data-testid="detail-panel"]').dataset.mode,
        inside: inside(panel) && inside(map) && inside(focus) && inside(load),
        map: [Math.round(map.width), Math.round(map.height)],
        canvas: [Math.round(canvas.width), Math.round(canvas.height)]
      };
    });
    assert.equal(zoomed.mode, 'sheet');
    assert.equal(zoomed.inside, true, 'Area sheet, map and actions must fit the 200% viewport');
    assert.ok(Math.abs(zoomed.map[0] - zoomed.map[1]) <= 2, 'map must not be clipped vertically');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === false);

    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="area-pick"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true);
    const phone = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="detail-panel"]').getBoundingClientRect();
      const map = document.querySelector('.sl-minimap-map').getBoundingClientRect();
      const canvas = document.querySelector('[data-testid="detail-canvas"]').getBoundingClientRect();
      return {
        inside: panel.top >= -1 && panel.bottom <= window.innerHeight + 1,
        canvas: [Math.round(canvas.width), Math.round(canvas.height)],
        map: [Math.round(map.width), Math.round(map.height)]
      };
    });
    assert.equal(phone.inside, true);
    assert.equal(phone.canvas[0], phone.canvas[1], 'phone map canvas must stay 1:1');
    assert.ok(phone.map[1] >= phone.canvas[1] - 2, 'phone map must not clip the canvas');
  });
});

test('overview map zooms and keyboard navigation works on the diorama', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await page.locator('[data-testid="area-pick"]').click();
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true);
    const scale0 = await page.locator('[data-testid="detail-map-scale"]').innerText();
    await page.locator('[data-testid="detail-map-zoom-in"]').click();
    await page.locator('[data-testid="detail-map-zoom-in"]').click();
    await page.waitForTimeout(400);
    const scale1 = await page.locator('[data-testid="detail-map-scale"]').innerText();
    assert.notEqual(scale1, scale0, 'map zoom must change the scale label');
    assert.match(scale1, /radius/);
    await page.keyboard.press('Escape');

    const before = await page.evaluate(() => window.__sunlight.getSceneDebug().camera);
    await page.locator('#scene').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__sunlight.getSceneDebug().camera);
    assert.notDeepEqual(after.target, before.target, 'arrow keys must pan the diorama');
    assert.ok(after.zoom > before.zoom, 'plus must zoom the diorama');
  });
});

test('named places list is an accessible alternative to map tooltips', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const toggle = page.locator('[data-testid="named-toggle"]');
    if (!(await toggle.isVisible())) {
      await page.locator('[data-testid="light-collapse"]').click();
      await page.waitForTimeout(200);
    }
    await toggle.waitFor({ state: 'visible' });
    await toggle.click();
    await page.waitForFunction(() => {
      const list = document.querySelector('[data-testid="named-list"]');
      return list && list.children.length > 0;
    });
    const items = await page.locator('[data-testid="named-list"] li').count();
    assert.ok(items > 10, `expected named places in the list, got ${items}`);
    await page.locator('[data-testid="named-filter"]').fill('Bulevardul');
    await page.waitForTimeout(150);
    assert.ok((await page.locator('[data-testid="named-list"] li').count()) < items);
  });
});

test('wide model: 1500 m city, named landmarks and a camera-following compass', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const state = await readState(page);
    assert.equal(state.radiusM, 1500);
    assert.ok((state.stats?.buildings ?? 0) > 5000, `expected a wide city, got ${state.stats?.buildings}`);
    assert.ok(state.namedBuildings > 50, `expected named landmarks, got ${state.namedBuildings}`);
    assert.ok(state.namedRoads > 100, `expected named roads, got ${state.namedRoads}`);
    assert.ok(state.terrain, 'Brașov must carry an elevation heightfield');
    assert.ok(state.terrain.maxReliefM > 60, `expected real relief, got ${state.terrain.maxReliefM} m`);

    const compass = page.locator('[data-testid="compass"]');
    await compass.waitFor({ state: 'visible' });
    const before = await page.evaluate(() => ({
      rotation: document.querySelector('.sl-compass-rotor')?.getAttribute('transform') ?? '',
      azimuth: window.__sunlight.getState().cameraAzimuthDeg,
      caption: document.querySelector('[data-testid="compass-view"]')?.textContent ?? ''
    }));
    assert.equal(before.azimuth, 135, 'default view must look south-east');
    assert.equal(before.caption, 'SE', 'compass should read View from SE');
    assert.match(before.rotation, /rotate\(45(\.00)? 48 48\)/, 'NW should be toward the top of the compass');

    const box = await page.locator('#scene').boundingBox();
    assert.ok(box);
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 700, box.y + 450);
    await page.mouse.down();
    await page.mouse.move(box.x + 820, box.y + 450, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForFunction(
      (azimuth) => Math.abs(window.__sunlight.getState().cameraAzimuthDeg - azimuth) > 5,
      before.azimuth,
      { timeout: 5000 }
    );
    const after = await page.evaluate(() => ({
      rotation: document.querySelector('.sl-compass-rotor')?.getAttribute('transform') ?? '',
      azimuth: window.__sunlight.getState().cameraAzimuthDeg,
      caption: document.querySelector('[data-testid="compass-view"]')?.textContent ?? ''
    }));
    assert.notEqual(after.rotation, before.rotation, 'compass rose should rotate with the camera');
    assert.notEqual(after.caption, before.caption, 'compass caption should follow the camera');

    await compass.click();
    await page.waitForFunction(
      () => Math.abs(window.__sunlight.getState().cameraAzimuthDeg - 135) < 0.8,
      null,
      { timeout: 5000 }
    );
  });
});

test('hover and tap tooltips identify named city features', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const hit = await page.evaluate(() => {
      for (let y = 160; y < 800; y += 12) {
        for (let x = 200; x < 1150; x += 12) {
          const feature = window.__sunlight.hitTest(x, y);
          if (feature?.name) return { x, y, feature };
        }
      }
      return null;
    });
    assert.ok(hit, 'expected to find a named feature by scanning the diorama');

    await page.mouse.move(hit.x, hit.y);
    await page.waitForFunction(() => !!window.__sunlight.getState().hover, null, { timeout: 5000 });
    const tooltip = page.locator('[data-testid="feature-tooltip"]');
    await tooltip.waitFor({ state: 'visible' });
    assert.match((await tooltip.textContent()) ?? '', new RegExp(escapeRegex(hit.feature.name)));
    const hoverState = await readState(page);
    assert.equal(hoverState.hover?.name, hit.feature.name);
    assert.equal(hoverState.hover?.sticky, false);

    await page.mouse.click(hit.x, hit.y);
    await page.waitForFunction(() => window.__sunlight.getState().hover?.sticky === true, null, {
      timeout: 5000
    });
    assert.equal(await page.locator('[data-testid="tooltip-close"]').isVisible(), true);
    await page.screenshot({ path: `${SHOTS}/feature-tooltip.png` });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sunlight.getState().hover === null, null, {
      timeout: 5000
    });
  });
});

test('area picker combines the 5 km overview with the detail window', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    const button = page.locator('[data-testid="area-pick"]');
    await button.waitFor({ state: 'visible' });
    await button.click();
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === true);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-testid="detail-panel"]').isVisible(), true);
    assert.equal(await page.locator('[data-testid="detail-canvas"]').isVisible(), true);
    assert.equal(await page.locator('[data-testid="detail-load"]').isVisible(), true);
    const status = await page.locator('[data-testid="detail-status"]').innerText();
    assert.match(status, /Within the loaded city/);
    // Loading map context is best-effort; the offline QA browser falls back to
    // the loaded model rather than failing the page.
    assert.equal(await page.locator('[data-testid="detail-size-input"]').getAttribute('max'), '1500');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sunlight.getState().detailPanelOpen === false);
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-testid="detail-panel"]').isVisible(), false);
  });
});

test('switching cities resets the clock to the new city\'s local now', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=1900-01-01&time=00:30');
    const before = await readState(page);
    assert.equal(before.date, '1900-01-01');
    assert.equal(Math.round(before.minute), 30);

    await page.evaluate(() =>
      window.__sunlight.actions.selectSearchResult({
        geonameId: 681290,
        name: 'Cluj-Napoca',
        asciiName: 'Cluj-Napoca',
        country: 'RO',
        countryName: 'Romania',
        lat: 46.76667,
        lon: 23.6,
        tz: 'Europe/Bucharest',
        population: 286598,
        seed: true,
        seedSlug: 'cluj-napoca'
      })
    );
    await page.waitForFunction(
      () => window.__sunlight.getState().city?.geonameId === 681290 && window.__sunlight.getState().phase === 'ready',
      null,
      { timeout: 30_000 }
    );
    const after = await readState(page);
    const expected = await page.evaluate(() => {
      const tz = window.__sunlight.getState().city.tz;
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(now);
      const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      const clock = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(now);
      const [hour, minute] = clock.split(':').map(Number);
      return { date: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`, minute: hour * 60 + minute };
    });
    assert.equal(after.date, expected.date, 'new city should start on its local today');
    assert.ok(
      Math.abs(after.minute - expected.minute) <= 5,
      `new city should start near its local now (${after.minute} vs ${expected.minute})`
    );
  });
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
