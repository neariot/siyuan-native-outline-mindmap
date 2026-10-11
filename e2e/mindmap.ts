import { expect, type Page } from '@playwright/test';

/**
 * Interaction helpers for the mind map view.
 *
 * Everything goes through **real interaction** (click / mouse events / wheel / keyboard), never `page.evaluate`
 * to call internal functions —— that sidesteps the user's path and tests nothing.
 *
 * Background: synthesizing events through CDP's `dispatchMouseEvent` was measured to **never reach SiYuan's gesture logic**,
 * so the test "passed" while the control group did not move either (a false positive). Playwright input goes through the browser's real pipeline,
 * which is the main reason CDP was dropped.
 */

/**
 * ★★ Make sure the plugin panel **is open**.
 *
 * ## Why this step has to be explicit
 *
 * `.om-dock` / `.om-mm-viewswitch` exist in the DOM only while **the panel is open**.
 * Whether the panel is open is **SiYuan's own persisted layout state** (`uiLayout` in `conf.json`),
 * not something a page can decide.
 *
 * `openDoc` used to assert outright that they were visible —— it passed all the time on the user's machine,
 * because in that layout the panel **happened to be open**. Moving to a fresh workspace (E2E
 * now runs on the isolated instance) immediately turned into `element(s) not found`:
 * it looks like the plugin is broken, but in fact **the panel is not open**.
 *
 * So this explicitly clicks the plugin icon in the right dock. If it is already open, that is skipped.
 */
export async function ensureDockOpen(page: Page): Promise<void> {
  const view = page.locator('.om-mm-viewswitch');

  /**
   * Is the panel **really open** now?
   *
   * ★ The only valid criterion is `.om-mm-viewswitch` **width > 0**, not count / isVisible.
   *
   *   As measured (after switching documents):
   *     `.om-mm-viewswitch` exists in **both the open and the closed** state,
   *     display is flex either way and `isVisible()` is true as well ——
   *     the only difference is that **the width is 0 while closed** (SiYuan collapsed the dock).
   *
   *     after navigation   n=1  w=0     ← closed, yet the DOM is there and isVisible()=true
   *     after click 1      n=1  w=0
   *     after click 2      n=1  w=122   ← this is open
   *     after click 3      n=1  w=0     ← closed again (confirming it is a "toggle")
   *
   *   So the "visible" criterion is **false** here —— it counts the closed state as open,
   *   so it returned early, and every assertion after it timed out against a zero-width panel.
   *
   * `last()` is used because the old panel's DOM lingers briefly when switching documents (see the note below).
   */
  // ★★ You must query the DOM directly with `page.evaluate`, and **must not** use `locator.evaluate`.
  //
  //   `locator.evaluate` **waits for the element to appear** by itself (until the locator times out).
  //   And when the question is "is the panel open", the panel often **is not mounted yet** ——
  //   so that single query burns the whole timeout and drags the test down
  //   (the error is always `Target page ... has been closed` as measured,
  //    because the 120-second test timeout fires first and the page is torn down).
  //
  //   What is wanted is the instantaneous state right now: a miss is 0 and it returns immediately.
  const isOpen = async (): Promise<boolean> =>
    page
      .evaluate(() => {
        const all = document.querySelectorAll('.om-mm-viewswitch');
        const last = all[all.length - 1];
        return last ? last.getBoundingClientRect().width : 0;
      })
      .then((w) => w > 0)
      .catch(() => false);

  // Do not click if it is really open —— clicking **toggles** it and closes what is open.
  if (await isOpen()) return;

  // A toast over the dock swallows the clicks below (see `dismissSnackbars`).
  await dismissSnackbars(page);

  // ★★ The precondition, and the reason it is not the same question as "is it open".
  //
  //   `.om-mm-viewswitch` exists only once the plugin has registered its panel, so **attached** means
  //   "the plugin loaded". A closed panel is *legitimately* `display:none` with width 0, which is why
  //   visibility (`isVisible`, the first bounding box) cannot be used here —— it would report a
  //   correctly-closed panel as a failure.
  //
  //   Measured: the cold start after a fresh page load takes longer than the click loop's own 3 × 3s
  //   budget, so the loop could expire while the plugin was still mounting and report the panel as
  //   stuck. The two export cases that run first in their file failed that way while the rest passed.
  //   Waiting here separates "still loading" (wait, up to the same 60s `openDoc` allows for visibility)
  //   from "loaded but would not open" (the error below).
  await page
    .locator('.om-mm-viewswitch')
    .last()
    .waitFor({ state: 'attached', timeout: 60_000 })
    .catch(() => {
      throw new Error(
        'the plugin panel never mounted (.om-mm-viewswitch absent after 60s) —— the plugin did not load; ' +
          'check the browser console for an onload error',
      );
    });

  const entry = page.locator('[data-type*="native-outline-mindmap"]').first();
  await entry.waitFor({ state: 'visible', timeout: 30_000 });

  // Keep clicking until it is really open.
  //
  // ★ Why clicking twice may be needed: when switching documents SiYuan restores the panel from the **persisted layout**,
  //   and that state can be the opposite of what was just observed —— so the first click **closes** it.
  //   As the table above measures: after navigation it is closed, one click leaves it closed, the second click opens it.
  //
  //   `force: true` is used here: the dock icon carries a tooltip ("Mindmap / Click to expand/minimize"),
  //   and a plain click's actionability check is blocked by the tooltip or lands off target.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await entry.click({ force: true });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await isOpen()) return;
      await page.waitForTimeout(50);
    }
  }

  throw new Error(
    'after 3 clicks on the plugin entry the panel is still closed (.om-mm-viewswitch width stayed 0).' +
      'the plugin may have failed to load —— check the browser console for an onload error',
  );
}

