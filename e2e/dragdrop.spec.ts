import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { siyuanUrl, siyuanToken } from './env';
import {
  kernelApi, createTempDoc, removeDoc, topLevelTexts,
  resolveTestNotebook, TEMP_DOC_MD, type KernelApi,
} from './testdoc';

/**
 * E2E for drag-and-drop reordering.
 *
 * ## Why this is tested
 *
 * Dragging is a **destructive** action: it really changes the block order inside SiYuan. Once an interaction like this breaks,
 * what the user gets is "the content is scrambled after dragging" —— far worse than a button that does nothing.
 * It also involves native HTML5 DnD, and reading the code alone can hardly convince you the event chain is wired up.
 *
 * ## Use `dragTo`, not `mouse.move`
 *
 * Native HTML5 drag and drop relies on the `dragstart` / `dragover` / `drop` event set,
 * which plain `mouse.down/move/up` **does not trigger**.
 * Playwright's `locator.dragTo()` dispatches the real event sequence (with a DataTransfer),
 * and is the only workable way to drive this.
 *
 * ## ★ The drop target has **three zones**, and dropping in the middle of a row makes it a child
 *
 * `dropZoneAt` decides from the pointer's position ratio within the row (see `drop-zone.ts`):
 *
 * | Ratio | Zone | Effect |
 * |---|---|---|
 * | < 0.25 | `above` | ordered **above** that row (same level) |
 * | 0.25 ~ 0.75 | `child` | becomes a **child** of that row (row order unchanged, only the level changes) |
 * | > 0.75 | `below` | ordered **below** that row (same level) |
 *
 * ★ The `child` zone **does take effect** —— it turns the source node into a child of the target, but **does not change the row order**,
 *   only the **indent level**. So if a flat text list (`rowTexts()` / `allTextContents()`)
 *   is used as the criterion, before and after are **identical**, the test still passes, and it looks like "the drag did nothing".
 *   The criterion has to be the level, not the text. The drop point must also be at the row's upper or lower edge, never dead center.
 *
 *   Measured control case (甲/节点一/乙/丙, dragging "丙" onto the exact middle of "甲"):
 *     before x: 甲=1161 节点一=1188 乙=1161 丙=1161
 *     after  x: 甲=1161 节点一=1188 乙=1188 丙=1161   ← 乙 moved one level deeper
 *     SiYuan's kramdown confirms that "乙" moved under "甲" as well.
 *
 *   **Lesson**: when asserting a change in a tree structure, a flat text list is **blind** ——
 *   the **indentation/level** has to be part of the comparison. This one nearly had a working feature recorded as broken.
 *
 *   So every test below that checks **same-level reordering** uses `targetPosition`
 *   to place the pointer **inside the upper edge** of the row (about 10%).
 *
 * ## One temp document per test
 *
 * Dragging changes block order, so a shared document would be scrambled (and once the `sort` column is scrambled,
 * the "order" assertions of other tests all go stale). So each test creates its own and deletes it when done.
 */

let api: KernelApi;
let notebook = '';
let docId = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  api = await kernelApi(baseURL, token);
  notebook = await resolveTestNotebook(api);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  docId = await createTempDoc(api, notebook, TEMP_DOC_MD);
  await openDoc(page, docId);
  await toOutlineView(page);
});

test.afterEach(async () => {
  if (docId) await removeDoc(api, docId);
  docId = '';
});

/**
 * Drag onto the **upper edge** of a row so the drop is judged `above` (ordered above, same level).
 *
 * The default drop point of `dragTo(targetRow)` (dead center) cannot be used —— it is judged `child`,
 * which amounts to "stuffing the node under the target row".
 */
async function dragAbove(
  page: Parameters<typeof openDoc>[0],
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  const target = page.locator('.node-row').nth(toIndex);
  const box = await target.boundingBox();
  if (!box) throw new Error(`could not get the position of row ${toIndex}`);
  await page
    .locator('.om-bullet')
    .nth(fromIndex)
    .dragTo(target, { targetPosition: { x: 12, y: Math.max(1, box.height * 0.1) } });
  await page.waitForTimeout(1200);
}

/** Row texts in the UI (in render order). */
async function rowTexts(page: Parameters<typeof openDoc>[0]): Promise<string[]> {
  return page.locator('.node-text').allTextContents();
}

