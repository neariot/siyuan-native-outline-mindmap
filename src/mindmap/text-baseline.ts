/**
 * Vertical centering of SVG text.
 *
 * ## Why not `dominant-baseline="central"`
 *
 * That attribute behaves correctly in Chromium, but in Safari (especially iOS) it is ignored or
 * computed from the font's ascent/descent rather than from the glyph's actual ink;
 * it has been open in the WebKit tracker since 2008:
 *
 *   https://bugs.webkit.org/show_bug.cgi?id=6424
 *   `<text>`, `<tspan>` dominant-baseline attribute is not respected
 *
 * The consequence is most visible on Chinese nodes —— the ascent of CJK fonts in SiYuan's UI font stack is far larger than
 * that of Latin ones, so centering by ascent/descent pushes the text up as a whole, looking "placed high".
 * The same page looks aligned in desktop Chromium, so a desktop screenshot alone will not reveal it.
 *
 * ## Approach
 *
 * Instead of relying on the browser's baseline keywords, compute the offset as `dy` ourselves:
 *
 *   - Latin font ink sits roughly below the middle of a line, and empirical values such as `0.5em - 0.5*capHeight`
 *     are unreliable;
 *   - What is more robust is the position of the **ink midpoint** relative to the baseline. The ink of CJK characters approximately
 *     fills the lower to upper edge of the em, and the measured midpoint is about `0.36em` above the baseline (under SiYuan's font stack).
 *
 * Because node height is set from `fontSize`, what is given here is a **ratio relative to fontSize**,
 * so changing the font size scales it automatically.
 */

/**
 * For mixed CJK/Latin text, the distance of the ink midpoint above the baseline (unit: em, positive means above the baseline).
 *
 * Basis for the values: measured (Chromium + SiYuan font stack); at 100px the ink of a CJK sample string
 * spans 0.85em above the baseline to 0.08em below it, with the midpoint 0.385em above the baseline.
 * At 14px the same ratio holds (0.393em, slightly off due to quantization error).
 */
const INK_MID_ABOVE_BASELINE = 0.385;

/**
 * Returns the `dy` needed to center the text vertically (the offset relative to the passed-in `y`).
 *
 * @param fontSize font size (px)
 * @param boxHeight height of the containing node box (px) —— no offset when non-positive
 */
export function centerBaselineDy(fontSize: number, boxHeight: number): number {
  if (!(fontSize > 0) || !(boxHeight > 0)) return 0;
  return INK_MID_ABOVE_BASELINE * fontSize;
}
