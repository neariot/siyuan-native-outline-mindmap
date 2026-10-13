/**
 * The auto-scroll decisions, as pure functions so they can be tested without a browser.
 *
 * ★ They live here rather than inline in `Outliner.tsx` because the first version of them was
 *   re-implemented inside the test that claimed to freeze them (`docs/pitfalls/mobile.md` §3.3), so every
 *   assertion compared a literal the test had just written with itself: no change to the product could
 *   turn that file red. A decision that is written twice is tested once.
 */

/** Raised bottom line: the last node must stay reachable above the keyboard bar. */
export const autoScrollBottomLimit = (viewportBottom: number, barHeight: number): number =>
  viewportBottom - barHeight;

/**
 * Whether a downward scroll step must be rolled back.
 *
 * `.om-outline-wrap` reserves room below the last node (`padding-bottom: 40vh`), so scrolling to the
 * bottom ends with the last node above the top of the screen and no node left to drop on. The rule:
 * scrolling down while the last node has already moved entirely above the bottom line goes further in
 * the wrong direction, so the step is undone.
 */
export const shouldRollBackScroll = (
  dy: number,
  beforeLastBottom: number,
  bottomLimit: number,
): boolean => dy > 0 && beforeLastBottom < bottomLimit;
