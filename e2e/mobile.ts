import { expect, type Browser, type BrowserContext, type Page, devices } from '@playwright/test';

/**
 * Interaction helpers for the mobile E2E —— alongside `mindmap.ts` (desktop), with the **same interface contract**.
 *
 * ## Why mobile gets its own file
 *
 * The desktop helpers assume three things from the start; on mobile **none of the three holds**:
 *
 * | Assumption | Desktop | Mobile reality |
 * |---|---|---|
 * | Frontend entry | `/` → 302 → `stage/build/desktop/` | The same address is split by **UA**, so you must go through `/stage/build/mobile/` explicitly |
 * | Ready condition | `window.siyuan.layout` exists | It **also exists** under the mobile shell, but the panel entry is completely different |
 * | Opening the panel | Click the right-side dock icon | There is no right sidebar ⇒ go "bottom toolbar → More (#toolbarMore) → Native Outline & Mindmap" |
 *
 * Collects the mobile-specific pieces:
 * - shell readiness and page navigation
 * - opening the plugin panel and switching views
 * - virtual keyboard pop-up (visualViewport simulation and real-device response)
 * - soft-keyboard accessory bar operations (add sibling/child, task, note, H1, indent/outdent, move up/down)
 * - touch gestures and the `data-prevent-swipe` guard against accidental swipes
 */

/** Mobile viewport size (CSS pixels). Defaults to the iPhone 12/13/14 portrait size. */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/**
 * Open a **mobile** browser context.
 *
 * ★ The key is `isMobile: true`: the SiYuan kernel splits the frontend by `User-Agent`.
 * `devices['iPhone 12']` brings UA / deviceScaleFactor / hasTouch / isMobile all at once.
 */
export async function mobileContext(browser: Browser, baseURL?: string): Promise<BrowserContext> {
  return browser.newContext({
    ...devices['iPhone 12'],
    ...(baseURL ? { baseURL } : {}),
  });
}

/** Mobile page address —— **goes through the mobile build explicitly**, never letting the kernel guess from the UA. */
export function mobileUrl(baseURL: string, docId: string): string {
  return `${baseURL.replace(/\/$/, '')}/stage/build/mobile/?id=${docId}`;
}

/**
 * Wait until the mobile shell is ready.
 */
