import { test, expect, type Page } from './fixtures';
import { siyuanUrl, siyuanToken } from './env';
import {
  openDoc, toMindmapView, toOutlineView, mindmapState, clickBadgeOn, firstBadgeOwner,
  ensureBarOpen,
} from './mindmap';
import {
  kernelApi, ensureTestDoc, resolveTestNotebook, createTempDoc, removeDoc, TEMP_DOC_MD,
} from './testdoc';

/**
 * **State persistence** when switching views.
 *
 * ## Why a separate suite
 *
 * In `mount.ts` the view is a ternary expression:
 *
 *     view === 'outline' ? <Outliner .../> : <Mindmap .../>
 *
 * That means **switching views unmounts the other component**, destroying all of its internal `useState`.
 * Users, however, think they are merely "looking at another drawing style" and should not lose their settings.
 *
 * The existing "the outline and mindmap views can be switched back and forth" case only asserted that **the DOM appeared**
 * and knew nothing about state —— so a defect like "after clicking Outline and coming back, structure and theme are all back to default"
 * could stay completely unnoticed.
 *
 * ## What should persist and what should not
 *
 * Two kinds; do not lump them together:
 *
 *   · **Display preferences** (structure/links/style/shape) —— should be remembered across documents and reloads.
 *     They describe "how I want to look at it", independent of which document it is, so they are stored globally.
 *   · **Collapse state** —— stored **per document**. What is collapsed is "which branch of this document",
 *     and node IDs are unique to each document, so storing it globally would bleed between documents.
 *   · **Selected node** —— lifted in `mount.ts`, it already persists; this only pins it so it cannot regress.
 *   · **Zoom** —— deliberately **not** restored: fitting to the current panel when the mindmap opens
 *     is more useful than restoring the previous zoom (see `userAdjustedView` in Mindmap.tsx).
 */

let DOC = '';
let notebook = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  try {
    notebook = await resolveTestNotebook(api);
    DOC = await ensureTestDoc(api, notebook);
  } finally {
    await api.dispose();
  }
});

/**
 * Clear the preferences in localStorage —— every case starts from a **clean default**.
 *
 * ★ Without clearing, cases pollute each other: one case changes the structure to balanced and saves it,
 *   the next one opens with balanced, and the precondition assertion (default is right-side) blows up.
 *   Measured: without clearing, the first batch of cases went red — it looked like a broken product when it was our own dirty data.
 */
async function clearPrefs(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('om-mm-prefs') || k.startsWith('om-mm-collapsed')) {
        localStorage.removeItem(k);
      }
    }
  });
}

/** Read the currently selected text of the four dropdowns in the settings bar */
async function barPrefs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.mm-bar select')].map(
      (s) => (s as HTMLSelectElement).options[(s as HTMLSelectElement).selectedIndex]?.text ?? '',
    ),
  );
}

/** Switch to the outline, then back to the mindmap */
async function roundTrip(page: Page): Promise<void> {
  await toOutlineView(page);
  await page.waitForTimeout(600);
  await toMindmapView(page);
  await page.waitForTimeout(900);
}

