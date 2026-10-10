/**
 * Render a node tree into **SiYuan native block DOM** (without going through markdown).
 *
 * ────────────────────────────────────────────────────────────────
 * Why this module exists (conclusion after reading the SiYuan source)
 * ────────────────────────────────────────────────────────────────
 *
 * The kernel's `kernel/api/block_op.go` insertBlock / appendBlock accept only two
 * `dataType` values, and the two paths work completely differently:
 *
 * ```go
 * if "markdown" == dataType {
 *     data, err = dataBlockDOM(data, luteEngine)   // parsed as markdown by Lute first
 * }
 * // when dataType == "dom", handed to PerformBlockOperation as-is
 * ```
 *
 * Both paths end up in `BlockDOM2Tree(data)` at `transaction.go:1704`,
 * but the **markdown path has an extra markdown parsing step**, so it inherits markdown's
 * paragraph semantics:
 *
 * ```go
 * // lute/parse/paragraph.go:22
 * func ParagraphContinue(p, context) int {
 *     if context.blank { return 1 }   // blank line → paragraph ends
 *     return 0                         // otherwise this line joins the current paragraph
 * }
 * ```
 *
 * In other words, on the markdown path an "attachment paragraph" **must be preceded by a blank line**, otherwise it is merged into the
 * first paragraph (the content is not lost, but the paragraph boundary is). The **dom path has no markdown parsing**:
 * a paragraph is given explicitly by `<div data-type="NodeParagraph">`, one div is one paragraph,
 * and **there is no blank-line/indent semantics**.
 *
 * So this module produces block DOM directly, so that "one node = listItem, one paragraph = NodeParagraph"
 * map one to one, entirely free of blank lines.
 *
 * ────────────────────────────────────────────────────────────────
 * Two shape constraints that must be respected (both were hit before)
 * ────────────────────────────────────────────────────────────────
 *
 * 1. **Complete hierarchy**: it must be `NodeList > NodeListItem > NodeParagraph`.
 *    Giving only `NodeListItem` does not work —— `doInsert0` takes
 *    `subTree.Root.FirstChild`; without the outer container the child blocks are lost.
 *
 * 2. **Every block needs a valid `data-node-id`** (`yyyyMMddHHmmss-7 chars`).
 *    With an empty ID the structure in the `.sy` file is actually correct, but the listItem / paragraph **has no ID**,
 *    so neither SQL nor `getChildBlocks` can find it, and it looks like "the subtree vanished into thin air".
 */
import type { OutlineNode } from '../model/types';
import { htmlToSiyuanDom, makeSiyuanId } from './map';

/** SiYuan's empty block-level attribute div; the editor uses it to hold block icons/counters and other decorations */
const PROTYLE_ATTR = '<div class="protyle-attr" contenteditable="false"></div>';

/** The bullet on the left of a list item (dot/checkbox is decided by CSS from data-subtype) */
const PROTYLE_ACTION =
  '<div class="protyle-action" draggable="true">' +
  '<svg><use xlink:href="#iconDot"></use></svg>' +
  '</div>';

/**
 * The **checkbox** on the left of a task list item.
 *
 * ★ This was once written wrong (corrected by measurement). SiYuan's task marker is **not** a
 * div with `data-type="NodeTaskListItemMarker"`; it is expressed by
 * **the `protyle-action--task` icon** plus **the listItem's own `data-task` attribute**
 * together; on the Lute side this corresponds to `protyle.go:1620`:
 *
 * ```go
 * if ast.NodeListItem == tree.Context.Tip.Type && atom.Input == n.DataAtom {
 *     node.Type = ast.NodeTaskListItemMarker
 *     node.ReviveFromDataTask(util.DomAttrValue(n, "data-task"), lute.hasAttr(n, "checked"))
 * }
 * ```
 *
 * The correct shape (taken from the kernel `getBlockDOM`'s real output):
 * ```
 * <div data-marker="*" data-subtype="t" data-task=" " data-type="NodeListItem" class="li">
 *   <div class="protyle-action protyle-action--task" draggable="true">
 *     <svg><use xlink:href="#iconUncheck"></use></svg>
 *   </div>
 *   <div data-type="NodeParagraph" class="p">…</div>
 * </div>
 * ```
 * A to-do uses `data-task=" "` + `#iconUncheck`;
 * A completed one uses `data-task="X"` + `#iconCheck` + the class `protyle-task--done` appended.
 */
