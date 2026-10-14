// ★★★ Addressing inside a table cell. Pure functions, no DOM and no React.
//
// ## Why a table needs its own addressing at all
//
// Every other editable thing in the outline is one node ↔ one `.node-text` element, so the
// `elMap` keyed by node id is enough. A table cell is **not** one of those:
//
//   • a cell's carrier is a `<td>`/`<th>` **inside the table block**, not a paragraph block of
//     its own, so the `elMap` node→element rule cannot hold it (`docs/todo/inline-markup-sync.md`
//     §3 D9, measured); and
//   • the cell is addressed by **(node, row, column)**, and the node id alone does not name it.
//
// So this file owns the key format and the four operations that can go wrong. Each one of them
// is a **data-loss** shape if it is wrong, which is why they are pinned here rather than inside
// the component:
//
//   • a mis-resolved key writes one cell's text over another's (silent corruption);
//   • an out-of-range index silently **grows** the table (`rows[99] = …`) and the kernel then
//     stores a ragged table;
//   • a write that reports "changed" when nothing changed makes every pass rewrite the block,
//     which is a transaction storm and a flashing re-read on every keystroke.
//
// `Tab` navigation belongs here too: it must **not** escape the table, because an editor that
// tabs out of the last cell into the document body writes the caret position into the next node.
//
// Runs offline: python3 scripts/run-tests.py table-cells

/** A cell address. `row === HEADER_ROW` is the header row. */
export interface TableCellRef {
  nodeId: string;
  row: number;
  col: number;
}

export const HEADER_ROW = -1;

/**
 * The key an element is registered under in the cell map.
 *
 * ★ The separator matters: it is a character that can never occur in a SiYuan block id (ids are
 *   `[0-9]{14}-[0-9a-z]{7}`), so `parseTableCellKey` cannot be fooled by an id that happens to
 *   contain a digit row/column.
 */
export function tableCellKey(nodeId: string, row: number, col: number): string {
  return `${nodeId}:${row}:${col}`;
}

/** The inverse of `tableCellKey`, or `null` when the key is not one. */
export function parseTableCellKey(key: string): TableCellRef | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [nodeId, row, col] = parts;
  if (!nodeId) return null;
  if (!/^-?\d+$/.test(row) || !/^-?\d+$/.test(col)) return null;
  return { nodeId, row: Number(row), col: Number(col) };
}

/** Read a cell. Out-of-range reads are `''`, never a throw and never a phantom write-back. */
export function readTableCell(table: { header: string[]; rows: string[][] }, row: number, col: number): string {
  if (col < 0) return '';
  if (row === HEADER_ROW) return table.header[col] ?? '';
  return table.rows[row]?.[col] ?? '';
}

/**
 * Write a cell **in place**. Returns whether anything actually changed.
 *
 * ★★ It writes only into an address that already exists. An out-of-range address is refused
 *   (`false`), because growing the table from a keystroke is how a ragged table reaches the
 *   kernel: `tableToKramdown` emits one separator per **header** cell, so a wider body row
 *   produces a table the reader cannot parse back.
 */
export function writeTableCell(
  table: { header: string[]; rows: string[][] },
  row: number,
  col: number,
  value: string,
): boolean {
  if (col < 0) return false;
  if (row === HEADER_ROW) {
    if (col >= table.header.length) return false;
    if (table.header[col] === value) return false;
    table.header[col] = value;
    return true;
  }
  const target = table.rows[row];
  if (!target || col >= target.length) return false;
  if (target[col] === value) return false;
  target[col] = value;
  return true;
}

/**
 * The cell `Tab` / `Shift+Tab` moves to, or `null` when the edge of the table is reached.
 *
 * Rows are walked **including** the header (`HEADER_ROW`), because a table whose header cannot be
 * reached by `Tab` is a table whose header cannot be corrected.
 */
export function nextTableCell(
  table: { header: string[]; rows: string[][] },
  row: number,
  col: number,
  forward: boolean,
): TableCellRef | null {
  const width = table.header.length;
  const height = table.rows.length;
  const total = height + 1;
  if (width <= 0 || total <= 0) return null;
  // A ref's row may be out of range (a row was removed elsewhere); clamp rather than refuse, so
  // `Tab` still lands somewhere instead of doing nothing.
  const totalCells = total * width;
  const inRange = row >= HEADER_ROW && row < HEADER_ROW + total && col >= 0 && col < width;
  // ★ `row − HEADER_ROW` and **not** `row + HEADER_ROW`: the header sits at −1, so adding would
  //   push it to −2 and wrap the whole walk. This is exactly the shape that makes `Tab` appear to
  //   work while repeating the last cell forever.
  const linear = (row - HEADER_ROW) * width + col;
  const clamped = Math.min(Math.max(linear, 0), totalCells - 1);
  const next = forward ? clamped + 1 : clamped - 1;
  if (next < 0 || next >= totalCells) {
    // At a real edge the caret must stay in the table (`null` tells the caller not to move).
    // From an address that is **not** a real cell there is no edge to respect, so the nearest
    // valid cell is the answer —— otherwise a row removed by another client strands the caret and
    // the user cannot `Tab` back into the table to repair it.
    return inRange ? null : { nodeId: '', row: Math.floor(clamped / width) + HEADER_ROW, col: clamped % width };
  }
  return { nodeId: '', row: Math.floor(next / width) + HEADER_ROW, col: next % width };
}
