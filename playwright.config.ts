import { chromiumPath, siyuanUrl } from './e2e/env';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration -- drive a real SiYuan with a real browser.
 *
 * ## What has to be running first
 *
 * The SiYuan kernel must be up (it serves both the UI and the API), and the plugin must be deployed:
 *
 *     npm run deploy
 *     npm run test:e2e
 *
 * ## Why Electron is not started
 *
 * The desktop build is an Electron shell, but **the real UI is served by the kernel over HTTP**
 * (`http://<kernel>/` -> 302 -> `/stage/build/desktop/`).
 * So Playwright's own Chromium can open that address directly:
 *
 * - no Electron and no Xvfb needed (genuinely headless)
 * - it neither occupies nor depends on the CDP port that is already in use
 * - it does not depend on "the user happens to have a page open" -- every run is a clean context
 *
 * Measured cold start (launch Chromium -> UI interactive): about 11 seconds.
 *
 * ## Which browser gets launched
 *
 * `CHROMIUM_PATH` from `.env` (injected by `scripts/run-e2e.py`), **required, no default** --
 * see `chromiumPath()` in `e2e/env.ts` for why a silent switch is not acceptable.
 * A Playwright-managed download is often not cached, so pointing at a browser that is already
 * installed avoids a few hundred MB per machine.
 */
export default defineConfig({
  testDir: './e2e',
  // Probe the kernel and warm it up first, so the first case does not pay the cold-start bill for everyone
  globalSetup: './e2e/global-setup.ts',
  // Every E2E case shares one kernel: run serially so they do not fight over document focus
  workers: 1,
  fullyParallel: false,
  // ★ Do not set this too low: a fixture waits several times in sequence (goto / siyuan.layout / dock / tab / canvas),
  //   and on a cold start their **sum** exceeds any single-step timeout -- 60s was measured to hang the first case.
  timeout: 120_000,
  expect: { timeout: 10_000 },

  // Retry once on failure: E2E has real async timing, so a retry settles an occasional flicker
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    // No default -- a guessed target may be the user's instance, and E2E really creates and deletes documents.
    baseURL: siyuanUrl(),
    viewport: { width: 1440, height: 900 },
    // Keep evidence on failure: screenshot + trace
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: chromiumPath(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