test.beforeEach(async ({ page }) => {
  await openDoc(page, DOC);
  await clearPrefs(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await toMindmapView(page);
});

test('display preferences are still there after a view round trip', async ({ page }) => {
  // Precondition: confirm the current value really is the default, otherwise "persisted" may just mean "never changed"
  const before = await barPrefs(page);
  expect(before[0], `the default structure should be rightward, measured "${before[0]}"`).toBe('向右');

  await ensureBarOpen(page);
  await page.locator('.mm-bar select').first().selectOption({ index: 1 });
  await page.waitForTimeout(400);
  const changed = await barPrefs(page);
  expect(changed[0], 'after changing the structure it should no longer be rightward').not.toBe('向右');

  await roundTrip(page);

  const after = await barPrefs(page);
  // Compare the whole array: this locks all four dropdowns at once, so missing any one of them goes red
  expect(after, `preferences should persist across the round trip (after change ${changed.join('/')}, after round trip ${after.join('/')})`).toEqual(
    changed,
  );
});

test('changing the structure and then the theme keeps both', async ({ page }) => {
  await ensureBarOpen(page);
  await page.locator('.mm-bar select').first().selectOption({ index: 1 });
  await page.waitForTimeout(400);
  // Theme swatches: click the 4th (the first 3 are the default palette)
  await ensureBarOpen(page);
  await page.locator('.mm-bar .theme-swatches > *').nth(4).click();
  await page.waitForTimeout(400);

  const changed = await barPrefs(page);
  await roundTrip(page);
  const after = await barPrefs(page);

  expect(after, 'both the structure and the theme should persist').toEqual(changed);
  expect(after[2], 'the third dropdown is style, and it should persist as well').toBe(changed[2]);
});

test('collapse state is still there after a view round trip', async ({ page }) => {
  const st0 = await mindmapState(page);
  expect(st0.nodes, 'there should be a collapsible branch initially').toBeGreaterThan(1);

  // firstBadgeOwner returns an **index**, not a Locator;
  // use clickBadgeOn —— it already encapsulates the pitfall that the owner node must be hovered first
  const idx = await firstBadgeOwner(page);
  expect(idx, 'a node with a collapse button should be found').toBeGreaterThanOrEqual(0);
  await clickBadgeOn(page, idx);

  const collapsed = await mindmapState(page);
  expect(collapsed.nodes, `the node count should drop after collapsing (${st0.nodes} → ${collapsed.nodes})`).toBeLessThan(
    st0.nodes,
  );

  await roundTrip(page);

  const after = await mindmapState(page);
  // ★ The node count is **observable** evidence —— if the collapse did not persist it bounces back to the original value
  expect(after.nodes, `the collapse should still be there after the round trip (collapsed ${collapsed.nodes}, after round trip ${after.nodes})`).toBe(
    collapsed.nodes,
  );
});

test('display preferences are still there after a full page reload', async ({ page }) => {
  await ensureBarOpen(page);
  await page.locator('.mm-bar select').first().selectOption({ index: 1 });
  await page.waitForTimeout(500);
  const changed = await barPrefs(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await toMindmapView(page);

  const after = await barPrefs(page);
  expect(after, `preferences should still be there after the reload (after change ${changed.join('/')})`).toEqual(changed);
});

test('collapse state follows the document and does not leak into another one', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let otherId = '';
  try {
    // Use TEMP_DOC_MD: it has a collapsible hierarchy (otherwise "B has no collapse" would prove nothing)
    otherId = await createTempDoc(api, notebook, TEMP_DOC_MD);

    // ★ Use the **same page** (same browser context): localStorage is shared,
    //   so this really verifies "distinguished per document",
    //   rather than a fake pass from "a different context has an empty localStorage anyway".
    await openDoc(page, DOC);
    await toMindmapView(page);
    const idx = await firstBadgeOwner(page);
    expect(idx, 'a node with a collapse button should be found in A').toBeGreaterThanOrEqual(0);
    await clickBadgeOn(page, idx);

    const a = await mindmapState(page);
    expect(a.collapsed, 'A should have a collapsed branch').toBeGreaterThan(0);

    await openDoc(page, otherId);
    await toMindmapView(page);
    const b = await mindmapState(page);
    expect(
      b.collapsed,
      `B is another document and must not inherit the collapse of A (measured: B has ${b.collapsed})`,
    ).toBe(0);

    // Back to A: its own collapse should still be there (proof it is "stored per document", not "cleared on switching away")
    await openDoc(page, DOC);
    await toMindmapView(page);
    const a2 = await mindmapState(page);
    expect(a2.collapsed, 'the collapse of A should still be there when returning to A').toBe(a.collapsed);
  } finally {
    if (otherId) await removeDoc(api, otherId);
    await api.dispose();
  }
});