function taskAction(done: boolean): string {
  return (
    '<div class="protyle-action protyle-action--task" draggable="true">' +
    `<svg><use xlink:href="#icon${done ? 'Check' : 'Uncheck'}"></use></svg>` +
    '</div>'
  );
}

/** One paragraph block; an empty paragraph must be produced too, otherwise the paragraph boundary is lost */
function paragraphDom(html: string): string {
  const id = makeSiyuanId();
  // An empty paragraph gets a zero-width placeholder: SiYuan does not keep a completely empty paragraph body
  const inner = htmlToSiyuanDom(html) || '\u200b';
  return (
    `<div data-node-id="${id}" data-type="NodeParagraph" class="p">` +
    `<div contenteditable="true" spellcheck="false">${inner}</div>` +
    PROTYLE_ATTR +
    '</div>'
  );
}

/** One list item: first paragraph → attachment paragraphs → (optional) child list */
function listItemDom(n: OutlineNode, children: string): string {
  const id = makeSiyuanId();
  // Task state: 1 = to-do, 2 = done (matches the OutlineNode.taskStatus convention)
  const isTask = n.taskStatus === 1 || n.taskStatus === 2;
  const done = n.taskStatus === 2;

  const parts: string[] = [isTask ? taskAction(done) : PROTYLE_ACTION];
  parts.push(paragraphDom(n.text ?? ''));
  for (const p of n.paragraphs ?? []) parts.push(paragraphDom(p));
  if (children) parts.push(children);
  parts.push(PROTYLE_ATTR);

  // A task list item's subtype is "t" (task); that is what makes the kernel turn it into a task state
  const subtype = isTask ? 't' : 'u';
  const cls = isTask && done ? 'li protyle-task--done' : 'li';
  const taskAttr = isTask ? ` data-task="${done ? 'X' : ' '}"` : '';
  return (
    `<div data-marker="*" data-subtype="${subtype}"${taskAttr}` +
    ` data-node-id="${id}" data-type="NodeListItem" class="${cls}">${parts.join('')}</div>`
  );
}

/**
 * Node tree → SiYuan native **block DOM** string.
 *
 * It produces a complete `NodeList`, which can be handed straight to
 * `/api/block/appendBlock` (`dataType: 'dom'`) for insertion.
 *
 * ⚠️ A list item's own block ID is generated anew by this function every time —— node identity relies on
 * `refreshMapsAfterCreate` aligning by order afterwards (see `store.ts`).
 */
export function treeToBlockDom(nodes: OutlineNode[]): string {
  const renderList = (list: OutlineNode[]): string => {
    const items = list.map((n) => {
      const kids = n.children?.length ? renderList(n.children) : '';
      return listItemDom(n, kids);
    });
    const id = makeSiyuanId();
    // ★ If **every sibling is a task list item**, the whole list's subtype must also be "t",
    //   otherwise the kernel does not treat it as a task list (a mixed list may be treated as non-task).
    const allTask = list.length > 0 && list.every((n) => n.taskStatus === 1 || n.taskStatus === 2);
    const subtype = allTask ? 't' : 'u';
    return (
      `<div data-subtype="${subtype}" data-node-id="${id}" data-type="NodeList" class="list">` +
      items.join('') +
      PROTYLE_ATTR +
      '</div>'
    );
  };
  return renderList(nodes);
}

/** The DOM of a single paragraph block (for `insertParagraphAfter`) */
export function paragraphBlockDom(html: string): string {
  return paragraphDom(html);
}
