import { expect, type Page } from '@playwright/test';

/**
 * E2E interaction helpers for the outline view —— shared by Desktop and Mobile.
 */

export interface OutlineState {
  rows: number;
  collapsed: number;
  crumbs: string[];
  hasBack: boolean;
  title: string;
  editing: number;
}

/**
 * Read the currently observable state of the outline.
 */
export async function outlineState(page: Page): Promise<OutlineState> {
  return page.evaluate(() => {
    const t = document.querySelector('.outliner-title .title') as HTMLInputElement | null;
    return {
      // exclude placeholder rows (e.g. the "Click or press Enter to start typing..." placeholder)
      rows: document.querySelectorAll('.node-row:not(.node-row-empty)').length,
      collapsed: document.querySelectorAll('.node-row.collapsed').length,
      crumbs: [...document.querySelectorAll('.crumb-btn, .crumb-cur')].map((e) => (e.textContent || '').trim()),
      hasBack: document.querySelectorAll('.crumb-back-btn').length > 0,
      title: t ? t.value || t.textContent || '' : '',
      editing: document.querySelectorAll('.node-text[contenteditable="true"]').length,
    };
  });
}

/**
 * Wait until the outline view is rendered and ready, with at least one **real** node row.
 *
 * ★ The criterion excludes `.node-row-empty`: the placeholder row reuses the `.node-row` class, so
 *   counting it made this precondition pass on a document whose outline rendered **no content** ——
 *   the vacuous pass the ledger records as more dangerous than a false failure (a caller then
 *   measured the placeholder row and called it a node). The message always claimed a real row.
 */
export async function ensureOutlineReady(page: Page): Promise<void> {
  await expect(page.locator('.om-outline-wrap').last()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').count(), {
      message: 'the outline should render at least one real node row (not the empty placeholder)',
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
}

/**
 * Read the plain text of every visible node in the outline.
 */
export async function getNodeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.om-outline-wrap .node-row:not(.node-row-empty) .node-text')).map(
      (el) => (el.textContent || '').trim(),
    );
  });
}

/**
 * Click the sidebar collapse arrow of the given node —— triggers collapse / expand.
 *
 * ★ The class is `.node-sidebar-arrow` (`outliner-node-sidebar node-sidebar-arrow` in the markup).
 *   This helper used to look for `.om-arrow`, a class that exists nowhere in `src/` any more --
 *   nothing called it, so nothing went red, and the stale selector just sat there.
 */
export async function clickArrow(page: Page, index: number): Promise<void> {
  const arrow = page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').nth(index).locator('.node-sidebar-arrow').first();
  await arrow.click({ force: true });
  await page.waitForTimeout(250);
}

/**
 * Index of the first node row whose bullet carries `has-child` —— i.e. a row that can be zoomed into.
 *
 * ★ Fails fast when the fixture has no parent node. Returning `-1` made a caller select the **last**
 *   row (`nth(-1)`), which for this fixture is a leaf: the case then zoomed an unrelated row and
 *   could still pass. The precondition is named here instead of being handed to the caller as a
 *   number it may not check.
 */
export async function firstParentBullet(page: Page): Promise<number> {
  const idx = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.om-outline-wrap .om-bullet')];
    return bs.findIndex((b) => (b.className || '').toString().includes('has-child'));
  });
  if (idx < 0) {
    throw new Error(
      'firstParentBullet: no bullet with children in the outline —— the fixture must hold a nested node before zooming',
    );
  }
  return idx;
}

/**
 * Read the text prefix of every node currently selected (.node-row.selected) in the outline.
 */
export async function selectedTexts(page: Page, maxLen: number = 4): Promise<string[]> {
  return page.evaluate((len) =>
    [...document.querySelectorAll('.om-outline-wrap .node-row')]
      .filter((r) => r.className.includes('selected'))
      .map((r) => (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, len)),
    maxLen,
  );
}

/**
 * Drag an outline row onto another row, aiming at a fraction of the **target row's height**.
 *
 * `fraction` selects the drop zone (the boundaries are 25% / 75%, pinned by `drop-zone.test.ts`):
 * below 0.25 → `above`, above 0.75 → `below`, in between → `child`.
 *
 * ★★★ Two measured traps, each of which produced a false "reordering is broken" while the product was
 *     fine —— so this helper encodes the correct gesture rather than leaving it to each caller:
 *
 *     1. The only `draggable` element is the **bullet** (`.om-bullet`), not the row. A gesture that
 *        presses on the row's text never starts a drag, so nothing happens and it looks like a defect.
 *        Hence the press lands on the bullet, offset a few pixels in from its left edge.
 *     2. The zone comes from `dropZoneFor(e.clientY, rect.top, rect.height)` against the **row's** rect,
 *        so the hover coordinates have to be computed from the row, not from the bullet.
 *
 * The gesture is a real press-move-release: Playwright's synthetic `DragEvent` dispatch does not drive
 * this path (the drop handler reads React state set by `dragstart`, so a hand-dispatched sequence leaves
 * `dragIds` empty and the drop is ignored).
 */
export async function dragRowOnto(
  page: Page,
  fromIndex: number,
  toIndex: number,
  fraction: number,
): Promise<void> {
  const rows = page.locator('.om-outline-wrap .node-row');
  const srcBox = await rows.nth(fromIndex).boundingBox();
  const dstBox = await rows.nth(toIndex).boundingBox();
  if (!srcBox || !dstBox) throw new Error('dragRowOnto: a row has no box (is the outline rendered?)');

  // On the bullet, which is the draggable element.
  await page.mouse.move(srcBox.x + 14, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  for (let i = 1; i <= 12; i += 1) {
    // Move in steps: the zone is decided by the last `clientY` the row saw.
    const targetY = dstBox.y + dstBox.height * fraction * Math.min(1, i / 8);
    await page.mouse.move(dstBox.x + dstBox.width / 2, targetY);
  }
  await page.mouse.up();
}

/**
 * Wait until the outline stops changing row count.
 *
 * ★ A precondition, not a delay.
 *
 *   Measured: a moment after the document is opened the outline can render **zero** rows while
 *   it re-reads the tree, even though `ensureOutlineReady` has already passed. A click landing
 *   in that window types into nothing, and the case then reports "the edit never reached the
 *   document" -- a claim about the write path that is really about the test's timing.
 *
 *   The criterion is stability (the same count twice in a row), so it waits for the condition
 *   and lets a slow machine take longer rather than making the case lie.
 */
export async function waitForStableOutline(
  page: Page,
  opts: { samples?: number; intervalMs?: number; timeout?: number } = {},
): Promise<void> {
  const samples = opts.samples ?? 2;
  const intervalMs = opts.intervalMs ?? 400;
  let previous = -1;
  let stable = 0;
  const deadline = Date.now() + (opts.timeout ?? 20_000);
  while (Date.now() < deadline) {
    const count = await page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').count();
    stable = count === previous ? stable + 1 : 0;
    previous = count;
    if (stable >= samples && count > 0) return;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(
    `the outline never settled (last row count ${previous}); an edit made now could be typed into nothing`,
  );
}
