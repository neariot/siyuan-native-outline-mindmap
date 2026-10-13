/**
 * ★ A numbered node must survive delete → undo as an ordered list item.
 *
 * Reported shape: the toolbar `1.` button and the `1. ` inline shortcut both set `numbered` with no
 * text change, yet every write path emitted `- ` —— the outline showed numbering SiYuan never
 * received, and a reload silently dropped it.
 *
 * What this case drives: a document holding `- 甲` / `1. 乙`, deleting 乙 in the outline, then
 * undoing. Undo re-inserts the (now unmapped) node through `syncStructure`, so the insert itself
 * must carry `1. ` (`nodeInsertLine`). The assertion reads the **document** anchored at line start
 * (`/^1\. /m`): the broken build wrote `- 乙`, and a plain `toContain('1. 乙')` would also let the
 * doubled `- 1. 乙` pass —— both weaker assertions are pinned here so nobody "simplifies" them.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

let notebook = '';
const apiOf = () => kernelApi(siyuanUrl(), siyuanToken());

test.beforeAll(async () => {
  const api = await apiOf();
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

test('★ deleting a numbered node and undoing restores it as an ordered item', async ({ page }) => {
  const api = await apiOf();
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n1. 乙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row:not(.node-row-empty)');
    await expect(rows, 'the fixture should show two rows').toHaveCount(2);

    // Select 乙's row with Ctrl+click: the row's mousedown blurs any focused text for
    // modifier clicks, so focus stays off .node-text and Delete takes the deleteNodes path
    // (a plain click would focus the text and clear the selection instead).
    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(300);
    // The wrap div owns the Delete handler (`tabIndex={-1}` + onKeyDown): with focus on <body>
    // the keypress never reaches it, so focus the wrap first (tabbing into the panel does the same).
    await page.evaluate(() => {
      (document.querySelector('.om-outline-wrap') as HTMLElement)?.focus();
    });
    await page.keyboard.press('Delete');
    await expect
      .poll(async () => rows.count(), {
        message: '乙 should disappear from the outline after Delete',
        timeout: 10_000,
      })
      .toBe(1);

    // Undo: the Ctrl+Z handler lives on the node-text input, so focus one first.
    await rows.first().locator('.node-text').first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+z');

    // The re-insert must carry the ordered marker —— poll the document, not the screen.
    await expect
      .poll(async () => body(api, docId), {
        message: 'undo must restore 乙 to the document as an ordered item, not a plain one',
        timeout: 20_000,
      })
      .toMatch(/^1\. 乙/m);
    await expect(rows, '乙 should be back in the outline too').toHaveCount(2);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★ numbering an already-synced node converts its list in place', async ({ page }) => {
  const api = await apiOf();
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    await openDoc(page, docId);
    await toOutlineView(page);

    const rows = page.locator('.om-outline-wrap .node-row:not(.node-row-empty)');
    await expect(rows, 'the fixture should show two rows').toHaveCount(2);

    // Type the ordered shortcut at the START of the existing 乙 row: the inline shortcut sets
    // `numbered` while the text stays 乙, so the write-back must convert the block (delete +
    // reinsert as `1. `) rather than rewriting the text.
    await rows.nth(1).locator('.node-text').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.type('1. ');

    // Poll the document: the text never changes, so only a real conversion satisfies this.
    // The pre-conversion build leaves `- 乙` forever (and the outline keeps showing it numbered
    // until reload) —— that silent loss is exactly what this case guards.
    await expect
      .poll(async () => body(api, docId), {
        message: 'toggling numbering on a synced node must convert its list, not just the outline model',
        timeout: 20_000,
      })
      .toMatch(/^1\. 乙/m);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
