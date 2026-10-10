// tree-ops pure-function tests.
//
// Why they are separate: `tree-ops.ts` is deliberately decoupled from React / the SiYuan SDK so that it can be tested
// outside the plugin environment (`mount.ts` imports 'siyuan' and JSX, so it cannot be tested).
// But until now there were **no tests at all** -- which is exactly why the "mind map cannot delete a top-level node" bug
// survived for so long. This file pins the deletion semantics down.
//
// Run: node .tmp/t27/out/plugin/tree-ops.test.js

import {
  addChild,
  addSibling,
  removeNode,
  removeNodes,
  countNodes,
  findNode,
  toggleCollapse,
} from './tree-ops';
import type { OutlineNode } from '../model/types';

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

const n = (id: string, children: OutlineNode[] = []): OutlineNode => ({
  id,
  modified: 0,
  text: `<span>${id}</span>`,
  children,
});

// ---------------------------------------------------------------- removeNode
//
// ★ Core regression: can a top-level node be deleted.
//
// The mind map view wraps the node tree in a **synthetic root** `__root__` (Mindmap.tsx),
// whose children are the real top-level nodes; and the context menu passes in a **real node id**.
// "Reject whenever the target is top-level" never applies to the synthetic root and only harms real nodes:
// when a document has a "first/second" node, deleting the "first" fails and reports "the root node cannot be deleted".

const twoRoots = [n('a'), n('b')];
const delA = removeNode(twoRoots, 'a');
check('★ several top-level nodes: the first can be deleted', delA !== null, `got=${delA}`);
check('★ only the second remains after deletion', delA !== null && delA.length === 1 && delA[0].id === 'b',
  JSON.stringify(delA?.map((x) => x.id)));
check('★ the original array is not mutated in place', twoRoots.length === 2, `len=${twoRoots.length}`);

// A single top-level node: deleting it would empty the document -> must be rejected
const oneRoot = [n('only')];
check('★ single top-level node: deletion is rejected', removeNode(oneRoot, 'only') === null);

// Deep node: can be deleted
const deep = [n('r', [n('c', [n('g')])])];
const delG = removeNode(deep, 'g');
check('a nested node can be deleted', delG !== null && findNode(delG!, 'g') === null);
check('deleting a nested node keeps its parent', delG !== null && findNode(delG!, 'c') !== null);

// Deleting a middle layer: the subtree goes with it
const delC = removeNode(deep, 'c');
check('deleting a middle layer removes the subtree too', delC !== null && findNode(delC!, 'c') === null && findNode(delC!, 'g') === null);
check('deleting a middle layer keeps the root', delC !== null && findNode(delC!, 'r') !== null);

// Target not found
check('a missing target returns null', removeNode(twoRoots, 'zzz') === null);

// The synthetic root __root__ is not in nodes -> it can never be deleted
check('★ the synthetic root __root__ cannot be deleted', removeNode(twoRoots, '__root__') === null);

// Immutability: deletion must not change the reference structure of untouched nodes (except the deleted path)
const immutable = [n('x'), n('y')];
const beforeX = immutable[0];
const afterDel = removeNode(immutable, 'y');
check('unaffected nodes keep the same reference', afterDel !== null && afterDel[0] === beforeX);

// ---------------------------------------------------------------- addChild
const added = addChild([n('p')], 'p', 'new1');
check('addChild appends under the target', added !== null && added[0].children.length === 1 && added[0].children[0].id === 'new1');
check('addChild __root__ appends at the top level', addChild([], '__root__', 'root1')?.length === 1);
check('addChild returns null when the target is missing', addChild([n('p')], 'nope', 'x') === null);
check('addChild does not mutate the original array', (() => {
  const base = [n('p')];
  addChild(base, 'p', 'k');
  return base[0].children.length === 0;
})());

// ---------------------------------------------------------------- addSibling
const sib = addSibling([n('p')], 'p', 's1');
check('addSibling inserts after the target', sib !== null && sib.length === 2 && sib[1].id === 's1',
  JSON.stringify(sib?.map((x) => x.id)));
check('addSibling __root__ appends at the top level', addSibling([], '__root__', 'root1')?.length === 1);
check('addSibling returns null when the target is missing', addSibling([n('p')], 'nope', 'x') === null);

