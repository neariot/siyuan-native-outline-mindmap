/**
 * The **Delete** key's branch order, and the wiring that carries it out.
 *
 * Corresponds to `docs/pitfalls/editor.md` §2.3 (paired reverse keys: check branch completeness on both).
 *
 * ★ The measured defect: a single selection whose caret is **not** at the end of the line fell through the
 *   handler and reached the browser's native forward-delete —— the text disappeared while the node stayed:
 *
 *     measured (click a node, press Home, press Delete):
 *       UI:     ['A','B','C'] → ['A','','C']   ← empty shell
 *       SiYuan: ['A','B','C'] → ['A','','C']   ← persisted, too
 *
 *   and pressing Delete again could not remove it (for an empty node "caret at the end" is true, so it joined
 *   the next node instead).
 *
 * ★ This file used to hold two replicas: a §94 `Loader` modelling the write-back transaction, and a §95
 *   `deleteAction` modelling the key. The first contradicted `write-depth-nesting.test.ts` —— it modelled the
 *   **boolean** transaction that `store.ts` documents as replaced, while the sibling modelled the depth
 *   counter that actually ships —— so it is gone: the real store is driven over there. The key semantics now
 *   drive the real `deleteKeyAction` (extracted from the handler into `src/core/delete-key.ts` because the
 *   branch order *is* the fix), and the handler's use of it is read through the parser.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { deleteKeyAction } from '../core/delete-key';
import { callSites, enclosingBody } from './source-probe';

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

/** `['A','B','C']` with the caret in a middle node —— the state the shell bug was measured in. */
const at = (over: Partial<Parameters<typeof deleteKeyAction>[0]> = {}) =>
  deleteKeyAction({ atLineEnd: false, textEmpty: false, childCount: 0, index: 1, visibleCount: 3, ...over });

console.log('=== the empty-shell case: caret not at the end of the line ===');
{
  // ★★★ The whole defect: this used to fall through to the browser (nothing handled), which deleted the text
  //     and left the node.
  check('★★★ with text after the caret, Delete joins the next node —— it never leaves the browser to do it',
    at() === 'mergeNext', at());
  check('★★ the same node with nothing after it is still handled (no native delete, nothing changes)',
    at({ index: 2 }) === 'none', at({ index: 2 }));
}

console.log('\n=== an empty leaf is removed, whatever the caret position ===');
{
  check('★★★ an empty node with a sibling after it is deleted outright',
    at({ textEmpty: true }) === 'deleteNode', at({ textEmpty: true }));
  // ★ The case that decides the branch order: an empty node's caret is **always** "at the end"
  //   (`getCaretOffset` is 0 and the plain length is 0), so an empty node with a following node takes the
  //   join branch above and is *not* deleted. The branch that deletes is only reached by a node with
  //   nothing after it. Asserted because it is easy to "fix" into the opposite and never notice.
  check('★★ an empty node with a following node joins it (the at-line-end branch matches first)',
    at({ textEmpty: true, atLineEnd: true }) === 'mergeNext',
    at({ textEmpty: true, atLineEnd: true }));
  // ★ The special case that made this subtle: for an empty node the caret is *always* "at the end", so the
  //   at-line-end branch matches first —— but there is no next node, so it must fall through to the empty branch.
  check('★★★ an empty **last** node is deleted, not left behind by the at-line-end branch',
    at({ textEmpty: true, atLineEnd: true, index: 2 }) === 'deleteNode',
    at({ textEmpty: true, atLineEnd: true, index: 2 }));
  check('★★ the last remaining node is never deleted —— there has to be somewhere to type',
    at({ textEmpty: true, atLineEnd: true, index: 0, visibleCount: 1 }) === 'none');
  check('★ whitespace-only text counts as empty (the caller trims), so it is still removed',
    at({ textEmpty: true, index: 0, visibleCount: 2 }) === 'deleteNode');
}

console.log('\n=== a node with content is never deleted by Delete ===');
{
  check('★★★ an empty node that **has children** is not deleted —— its subtree would go with it',
    at({ textEmpty: true, childCount: 2 }) !== 'deleteNode', at({ textEmpty: true, childCount: 2 }));
  check('★ it joins the next node instead, like any other non-empty node',
    at({ textEmpty: true, childCount: 2 }) === 'mergeNext', at({ textEmpty: true, childCount: 2 }));
  check('★★ and at the end of the line with nothing after it, nothing happens at all',
    at({ textEmpty: true, childCount: 2, atLineEnd: true, index: 2 }) === 'none',
    at({ textEmpty: true, childCount: 2, atLineEnd: true, index: 2 }));
}

console.log('\n=== the handler carries out the decision, and never lets the key reach the browser ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'outline', 'Outliner.tsx'), 'utf8');
  const calls = callSites(src, /^deleteKeyAction$/);
  // ★ The criterion is "the Delete key decides through this function, and at least one call site exists",
  //   not "there is exactly one". A pinned count cannot tell a new *correct* site from an unexpected one:
  //   adding a second handler that also routes through `deleteKeyAction` failed the old assertion, which is
  //   the same shape as the `focusCanvas` count this repository deleted and the `openTab` count next door.
  //   The behavioural half below is what actually defends the defect (preventDefault before acting), so this
  //   one only has to establish that the decision function is used at all.
  check('★★ the Delete key decides with deleteKeyAction() (at least one call site in this component)',
    calls.length >= 1, calls.join(', '));

  // ★ The defect reached the browser because the handler did not preventDefault on the falling-through path.
  // Read through `enclosingBody`, which strips comments: the block carries a long explanation of the defect,
  // and a pattern that had to step over it would be measuring comment length instead of code order.
  const deleteBlock = enclosingBody(src, 'const action = deleteKeyAction({');
  check('★ the Delete branch was located (precondition)', deleteBlock.length > 200, `len=${deleteBlock.length}`);
  check('★★★ every decided branch is carried out only after the native default is suppressed',
    /const action = deleteKeyAction\(\{[\s\S]{0,300}?\}\);[\s\S]{0,200}?e\.preventDefault\(\);[\s\S]{0,200}?if \(action === 'deleteNode'\)/.test(deleteBlock),
    'the browser must never perform its own forward-delete');
  check("★★ both non-trivial actions are handled ('deleteNode' and 'mergeNext')",
    deleteBlock.includes("if (action === 'deleteNode')") && deleteBlock.includes("if (action === 'mergeNext') mergeWithNext(id)"));
  check('★★ deleting hands focus to a neighbour so focus never dangles',
    /if \(action === 'deleteNode'\)[\s\S]{0,300}?focusReq\(next, 'end'\)/.test(deleteBlock));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
