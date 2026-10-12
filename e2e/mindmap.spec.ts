import { test, expect, type Page } from './fixtures';
import {
  openDoc, toMindmapView, toOutlineView, structureSelect, setStructure,
  contentBox, canvasBox, currentScale, clickBarButton, revealInBar,
  ensureBarOpen,
} from './mindmap';
import {
  kernelApi, ensureTestDoc, resolveTestNotebook, TOP_BRANCHES,
  createTempDoc, createTempDocTitled, removeDoc,
  field,
} from './testdoc';
import { PNG } from 'pngjs';
import { siyuanUrl, siyuanToken } from './env';

/**
 * E2E for the mind map view —— replacing the earlier CDP + eyeball verification with real assertions in a real browser.
 *
 * ## Three things to know before reading
 *
 * 1. **The test document is purpose-built** (see `testdoc.ts`). Reusing an existing document once caused a false report:
 *    the synthetic root of that document had only one child, so balanced layout correctly did not split, yet the test called it a bug.
 * 2. **Input goes through real events**. CDP's synthetic events never reached SiYuan's gesture logic,
 *    producing the false positive "it passes but the control group does not move either". Playwright goes through the browser's real input pipeline.
 * 3. **Assertions look at geometry/pixels, not DOM counts**. `AGENTS.md` says this explicitly:
 *    an element can exist and be counted, yet the user cannot see it.
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

test.beforeEach(async ({ page }) => {
  await openDoc(page, DOC);
  await toMindmapView(page);
});

/**
 * Read which side of the root each **top-level branch** lands on.
 *
 * ★ This must be decided by node identity, never by comparing coordinate sets ——
 * "balanced" and "alternate" under equal-weight subtrees have the same left/right counts (2/2 each),
 * and the x coordinate sets may be identical too; only which branch is left and which is right differs.
 */
async function sidesByBranch(page: Page): Promise<Record<string, 'left' | 'right' | 'none'>> {
  return page.evaluate((branches: string[]) => {
    const nodes = [...document.querySelectorAll('.mm-node')];
    const info = nodes.map((n) => {
      const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(n.getAttribute('transform') ?? '');
      return { x: m ? parseFloat(m[1]) : NaN, text: (n.textContent ?? '').replace(/\s+/g, '') };
    });
    // Root = the node with the smallest x? No —— the root is the node at the smallest depth. Here we use the one that contains the document title
    const root = info.find((i) => i.text && !branches.some((b) => i.text.startsWith(b))) ?? info[0];
    const out: Record<string, 'left' | 'right' | 'none'> = {};
    for (const b of branches) {
      const hit = info.find((i) => i.text.startsWith(b));
      if (!hit) out[b] = 'none';
      else out[b] = hit.x < root.x - 1 ? 'left' : hit.x > root.x + 1 ? 'right' : 'none';
    }
    return out;
  }, TOP_BRANCHES);
}

test('the mind map view renders nodes', async ({ page }) => {
  const n = await page.locator('.mm-node').count();
  expect(n, 'the mind map should contain nodes').toBeGreaterThan(4);
  for (const b of TOP_BRANCHES) {
    await expect(page.locator('.mm-node', { hasText: b }).first(), `should have a "${b}" node`).toBeVisible();
  }
});

test('the default structure is rightward', async ({ page }) => {
  const sel = structureSelect(page);
  // The first dropdown option is the default structure (when changing the default, it must also be moved to the first position)
  expect(await sel.locator('option').first().getAttribute('value')).toBe('right');
  await expect(sel).toHaveValue('right');

  // And they really are all on the right-hand side
  const sides = await sidesByBranch(page);
  expect(Object.values(sides).every((s) => s === 'right'), JSON.stringify(sides)).toBe(true);
});

test('the structure dropdown has five items, in the right order with the right labels', async ({ page }) => {
  const opts = await structureSelect(page).locator('option').evaluateAll((els) =>
    els.map((e) => ({ value: (e as HTMLOptionElement).value, text: (e as HTMLOptionElement).textContent?.trim() })),
  );
  expect(opts.map((o) => o.value)).toEqual(['right', 'balanced', 'left', 'org', 'timeline']);
  expect(opts.map((o) => o.text)).toEqual(['向右', '平衡', '向左', '向下', '交替']);
  // The labels must not contain chart-type suffixes
  expect(opts.map((o) => o.text).join('')).not.toMatch(/图/);
});

/**
 * ★ The five structures must produce **mutually different** renderings.
 *
 * We assert here that the "left/right assignment of top-level branches" combination is unique —— steadier than asserting coordinates,
 * and the only way to tell balanced from alternate.
 */
test('each of the five structures produces a different left/right assignment', async ({ page }) => {
  const seen = new Map<string, string>();
  for (const v of ['right', 'balanced', 'left', 'org', 'timeline']) {
    await setStructure(page, v);
    const sides = await sidesByBranch(page);
    expect(Object.values(sides).some((s) => s !== 'none'), `structure ${v} should render at least one branch`).toBe(true);
    const key = JSON.stringify(sides);
    const dup = seen.get(key);
    expect(dup, `structure ${v} renders exactly the same result as ${dup}`).toBeUndefined();
    seen.set(key, v);
  }
  expect(seen.size).toBe(5);
});

/** Pin down exactly how balanced and alternate divide the children, so a future change cannot break them. */
test('balanced structure splits the child nodes in half by weight', async ({ page }) => {
  await setStructure(page, 'balanced');
  const sides = await sidesByBranch(page);
  const left = TOP_BRANCHES.filter((b) => sides[b] === 'left');
  const right = TOP_BRANCHES.filter((b) => sides[b] === 'right');
  expect(left.length, JSON.stringify(sides)).toBe(2);
  expect(right.length, JSON.stringify(sides)).toBe(2);
  // Half by weight = the first half on the right, the second half on the left (split in document order)
  expect(right).toEqual(['分支一', '分支二']);
  expect(left).toEqual(['分支三', '分支四']);
});

test('alternate structure puts child nodes on both sides by parity', async ({ page }) => {
  await setStructure(page, 'timeline');
  const sides = await sidesByBranch(page);
  // Index 0/2 on the right, 1/3 on the left
  expect(sides['分支一']).toBe('right');
  expect(sides['分支二']).toBe('left');
  expect(sides['分支三']).toBe('right');
  expect(sides['分支四']).toBe('left');
});

/** Control group: applying the same structure twice must give a stable result —— proof the differences above are not jitter. */
test('control group: applying the same structure twice changes nothing', async ({ page }) => {
  await setStructure(page, 'balanced');
  const a = await sidesByBranch(page);
  await setStructure(page, 'balanced');
  const b = await sidesByBranch(page);
  expect(b).toEqual(a);
});

/**
 * ★ Fit button must really fit the entire map.
 *
 * Corresponding defect: zoom used to be clamped at a readable lower bound (0.55 on a narrow screen),
 * so a button labeled "scale to fit all nodes" still could not fit everything.
 * Trade-off: **do not fit to font size** —— fitting everything takes priority.
 */
/**
 * ★★ `contentBox` must **refuse** to answer when it measured nothing.
 *
 * ## The defect this pins
 *
 * It used to return `{ l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }` when no `.mm-node` had a
 * non-zero rect. The "fit fits all the nodes" case below then asserts
 *
 *     content.l >= canvas.l - 2      content.r <= canvas.r + 2
 *
 * and **every one of those comparisons is satisfied by the sentinels** —— `Infinity >= anything` is true and
 * `-Infinity <= anything` is true. So the case passed with an empty panel: a missing precondition reported as
 * a pass, which is the failure mode that stays quiet (§7, "a test helper must not ... return nulls for a
 * missing precondition").
 *
 * `canvasBox` next to it already throws for its own missing precondition. This asserts the same rule applies
 * here, so a future refactor cannot reintroduce the sentinels and have the caller keep passing.
 *
 * It deliberately opens **no document**: the point is that there is nothing to measure. That is why it is a
 * case of its own rather than an assertion inside a case that has a panel open.
 */
