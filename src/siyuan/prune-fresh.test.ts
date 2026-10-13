// ★★★ `pruneDestroyedSiblings` must not probe a live fresh block (audit finding, measured).
//
// The SQL index flushes asynchronously (measured 200ms~2.8s after insertBlock), while the prune's
// double-confirm waits only 200ms — so a sibling inserted by the previous write-back misses both
// rounds while perfectly alive. Probing it at all is the defect: a miss there clears a live
// mapping (and drops the `everSeen` guard), and the next pass re-inserts it as a duplicate
// (defect #54's shape, via a different path).
//
// A **behavioural** test: a fake client whose SQL index never catches up drives the **real**
// `syncStructure` inserting two siblings. The second insert triggers the prune; the prune's
// probe SQL must not name the first (fresh) block.
//
// ★ Why the assertion is on the probe SQL, not on the surviving mapping: `loadBlockMap` revives
//   any mapping whose block is still in `freshlyInserted` (measured retention), so a cleared fresh
//   mapping comes back on the next rebuild anyway — the mapping survives either way and cannot tell
//   the two apart. What the fix observably changes is that no probe SQL names the fresh block
//   (shown red by removing the filter: the probe then names it and misses twice).

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

// Well-formed block ids (SIYUAN_ID_RE): 14 digits + '-' + 7 alphanumerics.
const DOC = '20260101000000-doc0001';
const mkid = (tag: string): string => `20260101000000-${tag}`;
const LI1 = mkid('li00001');
const P1 = mkid('p100001');
const LI2 = mkid('li00002');
const P2 = mkid('p200002');
// Node ids must be well-formed block ids or the walk reassigns them (defect #54's rule);
// use ids the fake kernel "adopts" so the test tracks the same nodes throughout.
const N1 = mkid('n100001');
const N2 = mkid('n200002');

class FakeClient {
  calls: string[] = [];
  /** node ids adopted via {: id}, in insertion order (the real kernel adopts them) */
  adopted: Array<{ item: string; para: string }> = [];

  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    // The kernel's in-memory AST is synchronous: freshly inserted blocks ARE visible here
    // (unlike the lagging SQL index below).
    let items = '';
    for (const a of this.adopted) {
      items += `<div data-node-id="${a.item}" data-type="NodeListItem"><div data-node-id="${a.para}" data-type="NodeParagraph"><div contenteditable="true">x</div></div></div>`;
    }
    return { dom: `<div data-node-id="${DOC}" data-type="NodeDocument">${items}</div>` };
  }

  async getBlockKramdown(_id: string): Promise<string> {
    return '';
  }

  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    this.calls.push(`sql:${stmt.slice(0, 60)}`);
    // loadBlockMap's listItem scan: empty document.
    if (stmt.includes("b.type = 'i'")) return [] as unknown as T[];
    // Every other read (prune confirms, type probes): the index NEVER catches up,
    // so freshly inserted blocks miss every round — the measured lag, frozen in place.
    return [] as unknown as T[];
  }

  async insertBlockWithOpData(
    md: string,
    _parentID: string,
    _previousID: string,
  ): Promise<{ listItemId: string; paragraphId: string; opData: string }> {
    this.calls.push(`insert:${md.slice(0, 40)}`);
    // Adopt {: id} like the real kernel does; the paragraph gets its own sibling id.
    const id = /\{: id="([^"]+)"\}/.exec(md)?.[1] ?? `20260101000000-f${this.adopted.length}000`;
    const para = `${id.slice(0, 15)}p${id.slice(16)}`;
    this.adopted.push({ item: id, para });
    return { listItemId: id, paragraphId: para, opData: '' };
  }

  async insertBlockEx(
    md: string,
    parentID: string,
    previousID: string,
  ): Promise<{ listItemId: string; paragraphId: string }> {
    const r = await this.insertBlockWithOpData(md, parentID, previousID);
    return { listItemId: r.listItemId, paragraphId: r.paragraphId };
  }

  async deleteBlock(id: string): Promise<null> {
    this.calls.push(`deleteBlock:${id}`);
    return null;
  }

  async moveBlock(): Promise<null> {
    return null;
  }

  async getChildBlocks(): Promise<never[]> {
    return [];
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

const node = (id: string, text: string): OutlineNode =>
  ({ id, modified: 1, text, children: [] }) as OutlineNode;

async function main(): Promise<void> {
  console.log('=== a fresh sibling survives the prune triggered by the next pass ===');
  {
    const c = new FakeClient();
    const store = mkStore(c);
    // Pass 1 inserts the first sibling (its blocks stay fresh: the fake index never catches up).
    store.beginWrite(DOC);
    try {
      await store.syncStructure(DOC, [node(N1, '<span>甲</span>')], store.beginPlaceholderScope());
    } finally {
      store.endWrite();
    }
    // Pass 2 inserts the second sibling: the walk sees N1 mapped, so its insert prunes over LI1.
    store.beginWrite(DOC);
    try {
      await store.syncStructure(
        DOC,
        [node(N1, '<span>甲</span>'), node(N2, '<span>乙</span>')],
        store.beginPlaceholderScope(),
      );
    } finally {
      store.endWrite();
    }
    const got1 = store.listItemOf(N1);
    const got2 = store.listItemOf(N2);
    check(
      '★ both siblings are mapped after the pass',
      got1 === N1 && got2 === N2,
      `N1→${got1} N2→${got2}`,
    );
    // The prune's probe is `SELECT id FROM blocks WHERE id IN (...)`: with the fix the fresh
    // sibling is skipped before any query, so no such probe runs at all. Without the fix the probe
    // runs, names the fresh block, and misses twice — the misfire this test guards.
    // (Assert on the probe form, not the id: the probe names the paragraph block, whose id differs
    // from both the node id and the item id — matching on any one of them passes vacuously.)
    const probes = c.calls.filter((k) => k.startsWith('sql:SELECT id FROM blocks WHERE id IN'));
    check(
      '★★ no probe SQL runs for the fresh sibling',
      probes.length === 0,
      probes.join(' | ') || '(no probe SQL at all)',
    );
    check(
      '★ no block was deleted (the prune found nothing dead)',
      !c.calls.some((k) => k.startsWith('deleteBlock')),
      c.calls.join(','),
    );
  }

  console.log(`\nprune-fresh: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
}

void main();