export async function waitMobileReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as { siyuan?: unknown }).siyuan,
    undefined,
    { timeout: 60_000 },
  );
  await expect(page.locator('#mobileBottomBar, #mobileTopBar, #toolbarMore').first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Open the plugin panel on mobile.
 *
 * Mobile has no right-side dock icon like the desktop, so it goes through the bottom "More" menu:
 *     bottom toolbar "More" (#toolbarMore) → plugin dock item ([data-type="mobile-plugin-dock"])
 */
export async function openPluginMobile(page: Page): Promise<void> {
  if (await page.locator('.om-mm-host').count()) return;

  const more = page.locator('#toolbarMore').first();
  await more.waitFor({ state: 'visible', timeout: 30_000 });
  await more.click({ force: true });

  const dock = page
    .locator('[data-type="mobile-plugin-dock"], .b3-menu__item:has-text("原生大纲导图")')
    .first();
  await dock.waitFor({ state: 'visible', timeout: 15_000 });
  await dock.click();

  await expect(page.locator('.om-mm-host')).toBeVisible({ timeout: 45_000 });
}

/**
 * Mobile: open the document + open the plugin panel, in one step.
 */
export async function openDocMobile(page: Page, baseURL: string, docId: string): Promise<void> {
  await page.goto(mobileUrl(baseURL, docId));
  await waitMobileReady(page);
  await openPluginMobile(page);
}

/**
 * Mobile: make sure the **top format toolbar** is expanded.
 */
export async function ensureToolbarOpen(page: Page): Promise<void> {
  const toggle = page.locator('.om-toolbar-toggle').last();
  if (!(await toggle.isVisible().catch(() => false))) return;
  const collapsed = await page.evaluate(() =>
    document
      .querySelectorAll('.om-toolbar')[document.querySelectorAll('.om-toolbar').length - 1]
      ?.classList.contains('om-toolbar--collapsed'),
  );
  if (collapsed) {
    await toggle.click();
    await page.waitForTimeout(250);
  }
}

export type MobileBarAction =
  | 'sibling'
  | 'child'
  | 'task'
  | 'note'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'body'
  | 'outdent'
  | 'indent'
  | 'moveUp'
  | 'moveDown'
  | 'bold'
  | 'done';

/**
 * Click the given action button on the mobile virtual-keyboard accessory bar (`.mobile-keyboard-bar`).
 */
export async function clickMobileBarAction(page: Page, action: MobileBarAction): Promise<void> {
  const bar = page.locator('.mobile-keyboard-bar');
  await expect(bar).toBeVisible({ timeout: 10_000 });

  let selector = '';
  switch (action) {
    case 'sibling':
      selector = "button[title*='添加同级主题'], button[aria-label*='添加同级主题']";
      break;
    case 'child':
      selector = "button[title*='添加子主题'], button[aria-label*='添加子主题']";
      break;
    case 'task':
      selector = "button[title*='切换待办状态'], button[aria-label*='切换待办状态']";
      break;
    case 'note':
      selector = "button[title*='添加/切换备注一'], button[aria-label*='添加/切换备注一']";
      break;
    case 'h1':
      selector = "button[title*='标题1'], button[aria-label*='标题1']";
      break;
    case 'h2':
      selector = "button[title*='标题2'], button[aria-label*='标题2']";
      break;
    case 'h3':
      selector = "button[title*='标题3'], button[aria-label*='标题3']";
      break;
    case 'body':
      selector = "button[title*='正文'], button[aria-label*='正文']";
      break;
    case 'outdent':
      selector = "button[title*='向左提升'], button[aria-label*='向左提升']";
      break;
    case 'indent':
      selector = "button[title*='向右缩进'], button[aria-label*='向右缩进']";
      break;
    case 'moveUp':
      selector = "button[title*='上移'], button[aria-label*='上移']";
      break;
    case 'moveDown':
      selector = "button[title*='下移'], button[aria-label*='下移']";
      break;
    case 'bold':
      selector = "button[title*='加粗'], button[aria-label*='加粗']";
      break;
    case 'done':
      selector = 'button.done-btn';
      break;
  }

  const btn = bar.locator(selector).first();
  await btn.waitFor({ state: 'visible', timeout: 5_000 });
  await btn.click();
  await page.waitForTimeout(200);
}

/**
 * Read the current state of the mobile keyboard accessory bar.
 */
export async function mobileKeyboardBarState(
  page: Page,
): Promise<{ visible: boolean; bottom: string; height: number; isOpen: boolean }> {
  return page.evaluate(() => {
    const el = document.querySelector('.mobile-keyboard-bar') as HTMLElement | null;
    if (!el) return { visible: false, bottom: '', height: 0, isOpen: false };
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      visible: cs.display !== 'none' && rect.height > 0,
      bottom: cs.bottom,
      height: Math.round(rect.height),
      isOpen: el.classList.contains('keyboard-open'),
    };
  });
}

/**
 * Simulate the iOS Safari soft keyboard popping up (shrink visualViewport and dispatch a resize event).
 * @param keyboardHeight simulated keyboard height (default 336px)
 */
export async function simulateIosKeyboard(page: Page, keyboardHeight = 336): Promise<void> {
  await page.evaluate((kbH) => {
    if (window.visualViewport) {
      const origHeight = window.innerHeight;
      const newHeight = Math.max(200, origHeight - kbH);
      Object.defineProperty(window.visualViewport, 'height', { value: newHeight, configurable: true });
      Object.defineProperty(window.visualViewport, 'offsetTop', { value: 0, configurable: true });
      window.visualViewport.dispatchEvent(new Event('resize'));
    }
  }, keyboardHeight);
  await page.waitForTimeout(100);
}

/**
 * Simulate the iOS Safari soft keyboard dismissing (restore the visualViewport height).
 */
export async function dismissIosKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.visualViewport) {
      Object.defineProperty(window.visualViewport, 'height', { value: window.innerHeight, configurable: true });
      Object.defineProperty(window.visualViewport, 'offsetTop', { value: 0, configurable: true });
      window.visualViewport.dispatchEvent(new Event('resize'));
    }
  });
  await page.waitForTimeout(100);
}

/**
 * Simulate iOS Safari page scrolling / visual viewport panning (offsetTop changes).
 */
export async function simulateVisualViewportScroll(page: Page, offsetTop: number): Promise<void> {
  await page.evaluate((top) => {
    if (window.visualViewport) {
      Object.defineProperty(window.visualViewport, 'offsetTop', { value: top, configurable: true });
      window.visualViewport.dispatchEvent(new Event('scroll'));
    }
  }, offsetTop);
  await page.waitForTimeout(100);
}

/**
 * Verify the `data-prevent-swipe` guard attribute on the outline and mindmap containers (prevents the sidebar from sliding out).
 */
export async function verifyPreventSwipe(
  page: Page,
): Promise<{ canvasPreventSwipe: string | null; outlinePreventSwipe: string | null }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.mm-canvas');
    const outline = document.querySelector('.om-outline-wrap');
    return {
      canvasPreventSwipe: canvas ? canvas.getAttribute('data-prevent-swipe') : null,
      outlinePreventSwipe: outline ? outline.getAttribute('data-prevent-swipe') : null,
    };
  });
}