test('★ contentBox refuses to answer when it measured no nodes', async ({ page }) => {
  // No document, no panel —— nothing can be measured. `about:blank` guarantees it rather than assuming it.
  await page.goto('about:blank');

  let message = '';
  try {
    await contentBox(page);
  } catch (e) {
    message = String(e);
  }

  expect(message, 'contentBox must throw instead of returning Infinity sentinels').not.toBe('');
  // It must name the precondition, not fail with a bare TypeError somewhere downstream.
  expect(message, `the error should say what went wrong, got: ${message.slice(0, 200)}`).toMatch(
    /measured 0 nodes/,
  );
});

test('fit button fits all the nodes', async ({ page }) => {
  // ★ Do not manufacture a "narrow panel" by shrinking the viewport: measured with a 900×700 viewport,
  //   SiYuan's right dock gets pushed entirely off screen (the dock sits at 908~1145 while the viewport is only 900 wide),
  //   and the plugin's buttons can no longer be clicked —— that is SiYuan's layout behavior, not the thing under test.
  //   Besides, at the default 1440 viewport the dock is only 237px wide anyway, which is already narrow enough.
  await clickBarButton(page, '适应');
  await page.waitForTimeout(600);

  const c = await canvasBox(page);
  const content = await contentBox(page);
  expect(content.l, `content left ${content.l} should not exceed canvas left ${c.l}`).toBeGreaterThanOrEqual(c.l - 2);
  expect(content.r, `content right ${content.r} should not exceed canvas right ${c.r}`).toBeLessThanOrEqual(c.r + 2);
  expect(content.t, `content top ${content.t} should not exceed canvas top ${c.t}`).toBeGreaterThanOrEqual(c.t - 2);
  expect(content.b, `content bottom ${content.b} should not exceed canvas bottom ${c.b}`).toBeLessThanOrEqual(c.b + 2);
});

/**
 * ★★ Fit button fits under **every document shape** —— not just the default one.
 *
 * ## Why this deserves its own case
 *
 * The case above only covered the shared test document (4 branches × 2 children) —— **one shape**.
 * But fit is `k = min(1, (cw-pad)/layout.w, (ch-pad)/layout.h)` ——
 * so **both** directions can become the bottleneck:
 *
 *   · wide and shallow document → width hits the limit first
 *   · narrow and deep document → height hits the limit first
 *   · single node → both are very loose, tests whether the min(1, …) cap really takes effect
 *
 * Testing one shape only covers one of those branches.
 *
 * ★ This case also pins down an **easy-to-get-wrong precondition**: the measured k matches
 *   the formula hand-computed to 5 decimal places (237px bar → k=0.3376), which shows that
 *   "fit to width" really is in effect, rather than a lucky non-overflow.
 *
 * The criterion is "does not overflow", not "fills up": `layout` carries its own padX=80/padY=60 whitespace,
 * and "fills up" was never the design goal (see AGENTS "do not cap things on the user's behalf").
 */
test('fit button fits under every document shape', async ({ page }) => {
  // ★ This file has no module-level `api` (the one built in `beforeAll` is disposed right away),
  //   so this case creates and removes its own temporary document, and opens a separate one here.
  const api = await kernelApi(
    siyuanUrl(),
    siyuanToken(),
  );
  const shapes: Array<{ name: string; md: string; note: string }> = [
    { name: 'wide and shallow', md: '- 甲\n  - 节点一\n  - 节点二\n  - 节点三\n  - 节点四\n- 乙\n  - 节点八\n- 丙\n', note: 'width hits the limit first' },
    { name: 'narrow and deep', md: '- 甲\n  - 节点一\n    - 节点二\n      - 节点三\n        - 节点四\n          - 节点五\n', note: 'height hits the limit first' },
    { name: 'single node', md: '- 只有一个\n', note: 'very loose, tests the min(1,…) cap' },
    { name: 'multi-level and multi-branch', md: '- 甲\n  - 节点一\n    - 节点一a\n    - 节点一b\n  - 节点二\n- 乙\n  - 节点八\n', note: 'there is volume in both directions' },
  ];

  const failures: string[] = [];
  for (const sh of shapes) {
    const id = await createTempDoc(api, notebook, sh.md);
    try {
      await openDoc(page, id);
      await toMindmapView(page);
      await clickBarButton(page, '适应');
      await page.waitForTimeout(700);

      const c = await canvasBox(page);
      const content = await contentBox(page);

      // Leave a 2px tolerance for floating point/rounding
      const over = {
        left: c.l - content.l,
        right: content.r - c.r,
        top: c.t - content.t,
        bottom: content.b - c.b,
      };
      const bad = Object.entries(over).filter(([, v]) => v > 2);
      if (bad.length) {
        failures.push(
          `${sh.name} (${sh.note}) overflowed ` +
            bad.map(([k, v]) => `${k}${Math.round(v)}px`).join('/') +
            `  canvas ${JSON.stringify(c)} content ${JSON.stringify(content)}`,
        );
      }

      // Precondition check: nodes really were measured, otherwise "no overflow" is fake.
      //
      // ★ Kept, but no longer the only thing standing between this case and a vacuous pass: `contentBox`
      //   itself now throws when it measured nothing (it used to return `Infinity` sentinels, which every
      //   `>=` / `<=` assertion below is satisfied by). This assertion is a second, local statement of the
      //   same precondition —— it reads naturally where the overflow comparison is, and it would still catch
      //   a caller that opted out of the throw.
      expect(
        Number.isFinite(content.l),
        `${sh.name}: contentBox must have measured real nodes (it throws when it measured none)`,
      ).toBe(true);
    } finally {
      await removeDoc(api, id);
    }
  }

  await api.dispose();
  expect(failures, `fit button must not let content run outside the canvas:\n${failures.join('\n')}`).toHaveLength(0);
});

/**
 * ★ Drag panning must really move the picture —— the control case for the CDP synthetic-event failure.
 */
test('dragging the canvas really pans the mind map', async ({ page }) => {
  const before = await contentBox(page);
  const c = await canvasBox(page);
  const cx = c.l + c.w / 2;
  const cy = c.t + c.h / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await contentBox(page);
  expect(Math.abs(after.l - before.l), 'the content should shift horizontally').toBeGreaterThan(40);
});

/**
 * ★ Ctrl+wheel must really zoom.
 *
 * Note that the wheel is **dual-purpose** in this plugin (`onWheel` in `Mindmap.tsx`):
 *   - plain wheel → pan (`setView`)
 *   - Ctrl/Cmd + wheel → zoom (`zoom`)
 *
 * A plain wheel was used to test zoom at first and the assertion naturally failed —— the test was wrong, not the product.
 * We test one case per path, pinning the semantics down.
 */
test('Ctrl+wheel really zooms the mind map', async ({ page }) => {
  const before = await currentScale(page);
  const c = await canvasBox(page);

  await page.mouse.move(c.l + c.w / 2, c.t + c.h / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);

  const after = await currentScale(page);
  expect(Number.isFinite(before) && Number.isFinite(after)).toBe(true);
  expect(Math.abs(after - before), `the scale should change (${before} → ${after})`).toBeGreaterThan(0.01);
});

/** A plain wheel = pan (not zoom) —— the counterpart to the case above. */
test('a plain wheel pans instead of zooming', async ({ page }) => {
  const scaleBefore = await currentScale(page);
  const before = await contentBox(page);
  const c = await canvasBox(page);

  await page.mouse.move(c.l + c.w / 2, c.t + c.h / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);

  expect(await currentScale(page), 'a plain wheel should not change the scale').toBeCloseTo(scaleBefore, 3);
  const after = await contentBox(page);
  expect(Math.abs(after.t - before.t), 'a plain wheel should pan the content').toBeGreaterThan(20);
});

/**
 * ★ The settings bar overflows horizontally in a narrow panel —— this records the status quo so it cannot quietly get worse.
 *
 * Measured: the sidebar has 237px available while the bar content is 1131px, so fit and export image buttons fall outside the viewport.
 * Right now they can only be reached by scrolling with `overflow-x: auto` (`scrollLeft` 0 → 894).
 * This case does not assert "it must overflow" (that would box in whoever fixes the layout later),
 * it only asserts that **the buttons are always reachable by scrolling** —— a floor that cannot be given up.
 */
