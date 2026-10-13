// Pure mathematical Tree Reconciler.
//
// Computes structural and content differences between two tree states without any host I/O.
// Decouples outline/mindmap editing intent from host block mutations.

import { cloneNodes, collectIds, findNode } from '../model/tree';
import type { OutlineNode } from '../model/types';

export type TreePatch =
  | {
      type: 'insert';
      node: OutlineNode;
      parentId: string | null;
      prevSiblingId: string | null;
    }
  | {
      type: 'remove';
      nodeId: string;
    }
  | {
      type: 'move';
      nodeId: string;
      parentId: string | null;
      prevSiblingId: string | null;
    }
  | {
      type: 'updateText';
      nodeId: string;
      text: string;
    }
  | {
      type: 'updateParagraphs';
      nodeId: string;
      paragraphs: string[];
    }
  | {
      type: 'setTaskStatus';
      nodeId: string;
      taskStatus: number;
    }
  | {
      type: 'setNumbering';
      nodeId: string;
      numbered: boolean;
    }
  | {
      type: 'setHeading';
      nodeId: string;
      heading?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    };

interface NodeHierarchyInfo {
  node: OutlineNode;
  parentId: string | null;
  prevSiblingId: string | null;
}

/**
 * Builds a map from node ID to its parent ID and preceding sibling ID in the tree.
 */
function buildHierarchyMap(nodes: OutlineNode[]): Map<string, NodeHierarchyInfo> {
  const map = new Map<string, NodeHierarchyInfo>();

  function walk(list: OutlineNode[], parentId: string | null): void {
    let prevSiblingId: string | null = null;
    for (const node of list) {
      map.set(node.id, { node, parentId, prevSiblingId });
      if (node.children?.length) {
        walk(node.children, node.id);
      }
      prevSiblingId = node.id;
    }
  }

  walk(nodes, null);
  return map;
}

/**
 * Computes a list of discrete `TreePatch` operations that transform `baseline` into `target`.
 *
 * Algorithm order:
 * 1. Removals: nodes present in baseline but missing in target (pruning top-level detached roots).
 * 2. Structural mutations:
 *    - Insertions: brand new subtrees not present in baseline.
 *    - Moves: nodes present in both whose parent or preceding sibling shifted.
 * 3. Content and attribute updates: text, attached paragraphs, task status, numbering, heading.
 */
export function diffTrees(baseline: OutlineNode[], target: OutlineNode[]): TreePatch[] {
  const patches: TreePatch[] = [];

  const baseMap = buildHierarchyMap(baseline);
  const targetMap = buildHierarchyMap(target);

  const baseIds = collectIds(baseline);
  const targetIds = collectIds(target);

  // 1. Identify removed nodes. Emit removals only for highest ancestor to avoid duplicate deletes.
  const removedIds = new Set<string>();
  for (const id of baseIds) {
    if (!targetIds.has(id)) {
      removedIds.add(id);
    }
  }

  for (const id of removedIds) {
    const info = baseMap.get(id);
    // If the parent is also removed, the child is implicitly removed with the parent subtree
    if (!info?.parentId || !removedIds.has(info.parentId)) {
      patches.push({ type: 'remove', nodeId: id });
    }
  }

  // 2. Insertions & Moves: follow target hierarchy order
  const insertedIds = new Set<string>();
  for (const id of targetIds) {
    if (!baseIds.has(id)) {
      insertedIds.add(id);
    }
  }

  // We emit insertions for top-level inserted roots (the subtree is carried within the node)
  for (const id of insertedIds) {
    const info = targetMap.get(id);
    if (!info) continue;
    if (!info.parentId || !insertedIds.has(info.parentId)) {
      patches.push({
        type: 'insert',
        node: cloneNodes([info.node])[0],
        parentId: info.parentId,
        prevSiblingId: info.prevSiblingId,
      });
    }
  }

  // 3. Moves for existing nodes
  for (const [id, targetInfo] of targetMap.entries()) {
    if (insertedIds.has(id)) continue;
    const baseInfo = baseMap.get(id);
    if (!baseInfo) continue;

    const parentChanged = baseInfo.parentId !== targetInfo.parentId;
    const siblingChanged = baseInfo.prevSiblingId !== targetInfo.prevSiblingId;

    if (parentChanged || siblingChanged) {
      patches.push({
        type: 'move',
        nodeId: id,
        parentId: targetInfo.parentId,
        prevSiblingId: targetInfo.prevSiblingId,
      });
    }
  }

  // 4. Content and attribute updates for nodes present in both
  for (const [id, targetInfo] of targetMap.entries()) {
    if (insertedIds.has(id)) continue;
    const baseInfo = baseMap.get(id);
    if (!baseInfo) continue;

    const b = baseInfo.node;
    const t = targetInfo.node;

    if (b.text !== t.text) {
      patches.push({ type: 'updateText', nodeId: id, text: t.text });
    }

    const bParas = b.paragraphs ?? [];
    const tParas = t.paragraphs ?? [];
    if (JSON.stringify(bParas) !== JSON.stringify(tParas)) {
      patches.push({ type: 'updateParagraphs', nodeId: id, paragraphs: [...tParas] });
    }

    if ((b.taskStatus ?? 0) !== (t.taskStatus ?? 0)) {
      patches.push({ type: 'setTaskStatus', nodeId: id, taskStatus: t.taskStatus ?? 0 });
    }

    if (!!b.numbered !== !!t.numbered) {
      patches.push({ type: 'setNumbering', nodeId: id, numbered: !!t.numbered });
    }

    if (b.heading !== t.heading) {
      patches.push({ type: 'setHeading', nodeId: id, heading: t.heading });
    }
  }

  return patches;
}

