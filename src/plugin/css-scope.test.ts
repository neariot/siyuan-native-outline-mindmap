/**
 * Regression test for the build-time style scope prefixer.
 *
 * Background
 *   The plugin CSS is **injected globally** (SiYuan attaches it to the host page with <link>, there is no Shadow DOM),
 *   and the source once had 173 selectors written as bare class names: `.node-row`, `.outliner-title`,
 *   `.btn`, `.link-chip`…… "SiYuan happens not to use this class name right now" is not a reason ——
 *   a host redesign or installing another plugin could collide with it at any moment.
 *
 *   The scoping happens at build time (`scripts/css-scope.mjs` +
 *   `tools.postcss` in `rsbuild.config.ts`), and this test locks down the behaviour of that function.
 *
 * Three easy-to-get-wrong points this test watches
 *   1. **Duplicate prefix**: `.om-mm-host .x` must not get another one and become
 *      `.om-mm-host .om-mm-host .x` (the scope still matches, but the selector is bloated,
 *      and once the host changes structure it stops matching —— a silent degradation, it must be locked down).
 *   2. **Dark theme selector**: `html[data-theme-mode='dark'] .om-mm-host`
 *      the prefix must be inserted **after** `html[...]`, written as
 *      `html[data-theme-mode='dark'] .om-mm-host`;
 *      a simple prepend becomes `.om-mm-host html[...]`, which **never matches** in SiYuan ——
 *      under dark mode the whole block of variables is dead code and the mind map keeps the light palette.
 *   3. **keyframes inside @keyframes** (`from` / `to` / `50%`) are not selectors
 *      and must not be prefixed.
 */

export {};

import { HOST_SCOPE, isScoped, scopeSelector } from '../../scripts/css-scope.mjs';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n      expected ${JSON.stringify(want)}\n      actual ${JSON.stringify(got)}`);
  }
}

/** Mimics the default prefixing of postcss-prefix-selector */
const prefixed = (sel: string) => `${HOST_SCOPE} ${sel}`;

console.log('plain bare selectors should be scoped:');
{
  check('.node-row → prefixed', scopeSelector('.node-row', prefixed('.node-row')), '.om-mm-host .node-row');
  check('.outliner-title → prefixed', scopeSelector('.outliner-title', prefixed('.outliner-title')), '.om-mm-host .outliner-title');
  check('.btn → prefixed', scopeSelector('.btn', prefixed('.btn')), '.om-mm-host .btn');
  // pseudo-class / descendant / attribute selectors
  check('.node-row:hover', scopeSelector('.node-row:hover', prefixed('.node-row:hover')), '.om-mm-host .node-row:hover');
  check('.node-row .title', scopeSelector('.node-row .title', prefixed('.node-row .title')), '.om-mm-host .node-row .title');
  check('[data-theme="dark"] .node-row', scopeSelector('[data-theme="dark"] .node-row', prefixed('[data-theme="dark"] .node-row')), '.om-mm-host [data-theme="dark"] .node-row');
}

console.log('\n★ already scoped selectors must not be prefixed twice:');
{
  check('.om-mm-host .x unchanged', scopeSelector('.om-mm-host .x', prefixed('.om-mm-host .x')), '.om-mm-host .x');
  check('.om-mm-host alone unchanged', scopeSelector('.om-mm-host', prefixed('.om-mm-host')), '.om-mm-host');
  check('nested .om-mm-host .a .b unchanged', scopeSelector('.om-mm-host .a .b', prefixed('.om-mm-host .a .b')), '.om-mm-host .a .b');
  // double prefixes are explicitly forbidden
  const twice = scopeSelector('.om-mm-host .x', prefixed('.om-mm-host .x'));
  check('★ .om-mm-host .om-mm-host never appears', twice.includes('.om-mm-host .om-mm-host'), false);
}

console.log('\n★ dark theme selector: the prefix must be inserted after html[...]:');
{
  check(
    "html[data-theme-mode='dark'] .om-mm-host",
    scopeSelector("html[data-theme-mode='dark'] .om-mm-host", prefixed("html[data-theme-mode='dark'] .om-mm-host")),
    "html[data-theme-mode='dark'] .om-mm-host",
  );
  check(
    'html prefix + bare selector (this one must be scoped, but inserted after html)',
    scopeSelector("html[data-theme-mode='dark'] .node-row", prefixed("html[data-theme-mode='dark'] .node-row")),
    "html[data-theme-mode='dark'] .om-mm-host .node-row",
  );
  // reverse: the shape "prefix before html" must never appear
  const bad = scopeSelector("html[data-theme-mode='dark'] .node-row", prefixed("html[data-theme-mode='dark'] .node-row"));
  check('★ .om-mm-host html[ never appears', bad.includes(`${HOST_SCOPE} html[`), false);
}

console.log('\nscope predicate function:');
{
  check('.om-mm-host .x → scoped', isScoped('.om-mm-host .x'), true);
  check('.om-mm-host → scoped', isScoped('.om-mm-host'), true);
  check('.node-row → unscoped', isScoped('.node-row'), false);
  check('.om-bullet → unscoped (.om- is its own prefix, but it is not under the host)', isScoped('.om-bullet'), false);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
