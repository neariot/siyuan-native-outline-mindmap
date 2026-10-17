/**
 * ★★★ Converting a node in a document that **already holds code blocks**, then typing into the new
 * box, must reach the document.
 *
 * ## Why this case exists
 *
 * Every earlier case builds its code blocks **during** the run: the node is converted, the store
 * inserts the block and remembers the markdown it wrote (`lastCodeMarkdown`), and the next pass sees
 * a difference. All of those pass.
 *
 * The reported failure is in a document whose code blocks were **already there when the panel
 * opened** —— five of them, all empty, left by earlier attempts. The panel loads them from the
 * kernel, and a loaded block is not in the store's bookkeeping at all. Measured on the user's own
 * document while this build was live: five code blocks, every one of them with empty content, and
 * the converted node's list item correctly deleted —— so the structural half of the conversion works
 * and only the source write does not.
 *
 * The criteria are the two the user can see, on a document shaped like theirs (the labels are
 * invented; the shape is what matters):
 *
 *   1. the converted node becomes a code box with the caret in it, and
 *   2. what is typed into it ends up in **that** block in the document.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const NODE_TEXT = '.om-outline-wrap .node-text';
const CODE_BOX = '.om-outline-wrap textarea.om-node-code';
const CONVERT = '.om-outline-wrap button[title="把当前节点变成代码块"]';

/** Three plain rows, **five empty code blocks** already in the document, then two empty rows. */
const DOC_WITH_EXISTING_CODE = [
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '```',
  '```',
  '',
  '```',
  '```',
  '',
  '```',
  '```',
  '',
  '```',
  '```',
  '',
  '```',
  '```',
  '',
  '- ',
  '- ',
].join('\n');

async function openToolbar(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(300);
  }
}

/** The panel's own id for the box the user is typing in, so the right block is checked. */
async function boxIdOf(page: Parameters<typeof toOutlineView>[0], index: number): Promise<string> {
  return (await page.locator(CODE_BOX).nth(index).getAttribute('data-node-id')) ?? '';
}

test('★★★ a document that already has code blocks: convert, then type, and it reaches the kernel', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, DOC_WITH_EXISTING_CODE);
    // The shape is the point, so it is asserted rather than assumed: a markdown quirk would
    // otherwise produce a document with one block and a green case that proved nothing.
    const sql = await api.call('/api/query/sql', {
      stmt: `SELECT count(*) AS n FROM blocks WHERE root_id='${docId}' AND type='c' LIMIT 1`,
    });
    const existing = Number((sql.data as { n?: number }[] | undefined)?.[0]?.n ?? 0);
    expect(existing, 'the fixture must really contain code blocks').toBe(5);

    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await openToolbar(page);
    await page.locator(NODE_TEXT).first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(
      page.locator(CODE_BOX),
      'the pre-existing code blocks must render as boxes',
    ).toHaveCount(5, { timeout: 15_000 });

    // Convert the last empty row.
    const rows = page.locator(NODE_TEXT);
    const count = await rows.count();
    await rows.nth(count - 1).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ae = document.activeElement as HTMLElement | null;
            return ae ? `${ae.tagName}.${ae.className}` : '';
          }),
        { message: 'the caret must be in the row to convert', timeout: 15_000 },
      )
      .toContain('node-text');
    await page.locator(CONVERT).first().click();
    await expect(page.locator(CODE_BOX), 'the converted node must add a box').toHaveCount(6, {
      timeout: 15_000,
    });

    // Type into the **new** box straight away, the way a person does.
    const box = page.locator(CODE_BOX).nth(5);
    await box.click();
    let typed = '';
    for (const ch of 'test') {
      await page.keyboard.type(ch);
      await page.waitForTimeout(400);
      typed += ch;
      await expect(box, `the box must keep "${typed}"`).toHaveValue(typed, { timeout: 5_000 });
    }

    // ★ The **block itself**, not the document text: another code block in the same document
    //   could carry the string while this one stayed empty, which is the reported failure.
    const boxId = await boxIdOf(page, 5);
    await expect
      .poll(
        async () => {
          if (!boxId) return 'no-id';
          const kd = await api.call('/api/block/getBlockKramdown', { id: boxId });
          return String((kd.data as { kramdown?: string })?.kramdown ?? '');
        },
        { message: 'the typed source must reach the block the box is bound to', timeout: 30_000 },
      )
      .toContain('test');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});