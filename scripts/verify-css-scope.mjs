// Style scoping gate: no unscoped bare selector may appear in the build output index.css.
//
// Ports scripts/verify-css-scope.py to the parser the build already uses (postcss): the Python
// version stripped comments with a regex and counted braces by hand, so a `/*` or a `{` inside a
// CSS string could delete real rules from the input (an unscoped selector then passes) or invent
// a selector that is not one. A regex over source text is not evidence — parse with the parser.
//
// Allowed scope forms: as long as one of them is present, the selector counts as pulled in.
// Keyframes stops (from/to/50%) are not selectors and are skipped — same rule as the Python gate.
//
// Usage:
//   node scripts/verify-css-scope.mjs            # check dist-plugin/index.css
//   node scripts/verify-css-scope.mjs <file.css>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCOPE = '.om-mm-host';
const ALLOWED_SCOPES = [
  HOST_SCOPE,
  '.om-',
  '.mm-',
  '.mobile-keyboard-bar',
  'b3-',
  '[class*="om-"]',
];
const KEYFRAME_STOP = /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/;

const isScoped = (selector) => ALLOWED_SCOPES.some((s) => selector.includes(s));

const target = process.argv[2] ?? path.join(ROOT, 'dist-plugin', 'index.css');
if (!fs.existsSync(target)) {
  console.log(`  ❌ ${target} not found, run npm run build first`);
  process.exit(1);
}

const root = postcss.parse(fs.readFileSync(target, 'utf8'));
let total = 0;
const bad = [];
root.walkRules((rule) => {
  // Skip keyframe stops: they are not selectors. postcss gives us the real rule
  // parent, so no brace-counting guesswork about "inside an at-rule".
  if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
  for (const one of rule.selector.split(',').map((s) => s.trim())) {
    if (!one || KEYFRAME_STOP.test(one)) continue;
    total++;
    if (!isScoped(one)) bad.push({ line: rule.source?.start?.line ?? 0, selector: one });
  }
});

console.log(`  selectors total  ${total}`);
console.log(`  scoped           ${total - bad.length}`);
console.log(`  unscoped         ${bad.length}`);

if (bad.length) {
  console.log();
  console.log('  ❌ Found unscoped bare selectors, release is forbidden:');
  const seen = new Set();
  for (const { line, selector } of bad) {
    if (seen.has(selector)) continue;
    seen.add(selector);
    console.log(`     ${target}:${line}  ${selector.slice(0, 88)}`);
    if (seen.size >= 15) {
      console.log(`     ... plus ${bad.length - seen.size} more collapsed`);
      break;
    }
  }
  console.log();
  console.log(`  How to fix: such selectors are automatically scoped into ${HOST_SCOPE} by the build-time prefixer,`);
  console.log('       so reaching this point means the prefixer did not take effect or was bypassed ——');
  console.log('       check tools.postcss in rsbuild.config.ts and scripts/css-scope.mjs.');
  process.exit(1);
}

console.log();
console.log(`  ✅ All ${total} selectors are scoped into the plugin`);
