// The tree primitives every layer shares: finding, flattening, removing, and asking whether a node is
// inside another node's subtree.
//
// ★ `containsNode` / `anyContains` exist because **two** call sites had grown their own version of the
//   cycle question and disagreed on one point: whether the node itself counts. The outline's drop guard
//   built a Set that added the moving node before walking its children (so "itself" was included); the
//   mount's reparent guard walked only `children` (so it was not). Measured against `a > b > c`, both still
//   refused and allowed the same drops —— because each site reaches "target is the node itself" by a
//   different route, the outline through its descendant set and the mount through an earlier
//   `ids.filter((i) => i !== targetId)`. The divergence was invisible, and invisible is not the same as
//   harmless: a third caller copying either one would enforce the safety rule in one view and not the
//   other. One function, one answer, and this file pins the answer.

import { flattenAll, flattenVisible, findNode, findPath, removeNode, containsNode, anyContains, flatNodes, collectIds } from './tree';
import type { OutlineNode } from './types';

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

/** A node with the fields the type requires, so a fixture cannot drift out of shape silently. */
const mk = (id: string, children: OutlineNode[] = []): OutlineNode => ({
  id,
  modified: 0,
  text: id,
  children,
});
/** A tree shaped `a > (b > c, d)`. */
const leaf = (id: string): OutlineNode => mk(id);
const tree = (): OutlineNode[] => [mk('a', [mk('b', [leaf('c')]), leaf('d')])];

// ---- findNode ----
{
  check('findNode: finds a root', findNode(tree(), 'a')?.id === 'a');
  check('findNode: finds a nested node', findNode(tree(), 'c')?.id === 'c');
  check('findNode: reports null for an absent id', findNode(tree(), 'zz') === null);
  check('findNode: an empty list is not a crash', findNode([], 'a') === null);
}

// ---- flattenAll / flattenVisible ----
{
  check('flattenAll: every node, roots first, depth-first',
    flattenAll(tree()).map((e) => e.node.id).join(',') === 'a,b,c,d');
  check('flattenAll: records the depth',
    flattenAll(tree()).map((e) => e.depth).join(',') === '0,1,2,1');
  check('flattenAll: records the parent',
    flattenAll(tree()).find((e) => e.node.id === 'c')?.parent?.id === 'b');
  check('flattenAll: records the index among siblings',
    flattenAll(tree()).find((e) => e.node.id === 'd')?.index === 1);

  const folded = tree();
  folded[0].children[0].collapsed = true;
  check('flattenVisible: hides the subtree of a folded node',
    flattenVisible(folded).map((e) => e.node.id).join(',') === 'a,b,d',
    `got=${flattenVisible(folded).map((e) => e.node.id).join(',')}`);
}

// ---- findPath ----
{
  check('findPath: returns the chain to a nested node',
    findPath(tree(), 'c')?.map((n) => n.id).join(',') === 'a,b,c');
  check('findPath: null when absent', findPath(tree(), 'zz') === null);
}

// ---- removeNode ----
{
  const t = tree();
  const gone = removeNode(t, 'b');
  check('removeNode: returns the removed subtree with its children intact',
    gone?.id === 'b' && gone.children.length === 1 && gone.children[0].id === 'c',
    `got=${JSON.stringify(gone && { id: gone.id, kids: gone.children.map((c) => c.id) })}`);
  check('removeNode: the node is gone from the tree',
    findNode(t, 'b') === null && findNode(t, 'c') === null);
  check('removeNode: its siblings stay', findNode(t, 'a') !== null && findNode(t, 'd') !== null);
  check('removeNode: null for an absent id', removeNode(tree(), 'zz') === null);
}

