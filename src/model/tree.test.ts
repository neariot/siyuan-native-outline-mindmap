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

import { flattenAll, flattenVisible, findNode, findPath, removeNode, containsNode, anyContains } from './tree';
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

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
