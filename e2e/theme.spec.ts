import { test, expect, type Page } from './fixtures';
import { siyuanUrl, siyuanToken } from './env';
import { kernelApi, resolveTestNotebook, createTempDoc, removeDoc, TEMP_DOC_MD } from './testdoc';
import { openDoc, toMindmapView } from './mindmap';
import { ensureOutlineReady, clickArrow } from './outline';
import { useTheme, restoreTheme, readTheme, MODE_FOLLOW_SYSTEM } from './themes';

/**
 * Theme-dependent rendering, measured against a **really switched** theme.
 *
 * ## Why these cases exist
 *
 * `src/styles.css` keys its dark-mode values off `html[data-theme-mode='dark']`. A rule written
 * that way can be **silently dead** —— and was: four rules for the collapsed bullet sat behind
 * `[data-theme='dark']`, an attribute SiYuan never writes, so dark mode kept using the light
 * colours and nothing ever went red. See `e2e/themes.ts` for the two traps that make this hard
 * to notice. The guard is the engine check below —— a lint that recognises only the shapes
 * someone thought of would be a second, weaker criterion for the same defect.
 *
 * The offline guard catches the selector; these cases catch the *rendering*: whether the theme
 * being asked for is the theme being drawn, and whether the result is actually visible.
 *
 * Run only these:  python3 scripts/run-e2e.py theme
 */

/** Relative luminance of an `rgb(...)` string; used to compare two theme values, not to judge taste. */
function luma(rgb: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) throw new Error(`not an rgb colour: ${rgb}`);
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Every selector in the **plugin's own** injected stylesheet that is conditional on the theme.
 *
 * The sheet is found by its scoping class (`om-mm-host`, added by the build to every selector), not
 * by file name, and the selectors are read out of the CSSOM —— the browser's own parsed model.
 * Nothing here reads CSS as text.
 *
 * ★ Grouping rules are walked **recursively** (`@media` / `@supports` / `@container` / `@layer`).
 *   The first version read only `sheet.cssRules`' top level and mapped `selectorText` over it, so a
 *   theme-conditional rule nested in an at-rule was invisible while the case's own comment claimed it
 *   checked every one of them. That was latent —— all of them are top level today —— but a latent
 *   "cannot see it" in a check that says "every" is a check that will pass on the defect it names.
 *   `CSSGroupingRule` is the CSSOM interface for at-rules that contain rules; matching on it covers
 *   any grouping rule the browser knows, including ones that do not exist yet.
 */
async function pluginThemeSelectors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // ★ Every rule's own selector is collected, then its children are walked —— **not** an
    //   either/or. In current Chromium a `CSSStyleRule` also has a `cssRules` member (CSS Nesting),
    //   so "if it has cssRules, recurse and continue" treated every ordinary style rule as a grouping
    //   rule and collected nothing at all: the guard reported "the plugin stylesheet has no
    //   theme-conditional rules at all" on a sheet full of them. Collecting first and recursing second
    //   is correct for both shapes.
    const walk = (rules: CSSRule[], out: string[]): string[] => {
      for (const r of rules) {
        const sel = (r as CSSStyleRule).selectorText;
        if (sel) out.push(sel);
        const nested = (r as CSSGroupingRule).cssRules;
        if (nested) walk([...nested], out);
      }
      return out;
    };

    return [...document.styleSheets].flatMap((sheet) => {
      let rules: CSSRule[];
      try {
        rules = [...sheet.cssRules];
      } catch {
        return []; // a cross-origin sheet cannot be read; not ours
      }
      const all = walk(rules, []);
      // Ownership is decided by the build's scoping class, at any depth.
      if (!all.some((sel) => sel.includes('om-mm-host'))) return [];
      return all.filter((sel) => sel.includes('data-theme'));
    });
  });
}

/** For each selector, the CSS engine's answer to "can this match anything here right now?" */
async function matchCounts(page: Page, selectors: string[]): Promise<Record<string, number>> {
  return page.evaluate((sels: string[]) => {
    const out: Record<string, number> = {};
    for (const sel of sels) {
      try {
        out[sel] = document.querySelectorAll(sel).length;
      } catch {
        out[sel] = -1; // the engine refused the selector; not judged here
      }
    }
    return out;
  }, selectors);
}

/** The collapsed node's concentric dot: an 18px halo (`.bullet-border`) around a 6px centre (`.bullet-dot`). */
async function bulletColors(page: import('@playwright/test').Page): Promise<{ halo: string; dot: string }> {
  return page.evaluate(() => {
    const row = document.querySelector('.node-row.collapsed');
    if (!row) throw new Error('no collapsed node row —— the case must collapse one first');
    const bg = (sel: string): string => {
      const el = row.querySelector(sel);
      if (!el) throw new Error(`missing ${sel} in the collapsed row`);
      return getComputedStyle(el).backgroundColor;
    };
    return { halo: bg('.bullet-border'), dot: bg('.bullet-dot') };
  });
}

