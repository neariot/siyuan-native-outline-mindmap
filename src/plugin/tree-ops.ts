/**
 * Pure operations on the node tree (add child node / sibling node).
 *
 * Why it is a separate file: these are pure functions that do not depend on React or the SiYuan SDK,
 * so they can be unit-tested outside the plugin environment (`mount.ts` imports 'siyuan' and JSX, so it cannot be tested).
 */
import type { OutlineNode } from '../model/types';

/** Append an empty child node under a node; returns null when the target is not found */
export function addChild(
  nodes: OutlineNode[],
  parentId: string,
  newId: string,
): OutlineNode[] | null {
  if (parentId === '__root__') {
    return [...nodes, { id: newId, modified: Date.now(), text: '', children: [] }];
  }
  let touched = false;
  const walk = (list: OutlineNode[]): OutlineNode[] =>
    list.map((n) => {
      if (n.id === parentId) {
        touched = true;
        const kids = n.children ?? [];
        return {
          ...n,
          children: [...kids, { id: newId, modified: Date.now(), text: '', children: [] }],
        };
      }
      if (n.children?.length) {
        const kids = walk(n.children);
        return kids === n.children ? n : { ...n, children: kids };
      }
      return n;
    });
  const next = walk(nodes);
  return touched ? next : null;
}

/** Insert an empty sibling node after a node; returns null when the target is not found */
export function addSibling(
  nodes: OutlineNode[],
  afterId: string,
  newId: string,
): OutlineNode[] | null {
  if (afterId === '__root__') {
    return [...nodes, { id: newId, modified: Date.now(), text: '', children: [] }];
  }
  let touched = false;
  const walk = (list: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const n of list) {
      out.push(n);
      if (n.id === afterId) {
        touched = true;
        out.push({ id: newId, modified: Date.now(), text: '', children: [] });
        continue;
      }
      if (n.children?.length) {
        const kids = walk(n.children);
        if (kids !== n.children) out[out.length - 1] = { ...n, children: kids };
      }
    }
    return out;
  };
  const next = walk(nodes);
  return touched ? next : null;
}

/** Find a node by ID; returns null when not found */
export function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Delete a node (together with its subtree); returns null when the target is not found.
 *
 * ★ On the "root node is not deletable" semantics (correction):
 *
 * The original implementation was "reject whenever the target is a **top-level** node". The intent of that rule was to prevent
 * emptying the whole document, but it **hurt by mistake** documents with several top-level nodes:
 *   when a document has two top-level nodes "first / second", deleting "first" was rejected,
 *   showing "The root node cannot be deleted" —— while "second" is equally top-level, with no difference.
 *   Confirmed by measurement (mind map right-click → delete node → confirm dialog → click OK → failure).
 *
 * The root cause is that the mind map view wraps the node tree in a **synthetic root** `__root__`
 * (`Mindmap.tsx`'s rootNode, whose id is fixed to `'__root__'` and whose children are the real top-level nodes),
 * while what the context menu passes in is a **real node id**, which is never `'__root__'`.
 * So the "reject top-level" rule never applied to the synthetic root, only to real nodes —— pure collateral damage.
 *
 * The correct semantics: **reject only the case where no top-level node would be left after the deletion**
 * (that really does equal emptying the document), rather than rejecting all top-level nodes.
 * That way the synthetic root `__root__` still cannot be deleted (it is not in nodes and `touched` is false),
 * and documents with several top-level nodes can be deleted normally.
 */
export function removeNode(nodes: OutlineNode[], id: string): OutlineNode[] | null {
  // The target is the only top-level node → deleting it leaves nothing, equal to emptying the document, so reject
  if (nodes.length === 1 && nodes[0]?.id === id) return null;
  let touched = false;
  const walk = (list: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const n of list) {
      if (n.id === id) {
        touched = true;
        continue;
      }
      if (n.children?.length) {
        const kids = walk(n.children);
        if (kids !== n.children) {
          out.push({ ...n, children: kids });
          continue;
        }
      }
      out.push(n);
    }
    return out;
  };
  const next = walk(nodes);
  return touched ? next : null;
}

/**
 * Delete nodes in bulk (by a set of ids).
 *
 * Use: **reverse sync** —— when the user deletes some list items in SiYuan, remove the matching nodes from the tree
 * in one go. Two differences from `removeNode`:
 * 1. Several deletions at once, rebuilding the tree only once (avoiding N renders)
 * 2. **No "root node protection"** —— an external deletion is a fact, the block is already gone in SiYuan;
 *    rejecting at that point because "only one node would be left" would make the UI inconsistent with SiYuan.
 *    Emptying into an empty tree is the correct result (the UI shows the empty state).
 *
 * Returns the new tree; if none of the targets is in the tree, returns `null` (callers skip rendering then).
 */
export function removeNodes(nodes: OutlineNode[], ids: Set<string>): OutlineNode[] | null {
  if (!ids.size) return null;
  let touched = false;
  const walk = (list: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const n of list) {
      if (ids.has(n.id)) {
        touched = true;
        continue;
      }
      if (n.children?.length) {
        const kids = walk(n.children);
        if (kids !== n.children) {
          out.push({ ...n, children: kids });
          continue;
        }
      }
      out.push(n);
    }
    return out;
  };
  const next = walk(nodes);
  return touched ? next : null;
}

/** Count the total number of nodes (including itself and all descendants) */
export function countNodes(node: OutlineNode): number {
  let n = 1;
  for (const c of node.children ?? []) n += countNodes(c);
  return n;
}

/**
 * Collapse / expand a node (corresponds to UI-TC-15 in agy).
 *
 * Two granularities:
 *   - `recursive = false`: change **only** this one node. Its subtree is kept as is,
 *     so expanding does not lose the hierarchy.
 *   - `recursive = true`: set the **whole subtree** to the same value.
 *     Used for "recursive collapse" —— expanding opens everything at once instead of level by level.
 *
 * ★ Why the whole subtree must be set to the **same value** instead of blindly negating:
 *   If "each node negates its own value" were allowed, a "partially collapsed" tree would turn after Alt+click into
 *   an upside-down state (expanded ones collapsed, collapsed ones expanded), which the user cannot predict at all.
 *   Setting everything to `!the root node's current value` is the semantics of "collapse all / expand all with one click".
 *
 * ★ Key behavior (locked in by tests, and the regression UI-TC-15 really guards against):
 *   Collapsing does **not** change the current view (zoomId) or the breadcrumb —— it only hides the child nodes.
 *   This function touches only the `collapsed` field and no other state, which the signature guarantees:
 *   it takes and returns the node tree, with no other entry point that could change the view.
 *
 * @param nodes root list (**modified in place**; callers usually already hold a draft or make a shallow copy)
 * @param id target node id; when not found, returns unchanged and changes nothing
 * @param recursive whether to recurse into the whole subtree
 * @returns the number of nodes actually changed (0 means the target was not found).
 *          Callers can use it to tell whether "this click took effect" and avoid needless re-renders.
 */
export function toggleCollapse(
  nodes: OutlineNode[],
  id: string,
  recursive: boolean,
): number {
  const target = findNode(nodes, id);
  if (!target) return 0;
  const value = !target.collapsed;
  if (!recursive) {
    target.collapsed = value;
    return 1;
  }
  let n = 0;
  const walk = (x: OutlineNode): void => {
    x.collapsed = value;
    n++;
    x.children.forEach(walk);
  };
  walk(target);
  return n;
}