// ---------------------------------------------------------------- Counting
check('countNodes includes descendants', countNodes(n('r', [n('a'), n('b', [n('c')])])) === 4);
check('countNodes with a single node', countNodes(n('solo')) === 1);

// ---------------------------------------------------------------- findNode
check('findNode finds a deep node', findNode([n('r', [n('c', [n('g')])])], 'g') !== null);
check('findNode returns null when not found', findNode([n('r')], 'zzz') === null);


// ═══════════════════════════════════════════════════════════
// removeNodes (bulk deletion, used by reverse sync)
// ═══════════════════════════════════════════════════════════
const N = (id: string, children: OutlineNode[] = []): OutlineNode => ({
  id, modified: 0, text: id, children,
});
const ids = (...xs: string[]): Set<string> => new Set(xs);

{
  const tree = [N('a', [N('a1'), N('a2')]), N('b'), N('c')];
  const r = removeNodes(tree, ids('b'));
  check('bulk delete of a single node', r !== null && r.map((n) => n.id).join() === 'a,c');
}
{
  const tree = [N('a'), N('b'), N('c')];
  const r = removeNodes(tree, ids('a', 'c'));
  check('bulk delete of several nodes', r !== null && r.map((n) => n.id).join() === 'b');
}
{
  const tree = [N('a', [N('a1', [N('a1x')])]), N('b')];
  const r = removeNodes(tree, ids('a1'));
  const a = r?.find((n) => n.id === 'a');
  check('bulk delete of a child node: descendants are removed with it', a !== undefined && (a.children ?? []).length === 0);
}
{
  const tree = [N('a'), N('b')];
  const r = removeNodes(tree, ids('zzz'));
  check('bulk delete of a nonexistent id: returns null', r === null);
}
{
  const tree = [N('a'), N('b')];
  const r = removeNodes(tree, ids());
  check('empty set: returns null', r === null);
}
{
  // ★ Key difference from removeNode: no root-node protection
  const tree = [N('only')];
  const r = removeNodes(tree, ids('only'));
  check('★ bulk delete can empty the whole tree (no root-node protection)', r !== null && r.length === 0);
}
{
  const tree = [N('a'), N('b')];
  const before = JSON.stringify(tree);
  removeNodes(tree, ids('a'));
  check('bulk delete does not modify the original tree (pure function)', JSON.stringify(tree) === before);
}
{
  const tree = [N('a', [N('b', [N('c')])])];
  const r = removeNodes(tree, ids('b'));
  check('bulk delete of a middle layer: parent kept, subtree removed', r !== null && (r[0].children ?? []).length === 0);
}


// ──────────────────────────────────────────────────────────────────
// Collapse granularity (corresponds to UI-TC-15 in agy)
// ──────────────────────────────────────────────────────────────────
//
// Dot click: without Alt -> collapse only itself; with Alt held -> recursively collapse the whole subtree.
// (`docs/SHORTCUTS.md` says "Alt+click recursively collapses/expands".)
//
// Two easy-to-get-wrong points are pinned down here:
//   · On recursive collapse the subtree must be set to **one single value**, not toggled node by node --
//     otherwise a "partially collapsed" tree flips upside down in one click, which the user cannot predict.
//   · Collapsing must **not** change the current view (zoomId) or the breadcrumb; it only hides child nodes.

{
  console.log('collapse: non-recursive affects only itself');
  const mk = () => [N('a', [N('a1', [N('a11')]), N('a2')]), N('b')];

  const t1 = mk();
  const n1 = toggleCollapse(t1, 'a', false);
  check('the number of changed nodes is 1', n1 === 1);
  check('the target is collapsed', t1[0].collapsed === true);
  check('★ children are unaffected (a1 stays expanded)', t1[0].children[0].collapsed !== true);
  check('★ grandchildren are unaffected (a11 stays expanded)', t1[0].children[0].children[0].collapsed !== true);
  check('siblings are unaffected', t1[1].collapsed !== true);

  // Click again to expand
  toggleCollapse(t1, 'a', false);
  check('clicking again restores expansion', t1[0].collapsed === false);
}

