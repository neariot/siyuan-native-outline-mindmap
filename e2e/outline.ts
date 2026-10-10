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
