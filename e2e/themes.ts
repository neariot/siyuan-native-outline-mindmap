import { expect, type Page } from '@playwright/test';
import { siyuanUrl, siyuanToken } from './env';

/**
 * Really switch SiYuan's theme on the isolated instance, so theme-dependent styles can be measured.
 *
 * ## Why this file exists (measured over several rounds)
 *
 * Testing anything that depends on the theme ("in dark mode the colour is X") looks trivial and is not.
 * Two traps both produce a **green** result while nothing about dark mode was ever exercised:
 *
 * ① **`appearance.modeOS` overrides `appearance.mode`.**
 *    The first attempt posted `{...appearance, mode: 2}` and the kernel answered `code:0` with
 *    `data.mode === 1` — success on the wire, no change on screen. SiYuan's config carries
 *    `modeOS` ("follow the system theme"), which was `true` here, so the effective theme came from
 *    `prefers-color-scheme`. Headless Chromium reports **light**, so every run stayed light.
 *    Measured: `mode: 1` alone → after reload `data-theme-mode` was still `"light"`.
 *    It only became dark with `{modeOS: false, mode: 1}`.
 *
 * ② **Setting the attribute yourself is not a theme switch.**
 *    `document.documentElement.setAttribute('data-theme-mode', 'dark')` does make
 *    `html[data-theme-mode='dark']` match —— that is enough to test a *selector*, and it is exactly
 *    how a screenshot taken that way misleads you: SiYuan's palette comes from its own CSS variables,
 *    which the attribute alone does not touch, so the surrounding UI **stays light** and the picture
 *    shows a light page with a dark-mode colour inside it. Judge dark mode only after a real switch.
 *
 * ## The contract this relies on
 *
 * SiYuan writes `data-theme-mode` (plus `data-light-theme` / `data-dark-theme`) on **`<html>`** and
 * nothing on `<body>` —— verified by reading the live DOM, and by the shipped bundle using
 * `data-theme-mode` 37 times and `data-theme=` never. `html[data-theme-mode='dark']` is therefore the
 * only correct selector form; `[data-theme='dark']` matches nothing and is silently dead
 * The guard lives in `e2e/theme.spec.ts`: it asks the CSS engine whether every theme-conditional
 * rule in the shipped stylesheet can match at all.
 *
 * ## Usage
 *
 *     python3 scripts/run-e2e.py theme          # the cases that use this helper
 */

/** `appearance.mode` values as the kernel defines them. */
export const MODE_LIGHT = 0;
export const MODE_DARK = 1;
/** `appearance.mode` value that defers to the OS theme —— the trap described above. */
export const MODE_FOLLOW_SYSTEM = 2;

export type ThemeMode = 'light' | 'dark';

const modeValue: Record<ThemeMode, number> = { light: MODE_LIGHT, dark: MODE_DARK };

/** What `<html>` carries, plus the palette variable SiYuan's own CSS keys off. */
export interface ThemeState {
  /** `data-theme-mode` on `<html>`; `null` when SiYuan stopped writing it. */
  themeMode: string | null;
  /** The same attribute on `<body>` —— expected to stay `null`, that is the point. */
  bodyThemeMode: string | null;
  /** The raw value of `--b3-theme-background` (a hex string, as CSS variables are). */
  background: string;
  /** The colour actually painted, as `rgb(...)` —— what a luminance comparison needs. */
  painted: string;
}

export async function readTheme(page: Page): Promise<ThemeState> {
  // ★ Never swallow this. An earlier version waited 30s and then returned `null` values, which made
  //   "the caller forgot to open SiYuan" look exactly like "SiYuan stopped writing the attribute" --
  //   the silent fallback of 5.1, inside the helper itself. Fail fast and name the precondition.
  const booted = await page
    .waitForFunction(() => document.documentElement.getAttribute('data-theme-mode') !== null, undefined, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!booted) {
    throw new Error(
      'no <html data-theme-mode> on this page —— open SiYuan (page.goto) before reading or switching the theme',
    );
  }
  return page.evaluate(() => {
    const el = document.documentElement;
    const transparent = 'rgba(0, 0, 0, 0)';
    return {
      themeMode: el.getAttribute('data-theme-mode'),
      bodyThemeMode: document.body.getAttribute('data-theme-mode'),
      background: getComputedStyle(el).getPropertyValue('--b3-theme-background').trim(),
      // The variable is a *declaration*; this is the result. `getComputedStyle` resolves it to rgb,
      // and falls back to <html> when <body> is left transparent (as some themes do).
      painted:
        [getComputedStyle(document.body).backgroundColor, getComputedStyle(el).backgroundColor].find(
          (c) => c && c !== transparent,
        ) ?? transparent,
    };
  });
}