test.describe('theme rendering', () => {
  test.afterEach(async ({ page }) => {
    await restoreTheme(page, 'light');
  });

  test('SiYuan writes the theme attribute on <html>, and asking for a mode really moves the palette', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // ① The contract the stylesheet depends on. If SiYuan ever moves this attribute, every
    //    `html[data-theme-mode='dark']` rule in the plugin goes dead at once —— say so here.
    const asLoaded = await readTheme(page);
    expect(
      asLoaded.themeMode,
      '<html data-theme-mode> is missing —— the plugin\'s dark-mode selectors would all be dead',
    ).toMatch(/^(light|dark)$/);
    expect(
      asLoaded.bodyThemeMode,
      'SiYuan now writes data-theme-mode on <body> too; the stylesheet keys off <html> only',
    ).toBeNull();

    // ② `appearance.modeOS` overrides `appearance.mode`: with "follow the system" on, the OS
    //    preference wins (headless Chromium reports light), and a request for dark changes nothing.
    const dark = await useTheme(page, 'dark');
    expect(dark.painted, 'dark mode must not be the light palette').not.toBe(asLoaded.painted);

    const light = await useTheme(page, 'light');
    expect(light.painted, 'switching back must restore the light palette').toBe(asLoaded.painted);

    // ③ The trap itself, stated so a future edit to the helper cannot quietly reintroduce it.
    expect(MODE_FOLLOW_SYSTEM, 'mode 2 means "follow the system", not "dark"').toBe(2);
  });

  test('every theme-conditional rule in the shipped stylesheet can match somewhere', async ({ page }) => {
    // ★ The engine's verdict, and the only authority on "can this selector match?". A rule keyed off
    //   an attribute SiYuan never writes matches **nothing, ever** —— that is what "silently dead"
    //   means, and only the browser can say so for every shape at once.
    //
    // ★ Sampling matters: "matches nothing right now" is not the same as "dead", a rule for an
    //   element that is not on screen yet simply has nothing to match. So sample both themes in
    //   **both views** (outline with a collapsed node, and the mindmap canvas) and only call a rule
    //   dead when it matched nothing anywhere. Add a view or a state here when you add theme rules
    //   that need it, or this case will report them dead.
    // ★ Navigate first: a fresh test gets a blank page, and a theme switch needs a booted SiYuan.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const api = await kernelApi(siyuanUrl(), siyuanToken());
    const notebook = await resolveTestNotebook(api);
    const docId = await createTempDoc(api, notebook, TEMP_DOC_MD);
    try {
      const hits: Record<string, number>[] = [];

      // ★ The document is opened **once**. A live theme switch leaves the DOM alone, so the four
      //   samples below cost a couple of seconds each instead of re-opening and re-rendering the
      //   document four times (measured: re-opening dominates, ~10s per round).
      await useTheme(page, 'light');
      await openDoc(page, docId);
      await ensureOutlineReady(page);
      // The theme rules for the bullet only have something to match while a branch is collapsed.
      await clickArrow(page, 0);
      await expect(page.locator('.node-row.collapsed')).toHaveCount(1);

      const themeSelectors = await pluginThemeSelectors(page);
      expect(themeSelectors.length, 'the plugin stylesheet has no theme-conditional rules at all').toBeGreaterThan(0);

      hits.push(await matchCounts(page, themeSelectors)); // light, outline
      await useTheme(page, 'dark');
      hits.push(await matchCounts(page, themeSelectors)); // dark, outline
      await toMindmapView(page);
      hits.push(await matchCounts(page, themeSelectors)); // dark, mindmap
      await useTheme(page, 'light');
      hits.push(await matchCounts(page, themeSelectors)); // light, mindmap

      const dead = themeSelectors.filter((sel) =>
        hits.every((h) => {
          const n = h[sel] ?? 0;
          return n === 0 || n === -1; // `-1` = the engine refused the selector; not judged here
        }),
      );
      expect(
        dead,
        `these theme-conditional rules matched nothing in any sample (${hits.length} taken: both themes x both views), ` +
          `so they are dead: ${dead.join(' | ')}`,
      ).toEqual([]);
    } finally {
      await removeDoc(api, docId);
    }
  });

  test('the collapsed bullet inverts with the theme and stays visible in both', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const api = await kernelApi(siyuanUrl(), siyuanToken());
    const notebook = await resolveTestNotebook(api);
    const docId = await createTempDoc(api, notebook, TEMP_DOC_MD);
    try {
      await useTheme(page, 'light');
      await openDoc(page, docId);
      await ensureOutlineReady(page);
      await clickArrow(page, 0);
      // Collapsed once, sampled in both themes: the DOM survives a live theme switch.
      await expect(page.locator('.node-row.collapsed')).toHaveCount(1);

      const light = await bulletColors(page);
      const lightBg = (await readTheme(page)).painted;

      await useTheme(page, 'dark');
      await expect(page.locator('.node-row.collapsed')).toHaveCount(1);

      const dark = await bulletColors(page);
      const darkBg = (await readTheme(page)).painted;

      // ★ The regression itself. Before the selector was fixed, `dark` came back **identical to
      //   `light`** (halo rgb(222,224,227) / dot rgb(71,73,75)) because the dark rules never matched,
      //   while the page around them was genuinely dark.
      expect(dark.halo, 'the dark rule for the halo never applied —— light and dark are the same colour').not.toBe(light.halo);
      expect(dark.dot, 'the dark rule for the dot never applied').not.toBe(light.dot);

      // The indicator is a light halo around a dark centre in light mode, and the reverse in dark
      // mode. Asserting the inversion (not the hex values) keeps the design free to change.
      expect(luma(light.halo), 'in light mode the halo must be lighter than the centre').toBeGreaterThan(luma(light.dot));
      expect(luma(dark.halo), 'in dark mode the halo must be darker than the centre').toBeLessThan(luma(dark.dot));

      // …and visible in both: an indicator that matches its background is as good as missing.
      const MIN_CONTRAST = 10;
      expect(
        Math.abs(luma(light.halo) - luma(lightBg)),
        `the light halo ${light.halo} does not stand out from the page ${lightBg}`,
      ).toBeGreaterThan(MIN_CONTRAST);
      expect(
        Math.abs(luma(dark.halo) - luma(darkBg)),
        `the dark halo ${dark.halo} does not stand out from the page ${darkBg}`,
      ).toBeGreaterThan(MIN_CONTRAST);
    } finally {
      await removeDoc(api, docId);
    }
  });
});
