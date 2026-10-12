/**
 * ★★ A heading the **document** already has must survive the plugin's load-and-save cycle.
 *
 * ★ Why this is the case that exists here, and what used to be here.
 *
 *   The outline once offered H1 / H2 / H3 / ¶ buttons and a `# ` + space shortcut for making a node a
 *   heading. Both were removed: a node in this plugin is always a list item, and SiYuan takes a heading level
 *   only from a **non-list** line (`kramdownToTree`: `const isHeading = !isList && !!headingMatch`), so a
 *   level set that way could never be read back. The case that used to live in this file asserted the
 *   button's effect and is gone with the buttons.
 *
 *   What is **not** gone is the other direction, and it must not regress: a document that already contains a
 *   real `# H1` —— written by hand in SiYuan, or by any other tool —— loads as a heading node and is saved
 *   back as a heading. `OutlineNode.heading`, `core/map.ts`'s reader/writer for it, and the `om-hN` styling
 *   are all kept for that. Without this case nothing would notice if a later change dropped them.
 *
 * ★ It asserts on the **document's block type** after a round trip, not on the outline's CSS class: the class
 *   is set from the in-memory tree, so it cannot tell "the level was reloaded" from "it never left memory".
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

let notebook = '';

test.beforeAll(async () => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  try {
    notebook = await resolveTestNotebook(api);
  } finally {
    await api.dispose();
  }
});

/** The heading levels the kernel holds, e.g. `["h2"]`. */
async function headingLevels(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string[]> {
  const dom = await api.call('/api/block/getBlockDOM', { id: docId });
  const html = String((dom.data as { dom?: string })?.dom ?? '');
  return html.match(/data-subtype="h[1-6]"/g) ?? [];
}

test('★★ a document\'s own heading survives loading and saving it from the outline', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    // ★ The heading must **not** be the document's first block.
    //
    //   Measured rule in `kramdownToTree`: a flush-left `# ` on the document's first content line is the
    //   **document title**, not a node ("the title block is always the document's first block, and nothing
    //   can be inserted before it"); any other flush-left `# ` is a real h1 node. Writing the fixture as
    //   `# 手写标题` first would therefore have tested a title, and the case would have passed while proving
    //   nothing about heading nodes. A list comes first here so the heading is the second block.
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n\n# 手写标题\n');
    expect(await headingLevels(api, docId), 'the fixture must start with one H1').toEqual(['data-subtype="h1"']);

    await openDoc(page, docId);
    await toOutlineView(page);

    // Edit a node, so a write-back is triggered and the whole tree goes through the save path.
    await page.locator('.om-outline-wrap .node-row').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type('丙');
    await page.waitForTimeout(2500);

    await expect
      .poll(async () => headingLevels(api, docId), {
        message: 'the document\'s own H1 must still be an H1 after a save',
        timeout: 20_000,
      })
      .toEqual(['data-subtype="h1"']);

    // And after a reload —— the level must come back out of the document, not out of memory.
    await page.reload();
    await openDoc(page, docId);
    await toOutlineView(page);
    await expect
      .poll(async () => page.locator('.om-outline-wrap .node-row.om-h1').count(), {
        message: 'the loaded heading must be presented as a heading',
        timeout: 20_000,
      })
      .toBe(1);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
