/**
 * The unified tooltip attributes.
 *
 * ## Background: SiYuan has two mechanisms, each with its own trade-offs
 *
 * SiYuan's icon tooltips go through `app/src/dialog/tooltip.ts`: a `mouseover`
 * delegate on `document` that selects `.ariaLabel` elements, reads their
 * `aria-label` attribute, and renders `<div id="tooltip">`. Compared with the browser's native `title`:
 *
 *   - the delay is SiYuan's (150ms animation + 300ms delay), not the browser's ~1s;
 *   - the style follows the theme and HTML is supported (keyboard shortcuts, secondary notes);
 *   - `data-position` controls the popup direction and flips automatically to stay inside the viewport.
 *
 * But it has one hard limit:
 *
 *     export const showTooltip = (...) => {
 *         if (isMobile() || !message) return;   // never shown on mobile
 *     };
 *
 * So **you must not write `aria-label` alone** —— that would turn mobile from
 * "a hint on long press" into "no hint at all", which is a regression.
 *
 * ## Approach: provide both
 *
 * Attach both to the same element:
 *
 *   - `class="... ariaLabel"` + `aria-label` -> the desktop bubble comes from SiYuan;
 *   - `title` -> mobile still shows the native hint on long press.
 *
 * On desktop, when both are present, SiYuan's bubble covers the native `title` (a mouse
 * move in fires `mouseover` at once, while the native tooltip needs a longer hover), so what you see is SiYuan's style.
 */

/** The positions SiYuan tooltips support. One-to-one with the parsing branches in `dialog/tooltip.ts`. */
export type TooltipPosition =
  /** Centered above. Most common for icon buttons, and SiYuan's default. */
  | 'north'
  /** Centered below. */
  | 'south'
  /** Left side. Suits elements that hug the left edge. */
  | 'west'
  /** Right side. */
  | 'east'
  /** Right of the **parent element** (the kind SiYuan's file tree / outline uses). */
  | 'parentE'
  /** Left of the **parent element**. */
  | 'parentW';

export interface TooltipAttrs {
  className: string;
  'aria-label': string;
  title: string;
  'data-position'?: string;
}

/**
 * Builds the tooltip attribute set; just spread it onto the element.
 *
 * ```tsx
 * <button type="button" {...tooltip('Toggle color theme', baseClass, 'north')}>
 * ```
 *
 * @param text The hint text. It goes into `aria-label` verbatim; HTML is allowed (e.g. `<span class='ft__on-surface'>`).
 * @param baseClass The element's existing class (optional). `ariaLabel` is appended, not overwritten.
 * @param position The popup direction, default `north` (above an icon button).
 */
export function tooltip(
  text: string,
  baseClass = '',
  position: TooltipPosition = 'north',
): TooltipAttrs {
  // With empty text do not attach aria-label —— SiYuan returns at once on
  // an empty string, but keeping the `ariaLabel` class still costs a wasted closest() lookup.
  if (!text) {
    return { className: baseClass, 'aria-label': '', title: '' };
  }
  const cls = baseClass ? `${baseClass} ariaLabel` : 'ariaLabel';
  return {
    className: cls,
    'aria-label': text,
    // Mobile fallback: SiYuan shows no bubble on mobile, so rely on the native title.
    title: text,
    'data-position': position,
  };
}

/**
 * Appends one line of secondary explanation (small gray text) to existing text.
 *
 * Mirrors SiYuan's own usage:
 *
 *     aria-label="Click <span class='ft__on-surface'>Open menu</span>"
 *
 * The native `title` does not support HTML and shows the angle brackets verbatim, so this is only for `aria-label`.
 */
export function tooltipWithHint(main: string, hint: string): string {
  if (!hint) return main;
  return `${main} <span class='ft__on-surface'>${hint}</span>`;
}
