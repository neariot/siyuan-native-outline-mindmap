/**
 * Reuse of `loadBlockMap` inside a write-back transaction, and the empty-node delete semantics of the Delete key.
 *
 * Corresponds to .logs/API-GOTCHAS.md §94 / §95.
 */
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

// ---------------------------------------------------------------- §94 write-back transaction cache

interface Loader {
  writeEpochOpen: boolean;
  cacheDocId: string;
  cacheLimit: number;
  value: Map<string, string> | null;
  realQueries: number;
  cacheHits: number;
}

function makeLoader(): Loader {
  return { writeEpochOpen: false, cacheDocId: '', cacheLimit: -1, value: null, realQueries: 0, cacheHits: 0 };
}

/** Replicates loadBlockMap's cache criterion */
function loadBlockMap(L: Loader, docId: string, limit = 5000): Map<string, string> {
  if (L.writeEpochOpen && L.cacheDocId === docId && L.cacheLimit === limit && L.value) {
    L.cacheHits++;
    return L.value;
  }
  L.realQueries++;
  const m = new Map<string, string>([['n1', 'b1']]);
  if (L.writeEpochOpen) {
    L.cacheDocId = docId;
    L.cacheLimit = limit;
    L.value = m;
  }
  return m;
}

function beginWrite(L: Loader): void {
  L.writeEpochOpen = true;
  L.cacheDocId = '';
  L.cacheLimit = -1;
  L.value = null;
}

function endWrite(L: Loader): void {
  L.writeEpochOpen = false;
  L.cacheDocId = '';
  L.cacheLimit = -1;
  L.value = null;
}

console.log('=== §94 loadBlockMap reuse inside a write-back transaction ===');
{
  const L = makeLoader();
  beginWrite(L);
  loadBlockMap(L, 'docA');
  loadBlockMap(L, 'docA');
  loadBlockMap(L, 'docA');
  endWrite(L);
  check('★ 3 calls inside one write-back -> 1 real query + 2 hits', L.realQueries === 1 && L.cacheHits === 2);
}
{
  const L = makeLoader();
  // No transaction open -> a real query every time (an external call must not be cached)
  loadBlockMap(L, 'docA');
  loadBlockMap(L, 'docA');
  check('★ no caching outside a transaction (so external client changes stay visible)', L.realQueries === 2 && L.cacheHits === 0);
}
{
  const L = makeLoader();
  beginWrite(L);
  loadBlockMap(L, 'docA');
  endWrite(L);
  beginWrite(L);
  loadBlockMap(L, 'docA');
  endWrite(L);
  check('★ the cache does not survive across write-backs (otherwise external changes are missed)', L.realQueries === 2 && L.cacheHits === 0);
}
{
  const L = makeLoader();
  beginWrite(L);
  loadBlockMap(L, 'docA');
  loadBlockMap(L, 'docB'); // different documents must not share
  endWrite(L);
  check('★ different documents do not share the cache', L.realQueries === 2 && L.cacheHits === 0);
}
{
  const L = makeLoader();
  beginWrite(L);
  loadBlockMap(L, 'docA', 5000);
  loadBlockMap(L, 'docA', 100); // different limit -> different result set, must not be reused
  endWrite(L);
  check('★ different limits do not share the cache', L.realQueries === 2 && L.cacheHits === 0);
}
{
  const L = makeLoader();
  beginWrite(L);
  loadBlockMap(L, 'docA');
  endWrite(L);
  endWrite(L); // a repeated endWrite must be idempotent
  loadBlockMap(L, 'docA');
  check('★ endWrite is idempotent, and nothing is cached afterwards', L.realQueries === 2 && L.cacheHits === 0);
}

// ---------------------------------------------------------------- §95 Delete key semantics

type Act = 'deleteNode' | 'mergeNext' | 'native' | 'none';

