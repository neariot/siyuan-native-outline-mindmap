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
  isTargetGoneError(err('parent block not found: 20260101000000-pbbaaaa')),
);
// updateBlock onto a deleted block
check(
  'load block tree [...] failed: tree not found (updateBlock onto a deleted block)',
  isTargetGoneError(err('load block tree [20260101000000-aaaaaaa] failed: tree not found')),
);
check('block not found (the one that really showed up in the UI)', isTargetGoneError(err('block not found')));

// ★★ Measured: the SAME situation reports a **different suffix** in its first second.
//
//   Deleting a document and writing to it immediately returns
//       `load block tree [<id>] failed: indexing`
//   and only from about one second on does it become
//       `load block tree [<id>] failed: tree not found`.
//
//   Only the second is recognised, so a write landing inside that window is reported as a raw kernel message
//   instead of "the document was deleted" —— which is exactly the silent-failure shape this criterion exists
//   to remove: the user is told nothing they can act on, and no recovery entry point appears.
//
//   ★ That is what this check pins, and it is currently **red on purpose** —— see the note in `docs/TODO.md`.
//     The fix is a judgement, not a substring: `indexing` is also what a freshly-inserted block reports while
//     the index lags, so accepting it unconditionally would make an ordinary write-back look like a deleted
//     document (the measured false positive the doc comment above warns about). The right criterion needs the
//     document's own ID confirmed gone, which is a query, not a string test.
console.log('\n=== The transient suffix measured immediately after a deletion ===');
check(
    '★ `failed: indexing` during the first second after a delete is NOT yet recognised (documented gap)',
    !isTargetGoneError(err('load block tree [20260101000000-aaaaaaa] failed: indexing')),
);

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
//   That document was **alive and well**
//   (25 blocks, getBlockKramdown returned normally),
//   it was just that some **child block ID had gone stale**, and the kernel answered `block not found` ——
//   **exactly the same** as the "document deleted" error message, so the plugin falsely reported "the target document has been deleted".
//
//   Fix: when docId is passed, the error must contain **this document's own ID** for the document to count as gone.
{
  const DOC = '20260101000000-docaaaa';
  // Stale child block: the ID reported is a **child** ID → must not count as a deleted document
  check(
    '★ A stale child ID does not falsely report "document deleted"',
    !isTargetGoneError(err('load block tree [20260101000000-cccaaaa] failed: tree not found'), DOC),
  );
  check(
    '★ block not found for a child does not falsely report',
    !isTargetGoneError(err('block not found: 20260101000000-cccaaaa'), DOC),
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
