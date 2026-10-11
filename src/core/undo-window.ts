/**
 * The undo **merge window**: whether a change joins the previous undo step or starts a new one.
 *
 * ★ Extracted from `mount.ts` so its boundaries can be pinned. The criterion is what decides whether Ctrl+Z
 *   steps back one user action or several, and it was measured wrong in both directions:
 *
 *   · continuous typing must **merge** —— otherwise Ctrl+Z walks back one character at a time;
 *   · a structural operation (indent, move, delete, format) must **not** merge, because each one is a
 *     separate decision the user made. Measured: 3 Tab indents 500 ms apart produced **one** undo point, so a
 *     single Ctrl+Z undid all three.
 *
 *   The criterion used to be "same node id + within 1.2 seconds", which cannot tell those two apart; `kind`
 *   is what does. It lives here, rather than inline in the change handler, because a rule that decides how
 *   much a single Ctrl+Z takes back has to be testable on its own.
 */

/** How long continuous typing keeps joining one undo step. */
export const UNDO_MERGE_MS = 1200;

export interface UndoWindowState {
  /** What kind of change this is. `'struct'` is a structural operation; anything else is text-like. */
  kind: 'struct' | 'text' | undefined;
  /** Key of the change (usually node id + field). An empty key means "never merges". */
  mergeKey: string;
  /** Key of the window that is still open. */
  lastKey: string;
  /** How long ago that window was opened or last refreshed. */
  elapsedMs: number;
}

/**
 * Whether this change joins the open window.
 *
 * A structural operation never does: for it the window is neither reused nor refreshed, so every such
 * operation pushes its own undo point.
 */
export function joinsUndoWindow(s: UndoWindowState): boolean {
  if (s.kind === 'struct') return false;
  if (!s.mergeKey) return false;
  return s.lastKey === s.mergeKey && s.elapsedMs < UNDO_MERGE_MS;
}
