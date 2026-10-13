import { test, expect, waitForRendered } from './fixtures';

/**
 * Smoke: Playwright can drive a real SiYuan, and the plugin is really mounted.
 *
 * This suite is the premise of every other E2E —— if it fails, nothing else is worth looking at.
 */

test('the SiYuan UI loads completely in headless Chromium', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForRendered(page);

  await expect(page.locator('#toolbar')).toBeVisible();
  await expect(page.locator('.layout__center')).toBeVisible();
  await expect(page).toHaveTitle(/SiYuan|思源/);
});

/**
 * ★ This case is also the regression test for the "readiness gate".
 *
 * Asserting "the UI loaded" is not enough —— on the first probe every DOM check passed
 * while the screenshot was still the splash. So this asserts **what is on screen**, not just that elements exist.
 */
/**
 * ★ The readiness gate really does keep "frames not yet drawn" out.
 *
 * ## Why it became what it is now (the old one was flaky)
 *
 * The old form: right after `goto`, **grab one frame** and assert it has "colour count < 60".
 * That is a race against real loading —— the grabbed frame is early or late:
 *
 * - Grabbed early → pure splash (9 colours) → pass
 * - Grabbed a bit later → half-drawn UI (possibly > 60 colours) → **fail**
 *
 * Measured: one failure in three consecutive runs. **An assertion racing real timing can never be stable.**
 *
 * ## How it is tested now
 *
 * Split into two things that cannot interfere with each other:
 *
 * 1. **The threshold itself**: check the decision function with a fabricated "minimal frame". CSS turns the page
 *    nearly monochrome, so the measured statistics must land on the "not ready" side —— no race needed.
 * 2. **The real ready state**: after `waitForRendered` returns, confirm the real UI's statistics
 *    really **exceed** the threshold —— proof the gate does not mistake a good frame for a bad one.
 *
 * Only when both sides are covered can it be called "able to distinguish".
 */
test('the readiness gate distinguishes a splash frame from the real UI', async ({ page }) => {
  const { frameStats, waitForRendered, isReady } = await import('./fixtures');

  // ① Fabricate a "splash-like" minimal page: white background + one colour block
  //    The real splash measures 9 colours / brightness 31; here it only has to fall below the threshold,
  //    we do not simulate SiYuan's own splash (that would race real loading).
  await page.setContent(
    '<body style="margin:0;background:#fff">' +
      '<div style="position:absolute;left:40%;top:40%;width:120px;height:120px;background:#2f6fed"></div>' +
      '</body>',
  );
  const plain = await frameStats(page);
  // ★ Decide with the **real threshold function**, do not copy the numbers into the case ——
  //   a copy would keep this case green even if fixtures.ts's threshold changed, i.e. no verification at all.
  const wouldPass = isReady(plain);
  expect(
    wouldPass,
    `a minimal frame must not be judged ready (measured colours=${plain.colors} brightness=${plain.brightness.toFixed(1)})`,
  ).toBe(false);
  expect(plain.colors, 'a minimal frame should have very few distinct colours').toBeLessThan(30);

  // ② Real UI: wait for the gate to let it through, and confirm it really crossed the threshold
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForRendered(page);
  const ready = await frameStats(page);
  expect(isReady(ready), `the real UI should be judged ready (measured ${JSON.stringify(ready)})`).toBe(true);
});

test('the plugin is mounted into SiYuan', async ({ app }) => {
  // The evidence of mounting is the sidebar entry button, not `.om-dock` — the dock toolbar renders
  // only while the panel is open AND the outline view is mounted (see waitPluginReady's note:
  // using `.om-dock` burns 60s when the panel is closed). Never `.first()` a lingering hidden node.
  await expect(app.locator('[data-type*="native-outline-mindmap"]').first()).toBeVisible({ timeout: 60_000 });
});
