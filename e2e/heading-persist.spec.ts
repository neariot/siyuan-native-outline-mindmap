/**
 * ★★ Does making a node an H1 survive a save and a reload?
 *
 * The outline's H1 / H2 / H3 / ¶ buttons all call `setHeadingMany`, which writes `node.heading` and calls
 * `mutate(..., 'struct')`. The read side **can** restore it —— `core/map.ts` parses the `#` count back into
 * `node.heading` when `loadDoc` runs `kramdownToTree` —— while `saveNodesIncremental` writes each node's
 * block through the **DOM** path as `<div data-type="NodeParagraph">`.
 *
 * Those two disagree about where the level lives, and nothing raises when they do: the outline shows `om-hN`
 * from its in-memory tree and the buttons look pressed, so only a reload reveals what the document kept.
 *
 * ★ It asserts on what the **plugin's own reader** restores, not on the document text. A node is a list item,
 * so a level appears nested however the kernel spells it; asking the reader "what level do you see now?" is
 * the user-visible question and does not encode the kernel's spelling.
 */
import { test, expect, type Page } from './fixtures';
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

/** Per node row: its heading level as the outline renders it (`h1`..`h6`, or `-` for a plain node). */
async function rowLevels(page: Page): Promise<string[]> {
  return page.locator('.om-outline-wrap .node-row').evaluateAll((els) =>
    els.map((el) => {
      const m = /om-h([1-6])/.exec(el.className);
      return m ? `h${m[1]}` : '-';
    }),
  );
}

test('★★ H1 applied in the outline is still a heading after a reload', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row');
    await rows.first().click();
    await page.waitForTimeout(200);

    // The format toolbar is `display: none` until opened, and whether it starts open depends on
    // `localStorage` (`om-outline-bar-open`), the container width and the phone rule —— i.e. on this browser
    // profile, not on the product. Open it rather than assume.
    const toolbar = page.locator('.om-toolbar');
    if (!(await toolbar.isVisible())) await page.locator('.om-toolbar-toggle').click();
    await expect(toolbar, 'the format toolbar must be open to reach the heading buttons').toBeVisible();

    // ★ Click the button by its own label: the `title` comes from i18n and is locale-dependent, so a
    //   title-based selector silently matches nothing on the zh_CN test instance.
    await page.locator('.om-toolbar button', { hasText: /^H1$/ }).click({ force: true });
    await expect(rows.first(), 'H1 must apply in the outline at once').toHaveClass(/om-h1/);

    // Give the debounced write-back time to run, then reload from the document.
    await page.waitForTimeout(2500);
    await page.reload();
    await openDoc(page, docId);
    await toOutlineView(page);

    await expect
      .poll(async () => rowLevels(page), {
        message: 'after a reload the node must still be a heading —— otherwise the level never reached the document',
        timeout: 20_000,
      })
      .toEqual(['h1', '-']);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