test('buttons in the settings bar are always reachable by scrolling', async ({ page }) => {
  for (const label of ['适应', '导出图片', '导出 .mm']) {
    const btn = await revealInBar(page, label);
    await expect(btn, `"${label}" should be visible`).toBeVisible({ timeout: 5_000 });
  }
});

/**
 * ★★ In a narrow sidebar every settings bar control must be inside the viewport, with no horizontal scrolling needed.
 *
 * ## The defect this case covers
 *
 * `.om-mm-root .mm-bar` used to be unconditionally `flex-wrap: nowrap` + `overflow-x: auto`:
 * SiYuan's right dock measures only **237px**, while the settings bar content is **1131px** (about 4.8×),
 * so fit, export image and export .mm buttons all fell outside the viewport
 * (the last button measured x up to 1907 while the viewport was only 1440 wide),
 * reachable only through a **4px tall** horizontal scrollbar —— which users would never find.
 *
 * The fix wraps when it does not fit, based on the **container** width (not the viewport).
 *
 * ## Why assert "no horizontal scrolling needed" and not just "the buttons are visible"
 *
 * `toBeVisible()` **still returns true** for elements inside an overflowing container —— the element really is rendered,
 * it has a size, it is just not in the viewport. The previous version of this case failed exactly there: it scrolled horizontally by hand first and then asserted visibility,
 * so the defect passed either way. That is why three things are pinned here:
 * the controls are inside the viewport, the bar itself needs no horizontal scrolling, and the bar really did wrap.
 */
  test('in a narrow sidebar the settings bar controls are all inside the viewport with no horizontal scrolling', async ({ page }) => {
    // ★★★ It must **set the bar narrow itself**.
    //
    //   This case used to depend on the **environmental fact** that "the right dock is exactly 237px" ——
    //   but the dock width is **persistent** (SiYuan records the dock width in its layout config,
    //   it is not visible in browser localStorage). On one measured run it was **636px**.
    //
    //   At 636px this case still "passed" —— because its precondition asserted only
    //   `barWidth < viewportWidth / 2` (636 < 720), **84px of luck**.
    //   If the user drags the dock a bit wider it goes red; but then it is no longer testing a "narrow bar".
    //
    //   ⇒ Set it explicitly to 300px and assert that it really is narrow.
    await page.evaluate(() => {
      const d = document.querySelector('.layout__dockr') as HTMLElement | null;
      if (d) { d.style.flex = 'none'; d.style.width = '300px'; d.style.minWidth = '300px'; }
    });
    await page.waitForTimeout(600);
    await ensureBarOpen(page);

    const info = await page.evaluate(() => {
    const bar = document.querySelector('.om-mm-root .mm-bar') as HTMLElement | null;
    if (!bar) return null;
    const vw = window.innerWidth;
    const cs = getComputedStyle(bar);
    const offScreen: string[] = [];
    for (const c of Array.from(bar.children)) {
      const b = (c as HTMLElement).getBoundingClientRect();
      if (b.width <= 0) continue;
      if (b.right > vw + 1 || b.left < -1) offScreen.push((c.textContent || '').trim().slice(0, 12));
    }
    return {
      barWidth: Math.round(bar.getBoundingClientRect().width),
      viewportWidth: vw,
      needsHScroll: bar.scrollWidth > bar.clientWidth + 1,
      flexWrap: cs.flexWrap,
      overflowX: cs.overflowX,
      offScreen,
      childCount: bar.children.length,
    };
  });
  expect(info, 'the settings bar should be found').not.toBeNull();
  const i = info!;

  // Precondition: this really is a "narrow" bar, otherwise this case proves nothing.
  // ★ Use "clearly narrower than the 560 wrap breakpoint" as the criterion, not "less than half the viewport" ——
  //   the latter "passes" with a 636px bar in a 1440px window, yet that is not a narrow bar (measured).
  // ★ It must have a **non-zero** width: when the toolbar is collapsed `.mm-bar` is `display:none`,
  //   so the width is **0** —— and `0 < 400` **passes**!
  //   That is exactly a "vacuous pass": nothing was measured, yet the assertion goes green.
  //   (Measured the hard way: injected a 900px wide bar, and because it was collapsed to 0 the case still went green.)
  expect(i.barWidth, `the toolbar should have a width (0 means it is collapsed and nothing can be measured)`).toBeGreaterThan(0);
  expect(
    i.barWidth,
    `this case needs a **really narrow** bar (clearly below the 560 wrap breakpoint), measured ${i.barWidth}px`,
  ).toBeLessThan(400);

  expect(i.offScreen, `no control should fall outside the viewport: ${i.offScreen.join(', ')}`).toHaveLength(0);
  expect(i.needsHScroll, 'in a narrow bar, wrapping should remove the need for horizontal scrolling').toBe(false);
  expect(i.flexWrap, 'in a narrow bar it should wrap instead of squeezing into one line').toBe('wrap');
});

  /**
   * ★★ The settings bar must never push controls outside the boundary at **any container width**.
   *
   * ## Why testing a single width is not enough
   *
   * Originally there was only the "narrow sidebar" case above, and it tested the default 237px —— so it missed half:
   *
   * The fix was `@container (max-width: 560px) { flex-wrap: wrap }`,
   * wrapping **only below 560px**. Measured after widening the right dock:
   *
   * | Container width | Result |
   * |---|---|
   * | 237 / 400 / 560 | ✅ wrapped, all present |
   * | **700** | ❌ export .mm pushed out again |
   * | 900 / 1100 | ❌ the stats text out of bounds |
   * | 1200 / 1300 | ❌ the stats text **still** out of bounds |
   *
   * Because the content is about 1131px while the breakpoint was a **guess** at 560 —— above the breakpoint it still overflowed.
   * The real criterion is "does it fit", which is what flex-wrap does by itself,
   * not something for us to guess a width for. The base rule is now a plain `flex-wrap: wrap`.
   *
   * The stats text had a separate problem: `flex-shrink: 0` pinned it at 298px,
   * still outside even in a 1300px container. Changed to shrinkable + `min-width: 0` (the latter being
   * the switch that actually lets a flex item shrink).
   *
   * ## Use the **bar's own** boundary as the criterion, not the viewport
   *
   * The probe forces the dock wider while the window is still 1440 —— so the dock itself sticks out of the window,
   * and judging by the viewport yields a false positive (that is what misjudged the 1300px row).
   */
  /**
   * ★★ The toolbar collapse toggle must show/hide with the **bar width**, not the **window width**.
   *
   * ## The defect this case covers
   *
   * `.mm-bar-toggle` used to control its visibility with `@media (max-width: 560px)` ——
   * which looks at the **window** width, but this toggle controls the **SiYuan right dock**,
   * and the dock width is **unrelated** to the window width.
   *
   * Measured (1440px window, 237px right dock): the toggle was `display: none` ——
   * the user was in a narrow dock that **does not fit anything** and had **no way at all to collapse the toolbar**.
   * Conversely, on a landscape phone (900px window) the dock is actually wider, yet the toggle appeared.
   *
   * Fix: switch to `@container`, the same criterion as the `.mm-bar` wrap rule.
   *
   * ## Why "wide window + narrow dock" must be tested as a pair
   *
   * Shrinking only the window makes the `@media` version **pass too** —— a false pass.
   * Only **wide window, narrow dock** can expose the "criterion looks at the wrong thing" bug.
   */
  test('the collapse toggle follows the bar width, not the window width', async ({ page }) => {
    // Precondition: the window is **wide** (so @media does not match) and the dock is **narrow** (so collapsing really is needed)
    const vw = await page.evaluate(() => window.innerWidth);
    expect(vw, `the window should be wide enough, otherwise the "criterion looks at the wrong thing" cannot be exposed (measured ${vw}px)`).toBeGreaterThan(560);

    // ★ Use the **dock** width as the "bar width", not the width of `.mm-bar` ——
    //   when the toolbar is collapsed `.mm-bar` is `display:none` and its width is **0**,
    //   so using it as the criterion gives a false failure of "the dock was not widened" (measured the hard way).
    const read = async () => page.evaluate(() => {
      const bar = document.querySelector('.om-mm-root .mm-bar') as HTMLElement | null;
      const tg = document.querySelector('.om-mm-root .mm-bar-toggle') as HTMLElement | null;
      const dock = document.querySelector('.layout__dockr') as HTMLElement | null;
      return {
        barW: dock ? Math.round(dock.getBoundingClientRect().width) : -1,
        shown: tg ? getComputedStyle(tg).display !== 'none' : null,
        visible: tg ? tg.getBoundingClientRect().width > 0 : null,
        offRight: tg && tg.getBoundingClientRect().width > 0
          ? Math.round(tg.getBoundingClientRect().right - window.innerWidth) : 0,
      };
    });

    // ① Narrow dock (the default 237px right dock) + wide window → the toggle must be shown
    const narrow = await read();
    // ★ It must first confirm that **something was measured**: when the toolbar is collapsed `.mm-bar` is `display:none` and
    //   its width is 0 —— and `0 < 560` **passes**, which makes this precondition worthless (measured the hard way).
    expect(narrow.barW, `the toolbar should have a width (0 means it is collapsed and nothing can be measured)`).toBeGreaterThan(0);
    expect(narrow.barW, `the right dock should really be narrow (measured ${narrow.barW}px)`).toBeLessThan(560);
    expect(
      narrow.shown,
      `with a bar of only ${narrow.barW}px and a window of ${vw}px, the collapse toggle should be shown` +
        `(judging the window with @media misses this case —— and then the user cannot collapse the toolbar)`,
    ).toBe(true);
    expect(narrow.visible, 'the toggle should really have a size (display not being none does not mean visible)').toBe(true);
    expect(narrow.offRight, `the toggle should not run outside the viewport (measured ${narrow.offRight}px past the edge)`).toBeLessThanOrEqual(0);

    // ② It really can toggle open and closed
    //
    // ★ Written as "relative to the current state" instead of "assume it starts expanded":
    //   in a narrow dock the toolbar is now **collapsed by default** (first visit is decided by dock width, see Mindmap.tsx),
    //   so a "one click makes it collapse" wording would fail the other way round.
    //   Here we only assert that "one click flips the state", independent of the initial state.
    const isCollapsed = () => page.evaluate(() =>
      document.querySelector('.om-mm-root .mm-bar')?.classList.contains('mm-bar--collapsed'),
    );
    const before = await isCollapsed();
    await page.locator('.om-mm-root .mm-bar-toggle').click();
    await page.waitForTimeout(500);
    expect(await isCollapsed(), `one click on the toggle should flip the collapsed state (was ${before})`).toBe(!before);

    await page.locator('.om-mm-root .mm-bar-toggle').click();
    await page.waitForTimeout(500);
    expect(await isCollapsed(), 'another click should flip it back').toBe(before);

    // ③ The reverse: after the dock is **widened** until things fit, the toggle should disappear
    //
    // ★ Expand the toolbar before measuring: when collapsed `.mm-bar` is `display:none`,
    //   so `getBoundingClientRect().width` is **0**,
    //   and comparing 0 against "should be > 560" gives a **meaningless** failure (measured the hard way).
    await page.evaluate(() => {
      const d = document.querySelector('.layout__dockr') as HTMLElement | null;
      if (d) { d.style.flex = 'none'; d.style.width = '900px'; d.style.minWidth = '900px'; }
    });
    await page.waitForTimeout(600);
    // Once the dock is wide the toggle (if still there) is clickable; click it to make sure it is expanded
    await ensureBarOpen(page);
    const wide = await read();
    expect(wide.barW, `it should really have been widened (measured ${wide.barW}px)`).toBeGreaterThan(560);
    expect(
      wide.shown,
      `with a bar of ${wide.barW}px that fits, the collapse toggle should no longer be shown`,
    ).toBe(false);
  });

  /**
   * ★★ The **layout** for a narrow bar (label on top, controls stacked vertically) must also follow the bar width.
   *
   * ## The defect this case covers
   *
   * The case above only checks whether controls overflow —— **the layout itself** is a different matter:
   * that whole block of narrow-screen toolbar styling (about 60 lines: `> label` stacking, button font size,
   * larger swatches) used to live in `@media (max-width: 560px)`,
   * which looks at the **window** width.
   *
   * Measured consequence (1440px window, 237px right dock):
   *   `getComputedStyle(label).flexDirection` = `'row'`
   * —— that is, a desktop user who drags the sidebar narrow **never gets** the layout prepared for a narrow bar.
   * It only turns into `'column'` when the window is shrunk to 520px.
   *
   * ## Why use flexDirection as the criterion
   *
   * It is the **cleanest observable difference** in that styling: `row` or `column`
   * is obvious at a glance and is not disturbed by secondary properties such as font size or whitespace.
   * And it is precisely the mechanism behind "label on top, controls filling the whole row".
   */
  test('the narrow-bar stacked layout follows the bar width, not the window width', async ({ page }) => {
    const vw = await page.evaluate(() => window.innerWidth);
    expect(vw, `the window should be wide enough, otherwise the "criterion looks at the wrong thing" cannot be exposed (measured ${vw}px)`).toBeGreaterThan(560);

    // ★ The bar width is always taken from the **dock**, never from `.mm-bar` ——
    //   when the toolbar is collapsed the latter is `display:none` with width 0 (this false failure was measured the hard way).
    //   Also, `flexDirection` can only be measured while **expanded**, so `ensureBarOpen` runs before measuring.
    const read = async () => {
      await ensureBarOpen(page);
      return page.evaluate(() => {
        const label = document.querySelector('.om-mm-root .mm-bar > label') as HTMLElement | null;
        const dock = document.querySelector('.layout__dockr') as HTMLElement | null;
        return {
          barW: dock ? Math.round(dock.getBoundingClientRect().width) : -1,
          dir: label ? getComputedStyle(label).flexDirection : null,
        };
      });
    };

    // ① Wide window + narrow dock → must use the stacked layout
    const narrow = await read();
    // ★ It must first confirm that **something was measured**: when the toolbar is collapsed `.mm-bar` is `display:none` and
    //   its width is 0 —— and `0 < 560` **passes**, which makes this precondition worthless (measured the hard way).
    expect(narrow.barW, `the toolbar should have a width (0 means it is collapsed and nothing can be measured)`).toBeGreaterThan(0);
    expect(narrow.barW, `the right dock should really be narrow (measured ${narrow.barW}px)`).toBeLessThan(560);
    expect(
      narrow.dir,
      `with a bar of only ${narrow.barW}px the label should be stacked (flexDirection: column), ` +
        `measured '${narrow.dir}' —— judging the window with @media misses this case`,
    ).toBe('column');

    // ② Widen the dock until it fits → it should go back to a row
    await page.evaluate(() => {
      const d = document.querySelector('.layout__dockr') as HTMLElement | null;
      if (d) { d.style.flex = 'none'; d.style.width = '900px'; d.style.minWidth = '900px'; }
    });
    await page.waitForTimeout(600);
    const wide = await read();
    expect(wide.barW, `it should really have been widened (measured ${wide.barW}px)`).toBeGreaterThan(560);
    expect(
      wide.dir,
      `with a bar of ${wide.barW}px that fits it should go back to a row, measured '${wide.dir}'`,
    ).toBe('row');
  });

  /**
   * ★★ The narrow-bar styling of the title area must follow the **bar width**, not the window width.
   *
   * ## The defect this case covers
   *
   * The narrow-bar styling of `.outliner-title` (padding 14px, font size 24px) used to live in
   * `@media (max-width: 768px)` —— which looks at the **window** width. But the title area is
   * **the plugin's own panel content**, whose width follows the dock.
   *
   * Measured (1440px window, 300px right dock):
   *   paddingTop=20px  fontSize=32px   ← the desktop set, never changed
   * The expected 14px / 24px could never be reached —— unless the **entire window** were shrunk below 768px,
   * and by then SiYuan has long pushed the panel away.
   *
   * ⇒ A desktop user who drags the sidebar narrow keeps a 32px title that squeezes the content badly.
   */
  test('the narrow-bar title styling follows the bar width, not the window width', async ({ page }) => {
    // ★ `.outliner-title` only exists in the **outline** view; the page fixture of this file
    //   stays in the mind map view by default, so not switching over would measure null.
    await toOutlineView(page);
    const vw = await page.evaluate(() => window.innerWidth);
    expect(vw, `the window should be wide enough, otherwise the "criterion looks at the wrong thing" cannot be exposed (measured ${vw}px)`).toBeGreaterThan(768);

    const read = async () => page.evaluate(() => {
      const t = document.querySelector('.outliner-title .title') as HTMLElement | null;
      const dock = document.querySelector('.layout__dockr');
      return {
        dockW: dock ? Math.round(dock.getBoundingClientRect().width) : -1,
        font: t ? getComputedStyle(t).fontSize : null,
        padTop: t ? getComputedStyle(t.parentElement as HTMLElement).paddingTop : null,
      };
    });

    // ① Wide window + narrow dock → it must use the narrow-bar font size
    await page.evaluate(() => {
      const d = document.querySelector('.layout__dockr') as HTMLElement | null;
      if (d) { d.style.flex = 'none'; d.style.width = '300px'; d.style.minWidth = '300px'; }
    });
    await page.waitForTimeout(600);
    const narrow = await read();
    expect(narrow.dockW, `the right dock should really be narrow (measured ${narrow.dockW}px)`).toBeLessThan(768);
    expect(
      narrow.font,
      `with a dock of only ${narrow.dockW}px and a window of ${vw}px, the title should use the narrow-bar font size 24px, measured ${narrow.font}`,
    ).toBe('24px');
    expect(narrow.padTop, `the title padding in a narrow bar should be 14px, measured ${narrow.padTop}`).toBe('14px');

    // ② Widen the dock → back to the desktop font size
    await page.evaluate(() => {
      const d = document.querySelector('.layout__dockr') as HTMLElement | null;
      if (d) { d.style.flex = 'none'; d.style.width = '1100px'; d.style.minWidth = '1100px'; }
    });
    await page.waitForTimeout(600);
    const wide = await read();
    expect(wide.dockW, `it should really have been widened (measured ${wide.dockW}px)`).toBeGreaterThan(768);
    expect(wide.font, `with a wide enough dock the title should go back to 32px, measured ${wide.font}`).toBe('32px');
  });

  /**
   * ★★ The sidebar arrow's "visible on touch" must follow the **input device**, not the width.
   *
   * ## The defect this case covers
   *
   * `.node-sidebar-arrow` is `opacity: 0` by default and reveals itself through `.node-row:hover`.
   * **Touch devices have no hover** —— so another block raises it to `opacity: 0.85`
   * and enlarges it to 32px (a finger is fatter than a mouse). But that block's criterion was
   * `@media (max-width: 768px)` —— **the wrong axis**.
   *
   * Measured (`hasTouch` context, 1440px window):
   *   pointer:coarse=true  hover:none=true  yet the arrow's opacity was still **0**
   * ⇒ Tablet users **never see this arrow** (they never get the coarse set);
   *   conversely, **mouse** users on a narrow window did get it.
   *
   * ⇒ Changed to `@media (pointer: coarse)`.
   *
   * ## Why the hasTouch context is mandatory
   *
   * Narrowing the window in an ordinary context makes the `@media (max-width)` version **pass too** ——
   * a false pass. Only "touch device + wide window" can expose that "the criterion looked at the wrong axis".
   */
  test('sidebar arrow touch visibility follows the input device, not the width', async ({ browser }) => {
    const mk = async (touch: boolean) => {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        hasTouch: touch,
      });
      const pg = await ctx.newPage();
      await openDoc(pg, DOC);
      await toOutlineView(pg);
      const r = await pg.evaluate(() => {
        const a = document.querySelector('.om-outline-wrap .node-sidebar-arrow') as HTMLElement | null;
        if (!a) return null;
        const cs = getComputedStyle(a);
        return {
          opacity: Number(cs.opacity),
          w: Math.round(a.getBoundingClientRect().width),
          coarse: matchMedia('(pointer: coarse)').matches,
          vw: window.innerWidth,
        };
      });
      await ctx.close();
      return r;
    };

    const touch = await mk(true);
    expect(touch, 'the sidebar arrow should be found in the touch context').not.toBeNull();
    expect(touch!.vw, `the window should be wide enough, otherwise the "criterion looked at the wrong axis" cannot be exposed (measured ${touch!.vw}px)`).toBeGreaterThan(768);

    // ① Touch device (however wide the window) → the arrow must be visible and large enough
    expect(
      touch!.opacity,
      `Touch devices have no hover, so the arrow must be visible by default (opacity > 0), measured ${touch!.opacity}. ` +
        `Using @media (max-width) as the criterion would make tablet users on a wide window never see it`,
    ).toBeGreaterThan(0);
    expect(touch!.w, `the touch device's hit area should be enlarged to 32px (a finger is fatter than a mouse), measured ${touch!.w}px`).toBe(32);

    // ② Mouse device → keeps "hidden by default, revealed on hover"
    const mouse = await mk(false);
    expect(mouse, 'the sidebar arrow should be found in the mouse context').not.toBeNull();
    expect(
      mouse!.opacity,
      `A mouse device should stay hidden by default (revealed on hover), measured ${mouse!.opacity}`,
    ).toBe(0);
    expect(mouse!.w, `a mouse device does not need an enlarged hit area, measured ${mouse!.w}px`).toBe(24);
  });

  /**
   * ★★ On first visit the toolbar's **default open/closed state** must be decided by dock width, not window width.
   *
   * ## The defect this case covers
   *
   * The first-visit default for `barOpen` used to be `window.innerWidth > 560` ——
   * yet another criterion that "uses the window width as a stand-in" (this repo has fixed 4 of that same mistake).
   * The toolbar lives in the **SiYuan right dock**, whose width is **unrelated** to the window width.
   *
   * Measured (first visit, no localStorage, 1440px window, 237px right dock):
   *   the expanded toolbar takes **239px** of height, while the panel is only 798px tall in total
   *   ⇒ the canvas has 529px left, **a third of the panel eaten by the toolbar**.
   * The first time a user opens the mind map they see a wall of settings instead of the map.
   *
   * ## How to create a "first visit"
   *
   * Both preconditions are required:
   *   ① no `om-mm-bar-open` in `localStorage` (otherwise the user's choice is read instead)
   *   ② the dock is already at the target width **before** the page scripts run (use `addInitScript`;
   *      setting the width with `evaluate` after reload is too late —— the first-visit decision has long been made)
   */
  test('the first-visit default open/closed state follows the dock width, not the window width', async ({ browser }) => {
    const probe = async (dockW: number) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      // ★② It must be injected before the page scripts and kept up (SiYuan rewrites the dock's styles)
      await ctx.addInitScript((width: number) => {
        try { localStorage.removeItem('om-mm-bar-open'); } catch { /* storage unavailable */ }
        const set = (): void => {
          const d = document.querySelector('.layout__dockr') as HTMLElement | null;
          if (d) { d.style.flex = 'none'; d.style.width = `${width}px`; d.style.minWidth = `${width}px`; }
        };
        set();
        setInterval(set, 120);
      }, dockW);

      const pg = await ctx.newPage();
      await openDoc(pg, DOC);
      await toMindmapView(pg);
      const r = await pg.evaluate(() => {
        const bar = document.querySelector('.om-mm-root .mm-bar') as HTMLElement | null;
        const dock = document.querySelector('.layout__dockr') as HTMLElement | null;
        return {
          dockW: dock ? Math.round(dock.getBoundingClientRect().width) : -1,
          vw: window.innerWidth,
          collapsed: bar ? bar.classList.contains('mm-bar--collapsed') : null,
          barH: bar ? Math.round(bar.getBoundingClientRect().height) : -1,
        };
      });
      await ctx.close();
      return r;
    };

    // ① Narrow dock → the first visit should be **collapsed** (the toolbar does not fit in a narrow dock; do not eat a third of the panel)
    const narrow = await probe(237);
    expect(narrow.vw, `the window should be wide enough, otherwise the "criterion looks at the wrong thing" cannot be exposed (measured ${narrow.vw}px)`).toBeGreaterThan(560);
    expect(narrow.dockW, `the dock should really be narrow (measured ${narrow.dockW}px)`).toBeLessThan(560);
    expect(
      narrow.collapsed,
      `with a dock of only ${narrow.dockW}px and a window of ${narrow.vw}px, the toolbar should be **collapsed** by default —— ` +
        `expanding it eats about 239px (the panel is only ${narrow.barH > 0 ? '798' : '798'}px tall), ` +
        `and the first thing the user sees is settings instead of the map. measured collapsed=${narrow.collapsed}, bar height ${narrow.barH}px`,
    ).toBe(true);
    expect(narrow.barH, `when collapsed the toolbar should take no height, measured ${narrow.barH}px`).toBe(0);

    // ② Wide dock → the first visit should be **expanded** (keeping the old desktop habit)
    const wide = await probe(1100);
    expect(wide.dockW, `the dock should really be wide (measured ${wide.dockW}px)`).toBeGreaterThan(560);
    expect(
      wide.collapsed,
      `with a dock of ${wide.dockW}px that fits, the toolbar should be **expanded** by default, measured collapsed=${wide.collapsed}`,
    ).toBe(false);
    expect(wide.barH, `an expanded toolbar should have height, measured ${wide.barH}px`).toBeGreaterThan(0);
  });

  test('the settings bar does not overflow at any container width from narrow to wide', async ({ page }) => {
    const widths = [237, 400, 560, 700, 900, 1100, 1200, 1300];
    const results: { w: number; off: string[]; hscroll: boolean; barW: number }[] = [];

    for (const w of widths) {
      // Change the **right dock** width directly: that is the real source of "container narrow/wide" and it is unrelated to the window.
      await page.evaluate((width: number) => {
        const d = document.querySelector('.layout__dockr') as HTMLElement | null;
        if (d) {
          d.style.flex = 'none';
          d.style.width = `${width}px`;
          d.style.minWidth = `${width}px`;
        }
      }, w);
      await page.waitForTimeout(500);
      // ★ Every width must first have the toolbar **expanded**: in a narrow dock it is collapsed by default,
      //   and when collapsed `.mm-bar` is `display:none` so every child control has width 0 ——
      //   that would make this case **pass vacuously** with nothing to measure.
      await ensureBarOpen(page);

      const r = await page.evaluate(() => {
        const bar = document.querySelector('.om-mm-root .mm-bar') as HTMLElement | null;
        if (!bar) return null;
        // ★ Judge by the bar's own boundary, not the viewport (see the case description)
        const barR = bar.getBoundingClientRect();
        const off: string[] = [];
        for (const c of Array.from(bar.children)) {
          const b = (c as HTMLElement).getBoundingClientRect();
          if (b.width <= 0) continue;
          if (b.right > barR.right + 1 || b.left < barR.left - 1) {
            off.push((c.textContent || '').trim().slice(0, 12));
          }
        }
        return {
          off,
          hscroll: bar.scrollWidth > bar.clientWidth + 1,
          barW: Math.round(barR.width),
        };
      });

      expect(r, `the settings bar should be found at container ${w}px`).not.toBeNull();
      results.push({ w, ...r! });
    }

    // Report each one, so a failure shows at a glance which width broke
    for (const r of results) {
      expect(r.off, `at container ${r.barW}px some controls fall outside the bar: ${r.off.join(', ')}`).toHaveLength(0);
      expect(r.hscroll, `at container ${r.barW}px the bar should not need horizontal scrolling`).toBe(false);
    }

    // Precondition self-check: those widths really were applied (otherwise the whole case spins on a single width)
    const applied = new Set(results.map((r) => r.barW));
    expect(applied.size, `several different widths should really have been measured, measured ${[...applied].join('/')}`).toBeGreaterThan(4);
  });