{
  console.log('collapse: recursion affects the whole subtree');
  const mk = () => [N('a', [N('a1', [N('a11')]), N('a2')]), N('b')];

  const t = mk();
  const n = toggleCollapse(t, 'a', true);
  check('the number of changed nodes is 4 (a/a1/a11/a2)', n === 4);
  check('the root is collapsed', t[0].collapsed === true);
  check('children are collapsed', t[0].children[0].collapsed === true);
  check('grandchildren are collapsed', t[0].children[0].children[0].collapsed === true);
  check('★ siblings (outside the subtree) are unaffected', t[1].collapsed !== true);

  // Click again: the whole subtree expands together
  toggleCollapse(t, 'a', true);
  check('clicking again expands the whole tree: root', t[0].collapsed === false);
  check('clicking again expands the whole tree: child', t[0].children[0].collapsed === false);
  check('clicking again expands the whole tree: grandchild', t[0].children[0].children[0].collapsed === false);
}

{
  console.log('collapse: on recursion the subtree takes one single value instead of toggling each node');
  // Build a "partially collapsed" tree: a expanded, a1 collapsed, a11 expanded
  const t = [N('a', [N('a1', [N('a11')]), N('a2')])];
  t[0].children[0].collapsed = true;
  // a11 is explicitly set to false (expanded)
  t[0].children[0].children[0].collapsed = false;

  // Collect the collapsed values of the whole subtree. The unknown hop exists to dodge TS literal narrowing --
  // after `t[0].collapsed = true` TS narrows the static type of that field to true,
  // so a later `=== false` is judged "necessarily false" and errors. Runtime behaviour is unaffected,
  // but the assertion is precisely about "what it became at runtime", so narrowing must be avoided here.
  const collapseValues = (nodes: OutlineNode[]): boolean[] => {
    const out: boolean[] = [];
    const walk = (x: OutlineNode) => {
      out.push(x.collapsed === true);
      x.children.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
  };

  toggleCollapse(t, 'a', true);
  // a was false -> toggled to true; the whole subtree should be true
  check('★ a partially collapsed tree becomes uniformly true after recursion',
    collapseValues(t).every((v) => v === true));

  // Reverse: a is true now -> recursing again should turn everything false
  toggleCollapse(t, 'a', true);
  check('★ recursing the other way turns everything uniformly false',
    collapseValues(t).every((v) => v === false));
}

{
  console.log('collapse: nothing changes when the target is not found');
  const t = [N('a', [N('a1')])];
  const before = JSON.stringify(t);
  const n = toggleCollapse(t, '不存在', true);
  check('returns 0', n === 0);
  check('★ the tree is completely unchanged (no node is touched by mistake)', JSON.stringify(t) === before);
}

{
  console.log('collapse: a leaf node can be collapsed too (no error, well-defined semantics)');
  const t = [N('leaf')];
  const n = toggleCollapse(t, 'leaf', true);
  check('recursive collapse of a leaf: 1 change', n === 1);
  check('the leaf is collapsed', t[0].collapsed === true);
}

{
  console.log('collapse: a deep target affects only its own subtree');
  const t = [N('root', [N('mid', [N('deep', [N('deeper')])])])];
  toggleCollapse(t, 'deep', true);
  check('root is unaffected', t[0].collapsed !== true);
  check('mid is unaffected', t[0].children[0].collapsed !== true);
  check('deep is collapsed', t[0].children[0].children[0].collapsed === true);
  check('deeper is collapsed too (it is inside the deep subtree)',
    t[0].children[0].children[0].children[0].collapsed === true);
}

{
  console.log('collapse: changes no field other than collapsed');
  const t: OutlineNode[] = [{
    id: 'a', modified: 123, text: '文字', children: [N('a1')],
    // these fields are often used by the view layer; collapsing must not touch them
    zoomId: undefined as unknown as string,
    heading: 2,
  } as OutlineNode];
  const textBefore = t[0].text;
  const modBefore = t[0].modified;
  const headBefore = t[0].heading;
  const kidsBefore = t[0].children.length;
  toggleCollapse(t, 'a', true);
  check('text is unchanged', t[0].text === textBefore);
  check('modified is unchanged (collapsing is not a content change)', t[0].modified === modBefore);
  check('heading is unchanged', t[0].heading === headBefore);
  check('children are not deleted (only hidden)', t[0].children.length === kidsBefore);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