/**
 * Switch the isolated instance to `mode` —— **live, with no reload** —— and wait until both the
 * attribute and the painted palette have moved.
 *
 * ★ Two things make it real, and both are required:
 *   - the request carries the **whole** appearance object with `modeOS:false`. With "follow the
 *     system" left on, `mode` is ignored and nothing moves;
 *   - the wait is for SiYuan's **own** front end to repaint (`data-theme-mode` is written by
 *     SiYuan, not by this helper), and the palette is compared before/after, so a silent no-op
 *     fails here instead of quietly poisoning whatever is measured next.
 *
 * ★ Why a live switch and not a reload: SiYuan's front end applies the appearance change itself
 *   (measured ~0.4s), which is also what a user does when they toggle the theme. Reloading costs a
 *   round of re-opening the document (measured ~10s), and re-opening is what makes a theme matrix
 *   slow. Because the DOM survives the switch, a caller can collapse a node **once** and sample
 *   every theme.
 *
 * Always pair it with `restoreTheme` (use `test.afterEach`): the instance is shared, and a theme
 * left behind by a failed case would change what every later case sees.
 */
export async function useTheme(page: Page, mode: ThemeMode): Promise<ThemeState> {
  const before = await readTheme(page);
  if (before.themeMode === mode) return before; // already there; do not touch a shared instance

  // The switch needs the app's own config object, and a caller may land here before SiYuan has
  // finished booting —— wait for it rather than making every caller open a document first.
  const ready = await page
    .waitForFunction(
      () => Boolean((window as unknown as { siyuan?: { config?: { appearance?: unknown } } }).siyuan?.config?.appearance),
      undefined,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    throw new Error('window.siyuan.config.appearance never appeared —— open SiYuan (page.goto) before switching the theme');
  }

  const answer = await page.evaluate(
    async ([target]) => {
      const app = (window as unknown as { siyuan: { config: { appearance: Record<string, unknown> } } }).siyuan;
      const res = await fetch('/api/setting/setAppearance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ★ `modeOS: false` is the whole point: with "follow the system" left on, `mode` is ignored.
        body: JSON.stringify({ ...app.config.appearance, modeOS: false, mode: target }),
      });
      return { status: res.status, code: (await res.json()).code };
    },
    [modeValue[mode]],
  );
  expect(answer.status, `setAppearance answered HTTP ${answer.status} —— the theme was never switched`).toBe(200);
  expect(answer.code, `setAppearance rejected the change (code ${answer.code})`).toBe(0);

  // Wait for SiYuan's own repaint, not for this helper's opinion of it.
  try {
    await page.waitForFunction(
      (wanted: string) => document.documentElement.getAttribute('data-theme-mode') === wanted,
      mode,
      { timeout: 15_000 },
    );
  } catch {
    const now = await readTheme(page);
    throw new Error(
      `asked for ${mode} and SiYuan left <html data-theme-mode> at ${JSON.stringify(now.themeMode)} —— ` +
        `setting the attribute by hand would produce a different failure mode, so this checks SiYuan's own value`,
    );
  }

  const after = await readTheme(page);
  expect(
    after.painted,
    `asked for ${mode} and <html> says so, but the page is still painted ${after.painted} (was ${before.painted}) ` +
      `—— the palette did not change, so nothing ${mode} is actually rendered`,
  ).not.toBe(before.painted);
  return after;
}

/** Put the instance back the way it was found. Safe to call when nothing was switched. */
export async function restoreTheme(page: Page, mode: ThemeMode = 'light'): Promise<void> {
  // A case that failed before navigating leaves a blank page; asking it to switch the theme would
  // only burn another timeout, and there is nothing to restore on a page that never loaded.
  const loaded = await page
    .evaluate(() => Boolean((window as unknown as { siyuan?: { config?: unknown } }).siyuan?.config))
    .catch(() => false);
  if (!loaded) return;
  await useTheme(page, mode);
}