/** Open a document (via URL, independent of which one is currently open in the UI). */
export async function openDoc(page: Page, docId: string): Promise<void> {
  await page.goto(`/?id=${docId}`);
  await page.waitForFunction(() => window.siyuan?.layout, undefined, { timeout: 60_000 });
  await ensureDockOpen(page);
  // ★ Wait for the panel to really render. The panel has **two legitimate shapes**:
  //
  //     - has content → `.om-dock` (the Outliner toolbar, with the bulk-action buttons)
  //     - empty document → `.om-mm-empty__title` ("This document has no content yet")
  //
  //   It used to assert `.om-dock` only, so **empty documents could never be opened**:
  //   the feature worked fine, yet the test timed out for 60 seconds already in openDoc.
  //   An empty document is legitimate input (a newly created one is), and the test infrastructure should not lock it out.
  //
  // ★★ But you **must not** write `.om-dock, .om-mm-empty__title` and then use `.first()`.
  //   When switching documents SiYuan does **not destroy** the old panel's DOM right away, so `<div class="om-dock">`
  //   lingers in the page with `display:none`, and since it comes first ⇒ `.first()`
  //   always selects that **old, hidden** node and waits until the timeout.
  //
  //   As measured (openDoc(A, which has content) → openDoc(B, an empty document)):
  //     112 × locator resolved to <div class="om-dock">…</div>
  //         - unexpected value "hidden"
  //
  //   So **visibility** is checked one by one instead of taking the first match.
  const dock = page.locator('.om-dock').last();
  const empty = page.locator('.om-mm-empty__title').last();
  await expect
    .poll(
      async () => (await dock.isVisible().catch(() => false)) || (await empty.isVisible().catch(() => false)),
      {
        message: 'the panel should render visible content (either the toolbar or the "This document has no content yet" empty state)',
        timeout: 60_000,
      },
    )
    .toBe(true);
  await expect(page.locator('.om-mm-viewswitch').last()).toBeVisible({ timeout: 30_000 });
}

/** Switch to the mind map view and wait for the canvas to appear. */
export async function toMindmapView(page: Page): Promise<void> {
  await dismissSnackbars(page);
  const btn = page.locator('.om-mm-viewswitch button', { hasText: '导图' });
  await btn.click();
  await expect(page.locator('.mm-canvas svg')).toBeVisible({ timeout: 30_000 });
  // There must be at least one node, otherwise the geometry assertions below are meaningless
  await expect(page.locator('.mm-node').first()).toBeVisible({ timeout: 30_000 });
}

/** Switch back to the outline view. */
export async function toOutlineView(page: Page): Promise<void> {
  await dismissSnackbars(page);
  await page.locator('.om-mm-viewswitch button', { hasText: '大纲' }).click();
  await expect(page.locator('.mm-canvas svg')).toHaveCount(0, { timeout: 15_000 });
}

/**
 * ★★ Make sure the toolbar is **expanded**.
 *
 * ## Why every helper that acts on the toolbar calls this first
 *
 * In a **narrow dock** the toolbar now starts collapsed (the first visit decides by dock width, see Mindmap.tsx).
 * The right dock the E2E suite uses is only 237px ⇒ `.mm-bar` is `display: none`,
 * so every `select` / `button` inside is **`attached` but unclickable**.
 *
 * The failure message looks like this and **looks exactly like the product being broken**:
 *
 *     locator resolved to <select>…</select>
 *       - element is not visible
 *
 * The product is actually right —— collapsing by default in a narrow dock is exactly the **intended** behavior
 * (expanding eats about 239px, and the panel is only 798px in total).
 * Getting the control into a clickable state is the **test helper's** job.
 *
 * Note the criterion is `isVisible()`: in a wide dock this toggle does not exist at all (`display:none`),
 * in which case there is nothing to do.
 */
