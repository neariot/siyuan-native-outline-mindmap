/**
 * ★★★ A code block is a block: it renders, survives a round trip, and can be **deleted**.
 *
 * ## The defect this covers (D21)
 *
 * A document holding
 *
 *     ```js
 *     const a = 1;
 *     ```
 *
 * was read as **no node at all**. Each fence line fell through to the generic reader branch, where a
 * flush-left line becomes an attached paragraph of the nearest node, so the fence became
 * `` <code></code>`js ``, the source became a plain paragraph, and the whole block was folded into
 * the **document title's** paragraphs. The block showed nowhere in the outline, and because it was
 * not a node there was nothing to delete — reported as *"a code block can't be deleted at all"*.
 *
 * A second, independent cause kept it undeletable even once it was a node: `syncDeletions` scanned
 * `WHERE type='i'` (listItems), and a code block is `type='c'`. So a removed code block was never a
 * deletion candidate, nothing was sent, no error was raised, and it stayed in the document.
 *
 * ## Why the criteria are what they are
 *
 * * **presence** — the block must appear as its own row. "The text is somewhere on the page" was
 *   already true in the broken build: it was inside the title's paragraph.
 * * **verbatim content** — the source is compared byte for byte, because the defect transformed it.
 * * **deletion** — asserted against the **kernel**, not the panel. A block that vanished from the
 *   outline while staying in the document is exactly the reported symptom, and only the kernel can
 *   tell those apart.
 *
 * The block is created **in SiYuan** rather than through the plugin, so this case is about reading
 * and deleting a block the plugin did not author — the shape the user actually hit.
 */
import { test, expect, type Page } from './fixtures';
import { openDoc, toOutlineView, toMindmapView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook, type KernelApi } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

let notebook = '';

/** The code the fixture stores. Markup-looking on purpose — see the "verbatim" case below. */
const SOURCE = 'const a = 1;\nif (a) { console.log(a); }';
const NASTY = '| a | b |\n# heading\n- list item';

test.beforeAll(async () => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  try {
    notebook = await resolveTestNotebook(api);
  } finally {
    await api.dispose();
  }
});

/** Put a code block into a fresh document, as SiYuan itself would store one. */
async function docWithCodeBlock(api: KernelApi, source: string, lang = 'js'): Promise<string> {
  const docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
  const r = await api.call('/api/block/insertBlock', {
    dataType: 'markdown',
    data: `\`\`\`${lang}\n${source}\n\`\`\``,
    parentID: docId,
    previousID: '',
    nextID: '',
  });
  expect((r.data as unknown[] | null) ?? [], 'precondition: the code block was created').toBeTruthy();
  return docId;
}

/** Block types present in the document, from the kernel's own index. */
async function types(api: KernelApi, docId: string): Promise<string> {
  const r = await api.call('/api/query/sql', {
    stmt: `SELECT id, type FROM blocks WHERE root_id='${docId}' LIMIT 50`,
  });
  return JSON.stringify((r.data as Array<{ id: string; type: string }>) ?? []);
}

/** The code block's source as the **document** holds it, or `null` when there is no code block. */
async function storedCode(api: KernelApi, docId: string): Promise<string | null> {
  // ★ Read it from the DOM, not SQL: the index lags a fresh insert by seconds (measured, and
  //   `loadBlockMap`'s own comment records it), so a SQL-based check would report "gone" for a
  //   block that is right there.
  const dom = await api.call('/api/block/getBlockDOM', { id: docId });
  const html = String((dom.data as { dom?: string })?.dom ?? '');
  const id = /data-node-id="([^"]+)"[^>]*data-type="NodeCodeBlock"/.exec(html)?.[1];
  if (!id) return null;
  const kb = await api.call('/api/block/getBlockKramdown', { id });
  return String((kb.data as { kramdown?: string })?.kramdown ?? '');
}