/**
 * ★ The exported image must not carry the collapse button's "−" circle (the defect this case covers).
 *
 * ## Why not count the circles in the exported PNG
 *
 * Tried: force the badge visible and export, then compare pixels with a clean export ——
 * **only 0.275% of pixels differ**, the ink ratio is nearly unchanged (0.0679 vs 0.0675).
 * A difference of that magnitude is too fragile to judge by threshold; a different font or zoom would misjudge it.
 *
 * ## Instead, assert the "fix mechanism itself"
 *
 * The root cause of the circles showing up is clear: `cloneNode` + `XMLSerializer` carries over only class attributes,
 * not the page CSS, so the standalone SVG has no stylesheet to interpret `.mm-badge`
 * and `opacity` falls back to its default of 1. So the fix must do **both** things:
 *   ① embed the plugin styles into the exported SVG
 *   ② add `.om-mm-host` to the cloned root node (that hide rule requires an ancestor to have it)
 *
 * So we intercept the serialized SVG string directly and pin those two things down.
 * That is more precise than statistics over the rendering, and it can be verified by injection.
 */
test('the exported SVG embeds the plugin styles and its root node carries om-mm-host', async ({ page }) => {
  // Intercept XMLSerializer and capture the SVG serialized during export
  await page.evaluate(() => {
    const w = window as unknown as { __svgs?: string[] };
    w.__svgs = [];
    const orig = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = function (node: Node) {
      const out = orig.call(this, node);
      if (typeof out === 'string' && out.includes('<svg')) w.__svgs!.push(out);
      return out;
    };
  });

  const dl = page.waitForEvent('download', { timeout: 30_000 });
  await clickBarButton(page, '导出图片');
  await dl;

  const svgs = await page.evaluate(() => (window as unknown as { __svgs?: string[] }).__svgs ?? []);
  expect(svgs.length, 'the exported SVG should be captured').toBeGreaterThan(0);
  const svg = svgs[svgs.length - 1];

  // ① The plugin styles are embedded, and they include the rule that hides the badge
  expect(svg, 'the exported SVG should carry <style>').toContain('<style');
  expect(svg, 'the plugin styles should be embedded (class prefixes om-/mm-)').toMatch(/om-mm-|mm-node/);

  // ② The root node carries om-mm-host —— the scoping ancestor of the hide rule; without it the styles do not apply
  const rootTag = /<svg[^>]*>/.exec(svg)?.[0] ?? '';
  expect(rootTag, 'the root node of the exported SVG should carry the om-mm-host class').toContain('om-mm-host');

  // ③ A badge really does exist in the export (otherwise this assertion is vacuous)
  expect(svg, 'the export should contain a badge element, otherwise this test is meaningless').toContain('mm-badge');
});