/**
 * The UI's **top-level** row texts, in render order —— derived from indentation, not from the kernel.
 *
 * ★ Needed to compare the kernel against the UI without asking the kernel which rows to expect: the
 *   earlier form filtered the UI list by kernel membership, so a node that had disappeared from the
 *   kernel was simply dropped from the expected side and the two lists compared equal. Deriving the
 *   level from the row's x offset keeps the two sides independent.
 */
async function topLevelRowTexts(page: Parameters<typeof openDoc>[0]): Promise<string[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.om-outline-wrap .node-row')].map((r) => ({
      x: Math.round(r.getBoundingClientRect().left),
      text: (r.querySelector('.node-text')?.textContent || '').trim(),
    }));
    if (rows.length === 0) return [];
    const minX = Math.min(...rows.map((r) => r.x));
    return rows.filter((r) => r.x === minX).map((r) => r.text);
  });
}

/**
 * Read out "level + text" —— this is what a tree-structure change **must** be inspected with.
 *
 * ★ Why `rowTexts()` cannot be used: it returns flat text and **cannot see indentation**.
 *   A `child` drop changes only the level, not the row order, so a flat list is identical before and after,
 *   and a feature that clearly took effect gets asserted as "no change".
 */
async function treeShape(page: Parameters<typeof openDoc>[0]): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.om-outline-wrap .node-row')].map((r) => {
      const x = Math.round(r.getBoundingClientRect().left);
      const text = (r.querySelector('.node-text')?.textContent || '').trim();
      return `${x}|${text}`;
    }),
  );
}

/**
 * ★ Drag the first node onto the third position and the order really changes.
 *
 * What is asserted is a **change of order**, not "no error thrown": the most common drag failure is
 * "the events are not wired up, the screen flickers but the data does not move", which looking for exceptions alone will not catch.
 */
test('dragging a node really changes the order', async ({ page }) => {
  const before = await rowTexts(page);
  expect(before.length, 'precondition: the temp document should have several rows').toBeGreaterThan(3);

  const moved = before[1];
  await dragAbove(page, 1, 3);

  const after = await rowTexts(page);
  // Row count unchanged (dragging moves things, it does not add or remove)
  expect(after.length, 'dragging should not change the row count').toBe(before.length);
  // The order really changed
  expect(after.join('|'), 'the order should differ after dragging').not.toBe(before.join('|'));
  // The dragged one is still there (not dropped)
  expect(after, `"${moved}" should not disappear`).toContain(moved);
});

/**
 * ★ The result of the drag is written back to SiYuan (not only a UI change).
 *
 * The kernel is asked directly for the top-level paragraphs' `sort` order: it only counts if that matches what the UI shows.
 */
test('the order after dragging is written back to SiYuan', async ({ page }) => {
  const before = await rowTexts(page);
  const target = before[2];

  await dragAbove(page, 2, 0);

  const after = await rowTexts(page);
  expect(after[0], `"${target}" should have been dragged to the front`).toBe(target);

  // ★ The UI's top-level rows are derived from **indentation**, independently of the kernel.
  const uiTop = await topLevelRowTexts(page);

  // ★ The kernel write back is **asynchronous** (the plugin only starts the write and the kernel round trip after the drop),
  //   so reading immediately occasionally returns the old order —— the classic timing problem that passes alone and fails in a mixed run.
  //   So poll until the kernel catches up, then assert.
  //
  //   Reading uses kramdown: a `parent_id` query finds nothing, and `sort` is not the sibling order either
  //   (see the note on topLevelTexts in testdoc.ts for details).
  await expect
    .poll(async () => (await topLevelTexts(api, docId))[0], {
      message: `"${target}" should also be first in the kernel (the write back is asynchronous)`,
      timeout: 15_000,
      intervals: [300, 500, 1000, 2000],
    })
    .toBe(target);

  const dbTop = await topLevelTexts(api, docId);
  // ★ Compare the **full** lists, both directions. The earlier form filtered the UI list by kernel
  //   membership (`after.filter((t) => dbTop.includes(t))`), which is one-directional: a top-level
  //   node that vanished from the kernel was simply dropped from the expected side, so data loss
  //   compared equal. Same length **and** same order must both hold.
  expect(dbTop, 'the kernel must hold exactly the top-level rows the UI shows (no silent data loss)').toEqual(uiTop);
});

