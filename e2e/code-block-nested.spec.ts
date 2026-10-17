/**
 * ★★★ A code block that is a **child** —— both halves: reading one that already is, and writing one.
 *
 * ## What it covers
 *
 * A fenced block used to be a root-level node and nothing else, because of a claim that turned out to
 * be false. Measured against the running kernel (2026-10-16):
 *
 * · `insertBlock` with `parentID` = a list item creates a `NodeCodeBlock` **inside** it, and with
 *   `previousID` = that item's paragraph the fence lands after the item's own text;
 * · `createDocWithMd` with an indented fence produces exactly that document;
 * · `moveBlock` on a code block answers `code: 0` and **moves nothing** —— so a level change is
 *   written as create-then-delete, and that is what the store now does.
 *
 * So a code block is an ordinary node with a level, and these two cases say so from both ends:
 *
 *   1. a document that already holds a nested fence opens with it as a **child row**, and a save
 *      round-trip leaves **one** fence (a code block the write path cannot see gets a second copy
 *      inserted beside it), and
 *   2. indenting a root-level code block nests it **in the document**, and outdenting brings it back.
 *
 * The level change uses the **toolbar buttons**, not Tab: inside a code box Tab inserts a tab
 * character (that is the rule for code), so the toolbar is the only way to change a code block's
 * level — which is also why those buttons had to exist.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const CODE_BOX = '.om-outline-wrap textarea.om-node-code';
const OUTDENT = '.om-toolbar button[title="向左提升 (Shift+Tab)"]';
const INDENT = '.om-toolbar button[title="向右缩进 (Tab)"]';

/** 甲 with a fence **inside** it, then 乙 —— the shape the kernel produces from indented markdown. */
const NESTED_MD = ['- 甲', '  ```js', '  hello', '  ```', '- 乙', ''].join('\n');

/** 甲, then a document-level fence, then 乙 —— a code block with no level to begin with. */
const ROOT_CODE_MD = ['- 甲', '', '```js', 'hello', '```', '', '- 乙', ''].join('\n');

async function openToolbar(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await expect(page.locator('.om-toolbar')).toBeVisible({ timeout: 10_000 });
  }
}

/**
 * Which list item owns the **code block**, read from the export's own indentation.
 *
 * ★★ Same trap as the table case, and it is why this helper exists rather than a regex: the obvious
 *   criterion —— "the export contains `- 甲 … \n\s+```js`" —— matches a **document-level** fence too,
 *   because `\s+` swallows the newline of the blank line above it. So the level is read the way the
 *   document states it, and `null` means the document level.
 */
function codeOwner(md: string): string | null {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^\s*`{3,}\s*\S*\s*$/.test(l) || /^\s*`{3,}/.test(l));
  if (i < 0) return null;
  const indent = (/^(\s*)/.exec(lines[i]) ?? ['', ''])[1].length;
  if (indent === 0) return null;
  for (let j = i - 1; j >= 0; j--) {
    const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(lines[j]);
    if (m && m[1].length < indent) return lines[j].trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
  }
  return null;
}

/** x of every rendered node, in document order: a code box's x is the code block's own indent. */
async function nodeXs(page: Parameters<typeof toOutlineView>[0]): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.om-outline-wrap .node-row:not(.node-row-empty)')].map((row) => {
      const el = row.querySelector('.node-text, textarea.om-node-code') as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().x) : -1;
    }),
  );
}

async function docMd(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const res = await api.call('/api/export/exportMdContent', { id: docId });
  return String((res.data as { content?: string })?.content ?? '');
}

/** How many fenced blocks the document holds, counted over its whole body. */
function fenceCount(md: string): number {
  return md.split('\n').filter((l) => l.trim().startsWith('```')).length;
}

