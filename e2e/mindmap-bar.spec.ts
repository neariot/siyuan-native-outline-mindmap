/**
 * ★★★ The mind map's buttons, tested by **what they do**.
 *
 * ## Why this file exists
 *
 * `e2e/mindmap.spec.ts` covers the bar's **layout**: that it wraps instead of scrolling, that the
 * collapse toggle works, that the container query fires. None of it clicks a control to see what
 * happens — measured, every one of `cmdFit`, `cmdExportImage`, `cmdExportMm`, `tipZoomIn`,
 * `tipZoomOut`, `tipResetZoom`, `tipToggleTheme`, `tipFitCanvas`, `cmdBackToFullMap`, `lblShape`
 * and the theme swatches had **zero** spec references. A button that is wired to nothing looks
 * exactly like a button that works, until someone presses it.
 *
 * ## The criterion is the effect, not the click
 *
 * Every case here asserts on something the click must have changed: the canvas transform, a node's
 * fill, a downloaded file, or the tree in SiYuan. "The button was clickable" is not evidence —— the
 * probe this file replaces found several controls that were reachable and did nothing visible.
 *
 * ## Measured before writing these
 *
 * * the bar starts **collapsed** (`mm-bar--collapsed`), so a case must open it first or every click
 *   lands on a hidden element and times out;
 * * the bar holds **8 theme swatches, 4 selects and 3 text buttons**, plus 3 zoom/reset controls
 *   with `aria-label`s (their `title`s are translated, so the aria-label is the stable handle);
 * * a second bar, `.mm-floating-dock`, holds the theme-cycle and fit buttons.
 */
import { test, expect, type Page } from './fixtures';
import { openDoc, toMindmapView, mindmapState, clickBadgeOn, firstBadgeOwner } from './mindmap';
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

/** Open the document in the mind map view with the bar expanded. */
async function openMap(page: Page, md: string, api: Awaited<ReturnType<typeof kernelApi>>): Promise<string> {
  const docId = await createTempDoc(api, notebook, md);
  await openDoc(page, docId);
  await toMindmapView(page);
  await expect(page.locator('.mm-node').first()).toBeVisible({ timeout: 30_000 });
  // ★ The bar starts collapsed, so nothing in it is clickable until it is opened (measured).
  const toggle = page.locator('.om-mm-root .mm-bar-toggle').first();
  if ((await toggle.count()) && (await page.locator('.om-mm-root .mm-bar--collapsed').count())) {
    await toggle.click();
    await expect(page.locator('.om-mm-root .mm-bar--collapsed')).toHaveCount(0, { timeout: 10_000 });
  }
  return docId;
}

/** The canvas transform: the thing zoom and fit must move. */
function transform(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('.mm-canvas svg g[transform]')?.getAttribute('transform') ?? 'none',
  );
}

/** The scale component of the transform, as a number. */
async function scale(page: Page): Promise<number> {
  const t = await transform(page);
  const m = /scale\(([-\d.]+)\)/.exec(t);
  return m ? Number(m[1]) : NaN;
}

/** The fill of the root node's shape — what a theme change must move. */
function rootFill(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el =
      document.querySelector('.mm-node[data-depth="0"] rect') ??
      document.querySelector('.mm-node rect');
    return el?.getAttribute('fill') ?? el?.getAttribute('style') ?? 'none';
  });
}

