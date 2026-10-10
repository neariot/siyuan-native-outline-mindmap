import { test, expect, type Page } from './fixtures';
import {
  openDoc, toMindmapView, toOutlineView, setStructure, clickBarButton,
  mindmapState, clickBadgeOn, firstBadgeOwner, currentScale, canvasBox,
} from './mindmap';
import { kernelApi, ensureTestDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

/**
 * Interaction E2E —— click, drag, scroll, collapse, switch.
 *
 * ## Why this suite exists
 *
 * Everything used to rely on CDP `dispatchMouseEvent` synthetic events, which by measurement **never enter SiYuan's gesture logic**:
 * the test "passed" while the control group did not move either —— a false positive.
 * Playwright's input goes through the browser's real event pipeline, which is what makes this suite meaningful.
 *
 * ## Every assertion demands that the state really changed
 *
 * It does not assert "the click raised no error", but that the node count, the selected class and scale, these
 * **observable states**, really changed as expected. Only then does a broken implementation go red.
 */

let DOC = '';
let notebook = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  try {
    notebook = await resolveTestNotebook(api);
    DOC = await ensureTestDoc(api, notebook);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  await openDoc(page, DOC);
  await toMindmapView(page);
});

test('clicking a node marks it as selected, and only one is selected', async ({ page }) => {
  const before = await mindmapState(page);
  expect(before.selected, 'no node should be selected initially').toBe(0);

  await page.locator('.mm-node').nth(1).click();
  await page.waitForTimeout(300);

  const after = await mindmapState(page);
  expect(after.selected, 'one click should leave exactly one node selected').toBe(1);
  expect(after.nodes, 'selection should not change the node count').toBe(before.nodes);
});

test('selection moves with the click and does not accumulate', async ({ page }) => {
  await page.locator('.mm-node').nth(1).click();
  await page.waitForTimeout(200);
  const first = await page.evaluate(() =>
    document.querySelector('.mm-node.mm-selected')?.getAttribute('data-node-id'),
  );

  await page.locator('.mm-node').nth(2).click();
  await page.waitForTimeout(200);
  const second = await page.evaluate(() =>
    document.querySelector('.mm-node.mm-selected')?.getAttribute('data-node-id'),
  );

  expect(second, 'it should have switched to another node').not.toBe(first);
  expect(await mindmapState(page).then((s) => s.selected), 'there is still exactly one selected').toBe(1);
});

/**
 * ★ Clicking the collapse button really collapses (the descendants disappear from the canvas).
 *
 * Background: the badge normally has `opacity:0; pointer-events:none`,
 * so the node that owns it must be hovered first to click it —— that is the real interaction path.
 */
test('clicking the collapse button really folds the child branch away', async ({ page }) => {
  const owner = await firstBadgeOwner(page);
  expect(owner, 'a node with a collapse button should exist').toBeGreaterThanOrEqual(0);

  const before = await mindmapState(page);
  expect(before.collapsed, 'no collapsed node initially').toBe(0);

  await clickBadgeOn(page, owner);

  const after = await mindmapState(page);
  expect(after.collapsed, 'exactly one node should be collapsed').toBe(1);
  expect(after.nodes, 'the collapsed descendants should disappear from the canvas').toBeLessThan(before.nodes);
});

/** Clicking again after collapsing should expand it back, and the node count returns to what it was. */
test('clicking the collapse button again expands it back', async ({ page }) => {
  const owner = await firstBadgeOwner(page);
  const before = await mindmapState(page);

  await clickBadgeOn(page, owner);
  const collapsed = await mindmapState(page);
  expect(collapsed.nodes).toBeLessThan(before.nodes);

  await clickBadgeOn(page, owner);
  const restored = await mindmapState(page);
  expect(restored.collapsed, 'there should be no collapsed node any more').toBe(0);
  expect(restored.nodes, 'the node count should return to what it was').toBe(before.nodes);
});

/** ★ The zoom buttons + / − really change the scale, and in the right direction. */
test('the zoom buttons: + zooms in, − zooms out', async ({ page }) => {
  const start = await currentScale(page);

  // ★ The button text is ASCII `+` / `-`, not the full-width `−` (U+2212).
  //   Writing the full-width one first, the locator found nothing and we waited 30 s for nothing —— noted so it is not repeated.
  await clickBarButton(page, '+');
  const zoomedIn = await currentScale(page);
  expect(zoomedIn, `clicking + should make it bigger (${start} → ${zoomedIn})`).toBeGreaterThan(start);

  await clickBarButton(page, '-');
  await page.waitForTimeout(400);
  const zoomedOut = await currentScale(page);
  expect(zoomedOut, `clicking − should make it smaller (${zoomedIn} → ${zoomedOut})`).toBeLessThan(zoomedIn);
});

/** View switch round trip: outline → mindmap → outline. */
test('the outline and mindmap views can be switched back and forth', async ({ page }) => {
  await expect(page.locator('.mm-canvas svg')).toBeVisible();

  await toOutlineView(page);
  await expect(page.locator('.mm-canvas svg'), 'the canvas should disappear after switching to the outline').toHaveCount(0);
  const rows = await page.locator('.om-outline-wrap .node-row, .om-outline-wrap li').count();
  expect(rows, 'the outline view should have content').toBeGreaterThan(0);

  await toMindmapView(page);
  await expect(page.locator('.mm-canvas svg'), 'the canvas should come back after switching to the mindmap').toBeVisible();
  expect(await page.locator('.mm-node').count()).toBeGreaterThan(0);
});

/** After switching the structure the viewport should re-fit (different structures differ in width and height). */
test('the content still fits after switching the structure', async ({ page }) => {
  const c = await canvasBox(page);
  for (const v of ['right', 'balanced', 'org']) {
    await setStructure(page, v);
    await clickBarButton(page, '适应');
    await page.waitForTimeout(300);

    const content = await page.evaluate(() => {
      let l = Infinity, r = -Infinity;
      for (const n of document.querySelectorAll('.mm-node')) {
        const b = n.getBoundingClientRect();
        if (b.width <= 0) continue;
        l = Math.min(l, b.left);
        r = Math.max(r, b.right);
      }
      return { l, r };
    });
    expect(content.l, `structure ${v}: content left ${content.l} must not exceed canvas left ${c.l}`).toBeGreaterThanOrEqual(c.l - 2);
    expect(content.r, `structure ${v}: content right ${content.r} must not exceed canvas right ${c.r}`).toBeLessThanOrEqual(c.r + 2);
  }
});

/**
 * ★ Dragging the canvas **must not** end up selecting a node.
 *
 * This is a behaviour that is easy to get wrong: the click at the end of a drag is often mistaken for a click-select,
 * so a user pans the view once and finds they have "selected" a node.
 * The implementation has `didDragRef` to block exactly this; this case pins it down.
 */
test('dragging the canvas must not select a node as a side effect', async ({ page }) => {
  const c = await canvasBox(page);
  const cx = c.l + c.w / 2;
  const cy = c.t + c.h / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 140, cy + 70, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(await mindmapState(page).then((s) => s.selected), 'no node should be selected after dragging').toBe(0);
});
