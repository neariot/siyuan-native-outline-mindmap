/**
 * **Focus restoration** semantics for panels / overlays —— and the reason Escape needs it.
 *
 * See `docs/pitfalls/editor.md` §2.1 (“whatever steals the focus must give it back”).
 *
 * ★ The same pattern appears in four places:
 *   · mind map edit overlay (textarea)
 *   · "@ reference a document" panel (autoFocus input)
 *   · "backlinks" panel (autoFocus input)
 *   · find & replace bar (autoFocus input)
 *
 *   Common trait: **it steals focus when opening, and nobody gives it back on close**.
 *   Focus lands on BODY → all subsequent typing is lost.
 *
 *   Contrast: the "Emoji" and "table" panels have no autoFocus, focus stays on the node,
 *   and they never had this problem — so this is not a "panel" disease,
 *   it is "**whatever steals focus must give it back**".
 *
 * ★ And the second half, which is why `panel-escape-focus.test.ts` is folded in here: a panel's Escape
 *   handler fires only while focus is **inside** the element that carries it. So "the handler is wired" is
 *   not enough —— the container needs `tabIndex` (or `box.focus()` silently does nothing) and the focus must
 *   really be moved into it on open. Both halves are asserted on the shipped JSX and callbacks through the
 *   parser; the file previously held a `PanelModel` class and a `PanelSpec[]` table written inside the test,
 *   so no change to the plugin could turn either of them red.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { fnBody, jsxElementsWithAttr, jsxElementsWithAttrContaining } from './source-probe';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const src = fs.readFileSync(path.join(__dirname, 'outline', 'Outliner.tsx'), 'utf8');

console.log('=== every panel container can take focus, and handles Escape ===');
{
  const boxes = jsxElementsWithAttr(src, 'ref', '{panelBoxRef}');
  // ★★ The precondition is **coverage**, not a hardcoded figure: every panel the component can open
  //   must have a container, because the two checks below are `every(...)` over what the probe
  //   found and would pass over nothing. An exact literal went stale the moment a panel was added
  //   (the code-block panel made it 6) and its red then hid the two real checks behind it, so the
  //   expected number is derived from the panel names instead of written down.
  const openable = new Set(Array.from(src.matchAll(/panel === '([a-z]+)'/g), (m) => m[1]));
  check(
    '★ every openable panel has a focusable container (precondition)',
    openable.size > 0 && boxes.length === openable.size,
    `containers=${boxes.length} openable=${openable.size} [${[...openable].join(',')}]`,
  );
  check('★★★ every container carries `tabIndex` —— without it `box.focus()` is a no-op and Escape never arrives',
    boxes.every((b) => b.attrs.includes('tabIndex')),
    boxes.filter((b) => !b.attrs.includes('tabIndex')).map((b) => `line ${b.line}`).join(', '));
  check('★★ every container wires the panel key handler',
    boxes.every((b) => b.attrs.includes('onKeyDown')),
    boxes.filter((b) => !b.attrs.includes('onKeyDown')).map((b) => `line ${b.line}`).join(', '));
}

console.log('\n=== Escape closes whichever panel is open ===');
{
  const keyBody = fnBody(src, 'const panelKeyDown = (e: React.KeyboardEvent)');
  check('★ the handler exists (precondition)', keyBody.length > 0);
  check('★★ it reacts to Escape', keyBody.includes("'Escape'"), keyBody.slice(0, 80));
  check('★★ and closes the panel', keyBody.includes('closePanel()'), keyBody.slice(0, 160));

  // The find bar is not a panel container: its input carries its own inline handler, and that arrow sits
  // inside a large component callback —— so the check is made **on the element** (the parser reports which
  // JSX element wires an `onKeyDown` that calls it), not by searching for an enclosing function body.
  const findEsc = jsxElementsWithAttrContaining(src, 'onKeyDown', 'closeFind()');
  check('★★★ the find bar closes on Escape from its own input handler',
    findEsc.length === 1 && findEsc[0].init.includes("'Escape'"),
    JSON.stringify(findEsc.map((f) => `line ${f.line}`)));
}

console.log('\n=== opening a panel records what to focus again, and moves focus inside ===');
{
  const openBody = fnBody(src, 'const openPanel = (name:');
  check('★ the opener exists (precondition)', openBody.length > 0);
  check('★★ the return target is recorded **before** the panel is shown',
    openBody.indexOf('panelReturnFocus.current =') >= 0 &&
      openBody.indexOf('panelReturnFocus.current =') < openBody.indexOf('setPanel('),
    'recording it afterwards can miss the node the user was in');
  check('★★★ opening from a toolbar button (no active node) falls back to the first visible node',
    openBody.includes('flattenVisible'),
    'without the fallback there is nothing to focus back and typing after closing is lost');
  check('★★★ focus is really moved into the container —— this is what makes Escape reach the handler',
    /box\.focus\(\)/.test(openBody), 'a rAF `box.focus()`');
  check('★ … and only when the panel does not already have focus',
    /contains\(document\.activeElement\)/.test(openBody),
    'otherwise an autoFocus input inside the panel is robbed of focus');
}

console.log('\n=== closing gives focus back ===');
{
  const closeBody = fnBody(src, 'const closePanel = (');
  check('★★ the recorded node is focused again on close', closeBody.includes('focusReq(back'), closeBody.slice(0, 120));
  check('★★ the record is cleared before restoring, so a second close cannot restore a stale target',
    closeBody.indexOf('panelReturnFocus.current = null') >= 0 &&
      closeBody.indexOf('panelReturnFocus.current = null') < closeBody.indexOf('focusReq('),
    'otherwise the panel after the next one restores a node the user has long left');

  // The find bar is the same defect: its input has `autoFocus`, so closing it without restoring focus
  // leaves focus on BODY and everything typed next is lost (measured ['A','B','C'] → ['A','B','C']).
  const closeFindBody = fnBody(src, 'const closeFind = (');
  check('★★ the find bar gives focus back too', closeFindBody.includes('focusReq(back'), closeFindBody.slice(0, 120));
  const openFindBody = fnBody(src, 'const openFind = (');
  check('★ and it records the target before opening', openFindBody.includes('panelReturnFocus.current ='),
    openFindBody.slice(0, 120));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
