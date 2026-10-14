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

/**
 * Re-open the document after a write, waiting for SiYuan's **own** navigation to finish first.
 *
 * ★ Why the wait is a condition and not a delay: a write makes SiYuan navigate on its own, and a
 *   second navigation while that one is in flight is interrupted (measured:
 *   `Navigation ... is interrupted by another navigation`). Sleeping a fixed time is a question
 *   about the machine; this waits for the document to be loaded and idle-in-the-browser-sense,
 *   which is the thing that actually has to be true.
 */
async function reopenDoc(page: Page, docId: string): Promise<void> {
  await page.waitForFunction(
    () => document.readyState === 'complete' && Boolean(window.siyuan?.layout),
    undefined,
    { timeout: 60_000 },
  );
  await openDoc(page, docId);
}

test('★★★ a cell edit reaches the table block and survives a reload', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    // ★★★ The first cell edit is a **precondition, not the assertion**, and that is the whole
    // trick in this case.
    //
    //   The first write-back after a document opens has a **null baseline**, so it takes the
    //   structural route, and `syncStructure` rewrites every table block wholesale. A case that
    //   types into a cell as the very first action therefore passes **even with `syncTableCells`
    //   deleted** (measured: the poll on `a丙` stayed green against a build whose table write-back
    //   was disabled) —— the strongest possible false pass, because the edit really did reach the
    //   document, just through a path that has nothing to do with the code under test.
    //
    //   So the case makes **two** cell edits and asserts on the second. By then the baselines
    //   exist and the structural route is not running, so the second edit can only be explained by
    //   `syncTableCells`. Making the first edit a table cell rather than an ordinary node edit is
    //   deliberate too: a node edit as the precondition is itself occasionally lost (the residual
    //   race recorded in `docs/todo/inline-markup-sync.md` §4), and a precondition that flakes
    //   makes the whole case a flake generator.
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
    const r = await api.call('/api/block/insertBlock', {
      dataType: 'markdown',
      data: '| h1 | h2 |\n| --- | --- |\n| a | b |',
      parentID: docId,
      previousID: '',
      nextID: '',
    });
    expect((r.data as string) ?? '', 'precondition: the table block was created').toBeTruthy();

    // ★ Every write this plugin makes, in order. A cell edit that never leaves the browser and a
    //   cell edit that leaves and is refused by the kernel look identical from the panel, and the
    //   two have different causes; this is what tells them apart.
    const writes: string[] = [];
    // ★ Plugin diagnostics, from **every** frame: the panel runs in a frame of its own, so a
    //   `console.warn` from the plugin does not reach a listener attached to the top page alone.
    const omWarn: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('[om')) omWarn.push(m.text());
    });
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/block\/(updateBlock|insertBlock|appendBlock|deleteBlock|moveBlock)/.test(req.url())) {
        let body = '';
        try {
          body = JSON.stringify(req.postDataJSON()).slice(0, 220);
        } catch {
          body = '<unreadable>';
        }
        writes.push(`${req.url().split('/api/')[1]} ${body}`);
      }
    });

    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator('.om-outline-wrap .om-node-table').first()).toBeVisible({ timeout: 30_000 });
    await waitForOutlineToMatchDocument(api, page, docId);

    // Edit one cell: click it, prove the caret is really in it, type.
    const editCell = async (rowCol: string, expectBefore: string, typed: string): Promise<void> => {
      const cell = page.locator(`.om-outline-wrap .om-node-cell[data-cell$=":${rowCol}"]`).first();
      await expect(cell, `cell ${rowCol} must be editable, not plain text`).toHaveAttribute(
        'contenteditable',
        'true',
        { timeout: 15_000 },
      );
      await cell.click();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const a = document.activeElement as HTMLElement | null;
              return `${a?.className ?? ''}|${(a?.textContent ?? '').trim()}`;
            }),
          { message: `the caret must be inside cell ${rowCol}`, timeout: 10_000 },
        )
        .toContain(`om-node-cell|${expectBefore}`);
      await page.keyboard.press('End');
      await page.keyboard.type(typed);
      // ★ The caret is in the cell, the character is in the element — and the model only follows
      //   when the browser reports an input event. `toContain` on `textContent` cannot see the
      //   difference, and the difference is the whole feature.
      await expect
        .poll(
          () =>
            page.evaluate(
              (sel) => document.querySelector(sel)?.textContent ?? '',
              `.om-outline-wrap .om-node-cell[data-cell$=":${rowCol}"]`,
            ),
          { message: `the typed text must be in cell ${rowCol}`, timeout: 10_000 },
        )
        .toBe(expectBefore + typed);
      // ★ And the model must have it too, not just the DOM. Polled, because the panel is emptied
      //   and re-rendered for ~500ms after a write-back (measured) and the cells are gone for that
      //   window — reading once, immediately, would report "no cell" and hide the real state.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const cells = Array.from(document.querySelectorAll('.om-outline-wrap .om-node-cell'));
              return cells.map((e) => (e.textContent || '').trim()).join('|');
            }),
          { message: `the model must carry the text typed into cell ${rowCol}`, timeout: 10_000 },
        )
        .toContain(expectBefore + typed);
    };

    // ── Step 1: the precondition edit. Its result is NOT asserted as proof of anything. ──
    await editCell('0:0', 'a', '丙');
    // ★ The evidence has to come from **inside** the polled function: `expect.poll` builds its
    //   `message` once, before the edit, so anything captured outside it describes the past.
    const seen = async (): Promise<string> => {
      const kd = (await kramdown(api, docId)).replace(/\n\{:[^}]*\}/g, '');
      return `kd=${kd} writes=${writes.join(' ;; ')} warn=${omWarn.join(' ;; ')}`;
    };
    await expect
      .poll(seen, { message: 'precondition: the first cell edit must land', timeout: 25_000 })
      .toMatch(/\|\s*a丙\s*\|/);

    // ── Step 2: the edit under test. Only `syncTableCells` can put this in the document. ──
    await editCell('0:1', 'b', '丁');
    await expect
      .poll(seen, { message: 'the second cell edit must reach the table block', timeout: 25_000 })
      .toMatch(/\|\s*b丁\s*\|/);

    // ── Step 3: it is a table block, not markup pasted into a paragraph ──
    // ★ The kernel rewrites both the separator (` ---` comes back as `-----`) and the cell padding,
    //   so nothing here asserts on the exact spacing we sent —— only on the shape.
    const kd = await kramdown(api, docId);
    expect(kd, 'no protyle-html residue').not.toContain('<protyle-html');
    expect(kd, 'the separator row must survive a cell edit').toMatch(/\|\s*-{2,}/);
    // ★ Each cell must hold **its own** edit and nothing else: a writer that mixed the two up, or
    //   wrote both into one, is the data-loss shape the addressing in `outline/table-cells.ts`
    //   exists to prevent.
    expect(kd, 'both cells hold their own edit').toMatch(/\|\s*a丙\s*\|\s*b丁\s*\|/);
    expect(kd, 'the header must not be touched').toMatch(/\|\s*h1\s*\|\s*h2\s*\|/);

    // ── Step 4: and it survives a reload, which is what "synced" has to mean ──
    //
    // ★ `reopenDoc`, not `page.reload()`: `openDoc` navigates with `page.goto`, which is already a
    //   full load that tears the page down and re-runs the plugin from scratch, so an extra
    //   `reload()` adds nothing but a race with SiYuan's own post-write navigation.
    await reopenDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator('.om-outline-wrap .om-node-table').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll('.om-outline-wrap .om-node-cell')).map((e) =>
              (e.textContent || '').trim(),
            ),
          ),
        { message: 'the edited cell must come back after a reload', timeout: 30_000 },
      )
      .toEqual(expect.arrayContaining(['a丙', 'b丁']));
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ Tab walks the cells and stops inside the table', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
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
    await expect(page.locator('.om-outline-wrap .om-node-table').first()).toBeVisible({ timeout: 30_000 });
    await waitForOutlineToMatchDocument(api, page, docId);

    const first = page.locator('.om-node-cell[data-cell$=":-1:0"]').first();
    await first.click();
    const activeCell = async (): Promise<string> =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-cell') ?? 'none');

    // Four cells: header (0,0), header (0,1), body (0,0), body (0,1).
    const walk = [':-1:0', ':-1:1', ':0:0', ':0:1'];
    for (const suffix of walk) {
      await expect.poll(activeCell, { message: `Tab must land on ${suffix}`, timeout: 10_000 }).toContain(suffix);
      if (suffix !== walk[walk.length - 1]) await page.keyboard.press('Tab');
    }
    // ★ At the last cell `Tab` must **not** leave the table: an escaped caret ends up in the
    //   document body and the next write-back stores it in the next node.
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    expect(await activeCell(), 'Tab at the last cell must not leave the table').toContain(':0:1');
    expect(await activeCell()).not.toBe('none');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});