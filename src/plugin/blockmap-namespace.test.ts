/**
 * Pure-logic tests for the reverse-lookup table namespace and the "keep uncatalogued mappings" semantics.
 *
 * Mirrors the three-table build + retention logic of `SiYuanStore.loadBlockMap`,
 * plus the skip criterion of `saveNodesIncremental`.
 *
 * Corresponds to .logs/API-GOTCHAS.md §80 / §82.
 *
 * ★ Why a pure class instead of a real kernel: these are **state-machine semantics**, not an API contract.
 *   A real kernel only verifies "is the final document right" and cannot reliably reproduce timing problems such as "the mapping got washed away".
 */
// ★ The `export {}` makes this a **module**: otherwise `pass`/`fail`/`check` land in the global scope,
//   colliding with the other script-style test.ts files in this directory (e.g. map-coverage-guard.test.ts),
//   which makes `tsc --noEmit` report TS2451. These tests compile and run independently and need no shared scope.
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

/** One row returned by SQL: a listItem and its child paragraph */
interface Row {
  id: string; // listItem block ID
  ial: string; // inline attributes
  child: string; // child paragraph block ID
}

/**
 * Mirrors the table build + retention semantics of loadBlockMap.
 * `prev` is the three tables left by the previous call (the real implementation reads instance fields).
 */
class MapModel {
  lastBlockMap = new Map<string, string>();
  lastListItems = new Map<string, string>();
  lastByBlock = new Map<string, string>();
  everSeen = new Set<string>();

  load(rows: Row[]): Map<string, string> {
    const map = new Map<string, string>();
    // ★ keep the mappings "we have seen with our own eyes but the SQL index has not catalogued yet"
    const prevMap = this.lastBlockMap;
    const prevListItems = this.lastListItems;
    const prevByBlock = this.lastByBlock;
    this.lastBlockMap = map;
    this.lastListItems = new Map<string, string>();
    this.lastByBlock = new Map<string, string>();

    for (const r of rows) {
      const key = r.id;
      // the value is the **child paragraph block** (safe to updateBlock)
      map.set(key, r.child || r.id);
      // the listItem is recorded separately (structural anchor)
      this.lastListItems.set(key, r.id);
      this.lastByBlock.set(r.child || r.id, key);
      this.lastByBlock.set(r.id, key);
    }
    // add back the entries SQL did not return
    for (const [nodeId, blockId] of prevMap) {
      if (!map.has(nodeId) && blockId) {
        map.set(nodeId, blockId);
        const li = prevListItems.get(nodeId);
        if (li) this.lastListItems.set(nodeId, li);
        this.lastByBlock.set(blockId, nodeId);
        this.everSeen.add(blockId);
      }
    }
    for (const [bid, nodeId] of prevByBlock) {
      if (!this.lastByBlock.has(bid)) this.lastByBlock.set(bid, nodeId);
    }
    return map;
  }

  /** Mirrors how syncStructure registers a newly inserted node (the correct form) */
  registerInserted(nodeId: string, listItemId: string, paragraphId: string): void {
    this.lastBlockMap.set(nodeId, paragraphId); // map stores the **paragraph block**
    this.lastListItems.set(nodeId, listItemId); // the listItem is stored separately
    this.lastByBlock.set(paragraphId, nodeId);
    this.lastByBlock.set(listItemId, nodeId);
    this.everSeen.add(paragraphId);
    this.everSeen.add(listItemId);
  }
}

/** Mirrors the skip criterion of saveNodesIncremental */
const shouldWrite = (
  blockId: string | undefined,
  oldText: string | undefined,
  newText: string,
): boolean => {
  if (!blockId) return false; // no mapping → leave it to syncStructure
  // ★ The corrected criterion: oldText === undefined must be written as well
  return oldText === undefined || oldText !== newText;
};

console.log('=== Reverse-lookup table namespace ===');

// 1. Normal: map holds the paragraph block, listItems holds the listItem
{
  const m = new MapModel();
  const map = m.load([{ id: 'L1', ial: '', child: 'P1' }]);
  check('the map value is the **paragraph block**', map.get('L1') === 'P1');
  check('the listItems value is the **listItem**', m.lastListItems.get('L1') === 'L1');
  check('the two values differ (namespaces are isolated)', map.get('L1') !== m.lastListItems.get('L1'));
}

