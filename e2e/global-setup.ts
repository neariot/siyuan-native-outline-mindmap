import { chromium, request } from '@playwright/test';
import { siyuanUrl } from './env';

/**
 * E2E global setup.
 *
 * ## Why it is needed
 *
 * Both "is the kernel running" and "warm up" used to be crammed into every case, which caused two problems:
 *
 * 1. **The error when the kernel is not running is hard to understand.** A case times out after 60 s on `goto`,
 *    then tells you "test timeout" —— you cannot tell that the real cause is SiYuan not being started.
 *    Probing once here states plainly whatever is missing.
 * 2. **The first case pays for the cold start.** Measured: the first case takes 1.2 minutes (failing on timeout),
 *    the following ones need only 6~28 seconds. Cold start covers browser launch + SiYuan frontend first load.
 *    Warming up here puts every case on the same starting line.
 *
 * Note: test documents are not created here. `ensureTestDoc` **deletes and recreates** the document every time
 * (reason in testdoc.ts), so the document id changes each time and the warm-up phase cannot get a stable id.
 */

const BASE = siyuanUrl();

export default async function globalSetup(): Promise<void> {
  // ① Is the kernel running —— if not, say so; never let it become a puzzling timeout
  const api = await request.newContext({ baseURL: BASE });
  try {
    const r = await api.get('/api/system/version', { timeout: 10_000 });
    if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
  } catch (e) {
    await api.dispose();
    throw new Error(
      `The SiYuan kernel is not running (${BASE}): ${(e as Error).message}\n` +
        `Start SiYuan first, or point SIYUAN_URL in .env at the correct address.`,
    );
  }
  await api.dispose();

  // ② Warm up: load the SiYuan frontend once, so the cold-start cost is paid here
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => {
        const s = (window as unknown as { siyuan?: { layout?: unknown } }).siyuan;
        return !!(s && s.layout);
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.screenshot({ path: '.tmp/e2e-warmup.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
}