/** The code source the outline is showing, or `null` when no code block is rendered. */
function shownCode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // ★ The box is a `<textarea>` (editable source), not a `<pre><code>` display:
    //   its value is the source verbatim, newlines included.
    const el = document.querySelector('.om-outline-wrap textarea.om-node-code') as HTMLTextAreaElement | null;
    return el ? el.value : null;
  });
}

test('★★★ a code block renders as its own node, and can be deleted', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await docWithCodeBlock(api, SOURCE);
    expect(await storedCode(api, docId), 'precondition: the document holds a code block').toContain(
      'const a = 1;',
    );

    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // ── It is a node, and the source is shown verbatim ──
    await expect
      .poll(() => shownCode(page), {
        message: 'the code block must render as its own row, not fold into the title',
        timeout: 20_000,
      })
      .toBe(SOURCE);
    // ★ The language is carried, so the block is not just a generic `<pre>`.
    await expect(page.locator('.om-outline-wrap .om-node-code').first()).toHaveAttribute(
      'data-lang',
      'js',
    );

    // ── It is deletable, and the deletion reaches the DOCUMENT ──
    const writes: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/block\//.test(req.url())) {
        let body = '';
        try {
          body = JSON.stringify(req.postDataJSON()).slice(0, 140);
        } catch {
          body = '<unreadable>';
        }
        writes.push(`${req.url().split('/api/')[1]} ${body}`);
      }
    });
    const row = page.locator('.om-outline-wrap .node-row').filter({ has: page.locator('.om-node-code') }).first();
    await expect(row, 'the code block must have a row of its own to act on').toBeVisible();
    await row.click();
    // ★ The click must **select** the row: Delete only acts on `selected`. The click lands
    //   in the editable box, so the caret is there too — and a Delete with the caret in the
    //   box must edit a character, not the node (see `handleWrapKeyDown`). Deleting the node
    //   therefore means focus outside any editor (as after clicking the row's own chrome,
    //   which focuses the wrap, never the box): focus the wrap, then Delete.
    await expect(row, 'clicking a code-block row must select it').toHaveClass(/selected/);
    await page.locator('.om-outline-wrap').first().focus();
    await page.keyboard.press('Delete');

    // ★ The evidence comes from **inside** the polled function: `expect.poll` builds `message` once,
    //   before any request, so a snapshot taken outside it describes the past.
    const seen = async (): Promise<string> => {
      const gone = (await storedCode(api, docId)) === null;
      return `gone=${gone} writes=${writes.join(' ;; ')}`;
    };
    await expect
      .poll(seen, {
        message: 'deleting the code block must remove it',
        timeout: 25_000,
      })
      .toContain('gone=true');
    // ★ And it must be gone from the kernel's block list, not merely empty.
    //   Polled, not asserted once: the SQL index lags a delete by seconds (the same lag
    //   `loadBlockMap` documents), so reading it immediately after the DOM confirms reports a
    //   stale row for a block that is already gone.
    await expect
      .poll(async () => (await types(api, docId)).includes('"c"'), {
        message: 'no code block may remain in the kernel block list',
        timeout: 20_000,
      })
      .toBe(false);
    // ★ The neighbouring nodes must survive: a delete that took the list with it is data loss.
    await expect
      .poll(
        async () => {
          const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
          return String((kd.data as { kramdown?: string })?.kramdown ?? '');
        },
        { message: 'the list items must survive deleting the code block', timeout: 20_000 },
      )
      .toContain('甲');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★★ the source is never parsed as markup, and survives a reload', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    // ★ Lines that the reader treats as markup **outside** a fence: a table row, an h1, a list
    //   item. Inside a fence they are code, and one being "recognised" corrupts the sample.
    docId = await docWithCodeBlock(api, NASTY, '');
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    await expect
      .poll(() => shownCode(page), {
        message: 'a code sample that looks like markup must be shown exactly as stored',
        timeout: 20_000,
      })
      .toBe(NASTY);

    // ★ No table and no extra node may have been created out of the sample.
    expect(await types(api, docId), 'the sample must not have become a table').not.toContain('"t"');
    await expect
      .poll(async () => page.locator('.om-outline-wrap .node-row').count(), {
        message: 'the sample must not have become extra rows',
        timeout: 10_000,
      })
      .toBe(3);

    // ── A reload must show the same thing ──
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await expect
      .poll(() => shownCode(page), { message: 'the code block must come back after a reload', timeout: 20_000 })
      .toBe(NASTY);
    expect(await storedCode(api, docId), 'and the document must still hold it verbatim').toContain(
      '| a | b |',
    );
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ a code block is not moved into a list by indent, and shows in the mind map', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await docWithCodeBlock(api, SOURCE);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // ★ Indent must refuse it. A code block cannot live inside a `NodeList` (measured), and a
    //   demote that "succeeded" would either lose the block or corrupt the list around it.
    const row = page.locator('.om-outline-wrap .node-row').filter({ has: page.locator('.om-node-code') }).first();
    await row.click();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(800);
    expect(await storedCode(api, docId), 'indent must not remove the code block').toContain('const a = 1;');

    // ★ And the mind map must not have swallowed it either: it is a node, so it has a topic.
    await toMindmapView(page);
    await expect(page.locator('.mm-node').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.locator('.mm-node').count(), {
        message: 'the code block must be a topic in the map as well',
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(3);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★★ a code block source is editable in the outline, and the map previews it', async ({ page }) => {
  // The follow-up to D21: the block rendered read-only, so it could never be corrected in
  // place; and the mind map drew it as an empty (zero-width) topic, which reads as a
  // broken character. The criteria are the same shape as D21's: the kernel decides what
  // was written, and the panel must show it back verbatim after a reload.
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await docWithCodeBlock(api, SOURCE);
    expect(await storedCode(api, docId), 'precondition: the document holds a code block').toContain(
      'const a = 1;',
    );

    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // ── The source sits in an editable box, verbatim ──
    const box = page.locator('.om-outline-wrap textarea.om-node-code').first();
    await expect(box, 'the source must sit in an editable box').toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => shownCode(page), {
        message: 'the editable box must hold the source verbatim',
        timeout: 20_000,
      })
      .toBe(SOURCE);

    // ── Edit it: a multiline edit must keep its newline ──
    //   (A contenteditable box would join the lines with no newline at all, which is why
    //   the box is a textarea — the newline here is the criterion for that choice.)
    const EDITED = 'const b = 2;\nconsole.log(b);';
    await box.fill(EDITED);
    await expect
      .poll(() => storedCode(api, docId), {
        message: 'an edit of the source must reach the document verbatim',
        timeout: 30_000,
      })
      .toContain('const b = 2;');

    // ── A reload shows the edit, newline included ──
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await expect
      .poll(() => shownCode(page), { message: 'the edit must come back after a reload', timeout: 20_000 })
      .toBe(EDITED);

    // ── Multi-character typing keeps the caret in the box ──
    //   (The box used to be keyed on its own value, so the first keystroke remounted it,
    //   focus fell to BODY, the rest of the typing went nowhere — and a Backspace then
    //   deleted the whole selected row instead of a character.)
    const box2 = page.locator('.om-outline-wrap textarea.om-node-code').first();
    await box2.click();
    await page.keyboard.type('XYZ');
    await expect
      .poll(() => shownCode(page), { message: 'typed characters must land in the box', timeout: 20_000 })
      .toBe(`${EDITED}XYZ`);
    const focusedClass = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.className ?? '',
    );
    expect(String(focusedClass), 'the caret must stay in the code box while typing').toContain(
      'om-node-code',
    );

    // ── And the mind map previews the source instead of a placeholder ──
    await toMindmapView(page);
    await expect(page.locator('.mm-node').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.locator('.mm-node', { hasText: 'const b = 2;' }).count(), {
        message: 'the mind map topic must preview the source, not a placeholder',
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(1);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
