/**
 * ★★ A structural edit must reach SiYuan even when the next key arrives before the previous write-back has
 * finished.
 *
 * Reported: "tab demote does not sync to SiYuan", then "it works probabilistically". Measured, it is not
 * probabilistic at all —— it is a race, and the race has a window:
 *
 *   Shift+Tab, Tab   pressed back to back  → SiYuan keeps the flat document
 *   Shift+Tab, pause, Tab                  → SiYuan nests the node correctly
 *
 * Cause: `serializeTree` —— the evidence behind the write-coalescing "did the tree change again?" check ——
 * emitted a flat `id:text` sequence with **no nesting and no child order**, so `甲|乙|丙` and `甲(乙)|丙`
 * produced byte-identical strings. The catch-up write was therefore skipped while the outline showed the
 * indent, and nothing raised an error.
 *
 * The assertion reads **the document**, not the screen, because the screen was right the whole time —— that
 * is what made this hard to see.
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

/** The document's own markdown, with the front-matter block removed. */
async function body(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const res = await api.call('/api/export/exportMdContent', { id: docId });
  const content = String((res.data as { content?: string })?.content ?? '');
  return content.split('---').slice(2).join('---').trim();
}

test('★ Shift+Tab then Tab, pressed back to back, still reaches SiYuan', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    // 甲 / 乙 / 丙 at the top level: indenting 乙 has one obvious correct result.
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n- 丙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row');
    expect(await rows.count(), 'the fixture should show three rows').toBe(3);

    await rows.nth(1).click(); // 乙
    await page.waitForTimeout(300);
    expect(await body(api, docId), 'the fixture starts flat').toContain('- 甲\n- 乙');

    // ★ No pause between the two keys —— that is the whole point of the case.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');

    // Poll rather than sleep: the write-back is asynchronous, and a fixed wait would make this case
    // pass or fail on machine speed (see docs/pitfalls/testing.md on machine load).
    await expect
      .poll(async () => body(api, docId), {
        message: '乙 must end up nested under 甲 in the document, not only in the outline',
        timeout: 20_000,
      })
      .toContain('- 甲\n\n  - 乙');

    // And the sibling order must survive: 丙 still after 甲's subtree.
    expect(await body(api, docId), '丙 must stay after 乙').toMatch(/-\s*乙[\s\S]*-\s*丙/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★ a pause between the same two keys gives the same document', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n- 丙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row');
    await rows.nth(1).click();
    await page.waitForTimeout(300);

    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(800); // the pause that used to be the only thing making it work
    await page.keyboard.press('Tab');

    await expect
      .poll(async () => body(api, docId), { message: 'the slow path must keep working', timeout: 20_000 })
      .toContain('- 甲\n\n  - 乙');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
