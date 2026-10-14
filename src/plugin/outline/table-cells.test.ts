// ★ Cell addressing, pinned offline. The four operations in `table-cells.ts` are each a
//   data-loss shape if wrong; see that file for why none of them belongs inside the component.
//
// Runs offline: python3 scripts/run-tests.py table-cells

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableData } from '../../model/types';
import {
  HEADER_ROW,
  nextTableCell,
  parseTableCellKey,
  readTableCell,
  tableCellKey,
  writeTableCell,
} from './table-cells';

const T = (): TableData => ({ header: ['a', 'b'], rows: [['1', '2'], ['3', '4']] });

test('a key round-trips, header row included', () => {
  for (const [row, col] of [
    [HEADER_ROW, 0],
    [HEADER_ROW, 1],
    [0, 0],
    [1, 1],
  ] as const) {
    const ref = parseTableCellKey(tableCellKey('20260101120000-abcdefg', row, col));
    assert.deepEqual(ref, { nodeId: '20260101120000-abcdefg', row, col });
  }
});

test('a key that is not a cell address does not resolve', () => {
  // ★ A plain node id must NOT parse: the cell map and the node map are keyed differently, and a
  //   key that answered for both would let a node edit land in a cell.
  assert.equal(parseTableCellKey('20260101120000-abcdefg'), null);
  assert.equal(parseTableCellKey('a:1'), null);
  assert.equal(parseTableCellKey('a:1:2:3'), null);
  assert.equal(parseTableCellKey('a:x:2'), null);
  assert.equal(parseTableCellKey(':1:2'), null);
});

test('reads cover the header, the body, and everything past the edge', () => {
  const t = T();
  assert.equal(readTableCell(t, HEADER_ROW, 1), 'b');
  assert.equal(readTableCell(t, 1, 0), '3');
  // Out of range reads as empty, so a stale element shows '' instead of throwing.
  assert.equal(readTableCell(t, 9, 0), '');
  assert.equal(readTableCell(t, 0, 9), '');
  assert.equal(readTableCell(t, HEADER_ROW, 9), '');
  assert.equal(readTableCell(t, 0, -1), '');
});

test('a write into an existing cell changes the table and reports it', () => {
  const t = T();
  assert.equal(writeTableCell(t, 1, 1, 'x'), true);
  assert.equal(t.rows[1][1], 'x');
  assert.equal(writeTableCell(t, HEADER_ROW, 0, 'z'), true);
  assert.equal(t.header[0], 'z');
});

test('a write that changes nothing reports no change', () => {
  // ★★ Otherwise every pass rewrites the whole table block: a transaction per keystroke, and a
  //   re-read that blanks the panel each time.
  const t = T();
  assert.equal(writeTableCell(t, 0, 0, '1'), false);
  assert.equal(writeTableCell(t, HEADER_ROW, 1, 'b'), false);
});

test('a write past the edge is refused and never grows the table', () => {
  // ★★★ The data-loss shape: `tableToKramdown` emits one separator cell per **header** cell, so a
  //   wider body row produces a table `parseTableLines` cannot read back —— the table survives the
  //   session and is unreadable after the reload.
  const t = T();
  assert.equal(writeTableCell(t, 0, 5, 'x'), false);
  assert.equal(writeTableCell(t, 5, 0, 'x'), false);
  assert.equal(writeTableCell(t, HEADER_ROW, 5, 'x'), false);
  assert.equal(writeTableCell(t, 0, -1, 'x'), false);
  assert.deepEqual(t, T());
});

test('Tab walks the header then every row, and stops at the edges', () => {
  const t = T();
  // header(2) + 2 rows x 2 = 6 cells
  let at = { row: HEADER_ROW, col: 0 };
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    seen.push(`${at.row},${at.col}`);
    const n = nextTableCell(t, at.row, at.col, true);
    if (!n) break;
    at = n;
  }
  assert.deepEqual(seen, ['-1,0', '-1,1', '0,0', '0,1', '1,0', '1,1']);
  // ★ Past the last cell there is no next cell, so the caret stays in the table rather than
  //   jumping into the document body and being written into the next node.
  assert.equal(nextTableCell(t, 1, 1, true), null);
  assert.equal(nextTableCell(t, HEADER_ROW, 0, false), null);
});

test('Shift+Tab walks back, and wraps nothing', () => {
  const t = T();
  assert.deepEqual(nextTableCell(t, 1, 1, false), { nodeId: '', row: 1, col: 0 });
  assert.deepEqual(nextTableCell(t, 0, 0, false), { nodeId: '', row: HEADER_ROW, col: 1 });
  assert.deepEqual(nextTableCell(t, HEADER_ROW, 1, true), { nodeId: '', row: 0, col: 0 });
});

test('Tab from a stale address still lands inside the table', () => {
  // A row removed by another client leaves the focused cell pointing at nothing. The rule is
  // **clamp the address, then move**; when no move is possible from the clamp, the answer is the
  // clamp itself. So the caret is never stranded outside the table and never given `null`, which
  // would leave the user unable to `Tab` back in and repair the row.
  const t = T(); // 6 cells: (-1,0) (-1,1) (0,0) (0,1) (1,0) (1,1)
  assert.deepEqual(nextTableCell(t, 9, 0, true), { nodeId: '', row: 1, col: 1 });
  assert.deepEqual(nextTableCell(t, 9, 0, false), { nodeId: '', row: 1, col: 0 });
  assert.deepEqual(nextTableCell(t, -5, 0, true), { nodeId: '', row: HEADER_ROW, col: 1 });
  assert.deepEqual(nextTableCell(t, -5, 0, false), { nodeId: '', row: HEADER_ROW, col: 0 });
  // A column past the end is stale in the same way, and clamps to the last cell.
  assert.deepEqual(nextTableCell(t, 0, 9, true), { nodeId: '', row: 1, col: 1 });
});

test('an empty table offers no cell to move to', () => {
  assert.equal(nextTableCell({ header: [], rows: [] }, 0, 0, true), null);
});
