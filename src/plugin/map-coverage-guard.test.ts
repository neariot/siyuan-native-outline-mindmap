/**
 * Regression test for the criterion of the "incomplete mapping" guard.
 *
 * Background (a severe bug measured in practice): `sql()` used to mistake the **LIMIT inside a subquery**
 * for an outer LIMIT and therefore did not add an outer LIMIT, so `loadBlockMap` got only 64 rows back
 * (SiYuan's default cap for a query without LIMIT). Only 64 of the 150 nodes in the tree were mapped,
 * the other 86 were judged "newly added in the UI" -> **re-inserted** -> the document grew from 150 rows to 236,
 * while the UI looked completely normal and raised no error at all.
 *
 * Guard criterion: tree > 80 nodes and more than half of them missing from the mapping -> abort the write-back.
 * This test pins the boundaries of that criterion, so that a later threshold change does not wrongly block legitimate bulk additions.
 *
 * ★ The criterion is imported from `src/siyuan/store.ts`, the code that refuses the write. It used to be
 *   re-implemented in this file, so the eleven cases below compared a copy with itself and the guard's two
 *   numbers could be changed without turning anything red —— a safety check that decides whether a document
 *   is rewritten, with no defence at all. The cases are the same eleven; they fail when the product moves.
 */
export {};

import { mappingLooksIncomplete } from '../siyuan/store';

let pass = 0;
let fail = 0;
const check = (name: string, tree: number, mapped: number, want: boolean): void => {
  const got = mappingLooksIncomplete(tree, tree - mapped);
  if (got === want) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  expected ${want} but got ${got} (tree=${tree} mapped=${mapped})`);
  }
};

console.log('Guard criterion (tree > 80 and missing > half):');
check('150 with only 64 read (the real bug) -> block', 150, 64, true);
check('150 all read -> allow', 150, 150, false);
check('300 with only 64 read -> block', 300, 64, true);
check('300 with 150 read (exactly half) -> allow', 300, 150, false);
console.log('\nsmall documents are not wrongly blocked:');
check('60 all newly created (map=0) -> allow', 60, 0, false);
check('80 all newly created -> allow', 80, 0, false);
check('81 all newly created -> block', 81, 0, true);
console.log('\nlegitimate bulk additions (the large document already has mappings):');
check('150->155 (+5 new) -> allow', 155, 150, false);
check('150->220 (+70 new) -> allow', 220, 150, false);
check('150->260 (+110 new) -> allow (mappings are still the majority)', 260, 150, false);
check('150->310 (+160 new, over half missing) -> block', 310, 150, true);
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
