// ★★★ A just-inserted block must not be rewritten by the same pass's text sync (fix).
//
// Measured undo-path race: `syncStructure` inserts `1. 乙` (the insert stores the kernel-parsed
// structure, whose inline span is the bare `<span>乙</span>`), then `saveNodesIncremental` runs in
// the SAME pass. The SQL index has no row for the new block yet (`oldText === undefined`), so the
// old rule rewrote it via the DOM path — and the DOM round trip downgrades the inline structure
// (`<span>乙</span>` → `<span data-type="text">乙</span>`), a silent content change that the export
// markdown then carries forever (`1. <span data-type="text">乙</span>`).
//
// The fix: unknown + freshly-inserted ⇒ trust the insert, skip the rewrite. Unknown + anything
// else keeps the old rule (the NewNode bug: a genuinely found-but-unread block must be written).
//
// A **behavioural** test: a fake client drives the **real** `saveNodesIncremental`, asserting
// whether `updateBlockDom` is really sent.

export {};

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
  /** rows the fake SQL index returns for the content/markdown read */
  indexRows: Array<{ id: string; content: string; markdown: string | null }> = [];

  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: '' };
  }

  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    // loadBlockMap's listItem scan: the item exists with its paragraph child
    if (stmt.includes("b.type = 'i'")) {
      return [{ id: LI, ial: '', child: PARA, childList: '' }] as unknown as T[];
    }
    // saveNodesIncremental's content read: whatever the fake index holds (possibly nothing)
    if (stmt.includes('SELECT id, content, markdown FROM blocks')) {
      return this.indexRows as unknown as T[];
    }
    if (stmt.includes('SELECT id FROM blocks')) {
      return this.indexRows.map((r) => ({ id: r.id })) as unknown as T[];
    }
    return [];
  }

  async updateBlockDom(id: string, _dom: string): Promise<null> {
    this.calls.push(`updateBlockDom:${id}`);
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

const node = (): OutlineNode => ({
  id: LI,
  modified: 1,
  text: '<span>乙</span>',
  children: [],
});

async function main(): Promise<void> {
  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 1: block inserted this pass, index not caught up → no DOM rewrite');
  {
    const c = new FakeClient();
    c.indexRows = []; // the index knows nothing yet
    const store = mkStore(c);
    // loadBlockMap registers the mapping; then the insert path marks both blocks fresh
    await store.loadBlockMap('doc1');
    (store as any).freshlyInserted.add(PARA);
    (store as any).freshlyInserted.add(LI);
    await store.saveNodesIncremental('doc1', [node()]);
    check(
      '★★ a just-inserted block is not rewritten by the same pass',
      !c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join(','),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 2: block NOT freshly inserted and unread → still written (the NewNode bug)');
  {
    const c = new FakeClient();
    c.indexRows = [];
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    // NOTE: no freshlyInserted registration — an old block the index merely missed
    await store.saveNodesIncremental('doc1', [node()]);
    check(
      '★ a missing-but-not-fresh block is still written',
      c.calls.some((k) => k === `updateBlockDom:${PARA}`),
      c.calls.join(','),
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log('Scenario 3: index caught up with identical text → skipped as before');
  {
    const c = new FakeClient();
    // ★ The **paragraph** block's markdown is the paragraph text; the `- ` marker belongs to
    //   the listItem row above it. Measured against the kernel:
    //     type p  markdown='乙'      type i  markdown='- 乙'
    //   `saveNodesIncremental` maps a node to the paragraph block, so that is what goes here.
    //   The fixture said `'- 乙'`, which only passed while the comparison read the plain
    //   `content` column and ignored `markdown`; it would have described the wrong block.
    c.indexRows = [{ id: PARA, content: '乙', markdown: '乙' }];
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    (store as any).freshlyInserted.add(PARA);
    (store as any).freshlyInserted.add(LI);
    await store.saveNodesIncremental('doc1', [node()]);
    check(
      '★ an unchanged block is still skipped',
      !c.calls.some((k) => k.startsWith('updateBlockDom')),
      c.calls.join(','),
    );
  }

  console.log(`\nno-rewrite-fresh: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
}

void main();
