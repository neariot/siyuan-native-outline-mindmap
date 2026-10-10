/**
 * The decision boundary of `isTargetGoneError`.
 *
 * Corresponds to .logs/API-GOTCHAS.md §85 (target document deleted externally → edit silently lost).
 *
 * ★ Why this is worth a unit test: the predicate decides whether the UI shows
 *   "a useless block not found" or "a readable message + a save-as recovery entry".
 *   The kernel has no stable error code, so we must match the message and pin the
 *   **actually observed wording** down, lest a kernel rewording silently lose recovery.
 */
export {};

import { SiYuanError, isTargetGoneError } from '../siyuan/api';

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

/** Build an error out of the message the kernel really returned (measured) */
const err = (msg: string): SiYuanError => new SiYuanError(msg, -1, '/api/block/insertBlock');

console.log('=== Actually observed "target no longer exists" messages ===');

// insertBlock into a deleted document
check(
  'parent block not found (insertBlock into a deleted document)',
  isTargetGoneError(err('parent block not found: 20261005160951-cgtixm8')),
);
// updateBlock onto a deleted block
check(
  'load block tree [...] failed: tree not found (updateBlock onto a deleted block)',
  isTargetGoneError(err('load block tree [20260101000000-aaaaaaa] failed: tree not found')),
);
check('block not found (the one that really showed up in the UI)', isTargetGoneError(err('block not found')));

console.log('\n=== Case sensitivity and substring matching ===');
check('uppercase is recognized too', isTargetGoneError(err('Parent Block Not Found: x')));
check('prefix is irrelevant (substring match only)', isTargetGoneError(err('error: tree not found (id=x)')));

console.log('\n=== Must not be misjudged ===');
check('an ordinary network error is not misjudged', !isTargetGoneError(err('NetworkError when attempting to fetch resource')));
check('a permission error is not misjudged', !isTargetGoneError(err('permission denied')));
check('a SQL syntax error is not misjudged', !isTargetGoneError(err('no such column: foo')));
check('a plain Error (not a SiYuanError) is not misjudged', !isTargetGoneError(new Error('parent block not found')));
check('a string is not misjudged', !isTargetGoneError('parent block not found'));
check('null is not misjudged', !isTargetGoneError(null));
check('undefined is not misjudged', !isTargetGoneError(undefined));

// ★★★ False-positive regression ("the original document was deleted" struck again).
//
//   That document `20261009154100-mpqi2c7` was **alive and well**
//   (25 blocks, getBlockKramdown returned normally),
//   it was just that some **child block ID had gone stale**, and the kernel answered `block not found` ——
//   **exactly the same** as the "document deleted" error message, so the plugin falsely reported "the target document has been deleted".
//
//   Fix: when docId is passed, the error must contain **this document's own ID** for the document to count as gone.
{
  const DOC = '20261009154100-mpqi2c7';
  // Stale child block: the ID reported is a **child** ID → must not count as a deleted document
  check(
    '★ A stale child ID does not falsely report "document deleted"',
    !isTargetGoneError(err('load block tree [20261009154117-uh5jq6l] failed: tree not found'), DOC),
  );
  check(
    '★ block not found for a child does not falsely report',
    !isTargetGoneError(err('block not found: 20261009154117-uh5jq6l'), DOC),
  );
  // The document really is gone: the ID reported is the **document** ID → must be detected
  check(
    '★ The document counts as deleted only when its own ID appears',
    isTargetGoneError(err(`load block tree [${DOC}] failed: tree not found`), DOC),
  );
  check(
    '★ parent block not found carrying the document ID is still detected',
    isTargetGoneError(err(`parent block not found: ${DOC}`), DOC),
  );
  // Without docId, keep the old behaviour (backward compatible; do not lose the existing recovery entry point)
  check('★ Without docId the old behaviour is kept', isTargetGoneError(err('block not found')));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
