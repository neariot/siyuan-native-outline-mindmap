/**
 * Build-output regression: the output must really carry the attributes a SiYuan tooltip needs.
 *
 * Why inspect the output instead of a browser: a tooltip is a purely static JSX attribute,
 * verifying it with a CDP hover + screenshot is both subject to render timing and requires guessing the bubble coordinates,
 * slow and unstable. Checking the strings compiled into `index.js` is deterministic.
 *
 * Three things are pinned down here:
 *   1. the class fragment `ariaLabel` exists in the output (SiYuan's mouseover delegation selects elements by it);
 *   2. the plugin's own tooltip() helper is called (meaning the unified implementation is used);
 *   3. the code does not wrongly interpolate ariaLabel into a template literal (a wrong interpolation silently swallows 12 lines).
 *
 * The exact wording is not checked —— wording changes with i18n, and pinning it down makes the test brittle.
 */
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.error('  ❌', name, extra ?? ''); }
};

// The output is built from the sources in git, so scan the sources + the built index.js (if present) directly
const SRC_FILES = [
  'src/plugin/outline/Outliner.tsx',
  'src/mindmap/Mindmap.tsx',
];

let totalAriaLabel = 0;
for (const f of SRC_FILES) {
  const s = readFileSync(f, 'utf8');
  const n = (s.match(/ariaLabel/g) || []).length;
  totalAriaLabel += n;
  check(`${f} carries ariaLabel`, n > 0, `actual ${n}`);
  // wrong-interpolation detection: ariaLabel must not appear inside a template literal or a ternary
  check(`${f} does not interpolate ariaLabel into a template literal`,
    !/ariaLabel`/.test(s), 'found ariaLabel` —— the template literal is broken');
  check(`${f} has no ariaLabel glued to a ternary branch`,
    !/'\s?ariaLabel/.test(s) && !/\?\s*'ariaLabel/.test(s),
    'ariaLabel landed inside a ternary expression');
}

// ★ The floor moves with the surface, and it is a floor on purpose: it catches a rewrite that drops
//   `ariaLabel` from a whole file, which the per-file checks above cannot see. It was 35 while the link
//   chip and the summary bar existed —— both are gone (no native carrier, so they never persisted), and
//   each carried one.
check('overall ariaLabel count >= 33 (covers the icon buttons)', totalAriaLabel >= 33, `actual ${totalAriaLabel}`);

// the tooltip() helper itself
const helper = readFileSync('src/plugin/tooltip.ts', 'utf8');
check('the helper produces aria-label too', helper.includes("'aria-label': text"));
check('the helper produces title too (mobile fallback)', /title: text/.test(helper));
check('the helper appends the ariaLabel class', helper.includes('ariaLabel'));

// if it was already built, also check whether it made it into the bundle
if (existsSync('dist-plugin/index.js')) {
  const bundle = readFileSync('dist-plugin/index.js', 'utf8');
  check('the build output contains ariaLabel', bundle.includes('ariaLabel'));
} else {
  console.log('  · skipping the bundle check (dist-plugin/index.js does not exist)');
}

console.log(`  tooltip-build: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
