/**
 * ★★★ A table that is a **child** —— both halves: reading one that already is, and writing one.
 *
 * ## What it covers
 *
 * A table used to be a root-level node that nothing could re-parent, and the reason was written down
 * as a kernel law: "a `NodeList` cannot contain a table". Measured against the running kernel
 * (2026-10-16) that is false, in the same way and with the same numbers as for a code block:
 *
 * · `insertBlock` with `parentID` = a list item creates a `NodeTable` **inside** it, and with
 *   `previousID` = that item's paragraph the table lands after the item's own text;
 * · `createDocWithMd` with an indented table produces exactly that document;
 * · `moveBlock` on a `NodeTable` answers `code: 0` and **moves nothing** —— so a level change is
 *   written as create-then-delete, and that is what the store now does
 *   (`docs/kernel-api.md` §7.17).
 *
 * A table has one extra hazard that a code block does not: its **cells** are written by a separate
 * pass (`syncTableCells`), keyed by the block id. A table that is re-created gets a new id, so the
 * criteria here deliberately check the **cell content** after a level change, not just the nesting —
 * a re-create that dropped the cells would look correct in every other respect.
 *
 * The two cases:
 *
 *   1. a document that already holds a nested table opens with it as a **child row**, and a save
 *      round-trip leaves **one** table with its cells (a table the write path cannot see is judged
 *      "new in the UI" and gets a second copy, and the original is then deleted), and
 *   2. indenting a root-level table nests it **in the kernel**, outdenting brings it back, and the
 *      cells survive both.
 *
 * The level change goes through the **toolbar buttons**, like the code-block case.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const TABLE = '.om-outline-wrap table.om-node-table';
/**
 * A **cell** of the table, for clicks.
 *
 * ★ The inner selector of `has:` is resolved **relative to the outer element**, so it must not
 *   repeat the `.om-outline-wrap` prefix: written as a full path it looks for a `.om-outline-wrap`
 *   *inside* the row, matches nothing, and the click waits for a row that does not exist (measured:
 *   both cases timed out at 2 minutes on an otherwise green run).
 *
 * ★ And it is the **`.om-node-cell` div**, not the `<td>` and not the row: a table cell is rendered
 *   as a contenteditable div *inside* the `<td>` (a contenteditable table would make every keystroke
 *   a structural edit), and only that div carries `data-node-id` and takes focus. Clicking the `<td>`
 *   or the row leaves `document.activeElement` on the body —— and the toolbar then falls back to "the
 *   first node", which would indent the wrong one (measured: the caret check failed, and the toolbar
 *   had no idea which node it was acting on).
 */
const TABLE_CELL = '.om-outline-wrap table.om-node-table .om-node-cell';
const OUTDENT = '.om-toolbar button[title="向左提升 (Shift+Tab)"]';
const INDENT = '.om-toolbar button[title="向右缩进 (Tab)"]';

/** 甲 with a table **inside** it, then 乙 —— the shape the kernel produces from indented markdown. */
const NESTED_TABLE_MD = [
  '- 甲',
  '  | h1 | h2 |',
  '  | --- | --- |',
  '  | a | b |',
  '- 乙',
  '',
].join('\n');

/** 甲, then a document-level table, then 乙. */
const ROOT_TABLE_MD = ['- 甲', '', '| h1 | h2 |', '| --- | --- |', '| a | b |', '', '- 乙', ''].join('\n');

async function openToolbar(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await expect(page.locator('.om-toolbar')).toBeVisible({ timeout: 10_000 });
  }
}

async function nodeXs(page: Parameters<typeof toOutlineView>[0]): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.om-outline-wrap .node-row:not(.node-row-empty)')].map((row) => {
      const el = row.querySelector('.node-text, table.om-node-table') as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().x) : -1;
    }),
  );
}

async function docMd(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const res = await api.call('/api/export/exportMdContent', { id: docId });
  return String((res.data as { content?: string })?.content ?? '');
}

/**
 * Which list item owns the table, read from the export's **own indentation**.
 *
 * ★★ The obvious criterion —— "the export contains `- 甲 … \n\s+\| ?h1`" —— cannot see nesting at all:
 *   `\s+` also matches the newline of a **blank line**, so a table sitting at the document level, two
 *   lines below 甲, matches it. Measured: with the writer's nested anchor reverted, that case stayed
 *   **green** —— a red proof that failed and said so, which is the only reason it was caught.
 *
 *   So the level is read the way the document states it: how far the table's own line is indented, and
 *   the nearest list item **less indented** than that. `null` means the document level, and the
 *   counter-case asserts exactly that, so the helper cannot be satisfied by a top-level table.
 */
function tableOwner(md: string): string | null {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^\s*\| ?h1/.test(l));
  if (i < 0) return null;
  const indent = (/^(\s*)/.exec(lines[i]) ?? ['', ''])[1].length;
  if (indent === 0) return null; // column 0 == the document level
  for (let j = i - 1; j >= 0; j--) {
    const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(lines[j]);
    if (m && m[1].length < indent) return lines[j].trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
  }
  return null;
}

/**
 * Put the caret in a table cell, and wait until it is really there.
 *
 * ★ The toolbar resolves its target from `document.activeElement`, so a click that did not take
 *   focus would make it fall back to "the first node" and indent the **wrong** one —— which would
 *   look like a product bug and be nothing of the kind.
 *
 * ★ And the click sometimes does not take: measured, right after the click `activeElement` **is**
 *   the cell, and a moment later it is not —— a re-render lands after the click and takes the caret
 *   with it. So this clicks and waits, and clicks again if the caret did not take, which is exactly
 *   what a person does when the first tap does nothing.
 */