/**
 * ★★ Dismiss SiYuan's transient toasts before any click in the dock.
 *
 * A snackbar (`#message .b3-snackbar`) is anchored over the dock and **intercepts pointer events**, so a
 * click on the plugin entry or on a toolbar button retries until the test times out:
 *
 *     <div data-type="textMenu" class="b3-snackbar__content …">…</div>
 *       … subtree intercepts pointer events
 *
 * Measured: the toast that did this read "block not found" for a document id the page had asked for after
 * the document had been replaced —— the message was correct, the panel was correct, and the only broken
 * thing was the click. So this is a precondition for clicking, not part of "is the panel open".
 *
 * SiYuan hides these on its own timer; clicking the close button is what a user does and is quicker. A
 * click that fails because the toast already vanished is fine here, and the toast still standing is *not*
 * swallowed: the next click then fails with Playwright's own "intercepts pointer events" message, which
 * names the cause.
 */
export async function dismissSnackbars(page: Page): Promise<void> {
  const closes = page.locator('#message .b3-snackbar__close');
  for (let left = await closes.count(); left > 0; left -= 1) {
    await closes
      .first()
      .click({ timeout: 2_000 })
      .catch(() => closes.first().evaluate((el: HTMLElement) => el.click()).catch(() => undefined));
  }
}

export async function ensureBarOpen(page: Page): Promise<void> {
  await dismissSnackbars(page);
  const toggle = page.locator('.om-mm-root .mm-bar-toggle');
  if (!(await toggle.isVisible().catch(() => false))) return; // wide dock: no toggle, it is expanded already
  const collapsed = await page.evaluate(() =>
    document.querySelector('.om-mm-root .mm-bar')?.classList.contains('mm-bar--collapsed'),
  );
  if (collapsed) {
    await toggle.click();
    await page.waitForTimeout(250);
  }
}

/** Current value of the structure dropdown. */
export function structureSelect(page: Page) {
  return page.locator('.mm-bar select').first();
}

/** Switch the structure (a real select interaction). */
export async function setStructure(page: Page, value: string): Promise<void> {
  await ensureBarOpen(page);
  const sel = structureSelect(page);
  await sel.selectOption(value);
  // Wait for the layout to be recomputed: the node count stays the same but positions change, and asserting on "transform changes" is hard to keep stable,
  // so waiting one render frame is enough here (Playwright's next query carries its own stability wait)
  await page.waitForTimeout(300);
}

/**
 * Geometric fingerprint of the mind map content —— the position and size of every node in **screen coordinates**.
 *
 * Screen coordinates rather than SVG-local ones: local coordinates do not include `translate/scale`,
 * so after switching between two structures the local coordinates can match while the displayed positions differ.
 */
export async function geometry(page: Page): Promise<{ id: string; x: number; y: number; w: number; h: number }[]> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.mm-node')];
    return nodes.map((n, i) => {
      const b = n.getBoundingClientRect();
      const label = (n.textContent ?? '').trim().slice(0, 12);
      return { id: `${i}:${label}`, x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
    });
  });
}

/** Bounding box of the whole mind map (all nodes), in screen coordinates. */
export async function contentBox(page: Page): Promise<{ l: number; t: number; r: number; b: number }> {
  return page.evaluate(() => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of document.querySelectorAll('.mm-node')) {
      const x = n.getBoundingClientRect();
      if (x.width <= 0) continue;
      l = Math.min(l, x.left); t = Math.min(t, x.top);
      r = Math.max(r, x.right); b = Math.max(b, x.bottom);
    }
    return { l, t, r, b };
  });
}

/** Screen rectangle of the canvas. */
export async function canvasBox(page: Page): Promise<{ l: number; t: number; r: number; b: number; w: number; h: number }> {
  return page.evaluate(() => {
    const svg = document.querySelector('.mm-canvas svg');
    if (!svg) throw new Error('could not find .mm-canvas svg');
    const b = svg.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
  });
}

/** Current zoom value (scale read from `<g transform>`). */
export async function currentScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const g = document.querySelector('.mm-canvas svg g[transform]');
    if (!g) return NaN;
    const m = /scale\(([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
    return m ? parseFloat(m[1]) : NaN;
  });
}

