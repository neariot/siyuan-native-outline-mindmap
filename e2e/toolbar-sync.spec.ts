/**
 * ★★★ What an inline-markup toolbar button does to the **document**, not to the outline.
 *
 * ## Why the criterion is the kernel's answer
 *
 * Every defect this file covers produced the same symptom — the outline looked right and the
 * document was not — so an assertion on the outline's own HTML would have passed all of them.
 * The criterion is therefore:
 *
 *   1. the node's HTML right after the click (what `syncText` captured), **and**
 *   2. the kramdown the kernel holds after the write settled (what actually persisted), **and**
 *   3. the node's HTML after a reload (whether it came back).
 *
 * A button that changes only (1) has not done its job. See
 * [`docs/todo/inline-markup-sync.md`](../docs/todo/inline-markup-sync.md) for the measurement
 * behind each case.
 *
 * ## Why one document per case
 *
 * The blocks are real SiYuan blocks and the write-back is asynchronous, so a shared document
 * makes one case's pending write land in another's result. Each case owns its document and
 * deletes it in `finally`.
 */
import { test, expect, type Page } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
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

const NODE_TEXT = '.om-outline-wrap .node-row:not(.node-row-empty) .node-text';

/**
 * Open the markup toolbar.
 *
 * ★ It starts collapsed (measured: clicking a markup button with it collapsed waits for a
 *   target that is not there and times out). The assertion names the button that must be
 *   reachable, so a toolbar that stops rendering cannot pass vacuously.
 */
async function openToolbar(page: Page): Promise<void> {
  // The toggle is found by its **class**, not by its title: a title is a catalogue value, and a
  // partial match of one is not exempt from the fixture-vocabulary rule — and it would stop
  // matching the moment the catalogue is reworded.
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.count()) {
    const expanded = await toggle.getAttribute('aria-expanded');
    if (expanded === 'false') await toggle.click();
  }
  await expect(page.locator('.om-outline-wrap button[title="加粗"]').first()).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Select a node's whole text the way a user does: click into it, then Home / Shift+End.
 *
 * ★ The non-collapsed selection is a **precondition, not an expectation**.
 *
 *   `document.execCommand` on a collapsed range applies to nothing and returns normally, so a
 *   case that raced the selection reported "the document never received the mark" — a failure
 *   about the write path that was really about the test. Measured: the italic case passed and
 *   failed on the same build.
 */
async function selectNodeText(page: Page, index = 0): Promise<void> {
  await page.locator(NODE_TEXT).nth(index).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString() ?? ''), {
      message: 'the node text must really be selected before a markup button is pressed',
      timeout: 10_000,
    })
    .not.toBe('');
}

async function nodeHtml(page: Page, index = 0): Promise<string> {
  return page.evaluate(
    ({ sel, i }) => (document.querySelectorAll(sel)[i] as HTMLElement)?.innerHTML ?? '',
    { sel: NODE_TEXT, i: index },
  );
}

async function kramdown(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const r = await api.call('/api/block/getBlockKramdown', { id: docId });
  const kd = String((r.data as { kramdown?: string })?.kramdown ?? '');
  return kd.split('\n{: id=')[0].trim();
}

/**
 * Wait until the plugin has finished writing back.
 *
 * ★ Not a fixed sleep, and not the kernel's answer.
 *
 *   The kernel reports a write as soon as the transaction lands, which is **before** the plugin
 *   has finished its own transaction (the echo guard is still open, the undo baseline is not yet
 *   recorded). A second edit pressed in that window races the write-back, so a case that polls
 *   the kernel and immediately clicks the next button measures the race, not the feature.
 *   Measured: the same clear-format case passed and failed on the same build for this reason.
 *   The saving indicator is the thing that actually means "idle", so that is what is waited on.
 */
async function waitForIdle(page: Page): Promise<void> {
  await expect(page.locator('.om-mm-saving')).toHaveCount(0, { timeout: 20_000 });
}

/** Poll the document until `wanted` shows up, or report what it actually holds. */
async function expectKernelHolds(
  api: Awaited<ReturnType<typeof kernelApi>>,
  docId: string,
  wanted: string,
  message: string,
): Promise<string> {
  let seen = '';
  await expect
    .poll(
      async () => {
        seen = await kramdown(api, docId);
        return seen;
      },
      { message, timeout: 20_000 },
    )
    .toContain(wanted);
  return seen;
}

/** Reopen the document in a fresh page load and read the node back. */
async function reloadAndRead(page: Page, docId: string): Promise<string> {
  await page.reload();
  await openDoc(page, docId);
  await toOutlineView(page);
  await expect(page.locator(NODE_TEXT).first()).toBeVisible({ timeout: 30_000 });
  return nodeHtml(page);
}

async function withDoc(
  page: Page,
  markdown: string,
  body: (ctx: {
    api: Awaited<ReturnType<typeof kernelApi>>;
    docId: string;
  }) => Promise<void>,
): Promise<void> {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, markdown);
    await openDoc(page, docId);
    await toOutlineView(page);
    await expect(page.locator(NODE_TEXT).first()).toBeVisible({ timeout: 30_000 });
    await openToolbar(page);
    await body({ api, docId });
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
}

// ---------------------------------------------------------------- D1: the wrapper must wrap

