/**
 * A node's identity must survive the write-back, or the mapping keys drift and the node is **duplicated**.
 *
 * Corresponds to .logs/API-GOTCHAS.md §109, defect #54.
 *
 * ★ The mechanism has changed since this file was written, and the old version pinned the *old* one: it
 *   asserted that inserting writes `- {: id="…"}body` into the markdown so the kernel keeps the ID. The
 *   write-back goes through the block-DOM path now (`store.ts`, `updateBlockDom`), where every
 *   `data-node-id` is generated fresh and the node's own ID is deliberately **not** reused. Identity is
 *   re-established afterwards by `refreshMapsAfterCreate`, whose documented basis is:
 *
 *     "the order of listItems in the DOM == the pre-order order of the node tree, and the block tree uses
 *      the same order, so a one-to-one match by index is enough."
 *
 *   So what has to hold is: **one list item per node, in pre-order, each carrying a valid unique ID**.
 *   If a node is dropped, reordered, or gets a malformed ID, that index alignment shifts by one and the
 *   tail of the document is judged "new" —— silent duplicate insertion, the very defect this file is about.
 *
 * ★ Every case below reads the product: `treeToBlockDom` serialises, `parseDomToTree` (the parser the
 *   write-back itself uses to read a document back) parses, and the assertions are made on **its** view of
 *   the order. The previous version re-implemented the serialiser and the alignment as local closures and
 *   asserted on those, so no change to the plugin could turn it red.
 */
export {};

import type { OutlineNode } from '../model/types';
import { treeToBlockDom } from '../core/blockdom';
import { SIYUAN_ID_RE, makeSiyuanId } from '../core/map';
import { parseDomToTree, type BlockTreeState } from '../siyuan/dom-tree';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const node = (id: string, text: string, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 0, text, children }) as OutlineNode;

/** The listItem IDs of a parsed document, in pre-order —— the order `refreshMapsAfterCreate` aligns by. */
function preOrderItems(st: BlockTreeState): string[] {
  const out: string[] = [];
  const walkList = (listId: string): void => {
    for (const li of st.childrenOf.get(listId) ?? []) {
      out.push(li);
      const childList = st.itemToChildList.get(li);
      if (childList) walkList(childList);
    }
  };
  if (st.topListId) walkList(st.topListId);
  return out;
}

console.log('=== the ID shape both sides agree on ===');
{
  // The generator and the validator must agree, or a node's ID is one the plugin will not recognise on re-read.
  const generated = makeSiyuanId();
  check(`★ makeSiyuanId() produces an ID SIYUAN_ID_RE accepts (${generated})`, SIYUAN_ID_RE.test(generated));
  check('★ the validator is not vacuous: a malformed ID is rejected', !SIYUAN_ID_RE.test('bogus'));
  check('★★ a well-formed-but-different ID is not equal to a fresh one', makeSiyuanId() !== generated);
}

console.log('\n=== one list item per node, in pre-order ===');
{
  // 甲 ─ 子T, 同E        (three nodes, one of them nested)
  // 乙
  const tree: OutlineNode[] = [
    node('n1', '甲', [node('n2', '子T'), node('n3', '同E')]),
    node('n4', '乙'),
  ];
  const dom = treeToBlockDom(tree);
  const state = parseDomToTree(dom, '20260101000000-aaaaaaa');

  const items = preOrderItems(state);
  check('★★ every node has exactly one list item (4 nodes → 4 items)', items.length === 4, `got=${items.length}`);
  check('★ every list item carries a paragraph block (the node text)',
    items.every((li) => state.itemToParagraph.has(li)),
    `missing=${items.filter((li) => !state.itemToParagraph.has(li)).length}`);

  const top = state.childrenOf.get(state.topListId) ?? [];
  check('★★ the top level has one item per top-level node (2 → 2)', top.length === 2, `got=${top.length}`);

  // Nesting: 甲's item owns a child list holding its two children. This is what makes the pre-order walk
  // match the node tree's pre-order —— with a flat list, index alignment would pair 子T with 乙.
  const childList = state.itemToChildList.get(top[0]);
  check('★★ the first node owns a child list', !!childList, `itemToChildList=${!!childList}`);
  check('★★ that child list holds its children, in order (2 → 2)',
    childList ? (state.childrenOf.get(childList) ?? []).length === 2 : false);
}

console.log('\n=== the IDs the kernel receives are valid and unique ===');
{
  const tree: OutlineNode[] = [node('n1', '甲', [node('n2', '子T')]), node('n3', '乙')];
  const state = parseDomToTree(treeToBlockDom(tree), '20260101000000-aaaaaaa');
  const ids = [...state.aliveIds];
  check('★★ every block ID is in SiYuan format', ids.every((id) => SIYUAN_ID_RE.test(id)),
    `bad=${ids.filter((id) => !SIYUAN_ID_RE.test(id)).join(',')}`);
  // Duplicate keys would make one node's mapping overwrite another's, which looks exactly like a lost node.
  check('★★★ no two blocks share an ID', new Set(ids).size === ids.length,
    `unique=${new Set(ids).size} total=${ids.length}`);

  const items = preOrderItems(state);
  check('★ the node IDs from the tree are not reused as block IDs (identity is re-aligned, not inherited)',
    !items.some((li) => li === 'n1' || li === 'n2' || li === 'n3'));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
