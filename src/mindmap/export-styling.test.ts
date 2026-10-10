/**
 * "Export image" must match what is on screen (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * Symptom
 * ──────────────────────────────────────────────────────────────────
 *
 * In the exported PNG a big "−" circle appears at every branch junction,
 * yet they are nowhere to be seen on screen.
 *
 * ──────────────────────────────────────────────────────────────────
 * Root cause
 * ──────────────────────────────────────────────────────────────────
 *
 * Those circles are the collapse button `.mm-badge`, hidden by the plugin styles:
 *
 *     .om-mm-host .mm-node:not(.mm-collapsed) .mm-badge { opacity: 0 }
 *
 * `exportPng` uses `cloneNode` + `XMLSerializer` to produce a standalone SVG,
 * **which carries the class attributes along but not the page CSS**. A standalone document has no stylesheet interpreting those classes,
 * and `opacity` falls back to its default 1 ⇒ every circle becomes visible.
 *
 * The fix needs **both steps at once**; missing one makes it useless:
 *   ① embed the plugin styles into the SVG;
 *   ② add `.om-mm-host` to the cloned root node -- the rule above is a descendant selector,
 *      it requires the class on an ancestor, the standalone SVG root has none, and without it it can never match.
 */

export {};

import * as fs from 'node:fs';
import * as child_process from 'node:child_process';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const src = fs.readFileSync('src/mindmap/Mindmap.tsx', 'utf8');

console.log('① Embed the plugin styles into the cloned SVG');

check(
  '★ the plugin styles are collected before the export (textContent)',
  /querySelectorAll\('style'\)[\s\S]{0,200}textContent/.test(src),
  'found no code that collects the style text',
);

check(
  '★ only the plugin styles are taken, the SiYuan stylesheet is not dragged along',
  /\.filter\(\(t\)\s*=>\s*t\.includes\('om-mm-'\)\s*\|\|\s*t\.includes\('\.mm-'\)\)/.test(src),
  'not filtered by the plugin marker -- the whole SiYuan stylesheet gets stuffed into the exported file',
);

check(
  '★ <style> is created with the SVG namespace (createElement would produce an HTML element, which has no effect in SVG)',
  /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg',\s*'style'\)/.test(src),
  'must be createElementNS(.., svg namespace, "style")',
);

check(
  '★ <style> is inserted at the very front of the clone (it has to take effect before the shapes)',
  /insertBefore\(styleEl,\s*clone\.firstChild\)/.test(src),
);

console.log('\n★★ Add the ancestor class on the root node (without this step the embedded styles are useless)');

check(
  '★★ the cloned root node carries om-mm-host',
  /setAttribute\(\s*'class',\s*`\$\{svg\.getAttribute\('class'\)[\s\S]{0,80}om-mm-host/.test(src),
  'the root node was not given om-mm-host -> the descendant selector cannot match',
);


console.log('\n③ the existing export behavior was not broken');

check(
  '★ the translate/scale transform on <g> is still cleared (otherwise only the current viewport is exported)',
  /querySelector\('g'\)[\s\S]{0,80}setAttribute\('transform',\s*''\)/.test(src),
);

check('★ width/height is still set', /clone\.setAttribute\('width',\s*String\(W\)\)/.test(src));
check('★ XMLSerializer is still used', /new XMLSerializer\(\)\.serializeToString\(clone\)/.test(src));
check('★ output is still at 2x resolution', /canvas\.width\s*=\s*W\s*\*\s*2/.test(src));
check('★ the theme background color is still used as the fill', /ctx\.fillStyle\s*=\s*theme\.bg/.test(src));

console.log('\n④ that "collapse button hidden" rule really does require the .om-mm-host ancestor');

{
  // ★ note where the scoping comes from: `src/styles.css` writes it **without a prefix**
  //   `.mm-node:not(.mm-collapsed) .mm-badge{opacity:0}`,
  //   the `.om-mm-host` prefix is added at **build time** (scripts/verify-css-scope.py).
  //   What actually ships with the artifact and is parsed by the browser is dist-plugin/index.css.
  const source = fs.readFileSync('src/styles.css', 'utf8');
  check(
    '★ the source stylesheet has the "collapse button hidden" rule (opacity:0)',
    /\.mm-node:not\(\.mm-collapsed\)\s+\.mm-badge\s*\{\s*opacity:\s*0/.test(source),
    'that rule is gone from src/styles.css',
  );

  const builtPath = 'dist-plugin/index.css';
  if (!fs.existsSync(builtPath)) {
    try {
      child_process.execSync('npm run build', { stdio: 'ignore' });
    } catch {}
  }
  if (fs.existsSync(builtPath)) {
    const built = fs.readFileSync(builtPath, 'utf8');
    check(
      '★★ in the build artifact the rule carries the .om-mm-host prefix (this is exactly the basis for adding the root class)',
      /\.om-mm-host[^{}]*\.mm-node:not\(\.mm-collapsed\)\s+\.mm-badge\s*\{\s*opacity:\s*0/.test(built),
      'no prefixed rule found in the artifact -- if the build ever changes, the circles may show up in exports again',
    );
  } else {
    check('★★ the build artifact exists (run npm run build before this test)', false,
      `${builtPath} does not exist -- cannot check the build-time scope prefix`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}