test('★★★ a fenced block already inside a list item loads as that node\'s child, and stays single', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, NESTED_MD);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // ★ Criterion 1: three nodes (甲, its code block, 乙) and the code block sits **deeper** than both
    //   list items. Before the fix the fence read as a top-level row, so its x equalled theirs.
    const boxes = page.locator(CODE_BOX);
    await expect(boxes, 'the nested fence must render as a code box').toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(boxes.first(), 'the source must come back without the block indent').toHaveValue('hello');
    const xs = await nodeXs(page);
    expect(xs.length, 'three nodes: 甲, its code block, 乙').toBe(3);
    expect(xs[1], 'the code block must sit deeper than 甲').toBeGreaterThan(xs[0]);
    expect(xs[2], 'and 乙 is back at the top level').toBe(xs[0]);

    // ★ Criterion 2: a save round-trip must not produce a **second** fence. A code block the write
    //   path cannot see is judged "new in the UI", inserted beside the original, and the original is
    //   then deleted as "in the document but not in the tree" —— a shape this case exists to catch.
    const before = await docMd(api, docId);
    const box = boxes.first();
    await box.click();
    await page.keyboard.type('!');
    await expect(box, 'the edit lands in the box').toHaveValue('hello!', { timeout: 10_000 });
    await expect
      .poll(() => docMd(api, docId), {
        message: 'the edited source must reach the nested block',
        timeout: 30_000,
      })
      .toContain('hello!');
    const after = await docMd(api, docId);
    expect(fenceCount(after), 'exactly one fence —— a second copy is the failure this guards').toBe(
      fenceCount(before),
    );
    expect(codeOwner(after), 'and it is still nested, not promoted to the document level').toBe('甲');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★★ indenting a code block nests it in the document, and outdenting brings it back', async ({
  page,
}) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, ROOT_CODE_MD);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await openToolbar(page);

    const box = page.locator(CODE_BOX).first();
    await expect(box, 'the document-level fence must render as a code box').toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => docMd(api, docId), { message: 'precondition: the fixture starts with one fence' })
      .toContain('hello');
    expect(codeOwner(await docMd(api, docId)), 'precondition: the document agrees it is at the root')
      .toBeNull();
    const startXs = await nodeXs(page);
    expect(startXs.length, 'three nodes: 甲, the code block, 乙').toBe(3);
    expect(startXs[1], 'precondition: the code block starts at the top level').toBe(startXs[0]);

    // ---- indent: the code block becomes a child of 甲 ----
    await box.click();
    // ★ Wait for the caret rather than trusting the click: a keystroke... (there is none here, the
    //   toolbar reads `document.activeElement`) —— so this waits for the **target** the toolbar will use.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ae = document.activeElement as HTMLElement | null;
            return ae?.className?.toString().includes('om-node-code') ?? false;
          }),
        { message: 'the caret must be in the code box before indenting', timeout: 15_000 },
      )
      .toBe(true);
    await page.locator(INDENT).click();
    await expect
      .poll(() => nodeXs(page).then((xs) => xs[1]), {
        message: 'the code block must move one level deeper',
        timeout: 20_000,
      })
      .toBeGreaterThan(startXs[1]);
    await expect
      .poll(() => docMd(api, docId).then(codeOwner), {
        message: '★ the document must show the fence nested inside 甲 —— a panel-only move is the failure',
        timeout: 30_000,
      })
      .toBe('甲');
    expect(fenceCount(await docMd(api, docId)), 'still exactly one fence after the indent').toBe(2);

    // ---- outdent: back to the document level ----
    await page.locator(CODE_BOX).first().click();
    await page.locator(OUTDENT).click();
    await expect
      .poll(() => nodeXs(page).then((xs) => xs[1]), {
        message: 'the code block must come back to the top level',
        timeout: 20_000,
      })
      .toBe(startXs[1]);
    await expect
      .poll(() => docMd(api, docId).then(codeOwner), {
        message: '★ the document must show the fence at the document level again (column 0)',
        timeout: 30_000,
      })
      .toBeNull();
    expect(fenceCount(await docMd(api, docId)), 'one fence after the outdent, not two').toBe(2);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});