/**
 * Dropping a node onto itself should not scramble the content (boundary: no actual move).
 *
 * ★ The criterion is `treeShape()` (including indentation), **not** `rowTexts()`.
 *
 *   Dropping on itself lands in the `child` zone —— which amounts to "making itself a child of itself".
 *   If this action really slipped through, the consequence is a **level** change (it indents itself under itself),
 *   to which a flat text list is **completely insensitive**: the text is still that one row and the order has not changed.
 *
 *   In other words, writing this test with `rowTexts()` stays green even with the guard broken ——
 *   the same root cause as the earlier misjudgement of the `child` drop (see the correction note in the file header).
 */
test('dropping a node onto itself changes nothing', async ({ page }) => {
  const before = await treeShape(page);
  const beforeTexts = before.map((r) => r.split('|')[1]);

  await page.locator('.om-bullet').nth(1).dragTo(page.locator('.node-row').nth(1));
  await page.waitForTimeout(1200);

  // ★ Compare the **indentation** too: that is where "nesting itself inside itself" would show up
  const after = await treeShape(page);
  expect(after, 'neither the level nor the order should change').toEqual(before);

  // No duplicated rendering caused by "nesting itself inside itself"
  expect(
    after.filter((r) => r.split('|')[1] === beforeTexts[1]).length,
    `"${beforeTexts[1]}" should not be duplicated`,
  ).toBe(1);

  // The kernel should not have moved either. Compared against the kernel's own order, not a
  // hardcoded name list: the old filter (`['甲', '乙', '丙', '丁']`) named nodes this fixture
  // never holds (TEMP_DOC_MD has 甲/节点一/乙/节点八), so 丙/丁 silently matched nothing while
  // nested names passed through unfiltered.
  const kernelTop = await topLevelTexts(api, docId);
  expect(kernelTop, 'the top-level order in the kernel should not change either').toEqual(
    beforeTexts.filter((t) => kernelTop.includes(t)),
  );
});

  /**
   * ★★ An **ancestor** must not be dragged into **its own descendant** —— that would create a cycle in the tree.
   *
   * ## Why this gets a test of its own (rather than relying on the "drop onto itself" one)
   *
   * The code has two guards:
   *   ① `ids.filter((i) => i !== targetId)` —— blocks "drop onto itself"
   *   ② `if (desc.has(targetId)) return` —— blocks "drop into its own descendant"
   *
   * As measured: **"drop onto itself" only reaches ①**,
   * delete ② entirely and that test **stays green** —— it never touches ② at all.
   * And ② is the only guard that blocks "ancestor → descendant": once it is deleted,
   * dragging "甲" onto "节点一" turns the tree into `乙 / 甲 / 节点一`
   * (甲 jumps to the top level together with its child), and **a cycle really is created**.
   *
   * ⇒ Each guard needs **its own test**, otherwise deleting one makes no test complain.
   */
  test('an ancestor cannot be dragged into its own descendant', async ({ page }) => {
    const before = await treeShape(page);
    expect(before.length, 'the test document should have a parent-child structure').toBeGreaterThan(1);
    // Precondition: row 0 must **have child nodes**, otherwise "ancestor → descendant" cannot be constructed
    const indent0 = Number(before[0].split('|')[0]);
    expect(
      Number(before[1].split('|')[0]),
      'precondition: row 1 should be a child of row 0 (indented deeper)',
    ).toBeGreaterThan(indent0);

    // Drag row 0 (the ancestor) onto the exact middle of row 1 (its descendant) = child
    await page.locator('.om-bullet').nth(0).dragTo(page.locator('.node-row').nth(1));
    await page.waitForTimeout(1300);

    const after = await treeShape(page);
    expect(
      after,
      `dragging an ancestor into its own descendant should be ignored entirely (otherwise a cycle appears in the tree). Before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
    ).toEqual(before);

    // The kernel must not move either —— a UI that stays put while the data changes is just as bad
    const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
    const body = String((kd.data as { kramdown?: string })?.kramdown ?? '');
    expect(body, 'the content in the kernel should not be lost').toContain('节点一');
  });

/**
 * ★★ A **controlled experiment** for the three-zone semantics: for the same "source → target" pair,
 *    a drop in the **middle** of the row → becomes a child; a drop on the **upper edge** → ordered first at the same level.
 *
 * ## Why the **level** must be inspected rather than the text order
 *
 * This test originally asserted that "a drop in the middle of the row **changes nothing**" —— **that was wrong**.
 * The `child` zone does take effect, it simply **does not change the row order** and only turns the source node into a child of the target.
 * But the criterion then was a flat text list (`allTextContents()`), which **cannot see indentation**,
 * so before and after were identical and a working feature was recorded as "no change".
 *
 * ⇒ Now `treeShape()` (level + text) is used, so the difference between the two drop points can be seen.
 */
test('a drop in the middle of a row makes a child, only the upper edge reorders siblings', async ({ page }) => {
  const before = await treeShape(page);
  const movedText = before[2].split('|')[1];

  // ① **Middle** of the row (the default drop point) → judged `child`: the level gets deeper, but the row order does not change
  await page.locator('.om-bullet').nth(2).dragTo(page.locator('.node-row').nth(0));
  await page.waitForTimeout(1300);

  const afterChild = await treeShape(page);
  // The **order** of rows really did not change (this is exactly the phenomenon that was misread as "no change")
  expect(
    afterChild.map((r) => r.split('|')[1]),
    'a drop in the middle of a row should not change the row order',
  ).toEqual(before.map((r) => r.split('|')[1]));

  // ★ But the **level** must have changed —— that is what a child drop really does
  const indentOf = (rows: string[], text: string): number =>
    Number(rows.find((r) => r.split('|')[1] === text)!.split('|')[0]);
  const targetText = before[0].split('|')[1];
  expect(
    indentOf(afterChild, movedText),
    `with a drop in the middle of the row, "${movedText}" should become a child (indented deeper than the target row "${targetText}")`,
  ).toBeGreaterThan(indentOf(before, targetText));

  // ② Start over with a **clean document** and drop on the **upper edge** this time → ordered first at the same level
  const fresh = await createTempDoc(api, notebook, TEMP_DOC_MD);
  try {
    await openDoc(page, fresh);
    await toOutlineView(page);
    const b2 = await treeShape(page);
    const moved2 = b2[2].split('|')[1];

    const box = await page.locator('.node-row').nth(0).boundingBox();
    await page
      .locator('.om-bullet')
      .nth(2)
      .dragTo(page.locator('.node-row').nth(0), {
        targetPosition: { x: 20, y: Math.max(1, box!.height * 0.1) },
      });
    await page.waitForTimeout(1300);

    const afterAbove = await treeShape(page);
    expect(afterAbove[0].split('|')[1], `with a drop on the upper edge, "${moved2}" should be ordered first`).toBe(moved2);
    expect(afterAbove.length, 'the row count is unchanged (only the order changed)').toBe(b2.length);
    expect(
      [...afterAbove].map((r) => r.split('|')[1]).sort(),
      'the set of nodes is unchanged',
    ).toEqual([...b2].map((r) => r.split('|')[1]).sort());
    // Same-level reorder: the indentation should not get deeper
    expect(
      Number(afterAbove[0].split('|')[0]),
      'a drop on the upper edge is a **same-level** reorder, so the indentation should not get deeper',
    ).toBe(Number(b2[0].split('|')[0]));
  } finally {
    await removeDoc(api, fresh);
  }
});

/**
 * ★ The drop zones' **boundaries**, driven through a real browser at the resolution a pointer has.
 *
 * The unit cases in `src/plugin/outline/drop-zone.test.ts` pin the arithmetic (exactly 0.25 → `child`,
 * 24.9 → `above`, 75.1 → `below`). What they cannot see is the other half of the claim: that the ratio the
 * *page* produces is the one the decision receives. **Measured, and it is not exact** —— `DragEvent.clientY`
 * is an **integer**, while a row's `getBoundingClientRect().height` is fractional (33.59375 in this
 * fixture), so a pointer at "exactly 25% of the row" cannot be expressed: the two integer pixels around that
 * point give 0.2381 and 0.2679. A case asserting `ratio === 0.25` through a real drag is therefore
 * asserting something unreachable, and it failed for that reason before this comment was written.
 *
 * So the claim tested here is the one a user can exercise: **the boundary lands within one pixel of where
 * the constant says**. The pixel below the 25% line must reorder (`above`), the pixel at or above it must
 * nest (`child`), and the same at 75% the other way. That is also the property the unit cases cannot cover
 * —— a padding or border between the row the DOM measures and the row the plugin reads would move the real
 * edge while the arithmetic stayed green.
 *
 * Judged by the **level** (from `treeShape()`), which is what a `child` drop changes; a flat text list
 * cannot see it, which is how the `child` zone was once misread as "no change".
 */
test('★ the drop boundary lands within one pixel of the 25% and 75% lines', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());

  /** A fresh document; drop row 2 onto row 0 at `offsetPx` below row 0's top; return the shape. */
  const dropAtOffset = async (offsetPx: number): Promise<string[]> => {
    const fresh = await createTempDoc(api, notebook, TEMP_DOC_MD);
    try {
      await openDoc(page, fresh);
      await toOutlineView(page);
      await page
        .locator('.om-bullet')
        .nth(2)
        .dragTo(page.locator('.node-row').nth(0), {
          targetPosition: { x: 12, y: offsetPx },
        });
      await page.waitForTimeout(1300);
      return treeShape(page);
    } finally {
      await removeDoc(api, fresh);
    }
  };

  // Measure the row the plugin itself reads, so the pixel offsets are derived rather than guessed.
  const rect = await page.evaluate(() => {
    const r = document.querySelectorAll('.node-row')[0]!.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  // ★ The integer pixels bracketing each line: `floor` is below the line, `floor + 1` is at or above it.
  const line25 = rect.height * 0.25;
  const line75 = rect.height * 0.75;
  const below25 = Math.floor(line25);
  const at25 = below25 + 1;
  const below75 = Math.floor(line75);
  const at75 = below75 + 1;
  // The ratio the decision will actually compute for those pixels (integer clientY, fractional height).
  const ratioOf = (offset: number): number => offset / rect.height;
  console.log(
    `PROBE row height ${rect.height}; 25% = ${line25.toFixed(3)} → pixels ${below25} (ratio ${ratioOf(below25).toFixed(4)}) / ` +
      `${at25} (ratio ${ratioOf(at25).toFixed(4)}); 75% = ${line75.toFixed(3)} → pixels ${below75} / ${at75}`,
  );

  const indentOf = (rows: string[], text: string): number =>
    Number(rows.find((r) => r.split('|')[1] === text)!.split('|')[0]);

  // ── 25% line: below it → `above` (same level, ordered first); at/above it → `child` (deeper) ──
  const b = await dropAtOffset(below25);
  const source = b.map((r) => r.split('|')[1]).sort();
  const baseline = await (async () => {
    const fresh = await createTempDoc(api, notebook, TEMP_DOC_MD);
    try {
      await openDoc(page, fresh);
      await toOutlineView(page);
      return treeShape(page);
    } finally {
      await removeDoc(api, fresh);
    }
  })();
  const sourceText = baseline[2].split('|')[1];
  const targetIndent = indentOf(baseline, baseline[0].split('|')[1]);

  expect(
    indentOf(b, sourceText),
    `★ one pixel below the 25% line (${below25}px, ratio ${ratioOf(below25).toFixed(4)}) must be the ` +
      'same-level `above` zone, not a child',
  ).toBe(targetIndent);
  expect(b[0].split('|')[1], 'an `above` drop puts the source first').toBe(sourceText);
  expect(source, 'no node is lost').toEqual(baseline.map((r) => r.split('|')[1]).sort());

  const c = await dropAtOffset(at25);
  expect(
    indentOf(c, sourceText),
    `★ the first pixel at or above the 25% line (${at25}px, ratio ${ratioOf(at25).toFixed(4)}) must be ` +
      'the `child` zone —— the interval is closed at the low end',
  ).toBeGreaterThan(targetIndent);

  // ── 75% line: below it → `child`; above it → `below` (same level) ──
  const d = await dropAtOffset(below75);
  expect(
    indentOf(d, sourceText),
    `★ one pixel below the 75% line (${below75}px, ratio ${ratioOf(below75).toFixed(4)}) is still the ` +
      '`child` zone —— the interval is closed at the high end',
  ).toBeGreaterThan(targetIndent);

  const e = await dropAtOffset(at75);
  expect(
    indentOf(e, sourceText),
    `★ the first pixel above the 75% line (${at75}px, ratio ${ratioOf(at75).toFixed(4)}) must be the ` +
      'same-level `below` zone, not a child',
  ).toBe(targetIndent);

  await api.dispose();
});

/** Dragging too far onto empty canvas space should not lose nodes. */
test('dropping on empty space does not lose nodes', async ({ page }) => {
  const before = await rowTexts(page);
  const wrap = await page.locator('.om-outline-wrap').boundingBox();
  expect(wrap).not.toBeNull();

  await page.locator('.om-bullet').nth(2).dragTo(page.locator('.om-outline-wrap'), {
    targetPosition: { x: wrap!.width - 20, y: wrap!.height - 20 },
  });
  await page.waitForTimeout(1000);

  const after = await rowTexts(page);
  expect(
    [...after].sort(),
    'wherever it lands, the set of nodes should not change (neither lost nor added)',
  ).toEqual([...before].sort());
});