/**
 * ★ Scroll the settings bar horizontally until the given button is visible, then return it.
 *
 * Why this is necessary: `.om-mm-root .mm-bar` is `flex-wrap: nowrap; overflow-x: auto`,
 * while its available width in the dock is narrow (237px as measured) against 1131px of content.
 * So the right-hand buttons such as "Fit" and "Export image" **land outside the viewport** (x=1787 at 1440 wide),
 * `elementFromPoint` returns null and Playwright cannot click them.
 *
 * This is the current **real interaction path**: the user has to scroll the settings bar horizontally to reach these buttons.
 * The test does the same instead of masking the problem with `force: true`.
 */
export async function revealInBar(page: Page, text: string) {
  const btn = page.locator('.mm-bar button', { hasText: text }).first();
  await btn.waitFor({ state: 'attached', timeout: 15_000 });

  // First expand the collapsed toolbar (collapsed by default in a narrow dock, see `ensureBarOpen`)
  await ensureBarOpen(page);

  // Then scroll to the far right (the buttons sit at the right end of the bar)
  await page.evaluate(() => {
    const bar = document.querySelector('.mm-bar');
    if (bar) bar.scrollLeft = bar.scrollWidth;
  });
  await page.waitForTimeout(200);
  return btn;
}

/** Click a button in the settings bar (scrolling it into view first). */
export async function clickBarButton(page: Page, text: string): Promise<void> {
  const btn = await revealInBar(page, text);
  await btn.click({ timeout: 10_000 });
}

/** Observable state of the mind map right now. */
export interface MindmapState {
  nodes: number;
  badges: number;
  collapsed: number;
  selected: number;
  scale: number;
}

export async function mindmapState(page: Page): Promise<MindmapState> {
  return page.evaluate(() => {
    const g = document.querySelector('.mm-canvas svg g[transform]');
    const m = /scale\(([-\d.]+)\)/.exec(g?.getAttribute('transform') ?? '');
    return {
      nodes: document.querySelectorAll('.mm-node').length,
      badges: document.querySelectorAll('.mm-badge').length,
      collapsed: document.querySelectorAll('.mm-node.mm-collapsed').length,
      selected: document.querySelectorAll('.mm-node.mm-selected').length,
      scale: m ? parseFloat(m[1]) : NaN,
    };
  });
}

/**
 * Click the collapse button on one node.
 *
 * ★ You must hover **the node that owns it** first: the badge is normally
 * `opacity: 0; pointer-events: none`, and only under `.mm-node:hover` does it
 * become `opacity: 1; pointer-events: auto`. It is also extremely small (6×6 as measured),
 * so without hovering first it can never be clicked.
 */
export async function clickBadgeOn(page: Page, nodeIndex: number): Promise<void> {
  const node = page.locator('.mm-node').nth(nodeIndex);
  await node.hover();
  await page.waitForTimeout(300);
  await node.locator('.mm-badge').click({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** Find the index of the first node that has a collapse badge (-1 if none). */
export async function firstBadgeOwner(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.mm-node')];
    return nodes.findIndex((n) => n.querySelector('.mm-badge'));
  });
}

/**
 * Open the context menu on one node.
 *
 * ★ Returns the menu's **list of labels**, so callers can assert the menu contents along the way ——
 *   asserting only that "the menu appeared" would not notice a missing item.
 */
export async function openCtxMenu(page: Page, nodeIndex: number): Promise<string[]> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.locator('.mm-node').nth(nodeIndex).click({ button: 'right' });
  await page.waitForTimeout(600);
  return page.evaluate(() =>
    [...document.querySelectorAll('.mm-ctx-menu .mm-ctx-item')].map((x) =>
      (x.textContent || '').replace(/\s+/g, ' ').trim(),
    ),
  );
}

/** Click one item in the context menu (matched by its text). */
export async function clickCtxItem(page: Page, label: string): Promise<void> {
  await page.locator('.mm-ctx-menu .mm-ctx-item', { hasText: label }).first().click();
  await page.waitForTimeout(900);
}

/**
 * Measure the context menu's position and overflow relative to the **viewport**.
 *
 * ★ The criterion uses `window.innerWidth/Height`, not some ancestor container:
 *   the menu is an overlay, and the boundary the user can see is the viewport.
 */
export async function ctxMenuBox(page: Page): Promise<{
  x: number; y: number; right: number; bottom: number;
  width: number; height: number;
  overflowRight: number; overflowBottom: number; overflowLeft: number; overflowTop: number;
} | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.mm-ctx-menu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
      overflowRight: Math.max(0, Math.round(r.right - window.innerWidth)),
      overflowBottom: Math.max(0, Math.round(r.bottom - window.innerHeight)),
      overflowLeft: Math.max(0, Math.round(-r.left)),
      overflowTop: Math.max(0, Math.round(-r.top)),
    };
  });
}
