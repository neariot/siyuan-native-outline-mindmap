/**
 * The mapping's **key namespace**: which ID may be a key, and which entries survive one read.
 *
 * Corresponds to .logs/API-GOTCHAS.md §80 / §82, and `kernel-api.md` §7.7 ("do not mix two kinds of ID in
 * one map").
 *
 * ★ This file used to hold `class MapModel` —— a hand-written mirror of `SiYuanStore.loadBlockMap`'s three
 *   tables and its retention loops —— and asserted on that mirror, so the plugin could change freely while
 *   the test stayed green. It was also a *second* definition of the rule, which is the failure this
 *   repository keeps hitting: two criteria drift, and the one nobody runs is the one that is wrong.
 *
 * The two halves now read the product:
 *
 *   1. the tables themselves, through the real `loadBlockMap` (the fixture document is produced by
 *      `treeToBlockDom` and read back by `parseDomToTree`, exactly as `loadBlockMap` does it) —— see also
 *      `src/siyuan/blockmap-anchor.test.ts` for which **kind** of block ID belongs in which table;
 *   2. the retention rule, `isUnseenButOurs()` in `src/siyuan/store.ts`, which decides whether an entry of
 *      the previous read survives —— the rule whose absence inserts a node **twice**.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { treeToBlockDom } from '../core/blockdom';
import type { OutlineNode } from '../model/types';
import { SiYuanClient } from '../siyuan/api';
import { parseDomToTree } from '../siyuan/dom-tree';
import { SiYuanStore, isUnseenButOurs } from '../siyuan/store';
import { callSites } from './source-probe';

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

class FakeClient {
  constructor(private dom: string) {}
  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: this.dom };
  }
  async sql<T>(_stmt: string, _limit?: number): Promise<T[]> {
    return [];
  }
  async getBlockKramdown(_id: string): Promise<string> {
    return '';
  }
}

// ★ Wrapped in async: this project's tests compile to CJS, which has no top-level await.
async function main(): Promise<void> {
  console.log('=== one namespace: every table is keyed by the node, and the block ID is the listItem ===');
  {
    const dom = treeToBlockDom([node('n1', '甲', [node('n2', '子T')])]);
    const layout = parseDomToTree(dom, 'doc1');
    const store = new SiYuanStore({
      client: new FakeClient(dom) as unknown as SiYuanClient,
      notebook: 'nb',
      basePath: '/x',
    });
    const map = await store.loadBlockMap('doc1');
    const keys = [...map.keys()];

    check('★ the mapping has one entry per list item (2 nodes → 2 entries)', keys.length === 2, `got=${keys.length}`);
    // ★ The namespace rule: the key is the identity the rest of the plugin uses, and it must resolve through
    //   `listItemOf`/`byBlock` as well —— a key that exists in one table only is the "mixed namespaces" defect.
    check('★★ every key is a block ID of the document (not a synthetic node id)',
      keys.every((k) => layout.aliveIds.has(k)), keys.filter((k) => !layout.aliveIds.has(k)).join(','));
    check('★★ every key resolves to a listItem anchor, and to itself',
      keys.every((k) => store.listItemOf(k) === k), keys.map((k) => `${k}→${store.listItemOf(k)}`).join(' '));
    check('★★ the value of each entry is that listItem\'s paragraph (the updatable block)',
      keys.every((k) => map.get(k) === layout.itemToParagraph.get(k)),
      keys.map((k) => `${k}→${map.get(k)}`).join(' '));
    check('★ the reverse table resolves both the node key and its paragraph back to the same node',
      keys.every((k) => store.byBlock(k) === k && store.byBlock(map.get(k) ?? '') === k));
  }

  console.log('\n=== retention: only "unseen, but inserted by us" survives ===');
  {
    // The rule decides whether the entry of a *previous* read is carried over into a read that lacks it.
    const current = new Map([['kept', 'blk-a']]);
    const fresh = new Set(['blk-b']);

    check('★★ absent from this read **and** inserted by us → carried over',
      isUnseenButOurs(current, 'node-b', 'blk-b', fresh) === true);
    check('★★★ absent from this read, but not ours → **dropped** (a foreign block\'s stale mapping must not live forever)',
      isUnseenButOurs(current, 'node-c', 'blk-c', fresh) === false);
    check('★ present in this read → never carried over (the read is the authority)',
      isUnseenButOurs(current, 'kept', 'blk-a', fresh) === false);
    check('★ nothing fresh at all → nothing is carried over',
      isUnseenButOurs(current, 'node-d', 'blk-d', new Set()) === false);
  }

  console.log('\n=== all three tables ask that one rule ===');
  {
    // ★ Precondition of the cases above: a rule nothing calls defends nothing. Three tables, three calls ——
    //   and the third one passes the key as the block ID (the reverse table is block → node).
    const src = fs.readFileSync(path.join(__dirname, '..', 'siyuan', 'store.ts'), 'utf8');
    const calls = callSites(src, /^isUnseenButOurs$/);
    check('★★ the three tables share the retention rule (3 call sites)', calls.length === 3, calls.join(', '));
  }
  // ★ The summary belongs **inside** the async body: at the top level it would print (and exit 0) before
  //   the awaited cases had run, which is a test that reports success without having checked anything.
  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

void main();
