// Style scoping: at build time, pull every selector into the plugin container `.om-mm-host`.
//
// Background
//   Plugin CSS is **injected globally** (SiYuan attaches index.css to the host page with <link>,
//   there is no Shadow DOM). In the source, 173 selectors are written as bare class names:
//
//       .node-row / .outliner-title / .btn / .link-chip / .match-item ...
//
//   These names are too generic; the risk of colliding with the host or another plugin never goes away.
//   "SiYuan happens not to use this class name right now" is no argument —— a host redesign, another plugin,
//   or even just a second plugin on the same page can collide with it all of a sudden.
//
// Approach
//   Instead of prefixing those 173 selectors by hand (easy to miss some, and ones added later get missed too),
//   the prefix is added uniformly **at build time**. The benefits:
//     · the source stays readable as it is, with no long chain of `.om-mm-host .a, .om-mm-host .b`
//     · bare class names written later are **automatically** pulled in, so none is forgotten
//     · a selector that is already scoped does not get the prefix twice
//
// Division of labor with `scripts/verify-css-scope.py`
//   This file does the "pulling in", that script does the "acceptance check" —— it scans the built output,
//   and fails the build on any bare selector that slipped through. The two run back to back and back each other up.

/** The plugin container's class name; it must match `host.classList.add(...)` in `src/plugin/mount.ts` */
export const HOST_SCOPE = '.om-mm-host';

/**
 * Tells whether a selector is **already** scoped.
 *
 * It looks only at the original selector text, not at the prefixed result —— otherwise `.om-mm-host .x`
 * would be prefixed a second time and become `.om-mm-host .om-mm-host .x`.
 */
export const isScoped = (selector) => selector.includes(HOST_SCOPE);

/**
 * Adds the scope prefix to one selector.
 *
 * Three cases:
 *   1. already scoped (contains `.om-mm-host`) → return it unchanged, so the prefix is not repeated;
 *   2. a top-level `html[...]` at the front (dark theme variables) → insert the prefix after html,
 *      written as `html[data-theme-mode='dark'] .om-mm-host`,
 *      which guarantees "the plugin container under dark mode" rather than "html under dark mode";
 *   3. everything else → just `prefix + space + original selector`.
 *
 * @param selector the original selector (without the prefix)
 * @param prefixed the result postcss-prefix-selector already computed; case 3 uses it directly
 */
export const scopeSelector = (selector, prefixed) => {
  if (isScoped(selector)) return selector;
  if (/^html\[/.test(selector)) {
    return selector.replace(/^(html\[[^\]]*\])/, `$1 ${HOST_SCOPE}`);
  }
  return prefixed;
};