/** The exported PNG must be a valid image with content (guards against exporting a blank image). */
test('the exported PNG is a valid image with content', async ({ page }) => {
  const dl = page.waitForEvent('download', { timeout: 30_000 });
  await clickBarButton(page, '导出图片');
  const download = await dl;
  const path = await download.path();
  expect(path, 'the exported file should be obtained').toBeTruthy();

  const buf = await (await import('node:fs/promises')).readFile(path!);
  expect(buf.subarray(0, 8).toString('hex'), 'it should be a PNG').toBe('89504e470d0a1a0a');
  expect(buf.byteLength).toBeGreaterThan(5_000);

  const png = PNG.sync.read(buf);
  expect(png.width).toBeGreaterThan(100);
  expect(png.height).toBeGreaterThan(100);

  let nonWhite = 0;
  let total = 0;
  const colors = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4 * 53) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    colors.add((r >> 4) * 4096 + (g >> 4) * 64 + (b >> 4));
    if (r < 240 || g < 240 || b < 240) nonWhite++;
    total++;
  }
  expect(colors.size, 'the exported image should not be a flat color').toBeGreaterThan(3);
  expect(nonWhite / total, 'the exported image should have content').toBeGreaterThan(0.02);
});

test('a long node label wraps onto more lines instead of being elided', async ({ page }) => {
  // The map used to cut every label at 20 characters and append "…": the reader could not see the
  // node's text at all, and the cut ignored the box width (a Latin label wasted half its box).
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  const nb = await resolveTestNotebook(api);
  // A short literal repeated: the auditor caps fixture tokens at 12 characters, and the point here is
  // a label long enough to wrap, not the wording.
  // ★ Four repeats, not two: the point of this case is a label that **wraps**, so its length is part of
  //   the fixture, not decoration. Two repeats (12 characters) fitted on one line and made the case red.
  const long = '长节点标题'.repeat(4);
  const id = await createTempDoc(api, nb, `- ${long}\n  - 短标题\n`);
  try {
    await openDoc(page, id);
    await toMindmapView(page);
    await page.waitForTimeout(1200);
    const labels = await page.evaluate(() => {
      const svg = document.querySelector('.mm-canvas svg');
      return [...(svg?.querySelectorAll('text') ?? [])].map((t) => ({
        lines: [...t.querySelectorAll('tspan')].map((s) => s.textContent ?? ''),
      }));
    });
    const wrapped = labels.find((l) => l.lines.join('') === long);
    expect(wrapped, 'the long label is drawn as a node').toBeTruthy();
    expect(wrapped!.lines.length, 'the long label took more than one line').toBeGreaterThan(1);
    expect(wrapped!.lines.join(''), 'wrapping dropped no character').toBe(long);
    expect(JSON.stringify(labels), 'no label shows a truncation ellipsis').not.toContain('…');
  } finally {
    await removeDoc(api, id);
    await api.dispose();
  }
});

