/**
 * The mapping the write-back is built on: **which block ID goes into which table**.
 *
 * Root cause layer of defects #53/#54: the tables must not be mixed up.
 *
 *   · "node ID → paragraph block"  decides where **text** goes (`updateBlockDom`)
 *   · "node ID → listItem block"   decides the **anchor** of a structural insert / move (`previousID`)
 *
 * ★ Measured, from the kernel: `moveBlock` whose `previousID` is *not* a listItem returns
 *   `{code: 0, msg: ''}` and **applies nothing** —— it even writes an `E` log about the illegal
 *   structure. Success and failure are indistinguishable from the outside, so the plugin never learns
 *   that the order was not corrected; the document keeps a stale order and the UI keeps the new one.
 *   So the anchor table holding a paragraph (or a list) instead of a listItem is not a cosmetic slip:
 *   it is a silent no-op on every reorder. The measurements are in `docs/kernel-api.md` §7.15.
 *
 * ★ This file reads the product instead of restating it: the document is produced by `treeToBlockDom`,
 *   the IDs come from `parseDomToTree` (the same parser `loadBlockMap` uses), and the assertions are made
 *   against the store's own tables. Its predecessor (`kernel-bugs.test.ts`) asserted on stub functions
 *   written in the test itself —— `bad.applied === false` for an object constructed with
 *   `applied: false` —— so it could not go red for any change to the plugin, and the kernel facts it
 *   carried lived only in a gitignored `.logs/` file.
 */
export {};

import { treeToBlockDom } from '../core/blockdom';
import { SIYUAN_ID_RE } from '../core/map';
import type { OutlineNode } from '../model/types';
import { SiYuanClient } from './api';
import { parseDomToTree } from './dom-tree';
import { SiYuanStore } from './store';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(`${name}  ${extra}`);
    console.log(`  ❌ ${name}  ${extra}`);
  }
};

const node = (id: string, text: string, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 0, text, children }) as OutlineNode;

/** Only the calls `loadBlockMap` makes are needed: the DOM read, and SQL as the fallback. */
class FakeClient {
  constructor(private dom: string, private rows: unknown[] = []) {}
  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: this.dom };
  }
  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    if (stmt.includes("b.type = 'i'")) return this.rows as T[];
    return [];
  }
  async getBlockKramdown(_id: string): Promise<string> {
    return '';
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

async function main(): Promise<void> {
  console.log('=== the anchor table holds list items, the text table holds paragraphs ===');

  {
    // 甲 ─ 子T      (a nested node, so there is a child list as well as paragraphs)
    const tree: OutlineNode[] = [node('n1', '甲', [node('n2', '子T')])];
    const dom = treeToBlockDom(tree);
    const layout = parseDomToTree(dom, 'doc1');

    // What the kernel's in-memory AST reports for that document: listItem → its first paragraph.
    const pairs = [...layout.itemToParagraph.entries()];
    check('★ the document under test has two list items (precondition)', pairs.length === 2, `got=${pairs.length}`);
    const [nodeId, paragraphId] = pairs[0] ?? ['', ''];

    const store = mkStore(new FakeClient(dom));
    const map = await store.loadBlockMap('doc1');

    check('★★ the text table maps the node to its **paragraph** block',
      map.get(nodeId) === paragraphId, `map=${map.get(nodeId)} paragraph=${paragraphId}`);
    check('★★★ the anchor table maps the node to its **listItem** block —— never to the paragraph',
      store.listItemOf(nodeId) === nodeId && store.listItemOf(nodeId) !== paragraphId,
      `listItemOf=${store.listItemOf(nodeId)} node=${nodeId} paragraph=${paragraphId}`);

    // A structural insert must hand the kernel a block ID it can position after; anything else is accepted
    // and ignored (see the header), so the value has to be a real block ID.
    check('★★ the anchor is a well-formed block ID the kernel accepts',
      SIYUAN_ID_RE.test(store.listItemOf(nodeId)), store.listItemOf(nodeId));

    // An echo arriving in **either** ID form must be recognised as "ours" (a measured false-conflict bug:
    // transactions carry the paragraph ID for an update and the listItem ID for a delete).
    check('★★ the reverse table resolves both ID forms back to the node',
      store.byBlock(paragraphId) === nodeId && store.byBlock(nodeId) === nodeId,
      `paragraph→${store.byBlock(paragraphId)} listItem→${store.byBlock(nodeId)}`);
    const ids = store.blockIdsOf(nodeId);
    check('★★ blockIdsOf() returns both, without repeating one',
      ids.length === 2 && ids.includes(nodeId) && ids.includes(paragraphId), JSON.stringify(ids));
  }

  console.log('\n=== the SQL path agrees with the DOM path (index lag fallback) ===');

  {
    // The kernel reports, per listItem: `child` = the first paragraph, `childList` = the child list.
    const li = '20260101000000-li00001';
    const para = '20260101000000-p000001';
    const c = new FakeClient('', [{ id: li, ial: '', child: para, childList: '20260101000000-l000002' }]);
    const store = mkStore(c);
    const map = await store.loadBlockMap('doc1');

    check('★★ the SQL fallback maps the node to its paragraph', map.get(li) === para, `map=${map.get(li)}`);
    check('★★★ and still exposes the listItem as the anchor',
      store.listItemOf(li) === li && store.listItemOf(li) !== para, `listItemOf=${store.listItemOf(li)}`);
    check('★ a node that is not in the document has no anchor',
      store.listItemOf('20260101000000-nope001') === '', store.listItemOf('20260101000000-nope001'));
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
}

void main();
