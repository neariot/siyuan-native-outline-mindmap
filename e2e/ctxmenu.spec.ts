import { test, expect } from './fixtures';
import { siyuanUrl, siyuanToken } from './env';
import {
  openDoc, toMindmapView, toOutlineView, openCtxMenu, clickCtxItem, ctxMenuBox, mindmapState,
} from './mindmap';
import {
  kernelApi, ensureTestDoc, resolveTestNotebook, createTempDoc, removeDoc, TEMP_DOC_MD,
} from './testdoc';

/**
 * The mind map context menu.
 *
 * ## Why it gets its own suite
 *
 * Previously only three items were covered (add child node / focus / back to full map),
 * while the menu has **7 items in total** —— "Edit node", "Add sibling node", "Expand as sub-document"
 * and "Delete node (with children)" were never clicked at all.
 * Menu items are **conditionally rendered** (`editable && onEditNode`, `deletable && onDeleteNode`),
 * so a missing prop silently drops an item: no error, the user just loses a feature.
 *
 * ## One pitfall you must know: `window.confirm` **cancels by default** in a headless browser
 *
 * Deleting a node raises a confirm dialog. In headless Chromium `window.confirm()` **returns false automatically**,
 * so the delete is (correctly) aborted —— and it looks exactly like "the delete feature is broken".
 * The menu item exists, is visible, and the menu closes after the click, yet the node count does not change ——
 * which is easy to misreport as "the delete is broken".
 *
 * ⇒ To test any action with a confirm dialog you **must handle the dialog first**.
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

test('the context menu lists every node action', async ({ page }) => {
  const items = await openCtxMenu(page, 1);

  // Assert item by item, so a missing one names itself
  for (const want of [
    '编辑节点', '备注/描述', '新增子节点', '新增兄弟节点',
    '展开为子文档', '聚焦此节点', '返回全图', '删除节点（含子节点）',
  ]) {
    expect(items.some((t) => t.includes(want)), `the menu should contain "${want}", actual: ${items.join(' / ')}`).toBe(
      true,
    );
  }
  expect(items, 'the menu should have exactly these 8 items').toHaveLength(8);
});

test('the context menu does not run outside the viewport', async ({ page }) => {
  const total = await page.locator('.mm-node').count();
  expect(total, 'the test document should have more than one node').toBeGreaterThan(1);

  const bad: string[] = [];
  for (let i = 0; i < total; i++) {
    await openCtxMenu(page, i);
    const box = await ctxMenuBox(page);
    expect(box, `the menu for node #${i} should appear`).not.toBeNull();
    const b = box!;
    if (b.overflowRight || b.overflowBottom || b.overflowLeft || b.overflowTop) {
      bad.push(
        `#${i} overflows right${b.overflowRight}/bottom${b.overflowBottom}/left${b.overflowLeft}/top${b.overflowTop}`,
      );
    }
  }
  expect(bad, `the menu should not run outside the viewport, actual: ${bad.join('; ')}`).toHaveLength(0);
});

test('deleting a node also deletes its children and writes back to SiYuan', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let id = '';
  try {
    // Use a temp document: this one really deletes nodes, do not touch the shared test document
    id = await createTempDoc(api, notebook, TEMP_DOC_MD);
    await openDoc(page, id);
    await toMindmapView(page);

    const before = await mindmapState(page);
    // "甲" has child nodes, so deleting it should take them along
    await openCtxMenu(page, 1);

    // ★ A confirm handler is required —— headless browsers cancel by default, and without one the delete is aborted,
    //   which looks like the feature is broken (see the file header)
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });

    await clickCtxItem(page, '删除节点（含子节点）');
    await page.waitForTimeout(2500); // wait for the write back to SiYuan

    expect(dialogs.length, 'a confirm dialog should have appeared').toBeGreaterThan(0);
    expect(dialogs[0], 'the confirm dialog should say the child nodes are deleted too').toContain('子节点');

    const after = await mindmapState(page);
    expect(
      after.nodes,
      `the node count should drop after the delete (${before.nodes} → ${after.nodes})`,
    ).toBeLessThan(before.nodes);

    // Verify the write back too: watching the UI change is not enough, the SiYuan document is the only source of truth
    const kd = await api.call('/api/block/getBlockKramdown', { id });
    const body = String((kd.data as { kramdown?: string })?.kramdown ?? '');
    expect(body, 'the deleted branch should no longer be in the SiYuan document').not.toContain('分支一');
    expect(body, 'the branch that was not deleted should still be there').toContain('乙');
  } finally {
    if (id) await removeDoc(api, id);
    await api.dispose();
  }
});

test('cancelling the confirm dialog does not delete the node', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let id = '';
  try {
    id = await createTempDoc(api, notebook, TEMP_DOC_MD);
    await openDoc(page, id);
    await toMindmapView(page);

    const before = await mindmapState(page);
    await openCtxMenu(page, 1);

    // ★ The reverse direction: this time **cancel**. The delete must be aborted ——
    //   testing only "deleted after confirming" would let a "deletes without waiting for the confirm" defect slip through.
    page.on('dialog', (d) => void d.dismiss());
    await clickCtxItem(page, '删除节点（含子节点）');
    await page.waitForTimeout(1500);

    const after = await mindmapState(page);
    expect(after.nodes, `the node count should not change after cancelling (${before.nodes} → ${after.nodes})`).toBe(before.nodes);
  } finally {
    if (id) await removeDoc(api, id);
    await api.dispose();
  }
});

test('"Edit node" opens the input box and gives it focus', async ({ page }) => {
  await openCtxMenu(page, 1);
  await clickCtxItem(page, '编辑节点');

  await expect(page.locator('.mm-edit-overlay'), 'the edit overlay should appear').toHaveCount(1);
  await expect(page.locator('.mm-edit-input'), 'the input box should appear').toHaveCount(1);

  // ★ Focus must really be inside the input: existing without focus means the user loses it on the first keystroke
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  expect(focused, `focus should be on the edit input, actual: "${focused}"`).toContain('mm-edit-input');
});

test('"Add sibling node" inserts a node at the same level', async ({ page }) => {
  const before = await mindmapState(page);
  await openCtxMenu(page, 1);
  await clickCtxItem(page, '新增兄弟节点');
  await page.waitForTimeout(1200);

  const after = await mindmapState(page);
  expect(
    after.nodes,
    `the node count should grow after adding a sibling (${before.nodes} → ${after.nodes})`,
  ).toBe(before.nodes + 1);
});

test('"Expand as sub-document" moves the child nodes away and does not duplicate the node text', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let id = '';
  const created: string[] = [];
  try {
    // This one really creates a child document and really moves nodes, so it must use a temp document
    // It uses its own markdown: a branch "with 2 child nodes" is needed to move
    id = await createTempDoc(api, notebook, '- 分支一\n  - 节点一\n  - 节点二\n- 分支二\n');
    await openDoc(page, id);
    await toMindmapView(page);

    const before = await mindmapState(page);
    await openCtxMenu(page, 1); // "分支一", which has 2 child nodes

    // ★ A confirm handler is required (see the file header: headless browsers cancel by default)
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });
    await clickCtxItem(page, '展开为子文档');
    await page.waitForTimeout(4500); // create child document + move blocks, allow extra time

    expect(dialogs.length, 'a confirm dialog should appear').toBeGreaterThan(0);
    expect(dialogs[0], 'the confirm dialog should say the child nodes will be moved').toContain('子节点');

    const after = await mindmapState(page);
    // Two child nodes move away → the mind map loses 2
    expect(
      after.nodes,
      `after expanding, the child nodes should disappear from the current document (${before.nodes} → ${after.nodes})`,
    ).toBe(before.nodes - 2);

    // ★★ The node text must **not be duplicated**.
    //   This pins down a real defect: the original implementation **appended** the reference after the original text,
    //   and the reference rendered its own title, so the node showed up as "分支一 分支一".
    const nodeText = await page.evaluate(() => {
      const n = [...document.querySelectorAll('.mm-node')].find((x) =>
        (x.textContent || '').includes('分支一'),
      );
      if (!n) return null;
      const tspans = [...n.querySelectorAll('tspan')].map((t) => (t.textContent || '').trim());
      return { joined: tspans.join(''), count: tspans.length };
    });
    expect(nodeText, 'the "分支一" node should be found').not.toBeNull();
    const shown = nodeText!.joined;
    const occurrences = shown.split('分支一').length - 1;
    expect(
      occurrences,
      `"分支一" should appear exactly 1 time in the node text, actual ${occurrences} (text: "${shown}")`,
    ).toBe(1);

    // What is written back to SiYuan must be right too: it should be a **pure reference**, not "original text + reference"
    const kd = await api.call('/api/block/getBlockKramdown', { id });
    const body = String((kd.data as { kramdown?: string })?.kramdown ?? '');
    // ★ SiYuan puts a listItem's block attributes **on the same line** (`- {: id="…"}body`),
    //   so filtering by "the whole line is an attribute" is not enough —— strip the inline `{: …}` first, then compare.
    //   Without stripping it the assertion sees the attribute prefix and misjudges it as "the original text precedes the reference".
    const strip = (l: string): string => l.replace(/\{:[^}]*\}/g, '').trim();
    const refLine = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('(('))
      .map(strip)
      .find((l) => l.length > 0);
    expect(refLine, 'the original document should be left with one reference line').toBeTruthy();
    expect(
      refLine,
      `after stripping the block attributes, that reference line should be **only the reference**, and must not repeat the original text before it. Actual: "${refLine}"`,
    ).toMatch(/^-\s*\(\(/);
    expect(body, 'the child nodes should no longer remain in the original document').not.toContain('节点一');

    // The child document was really created, and its **content was moved over** (not deleted without moving)
    const docs = await api.sql(
      "SELECT id, hpath FROM blocks WHERE type='d' AND hpath LIKE '%分支一%' LIMIT 5",
    );
    expect(docs.length, 'a child document should have been created').toBeGreaterThan(0);
    for (const d of docs) created.push(String((d as { id: string }).id));
    const subKd = await api.call('/api/block/getBlockKramdown', { id: created[0] });
    const subBody = String((subKd.data as { kramdown?: string })?.kramdown ?? '');
    expect(subBody, 'the child document should contain "节点一"').toContain('节点一');
    expect(subBody, 'the child document should contain "节点二"').toContain('节点二');
  } finally {
    for (const c of created) await removeDoc(api, c);
    if (id) await removeDoc(api, id);
    await api.dispose();
  }
});

/**
 * ★ The per-node collapse entry must not be labelled with the global command.
 *
 * The entry only appears for a node that **has children** (the `node.children.length > 0` guard), and it
 * calls `toggleCollapse(id, true)` on that one node. It used to read `cmdExpandAll` / `cmdCollapseAll` ——
 * "Expand all" / "Collapse all" —— which describes the whole map's command in the level menu, so the label
 * overstates what clicking it does. `tipExpandNode` / `tipCollapseNode` are the per-node strings, already
 * used for the same action on the toolbar.
 *
 * Asserted on the **rendered** menu, because the defect is the text a user reads.
 */
test('★ the outline\'s per-node collapse entry uses the per-node label, not the global command', async ({ page }) => {
  // ★ This is the **outline's** menu (`Outliner.tsx` renders its own `.mm-ctx-menu`), not the mind map's.
  //   They are two separate menus with the same class names: the mind map's (`Mindmap.tsx`) has no collapse
  //   entry at all, so opening it here found eight items on every node and the case proved nothing.
  await toOutlineView(page);

  // `分支一` is the first node and has children, so the guard that renders this entry is satisfied.
  await page.locator('.om-outline-wrap .node-row').first().click({ button: 'right' });
  await page.waitForTimeout(400);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.mm-ctx-menu .mm-ctx-item')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()),
  );
  const joined = items.join(' / ');

  expect(joined, `expected a per-node label, outline menu was: ${joined}`).toMatch(/折叠主题|展开主题/);
  expect(joined, `the global command label must not be used for a single node, outline menu was: ${joined}`)
    .not.toMatch(/全部折叠|全部展开|Collapse all|Expand all/);
});
