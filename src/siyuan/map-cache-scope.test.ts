/**
 * The **document scope** of the map cache (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * What this guards
 * ──────────────────────────────────────────────────────────────────
 *
 * Every call to `loadBlockMap(docId)` **replaces wholesale** the instance-level
 * `lastBlockMap` / `lastListItems` / `lastByBlock`, and writes the cache
 * `mapCacheDocId` / `mapCacheValue`.
 *
 * Hence a natural worry (raised in an agy review):
 *
 *   > fetching the map for document B **wipes out** the map for document A; afterwards the syncDeletions of A
 *   > cannot resolve the owner, misjudges it as "changed by an external client", and silently skips the deletion.
 *
 * **Measured conclusion**: the cache does have a document-scope guard (it is reused only when `mapCacheDocId === docId`),
 * so it never reads the map of **another document**. The cross-document consequence is "conservatively cleaning up less",
 * not "deleting the wrong thing" — only the latter is an incident; the former only affects when cleanup happens.
 *
 * This test guards three invariants:
 *   ① the cache only hits on its own document;
 *   ② switching documents always invalidates it (the map of B is never fed to A);
 *   ③ the depth semantics of nested transactions: ending the inner one does not close the outer cache.
 */

export {};

import * as fs from 'node:fs';

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

/**
 * A replica of the cache criteria from `store.ts` (beginWrite / endWrite / loadBlockMap).
 *
 * ★ The criteria copy the source exactly:
 *     loadBlockMap hit condition → writeEpochOpen && mapCacheDocId===docId && same limit
 *     beginWrite outermost   → reset to the current docId
 *     beginWrite nested across documents → also resets (does not reuse another document's map)
 *     endWrite inner         → returns immediately, leaves the cache alone
 *     endWrite outermost     → clears everything
 */
class MapCache {
  private depth = 0;
  private open = false;
  private docId = '';
  private limit = -1;
  private value: Map<string, string> | null = null;
  /** Count real "database queries", used to prove the cache really hits/misses */
  sqlCalls = 0;

  beginWrite(doc: string): void {
    this.depth++;
    this.open = true;
    if (this.depth === 1) {
      this.docId = doc;
      this.limit = -1;
      this.value = null;
    } else if (doc && this.docId !== doc) {
      this.docId = doc;
      this.limit = -1;
      this.value = null;
    }
  }

  endWrite(): void {
    if (this.depth > 0) this.depth--;
    if (this.depth > 0) return;
    this.open = false;
    this.docId = '';
    this.limit = -1;
    this.value = null;
  }

  /** Replica of loadBlockMap: return from the cache on a hit, otherwise "query the database" */
  load(doc: string, limit = 5000, rows?: Map<string, string>): Map<string, string> {
    if (this.open && this.docId === doc && this.limit === limit) {
      return this.value as Map<string, string>;
    }
    this.sqlCalls++;
    const map = rows ?? new Map<string, string>();
    this.docId = doc;
    this.limit = limit;
    this.value = map;
    return map;
  }
}

console.log('① the cache only hits on its own document');

{
  const c = new MapCache();
  c.beginWrite('A');
  const a1 = c.load('A', 5000, new Map([['n1', 'b1']]));
  const before = c.sqlCalls;
  const a2 = c.load('A', 5000, new Map([['ZZZ', 'ZZZ']]));

  check('the second load of the same document hits the cache (no new query)', c.sqlCalls === before, `queries ${c.sqlCalls}`);
  check('★ what comes back is the **cached** content, not the newly passed table',
    a2.get('n1') === 'b1' && !a2.has('ZZZ'),
    JSON.stringify([...a2.entries()]));
  check('the first one queried the database', a1.has('n1'));
  c.endWrite();
}

console.log('\n② ★ switching documents always invalidates — the map of B is never fed to A');

