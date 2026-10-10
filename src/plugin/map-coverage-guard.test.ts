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
 */

{
  let pass = 0, fail = 0;
  function check(name: string, got: boolean, want: boolean): void {
    if (got === want) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  expected ${want} but got ${got}`); }
  }
  function looksBroken(tree: number, mapped: number): boolean {
    if (tree <= 80) return false;
    const miss = tree - mapped;
    return miss > tree * 0.5;
  }
  console.log('Guard criterion (tree > 80 and missing > half):');
  check('150 with only 64 read (the real bug) -> block', looksBroken(150, 64), true);
  check('150 all read -> allow', looksBroken(150, 150), false);
  check('300 with only 64 read -> block', looksBroken(300, 64), true);
  check('300 with 150 read (exactly half) -> allow', looksBroken(300, 150), false);
  console.log('\nsmall documents are not wrongly blocked:');
  check('60 all newly created (map=0) -> allow', looksBroken(60, 0), false);
  check('80 all newly created -> allow', looksBroken(80, 0), false);
  check('81 all newly created -> block', looksBroken(81, 0), true);
  console.log('\nlegitimate bulk additions (the large document already has mappings):');
  check('150->155 (+5 new) -> allow', looksBroken(155, 150), false);
  check('150->220 (+70 new) -> allow', looksBroken(220, 150), false);
  check('150->260 (+110 new) -> allow (mappings are still the majority)', looksBroken(260, 150), false);
  check('150->310 (+160 new, over half missing) -> block', looksBroken(310, 150), true);
  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}
