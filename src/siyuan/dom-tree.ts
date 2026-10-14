/**
 * Parses the block tree structure out of SiYuan's native DOM (the HTML returned by /api/block/getBlockDOM).
 *
 * Why this is needed:
 * 1. SiYuan's SQLite database is indexed asynchronously; a block just created or moved lags by 1-3 seconds, so SQL queries easily come back empty.
 * 2. The blocks table in SQLite has no sibling-order column (the sort field is always 20 and only encodes the block type).
 * 3. The kernel's in-memory AST / getBlockDOM is synchronous, live, and absolutely authoritative about order.
 */

export interface BlockTreeState {
  /** listItem block ID -> ID of the first paragraph block (NodeParagraph) under it */
  itemToParagraph: Map<string, string>;
  /** listItem block ID -> ID of the child list (NodeList) under it */
  itemToChildList: Map<string, string>;
  /** block ID -> parent block ID (AST hierarchy membership) */
  parentOf: Map<string, string>;
  /** parent block ID -> array of child block IDs (strictly in document order) */
  childrenOf: Map<string, string[]>;
  /** set of all live block IDs in the document */
  aliveIds: Set<string>;
  /** top-level list container ID (the first NodeList hanging directly off the document root) */
  topListId: string;
  /** listItem block ID -> task state (1: not done, 2: done) */
  itemTaskStatus: Map<string, number>;
  /**
   * Document-root **table** block IDs, in document order.
   *
   * ★ A table is not a list item: it has no `NodeListItem`, so none of the tables above can
   *   hold it. Measured — the kernel stores a table with `parent_id` = the document and block
   *   type `t`, and writing one inside a paragraph's inline DOM is stored as `<protyle-html>`.
   *   Without this list a table in a document is invisible to the whole write path.
   */
  rootTableIds: string[];
  /** when the document has no list at all, the ID of SiYuan's default empty paragraph block under the document root (cleaned up when the first node is inserted) */
  emptyRootParagraphs: string[];
}

/**
 * Parses the HTML fragment returned by getBlockDOM.
 *
 * @param domHtml The full HTML returned by SiYuan
 * @param rootDocId The document root block ID
 */
export function parseDomToTree(domHtml: string, rootDocId: string): BlockTreeState {
  const itemToParagraph = new Map<string, string>();
  const itemToChildList = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const aliveIds = new Set<string>();
  const itemTaskStatus = new Map<string, number>();
  const rootTableIds: string[] = [];
  let topListId = '';

  if (!domHtml) {
    return {
      itemToParagraph,
      itemToChildList,
      parentOf,
      childrenOf,
      aliveIds,
      topListId,
      itemTaskStatus,
      rootTableIds,
      emptyRootParagraphs: [],
    };
  }

  // Scan all <div ...>, <div> and </div>
  const tokenRe = /<div(?:\s+([^>]*?))?>|<\/div>/g;
  const stack: Array<{ id: string; type: string }> = [{ id: rootDocId, type: 'NodeDocument' }];

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(domHtml)) !== null) {
    if (m[0] === '</div>') {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      const attrs = m[1];
      const idMatch = /data-node-id="([^"]+)"/.exec(attrs);
      const typeMatch = /data-type="([^"]+)"/.exec(attrs);

      if (idMatch && typeMatch) {
        const id = idMatch[1];
        const type = typeMatch[1];
        aliveIds.add(id);

        if (type === 'NodeListItem' && attrs) {
          const taskMatch = /data-task="([^"]*)"/.exec(attrs);
          if (taskMatch) {
            itemTaskStatus.set(id, taskMatch[1].trim() ? 2 : 1);
          }
        }

        // Find the nearest real block on top of the stack (skipping non-block inner divs)
        let parentIdx = stack.length - 1;
        while (parentIdx >= 0 && !stack[parentIdx].id) {
          parentIdx--;
        }
        const parent = parentIdx >= 0 ? stack[parentIdx] : { id: rootDocId, type: 'NodeDocument' };

        parentOf.set(id, parent.id);

        let sibs = childrenOf.get(parent.id);
        if (!sibs) {
          sibs = [];
          childrenOf.set(parent.id, sibs);
        }
        sibs.push(id);

        if (parent.type === 'NodeListItem') {
          if (type === 'NodeParagraph' && !itemToParagraph.has(parent.id)) {
            itemToParagraph.set(parent.id, id);
          } else if (type === 'NodeList' && !itemToChildList.has(parent.id)) {
            itemToChildList.set(parent.id, id);
          }
        }

        if (type === 'NodeList' && (parent.type === 'NodeDocument' || parent.id === rootDocId)) {
          if (!topListId) topListId = id;
        }

        // ★ A root-level table: measured, the kernel hangs it off the document, never off a
        //   NodeList, and it is the only thing here that has no listItem parent.
        if (type === 'NodeTable' && (parent.type === 'NodeDocument' || parent.id === rootDocId)) {
          rootTableIds.push(id);
        }

        stack.push({ id, type });
      } else {
        // Non-block div, such as <div class="protyle-action"> or <div contenteditable="true">
        stack.push({ id: '', type: '' });
      }
    }
  }

  const emptyRootParagraphs: string[] = [];
  if (!topListId) {
    const rootKids = childrenOf.get(rootDocId) ?? [];
    for (const kid of rootKids) {
      const kidRe = new RegExp(
        `<div\\s+[^>]*data-node-id="${kid}"[^>]*data-type="NodeParagraph"[^>]*>([\\s\\S]*?)<\\/div>(?=(?:<div\\s+[^>]*data-node-id=|$))`,
      );
      const km = kidRe.exec(domHtml);
      if (km) {
        const textMatch = /<div\s+[^>]*contenteditable="true"[^>]*>([\s\S]*?)<\/div>/.exec(km[1]);
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').replace(/\u200b/g, '').trim() : '';
        if (!text) {
          emptyRootParagraphs.push(kid);
        }
      }
    }
  }

  return {
    itemToParagraph,
    itemToChildList,
    parentOf,
    childrenOf,
    aliveIds,
    topListId,
    itemTaskStatus,
    rootTableIds,
    emptyRootParagraphs,
  };
}
