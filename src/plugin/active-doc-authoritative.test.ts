// Resolving the "currently active document" must use the authority SiYuan itself uses; scanning the DOM to guess is forbidden.
//
// ## Background (a real defect)
//
// "After creating a new notebook, the documents inside it keep saying they have no content; reopening the UI fixes it."
//
// Root cause: this used to be a four-layer DOM heuristic, one layer being "take the .protyle that contains the focused element".
// With several tabs open that matches **the one that was just opened**, not the one the user is looking at. The captured scene:
//
//     1656ms  matched=focused  id=<the just-opened empty document>
//             protyles=[the one the user is reading, the just-opened one]   URL=the one the user is reading
//
// So the panel read that still-empty document and showed "This document has no content yet".
//
// The fix is to use the definition SiYuan itself uses (`getActiveTab` in `app/src/layout/tabUtil.ts`
// and how `app/src/window/setHeader.ts` reads the value):
//
//   1. Active tab = the data-id of `.layout__wnd--active .item--focus`
//   2. Find the Tab instance by that id in `siyuan.layout.centerLayout`
//   3. Read `model.editor.protyle.block.rootID`
//
// On mobile, read `siyuan.mobile.editor.protyle.block.rootID`.
//
// ## Why assert on the source instead of driving a browser
//
// Checking "does it pick the right one when several tabs are open" means opening two tabs, switching back and forth, then reading the panel -- tens of seconds per round.
// What really has to be locked down here is a **structural constraint**: no branch may "guess".
// Reading the source settles it in milliseconds, and a slow machine cannot make it flake.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, 'active-doc.ts'), 'utf8');

/**
 * Source with the comments removed.
 *
 * Assertions must look at the **code** only —— this file's prose quotes the forbidden patterns,
 * so asserting on the raw text would be matched by its own comments and the test would be decoration.
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('active document comes from the structure SiYuan treats as authoritative, no DOM guessing', () => {
  // ① Use the "active tab" criterion SiYuan itself uses.
  assert.match(
    SRC,
    /querySelector\(\s*'\.layout__wnd--active \.item--focus'\s*\)/,
    'did not use `.layout__wnd--active .item--focus` —— that is the getActiveTab definition, ' +
      'without it the only option is guessing which editor is active',
  );

  // ② Take the document ID from the kernel object, not from a DOM attribute.
  assert.match(
    SRC,
    /model\?\.editor\?\.protyle\?\.block\?\.rootID|model\.editor\.protyle\.block\.rootID/,
    'did not read the value from model.editor.protyle.block.rootID —— ' +
      'that is how SiYuan setHeader.ts does it, a DOM attribute is only a render result',
  );

  // ③ The layout tree root must be siyuan.layout.centerLayout.
  //    siyuan.ws.app.layout will not do: that field no longer exists in 3.8.6,
  //    and failing to read it degrades into scanning the DOM.
  assert.match(
    SRC,
    /layout\?\.centerLayout/,
    'did not read siyuan.layout.centerLayout',
  );
  assert.doesNotMatch(
    SRC,
    /ws\?\.app\?\.layout/,
    'reads siyuan.ws.app.layout again —— that field no longer exists in 3.8.6',
  );

  // ④ Mobile reads the kernel object too.
  assert.match(
    SRC,
    /mobile\?\.editor\?\.protyle\?\.block\?\.rootID/,
    'mobile did not read siyuan.mobile.editor.protyle.block.rootID',
  );

  // ⑤ The key ban: no guessing of the "take by array position" kind may come back.
  //
  //    That is the technique that once read the wrong document —— whatever the variable is named,
  //    "take index 0 / take the last one" is the same mistake. So the ban is on the **shape**,
  //    not on variable names (banning names is bypassed by a rename, which makes the test worthless).
  assert.doesNotMatch(
    SRC,
    /\[[A-Za-z_$][\w$]*\.length\s*-\s*1\]/,
    'takes the last array element again —— that is exactly what read the wrong document',
  );
  assert.doesNotMatch(
    SRC,
    /\.querySelectorAll\([^)]*\.protyle/,
    'scans .protyle elements with querySelectorAll again —— ' +
      'the document ID must come from the kernel object, not from a rendered editor element',
  );
  assert.doesNotMatch(
    SRC,
    /\.protyle-wysiwyg\[data-node-id\]/,
    'takes .protyle-wysiwyg data-node-id as the document source again —— ' +
      'that element does not exist at all before the new editor renders it',
  );

  // ⑥ There must be a stable path that does not depend on a DOM ancestor.
  //
  //    Measured: at the moment the Dock panel opens, `.layout__wnd--active` disappears entirely for an instant
  //    (0 matches), while the `item--focus` flag on the Tab in the layout tree stays correct:
  //
  //        DOM_active windows=0   models=1   rootID=...  focus=True
  //
  //    Relying on the DOM selector alone fails intermittently (measured: 3 failures out of 5 runs),
  //    and the panel sits at "loading" —— which is exactly "the document always says it has no content".
  //    So the Tab's own `headElement` flag must be used as the fallback.
  //
  //    The assertion must look at **the fallback step**: reading the Tab headElement's
  //    `item--focus` class on the Tab node of the layout tree. Asserting that "item--focus appears in the source" is not enough --
  //    once the fallback is deleted the word is still in the fast-path selector, so the test misses it (this was measured).
  assert.match(
    SRC,
    /headElement\?\.classList\?\.contains\(\s*['"]item--focus['"]\s*\)/,
    'does not fall back to reading item--focus from the Tab headElement in the layout tree —— ' +
      'the .layout__wnd--active DOM ancestor prefix alone fails intermittently' +
      ' (measured: that ancestor disappears entirely for an instant, 3 failures out of 5 runs)',
  );
  // The fallback must actually be invoked after the fast path misses, not merely defined.
  assert.match(
    SRC,
    /if\s*\(\s*!\s*hit\s*\)/,
    'the fallback path is not triggered by the fast path missing —— defined but not wired up is as good as absent',
  );

  // ⑦ When it cannot resolve a value it must return an empty string (the caller shows "loading"),
  //    and must never fall back to guessing "probably this one".
  assert.match(
    SRC,
    /return fromDesktopLayout\(\) \|\| fromMobileEditor\(\);/,
    'the resolution chain changed —— there must be exactly two authoritative sources here, and neither may fall back to guessing from the DOM',
  );
});
