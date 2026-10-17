/**
 * ★★★ The top toolbar's outdent / indent buttons must really change the node's level.
 *
 * ## What it covers
 *
 * Outdent and indent existed only in the **mobile** bar (`.mobile-bar-fixed`), so the top toolbar
 * — the one on desktop and in a tablet-width dock — had no entry point for them at all: changing a
 * node's level needed the Tab / Shift+Tab shortcut, which a touch keyboard does not have.
 *
 * Two buttons are therefore not enough on their own: what matters is that they perform the **same**
 * operation as the mobile pair, on the node the caret is in, and that the **document** follows (a
 * level change that only moves rows on screen is how this fails quietly).
 *
 * The criteria are the three a user can check:
 *
 *   1. both buttons exist in the top toolbar (the mobile pair is not what satisfies this — the
 *      locator is scoped to `.om-toolbar`),
 *   2. indent moves the row **deeper** and outdent brings it back, and
 *   3. the kernel's own markdown shows the nesting, so the change is not screen-only.
 */
import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

const OUTDENT = '.om-toolbar button[title="向左提升 (Shift+Tab)"]';
const INDENT = '.om-toolbar button[title="向右缩进 (Tab)"]';
const ROW_TEXT = '.om-outline-wrap .node-row:not(.node-row-empty) .node-text';

/** `- 甲` / `  - 乙` / `- 丙`: 乙 is already a child, so it can be outdented and indented again. */
const NESTED_MD = '- 甲\n  - 乙\n- 丙\n';

async function rowXs(page: Parameters<typeof toOutlineView>[0]): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.om-outline-wrap .node-row:not(.node-row-empty) .node-text')].map(
      (e) => Math.round((e as HTMLElement).getBoundingClientRect().x),
    ),
  );
}

async function docMd(api: Awaited<ReturnType<typeof kernelApi>>, docId: string): Promise<string> {
  const res = await api.call('/api/export/exportMdContent', { id: docId });
  return String((res.data as { content?: string })?.content ?? '');
}

