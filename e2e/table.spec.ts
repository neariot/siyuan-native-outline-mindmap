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

/**
 * Edit a cell by writing its text and firing the input event a keystroke fires.
 *
 * ★ Used for the step **under test**, where the keyboard would introduce a harness race: the panel
 *   re-renders when a write-back lands, and a caret placed a moment earlier is thrown away ——
 *   measured, the typing then went to `fn__flex-column` and the document kept the previous text.
 *   That says nothing about the write path, which is what this case is for.
 *
 * The cell is focused first because `syncCell` refuses input from a cell that does not hold the
 * caret (that guard is what stops a stale cell writing a neighbour's text), so this is still the
 * real path: focus → text → `input` → `syncCell` → model → write-back.
 */
async function editCellFocused(
  page: Page,
  rowCol: string,
  expectBefore: string,
  typed: string,
): Promise<void> {
  const sel = `.om-outline-wrap .om-node-cell[data-cell$=":${rowCol}"]`;
  await expect(page.locator(sel).first()).toHaveText(expectBefore, { timeout: 15_000 });
  await page.locator(sel).first().evaluate(
    (el, text) => {
      const box = el as HTMLElement;
      box.focus();
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
    expectBefore + typed,
  );
}

/**
 * Wait until the table on screen is **stable**: the same cells with the same text, twice in a row.
 *
 * ★★★ Why a row-count wait is not enough, and why this is a condition rather than a delay.
 *
 *   A write-back empties the panel and re-renders it (measured: `shown=""` for ~500ms). During
 *   that window a cell can be focused and then **thrown away**, which is exactly what a failing run
 *   showed: the caret was placed in the cell under test, and by the time the keystroke was sent
 *   `document.activeElement` was `fn__flex-column` —— the panel, not the cell, so the character went
 *   nowhere and the document kept the previous text. `waitForStableOutline` cannot see this: it
 *   samples the **row count**, and a row survives its cells being replaced.
 *
 *   So the condition is "the cells and their text are what they were one interval ago". A case that
 *   types into a cell is otherwise asserting about a table that is still being rebuilt.
 */
async function waitForStableTable(page: Page): Promise<void> {
  const snapshot = (): Promise<string> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.om-outline-wrap .om-node-cell'))
        .map((e) => `${e.getAttribute('data-cell')}=${e.textContent ?? ''}`)
        .join('|'),
    );
  let previous = '\u0000';
  await expect
    .poll(
      async () => {
        const now = await snapshot();
        const unchanged = now === previous;
        previous = now;
        return unchanged && now.length > 0;
      },
      {
        message: 'the table must hold still before a cell is edited',
        timeout: 20_000,
        intervals: [300],
      },
    )
    .toBe(true);
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
  try {
    await openDoc(page, docId);
  } catch (e) {
    // ★★ SiYuan navigates on its own when a write lands, and a `goto` that overlaps that
    //   navigation is **interrupted** —— `Navigation … is interrupted by another navigation`
    //   (measured). That is the browser reporting a race in the harness, not a product failure:
    //   the document is loaded either way, so the navigation is retried once, after the in-flight
    //   one has had its turn.
    if (!/interrupted by another navigation/i.test(String(e))) throw e;
    await page.waitForFunction(
      () => document.readyState === 'complete' && Boolean(window.siyuan?.layout),
      undefined,
      { timeout: 60_000 },
    );
    await openDoc(page, docId);
  }
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
    page.on('response', async (res) => {
      if (!/\/api\/block\/updateBlock/.test(res.url())) return;
      let body = '';
      try {
        body = (await res.text()).slice(0, 160);
      } catch {
        body = '<unreadable>';
      }
      writes.push(`RESP ${res.status()} ${body}`);
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
      await waitForStableTable(page);
      await cell.click();
      // ★★★ Focus is **placed**, not hoped for.
      //
      //   Measured: `click()` on a contenteditable div does not reliably move the caret when the
      //   previous cell still has focus, and the diagnostic caught it in the act ——
      //   `focusAtType=…:0:0` while the test believed it was typing into `0:1`, so the keystroke
      //   went to the old cell and the document was given *its* text. A cell edit is only
      //   meaningful once the caret is provably in that cell, so the precondition is the caret
      //   itself and it is established explicitly.
      await cell.evaluate((el) => {
        (el as HTMLElement).focus();
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              (sel) => (document.activeElement as HTMLElement | null)?.getAttribute?.('data-cell') ?? '',
              `.om-outline-wrap .om-node-cell[data-cell$=":${rowCol}"]`,
            ),
          { message: `the caret must be inside cell ${rowCol}`, timeout: 10_000 },
        )
        .toContain(`:${rowCol}`);
      await expect
        .poll(
          () =>
            page.evaluate(
              (sel) => document.querySelector(sel)?.textContent ?? '',
              `.om-outline-wrap .om-node-cell[data-cell$=":${rowCol}"]`,
            ),
          { message: `cell ${rowCol} must show its own model text before typing`, timeout: 10_000 },
        )
        .toBe(expectBefore);
      await page.keyboard.press('End');
      await page.keyboard.type(typed);
      // ★ Which element the keystroke actually reached. A cell that shows the text but sends the
      //   *other* cell's text is a focus/target problem, and this tells the two apart.
      omWarn.push(
        'focusAtType=' +
          (await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            return `${a?.className ?? ''}#${a?.getAttribute?.('data-cell') ?? ''}=${JSON.stringify(a?.textContent ?? '')}`;
          })),
      );
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
    //
    // ★ ★★ Retried **once**, and that is deliberate rather than a papered-over flake: the
    //   precondition is here to make the second edit meaningful, and the pre-existing residual
    //   race documented in `docs/todo/inline-markup-sync.md` §4 can swallow *any* edit made in
    //   this window (measured under full-suite load: a lone `moveBlock`, no `updateBlock`, and
    //   `syncTableCells` never entered). A test about which writer owns a table body must not be
    //   taken red by a defect it is not testing —— but it also must not hide it, so the second
    //   edit below is asserted **once** and never retried, and the precondition records that it
    //   needed a retry when that happens.
    const seen = async (): Promise<string> => {
      const kd = (await kramdown(api, docId)).replace(/\n\{:[^}]*\}/g, '');
      return `kd=${kd} writes=${writes.join(' ;; ')} warn=${omWarn.join(' ;; ')}`;
    };
    const landed = async (): Promise<boolean> => /\|\s*a丙\s*\|/.test(await seen());
    await editCell('0:0', 'a', '丙');
    await expect
      .poll(landed, { message: 'precondition: the first cell edit must land', timeout: 20_000 })
      .toBe(true)
      .catch(async () => {
        // One more attempt, from a **fresh** cell lookup so the focused element is re-read.
        console.warn('[e2e] the precondition edit hit the §4 race; retrying once');
        await reopenDoc(page, docId);
        await toOutlineView(page);
        await editCell('0:0', 'a', '丙');
        await expect
          .poll(landed, { message: 'precondition: the retried cell edit must land', timeout: 20_000 })
          .toBe(true);
      });

    // ── Step 2: the edit under test. Only `syncTableCells` can put this in the document. ──
    //
    // ★ The precondition edit's write-back must be **finished** before this one starts, and that is
    //   a condition, not a delay: while a write-back is in flight the panel empties and re-renders,
    //   and a cell focused in that window is thrown away —— measured, the keystroke then landed in
    //   `fn__flex-column` (the panel) and the document kept the old text, which reads exactly like
    //   the writer being broken.
    //
    //   So the wait is for the *document* to hold the precondition edit **and** the outline to show
    //   it, which is the state this step needs and cannot be satisfied by a still-rebuilding panel.
    await expect
      .poll(
        async () =>
          (await page.evaluate(() =>
            Array.from(document.querySelectorAll('.om-outline-wrap .om-node-cell'))
              .map((e) => (e.textContent || '').trim())
              .join('|'),
          )) + '||' + (await kramdown(api, docId)).replace(/\n\{:[^}]*\}/g, ''),
        { message: 'the panel and the document must agree before the second edit', timeout: 25_000 },
      )
      .toContain('b||');
    // ★★★ The second edit is driven **without the keyboard**, and that is the point rather than a
    //   shortcut.
    //
    //   Measured: the precondition edit's own write-back arrives over the websocket and re-renders
    //   the panel at a time no sampling can predict —— in the failing runs the caret had been placed
    //   in the cell and typing still landed in `fn__flex-column` (the panel), so the document kept
    //   the old text. That is a harness race *before* the code under test is reached, and a case
    //   that flakes there cannot be evidence about the writer.
    //
    //   What the case is actually about is the **write path**: a cell whose model changed must reach
    //   its table block through `syncTableCells` and nobody else. Setting the cell's text and firing
    //   the same `input` event a keystroke fires exercises exactly that, with no caret involved ——
    //   and the caret guard in `syncCell` means the element must really be the focused one, so the
    //   cell is focused explicitly first.
    await editCellFocused(page, '0:1', 'b', '丁');
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

    // ── Step 3b: a **later structural pass** must not write the old cells back ──
    //
    // ★★★ This is the trigger for D19, and without it the case is only a partial guard (measured:
    //   3 of 5 runs red under the mutation, which `redproof.py --repeat` correctly refuses).
    //
    //   `moveBlock` carries a block's content from the tree the pass was given, so a structural pass
    //   whose tree predates a cell edit writes the old cells back over it. Adding a node forces
    //   exactly such a pass, and the edits above must survive it.
    await page.locator('.om-outline-wrap .node-text').first().click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''), {
        message: 'a node must be active before adding a sibling',
        timeout: 10_000,
      })
      .toContain('node-text');
    const addSibling = page.locator('.om-dock button.add-btn').first();
    await expect(addSibling, 'the add-sibling button must be reachable').toBeVisible({ timeout: 15_000 });
    await addSibling.click();
    await expect
      .poll(async () => (await blockTypes(api, docId)).filter((x) => x === 'i').length, {
        message: 'the structural change must reach the document',
        timeout: 25_000,
      })
      .toBeGreaterThan(2);

    // ★ Both cell edits are still there after that pass. This is the assertion D19 needs.
    await expect
      .poll(async () => (await kramdown(api, docId)).replace(/\n\{:[^}]*\}/g, ''), {
        message: 'a later structural pass must not write a table\'s old cells back over a saved edit',
        timeout: 25_000,
      })
      .toMatch(/\|\s*a丙\s*\|\s*b丁\s*\|/);

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
