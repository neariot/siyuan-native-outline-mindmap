/**
 * ★★★ A table inserted from the outline is a **real SiYuan table block**.
 *
 * ## Why this needed its own node kind
 *
 * The toolbar used to inject `<table>` into a node's text. A table cannot live there: the
 * kernel stores the attempt as the literal text `<protyle-html>`, and the write path strips
 * the tags, so the table was lost **and** the node was left holding one `&nbsp;` per cell.
 * `insertBlock` with a `NodeTable` **DOM** answers `code: 0` and creates nothing, so the only
 * route is a **markdown** table — which is what a table node is written as.
 *
 * ## Why the criterion is the kernel's block tree
 *
 * "The outline shows a table" proves nothing: the old button did that too. The criterion is a
 * block of type `t` under the document, its kramdown after a write, and the same block after a
 * reload. A second document with a table written **by hand in SiYuan** is opened to check the
 * other direction — that loading a document does not quietly lose a table the plugin never made.
 *
 * See `docs/todo/inline-markup-sync.md` §D9 for the measurements.
 */
import { test, expect, type Page } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook, type KernelApi } from './testdoc';
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

async function blockTypes(api: KernelApi, docId: string): Promise<string[]> {
  const r = await api.call('/api/query/sql', {
    stmt: `SELECT type FROM blocks WHERE root_id='${docId}' ORDER BY id LIMIT 200`,
  });
  const rows = (r.data as Array<{ type: string }>) ?? [];
  return rows.map((x) => x.type);
}

async function kramdown(api: KernelApi, docId: string): Promise<string> {
  const r = await api.call('/api/block/getBlockKramdown', { id: docId });
  return String((r.data as { kramdown?: string })?.kramdown ?? '');
}

/**
 * Wait until the outline **shows what the document holds**.
 *
 * ★ Not a settle counter and not a sleep.
 *
 *   Two earlier attempts both failed: polling the kernel's kramdown for two identical reads
 *   passes during a lull, and passing in isolation but failing in the full suite is exactly
 *   what a load-sensitive wait looks like. The condition this waits for is the one that
 *   actually matters — the rows on screen agree with the blocks in the document — so the
 *   editing case cannot type into a row that is about to be replaced.
 *
 *   If it times out, the failure says which side disagrees instead of "the edit was lost".
 */
async function waitForOutlineToMatchDocument(
  api: KernelApi,
  page: Page,
  docId: string,
): Promise<void> {
  const kernelTexts = async (): Promise<string> => {
    const kd = await kramdown(api, docId);
    // Every `- item` line of the document, in order.
    return (kd.match(/^- .*$/gm) ?? []).map((l) => l.replace(/^-\s*\{:[^}]*\}\s*/, '')).join('|');
  };
  const shownTexts = (): Promise<string> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.om-outline-wrap .node-text'))
        .map((e) => (e.textContent || '').trim())
        .join('|'),
    );
  await expect
    .poll(
      async () => ({ kernel: await kernelTexts(), shown: await shownTexts() }),
      {
        message: 'the outline must show what the document holds before anything is edited',
        timeout: 30_000,
      },
    )
    .toEqual({ kernel: await kernelTexts(), shown: await shownTexts() } as never);
}

/** Open the markup toolbar, which starts collapsed (measured). */
async function openToolbar(page: Page): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.count() && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(page.locator('.om-outline-wrap button.om-toolbar-toggle').first()).toBeVisible({
    timeout: 15_000,
  });
}

test('★★ a table inserted from the outline becomes a real table block', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').first()).toBeVisible();
    await openToolbar(page);

    expect(await blockTypes(api, docId), 'precondition: no table yet').not.toContain('t');

    await page.locator('.om-outline-wrap button[title="表格"]').first().click();
    const insert = page.locator('.om-outline-wrap button.primary', { hasText: /Insert|插入/ }).first();
    await expect(insert).toBeVisible({ timeout: 10_000 });
    await insert.click();

    // ★ The kernel's own answer: a block of type `t`, hung off the document.
    await expect
      .poll(async () => blockTypes(api, docId), {
        message: 'the document must hold a table block (type "t")',
        timeout: 20_000,
      })
      .toContain('t');

    const kd = await kramdown(api, docId);
    // ★ The kernel rewrites the separator it is given (` ---` comes back as ` --`), so the
    //   assertion is on "a separator row exists", not on the exact dashes we sent.
    expect(kd, 'the table must be stored as markdown, not as a lost <table>').toMatch(/\|\s*-{2,}/);
    expect(kd, 'no protyle-html residue').not.toContain('<protyle-html');
    // ★ And the nodes must still be there — a table must not swallow the list.
    expect(kd).toContain('甲');
    expect(kd).toContain('乙');

    // And it comes back after a reload, drawn as a table.
    await page.reload();
    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator('.om-outline-wrap .om-node-table').first()).toBeVisible({ timeout: 30_000 });
    expect(await blockTypes(api, docId), 'the table must still be there after a reload').toContain('t');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ a table written in SiYuan loads into the outline and is not lost', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    // Put the table in the way SiYuan's own editor would: a markdown table block at root.
    const r = await api.call('/api/block/insertBlock', {
      dataType: 'markdown',
      data: '| h1 | h2 |\n| --- | --- |\n| a | b |',
      parentID: docId,
      previousID: '',
      nextID: '',
    });
    expect((r.data as string) ?? '', 'precondition: the table block was created').toBeTruthy();


    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').first()).toBeVisible();
    await waitForStableOutline(page);
    // ★ The table must be visible, not silently folded into a neighbouring node as text.
    await expect(page.locator('.om-outline-wrap .om-node-table').first()).toBeVisible({ timeout: 30_000 });
    await waitForOutlineToMatchDocument(api, page, docId);

    // Edit a node, so the whole tree goes through the save path.
    // ★ Located by its text, not by position: a table row is also a `.node-row`, so "the
    //   first row" is no longer the same thing it was before tables existed.
    const target = page.locator('.om-outline-wrap .node-text').filter({ hasText: '甲' }).first();
    await target.click();
    // ★ Fail fast if the caret did not land: `keyboard.type` into a page that has focus
    //   somewhere else types nothing and reports success, which reads as "the edit was lost".
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''), {
        message: 'the node text box must really hold the caret before typing',
        timeout: 10_000,
      })
      .toContain('node-text');
    await page.keyboard.press('End');
    await page.keyboard.type('丁');
    // ★ Wait for the condition rather than a stopwatch: the write-back is asynchronous and a
    //   fixed delay would make this a measure of the machine, not of the code.
    // ★ Both sides are read, because "the edit never arrived" has two very different causes:
    //   text typed into nothing (the outline does not show it either) versus a write that was
    //   never sent. Only the second one is about the write path, and the failure has to say
    //   which one happened rather than leaving the reader to guess.
    await expect
      .poll(
        async () =>
          `outline[${await page.evaluate(() =>
            Array.from(document.querySelectorAll('.om-outline-wrap .node-text'))
              .map((e) => (e.textContent || '').trim())
              .join('|'),
          )}] document[${(await kramdown(api, docId)).replace(/\n\{:[^}]*\}/g, '')}]`,
        { message: 'the edit must reach the document', timeout: 20_000 },
      )
      .toContain('丁');

    const kd = await kramdown(api, docId);
    expect(kd, 'the table must survive an edit').toMatch(/\|\s*-{2,}/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});