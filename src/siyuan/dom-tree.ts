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
   * Every **table** block ID in the document, in document order —— at any depth.
   *
   * ★ It began as "document-root table IDs", because that was all a table could be: no `NodeListItem`,
   *   `parent_id` = the document, block type `t` (and writing one inside a paragraph's inline DOM is
   *   stored as `<protyle-html>`). **That is no longer the only place one can live** —— measured on
   *   the running kernel (2026-10-16), `insertBlock` with `parentID` = a list item creates a
   *   `NodeTable` inside it, and a user can write the same in SiYuan's own editor.
   *
   *   Why the list exists at all: a table has no list item and no paragraph, so **no list table above
   *   can hold it** —— at any level. Without this list the write path is blind to one, and a blind
   *   table is worse than an unreadable one: `syncStructure` inserts a **second copy** beside it, and
   *   `syncDeletions` deletes the original.
   */
  tableIds: string[];
  /**
   * Every **code block** ID in the document, in document order —— at any depth.
   *
   * ★ It began as "document-root code block IDs", because that was all a code block could be: a
   *   `NodeCodeBlock` with no listItem, hung off the document. **That is no longer the only place one
   *   can live** —— measured against the running kernel, `insertBlock` with `parentID` = a list item
   *   creates a `NodeCodeBlock` inside it, and a user can write the same in SiYuan's own editor. So
   *   the list is collected at any depth, and the name says what it holds.
   *
   *   Why the list is needed at all: no list table above can hold a code block (it has no listItem
   *   and no paragraph), so without it the write path is blind to one —— and a blind block is worse
   *   than an unreadable one: `syncStructure` judges it "new in the UI" and inserts a **second copy**
   *   beside the original, while `syncDeletions` deletes the original.
   */
  codeBlockIds: string[];
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
  const tableIds: string[] = [];
  const codeBlockIds: string[] = [];
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
      tableIds,
      codeBlockIds,
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

        // ★★ A **table**, collected wherever it lives.
        //
        //   A table has no `NodeListItem` and no `NodeParagraph`, so it cannot appear in any of the
        //   maps above — whether it hangs off the document or sits inside a list item (measured: both
        //   are creatable, and a user can write the nested one in SiYuan's editor). Hence **no depth
        //   condition**: every one of them has to reach the writer.
        if (type === 'NodeTable') {
          tableIds.push(id);
        }

        // ★★ A **code block**, collected wherever it lives.
        //
        //   Measured against the running kernel: a code block is
        //   `<div data-type="NodeCodeBlock" class="code-block">`, hung off the document when it is a
        //   document-level block —— no listItem and no paragraph, so none of the tables above can
        //   hold it. It can equally live **inside a list item** (`insertBlock` with `parentID` = a
        //   list item produces one, and the user can write the same in SiYuan's own editor), and it
        //   stays invisible to every list table there too. Hence **no depth condition**: each of them
        //   has to reach the writer, at any level.
        if (type === 'NodeCodeBlock') {
          codeBlockIds.push(id);
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
    tableIds,
    codeBlockIds,
    emptyRootParagraphs,
  };
}
