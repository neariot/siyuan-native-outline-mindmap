/**
 * The **classification** semantics of the undo merge window.
 *
 * Corresponds to `docs/pitfalls/editor.md` §2.2 (the undo merge window treats discrete operations like typing).
 *
 * ★ The core distinction:
 *   · continuous typing (kind='text' / undefined) -> **merge** (otherwise Ctrl+Z has to walk back one character at a time)
 *   · structural operations (kind='struct')        -> **each becomes its own step** (they are independent user decisions)
 *
 * ★ The criterion itself now lives in `src/core/undo-window.ts` (`joinsUndoWindow`), called by the change
 *   handler in `mount.ts`. This file used to hold a `MergeModel` class that "replicates the decision in
 *   mount.ts" —— a copy compared against itself, so the plugin's rule could be changed freely (including back
 *   to the wrong one: the measured defect was 3 Tab indents producing a single undo point).
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { UNDO_MERGE_MS, joinsUndoWindow } from '../core/undo-window';
import { callSites } from './source-probe';

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

console.log('=== continuous typing merges; a structural operation never does ===');
{
  const type = (elapsedMs: number, key = 'n1#text') =>
    joinsUndoWindow({ kind: 'text', mergeKey: key, lastKey: key, elapsedMs });

  check('★★ typing inside the window joins the step (Ctrl+Z must not walk back one character)',
    type(500) === true);
  check('★ the boundary is exclusive: exactly at the window it is a new step',
    type(UNDO_MERGE_MS) === false, `elapsedMs=${UNDO_MERGE_MS}`);
  check('★ typing after the window starts a new step', type(UNDO_MERGE_MS + 1) === false);

  // ★★ The measured defect: same node, well inside the window, but a structural operation.
  for (const kind of ['struct'] as const) {
    check('★★★ a structural operation never joins the window, however recent it is',
      joinsUndoWindow({ kind, mergeKey: 'n1#text', lastKey: 'n1#text', elapsedMs: 1 }) === false,
      'three indents must be three undo steps');
  }
  // The kind is also absent for the text path —— an undefined kind must still merge like text.
  check('★ an undefined kind behaves like text (the helpers pass it that way)',
    joinsUndoWindow({ kind: undefined, mergeKey: 'n1#text', lastKey: 'n1#text', elapsedMs: 10 }) === true);
}

console.log('\n=== the key decides *which* step, not just how recent ===');
{
  check('★★ a different node does not join the previous step',
    joinsUndoWindow({ kind: 'text', mergeKey: 'n2#text', lastKey: 'n1#text', elapsedMs: 10 }) === false);
  check('★ the same node but a different field does not join either',
    joinsUndoWindow({ kind: 'text', mergeKey: 'n1#title', lastKey: 'n1#text', elapsedMs: 10 }) === false);
  check('★★ an empty key never merges (that is how a structural operation blanks it)',
    joinsUndoWindow({ kind: 'text', mergeKey: '', lastKey: '', elapsedMs: 10 }) === false);
}

console.log('\n=== the product uses this rule, and refreshes the window only when it merges ===');
{
  // ★ Precondition: a rule nothing calls defends nothing. Read through the parser, because the name also
  //   appears in the comments that explain it.
  const src = fs.readFileSync(path.join(__dirname, 'mount.ts'), 'utf8');
  const calls = callSites(src, /^joinsUndoWindow$/);
  check('★★ the change handler decides with joinsUndoWindow()', calls.length === 1, calls.join(', '));

  // The window is refreshed on a merge and re-opened otherwise; and a structural operation blanks the key, so
  // the next text edit cannot join a window that a structural operation just ended.
  check('★★ a merged change refreshes the window timestamp only',
    /else \{\s*mergeRef\.current\.at = now;/.test(src), 'the else branch');
  check('★★★ when the window is (re)opened, a structural operation stores an empty key',
    /mergeRef\.current = \{ key: isStruct \? '' : mergeKey, at: now \}/.test(src));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
