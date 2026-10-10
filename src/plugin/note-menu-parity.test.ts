/**
 * The "note/description" context menu item —— both views must have it, and it must be wired to the **correct** action.
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this has to be guarded
 * ──────────────────────────────────────────────────────────────────
 *
 * The attached paragraph (formerly called "note") used to have only one entry point:
 *
 *   · **Outline**: that 📝 button in the toolbar
 *   · **Mind map**: the small badge at the top-right of a node (`mm-para-badge`)
 *
 * Neither entry point is easy to find —— the toolbar button has no text, the badge has to be hit precisely,
 * and right-click is the conventional entry point of this interface. Adding the menu item itself is a small matter;
 * what is really easy to get wrong is the **wiring**:
 *
 *   · the menu item's `onClick` hooked to the wrong function (e.g. hooked to `deleteNodes`)
 *     → no error, the types pass too, and the user only discovers the disaster after clicking;
 *   · only one view was changed and the other was missed
 *     → equally silent, nobody gets a warning.
 *
 * Neither of these is something "the compiler cannot see", so source assertions guard them:
 *
 *   ① the outline menu item must call `togglePara` (= the same action as the toolbar 📝)
 *   ② the mind map menu item must call `openParagraphs` (= the same action as the badge)
 *   ③ both views must have it, not just one
 */

export {};

import * as fs from 'node:fs';

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

const outliner = fs.readFileSync('src/plugin/outline/Outliner.tsx', 'utf8');
const mindmap = fs.readFileSync('src/mindmap/Mindmap.tsx', 'utf8');

/**
 * Take the context-menu section (`mm-ctx-menu` to the end of the file).
 *
 * Not the "whole file" —— `tipNote` also appears once inside the toolbar button,
 * and a whole-file search would mistake that button for a menu item.
 */
function ctxMenuSection(src: string): string {
  const at = src.indexOf('className="mm-ctx-menu"');
  return at < 0 ? '' : src.slice(at);
}

/**
 * Whether the menu-item wiring looks suspicious: `tipNote` is not found in the menu section,
 * or the expected handler does not appear in the `onClick` right before it.
 *
 * `window` is 600 characters —— enough to cover one menu-item div (measured at about 250 characters),
 * and not so far that it pulls in a neighbouring menu item's handler.
 */
function noteMenuWiringBad(section: string, handler: RegExp): boolean {
  const at = section.indexOf("tipNote");
  if (at < 0) return true;
  const before = section.slice(Math.max(0, at - 600), at);
  return !handler.test(before);
}

// ──────────────────────────────────────────────────────────────────
console.log('Outline: the context menu has "note/description", and it is wired to the toolbar action');

{
  const sec = ctxMenuSection(outliner);
  check('the context-menu section is found', sec.length > 0);

  check(
    '★ the menu has a tipNote item',
    sec.includes("tipNote"),
  );
  check(
    '★ it calls togglePara (the same action as the toolbar 📝)',
    !noteMenuWiringBad(sec, /togglePara\(id\)/),
  );

  // align with the toolbar: both must use the same handler, otherwise there would be
  // two implementations, "the toolbar does this and the context menu does that".
  //
  // ★ do not look for that button by `📝` —— the `EMOJIS` constant array in the file also contains this character,
  //   and `indexOf` would hit that array entry. Instead search backwards **starting from the handler**:
  //   the button is the one that `togglePara(activeId)` immediately follows.
  const toolbarHandlerAt = outliner.indexOf('togglePara(activeId)');
  check('the toolbar 📝 button handler is found', toolbarHandlerAt > 0);
  check(
    '★ the toolbar 📝 also calls togglePara (both sides share one source)',
    toolbarHandlerAt > 0 && outliner.slice(toolbarHandlerAt, toolbarHandlerAt + 120).includes('📝'),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('Mind map: the context menu has "note/description", and it is wired to the badge action');

{
  const sec = ctxMenuSection(mindmap);
  check('the context-menu section is found', sec.length > 0);

  check(
    '★ the menu has a tipNote item',
    sec.includes("tipNote"),
  );
  check(
    '★ it calls openParagraphs (the same action as the node badge)',
    !noteMenuWiringBad(sec, /openParagraphs\(/),
  );

  // the badge path is still there (the menu item is an addition, not a replacement)
  check(
    '★ the node badge still calls openParagraphs (must not be reduced to the menu alone)',
    /className="mm-para-badge"/.test(mindmap) &&
      /openParagraphs\(b\.node\)/.test(mindmap),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('the criteria themselves are effective (feeding a bad sample must go red)');

{
  // ① wired to a dangerous action: the types are legal, it compiles, and only clicking reveals it
  const WRONG = `
    <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); deleteNodes([ctxMenu.id]); }}>
      {t('tipNote')}
    </div>`;
  check(
    '★ the criterion can spot "a menu item hooked to the wrong handler"',
    noteMenuWiringBad(WRONG, /togglePara\(id\)/),
  );

  // ② only one view was patched: the other one's menu section has no tipNote at all
  const NO_MENU_ITEM = `
    <div className="mm-ctx-menu">
      {t('cmdEditNode')}
    </div>`;
  check(
    '★ the criterion can spot "the menu has no such item at all"',
    noteMenuWiringBad(NO_MENU_ITEM, /togglePara\(id\)/),
  );

  // ③ reverse control: the correct form must **not** be judged red
  const OK = `
    <div className="mm-ctx-item" onClick={() => { const id = ctxMenu.id; setCtxMenu(null); togglePara(id); }}>
      {t('tipNote')}
    </div>`;
  check(
    '★ the criterion does not hit the correct form',
    !noteMenuWiringBad(OK, /togglePara\(id\)/),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailed items:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
