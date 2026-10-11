/**
 * What the **Delete** key does to the node the caret is in.
 *
 * ★ Extracted from the outline's key handler so the branch order can be pinned. The order is the whole point,
 *   and it was measured wrong: the handler had only two paths (caret at the end of the line → join the next
 *   node; multi-selection → delete), so **a single selection with the caret not at the end of the line** fell
 *   through to the browser's native forward-delete —— the text was removed while the node stayed:
 *
 *     measured (click a node, press Home, press Delete):
 *       UI:     ['A','B','C'] → ['A','','C']   ← empty shell
 *       SiYuan: ['A','B','C'] → ['A','','C']   ← persisted, too
 *
 *   and pressing Delete again could not remove it either (for an empty node "caret at the end" is true, so it
 *   took the join branch and swallowed the **next** node instead).
 *
 *   Delete is now symmetric with Backspace: an empty leaf is removed outright, anything else joins the next
 *   node. `atLineEnd` is decided by the caller (it needs the DOM), everything else is pure.
 */

export type DeleteKeyAction =
  /** join this node's text with the next node's */
  | 'mergeNext'
  /** remove the node itself */
  | 'deleteNode'
  /** handled (the key must not reach the browser), but nothing changes */
  | 'none';

export interface DeleteKeyState {
  /** The caret is at or past the end of this node's text. */
  atLineEnd: boolean;
  /** This node's text is empty (whitespace does not count). */
  textEmpty: boolean;
  /** How many children this node has. */
  childCount: number;
  /** Where this node sits among the visible nodes, and how many are visible. */
  index: number;
  visibleCount: number;
}

export function deleteKeyAction(s: DeleteKeyState): DeleteKeyAction {
  const hasNext = s.index < s.visibleCount - 1;

  // At the end of the line with something after it: join the next node. This is checked first, so a node that
  // is empty but *has* children also reaches it (a node with content must never be removed by Delete).
  if (s.atLineEnd && hasNext) return 'mergeNext';

  // An empty leaf goes away entirely. The last remaining node is kept: there has to be one node to type in.
  if (s.textEmpty && s.childCount === 0) return s.visibleCount > 1 ? 'deleteNode' : 'none';

  // Not empty and not at the line end: take over the next node's text, like Backspace does backwards.
  if (hasNext) return 'mergeNext';

  return 'none';
}
