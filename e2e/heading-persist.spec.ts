/**
 * ★★ The heading buttons (H1 / H2 / H3 / ¶) must survive a reload.
 *
 * `setHeadingMany` writes `node.heading` and calls `mutate(..., 'struct')`, so the UI reflects the change
 * immediately —— and the changes look saved. But nothing on the read side ever puts it back: the field is
 * declared in `model/types.ts` and named by the outline, and by nothing else. A store that never writes it
 * and a loader that never reads it cannot round-trip, so the heading is session-local however it looks.
 *
 * This is the same shape as the summary and link-line defects already recorded in `model/types.ts`: a
 * declared field with a writer and no reader looks exactly like a working feature until the document is
 * re-read. Asserting on the DOM would pass here, because the DOM is set from the in-memory tree —— so the
 * case asserts on **the document after a reload**, which is the only thing that can tell the difference.
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

async function body(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const res = await api.call('/api/export/exportMdContent', { id: docId });
  const content = String((res.data as { content?: string })?.content ?? '');
  return content.split('---').slice(2).join('---').trim();
}

test('★★ H1 on a node survives a reload', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row');
    await rows.first().click();
    await page.waitForTimeout(200);

    // ★ Open the format toolbar before reaching for a button on it.
    //
    //   `.om-toolbar--collapsed` is `display: none !important`, and the collapsed/expanded state is
    //   remembered per view in `localStorage` (`om-outline-bar-open`) as well as derived from the phone
    //   rule and the container width —— so whether the row is present is a property of this browser
    //   profile, not of the product. Asserting on the toggle instead of guessing keeps the case about the
    //   heading rather than about layout state a previous run may have left behind.
    const toolbar = page.locator('.om-toolbar');
    if (!(await toolbar.isVisible())) {
      await page.locator('.om-toolbar-toggle').click();
    }
    await expect(toolbar, 'the format toolbar must be open to reach the heading buttons').toBeVisible();

    // Click H1 in the outline toolbar.
    //
    // ★ Match on the button's own text, not its `title`: the tooltip comes from the i18n catalogue and is
    //   locale-dependent (the test instance runs zh_CN, where it reads "标题1 (# + 空格)"), so a
    //   title-based selector silently matches nothing. `H1` is the button's label and is not translated.
    await page.locator('.om-toolbar button', { hasText: /^H1$/ }).click({ force: true });

    // The UI should reflect it at once —— that part already works, and is not what this case is about.
    await expect(rows.first(), 'H1 must apply in the UI').toHaveClass(/om-h1/);
    // ★ The real question: does the **kernel** hold a heading?
    //
    //   Assert on the kernel's own block type rather than on the exported text. Measured, the export writes
    //   the node as `- # <span data-type="text">甲</span>` —— a heading **nested in a list item** (which
    //   is the document's shape: every node is a listItem) whose body carries the inline-style span the
    //   plugin uses for its rich text. A text pattern would have to encode both of those, and would then be
    //   testing the serializer rather than the level. `data-subtype="hN"` is what a heading *is*.
    //
    //   The value of this case is the round trip: before the fix the level never left memory at all.
    await expect
      .poll(async () => {
        const dom = await api.call('/api/block/getBlockDOM', { id: docId });
        const html = String((dom.data as { dom?: string })?.dom ?? '');
        return (html.match(/data-subtype="h([1-6])"/g) ?? []).join(',');
      }, { message: 'the kernel must hold 甲 as an H1 block', timeout: 15_000 })
      .toBe('data-subtype="h1"');

    // And it must come back after a reload —— a heading that only lives in memory fails here.
    await page.reload();
    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(
      page.locator('.om-outline-wrap .node-row').first(),
      'after a reload the node must still be a heading —— this is the half that failed before the fix, because nothing on the read side restored the level',
    ).toHaveClass(/om-h1/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
