/**
 * ★★★ Converting an **empty** node and typing into it — the reported case, end to end.
 *
 * ## What it covers
 *
 * The E2E case above converts a node that already holds text. The report was a different flow:
 * an **empty** node is converted, and the characters typed into the new box never reached the
 * kernel. Measured on the user's own document: the code block was created and the old list item
 * was deleted (both correct), and its source stayed empty:
 *
 * ```
 * block 20261016070421-xxxxxxx  type=c  content=""     ← the block exists, the source does not
 * empty list items in the doc: 0                        ← the conversion did happen
 * ```
 *
 * The difference matters because an empty node takes a **different** path through the sync: the
 * conversion's own write-back creates the block with an empty fence, and the keystrokes that follow
 * are the **first** content write for it. The criteria are therefore the same three the converting
 * case uses — the caret is in the box, the typed text lands in the box, and the **document** holds
 * it — with an empty node as the precondition.
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

test('★★★ an empty node converts, and the first keystrokes reach the document', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    // Two list items: the second stays empty, and it is the one converted.
    docId = await createTempDoc(api, nb, '- alpha\n- \n');
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await openToolbar(page);

    const rows = page.locator(NODE_TEXT);
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    const empty = rows.nth(1);
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await empty.click();

    const btn = page.locator('.om-outline-wrap button[title="把当前节点变成代码块"]').first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    const box = page.locator('.om-outline-wrap textarea.om-node-code').first();
    await expect(box, 'the empty node must become a code box').toBeVisible({ timeout: 15_000 });
    await expect(box, 'an empty node converts to an empty block').toHaveValue('');

    // The caret must be inside it, or the keystrokes go to the neighbouring node.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (document.activeElement as HTMLElement | null)?.className?.toString() ?? '',
          ),
        { message: 'the caret must land in the new code box', timeout: 15_000 },
      )
      .toContain('om-node-code');

    // ★★ Typing starts **immediately** — no wait for any settle window. That is the reported
    //   flow (press the button, type), and it is the case that used to fail: the store replaces the
    //   node's id with the block id the kernel mints, React re-mounts the textarea, and everything
    //   typed into the outgoing element was dropped. The box commits its value on unmount, so the
    //   keystrokes survive the swap instead of needing the user to wait.
    await page.keyboard.type('test');
    await expect(box, 'the keystrokes must land in the box').toHaveValue('test', { timeout: 10_000 });

    // ★★★ A **burst**, with no delay between the keys.
    //
    //   Every keystroke writes back and re-renders, and React updates a mounted element's props
    //   in the mutation phase while its ref is attached in the layout phase —— so for the length of
    //   one commit a handler can carry the **new** node id while the box is still registered under
    //   the **old** one. Anything that resolves the element through that registry drops exactly the
    //   keystrokes typed in that window, silently (measured: four of them, `val: null`, the box
    //   showed the text and the document stayed empty). A burst is what makes that window
    //   reachable on purpose rather than by luck, so the case can defend it.
    const burst = 'abcdefghijklmnopqrstuvwxyz0123456789';
    await page.keyboard.type(burst, { delay: 0 });
    await expect(box, 'a burst of keystrokes must not lose a character').toHaveValue(
      `test${burst}`,
      { timeout: 10_000 },
    );

    // ★ The document is the authority: the source must reach it.
    await expect
      .poll(
        async () => {
          const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
          return String((kd.data as { kramdown?: string })?.kramdown ?? '');
        },
        { message: 'the typed source must reach the document', timeout: 30_000 },
      )
      .toContain(`test${burst}`);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});