// ---- containsNode / anyContains: the cycle question, in one place ----
{
  const a = findNode(tree(), 'a')!;
  const b = findNode(tree(), 'b')!;

  check('containsNode: the node itself counts', containsNode(a, 'a') === true);
  check('containsNode: a direct child counts', containsNode(a, 'b') === true);
  check('containsNode: a grandchild counts', containsNode(a, 'c') === true);
  check('containsNode: an unrelated id does not', containsNode(a, 'z') === false);
  check('containsNode: a leaf contains only itself', containsNode(b, 'd') === false);
  check('containsNode: a deeper node does not contain its ancestor', containsNode(b, 'a') === false);
  check('containsNode: a leaf reports itself', containsNode(b, 'b') === true);

  check('anyContains: finds a node nested under a root', anyContains(tree(), 'c') === true);
  check('anyContains: the root itself counts', anyContains(tree(), 'a') === true);
  check('anyContains: false for an absent id', anyContains(tree(), 'z') === false);
  check('anyContains: an empty list is not a crash', anyContains([], 'a') === false);

  // ★ The two refusals the drop guards rely on. Both must be true, and it must not matter which call site
  //   asks —— that is the property the two hand-written versions could not guarantee.
  const sub = findNode(tree(), 'b')!;
  check('a drop of b onto c is refused (descendant)', containsNode(sub, 'c') === true);
  check('a drop of b onto b is refused (itself)', containsNode(sub, 'b') === true);
  check('a drop of b onto d is allowed (a sibling)', containsNode(sub, 'd') === false);
}

// ---- collectIds: "which node ids are in this tree" -----------------------------------------------
//
// `mount.ts` collected these for the "what still exists" probe before a deletion, `store.ts` for the set a
// prune reads. Both hand-rolled; the first needed a `?? []` guard because it is called with a possibly-unset
// ref, so the two carried different assumptions about their input.
{
  check('collectIds: every id, depth-first',
    [...collectIds(tree())].join(',') === 'a,b,c,d');
  check('collectIds: undefined is an empty set, not a crash', collectIds(undefined).size === 0);
  check('collectIds: null is an empty set, not a crash', collectIds(null).size === 0);
  check('collectIds: an empty list is an empty set', collectIds([]).size === 0);
  check('collectIds: a node with no children array still contributes its id',
    collectIds([{ id: 'solo', modified: 0, text: 'solo' } as OutlineNode]).has('solo'));
  check('collectIds: a duplicate id collapses (it is a Set)',
    collectIds([mk('x'), mk('x')]).size === 1);
}

// ---- flatNodes: the one flatten five call sites used to hand-roll -------------------------------
//
// `mount.ts` (twice), `store.ts` (twice) and `core/map.ts` each had their own copy of this walk. They were
// measured equivalent —— chain, wide tree, empty list, a node with no `children` key, five-deep —— so this
// pins that equivalence rather than the shape of any one copy.
{
  check('flatNodes: depth-first, parents before children',
    flatNodes(tree()).map((n) => n.id).join(',') === 'a,b,c,d');
  check('flatNodes: a wide tree keeps sibling order',
    flatNodes([mk('x'), mk('y'), mk('z')]).map((n) => n.id).join(',') === 'x,y,z');
  check('flatNodes: an empty list is empty',
    flatNodes([]).length === 0);
  check('flatNodes: a node with no children array is still listed',
    flatNodes([{ id: 'solo', modified: 0, text: 'solo' } as OutlineNode]).map((n) => n.id).join(',') === 'solo');
  check('flatNodes: a five-deep chain is fully walked',
    flatNodes([mk('1', [mk('2', [mk('3', [mk('4', [mk('5')])])])])]).map((n) => n.id).join(',') === '1,2,3,4,5');
  check('flatNodes: ignores fold state (that is flattenVisible\'s job)',
    (() => { const t = tree(); t[0].children[0].collapsed = true; return flatNodes(t).length === 4; })());
  // The optional accumulator is what two call sites relied on.
  {
    const acc: OutlineNode[] = [];
    const got = flatNodes(tree(), acc);
    check('flatNodes: extends a supplied accumulator', acc.length === 4 && got === acc);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