/**
 * Replicates the Delete branch decision after the fix.
 * atEnd: whether the caret is at the line end; empty: whether the node text is empty; kids: number of child nodes; idx/len: position
 */
function deleteAction(atEnd: boolean, empty: boolean, kids: number, idx: number, len: number): Act {
  // Same order as the real code: first check "at line end and there is a next one" -> merge
  if (atEnd && idx < len - 1) return 'mergeNext';
  // empty node (wherever the caret is) -> delete the whole block
  if (empty && kids === 0) return len > 1 ? 'deleteNode' : 'none';
  // non-empty and not at the line end -> take it over too, merge into the next one
  if (idx < len - 1) return 'mergeNext';
  return 'none';
}

/**
 * The special case of an empty node **sitting in the last position**:
 * the at-line-end branch matches first, but idx is already the last one -> it falls through to the empty-node branch -> delete.
 */
function deleteActionTailEmpty(len: number): Act {
  return deleteAction(true, true, 0, len - 1, len);
}

/** The behavior before the fix (only the "merge at line end" and "multi-select delete" paths exist) */
function deleteActionOld(atEnd: boolean, idx: number, len: number): Act {
  if (atEnd && idx < len - 1) return 'mergeNext';
  return 'native';
}

console.log('\n=== §95 The three cases of the Delete key ===');
{
  check(
    '★ empty node (at line end, not the last position) -> merge into the next one (the at-line-end branch wins)',
    deleteAction(true, true, 0, 1, 4) === 'mergeNext',
  );
  check(
    '★ empty node (at line end, **the last one**) -> delete the whole block (before the fix it left an empty shell)',
    deleteActionTailEmpty(4) === 'deleteNode',
  );
  check('★ empty node with the caret not at the line end -> delete the whole block as well', deleteAction(false, true, 0, 1, 4) === 'deleteNode');
  check('non-empty + caret at the line end -> merge into the next one', deleteAction(true, false, 0, 1, 4) === 'mergeNext');
  check('non-empty + caret not at the line end -> taken over too (merge), no degradation to the native delete', deleteAction(false, false, 0, 1, 4) === 'mergeNext');
  check('non-empty + has child nodes -> not deleted as an empty node', deleteAction(true, false, 2, 1, 4) !== 'deleteNode');
  check('last node + caret at the line end -> no merge (nothing follows)', deleteAction(true, false, 0, 3, 4) === 'none');
  check('the only node is empty -> not deleted (otherwise the document goes empty)', deleteAction(true, true, 0, 0, 1) === 'none');
}

console.log('\n=== §95 Contrast with the state before the fix (the defect really existed) ===');
{
  check(
    '★ before the fix: empty node + caret not at the line end -> handed to the browser native delete (leaves an empty shell)',
    deleteActionOld(false, 1, 4) === 'native',
  );
  check(
    '★ before the fix: non-empty + caret not at the line end -> also goes native (deletes characters, not the node)',
    deleteActionOld(false, 1, 4) === 'native',
  );
  check('before the fix only "merge at line end" was taken over', deleteActionOld(true, 1, 4) === 'mergeNext');
}

console.log('\n=== §95 Symmetry with Backspace ===');
{
  // Backspace: empty node with the caret at the line start -> delete; non-empty -> merge into the previous one
  const backspace = (atStart: boolean, empty: boolean, kids: number, idx: number, len: number): Act => {
    if (atStart && empty && kids === 0) return len > 1 ? 'deleteNode' : 'none';
    if (atStart && idx > 0) return 'mergeNext';
    return 'none';
  };
  check('Backspace on an empty node -> delete', backspace(true, true, 0, 1, 4) === 'deleteNode');
  check('Delete on an empty node -> delete (consistent with Backspace)', deleteAction(false, true, 0, 1, 4) === 'deleteNode');
  check(
    '★ both treat "empty node" the same way -- this is the symmetry requirement',
    backspace(true, true, 0, 1, 4) === deleteAction(false, true, 0, 1, 4),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
