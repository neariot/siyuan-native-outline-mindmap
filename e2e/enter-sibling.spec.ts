import { test, expect } from './fixtures';
import { openDoc, toOutlineView } from './mindmap';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook, type KernelApi } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

/**
 * `Enter` does exactly one thing **at any level**: create a new sibling node at the same level.
 *
 * ## The bug this case targets (user-reported)
 *
 * Press Enter at the end of an existing node to create a new node, then press Enter repeatedly: the first press is right,
 * from the second press on that empty node **moves up one level**.
 *
 * The root cause is an "empty node special case" in `Outliner.tsx`'s `splitNode`: when the node is empty and
 * has no children, **having a parent** means outdent (move after the parent = move up one level).
 *  The fix only covered the **root level** ("keep creating siblings"); nodes with a parent were left alone,
 * so the same operation behaved differently at different levels.
 *
 * ## Why assert the level instead of the text
 *
 * This is a pure **level** change: the row count goes 3 to 3, not one character changes,
 * only the indentation and the block tree inside SiYuan differ. ★ A flat text list assertion **cannot see it**
 * (AGENTS.md records a blind spot of the same kind: a green case for "dragging to the middle of a row changes nothing"
 * hid normal behaviour). So this asserts two things at once:
 *   · the UI horizontal position (indentation)
 *   · the real block tree inside SiYuan (there should be only 1 root-level item)
 *
 * ## Reverse protection
 *
 * After removing Enter's outdent, users must not lose the ability to "decrease indentation" ——
 * that route is carried by `Shift+Tab` (see docs/SHORTCUTS.md), so the third case guards it.
 * Without it, nothing would stop someone from "casually" giving the outdent back to Enter later.
 */

let api: KernelApi;
let notebook = '';
let docId = '';

test.beforeAll(async () => {
  api = await kernelApi(siyuanUrl(), siyuanToken());
  notebook = await resolveTestNotebook(api);
});

test.afterAll(async () => {
  await api.dispose();
});

test.afterEach(async () => {
  if (docId) await removeDoc(api, docId);
  docId = '';
});

/** Each row's text + horizontal position. A larger x means a deeper level. */
async function rows(page: any): Promise<Array<{ txt: string; x: number }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.om-outline-wrap .node-row')).map((el) => {
      const e = el as HTMLElement;
      const t = (e.querySelector('.node-text') as HTMLElement)?.getBoundingClientRect();
      return {
        txt: ((e.querySelector('.node-text') as HTMLElement)?.textContent || '').trim(),
        x: t ? Math.round(t.x) : -1,
      };
    }),
  );
}

/** Put the caret at the end of row idx. */
async function caretToEnd(page: any, idx: number): Promise<void> {
  await page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').nth(idx).locator('.node-text').first().click();
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
}

test('pressing Enter repeatedly at the end of a level-2 node: every press creates a node at level 2, the level must not change', async ({ page }) => {
  docId = await createTempDoc(api, notebook, '- 甲\n  - 乙\n');
  await openDoc(page, docId);
  await toOutlineView(page);
  await page.waitForTimeout(800);

  const before = await rows(page);
  const rootX = before.find((r) => r.txt === '甲')?.x ?? -1;
  const childX = before.find((r) => r.txt === '乙')?.x ?? -1;
  // ★ Precondition guard: the two levels must really have been **measured** and must differ.
  //   Otherwise "both 0" or "neither measured" would make the assertions below vacuously true (AGENTS.md records this pitfall).
  expect(rootX, 'the horizontal position of the root-level node must be measured').toBeGreaterThan(0);
  expect(childX, 'a level-2 node must be indented deeper than the root, otherwise this case is meaningless').toBeGreaterThan(rootX);

  await caretToEnd(page, 1);

  // Press 4 times: the 1st creates a level-2 empty node, every later press must keep creating at the **same level**
  for (let i = 1; i <= 4; i++) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const r = await rows(page);
    expect(r.length, `Enter #${i} should add one row`).toBe(before.length + i);
    const last = r[r.length - 1];
    expect(last.txt, `the node created by Enter #${i} should be empty`).toBe('');
    expect(
      last.x,
      `after Enter #${i} the new node must still be at level 2 (x=${childX}), actual ${last.x} (${last.x === rootX ? 'it moved up to the root level' : 'wrong level'})`,
    ).toBe(childX);
  }

  // Cross-check the **real block tree** inside SiYuan —— correct UI indentation does not mean it was persisted correctly
  const kd = await api.call('/api/block/getBlockKramdown', { id: docId });
  const lines = ((kd.data?.kramdown as string) || '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('{:'));
  const rootItems = lines.filter((l) => !l.startsWith(' '));
  expect(rootItems.length, `the root level should hold only "甲"; actual block tree:\n${lines.join('\n')}`).toBe(1);
});

test('pressing Enter repeatedly at the end of a root-level node: also creates siblings only (guards the root-level fix)', async ({ page }) => {
  docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
  await openDoc(page, docId);
  await toOutlineView(page);
  await page.waitForTimeout(800);

  const before = await rows(page);
  const rootX = before[0]?.x ?? -1;
  expect(rootX, 'the horizontal position of the root-level node must be measured').toBeGreaterThan(0);

  await caretToEnd(page, 0);
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const r = await rows(page);
    expect(r.length, `Enter #${i} should add one row`).toBe(before.length + i);
    expect(r[r.length - 1].x, `after Enter #${i} the new node must still be at the root level`).toBe(rootX);
  }
});

test('reverse protection: Shift+Tab can still move a node up one level (the outdent ability is not lost)', async ({ page }) => {
  docId = await createTempDoc(api, notebook, '- 甲\n  - 乙\n');
  await openDoc(page, docId);
  await toOutlineView(page);
  await page.waitForTimeout(800);

  const before = await rows(page);
  const rootX = before.find((r) => r.txt === '甲')?.x ?? -1;
  const childX = before.find((r) => r.txt === '乙')?.x ?? -1;
  expect(rootX, 'the horizontal position of the root-level node must be measured').toBeGreaterThan(0);
  expect(childX, 'a level-2 node must be indented deeper than the root').toBeGreaterThan(rootX);

  await caretToEnd(page, 1);
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(800);

  const after = await rows(page);
  const yi = after.find((r) => r.txt === '乙');
  expect(yi, '"乙" should still exist after Shift+Tab').toBeTruthy();
  expect(yi!.x, `after Shift+Tab "乙" should move up to the root level (x=${rootX}), actual ${yi!.x}`).toBe(rootX);
});
