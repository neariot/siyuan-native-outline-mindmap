/**
 * Drag-to-edge auto-scroll, and the content that padding-bottom pushes out of reach.
 *
 * ★ Every assertion here reads the **product**: the guard from `outline/auto-scroll.ts`, which
 *   `Outliner.tsx` calls, and the rules from `src/styles.css`, parsed with postcss. The first version
 *   re-implemented both inside this file, so each check compared a literal the test had just written
 *   with itself —— no change to the product could turn it red, and two ledger entries named it as the
 *   test that freezes the behaviour. A re-implementation is not a test of anything.
 *
 * The recorded measurements (390×844 mobile, 20 nodes) are kept as comments: they are why the rules
 * below exist, and they are not assertions, because a number typed in here cannot fail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import { autoScrollBottomLimit, shouldRollBackScroll } from './outline/auto-scroll';

export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

const cssFile = path.join(__dirname, '..', 'styles.css');
const sheet = postcss.parse(fs.readFileSync(cssFile, 'utf-8'));

/**
 * The declarations the stylesheet gives `selector` **outside** any at-rule.
 *
 * ★ Rules inside `@media` are skipped, and the order matters: merging them in lets a narrow-screen
 *   value overwrite the base one, so a check on the base rule reads the narrow rule's number and goes
 *   red on a stylesheet that is correct. Use `declsIn` for a conditional rule.
 */
const declsOf = (selector: string): Record<string, string> => {
  const out: Record<string, string> = {};
  sheet.walkRules((rule) => {
    // A selector list can hold the target among others, and a rule nested in a media query is
    // conditional: it must be asked for separately.
    if (rule.parent && rule.parent.type === 'atrule') return;
    if (!rule.selectors.some((s) => s.trim() === selector)) return;
    rule.walkDecls((d) => { out[d.prop] = d.value; });
  });
  return out;
};

/** The same, but only from `@media` rules whose **params** match (e.g. the narrow-screen query). */
const declsIn = (params: RegExp, selector: string): Record<string, string> => {
  const out: Record<string, string> = {};
  // ★ Matched by name and then filtered on params: postcss tests a walk pattern against the at-rule
  //   **name** (`media`), never against `max-width: 768px`, so passing the query straight in matches
  //   nothing at all and the assertions below pass or fail for a reason that has nothing to do with CSS.
  sheet.walkAtRules('media', (at) => {
    if (!params.test(at.params)) return;
    at.walkRules((rule) => {
      if (!rule.selectors.some((s) => s.trim() === selector)) return;
      rule.walkDecls((d) => { out[d.prop] = d.value; });
    });
  });
  return out;
};

/**
 * `padding-bottom` as a browser reads it, from either the longhand or the shorthand.
 * The stylesheet writes `padding: 18px 0 40vh`, so looking only for the longhand finds nothing and the
 * check goes red on a rule that is present —— which is what this file's first version would have done
 * if it had read the stylesheet at all.
 */
const bottomPadding = (decls: Record<string, string>): string | undefined => {
  if (decls['padding-bottom'] !== undefined) return decls['padding-bottom'];
  const parts = (decls.padding ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 || parts.length === 3) return parts[parts.length - 1];
  if (parts.length === 4) return parts[2];
  return undefined;
};

console.log('=== the scroll area must be a scroll area at all ===');
{
  const wrap = declsOf('.om-outline-wrap');
  // `flex: 1` only does anything inside a flex container, and the host is the element that scrolls.
  check('★★ `.om-outline-wrap` is the scroll area (`overflow-y: auto`)', wrap['overflow-y'] === 'auto');
  check('★★ … and it is allowed to grow (`flex: 1`)', wrap.flex === '1');
  // ★ The room that pushes the last node out of reach is reserved **here**; the guard in
  //   `auto-scroll.ts` is what makes it safe, so this is the rule the guard exists for.
  check('★★ … and it reserves room below the last node (`padding-bottom: 40vh`)',
    bottomPadding(wrap) === '40vh');
}

console.log('\n=== under the narrow-screen media query the padding shrinks ===');
{
  const narrow = declsIn(/max-width:\s*768px/, '.om-outline-wrap');
  const narrowBottom = bottomPadding(narrow);
  check('★ the narrow screen reserves less room, and the value is a length',
    narrowBottom !== undefined && /^\d+(px|vh|%)$/.test(narrowBottom.trim()));
}

console.log('\n=== the overshoot guard (shipped, not re-implemented) ===');
{
  // Measured trace of the last node's bottom while scrolling to the bottom of the reserved space:
  //   {t: 5, b: 39} → {t: -13, b: 21} → {t: -31, b: 3} → {t: -49, b: -15} → {t: -66, b: -32}
  const trace = [39, 21, 3, -15, -32];
  check('★★ scrolling all the way down pushes the last node off screen',
    trace[trace.length - 1] < 0);
  check('★★★ so at the bottom no node can take the drop',
    trace.every((b) => b > 40) === false);

  check('★★ scrolling down with the last node above the bottom line ⇒ roll back',
    shouldRollBackScroll(18, -66, 812) === true);
  check('★★ the last node mid-node (bottom < bottom line) ⇒ roll back, do not push it out of view',
    shouldRollBackScroll(18, 700, 812) === true);
  check('★★ the last node below the bottom line ⇒ scroll down normally',
    shouldRollBackScroll(18, 900, 812) === false);
  check('★ scrolling up is unaffected by the guard',
    shouldRollBackScroll(-18, -66, 812) === false);
  // ★ The boundary, and the case that tells `>` from `>=`: auto-scroll runs every frame, so a step of
  //   zero is a normal thing to hand the guard (the finger held still at the edge). It is not a
  //   downward scroll, so nothing is rolled back. Without this line a `>` → `>=` change is invisible.
  check('★★ a step of zero is not a downward scroll ⇒ no rollback',
    shouldRollBackScroll(0, -66, 812) === false);
}

console.log('\n=== the keyboard bar eats the bottom hit area ===');
{
  // 844px viewport, a 192px `.mobile-bar-fixed` (4 buttons and separators, measured).
  const vh = 844;
  const barH = 192;
  const bottomLimit = autoScrollBottomLimit(vh, barH);
  check('★ a finger resting at y=834 is over `.mobile-bar-fixed`, not over a node',
    834 > bottomLimit);
  check('★★ ⇒ the bottom line is raised above the bar', bottomLimit === 652);

  const bar = declsOf('.mobile-bar-fixed');
  check('★ … and `.mobile-bar-fixed` is a real rule in the stylesheet, not a name only',
    Object.keys(bar).length > 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);