/**
 * Batch indent / outdent (corresponds to UI-TC-16 in agy).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this is a separate module
 * ──────────────────────────────────────────────────────────────────
 *
 * These two operations used to be inlined in `Outliner.tsx`'s `mutate` callback, depending on React state
 * and `flattenAll(draft)`, so they could only be tested together with a browser. But they are essentially **pure tree operations** ——
 * extracting them allows offline unit tests and makes "what a multi-selection actually does" readable.
 *
 * ──────────────────────────────────────────────────────────────────
 * Key rule for multi-selection: act only on "top-level selected items"
 * ──────────────────────────────────────────────────────────────────
 *
 * If the user selects `[A, A's child B]` at once, **do not** indent both ——
 * B already sits under A, and when A indents B has already moved with it. Indenting B again turns it
 * into a **sibling** of A, the exact opposite of the user's "indent them together" intent.
 *
 * So `topLevelSelected` runs first: it filters out items whose ancestor is also selected,
 * keeping only the topmost ones in the selection.
 *
 * ──────────────────────────────────────────────────────────────────
 * Indent semantics: attach under the **previous sibling**
 * ──────────────────────────────────────────────────────────────────
 *
 * Indenting is **not** "attach under the parent" (that is already the current situation, so nothing would change),
 * it means "become the last child of the previous sibling" —— which is exactly what
 * the Tab key conventionally means in an outline editor. The first sibling has no "previous sibling", so it cannot be indented
 * (skipped when `findIndex <= 0`).
 *
 * Outdent is the opposite: detach it from the parent and insert it **after the parent**,
 * becoming the parent's next sibling. A root node has no parent, so it cannot be outdented.
 */

import type { OutlineNode } from '../../model/types';
import { flattenAll } from '../../model/tree';

/**
 * Filter the "top-level items" out of the selection: items whose ancestor is also selected are dropped.
 *
 * The original order is preserved (no sorting) —— callers usually process in click order,
 * and the order affects "who becomes whose child" (see the notes on `indentNodes`).
 *
 * ★ It also filters out **ids that do not exist in the tree**.
 *   Without this filter, `flattenAll` cannot find the id → `parent` is undefined →
 *   the `while` is never entered → the function returns `true`, so a ghost id counts as a "valid top-level item"
 *   and stays in the return value. Downstream skips it because location fails, but the function **lies**:
 *   from the return value the caller cannot tell which ids can actually be acted on.
 *   In a multi-selection (the selection may come from an earlier render, the node may already be deleted elsewhere)
 *   this situation really happens.
 */
export function topLevelSelected(nodes: OutlineNode[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  // Build the flat table once —— every id below needs repeated parent-chain lookups,
  // re-running flattenAll each time is a wasteful O(n²) (noticeable with dozens of items selected).
  const flat = flattenAll(nodes);
  const parentOf = new Map<string, OutlineNode | null>();
  for (const e of flat) parentOf.set(e.node.id, e.parent ?? null);

  return ids.filter((id) => {
    // Id not present in the tree —— a ghost id, filtered out right here (see the notes above)
    if (!parentOf.has(id)) return false;
    let parent = parentOf.get(id) || null;
    while (parent) {
      if (set.has(parent.id)) return false;
      parent = parentOf.get(parent.id) || null;
    }
    return true;
  });
}

/** Locate a node's parent and its sibling list in the tree */
const locate = (
  nodes: OutlineNode[],
  id: string,
): { list: OutlineNode[]; idx: number; parent: OutlineNode | null } | null => {
  const entry = flattenAll(nodes).find((e) => e.node.id === id);
  if (!entry) return null;
  const list = entry.parent ? entry.parent.children : nodes;
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  return { list, idx, parent: entry.parent };
};

/**
 * Batch indent: each top-level selected item attaches under its **previous sibling**.
 *
 * ★ Why the processing goes **back to front**:
 *   Given siblings [A, B, C], the user selects all and presses Tab, expecting all three to become "children of the
 *   item above" ——
 *
 *       A            A
 *       B      →       B
 *       C                C
 *
 *   If processing **front to back** one item at a time:
 *     1. A is first, idx=0, skipped;
 *     2. B indents under A → the list becomes [A([B]), C];
 *     3. C's "previous sibling" is now A (B is no longer at this level),
 *        so C also attaches under A → C and B become siblings instead of C sitting under B.
 *
 *   Back to front is correct:
 *     1. C indents under B → [A, B([C])];
 *     2. B indents under A → [A([B([C])])];
 *     3. A is first, skipped.
 *
 *   That is the stair-step indentation the user wants.
 *
 * @param nodes The tree (**modified in place**; the caller usually already holds the draft)
 * @param ids Selected node ids (may include non-top-level items; they are filtered internally first)
 * @returns How many indents actually happened (0 means none moved —— e.g. all are first siblings)
 */
export function indentNodes(nodes: OutlineNode[], ids: readonly string[]): number {
  const tops = topLevelSelected(nodes, ids);
  if (tops.length === 0) return 0;

  // First compute the id list in "back to front" order. Note that every operation changes the tree structure,
  // so parent/index cannot be cached up front —— every step must locate them again.
  let done = 0;
  for (let i = tops.length - 1; i >= 0; i--) {
    const loc = locate(nodes, tops[i]);
    if (!loc) continue;
    const { list, idx } = loc;
    // The first sibling has no "previous sibling" to attach to, so it cannot be indented
    if (idx <= 0) continue;
    const [moved] = list.splice(idx, 1);
    const prev = list[idx - 1];
    // ★ A table is a block of its own and cannot become a child: measured, the kernel hangs a
    //   table off the document and refuses it inside a `NodeList`. Leaving it where it is is
    //   the only correct answer -- and it is silent either way, so it is stated here.
    //   ★ A code block is the same shape (a root-level block, no listItem), so it is refused by
    //   the same rule rather than a second one beside it -- one condition, two block kinds.
    if (prev.table || moved.table || prev.codeBlock || moved.codeBlock) {
      list.splice(idx, 0, moved);
      continue;
    }
    prev.children.push(moved);
    // ★ After attaching, the previous sibling must be expanded, otherwise the child is hidden by the collapsed state,
    //   and the user will think "I pressed Tab but the node disappeared".
    prev.collapsed = false;
    moved.modified = Date.now();
    done++;
  }
  return done;
}

/**
 * Batch outdent: every top-level selected item is detached from its parent and inserted **after the parent**,
 * becoming the parent's next sibling.
 *
 * ★ Order: **back** to front.
 *   Same reasoning as indent —— processing later items does not change the relative position of earlier ones.
 *   If outdent ran front to back, an item detached first gets inserted after its parent,
 *   which may change the parent/index location of later items.
 *
 * @returns How many outdents actually happened (0 means all were root nodes that cannot be outdented)
 */
export function outdentNodes(nodes: OutlineNode[], ids: readonly string[]): number {
  const tops = topLevelSelected(nodes, ids);
  if (tops.length === 0) return 0;

  let done = 0;
  for (let i = tops.length - 1; i >= 0; i--) {
    const loc = locate(nodes, tops[i]);
    if (!loc || !loc.parent) continue; // a root node cannot be outdented
    const { list, idx, parent } = loc;
    const [moved] = list.splice(idx, 1);
    moved.modified = Date.now();
    // Insert after the parent (becoming the parent's next sibling)
    const ploc = locate(nodes, parent.id);
    const plist = ploc ? ploc.list : nodes;
    const pIdx = ploc ? ploc.idx : nodes.findIndex((x) => x.id === parent.id);
    plist.splice(pIdx + 1, 0, moved);
    done++;
  }
  return done;
}