// 2. The key is the listItem block ID (same as kramdownToTree)
{
  const m = new MapModel();
  const map = m.load([{ id: 'L1', ial: '', child: 'P1' }]);
  check('with no attributes the key is the listItem block ID', map.has('L1'));
  check('with no attributes the value is still the paragraph block', map.get('L1') === 'P1');
}

console.log('\n=== Keeping mappings "not catalogued by SQL" (ghost duplicate node fix) ===');

// 3. A just-inserted block is not in the SQL index yet → the rebuild must keep it
{
  const m = new MapModel();
  m.load([{ id: 'L1', ial: '', child: 'P1' }]);
  m.registerInserted('N-new', 'L-new', 'P-new');
  // next load: SQL has only L1 (the index has not caught up with the new block)
  const map = m.load([{ id: 'L1', ial: '', child: 'P1' }]);
  check('★ the new block mapping is kept (otherwise it is inserted again)', map.get('N-new') === 'P-new');
  check('★ what is kept is the **paragraph block**, not the listItem', map.get('N-new') !== 'L-new');
  check('the listItem of the kept entry is restored as well', m.lastListItems.get('N-new') === 'L-new');
  check('the kept entry enters everSeen (used by the deletion gate)', m.everSeen.has('P-new'));
}

// 4. Once SQL has catalogued it SQL wins (no stale value is kept after the index catches up)
{
  const m = new MapModel();
  m.lastBlockMap.set('N1', 'P-old');
  m.lastListItems.set('N1', 'L-old');
  const map = m.load([{ id: 'L1', ial: '', child: 'P1' }]);
  check('SQL has catalogued it → the SQL value overwrites the old one', map.get('L1') === 'P1');
}

// 5. ★ Regression: pollution must not be frozen in (§80)
{
  const m = new MapModel();
  // simulate a polluted table: the map holds a listItem
  m.lastBlockMap.set('N1', 'L1');
  m.lastListItems.set('N1', 'L1');
  // SQL does not have that block (newly inserted) → kept → the pollution is frozen in
  const map = m.load([]);
  check(
    '★ a polluted map value is kept (so loadBlockMap **cannot** heal pollution by itself)',
    map.get('N1') === 'L1',
  );
  // Conclusion: the **write side** must guarantee there is no pollution
  const m2 = new MapModel();
  m2.load([]);
  m2.registerInserted('N2', 'L2', 'P2');
  const map2 = m2.load([]);
  check('★ a correctly registered value is still the paragraph block after retention', map2.get('N2') === 'P2');
}

// 6. The byBlock reverse lookup does not push a listItem back into map as a **key** (namespace isolation)
{
  const m = new MapModel();
  m.lastByBlock.set('SOMEBLOCK', 'SOMENODE');
  const map = m.load([]);
  check('★ a byBlock block ID never becomes a key of map', !map.has('SOMEBLOCK'));
  check('the byBlock reverse lookup itself is kept', m.lastByBlock.get('SOMEBLOCK') === 'SOMENODE');
}

console.log('\n=== saveNodesIncremental skip criterion (the text would not get written fix) ===');

// 7. Just inserted, not indexed by SQL → oldText undefined → **still must write**
check('★ it still writes when oldText is undefined (the old implementation skipped → lost text)', shouldWrite('P1', undefined, '新') === true);
check('the text really differs → write', shouldWrite('P1', '旧', '新') === true);
check('the text is the same → skip', shouldWrite('P1', '新', '新') === false);
check('no mapping → do not write (leave it to syncStructure)', shouldWrite(undefined, undefined, '新') === false);
check('empty text is written too (so old content cannot linger)', shouldWrite('P1', '旧', '') === true);

console.log('\n=== Regression: the old path is unaffected ===');
{
  const m = new MapModel();
  m.load([
    { id: 'L1', ial: '', child: 'P1' },
    { id: 'L2', ial: '', child: 'P2' },
  ]);
  // normal rebuild (every block is in SQL): the result must match the first load
  const map = m.load([
    { id: 'L1', ial: '', child: 'P1' },
    { id: 'L2', ial: '', child: 'P2' },
  ]);
  check('a normal rebuild is stable', map.get('L1') === 'P1' && map.get('L2') === 'P2');
  check('the map size is right after a normal rebuild', map.size === 2);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
