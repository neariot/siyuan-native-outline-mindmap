// ★★★ The change detector must not believe a **stale** index.
//
// ## The defect
//
// `saveNodesIncremental` decides "does this block need rewriting?" by comparing the node's text
// with what the block currently holds. The stored side comes from the SQL index, and the index
// **lags the writes this same session just made** —— it is an index, not the database.
//
// Measured on the outline: bold a node and press "clear format" straight afterwards. The node's
// HTML changes, the DOM write is attempted, and the kernel still answers `**…**` —— because the
// index had not caught up with the bold yet, so it reported the block as *unformatted plain
// text*, which is exactly what the node now said. The detector concluded "no change" and sent
// nothing. The same two steps a second apart work; a quarter of a second apart they do not.
//
// This is the same failure shape as the documented "an unknown value must not be skipped" case:
// there the stored side was missing, here it is present but out of date. Both are answered by
// the same rule —— when the index cannot be trusted, write.
//
// ## Why the fix is a remembered write
//
// The store already keeps `writtenTask` for exactly this reason on the task flag. The text
// equivalent remembers what **this** plugin last wrote for a block and prefers it over an index
// that disagrees with it. An index that agrees is up to date, and the entry retires.
//
// Behavioural: a fake client drives the **real** `saveNodesIncremental`, asserting whether
// `updateBlockDom` is really sent.

import { SiYuanStore } from './store';
import type { SiYuanClient } from './api';
import type { OutlineNode } from '../model/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const LI = '20260101000000-li00001';
const PARA = '20260101000000-p000001';

class FakeClient {
  calls: string[] = [];
  /** What the SQL index holds for the paragraph block (plain text / markdown, i.e. as stored). */
  indexedMarkdown = '文字';

  async getBlockDOM(): Promise<{ dom: string }> {
    return { dom: '' };
  }

  async sql<T>(stmt: string): Promise<T[]> {
    if (stmt.includes("b.type = 'i'")) {
      return [{ id: LI, ial: '', child: PARA, childList: '' }] as unknown as T[];
    }
    if (stmt.includes('SELECT id, content, markdown FROM blocks')) {
      return [{ id: PARA, content: '文字', markdown: this.indexedMarkdown }] as unknown as T[];
    }
    if (stmt.includes('SELECT id FROM blocks')) {
      return [{ id: PARA }] as unknown as T[];
    }
    return [];
  }

  async updateBlockDom(id: string, dom: string): Promise<null> {
    this.calls.push(`updateBlockDom:${id}:${dom}`);
    return null;
  }

  async updateBlock(): Promise<null> {
    this.calls.push('updateBlock');
    return null;
  }

  async updateTaskListItemMarker(): Promise<null> {
    return null;
  }

  async getChildBlocks(): Promise<never[]> {
    return [];
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

const node = (text: string): OutlineNode => ({
  // The node id **is** the listItem block id: `loadBlockMap` keys its mapping by that, which is
  // how a node finds its paragraph block.
  id: LI,
  modified: 1,
  text,
  children: [],
});

async function main(): Promise<void> {
  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 1: the index still shows the pre-edit text right after a write');
  {
    const c = new FakeClient();
    c.indexedMarkdown = '文字'; // plain — the document before bolding
    const store = mkStore(c);
    await store.loadBlockMap('doc1');

    // Pass 1: bold. The index says plain, the node says bold → a write goes out.
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);
    check('pass 1 writes the bold', c.calls.some((k) => k.startsWith('updateBlockDom')), c.calls.join('|'));

    // The kernel has accepted it, but the index has not caught up yet — still plain.
    c.calls.length = 0;
    c.indexedMarkdown = '文字';

    // Pass 2: clear format. The node now says plain again, and the **index** also says plain —
    // so without remembering its own write, the detector sees no change and writes nothing.
    await store.saveNodesIncremental('doc1', [node('<span>文字</span>')]);
    check(
      'pass 2 writes the removal even though the index still shows the pre-bold text',
      c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join('|'),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 2: once the index catches up, an unchanged node is skipped again');
  {
    const c = new FakeClient();
    c.indexedMarkdown = '文字';
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);

    // The index has now caught up: it shows the bold.
    c.calls.length = 0;
    c.indexedMarkdown = '**文字**';
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);
    check(
      'an unchanged node is still skipped once the index agrees',
      !c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join('|'),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 3: inside the lag window an index that disagrees is treated as behind');
  {
    const c = new FakeClient();
    c.indexedMarkdown = '文字';
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);

    // Still inside the window: the index has not caught up, so it must not be able to decide.
    c.calls.length = 0;
    c.indexedMarkdown = '文字';
    await store.saveNodesIncremental('doc1', [node('<span>文字</span>')]);
    check(
      'inside the window the index cannot mask our own last write',
      c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join('|'),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 3b: past the window the index is the authority again');
  {
    const c = new FakeClient();
    c.indexedMarkdown = '文字';
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);

    // Somebody else rewrote the block and the index caught up with **their** value. Age the
    // remembered write past the window so the index is consulted on its own merits.
    const written = (store as unknown as { writtenText: Map<string, { dom: string; at: number }> })
      .writtenText;
    for (const [k, v] of written) written.set(k, { dom: v.dom, at: v.at - 60_000 });

    c.calls.length = 0;
    c.indexedMarkdown = '外部文字';
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);
    check(
      'a change made outside the plugin is written over, not masked by the remembered value',
      c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join('|'),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 4: the remembered value retires, so the map cannot grow without bound');
  {
    const c = new FakeClient();
    c.indexedMarkdown = '文字';
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);
    c.indexedMarkdown = '**文字**';
    await store.saveNodesIncremental('doc1', [node('<span style="font-weight: bold;">文字</span>')]);
    const left = (store as unknown as { writtenText: Map<string, { dom: string; at: number }> })
      .writtenText;
    check('the entry is dropped once the index agrees', (left?.size ?? -1) === 0, `size=${left?.size}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exitCode = 1;
  }
}

void main();