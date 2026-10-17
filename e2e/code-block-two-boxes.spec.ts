/**
 * ★★★ Two code blocks in one document: typing into the second one must not disturb the first.
 *
 * ## What it covers
 *
 * The reported failure needs **two** code boxes on screen, which is what the user's own document
 * held after an earlier attempt: the first conversion left an empty code block behind, and the
 * second conversion added another one. Typing into the second box then made the characters
 * disappear at once, and the kernel kept an empty fence.
 *
 * The box commits its value back when React detaches it, and the first version of that commit
 * reached for **one shared** element reference rather than the element of the box being detached
 * (measured, this file's first run): with a single code box the two are the same element and the
 * defect cannot appear at all —— which is why every earlier case passed. With two, the detach of
 * the second box committed the **first** box's empty value into the second box's node, so the model
 * said "empty", the next render wrote that empty string over the textarea, and the typed
 * characters were erased by the very rule meant to preserve them.
 *
 * So the criteria are the two the user can see:
 *
 *   1. what the box being typed into shows never loses a character, and
 *   2. the document holds the typed source.
 *
 * The first box must still hold its own text as well (criterion 3) —— the commit must not move one
 * box's source into the other.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const NODE_TEXT = '.om-outline-wrap .node-text';
const CODE_BOX = '.om-outline-wrap textarea.om-node-code';
const CONVERT = '.om-outline-wrap button[title="把当前节点变成代码块"]';

async function openToolbar(page: Parameters<typeof toOutlineView>[0]): Promise<void> {
  const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(300);
  }
}

test('★★★ with two code blocks, typing into the second keeps both and the document', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    // Two empty rows: each is converted, which leaves two code boxes on screen.
    docId = await createTempDoc(api, nb, '- alpha\n- \n- \n');
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await openToolbar(page);
    await page.locator(NODE_TEXT).first().waitFor({ state: 'visible', timeout: 20_000 });

    // Convert the two empty rows, one at a time, always taking the first empty row that is left.
    for (let i = 0; i < 2; i++) {
      const row = page.locator(NODE_TEXT);
      const count = await row.count();
      let target = row.nth(count - 1);
      for (let j = count - 1; j >= 0; j--) {
        if ((await row.nth(j).innerText()).trim() === '') {
          target = row.nth(j);
          break;
        }
      }
      await target.click();
      // ★ Wait for the caret, not for a stopwatch: the focus loop that follows a conversion holds
      //   the caret in the new code box for a while, and clicking a row in the meantime is undone
      //   by it (measured: the caret was still in the first box when the second conversion began).
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const ae = document.activeElement as HTMLElement | null;
              return ae ? `${ae.tagName}.${ae.className}` : '';
            }),
          { message: 'the caret must move into the row to convert', timeout: 15_000 },
        )
        .toContain('node-text');
      const btn = page.locator(CONVERT).first();
      await expect(btn, 'the convert button must be available').toBeVisible({ timeout: 10_000 });
      await btn.click();
      await expect(
        page.locator(CODE_BOX),
        `conversion ${i + 1} must add a code box`,
      ).toHaveCount(i + 1, { timeout: 15_000 });
    }

    // Type into the **second** box, at a human pace: the write-back runs between keystrokes, and
    // the case that used to fail only failed when a keystroke landed on its own.
    const second = page.locator(CODE_BOX).nth(1);
    await second.click();
    // ★★ Wait for the **caret**, not for a stopwatch. `click()` returns as soon as the event is
    //   dispatched; the panel then re-renders and the write-back may run, and a keystroke sent in
    //   that window goes to whatever held the focus before —— which reads as "the box ate my first
    //   character". Measured: this case failed exactly here (`Expected: "t"` / `Received: ""`) on a
    //   loaded machine while passing on an idle one.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ae = document.activeElement as HTMLElement | null;
            return ae?.className?.toString().includes('om-node-code') ?? false;
          }),
        { message: 'the caret must be in the second box before typing', timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (document.activeElement as HTMLElement | null)?.className?.toString() ?? '',
          ),
        { message: 'the caret must land in the second box', timeout: 15_000 },
      )
      .toContain('om-node-code');
    // ★ Human pace, and the source must come out in the order it was typed: the focus loop used to
    //   re-focus the box with a bare `focus()`, which parks the caret at offset 0, so every
    //   character landed in front of the one before it (`t`, `et`, `est`, `estt`).
    let expectAfter = '';
    for (const ch of 'test') {
      await page.keyboard.type(ch);
      await page.waitForTimeout(400);
      expectAfter += ch;
      await expect(second, `the box must keep "${expectAfter}" after typing "${ch}"`).toHaveValue(
        expectAfter,
        { timeout: 5_000 },
      );
    }

    // The other box is untouched: its source was never the second box's.
    await expect(page.locator(CODE_BOX).first()).toHaveValue('', { timeout: 5_000 });

    await expect
      .poll(
        async () => {
          const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
          return String((kd.data as { kramdown?: string })?.kramdown ?? '');
        },
        { message: 'the typed source must reach the document', timeout: 30_000 },
      )
      .toContain('test');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});