async function focusTableCell(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const caretIsInCell = (): Promise<boolean> =>
    page.evaluate(() => {
      const ae = document.activeElement as HTMLElement | null;
      return !!ae?.classList.contains('om-node-cell') && !!ae.getAttribute('data-node-id');
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator(TABLE_CELL).first().click();
    try {
      await expect.poll(caretIsInCell, {
        message: 'the caret must be in a table cell before using the toolbar',
        timeout: 3_000,
      }).toBe(true);
      // ★★ Confirm it **held**: the first poll can pass a frame before the re-render that drops it.
      await page.waitForTimeout(400);
      if (await caretIsInCell()) return;
    } catch {
      // Not in a cell this time round —— click again.
    }
  }
  throw new Error('the caret never settled in a table cell after three clicks');
}

test('★★★ a table already inside a list item loads as that node\'s child, and stays single', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, NESTED_TABLE_MD);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    await expect(page.locator(TABLE), 'the nested table must render').toHaveCount(1, { timeout: 15_000 });
    // ★ The cells, not just the shape: a table read as a node with no rows would render as an empty
    //   grid, which looks like a table on screen.
    await expect
      .poll(
        () => page.locator(`${TABLE} tbody tr td`).allInnerTexts(),
        { message: 'the cells must survive the read', timeout: 15_000 },
      )
      .toEqual(['a', 'b']);

    // ★ Same structural read on the document side: the fixture's table belongs to 甲, and a table at
    //   the document level would say so.
    expect(tableOwner(await docMd(api, docId)), 'precondition: the fixture nests the table in 甲').toBe('甲');

    const xs = await nodeXs(page);
    expect(xs.length, 'three nodes: 甲, its table, 乙').toBe(3);
    expect(xs[1], 'the table must sit deeper than 甲').toBeGreaterThan(xs[0]);
    expect(xs[2], 'and 乙 is back at the top level').toBe(xs[0]);

    // ★ One save round trip must not add a second table (the "invisible to the write path" failure),
    //   and the cells must still be there.
    await page.locator(TABLE_CELL).first().click();
    await page.waitForTimeout(1500);
    await expect
      .poll(() => docMd(api, docId).then(tableOwner), {
        message: 'the table must still be nested after a save',
        timeout: 30_000,
      })
      .toBe('甲');
    // ★ Counted by the **separator row**, and matched loosely on purpose: the kernel's export writes
    //   `| ---| ---|` with no space before the closing pipes, so an exact literal matches nothing and
    //   the check would pass on a document with no table at all (measured: `Received: 0`).
    const md = await docMd(api, docId);
    expect(md.split('\n').filter((l) => /^\s*\|.*---.*\|\s*$/.test(l)).length,
      'exactly one table —— a second copy is the failure').toBe(1);
    expect(md, 'and its cells are intact').toMatch(/\|\s*a\s*\|\s*b\s*\|/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
test('★★★ indenting a table nests it in the document with its cells, and outdenting brings it back', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, ROOT_TABLE_MD);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await openToolbar(page);

    await expect(page.locator(TABLE), 'the document-level table must render').toHaveCount(1, {
      timeout: 15_000,
    });
    const startXs = await nodeXs(page);
    expect(startXs.length, 'three nodes: 甲, the table, 乙').toBe(3);
    expect(startXs[1], 'precondition: the table starts at the top level').toBe(startXs[0]);
    expect(tableOwner(await docMd(api, docId)), 'precondition: the document agrees it is at the root')
      .toBeNull();

    // ---- indent: the table becomes a child of 甲 ----
    await focusTableCell(page);
    await page.locator(INDENT).click();
    await expect
      .poll(() => nodeXs(page).then((xs) => xs[1]), {
        message: 'the table must move one level deeper',
        timeout: 20_000,
      })
      .toBeGreaterThan(startXs[1]);
    await expect
      .poll(() => docMd(api, docId).then(tableOwner), {
        message: '★ the document must show the table nested inside 甲 —— a panel-only move is the failure',
        timeout: 30_000,
      })
      .toBe('甲');
    // ★★ The cells, after the re-create. The table got a **new block id**, and its cells are written
    //   by a separate pass keyed on that id —— so "it is nested" and "it still has its data" are two
    //   different claims, and only the second one catches a lost edit.
    await expect
      .poll(() => page.locator(`${TABLE} tbody tr td`).allInnerTexts(), {
        message: 'the cells must survive the re-create',
        timeout: 20_000,
      })
      .toEqual(['a', 'b']);

    // ---- outdent: back to the document level ----
    await focusTableCell(page);
    await page.locator(OUTDENT).click();
    await expect
      .poll(() => nodeXs(page).then((xs) => xs[1]), {
        message: 'the table must come back to the top level',
        timeout: 20_000,
      })
      .toBe(startXs[1]);
    await expect
      .poll(() => docMd(api, docId).then(tableOwner), {
        message: '★ the document must show the table at the document level again (column 0)',
        timeout: 30_000,
      })
      .toBeNull();
    expect(
      (await docMd(api, docId)).split('\n').filter((l) => /^\s*\|.*---.*\|\s*$/.test(l)).length,
      'one table after the outdent',
    ).toBe(1);
    await expect
      .poll(() => page.locator(`${TABLE} tbody tr td`).allInnerTexts(), {
        message: 'and the cells survived the way back',
        timeout: 20_000,
      })
      .toEqual(['a', 'b']);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
