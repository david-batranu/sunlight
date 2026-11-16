/**
 * Sunlight E2E — canonical screenshots, visual sanity, performance smoke and
 * accessibility basics. Screenshots are written to QA_SHOTS at 1440x900
 * (plus one 390x844 mobile shot) and verified both by image statistics and by
 * human review (qa/report.md).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BRASOV,
  DESKTOP,
  MOBILE,
  SHOTS,
  assertNoErrors,
  gotoReady,
  imageStats,
  launchBrowser,
  openPage,
  readDebug,
  readState,
  screenshot,
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

async function waitFrames(page, frames = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let seen = 0;
        const step = () => {
          seen += 1;
          if (seen >= count) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames
  );
}

test('canonical Brasov screenshots: noon, golden hour, night and mobile', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await waitFrames(page, 3);
    const noon = await screenshot(page, 'brasov-noon.png');
    const noonStats = await imageStats(page, fs.readFileSync(noon));

    await setMinute(page, 1245);
    await waitFrames(page, 3);
    const golden = await screenshot(page, 'brasov-golden.png');
    const goldenStats = await imageStats(page, fs.readFileSync(golden));

    await setMinute(page, 1410);
    await waitFrames(page, 3);
    const night = await screenshot(page, 'brasov-night.png');
    const nightStats = await imageStats(page, fs.readFileSync(night));

    for (const [name, stats] of [
      ['noon', noonStats],
      ['golden', goldenStats],
      ['night', nightStats]
    ]) {
      assert.equal(stats.width, DESKTOP.width, `${name} screenshot width`);
      assert.equal(stats.height, DESKTOP.height, `${name} screenshot height`);
      assert.ok(stats.colors > 100, `${name} screenshot looks blank (${stats.colors} colours)`);
      assert.ok(stats.stdDev > 8, `${name} screenshot has no contrast (${stats.stdDev})`);
    }
    assert.ok(
      noonStats.mean > 160,
      `daylight frame should be bright (mean ${noonStats.mean.toFixed(1)})`
    );
    assert.ok(
      nightStats.mean < 130,
      `night frame should be dark (mean ${nightStats.mean.toFixed(1)})`
    );
    assert.ok(
      noonStats.mean - nightStats.mean > 40,
      `day should be much brighter than night (${noonStats.mean.toFixed(1)} vs ${nightStats.mean.toFixed(1)})`
    );
    assert.ok(
      noonStats.mean > goldenStats.mean + 5,
      `golden hour should be warmer/darker than noon (${goldenStats.mean.toFixed(1)} vs ${noonStats.mean.toFixed(1)})`
    );
  });
});

test('mobile screenshot at 390x844', async () => {
  await withPage(
    async ({ page }) => {
      await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
      await waitFrames(page, 3);
      const file = await screenshot(page, 'brasov-mobile.png');
      const stats = await imageStats(page, fs.readFileSync(file));
      // deviceScaleFactor 2 => 780x1688 physical pixels
      assert.equal(stats.width, MOBILE.width * 2);
      assert.equal(stats.height, MOBILE.height * 2);
      assert.ok(stats.colors > 100, 'mobile screenshot looks blank');
      assert.ok(stats.stdDev > 8, 'mobile screenshot has no contrast');
    },
    { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  );
});

test('performance smoke at 1440x900 (SwiftShader): merged draw calls, triangles, fps', async (t) => {
  await withPage(async ({ page }) => {
    await gotoReady(page, 'city=gn:683844&date=2026-06-21&time=13:20');
    await page.waitForTimeout(2000);
    const debug = await readDebug(page);
    const state = await readState(page);
    t.diagnostic(
      `render: drawCalls=${debug.render.drawCalls} triangles=${debug.render.triangles} fps=${debug.render.fps.toFixed(1)}`
    );
    t.diagnostic(`model: ${debug.modelKey} buildings=${state.stats?.buildings ?? '?'} radius=${state.radiusM ?? '?'} m terrain=${state.terrain ? state.terrain.maxReliefM + ' m' : 'flat'}, phase=${state.phase}`);
    t.diagnostic(
      `camera: az=${debug.camera.azimuthDeg.toFixed(1)}° pitch=${debug.camera.pitchDeg.toFixed(1)}° zoom=${debug.camera.zoom}`
    );

    assert.equal(debug.modelKey, BRASOV.key);
    assert.ok(debug.render.drawCalls > 0);
    assert.ok(
      debug.render.drawCalls <= 13,
      `draw calls should stay merged (~8), got ${debug.render.drawCalls}`
    );
    assert.ok(
      debug.render.triangles > 250_000 && debug.render.triangles < 750_000,
      `expected the wide city mesh (250k–700k triangles), got ${debug.render.triangles}`
    );
    // FPS is reported raw: SwiftShader is far slower than a real GPU.
    assert.ok(debug.render.fps > 0, 'fps should be a positive number');
  });
});

test('accessibility basics: roles, accessible names, slider aria-valuetext', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page);

    // Search / locate / about buttons expose accessible names.
    await page.getByRole('button', { name: 'Search cities' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Use my location' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'About Sunlight' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /City: Brașov/ }).waitFor({ state: 'visible' });

    // Slider: labelled and value announced in words.
    const slider = page.getByRole('slider', { name: 'Time of day' });
    await slider.waitFor({ state: 'visible' });
    const valueText = await slider.getAttribute('aria-valuetext');
    assert.match(valueText ?? '', /^\d\d:\d\d local, /, 'slider aria-valuetext should announce time');
    const range = await slider.evaluate((element) => ({ min: element.min, max: element.max }));
    assert.equal(range.min, '0');
    assert.equal(range.max, '1439');

    // Playback controls.
    await page.getByRole('button', { name: 'Play the day' }).waitFor({ state: 'visible' });
    await page.getByRole('combobox', { name: 'Playback speed' }).waitFor({ state: 'visible' });

    // Date input is associated with a label.
    const dateInput = page.locator('[data-testid="date-input"]');
    const labelText = await dateInput.evaluate((element) =>
      Array.from(element.labels ?? [])
        .map((label) => label.textContent?.trim() ?? '')
        .join(' ')
    );
    assert.match(labelText, /Date/, 'date input needs a programmatic label');

    // Sun-path chart is an image with a descriptive label.
    const sunPath = page.getByRole('img', { name: /Sun altitude/ });
    await sunPath.waitFor({ state: 'visible' });

    // Page has a single top-level heading and a named document.
    assert.equal(await page.locator('h1').count(), 1);
    assert.match(await page.title(), /Sunlight/);

    // Focus ring appears for keyboard navigation.
    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    assert.notEqual(outline.style, 'none', 'keyboard focus should show a focus-visible outline');
    assert.ok(parseFloat(outline.width) >= 1, `focus outline width ${outline.width}`);
  });
});

test('dialog focus trap: focus enters search / About and Tab stays inside', async () => {
  await withPage(async ({ page }) => {
    await gotoReady(page);

    await page.locator('[data-testid="open-search"]').click();
    await page.waitForTimeout(150);
    const searchFocus = await page.evaluate(() => ({
      inside: !!document.activeElement?.closest('[data-testid="search-dialog"]'),
      id: document.activeElement?.getAttribute('data-testid')
    }));
    assert.equal(searchFocus.id, 'search-input', 'search should move focus to its input');
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page.evaluate(() => !!document.activeElement?.closest('[data-testid="search-dialog"]')),
      true,
      'Tab must stay trapped inside the search dialog'
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-testid="search-dialog"]').isVisible(), false);

    await page.locator('[data-testid="about-open"]').click();
    await page.waitForTimeout(150);
    const aboutFocus = await page.evaluate(() => ({
      inside: !!document.activeElement?.closest('[data-testid="about-dialog"]'),
      id: document.activeElement?.getAttribute('data-testid')
    }));
    assert.equal(aboutFocus.inside, true, 'About should move focus into the dialog');
    for (let i = 0; i < 15; i += 1) await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => !!document.activeElement?.closest('[data-testid="about-dialog"]')),
      true,
      'Tab must stay trapped inside the About dialog'
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-testid="about-dialog"]').isVisible(), false);
  });
});

test('reduced motion preference is honoured (no long transitions)', async () => {
  await withPage(
    async ({ page }) => {
      await gotoReady(page);
      const reduced = await page.evaluate(() => {
        const play = document.querySelector('[data-testid="play-toggle"]');
        const style = getComputedStyle(play);
        return {
          matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          transitionSeconds: parseFloat(style.transitionDuration) || 0,
          animationSeconds: parseFloat(style.animationDuration) || 0
        };
      });
      assert.equal(reduced.matches, true, 'Playwright reduced-motion emulation should match');
      assert.ok(
        reduced.transitionSeconds <= 0.02,
        `transitions should be suppressed with reduced motion (${reduced.transitionSeconds}s)`
      );
      assert.ok(
        reduced.animationSeconds <= 0.02,
        `animations should be suppressed with reduced motion (${reduced.animationSeconds}s)`
      );
    },
    { reducedMotion: 'reduce' }
  );
});

test('screenshots directory is populated', async () => {
  for (const name of ['brasov-noon.png', 'brasov-golden.png', 'brasov-night.png', 'brasov-mobile.png']) {
    assert.ok(fs.existsSync(`${SHOTS}/${name}`), `missing screenshot ${SHOTS}/${name}`);
  }
});