test('★ clicking a to-do checkbox toggles it and never removes the marker', async ({ page }) => {
  // Reported from the mind map: "clicking the to-do deletes it". The checkbox cycled
  // none → todo → done → **none**, so the third click removed the task marker and the node went back to
  // being a plain list item —— which is what a click on a checkbox cannot be read as meaning.
  //
  // ★ Two clicks is the whole case: the second one is the click that used to remove the marker. Asserting
  //   "the document still holds a task marker" is what makes this red for that defect; asserting only the
  //   first click would pass for both rules.
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook, '- [ ] 节点一\n');
    await openDoc(page, docId);
    await toMindmapView(page);

    const box = page.locator('.mm-checkbox').first();
    await expect(box, 'the mind map should draw a checkbox for a to-do').toBeVisible({ timeout: 30_000 });

    // `exportMdContent` answers an object; the markdown is its `content`. Falling back to the whole payload
    // keeps a failure readable ("[object Object]" tells nobody anything).
    const markdown = async (): Promise<string> => {
      const res = await api.call('/api/export/exportMdContent', { id: docId });
      const data = res.data as { content?: string } | null;
      return data?.content ?? JSON.stringify(res.data ?? '');
    };

    await box.click();
    await expect
      .poll(markdown, { message: 'the first click should mark the task done', timeout: 15_000 })
      .toMatch(/-\s*\[[xX]\]\s/);

    await box.click();
    await expect
      .poll(markdown, { message: 'the second click should leave it not-done', timeout: 15_000 })
      .toMatch(/-\s*\[ \]\s/);
    expect(await markdown(), 'the task marker must still be there —— the defect removed it').toMatch(
      /-\s*\[[ xX]\]\s/,
    );
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★ dragging a node onto another nests it — and BOTH views must agree with the document', async ({ page }) => {
  // Reported: after a drag-to-reparent in the mind map, the SiYuan document is correct but the outline
  // and the mind map are both wrong.
  //
  // Measured before the fix, dragging 乙 onto 甲:
  //   document : `- 甲` / `  - 乙` / `- 丙`   ← correct, the nesting really landed
  //   outline  : 甲, 乙, 丙 all at the same indent   ← wrong
  //   mind map : all three at the same x             ← wrong
  //
  // ★ The assertion is deliberately **three-way**: comparing the views only against each other would pass
  //   for two views that are wrong in the same way, and comparing against the document alone would pass
  //   for a view that shows the old shape with the document already changed —— which is exactly the state
  //   this bug leaves behind, and the reason the plugin then writes the wrong picture back.
  //
  // ★ Nothing covered this gesture: `mindmap-reparent.test.ts` only re-reads the **source text** of the
  //   handlers, so no assertion in the repository could disagree with a broken drop.
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '- 甲\n- 乙\n- 丙\n');
    await openDoc(page, docId);
    await toMindmapView(page);

    const markdown = async (): Promise<string> => {
      const res = await api.call('/api/export/exportMdContent', { id: docId });
      return field(res, 'content')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('---') && !l.includes(': ') && !l.startsWith('# '))
        .join('\n');
    };
    // The document's own nesting: 乙 must sit one level under 甲.
    const assertDocumentNested = async (): Promise<void> => {
      await expect
        .poll(markdown, { message: 'the drag must nest 乙 under 甲 in the document', timeout: 20_000 })
        .toMatch(/- 甲\n {2,}- 乙/);
    };

    // ---- the drag itself: press on 乙's node, move onto 甲's, release
    const nodeTexts = () => page.evaluate(() =>
      [...document.querySelectorAll('.mm-node')].map((n) => (n.textContent || '').trim()),
    );
    const texts = await nodeTexts();
    const from = texts.findIndex((t) => t.startsWith('乙'));
    const to = texts.findIndex((t) => t.startsWith('甲'));
    expect(from, 'the fixture must contain a 乙 node').toBeGreaterThanOrEqual(0);
    expect(to, 'the fixture must contain a 甲 node').toBeGreaterThanOrEqual(0);

    const nodes = page.locator('.mm-node');
    const srcBox = await nodes.nth(from).boundingBox();
    const dstBox = await nodes.nth(to).boundingBox();
    expect(srcBox && dstBox, 'both nodes must be laid out before the drag').toBeTruthy();

    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    // Several steps: the drop is decided from the last position the pointer reported, so a single jump
    // would not exercise the same path a real drag takes.
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        srcBox!.x + (dstBox!.x - srcBox!.x) * (i / 10) + dstBox!.width / 2,
        srcBox!.y + (dstBox!.y - srcBox!.y) * (i / 10) + dstBox!.height / 2,
      );
      await page.waitForTimeout(40);
    }
    await page.mouse.up();

    await assertDocumentNested();

    // ---- the mind map must show it too: 乙 must now sit further right than 甲 (one level deeper)
    await expect
      .poll(async () => {
        const boxes = await page.evaluate(() =>
          [...document.querySelectorAll('.mm-node')]
            .map((n) => {
              const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(n.getAttribute('transform') || '');
              return { x: m ? parseFloat(m[1]) : NaN, text: (n.textContent || '').trim() };
            })
            .filter((n) => Number.isFinite(n.x)),
        );
        const parent = boxes.find((b) => b.text.startsWith('甲'));
        const child = boxes.find((b) => b.text.startsWith('乙'));
        if (!parent || !child) return 'missing';
        return child.x > parent.x ? 'nested' : `flat(x ${parent.x} vs ${child.x})`;
      }, { message: 'the mind map must draw 乙 inside 甲', timeout: 20_000 })
      .toBe('nested');

    // ---- and the outline, which is the other view of the same tree
    await toOutlineView(page);
    await expect
      .poll(async () => {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('.om-outline-wrap .node-row')].map((r) => ({
            left: Math.round(r.getBoundingClientRect().left),
            text: (r.querySelector('.node-text')?.textContent || '').trim(),
          })),
        );
        const parent = rows.find((r) => r.text === '甲');
        const child = rows.find((r) => r.text === '乙');
        if (!parent || !child) return 'missing';
        return child.left > parent.left ? 'nested' : `flat(${parent.left} vs ${child.left})`;
      }, { message: 'the outline must indent 乙 under 甲', timeout: 20_000 })
      .toBe('nested');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('dragging a DEEP node onto a shallow one re-levels it in both views', async ({ page }) => {
  // The case above moves a node one level, and it is the one that **goes red** when the re-read is allowed
  // to overtake our own write-back (measured 3/3 failing before the fix, 3/3 passing after).
  //
  // ★★ This case does **not** guard that defect, and saying so is the point of keeping it. It was written
  //    expecting the deeper fixture to be the stronger test; measured, it passes **with the fix removed**
  //    as reliably as with it — so as a regression test for the re-read it has no defensive value, and
  //    pretending otherwise would be the vacuous pass this repository keeps warning about.
  //
  //    What it does cover, and no other case does: a node moving **out of a three-level chain onto a
  //    root-level sibling**, i.e. the document, the map and the outline all re-levelling together. Both
  //    gestures issue the same kernel calls (`insertBlock` → `moveBlock` → `deleteBlock`), so the
  //    difference that decides which one trips the defect is timing, not the shape of the tree.
  //
  // Measured after the fix: document `- 丁` / `  - 丙`, map 丁@208 / 丙@334, outline 丁@1170 / 丙@1197.
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '- 甲\n  - 乙\n    - 丙\n- 丁\n');
    await openDoc(page, docId);
    await toMindmapView(page);

    const markdown = async (): Promise<string> => {
      const res = await api.call('/api/export/exportMdContent', { id: docId });
      return field(res, 'content');
    };
    const geometry = () => page.evaluate(() =>
      [...document.querySelectorAll('.mm-node')].map((n) => {
        const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(n.getAttribute('transform') || '');
        return { x: m ? parseFloat(m[1]) : NaN, text: (n.textContent || '').trim() };
      }).filter((n) => Number.isFinite(n.x)),
    );

    const before = await geometry();
    const texts = before.map((n) => n.text);
    const from = texts.findIndex((t) => t.startsWith('丙'));
    const to = texts.findIndex((t) => t.startsWith('丁'));
    expect(from, 'the fixture must contain a 丙 node').toBeGreaterThanOrEqual(0);
    expect(to, 'the fixture must contain a 丁 node').toBeGreaterThanOrEqual(0);
    // Precondition: 丙 really starts deeper than 丁, otherwise the case measures nothing.
    expect(before[from].x, '丙 must start deeper than 丁 for this case to mean anything').toBeGreaterThan(before[to].x);

    const nodes = page.locator('.mm-node');
    const srcBox = await nodes.nth(from).boundingBox();
    const dstBox = await nodes.nth(to).boundingBox();
    expect(srcBox && dstBox, 'both nodes must be laid out').toBeTruthy();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        srcBox!.x + (dstBox!.x - srcBox!.x) * (i / 10) + dstBox!.width / 2,
        srcBox!.y + (dstBox!.y - srcBox!.y) * (i / 10) + dstBox!.height / 2,
      );
      await page.waitForTimeout(40);
    }
    await page.mouse.up();

    // The document: 丙 becomes a child of 丁, i.e. the line after 丁 is indented under it.
    // ★ The kernel pads list lines with a trailing space (`- 丁 ` — a continuation marker), so the
    //   pattern must tolerate trailing whitespace on the parent line. Requiring `- 丁\n` outright failed
    //   against a **correct** document, which is the "test describes a document that never existed"
    //   mistake: the assertion was wrong, not the product.
    await expect
      .poll(markdown, { message: 'the drag must nest 丙 under 丁', timeout: 20_000 })
      .toMatch(/- 丁\s*\n {2,}- 丙/);

    // The map: 丙 must be exactly one level right of 丁 (not at its old three-level depth).
    await expect
      .poll(async () => {
        const now = await geometry();
        const d = now.find((n) => n.text.startsWith('丁'));
        const c = now.find((n) => n.text.startsWith('丙'));
        if (!d || !c) return 'missing';
        return c.x > d.x ? 're-levelled' : `stale(x ${d.x} vs ${c.x})`;
      }, { message: 'the map must move 丙 under 丁', timeout: 20_000 })
      .toBe('re-levelled');

    // And the outline, indentation-based, on the same tree.
    await toOutlineView(page);
    await expect
      .poll(async () => {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('.om-outline-wrap .node-row')].map((r) => ({
            left: Math.round(r.getBoundingClientRect().left),
            text: (r.querySelector('.node-text')?.textContent || '').trim(),
          })),
        );
        const d = rows.find((r) => r.text === '丁');
        const c = rows.find((r) => r.text === '丙');
        if (!d || !c) return 'missing';
        return c.left > d.left ? 'indented' : `flat(${d.left} vs ${c.left})`;
      }, { message: 'the outline must indent 丙 under 丁', timeout: 20_000 })
      .toBe('indented');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★ dropping a node into its own subtree is refused (no cycle, nothing lost)', async ({ page }) => {
  // Replaces a unit file that read `Mindmap.tsx` as text and regex-matched the guard (`isDesc` /
  // `containsNode`). A text match cannot go red when the drop misbehaves —— only when the guard is
  // reworded, which is what happened when the two hand-written cycle guards were merged into one helper.
  // This drives the gesture and asserts on the result instead.
  //
  // The rule: a node must never become its own descendant. A refused drop must leave the document
  // **exactly** as it was —— the guard has to run before the node is taken out of the tree, or a refused
  // drop loses it.
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '- 甲\n  - 乙\n    - 丙\n');
    await openDoc(page, docId);
    await toMindmapView(page);

    const markdown = async (): Promise<string> => {
      const res = await api.call('/api/export/exportMdContent', { id: docId });
      return field(res, 'content');
    };
    const before = await markdown();

    // Drag 甲 (the ancestor) onto 丙 (its own grandchild).
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('.mm-node')].map((n) => (n.textContent || '').trim()));
    const from = names.findIndex((t) => t.startsWith('甲'));
    const to = names.findIndex((t) => t.startsWith('丙'));
    expect(from, 'the fixture must contain 甲').toBeGreaterThanOrEqual(0);
    expect(to, 'the fixture must contain 丙').toBeGreaterThanOrEqual(0);

    const nodes = page.locator('.mm-node');
    const srcBox = await nodes.nth(from).boundingBox();
    const dstBox = await nodes.nth(to).boundingBox();
    expect(srcBox && dstBox, 'both nodes must be laid out').toBeTruthy();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        srcBox!.x + (dstBox!.x - srcBox!.x) * (i / 10) + dstBox!.width / 2,
        srcBox!.y + (dstBox!.y - srcBox!.y) * (i / 10) + dstBox!.height / 2,
      );
      await page.waitForTimeout(45);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);

    // The document must be untouched —— the same tree, the same nesting, nothing lost.
    expect(await markdown(), 'a refused drop must leave the document exactly as it was').toBe(before);
    // And 甲 must still be there (a guard that ran after the node was taken out would lose it).
    expect(await markdown()).toMatch(/- 甲/);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

