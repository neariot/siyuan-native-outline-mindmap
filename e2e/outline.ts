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
 * Wait until the outline view is rendered and ready (at least one node row or the empty placeholder).
 */
export async function ensureOutlineReady(page: Page): Promise<void> {
  await expect(page.locator('.om-outline-wrap').last()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.locator('.om-outline-wrap .node-row').count(), {
      message: 'the outline should render at least one node row',
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
 * Focus the node row at the given index.
 */
export async function focusNodeRow(page: Page, index: number): Promise<void> {
  const row = page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').nth(index);
  const textEl = row.locator('.node-text').first();
  await textEl.click();
  await page.waitForTimeout(100);
}

/**
 * Append-typing text into the node row at the given index.
 */
export async function typeInNode(page: Page, index: number, text: string): Promise<void> {
  await focusNodeRow(page, index);
  await page.keyboard.type(text);
  await page.waitForTimeout(150);
}

/**
 * Press a key inside the node row at the given index.
 */
export async function pressKeyInNode(
  page: Page,
  index: number,
  key: string,
  opts?: { shift?: boolean; ctrl?: boolean; alt?: boolean },
): Promise<void> {
  await focusNodeRow(page, index);
  const modifiers: string[] = [];
  if (opts?.ctrl) modifiers.push('Control');
  if (opts?.shift) modifiers.push('Shift');
  if (opts?.alt) modifiers.push('Alt');
  const chord = [...modifiers, key].join('+');
  await page.keyboard.press(chord);
  await page.waitForTimeout(200);
}

/**
 * Click the bullet of the given node —— triggers zoom (focus on the subtree).
 */
export async function clickBullet(page: Page, index: number): Promise<void> {
  const bullet = page.locator('.om-outline-wrap .node-row:not(.node-row-empty)').nth(index).locator('.om-bullet').first();
  await bullet.click();
  await page.waitForTimeout(250);
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
 * Find the index of the first bullet that owns children.
 */
export async function firstParentBullet(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('.om-outline-wrap .om-bullet')];
    return bs.findIndex((b) => (b.className || '').toString().includes('has-child'));
  });
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