test('★★★ the top toolbar outdent / indent buttons change the node level, in the document too', async ({
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

    // ★ The toolbar starts **collapsed** when its container is narrow, and the dock the suite drives
    //   is (the real criterion is the container width, not the window's — `.om-toolbar-toggle` is
    //   shown by `@container (max-width: 560px)`). That policy is not what this case is about, so the
    //   bar is opened first; what matters is that the buttons exist **inside the toolbar**.
    const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await expect(page.locator('.om-toolbar'), 'the toolbar must expand').toBeVisible({
        timeout: 10_000,
      });
    }

    // ★ Scoped to the top toolbar: the mobile bar has carried these buttons all along, so a
    //   locator that finds them anywhere would pass against the old build.
    await expect(page.locator(OUTDENT), 'the top toolbar must offer outdent').toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(INDENT), 'the top toolbar must offer indent').toBeVisible({
      timeout: 15_000,
    });

    // The caret in 乙 (row 1, a child of 甲). The toolbar resolves its target from the focused
    // element, so without the caret the button would act on whatever was focused before.
    await page.locator(ROW_TEXT).nth(1).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ae = document.activeElement as HTMLElement | null;
            return ae?.getAttribute('data-node-id') ?? '';
          }),
        { message: 'precondition: the caret must be in the row under test', timeout: 10_000 },
      )
      .not.toBe('');

    const before = await rowXs(page);
    const beforeMd = await docMd(api, docId);
    expect(beforeMd, 'precondition: the fixture nests 乙 under 甲').toMatch(/- 甲[\s\S]*\n\s+- 乙/);

    // ---- outdent: 乙 leaves 甲 and becomes a sibling ----
    await page.locator(OUTDENT).click();
    await expect
      .poll(() => rowXs(page).then((xs) => xs[1]), {
        message: 'outdent must bring 乙 back to 甲\'s level',
        timeout: 15_000,
      })
      .toBeLessThan(before[1]);
    // ★ Measured **after** the outdent, not from the start: the row returns to exactly the x it had
    //   before, so "deeper than where it started" can never hold and would have failed against a
    //   correct product (the model really did re-nest it —— `indentInTree` reported one node moved).
    const outdentedX = (await rowXs(page))[1];
    await expect
      .poll(() => docMd(api, docId), {
        message: 'the document must show 乙 as a top-level node',
        timeout: 15_000,
      })
      .toMatch(/- 甲\n- 乙/);

    // ---- indent: and back under 甲 ----
    await page.locator(ROW_TEXT).nth(1).click();
    await page.waitForTimeout(400);
    await page.locator(INDENT).click();
    await expect
      .poll(() => rowXs(page).then((xs) => xs[1]), {
        message: 'indent must put 乙 under 甲 again',
        timeout: 15_000,
      })
      .toBeGreaterThan(outdentedX);
    // ...and back at exactly the level it started from, which is the stronger statement.
    await expect
      .poll(() => rowXs(page).then((xs) => xs[1]), {
        message: 'the re-indented row must sit at its original level',
        timeout: 15_000,
      })
      .toBe(before[1]);
    await expect
      .poll(() => docMd(api, docId), {
        message: 'the document must show 乙 nested again',
        timeout: 15_000,
      })
      .toMatch(/- 甲[\s\S]*\n\s+- 乙/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

/**
 * ★★★ Outdent a node and immediately indent it back —— the document must follow both times.
 *
 * ## What it covers
 *
 * A level change that is **undone right away** is a different case from either step alone, because the
 * second write-back runs while the first one's effect is still missing from the read it makes.
 *
 * `moveNodes` reads the document's block tree from the DOM, and that snapshot describes the document
 * **as of the read**. Outdenting 乙 out of 甲 leaves 甲's child list empty; indenting it straight back
 * runs a pass whose snapshot may still name 乙 as 甲's first child. The pass had a shortcut for
 * "already the first child of the target container ⇒ nothing to do", read from that list, and took
 * it —— while the block was in the **root** list, so the move it needed was real. Measured: the panel
 * showed 乙 nested one level down, the document kept it at the top level, and the pass returned
 * `moved: 0` having reported nothing. Intermittent, because it depends on whether the snapshot was
 * fresh yet —— which is exactly why the criterion here waits for the **document**, not for the panel.
 *
 * So: the panel and the document must agree after the pair, and the document is the authority.
 */
/**
 * ★★★ Outdent a node and immediately indent it again: **both** changes must reach the document.
 *
 * ## Why this is a separate case
 *
 * A level change that is **undone right away** is not the same as either step alone, because the second
 * write-back runs while the first one's effect is still missing from the read it makes. The original
 * case above waits for the document between the two clicks; this one does not, which is what makes the
 * defect it covers **deterministic** (it was intermittent before: whether it fired depended on whether
 * the DOM snapshot happened to be fresh yet).
 *
 * ## The defect it was written for (fixed, and the fix is what makes this case worth keeping)
 *
 * 1. Outdent 乙 out of 甲. The kernel leaves 甲 with an **empty** child list, or removes it outright
 *    (both measured) —— either way there is no list item to position 乙 against.
 * 2. Indent 乙 straight back. 乙 becomes the **first** child, so there is no predecessor, and the only
 *    remaining move shape is `moveBlock(乙, parentID=<that list>, previousID='')`.
 * 3. **The kernel answers `code: 0` and moves nothing.** Anchoring on 甲's paragraph instead fails the
 *    same way (`code: 0`, no move), and `parentID` = 甲's listItem is rejected outright
 *    (`code: -1`, "`previousID` can not be the ID of a document").
 * 4. So the panel showed 乙 one level down, the document kept it at the top level, and `moveNodes`
 *    returned `moved: 0` having reported nothing —— a **silent** divergence, and an intermittent one.
 *
 * The repair: a child list is not automatically a usable **move target**, so `resolveWantList` is now
 * asked for one that can take this move. When the list it finds holds no item (read **live** through
 * `getBlockDOM`, because the SQL index lags and the DOM snapshot can predate the emptying move), the
 * empty list is deleted, a fresh one is created with a placeholder on 甲's paragraph, 乙 is moved
 * **after that placeholder**, and the placeholder is deleted at the end of the call. The empty list is
 * deleted rather than left beside the new one on purpose: two child lists under one item is defect
 * #53's duplicated structure, where a node whose block id is a `List` can never be position-corrected.
 *
 * One guard came with it: the shortcut that skips a move ("already the first child of the target
 * container ⇒ nothing to do") now also requires `parentOk`, so a **stale** sibling list cannot decide to
 * skip a move that is genuinely needed.
 */
test('★★★ outdent then immediately indent again reaches the document both times', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    const nb = await resolveTestNotebook(api);
    docId = await createTempDoc(api, nb, NESTED_MD);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    const toggle = page.locator('.om-outline-wrap button.om-toolbar-toggle').first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await expect(page.locator('.om-toolbar')).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.locator(ROW_TEXT).first()).toBeVisible({ timeout: 20_000 });

    await page.locator(ROW_TEXT).nth(1).click();
    const childX = (await rowXs(page))[1];
    expect(childX, 'precondition: 乙 starts nested under 甲').toBeGreaterThan((await rowXs(page))[0]);

    // ---- outdent, then indent straight back: **no poll in between** ----
    await page.locator(OUTDENT).click();
    await page.locator(ROW_TEXT).nth(1).click();
    await page.locator(INDENT).click();

    // ★ The document, not the panel: the row must end up where it started, **in SiYuan**.
    await expect
      .poll(() => rowXs(page).then((xs) => xs[1]), {
        message: 'the panel must show 乙 nested again',
        timeout: 20_000,
      })
      .toBe(childX);
    await expect
      .poll(() => docMd(api, docId), {
        message: '★ and the document must show it nested again —— a panel-only move is the failure',
        timeout: 30_000,
      })
      .toMatch(/- 甲[\s\S]*\n\s+- 乙/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
