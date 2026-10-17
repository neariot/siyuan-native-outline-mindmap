/**
 * ★★★ The `</>` toolbar button turns the **whole node** into a code block.
 *
 * ## The defect this covers
 *
 * The button was an inline wrapper (`wrapSelection('<code>', '</code>')`), so with nothing selected
 * it inserted an **empty pair**: the empty `<code>` rendered as a grey capsule, the caret stayed
 * outside it, and the pair never reached the kernel — measured:
 *
 * ```
 * before: <span>alpha</span>
 * after : <span>alpha</span><code></code>
 * kernel: "alpha"
 * ```
 *
 * In the outline that is simply the wrong control. A node is a list item whose text is one
 * paragraph, and an inline mark cannot hold a multi-line sample; the carrier SiYuan can actually
 * store is a **code block** — a root-level `NodeCodeBlock` (verified against the running kernel).
 * So the button converts the focused node: its text becomes the block's source and the caret goes
 * inside the new box.
 *
 * The criteria are the three things the user observes: the node becomes a code box, the caret is
 * inside it, and what is typed reaches the **document**.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const NODE_TEXT = '.om-outline-wrap .node-text';

async function openToolbar(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(300);
  }
}

test('★★★ the </> button turns the focused node into a code block the caret sits inside', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, '- alpha\n- beta\n');
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    const row = page.locator(NODE_TEXT).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await openToolbar(page);
    const btn = page.locator('.om-outline-wrap button[title="把当前节点变成代码块"]').first();
    await expect(btn, 'the button must be reachable').toBeVisible({ timeout: 10_000 });

    // The caret is in the first node; press the button.
    await row.click();
    await page.keyboard.press('End');
    await btn.click();
    await page.waitForTimeout(1000);

    // ① The node became a code box, and the old paragraph text is its source.
    const box = page.locator('.om-outline-wrap textarea.om-node-code').first();
    await expect(box, 'the node must become a code box').toBeVisible({ timeout: 10_000 });
    await expect(box, 'the node text must become the block source').toHaveValue('alpha');

    // ② The caret is inside it (not in the neighbouring node, which was the reported symptom).
    const focused = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName}.${String(a.className).slice(0, 30)}` : 'none';
    });
    expect(focused, 'the caret must land in the new code box').toContain('om-node-code');

    // ③ Typing reaches the document as a fenced block.
    await page.keyboard.type('const x = 1;');
    await expect
      .poll(
        async () => {
          const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
          return String((kd.data as { kramdown?: string })?.kramdown ?? '');
        },
        { message: 'the typed source must reach the document as a fenced block', timeout: 25_000 },
      )
      .toContain('const x = 1;');

    // ★ And it must be a **code block** in the kernel, not a paragraph holding the text.
    const dom = await api.call('/api/block/getBlockDOM', { id: docId });
    const html = String((dom.data as { dom?: string })?.dom ?? '');
    expect(html, 'the kernel must hold a NodeCodeBlock').toContain('NodeCodeBlock');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});