test('★★ inline code wraps the selected text instead of replacing it', async ({ page }) => {
  await withDoc(page, '- 文字\n', async ({ api, docId }) => {
    await selectNodeText(page);
    await page.locator('.om-outline-wrap button[title="行内代码"]').first().click();

    // The text must still be there, inside the code span.
    await expect
      .poll(() => nodeHtml(page), { message: 'the selected text must survive the wrap', timeout: 10_000 })
      .toContain('文字');
    expect(await nodeHtml(page), 'the selected text must be inside the code element').toMatch(
      /<code[^>]*>[^<]*文字[^<]*<\/code>/,
    );

    await expectKernelHolds(api, docId, '文字', 'the kernel must still hold the node text');
  });
});

// ---------------------------------------------------------------- D5: marks, not CSS

const MARKS: Array<[string, string, string]> = [
  ['加粗', '**文字**', 'bold'],
  ['斜体', '*文字*', 'italic'],
  ['删除线', '~~文字~~', 'strikethrough'],
  ['下划线', '<u>文字</u>', 'underline'],
];

for (const [title, wanted, label] of MARKS) {
  test(`★★ ${label} is stored in the document as a SiYuan mark`, async ({ page }) => {
    await withDoc(page, '- 文字\n', async ({ api, docId }) => {
      await selectNodeText(page);
      await page.locator(`.om-outline-wrap button[title="${title}"]`).first().click();

      const held = await expectKernelHolds(
        api,
        docId,
        wanted,
        `the document must hold ${wanted} for ${label}; an inline style is not the same thing`,
      );
      expect(
        held,
        `${label} must not be stored as a CSS style: the outline runs with styleWithCSS, so an unmapped ` +
          'declaration would land as `data-type="text" style="font-weight: …"`',
      ).not.toContain('data-type="text"');

      // And it must still be there after a reload, i.e. the read path understands it too.
      const after = await reloadAndRead(page, docId);
      expect(after, `${label} must survive a reload`).toContain('文字');
      expect(after).not.toContain('文字</span>{:');
    });
  });
}

// ---------------------------------------------------------------- D3: removing a mark is an edit

test('★★ removing the strikethrough reaches the document', async ({ page }) => {
  await withDoc(page, '- 文字\n', async ({ api, docId }) => {
    await selectNodeText(page);
    await page.locator('.om-outline-wrap button[title="删除线"]').first().click();
    await expectKernelHolds(api, docId, '~~文字~~', 'precondition: the mark must be stored first');
    await waitForIdle(page);

    // Same button again: a toggle is a real edit, and a *removal* is the direction that used
    // to be invisible — the outline showed plain text while the document kept the mark.
    await selectNodeText(page);
    await page.locator('.om-outline-wrap button[title="删除线"]').first().click();

    await expect
      .poll(async () => kramdown(api, docId), {
        message: 'the strikethrough must be gone from the document, not only from the outline',
        timeout: 20_000,
      })
      .not.toContain('~~');

    const after = await reloadAndRead(page, docId);
    expect(after, 'the strikethrough must not come back after a reload').not.toContain('~~');
    expect(after).toContain('文字');
  });
});

// ---------------------------------------------------------------- D10: clear format reaches the document

test('★★ clear format removes formatting from the document, not only from the outline', async ({ page }) => {
  await withDoc(page, '- 文字\n', async ({ api, docId }) => {
    await selectNodeText(page);
    await page.locator('.om-outline-wrap button[title="加粗"]').first().click();
    await expectKernelHolds(api, docId, '**文字**', 'precondition: the bold must be stored first');
    await waitForIdle(page);

    await page.locator('.om-outline-wrap button[title="清除格式"]').first().click();
    // What the button did to the node is the first question: if the node is unchanged, the
    // button never acted on this node, and the document assertion below would only say so
    // indirectly. Recording it turns that into the failure message.
    const afterClick = await nodeHtml(page);

    await expect
      .poll(async () => kramdown(api, docId), {
        message:
          'the bold must be gone from the document; the outline showing plain text is not the criterion. ' +
          `Node HTML right after the click: ${afterClick}`,
        timeout: 20_000,
      })
      .not.toContain('**');

    const after = await reloadAndRead(page, docId);
    expect(after, 'the bold must not come back after a reload').not.toContain('font-weight');
  });
});

// ---------------------------------------------------------------- D2: a colour is not a tag

test('★★ a coloured word keeps its colour across a reload', async ({ page }) => {
  await withDoc(page, '- 文字\n', async ({ api, docId }) => {
    // Set the colour through the toolbar's colour input, the way a user does.
    await selectNodeText(page);
    const colour = page.locator('.om-outline-wrap input[type="color"]').first();
    await colour.evaluate((el) => {
      // ★ React listens for `input` and tracks the value through its own descriptor, so a plain
      //   `el.value = …` is swallowed as "unchanged" and the button silently does nothing — which
      //   looks exactly like the defect under test. Going through the prototype setter is what a
      //   real change does.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '#dc2a2a');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expectKernelHolds(
      api,
      docId,
      'color:',
      'precondition: the colour must be stored first (the browser normalises `#dc2a2a` to `rgb(…)`, ' +
        'so the property, not the notation, is what is asserted here)',
    );
    await waitForIdle(page);

    // The hex must not have been read back as a `#tag`.
    const after = await reloadAndRead(page, docId);
    expect(after, 'the style attribute must survive the read').toContain('color:');
    expect(after, 'a hex colour inside style= must not be rewritten as a tag').not.toMatch(/data-tag="[0-9a-f]{3,6}/);

    // And writing again must not corrupt the document either.
    await page.locator(NODE_TEXT).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('丁');
    await expectKernelHolds(api, docId, '丁', 'precondition: the edit must be stored');
    const held = await kramdown(api, docId);
    expect(held, 're-saving must not turn the colour into a tag').not.toMatch(/data-tag="[0-9a-f]{3,6}/);
  });
});