/**
 * Applies a sequence of `TreePatch` operations to an existing tree in memory.
 * Returns a new tree reflecting all modifications.
 */
export function applyTreePatches(tree: OutlineNode[], patches: TreePatch[]): OutlineNode[] {
  const result = cloneNodes(tree);

  function detachNode(list: OutlineNode[], id: string): OutlineNode | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list.splice(i, 1)[0];
      }
      const hit = detachNode(list[i].children, id);
      if (hit) return hit;
    }
    return null;
  }

  function insertInto(
    list: OutlineNode[],
    node: OutlineNode,
    parentId: string | null,
    prevSiblingId: string | null,
  ): boolean {
    if (!parentId) {
      // Top-level root insert
      if (!prevSiblingId) {
        list.unshift(node);
      } else {
        const idx = list.findIndex((n) => n.id === prevSiblingId);
        if (idx !== -1) {
          list.splice(idx + 1, 0, node);
        } else {
          list.push(node);
        }
      }
      return true;
    }

    const parent = findNode(list, parentId);
    if (!parent) return false;

    if (!prevSiblingId) {
      parent.children.unshift(node);
    } else {
      const idx = parent.children.findIndex((n) => n.id === prevSiblingId);
      if (idx !== -1) {
        parent.children.splice(idx + 1, 0, node);
      } else {
        parent.children.push(node);
      }
    }
    return true;
  }

  for (const patch of patches) {
    switch (patch.type) {
      case 'remove': {
        detachNode(result, patch.nodeId);
        break;
      }
      case 'insert': {
        insertInto(result, cloneNodes([patch.node])[0], patch.parentId, patch.prevSiblingId);
        break;
      }
      case 'move': {
        const detached = detachNode(result, patch.nodeId);
        if (detached) {
          insertInto(result, detached, patch.parentId, patch.prevSiblingId);
        }
        break;
      }
      case 'updateText': {
        const target = findNode(result, patch.nodeId);
        if (target) {
          target.text = patch.text;
        }
        break;
      }
      case 'updateParagraphs': {
        const target = findNode(result, patch.nodeId);
        if (target) {
          target.paragraphs = [...patch.paragraphs];
        }
        break;
      }
      case 'setTaskStatus': {
        const target = findNode(result, patch.nodeId);
        if (target) {
          target.taskStatus = patch.taskStatus;
        }
        break;
      }
      case 'setNumbering': {
        const target = findNode(result, patch.nodeId);
        if (target) {
          target.numbered = patch.numbered;
        }
        break;
      }
      case 'setHeading': {
        const target = findNode(result, patch.nodeId);
        if (target) {
          target.heading = patch.heading;
        }
        break;
      }
    }
  }

  return result;
}
