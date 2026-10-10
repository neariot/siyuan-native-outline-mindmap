import { test, expect } from './fixtures';
import { openDoc, toMindmapView, mindmapState, canvasBox } from './mindmap';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook, TEMP_DOC_MD, type KernelApi } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

/**
 * E2E for the keyboard and the context menu.
 *
 * ## Why every case uses a **temporary document**
 *
 * The operations this suite tests **really modify the document**: Tab adds a child node, Enter adds a sibling node,
 * F2 edits text, right-click deletes. Run against a shared test document, each run pollutes it,
 * and the next assertion blows up. So every case creates its own temporary document and deletes it when done.
 *
 * ## Focus is a precondition
 *
 * The shortcuts are attached to `.mm-canvas`'s `onKeyDown` (see the comment in `Mindmap.tsx`:
 * "relying only on the overlay's onKeyDown misses this beat"). So every case must
 * **click a node first**, landing focus on the canvas and setting `selectedId` ——
 * with no node selected, these shortcuts return immediately.
 */

let api: KernelApi;
let notebook = '';
let docId = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  api = await kernelApi(baseURL, token);
  notebook = await resolveTestNotebook(api);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  docId = await createTempDoc(api, notebook, TEMP_DOC_MD);
  await openDoc(page, docId);
  await toMindmapView(page);
});

test.afterEach(async () => {
  if (docId) await removeDoc(api, docId);
  docId = '';
});

/** Click a node to establish focus and selection; this is the precondition of every shortcut. */
async function focusNode(page: Parameters<typeof mindmapState>[0], index = 1): Promise<void> {
  await page.locator('.mm-node').nth(index).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.mm-node.mm-selected')).toHaveCount(1);
}

test('focus lands on the canvas after clicking a node (the precondition of the shortcuts)', async ({ page }) => {
  await focusNode(page);
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? (a.className || '').toString() : '';
  });
  expect(active, 'focus should be on .mm-canvas, otherwise onKeyDown receives nothing').toContain('mm-canvas');
});

test('F2 enters edit mode and an input box appears', async ({ page }) => {
  await focusNode(page);
  // ★ The editor is not inside .mm-canvas; it is a standalone overlay `.mm-edit-overlay > textarea.mm-edit-input`.
  //   Searching for "an input inside the canvas" counted 0 every time, so F2 looked like it had no effect.
  const editor = page.locator('.mm-edit-input');
  await expect(editor, 'there should be no edit overlay before F2').toHaveCount(0);

  await page.keyboard.press('F2');
  await expect(editor, 'the edit box should appear after F2').toBeVisible({ timeout: 5_000 });
  await expect(editor).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(editor, 'Escape should leave editing').toHaveCount(0, { timeout: 5_000 });
});

/** Edit the text in the editor; after Enter saves it, the node text really changed. */
test('editing the text in the editor and saving really changes the node content', async ({ page }) => {
  await focusNode(page);
  await page.keyboard.press('F2');
  const editor = page.locator('.mm-edit-input');
  await expect(editor).toBeVisible({ timeout: 5_000 });

  const marker = '标题三';
  await editor.fill(marker);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);

  await expect(page.locator('.mm-edit-input'), 'the overlay should close after saving').toHaveCount(0);
  const texts = await page.locator('.mm-node').allTextContents();
  expect(texts.join('|'), 'the new text should appear on the node').toContain(marker);
});

/** ★ Tab adds a child node: the node count should go +1. */
test('Tab adds one child node to the selected node', async ({ page }) => {
  await focusNode(page);
  const before = await mindmapState(page);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);

  const after = await mindmapState(page);
  expect(after.nodes, `the node count should go +1 after Tab (${before.nodes} → ${after.nodes})`).toBe(before.nodes + 1);
});

/** ★ Enter adds a sibling node: the node count should go +1. */
test('Enter adds one sibling node to the selected node', async ({ page }) => {
  await focusNode(page);
  const before = await mindmapState(page);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  const after = await mindmapState(page);
  expect(after.nodes, `the node count should go +1 after Enter (${before.nodes} → ${after.nodes})`).toBe(before.nodes + 1);
});

/** With no node selected, the shortcuts must not add nodes by mistake. */
test('Tab / Enter create no new node when nothing is selected', async ({ page }) => {
  const before = await mindmapState(page);
  expect(before.selected, 'precondition: no node is selected at this point').toBe(0);

  // Click empty canvas space (not a node) so focus is on the canvas but nothing is selected
  const c = await canvasBox(page);
  await page.mouse.click(c.l + 20, c.t + 20);
  await page.waitForTimeout(300);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);

  expect(await mindmapState(page).then((s) => s.nodes), 'nothing new should appear while no node is selected').toBe(before.nodes);
});

/** ★ The context menu shows up and its items are complete. */
test('right-clicking a node opens the menu', async ({ page }) => {
  await page.locator('.mm-node').nth(1).click({ button: 'right' });
  await page.waitForTimeout(600);

  const menu = page.locator('.mm-ctx-menu');
  await expect(menu, 'right-click should open the menu').toBeVisible();

  const items = await menu.locator('.mm-ctx-item').allTextContents();
  const joined = items.join('|');
  for (const label of ['编辑节点', '新增子节点', '新增兄弟节点', '聚焦此节点', '删除节点（含子节点）']) {
    expect(joined, `the menu should contain "${label}"`).toContain(label);
  }
});

/** Clicking "add child node" in the context menu really adds a node, the node count should go +1. */
test('context menu: adding child node really adds a node', async ({ page }) => {
  const before = await mindmapState(page);

  await page.locator('.mm-node').nth(1).click({ button: 'right' });
  await page.waitForTimeout(600);
  await page.locator('.mm-ctx-menu .mm-ctx-item', { hasText: '新增子节点' }).click();
  await page.waitForTimeout(900);

  expect(await mindmapState(page).then((s) => s.nodes), 'there should be one more node').toBe(before.nodes + 1);
});

/** Escape closes the context menu. */
test('Escape closes the context menu', async ({ page }) => {
  await page.locator('.mm-node').nth(1).click({ button: 'right' });
  await page.waitForTimeout(600);
  await expect(page.locator('.mm-ctx-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await expect(page.locator('.mm-ctx-menu'), 'the menu should be closed after Escape').toHaveCount(0);
});

/**
 * ★ Focusing zooms the view down to that node's subtree, and returning restores it.
 *
 * This case watches the `zoomId` state specifically: after focusing, the node count **drops** (only the subtree is shown),
 * and returning should restore it.
 */
test('focusing a node shows only the subtree, and returning to the full map restores it', async ({ page }) => {
  const full = await mindmapState(page);

  await page.locator('.mm-node').nth(1).click({ button: 'right' });
  await page.waitForTimeout(600);
  await page.locator('.mm-ctx-menu .mm-ctx-item', { hasText: '聚焦此节点' }).click();
  await page.waitForTimeout(900);

  const focused = await mindmapState(page);
  expect(focused.nodes, 'after focusing, only that node\'s subtree should be shown, so the node count drops').toBeLessThan(full.nodes);

  // Return to the full map (possibly through the context menu or a button)
  await page.locator('.mm-node').first().click({ button: 'right' });
  await page.waitForTimeout(600);
  const back = page.locator('.mm-ctx-menu .mm-ctx-item', { hasText: '返回全图' });
  if (await back.count()) {
    await back.click();
    await page.waitForTimeout(900);
    expect(await mindmapState(page).then((s) => s.nodes), 'the node count should be restored after returning to the full map').toBe(full.nodes);
  }
});