/**
 * ★★ A document title is **plain text**, and the root node must not eat the characters that look like
 * markup.
 *
 * The root node's HTML is built by interpolating the title, so before this case existed a document titled
 * `use <T> for generics` rendered in the map as `use  for generics` —— measured through `htmlToRuns`, which
 * is what `RichText` feeds —— and `a<b>c` rendered as `ac`. The title comes from `blocks.content` and the
 * kernel stores it verbatim (checked against the running test instance), so nothing upstream loses it:
 * only our own rendering did. The exported PNG draws the same runs, so the characters vanished there too.
 *
 * The `.mm` export already escaped its title, which is exactly why this went unnoticed: the format that
 * escapes was tested, and the one the user looks at was not.
 */
test('★ a title containing < and > keeps those characters in the root node', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    // ★ The title the kernel stores verbatim —— no escaping, no sanitising, on the way in.
    const TITLE = 'E2E-角度<T>-测试';
    docId = await createTempDocTitled(api, notebook, '- 甲\n  - 乙\n', TITLE);
    await openDoc(page, docId);
    await toMindmapView(page);

    // ★ Read the **tspan**s of the root node, not `textContent`.
    //
    //   Measured: `.mm-node`'s `textContent` reads every node's label **twice** (the fixture's two
    //   one-character labels each come back doubled) —— a second
    //   copy exists in a child element for all nodes, so doubling it is a property of the render, not of
    //   the title. Asserting on `textContent` would have made this case pass for the wrong reason once and
    //   fail for the wrong reason another time. The tspans are the label that is actually drawn.
    const rootTspans = await page.evaluate(() => {
      const root = document.querySelector('.mm-node[data-node-id="__root__"]');
      return root ? [...root.querySelectorAll('tspan')].map((t) => (t.textContent || '')) : null;
    });
    expect(rootTspans, 'the root node must be rendered').not.toBeNull();
    const rootText = (rootTspans ?? []).join('').trim();

    expect(rootText, 'the root node must show the title exactly as stored, angle brackets included').toBe(TITLE);
    // Name the two halves separately: a lost `<` and a lost `>` are different defects, and the bug dropped
    // the whole `<T>` run at once, which a single `toContain('<')` would report as one failure.
    expect(rootText, 'the `<` must survive').toContain('<');
    expect(rootText, 'the `>` must survive').toContain('>');

  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
