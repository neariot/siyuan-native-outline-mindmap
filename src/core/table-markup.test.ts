// ★★★ A SiYuan table is a **block of its own** — measured, not assumed.
//
// ## Why the table needed a node of its own
//
// The toolbar used to inject `<table><tbody>…` into a node's text. The write path strips those
// tags (a table cannot live inside a paragraph's inline DOM: the kernel stores the attempt as
// the literal text `<protyle-html>`), so the table was lost **and** the node was left holding
// one `&nbsp;` per cell. Measured for a 2×2 table:
//
//     node text  <span>前</span><table><tbody><tr><td>&nbsp;</td>…</table>
//     written     <span>前</span>&nbsp;&nbsp;&nbsp;&nbsp;
//
// The only route the kernel accepts is a **markdown** table, which becomes a real block hung off
// the document — and `insertBlock` with a `NodeTable` **DOM** answers `code: 0` while creating
// nothing, which is why the DOM route is not an option to fall back on.
//
// So a table is a node carrying `table`, at document root. These cases pin the reader and the
// writer; `store` is covered by `e2e/table.spec.ts`, because whether the block really lands is
// a question only the running kernel can answer.
//
// Runs offline (`core/` has no DOM dependency): python3 scripts/run-tests.py table

import { kramdownToTree, treeToKramdown, parseTableLines, tableToKramdown } from './map';
import type { OutlineNode } from '../model/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, got?: unknown, want?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

/** The kernel's own export of a table block (measured; `colgroup` marks the closing line). */
const KERNEL_TABLE_KRAMDOWN = [
  '|h1|h2|',
  '| ----| ----|',
  '|a|b|',
  '|c|d|',
  '{: id="20260101000000-tbl0001" updated="20260101000000" colgroup="|"}',
].join('\n');

// ---------------------------------------------------------------- parse

check(
  'a run of pipe-lines with a separator is a table',
  JSON.stringify(parseTableLines(['|a|b|', '| ---| ---|', '|1|2|'])) ===
    JSON.stringify({ header: ['a', 'b'], rows: [['1', '2']] }),
  parseTableLines(['|a|b|', '| ---| ---|', '|1|2|']),
);
check(
  'a single pipe-line is ordinary text, not a table',
  parseTableLines(['|a|b|']) === null,
  parseTableLines(['|a|b|']),
  null,
);
check(
  'pipe-lines with no separator are ordinary text',
  parseTableLines(['|a|b|', '|c|d|']) === null,
  parseTableLines(['|a|b|', '|c|d|']),
  null,
);
check(
  'a short row is padded to the header width rather than producing a ragged table',
  JSON.stringify(parseTableLines(['|a|b|c|', '| ---| ---| ---|', '|1|'])) ===
    JSON.stringify({ header: ['a', 'b', 'c'], rows: [['1', '', '']] }),
  parseTableLines(['|a|b|c|', '| ---| ---| ---|', '|1|']),
);

// ---------------------------------------------------------------- read

{
  const tree = kramdownToTree(KERNEL_TABLE_KRAMDOWN);
  check('a table in the document becomes exactly one node', tree.length === 1, tree.length, 1);
  check(
    'the node carries the table',
    JSON.stringify(tree[0]?.table) === JSON.stringify({ header: ['h1', 'h2'], rows: [['a', 'b'], ['c', 'd']] }),
    tree[0]?.table,
    { header: ['h1', 'h2'], rows: [['a', 'b'], ['c', 'd']] },
  );
  // ★ The block id sits on the attribute line **after** the rows, which is the opposite of
  //   every other block; a reader that looks before them cannot find it and the write path
  //   then treats the table as new and inserts a second copy.
  check(
    'the node keeps the table block id',
    tree[0]?.id === '20260101000000-tbl0001',
    tree[0]?.id,
    '20260101000000-tbl0001',
  );
  check('a table node has no text of its own', (tree[0]?.text ?? 'x') === '', tree[0]?.text, '');
}

{
  const tree = kramdownToTree(`- 甲\n  {: id="20260101000000-li00001"}\n${KERNEL_TABLE_KRAMDOWN}\n- 乙\n  {: id="20260101000000-li00002"}\n`);
  check(
    'a table beside the nodes is a sibling of them, not text on one',
    tree.length === 3 && tree[1]?.table !== undefined && tree[0]?.text === '<span>甲</span>',
    tree.map((n) => ({ text: n.text, table: n.table !== undefined })),
    '3 nodes, the middle one a table',
  );
}

{
  // ★ A pipe-line that is not a table must not be swallowed: before this, a non-list
  //   flush-left line was folded into the node above as an attached paragraph, so a paragraph
  //   that merely starts with `|` would have been mangled.
  const tree = kramdownToTree('- 甲\n  {: id="20260101000000-li00001"}\n|普通文字\n{: id="x" colgroup="|"}\n');
  check(
    'a lone pipe-line is kept as text rather than deleted',
    JSON.stringify(tree).includes('普通文字'),
    tree,
    'the text must survive',
  );
}

// ---------------------------------------------------------------- write

{
  const node: OutlineNode = {
    id: '20260101000000-tbl0001',
    modified: 0,
    text: '',
    table: { header: ['h1', 'h2'], rows: [['a', 'b'], ['c', 'd']] },
    children: [],
  };
  check(
    'a table node writes markdown the kernel accepts',
    tableToKramdown(node.table!) === '|h1|h2|\n| ---| ---|\n|a|b|\n|c|d|',
    tableToKramdown(node.table!),
  );
  check(
    'a pipe inside a cell is escaped, so the table keeps its shape',
    tableToKramdown({ header: ['a|b'], rows: [] }) === '|a\\|b|\n| ---|',
    tableToKramdown({ header: ['a|b'], rows: [] }),
  );
  const doc = treeToKramdown([node], { docTitle: 'T' });
  check(
    'a table node writes its table, never a list item',
    doc.includes('|h1|h2|') && !doc.includes('- '),
    doc,
  );
}

// ★ The round trip: a tree with a table comes back the same shape.
{
  const tree = kramdownToTree(KERNEL_TABLE_KRAMDOWN);
  const back = kramdownToTree(treeToKramdown(tree, { docTitle: 'T' }));
  check(
    'a table survives write → read unchanged',
    JSON.stringify(back[0]?.table) === JSON.stringify(tree[0]?.table),
    back[0]?.table,
    tree[0]?.table,
  );
}

if (fail > 0) {
  console.error(`\n${fail} failed, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntable-markup: ${pass} passed`);
}