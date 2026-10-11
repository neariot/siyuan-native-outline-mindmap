/**
 * The **nesting depth** semantics of the write-back transaction (regression test for the fix).
 *
 * Original defect: `writeEpochOpen` was a boolean, and `endWrite()` set it to false unconditionally.
 * When two write-backs overlap (the main one in flight + a user undo / an external delete event),
 * the one that finishes first shuts down the whole map cache the other one is still using,
 * and clears `mapCacheValue`, so the latter reads the cache of the wrong document or degrades into repeated SQL queries.
 *
 * Fix: switch to a depth counter, so only the **outermost** endWrite really closes it.
 *
 * ★ This file used to carry a `Guard` class that "replicates the write-back transaction state machine of
 *   `SiYuanStore`" —— a copy compared against itself, so the plugin's own state machine could change freely
 *   (including back to the boolean that caused this defect). It drives the **real** `beginWrite` / `endWrite` /
 *   `loadBlockMap` through a counting fake client now, so "the second read was served from the cache" is
 *   observed as an SQL call that did **not** happen.
 */
export {};

import { SiYuanClient } from '../siyuan/api';
import { SiYuanStore } from '../siyuan/store';

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

const LI = '20260101000000-li00001';
const PARA = '20260101000000-p000001';

/** Answers the mapping query and counts how often the store actually asks the document. */
class CountingClient {
  sqlCalls = 0;
  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: '' }; // no DOM available → the SQL path, which is what the counter measures
  }
  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    this.sqlCalls++;
    if (stmt.includes("b.type = 'i'")) return [{ id: LI, ial: '', child: PARA, childList: null }] as unknown as T[];
    return [];
  }
  async getBlockKramdown(_id: string): Promise<string> {
    return '';
  }
}

const mkStore = (c: CountingClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

async function main(): Promise<void> {
  console.log('=== outside a transaction the cache never survives a read ===');
  {
    const c = new CountingClient();
    const store = mkStore(c);
    await store.loadBlockMap('doc1');
    const first = c.sqlCalls;
    check('★ a load reads the document', first >= 1, `sql=${first}`);
    await store.loadBlockMap('doc1');
    check('★★ a second load (no transaction) reads it again —— the cache must not outlive a write-back',
      c.sqlCalls > first, `sql=${c.sqlCalls}`);
  }

  console.log('\n=== inside a transaction the mapping is reused ===');
  {
    const c = new CountingClient();
    const s = mkStore(c);
    s.beginWrite('doc1');
    const m1 = await s.loadBlockMap('doc1');
    const afterFirst = c.sqlCalls;
    check('★ the first load inside the transaction reads', afterFirst >= 1, `sql=${afterFirst}`);

    const m2 = await s.loadBlockMap('doc1');
    check('★★ a second load inside the same transaction is served from the cache —— no SQL at all',
      c.sqlCalls === afterFirst, `sql=${c.sqlCalls} (was ${afterFirst})`);
    check('★ and it is the same mapping', m2.get(LI) === m1.get(LI), JSON.stringify([...m2.entries()]));

    // ★★★ The defect: the inner end used to close everything, so the outer transaction lost its cache.
    s.beginWrite('doc1');
    s.endWrite();
    await s.loadBlockMap('doc1');
    check('★★★ a nested transaction keeps the cache open when the inner one ends',
      c.sqlCalls === afterFirst, `sql=${c.sqlCalls} (was ${afterFirst})`);

    s.endWrite();
    await s.loadBlockMap('doc1');
    check('★★ the outermost end closes it —— the next load reads again',
      c.sqlCalls > afterFirst, `sql=${c.sqlCalls}`);
  }

  console.log('\n=== the cache is keyed by document and by row limit ===');
  {
    const c = new CountingClient();
    const s = mkStore(c);
    s.beginWrite('doc1');
    await s.loadBlockMap('doc1');
    const afterFirst = c.sqlCalls;
    await s.loadBlockMap('doc1', 10);
    check('★★ a different row limit is a different query, not a cache hit',
      c.sqlCalls > afterFirst, `sql=${c.sqlCalls}`);
    const afterLimit = c.sqlCalls;
    await s.loadBlockMap('doc2');
    check('★★ another document is not served the previous document\'s mapping',
      c.sqlCalls > afterLimit, `sql=${c.sqlCalls}`);
    s.endWrite();
  }

  console.log('\n=== an unmatched endWrite cannot corrupt the depth ===');
  {
    const c = new CountingClient();
    const s = mkStore(c);
    s.endWrite(); // no matching begin
    await s.loadBlockMap('doc1');
    const first = c.sqlCalls;
    await s.loadBlockMap('doc1');
    check('★★ a stray endWrite does not open a transaction (the next load still reads)',
      c.sqlCalls > first, `sql=${c.sqlCalls}`);
    // …and a stray end after a real transaction still leaves it closed.
    s.beginWrite('doc1');
    s.endWrite();
    s.endWrite();
    await s.loadBlockMap('doc1');
    const second = c.sqlCalls;
    await s.loadBlockMap('doc1');
    check('★ and the depth cannot go negative into "open"', c.sqlCalls > second, `sql=${c.sqlCalls}`);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

void main();
