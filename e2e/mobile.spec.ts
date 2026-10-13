import { test, expect } from '@playwright/test';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import {
  mobileContext,
  openDocMobile,
  clickMobileBarAction,
  mobileKeyboardBarState,
  simulateIosKeyboard,
  simulateVisualViewportScroll,
  dismissIosKeyboard,
  verifyPreventSwipe,
  ensureToolbarOpen,
} from './mobile';
import { outlineState, ensureOutlineReady, getNodeTexts } from './outline';
import { siyuanUrl, siyuanToken } from './env';

/**
 * Comprehensive E2E suite for mobile (iOS Safari / mobile shell).
 */
test.describe('Mobile E2E tests', () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();

  let tempDocId = '';
  let api: Awaited<ReturnType<typeof kernelApi>>;

  test.beforeAll(async () => {
    api = await kernelApi(baseURL, token);
  });

  test.afterAll(async () => {
    if (api) await api.dispose();
  });

  test.afterEach(async () => {
    // ★ Failures throw like every other suite: swallowing them leaves undeleted documents with
    //   nothing said (and the leftover report then blames a later case for the wrong reason).
    if (tempDocId && api) {
      await removeDoc(api, tempDocId);
      tempDocId = '';
    }
  });

  test('① the mobile shell is ready and the outline panel opens from the bottom menu', async ({ browser }) => {
    const notebook = await resolveTestNotebook(api);
    tempDocId = await createTempDoc(
      api,
      notebook,
      `- 根节点一
  - 子主题一
  - 子主题二
- 节点一
`,
    );

    const ctx = await mobileContext(browser, baseURL);
    const page = await ctx.newPage();
    try {
      await openDocMobile(page, baseURL, tempDocId);
      await ensureOutlineReady(page);

      const st = await outlineState(page);
      expect(st.rows).toBe(4);

      const texts = await getNodeTexts(page);
      expect(texts).toContain('根节点一');
      expect(texts).toContain('子主题一');
      expect(texts).toContain('子主题二');
      expect(texts).toContain('节点一');
    } finally {
      await ctx.close();
    }
  });

  test('② mobile virtual-keyboard bar buttons: add sibling, add child, task, indent and outdent', async ({ browser }) => {
    const notebook = await resolveTestNotebook(api);
    tempDocId = await createTempDoc(api, notebook, `- 主题甲\n`);

    const ctx = await mobileContext(browser, baseURL);
    const page = await ctx.newPage();
    try {
      await openDocMobile(page, baseURL, tempDocId);
      await ensureOutlineReady(page);

      // 1. Focus the first node
      const firstRow = page.locator('.om-outline-wrap .node-row').first();
      await firstRow.locator('.node-text').click();
      await page.waitForTimeout(200);

      const initialCount = (await outlineState(page)).rows;
      expect(initialCount).toBe(1);

      // 2. Click "Add sibling topic" (↵)
      await clickMobileBarAction(page, 'sibling');
      await page.keyboard.type('同级主题二');
      await page.waitForTimeout(250);

      let st = await outlineState(page);
      expect(st.rows).toBe(2);
      let texts = await getNodeTexts(page);
      expect(texts).toContain('同级主题二');

      // 3. Click "Add subtopic" (↳)
      await clickMobileBarAction(page, 'child');
      await page.keyboard.type('子主题节点八');
      await page.waitForTimeout(250);

      st = await outlineState(page);
      expect(st.rows).toBe(3);
      texts = await getNodeTexts(page);
      expect(texts).toContain('子主题节点八');

      // 4. Click "Toggle task status" (☑)
      // ★ Assert the plugin's own task box, not any checkbox on the page: a bare
      //   `input[type="checkbox"]` matches SiYuan chrome too, so the case cannot tell "the
      //   plugin's task box appeared" from "some checkbox exists somewhere".
      await clickMobileBarAction(page, 'task');
      await page.waitForTimeout(250);
      const hasTask = await page.locator('.taskbox').count();
      expect(hasTask, 'the plugin task box should appear after toggling').toBeGreaterThan(0);

      // 5. Click "Promote left" (⇤)
      await clickMobileBarAction(page, 'outdent');
      await page.waitForTimeout(250);

      // 6. Click "Indent right" (⇥)
      await clickMobileBarAction(page, 'indent');
      await page.waitForTimeout(250);

      // 7. Click the done button (✓) to close the editor
      await clickMobileBarAction(page, 'done');
      await page.waitForTimeout(200);
    } finally {
      await ctx.close();
    }
  });

  test('③ with the iOS Safari soft keyboard up and the viewport panned, the keyboard bar stays locked and the viewport does not drift', async ({ browser }) => {
    const notebook = await resolveTestNotebook(api);
    tempDocId = await createTempDoc(
      api,
      notebook,
      `- 节点 1
- 节点 2
- 节点 3
- 节点 4
- 节点 5
- 节点 6
- 节点 7
- 节点 8
`,
    );

    const ctx = await mobileContext(browser, baseURL);
    const page = await ctx.newPage();
    try {
      await openDocMobile(page, baseURL, tempDocId);
      await ensureOutlineReady(page);

      // Initial state: no soft keyboard, the keyboard bar sits at the bottom of the screen at 0px
      let bar = await mobileKeyboardBarState(page);
      expect(bar.visible).toBe(true);
      expect(bar.bottom).toBe('0px');
      expect(bar.isOpen).toBe(false);

      // Verify the outline container's bottom edge must always stay above the keyboard bar's top edge (content must never scroll under the toolbar)
      const checkOutlineAboveBar = async (desc: string) => {
        const bounds = await page.evaluate(() => {
          const wrap = document.querySelector('.om-outline-wrap');
          const barEl = document.querySelector('.mobile-keyboard-bar');
          if (!wrap || !barEl) return null;
          return {
            wrapBottom: Math.round(wrap.getBoundingClientRect().bottom),
            barTop: Math.round(barEl.getBoundingClientRect().top),
          };
        });
        expect(bounds, desc).not.toBeNull();
        if (bounds) {
          expect(bounds.wrapBottom, `${desc}: the outline bottom edge (${bounds.wrapBottom}) must be above the keyboard bar top edge (${bounds.barTop})`).toBeLessThanOrEqual(bounds.barTop + 1);
        }
      };

      await checkOutlineAboveBar('with no soft keyboard');

      // Focus a node to trigger input
      const row = page.locator('.om-outline-wrap .node-row').nth(4);
      await row.locator('.node-text').click();
      await page.waitForTimeout(200);

      // Simulate the iOS Safari soft keyboard popping up (336px)
      await simulateIosKeyboard(page, 336);
      bar = await mobileKeyboardBarState(page);
      expect(bar.isOpen).toBe(true);
      expect(bar.bottom).toBe('336px');
      await checkOutlineAboveBar('with the soft keyboard up');

      // Verify window.scrollY stays pinned to 0 while the keyboard is up (no whole-page drift / flicker)
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(0);

      // Simulate iOS Safari panning the visualViewport while typing (offsetTop becomes 120px)
      await simulateVisualViewportScroll(page, 120);
      bar = await mobileKeyboardBarState(page);
      // The keyboard bar must stay locked at 336px and never sink under the keyboard because offsetTop decays
      expect(bar.bottom).toBe('336px');

      // Simulate tapping Done or the soft keyboard retracting
      await dismissIosKeyboard(page);
      bar = await mobileKeyboardBarState(page);
      expect(bar.bottom).toBe('0px');
      expect(bar.isOpen).toBe(false);
      await checkOutlineAboveBar('after the soft keyboard retracts');
    } finally {
      await ctx.close();
    }
  });

  test('④ both the mobile outline and mindmap containers set data-prevent-swipe to guard gestures', async ({ browser }) => {
    const notebook = await resolveTestNotebook(api);
    tempDocId = await createTempDoc(api, notebook, `- 拖动测试分支\n  - 子项\n`);

    const ctx = await mobileContext(browser, baseURL);
    const page = await ctx.newPage();
    try {
      await openDocMobile(page, baseURL, tempDocId);
      await ensureOutlineReady(page);

      const swipeAttr = await verifyPreventSwipe(page);
      expect(swipeAttr.outlinePreventSwipe).toBe('true');

      // Switching to the mindmap view should likewise have data-prevent-swipe="true".
      // ★ No silent skip: the old shape wrapped this in a visibility `if` with a swallowed error,
      //   so an invisible view-switch left the canvas assertion unrunned and still passed. The switch
      //   must be visible — its absence is itself a defect in this flow.
      const viewSwitch = page.locator('.om-mm-viewswitch button', { hasText: '导图' }).last();
      await expect(viewSwitch, 'the view switch must be visible').toBeVisible({ timeout: 10_000 });
      await viewSwitch.click();
      await page.waitForTimeout(500);
      const swipeAttrAfter = await verifyPreventSwipe(page);
      expect(swipeAttrAfter.canvasPreventSwipe).toBe('true');
    } finally {
      await ctx.close();
    }
  });

  test('⑤ the mobile narrow-screen format toolbar toggles open and keeps its state', async ({ browser }) => {
    const notebook = await resolveTestNotebook(api);
    tempDocId = await createTempDoc(api, notebook, `- 格式栏节点\n`);

    const ctx = await mobileContext(browser, baseURL);
    const page = await ctx.newPage();
    try {
      await openDocMobile(page, baseURL, tempDocId);
      await ensureOutlineReady(page);

      // Expand the format toolbar
      await ensureToolbarOpen(page);
      const isCollapsed = await page.evaluate(() => {
        const tb = document.querySelector('.om-toolbar');
        return tb ? tb.classList.contains('om-toolbar--collapsed') : true;
      });
      expect(isCollapsed).toBe(false);
      // ★ "keeps its state" needs a second read after a settle: asserting once, immediately,
      //   cannot tell "stays open" from "opens then collapses".
      await page.waitForTimeout(800);
      const stillOpen = await page.evaluate(() => {
        const tb = document.querySelector('.om-toolbar');
        return tb ? !tb.classList.contains('om-toolbar--collapsed') : false;
      });
      expect(stillOpen, 'the toolbar must stay open, not just open momentarily').toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
