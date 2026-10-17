/**
 * Regression tests for bulk indent / outdent (corresponds to UI-TC-16 in agy).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this test exists
 * ──────────────────────────────────────────────────────────────────
 *
 * These two operations used to be inlined in the `mutate` callback of `Outliner.tsx`, untestable.
 * Extracted into `indent.ts`, they can be unit-tested offline.
 *
 * ──────────────────────────────────────────────────────────────────
 * Whether multi-select indent is a "staircase" or "flattening" -- SiYuan is the reference
 * ──────────────────────────────────────────────────────────────────
 *
 * Pressing Tab with [A, B, C] selected at the same level has two possible semantics:
 *
 *     staircase (this plugin's implementation)      flattening (old implementation)
 *       A                            A
 *         B                            B
 *           C                          C
 *
 * The old implementation was "front to back, attaching each item under its previous sibling", which yields **flattening**:
 *     1. A is the first -> skip
 *     2. B attaches under A -> the list becomes [A([B]), C]
 *     3. C's "previous sibling" is now A (B is no longer at this level) -> C also attaches under A
 *
 * SiYuan's own approach (`siyuan-src/app/src/protyle/wysiwyg/list.ts:756-770`,
 * `listIndent`) is: iterate over the selected items, maintaining a `previousID` whose initial value is **the previous item's
 * id**, and at the end of each round set the item just handled as the next round's `previousID` --
 * so item 2 attaches under item 1 and item 3 under item 2, yielding a **staircase**.
 *
 * This plugin therefore processes "back to front", matching SiYuan.
 */

export {};

import type { OutlineNode } from '../../model/types';
import { indentNodes, outdentNodes, topLevelSelected } from './indent';

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

const N = (id: string, ...children: OutlineNode[]): OutlineNode =>
  ({ id, modified: 0, text: id, children }) as OutlineNode;

/**
 * Render the tree as indented text, to make structural assertions easy.
 * For example [A([B([C])])] -> "A > B > C" (each > means one level of nesting)
 */
const sketch = (nodes: OutlineNode[]): string => {
  const out: string[] = [];
  const walk = (x: OutlineNode, path: string[]) => {
    out.push([...path, x.id].join(' > '));
    x.children.forEach((c) => walk(c, [...path, x.id]));
  };
  nodes.forEach((n) => walk(n, []));
  return out.join(' | ');
};