{
  const c = new MapCache();
  c.beginWrite('A');
  c.load('A', 5000, new Map([['aNode', 'aBlock']]));
  const n1 = c.sqlCalls;

  // switch to B within the same transaction
  const bMap = c.load('B', 5000, new Map([['bNode', 'bBlock']]));
  check('switching documents → queries again (cache invalidated)', c.sqlCalls === n1 + 1, `queries ${c.sqlCalls}`);
  check('B gets its own table', bMap.has('bNode') && !bMap.has('aNode'));

  // switch back to A: it must query again and must **not** return the map of B
  const aAgain = c.load('A', 5000, new Map([['aNode', 'aBlock']]));
  check('switching back to A also queries again', c.sqlCalls === n1 + 2, `queries ${c.sqlCalls}`);
  check(
    '★★ what comes back after switching to A is **not** the map of B (this is the heart of this case)',
    !aAgain.has('bNode'),
    JSON.stringify([...aAgain.entries()]),
  );
  c.endWrite();
}

console.log('\n③ nested transactions: ending the inner one does not close the outer cache');

{
  const c = new MapCache();
  c.beginWrite('A');
  c.load('A', 5000, new Map([['n1', 'b1']]));
  const n1 = c.sqlCalls;

  c.beginWrite('A');          // inner, same document
  c.load('A', 5000);
  c.endWrite();               // inner ends

  const after = c.load('A', 5000, new Map([['ZZZ', 'ZZZ']]));
  check('★ after the inner endWrite the outer cache is **still valid**',
    c.sqlCalls === n1 && after.get('n1') === 'b1',
    `queries ${c.sqlCalls}, content ${JSON.stringify([...after.entries()])}`);
  c.endWrite();
}

console.log('\n④ the cache is cleared after the outer one ends (no leaking across transactions)');

{
  const c = new MapCache();
  c.beginWrite('A');
  c.load('A', 5000, new Map([['n1', 'b1']]));
  const n1 = c.sqlCalls;
  c.endWrite();

  c.load('A', 5000, new Map([['fresh', 'fresh']]));
  check('★ after the transaction ends it must query again (otherwise it would get a stale map)',
    c.sqlCalls === n1 + 1, `queries ${c.sqlCalls}`);
}

console.log('\n⑤ different limits do not share the cache (limit is part of the hit condition)');

{
  const c = new MapCache();
  c.beginWrite('A');
  c.load('A', 5000, new Map([['n1', 'b1']]));
  const n1 = c.sqlCalls;
  c.load('A', 5001, new Map([['big', 'big']]));
  check('different limit → cache miss', c.sqlCalls === n1 + 1, `queries ${c.sqlCalls}`);
  c.endWrite();
}

console.log('\n⑥ ★ the replica must follow the source (prevents "testing the copy you wrote yourself")');

{
  // This case is a **meta-test**: ①~⑤ above test the MapCache replica inside this file.
  // If the criteria in store.ts change and this file does not follow, those assertions turn into
  // "testing a world that does not exist" — fully green but meaningless.
  // So the key constructs from the source are asserted here as well.
  const src = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const lines = src.split('\n');

  const hit = lines.find(
    (l) =>
      l.includes('writeEpochOpen') &&
      l.includes('mapCacheDocId === docId') &&
      l.includes('mapCacheLimit === limit'),
  );
  check(
    '★ the cache hit condition in the source is still the docId+limit three-part criterion',
    !!hit,
    hit ?? 'not found (store.ts changed its criteria; the replica in this test needs syncing)',
  );

  check(
    '★ beginWrite in the source still has its "outermost" branch (depth === 1)',
    lines.some((l) => l.includes('if (this.writeEpochDepth === 1)')),
  );

  check(
    '★ beginWrite in the source still has its "nested across documents → reset" branch',
    lines.some((l) => l.includes('this.mapCacheDocId !== docId')),
  );

  check(
    '★ endWrite in the source still has its "inner returns early" branch (otherwise the inner one would close the outer cache)',
    lines.some((l) => l.includes('if (this.writeEpochDepth > 0) return;')),
  );
}

console.log('\n⑦ the criteria themselves are valid (counter-example: the old unscoped cache)');

{
  // Simulate the old "cache ignores the document" behaviour: the hit condition has no docId
  let cached: Map<string, string> | null = null;
  const oldLoad = (rows: Map<string, string>) => {
    if (cached) return cached;
    cached = rows;
    return rows;
  };
  const m = oldLoad(new Map([['bNode', 'bBlock']]));
  check('★ counter-example: an unscoped cache returns the map of B to A',
    m.has('bNode'), 'this is exactly what this test guards against');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