test('★★ zoom in, zoom out and reset move the canvas scale', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n  - 甲二\n- 乙\n', api);

    const base = await scale(page);
    expect(base, 'precondition: the canvas has a readable scale').toBeGreaterThan(0);

    await page.locator('.om-mm-root .mm-bar button[aria-label="放大"]').first().click();
    await expect.poll(() => scale(page), { message: 'zoom in must increase the scale', timeout: 10_000 })
      .toBeGreaterThan(base);

    const zoomedIn = await scale(page);
    await page.locator('.om-mm-root .mm-bar button[aria-label="缩小"]').first().click();
    await expect.poll(() => scale(page), { message: 'zoom out must decrease the scale', timeout: 10_000 })
      .toBeLessThan(zoomedIn);

    // ★ Reset goes back to **100%**, which is a specific number and not merely "smaller" —— a
    //   control that stepped the scale like the other two would satisfy "changed" and be wrong.
    await page.locator('.om-mm-root .mm-bar button[aria-label="点击重置为 100%"]').first().click();
    await expect
      .poll(() => scale(page), { message: 'reset must restore 100%', timeout: 10_000 })
      .toBeCloseTo(1, 2);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ "fit" rescales the map so every node fits the canvas', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n  - 甲二\n  - 甲三\n- 乙\n  - 乙一\n', api);

    // ★ Deliberately move the view **away** from a fitted one first, so "fit" has something to do:
    //   asserting on a fit that was already in place would pass even if the button were dead.
    await page.locator('.om-mm-root .mm-bar button[aria-label="点击重置为 100%"]').first().click();
    await expect.poll(() => scale(page), { timeout: 10_000 }).toBeCloseTo(1, 2);
    const atFull = await scale(page);

    await page.locator('.om-mm-root .mm-bar button', { hasText: '适应' }).first().click();
    await expect
      .poll(async () => Math.abs((await scale(page)) - atFull) > 0.01, {
        message: 'fit must change the scale when the map does not already fit',
        timeout: 10_000,
      })
      .toBe(true);

    // ★ And the result must really fit: the map's own bounds must be inside the canvas.
    const fits = await page.evaluate(() => {
      const svg = document.querySelector('.mm-canvas svg') as SVGSVGElement | null;
      const g = svg?.querySelector('g[transform]') as SVGGElement | null;
      if (!svg || !g) return null;
      const c = svg.getBoundingClientRect();
      const b = g.getBoundingClientRect();
      return b.left >= c.left - 2 && b.right <= c.right + 2 && b.top >= c.top - 2 && b.bottom <= c.bottom + 2;
    });
    expect(fits, 'after fit the whole map must be inside the canvas').toBe(true);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ a theme swatch changes the node colours', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n- 乙\n', api);

    const swatches = page.locator('.om-mm-root .mm-bar .theme-swatches button');
    const count = await swatches.count();
    // ★ The count is asserted, not assumed: the probe measured 8, and a swatch list that silently
    //   lost its buttons would otherwise make this case vacuous.
    expect(count, 'the bar must offer the theme swatches').toBeGreaterThan(1);

    const before = await rootFill(page);
    await swatches.nth(1).click();
    await expect
      .poll(() => rootFill(page), { message: 'a theme swatch must change the node colour', timeout: 10_000 })
      .not.toBe(before);

    // ★ And the active swatch must follow, or the bar lies about which theme is on.
    await expect(swatches.nth(1)).toHaveClass(/on/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ the floating dock cycles the theme', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n- 乙\n', api);

    const before = await rootFill(page);
    await page.locator('.mm-floating-dock button').first().click();
    await expect
      .poll(() => rootFill(page), { message: 'the dock theme button must cycle the palette', timeout: 10_000 })
      .not.toBe(before);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ the shape selector changes the layout', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n  - 甲二\n- 乙\n', api);

    const shape = page.locator('.om-mm-root .mm-bar select').first();
    const options = await shape.locator('option').allTextContents();
    expect(options.length, 'the shape selector must offer more than one layout').toBeGreaterThan(1);

    // ★ The criterion is geometry: a different layout must place the nodes differently. Comparing
    //   the control's own value would only prove the `<select>` changed, not that anything used it.
    const positions = (): Promise<string> =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.mm-node'))
          .map((n) => {
            const r = n.getBoundingClientRect();
            return `${Math.round(r.left)},${Math.round(r.top)}`;
          })
          .join('|'),
      );
    const before = await positions();
    await shape.selectOption({ index: 1 });
    await expect
      .poll(positions, { message: 'a different shape must lay the nodes out differently', timeout: 10_000 })
      .not.toBe(before);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ the two export buttons really produce files', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n- 乙\n', api);

    await page.locator('.om-mm-root .mm-bar button', { hasText: '导出图片' }).first().click();
    await expect
      .poll(() => downloads.length, { message: 'the PNG export must download a file', timeout: 20_000 })
      .toBeGreaterThan(0);
    // ★ The extension is the point: an export that produced a file with the wrong type, or an empty
    //   one, would satisfy "a download happened".
    expect(downloads[0], 'the image export must be a PNG').toMatch(/\.png$/i);

    await page.locator('.om-mm-root .mm-bar button', { hasText: '导出 .mm' }).first().click();
    await expect
      .poll(() => downloads.length, { message: 'the .mm export must download a file', timeout: 20_000 })
      .toBe(2);
    expect(downloads[1], 'the second export must be a .mm file').toMatch(/\.mm$/i);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★ collapsing a node in the map hides the branch and survives a reopen', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await openMap(page, '- 甲\n  - 甲一\n  - 甲二\n- 乙\n', api);

    const before = await mindmapState(page);
    expect(before.nodes, 'precondition: the map shows every node').toBeGreaterThan(2);

    // ★ `clickBadgeOn`, not `click('.mm-badge')`. The badge is **covered** by the node's own rect,
    //   so Playwright judges the click intercepted and retries until it times out (2.1 minutes as
    //   measured, and this file reproduced it at 2.0 before switching) —— the badge is only revealed
    //   by hovering the owning node first, which is exactly what the helper does. It already existed
    //   for `e2e/export.spec.ts`; duplicating the knowledge here is how the same trap gets
    //   rediscovered.
    const owner = await firstBadgeOwner(page);
    expect(owner, 'precondition: a node must offer a collapse badge').toBeGreaterThanOrEqual(0);
    const before2 = await page.locator('.mm-node').count();
    await clickBadgeOn(page, owner);
    // The fold must be visible on the canvas before the document is read, or a "not yet" reads as
    // "never".
    await expect
      .poll(() => page.locator('.mm-node').count(), {
        message: 'collapsing must hide the branch on the canvas',
        timeout: 10_000,
      })
      .toBeLessThan(before2);

    // ★★★ The criterion is **not** the document, and that is the point of this case.
    //
    //   A first version of this asserted `fold="1"` in the block's kramdown and failed. The code says
    //   why, in `model/types.ts`: `collapsed` is *"view state, deliberately not saved"* —— folding is a
    //   way of looking at a document, not something the document says. The map keeps folded branches in
    //   `localStorage` under `om-mm-collapsed:<doc>`.
    //
    //   So the honest criterion is that the fold is **remembered across a reopen**, which is the
    //   promise the code actually makes. Asserting on the document would have demanded a behaviour the
    //   design rejects, and "fixing" it would have written view state into the user's document.
    await expect
      .poll(
        () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('om-mm-collapsed:')).length),
        { message: 'the fold must be remembered for this document', timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // Re-open the document: the branch must still be folded.
    await page.reload();
    await openDoc(page, docId);
    await toMindmapView(page);
    await expect
      .poll(async () => {
        const total = await page.locator('.mm-node').count();
        const folded = await page.locator('.mm-node.mm-collapsed').count();
        return `${folded}/${total}`;
      }, { message: 'the fold must come back after a reopen', timeout: 30_000 })
      .toMatch(/^[1-9]/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
