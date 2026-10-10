import { test as base, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Open SiYuan and make sure it is genuinely interactive.
 *
 * ## Why the DOM alone is not enough
 *
 * The lesson recorded in `AGENTS.md` was hit again here:
 * Right after `domcontentloaded`, `#toolbar` / `.dock` / `.protyle`
 * **all already exist, `getComputedStyle` also reports visible, and `getBoundingClientRect()` also has a size**,
 * yet the screenshot is a **splash screen** (only the SiYuan logo) ——
 * the elements are in the DOM, but what the user sees is still the loading screen.
 *
 * As measured that time: every DOM check passed, yet the screenshot was a pure splash screen.
 * So this gate requires the **picture itself** to prove the app has been drawn.
 *
 * ## The thresholds are measured, not guessed
 *
 * Measured difference between the splash screen and the ready state (1440×900, `scale: 'css'`):
 *
 * | State | Colors | Avg brightness | Screenshot bytes |
 * |---|---|---|---|
 * | Splash (0–1s) | 9 | 31 | 7.7 KB |
 * | Ready (from 3s) | 132 | 249.5 | 121 KB |
 *
 * All three separate cleanly, so take "colors > 30, brightness > 100",
 * which leaves margin on both sides (a switch to a dark theme will not misjudge it —— when truly ready the structural complexity is still there).
 */

/** Frame statistics: number of distinct colors, average brightness, screenshot byte size. */
export async function frameStats(page: Page): Promise<{ colors: number; brightness: number; bytes: number }> {
  const buf = await page.screenshot({ scale: 'css' });
  const png = PNG.sync.read(buf);
  const seen = new Set<number>();
  let sum = 0;
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4 * 97) {
    seen.add((png.data[i] >> 4) * 4096 + (png.data[i + 1] >> 4) * 64 + (png.data[i + 2] >> 4));
    sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    n++;
  }
  return { colors: seen.size, brightness: sum / n, bytes: buf.byteLength };
}

export const READY_COLORS = 30;
export const READY_BRIGHTNESS = 100;

/**
 * The **only** exit for the readiness decision.
 *
 * ★ It must exist in exactly this one place: `waitForRendered` and the test that verifies it both go through here.
 *   If a test copies the thresholds again, changing the values here still leaves that test green ——
 *   which means that test is not verifying the gate at all.
 */
export function isReady(stats: { colors: number; brightness: number }): boolean {
  return stats.colors > READY_COLORS && stats.brightness > READY_BRIGHTNESS;
}

/** Wait until the frame is actually drawn (not a splash screen). */
export async function waitForRendered(page: Page, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = { colors: 0, brightness: 0, bytes: 0 };
  while (Date.now() < deadline) {
    last = await frameStats(page);
    if (isReady(last)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `waited ${timeout}ms and the frame is still not ready (last frame colors=${last.colors} brightness=${last.brightness.toFixed(1)}) ——` +
      `it appears still stuck on the splash screen, or SiYuan did not start properly`,
  );
}

/** Open SiYuan and return a page that is ready. */
export async function openSiYuan(page: Page, opts: { url?: string } = {}): Promise<void> {
  await page.goto(opts.url ?? '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // ① App object is ready
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { siyuan?: { layout?: unknown } }).siyuan;
      return !!(s && s.layout);
    },
    undefined,
    { timeout: 60_000 },
  );

  // ② Top-level layout is visible (this step catches "in the DOM but hidden")
  await expect(page.locator('.layout__center')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#toolbar')).toBeVisible({ timeout: 30_000 });

  // ③ ★ The frame is really drawn —— every earlier step can pass and it can still be a splash screen
  await waitForRendered(page);
}

/**
 * Wait for the plugin to finish mounting.
 *
 * ★ Do not go looking for `window.siyuan.plugins` —— **that object does not exist**
 *   (as measured, `typeof siyuan.plugins === 'undefined'`,
 *   and the top-level keys are only layout / config / ws / user and the like).
 *   SiYuan does not hang its loaded plugins off `siyuan`, so that signal cannot be found.
 *
 * ★★ Nor can `.om-dock` be used (that is what this used to do, and **it is wrong**).
 *
 *   As measured (initial page, no panel open):
 *     .om-dock            0 matches   ← it renders only when the **panel is open and has content**
 *     .om-mm-viewswitch   0 matches   ← likewise only inside the panel
 *     .om-mm-host         0 matches
 *     [data-type*=…]      1 match     ← the real entry button, present as soon as the plugin is mounted
 *
 *   `.om-dock` is the Outliner's internal toolbar (inside the panel),
 *   not the sidebar entry button. Using it as the criterion for "plugin loaded"
 *   burns a full 60 seconds of waiting when the panel is closed —— and that is exactly this fixture's job,
 *   so **every test** pays that timeout first.
 *
 *   The real signal is the Dock entry button the plugin registers: SiYuan renders a
 *   span with `data-type="<plugin name><dockId>"`, which exists once the plugin's onload finishes.
 */
export async function waitPluginReady(page: Page): Promise<void> {
  await expect(
    page.locator('[data-type*="native-outline-mindmap"]').first(),
    'the plugin sidebar entry button never appeared —— the plugin may be disabled, or its onload threw and it never loaded',
  ).toBeVisible({ timeout: 60_000 });
}

/**
 * ## Why browser contexts are **not** reused (tried it, reverted it)
 *
 * To save reloading cold for every test, the context was once switched to worker-level reuse.
 * The effect was most tests dropping from 10~60 seconds to 4~6 seconds, but it **introduced new instability**:
 *
 * - Running the full suite started producing `beforeEach` timeouts —— the page snapshot showed SiYuan had in fact already loaded,
 *   it was `.om-dock` / `.om-mm-viewswitch` that never appeared;
 * - A different test failed every time (this run "plain wheel scroll", next run "mind map view renders nodes"),
 *   the classic signature of **cross-test state leakage**.
 *
 * The cause: SiYuan is a live application, and reusing localStorage at context level makes it restore the previous
 * UI layout —— once the plugin panel is in an "unmounted" layout,
 * later tests wait forever and never see it.
 *
 * Conclusion: **isolation matters more than saving those few seconds**. One new context per test,
 * and the cold-start bill is paid by the warm-up in `global-setup.ts` (as measured, the first test
 * dropped from a 1.2-minute timeout to 11.9 seconds).
 */

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await openSiYuan(page);
    await waitPluginReady(page);
    await use(page);
  },
});

export { expect };