const idsOf = (nodes: OutlineNode[]): string[] => {
  const out: string[] = [];
  const walk = (x: OutlineNode) => {
    out.push(x.id);
    x.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

// ──────────────────────────────────────────────────────────────────
console.log('top-level filtering (nested items in a multi-selection must not be processed twice)');

{
  // Selecting [A, A's child B]: B must not be treated as an independent item -- when A indents, B follows naturally.
  // Indenting B as well would turn B into a **sibling** of A, the opposite of the "indent together" intent.
  const t = [N('A', N('B'))];
  const tops = topLevelSelected(t, ['A', 'B']);
  check('★ when an ancestor is selected, its descendants are filtered out', tops.length === 1 && tops[0] === 'A');
}

{
  const t = [N('A'), N('B'), N('C')];
  const tops = topLevelSelected(t, ['A', 'B', 'C']);
  check('all three items at the same level are kept', tops.length === 3);
  check('the original order is kept', tops.join() === 'A,B,C');
}

{
  // Deep nesting: A > B > C, selecting only C -> C is a top-level item (no ancestor is selected)
  const t = [N('A', N('B', N('C')))];
  const tops = topLevelSelected(t, ['C']);
  check('when no ancestor is selected, a deep node counts as top-level itself', tops.join() === 'C');
}

{
  const t = [N('A', N('B', N('C')))];
  const tops = topLevelSelected(t, ['A', 'C']);
  check('★ only the outermost A remains, C is filtered out', tops.join() === 'A');
}

{
  const t = [N('A', N('B', N('C')))];
  const tops = topLevelSelected(t, ['B', 'C']);
  check('★ selecting [B,C] keeps only B', tops.join() === 'B');
}

{
  const t = [N('A')];
  check('empty selection -> empty', topLevelSelected(t, []).length === 0);
  check('nonexistent id -> empty', topLevelSelected(t, ['空节点一']).length === 0);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ multi-select indent is a "staircase", not "flattening" (aligned with SiYuan listIndent)');

{
  const t = [N('A'), N('B'), N('C')];
  const n = indentNodes(t, ['A', 'B', 'C']);
  // A is the first sibling and cannot indent; B and C each indent once
  check('2 indents happen (A is the first and cannot indent)', n === 2);
  check('★ the resulting structure is the staircase A > B > C', sketch(t) === 'A | A > B | A > B > C');
  check('the tree still has 3 nodes (none lost)', idsOf(t).length === 3);
}

{
  // Contrast with the wrong "front to back" approach: that yields A > B, A > C (flattening)
  const t = [N('A'), N('B'), N('C')];
  indentNodes(t, ['A', 'B', 'C']);
  const flat = sketch(t);
  check('★ not flattened (A must not have B and C as two direct siblings under it)', flat !== 'A | A > B | A > C');
  check('★ the parent of C is B (not A)', flat.includes('A > B > C'));
}

{
  // Select all in a four-level list
  const t = [N('1'), N('2'), N('3'), N('4')];
  indentNodes(t, ['1', '2', '3', '4']);
  check('★ selecting all four levels -> 1 > 2 > 3 > 4',
    sketch(t) === '1 | 1 > 2 | 1 > 2 > 3 | 1 > 2 > 3 > 4');
}

// ──────────────────────────────────────────────────────────────────
console.log('\nsingle indent: attach under the previous sibling');

{
  const t = [N('A'), N('B')];
  indentNodes(t, ['B']);
  check('B becomes a child node of A', sketch(t) === 'A | A > B');
}

{
  const t = [N('A'), N('B')];
  const n = indentNodes(t, ['A']);
  check('★ the first sibling cannot indent (there is no previous sibling)', n === 0);
  check('the structure is unchanged', sketch(t) === 'A | B');
}

{
  const t = [N('A', N('A1')), N('B')];
  indentNodes(t, ['B']);
  check('B attaches under A and becomes a sibling of A1', sketch(t) === 'A | A > A1 | A > B');
}

{
  console.log('  indenting expands the target parent (otherwise collapsed children stay hidden and look like they "vanished")');
  const t = [N('A'), N('B')];
  const a = t[0];
  a.collapsed = true;
  indentNodes(t, ['B']);
  // TS narrows the static type of `a.collapsed` to the literal true (it was just assigned true),
  // so `=== false` is judged "necessarily false" and errors. Of course it can change at runtime.
  // Launder the value through a function returning boolean to dodge narrowing
  // (a plain `const x: boolean` alias is NOT enough — narrowing pierces aliases).
  const readBool = (v: boolean): boolean => v;
  check('★ the parent node is expanded', readBool(a.collapsed) === false);
}

// ──────────────────────────────────────────────────────────────────
console.log('\noutdent: insert after the parent, becoming the next sibling of the parent');

{
  const t = [N('A', N('B'))];
  const n = outdentNodes(t, ['B']);
  check('1 outdent happens', n === 1);
  check('★ B becomes a sibling of A (A > B is split apart)', sketch(t) === 'A | B');
}

{
  const t = [N('A', N('B'))];
  const n = outdentNodes(t, ['A']);
  check('★ the root node cannot be outdented', n === 0);
  check('the structure is unchanged', sketch(t) === 'A | A > B');
}

{
  // A > B > C, outdent C by one level -> A > C, B  (C becomes the next sibling of B)
  const t = [N('A', N('B', N('C')))];
  outdentNodes(t, ['C']);
  check('★ C is detached from B and becomes a sibling of B', sketch(t) === 'A | A > B | A > C');
}

{
  // Multi-select outdent: A > [B, C, D]
  const t = [N('A', N('B'), N('C'), N('D'))];
  outdentNodes(t, ['B', 'C', 'D']);
  check('★ all three are detached from A and become siblings of A', sketch(t) === 'A | B | C | D');
}

{
  // A > [B, C], outdent only C
  const t = [N('A', N('B'), N('C'))];
  outdentNodes(t, ['C']);
  check('only C moves: A > B stays, C becomes a sibling of A', sketch(t) === 'A | A > B | C');
}

// ──────────────────────────────────────────────────────────────────
console.log('\nboundaries and invariants');

{
  const t = [N('A'), N('B')];
  const before = JSON.stringify(t);
  indentNodes(t, []);
  check('empty selection: nothing is changed', JSON.stringify(t) === before);
  check('empty selection: returns 0', indentNodes(t, []) === 0);
}

{
  const t = [N('A'), N('B')];
  check('missing target: returns 0', indentNodes(t, ['zzz']) === 0);
}

{
  console.log('  indent / outdent lose no node (multi-select is where nodes are most easily dropped)');
  const t = [N('A'), N('B'), N('C'), N('D')];
  const before = idsOf(t).sort().join();
  indentNodes(t, ['A', 'B', 'C', 'D']);
  check('★ the node count is unchanged after indenting', idsOf(t).length === 4);
  check('★ the id set is unchanged after indenting', idsOf(t).sort().join() === before);
  outdentNodes(t, ['B', 'C', 'D']);
  check('★ the node count is still unchanged after outdenting', idsOf(t).length === 4);
  check('★ the id set is still unchanged after outdenting', idsOf(t).sort().join() === before);
}

{
  console.log('  indenting updates modified (which triggers a write back to SiYuan)');
  const t = [N('A'), N('B')];
  const b = t[1];
  const before = b.modified;
  indentNodes(t, ['B']);
  // ★ Note: after indenting, B is **no longer at t[1]** (it moved into t[0].children),
  //   so the assertion must hold the original object reference; do not fetch it back via t[1] -- that slot
  //   is empty now. This pitfall was hit once while writing the assertion.
  check('★ the moved node shows a changed modified', b.modified !== before);
  check('B really was moved away (t[1] is now empty)', t.length === 1);
}

{
  console.log('  outdenting changes no field other than position');
  const t = [N('A', N('B'))];
  t[0].children[0].text = '文字内容';
  outdentNodes(t, ['B']);
  check('text is preserved (outdenting loses no content)', t[1].text === '文字内容');
}

{
  console.log('  idempotence: two indents should form two levels instead of cancelling each other out');
  const t = [N('A'), N('B'), N('C')];
  indentNodes(t, ['A', 'B', 'C']);
  const once = sketch(t);
  // Indent the currently deepest node C once more: C has no previous sibling left (it is already at the head), so nothing should change
  indentNodes(t, ['C']);
  check('indenting a node that is already at the head -> no change', sketch(t) === once);
}

// ── Tables and code blocks are ordinary nodes: they nest like anything else ──
//
//   They used to be refused, on the claim that "a `NodeList` cannot contain a table / a code block"
//   —— measured against the running kernel on 2026-10-16, **false for both**:
//   `insertBlock` with `parentID` = a list item creates a `NodeTable` and a `NodeCodeBlock` inside
//   it, and the exported markdown shows them nested (`docs/kernel-api.md` §7.17). The real blocker
//   had been **our writer**, which anchored every such block at the document root; it now anchors by
//   the block's place in the tree, so the level change is writable and these cases must pass.
{
  console.log('  a table indents like any node, and so does a code block');
  const T = (id: string): OutlineNode =>
    ({ id, modified: 0, text: '', table: { header: ['a', 'b'], rows: [['1', '2']] }, children: [] }) as OutlineNode;
  const C = (id: string): OutlineNode =>
    ({ id, modified: 0, text: '', codeBlock: { lang: '', code: 'x' }, children: [] }) as OutlineNode;

  const t1 = [N('A'), T('T')];
  indentNodes(t1, ['T']);
  check('★★ a table indents under its previous sibling', sketch(t1) === 'A | A > T', sketch(t1));
  check('★ and the table is really a child, not only a sibling', t1[0].children.length === 1);
  check('★★ the table keeps its own cells', t1[0].children[0].table?.header.join(',') === 'a,b');

  const t2 = [N('A'), C('C')];
  indentNodes(t2, ['C']);
  check('★★ a code block indents like any node', sketch(t2) === 'A | A > C', sketch(t2));
  check('★ and it keeps its source', t2[0].children[0].codeBlock?.code === 'x');

  // ★★ The control: the refusal that is left is the **first sibling**, a property of the list, and
  //   it must still apply to every kind —— otherwise "nothing is refused" would be the new bug.
  const t3 = [T('T0'), N('A')];
  indentNodes(t3, ['T0']);
  check('★★ the first sibling still cannot indent, whatever kind it is', sketch(t3) === 'T0 | A', sketch(t3));

  // ...and outdenting brings a table back to the top level.
  const t4 = [N('A', T('T')), N('B')];
  outdentNodes(t4, ['T']);
  check('★★ a nested table outdents back beside its parent', sketch(t4) === 'A | T | B', sketch(t4));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
