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
 * This test replicates the behavior of beginWrite/endWrite/loadBlockMap's cache criterion in store.ts,
 * with no dependency on the kernel -- pure logic verification.
 */

{
  let pass = 0;
  let fail = 0;
  function check(name: string, cond: boolean): void {
    if (cond) {
      pass++;
      console.log('  ✓ ' + name);
    } else {
      fail++;
      console.log('  ✗ ' + name);
    }
  }

  /** Replicates the write-back transaction state machine of SiYuanStore */
  class Guard {
    private open = false;
    private depth = 0;
    cacheDocId = '';
    cacheLimit = -1;
    cacheValue: Map<string, string> | null = null;
    queries = 0;

    beginWrite(docId = ''): void {
      this.depth++;
      this.open = true;
      if (this.depth === 1) {
        this.cacheDocId = docId;
        this.cacheLimit = -1;
        this.cacheValue = null;
      } else if (docId && this.cacheDocId !== docId) {
        this.cacheDocId = docId;
        this.cacheLimit = -1;
        this.cacheValue = null;
      }
    }

    endWrite(): void {
      if (this.depth > 0) this.depth--;
      if (this.depth > 0) return;
      this.open = false;
      this.cacheDocId = '';
      this.cacheLimit = -1;
      this.cacheValue = null;
    }

    /** Replicates loadBlockMap's cache-hit criterion */
    loadBlockMap(docId: string, limit: number, value: Map<string, string>): Map<string, string> {
      if (this.open && this.cacheDocId === docId && this.cacheLimit === limit && this.cacheValue) {
        return this.cacheValue;
      }
      this.queries++;
      this.cacheDocId = docId;
      this.cacheLimit = limit;
      this.cacheValue = value;
      return value;
    }

    get isOpen(): boolean {
      return this.open;
    }
    get nestingDepth(): number {
      return this.depth;
    }
  }

  console.log('\n=== Write-back transaction nesting depth ===');

  // (1) Single level: behavior matches the old implementation
  {
    const g = new Guard();
    g.beginWrite('docA');
    const v = new Map([['a', 'b']]);
    g.loadBlockMap('docA', -1, v);
    check('cache hits inside a single-level transaction', g.loadBlockMap('docA', -1, new Map()) === v && g.queries === 1);
    g.endWrite();
    check('closes after a single level ends', !g.isOpen && g.cacheValue === null);
  }

  // (2) ★ Core regression: an inner endWrite must not shut down a cache the outer level still uses
  {
    const g = new Guard();
    g.beginWrite('docA');
    const v = new Map([['a', 'b']]);
    g.loadBlockMap('docA', -1, v);
    g.beginWrite('docA'); // second write-back, concurrent/nested
    check('depth is 2 after the inner begin', g.nestingDepth === 2);
    g.endWrite(); // inner level ends -- the old implementation would set open to false and clear the cache here
    check('★ the transaction is still open after the inner endWrite', g.isOpen, );
    check('★ the cache is still valid after the inner endWrite', g.cacheValue === v);
    check('★ the cache still hits after the inner endWrite (no repeated SQL query)', g.loadBlockMap('docA', -1, new Map()) === v && g.queries === 1);
    g.endWrite(); // outermost level ends
    check('really closes only after the outermost endWrite', !g.isOpen && g.cacheValue === null && g.nestingDepth === 0);
  }

  // (3) Repeated endWrite is idempotent (must not push the depth negative)
  {
    const g = new Guard();
    g.beginWrite('docA');
    g.endWrite();
    g.endWrite();
    g.endWrite();
    check('repeated endWrite is idempotent, depth never negative', g.nestingDepth === 0 && !g.isOpen);
  }

  // (4) Nesting across documents: the cache must reset for the new document, otherwise it reads the wrong document's map
  {
    const g = new Guard();
    g.beginWrite('docA');
    const vA = new Map([['a', 'A']]);
    g.loadBlockMap('docA', -1, vA);
    g.beginWrite('docB');
    const vB = new Map([['b', 'B']]);
    const got = g.loadBlockMap('docB', -1, vB);
    check('★ the cache of the old document is not reused when nesting across documents', got === vB && got !== vA);
    g.endWrite();
    g.endWrite();
    check('closes after a cross-document nesting ends completely', !g.isOpen);
  }

  // (5) Counter-example for the old implementation: proves the boolean breaks (so nobody changes it back)
  {
    let open = false;
    let value: Map<string, string> | null = null;
    // Simulates the old implementation: no depth, endWrite just sets false and clears
    const oldBegin = (): void => {
      open = true;
      value = null;
    };
    const oldEnd = (): void => {
      open = false;
      value = null;
    };
    oldBegin();
    value = new Map([['a', 'b']]);
    oldBegin(); // second write-back
    oldEnd(); // first one ends
    check('★ counter-example: the old implementation has already closed wrongly here', !open && value === null);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}
