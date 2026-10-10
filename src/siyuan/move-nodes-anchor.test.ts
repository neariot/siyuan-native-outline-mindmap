/**
 * The **predecessor anchor for moving nodes must be a listItem** (fix).
 *
 * ──────────────────────────────────────────────────────────────────
 * Symptom: on desktop, pressing Enter repeatedly makes "the logo page flash by" once every few seconds
 * ──────────────────────────────────────────────────────────────────
 *
 * Log from a real machine (Windows desktop 3.8.6, `<workspace>/temp/siyuan.log`):
 *
 *     E transaction.go:142: transaction failed and requires UI reload:
 *       invalid block structure: NodeListItem [gnt6669] cannot contain
 *       NodeListItem [tr7hfpf],
 *       operations [0:move id=tr7hfpf parent= previous=byp9fn7 next=]
 *
 * `parent=` being empty means only `previousID` was passed — exactly the
 * `moveBlock(blockId, '', prevBlockId)` signature in `moveNodes`.
 *
 * ──────────────────────────────────────────────────────────────────
 * Root cause: a **paragraph block** was used as the predecessor of a listItem
 * ──────────────────────────────────────────────────────────────────
 *
 * `loadBlockMap` fills two tables whose semantics are entirely different:
 *
 *     lastListItems : nodeId → **listItem block ID**   (k.type === 'i')
 *     lastBlockMap  : nodeId → **paragraph block ID**        (b.type === 'p')
 *
 * But `moveNodes` was originally written as:
 *
 *     prevBlockId = this.lastListItems.get(prevNodeId)
 *                || this.lastBlockMap.get(prevNodeId)     // ← fall back to the paragraph block
 *                || '';
 *
 * So when "the predecessor's listItem is not registered yet", a paragraph block is used as `previousID` to move a
 * listItem. The kernel derives the parent from previousID → it gets the listItem that paragraph belongs to
 * → "a listItem containing a listItem" → the structure check fails.
 *
 * ──────────────────────────────────────────────────────────────────
 * Why the result is "keeps flashing" instead of "flashes once"
 * ──────────────────────────────────────────────────────────────────
 *
 * ① After the transaction **rolls back**, the kernel goes `TxErrCodeReloadUI(=6)` → `util.ReloadUI()`
 *    → broadcasts `reloadui` → frontend `reloadUI()` → `window.location.reload()`
 *    → the `#loading` in the HTML shell (dark overlay + 24vh logo) appears one more time.
 *
 * ② It is **self-sustaining**: the move never succeeds ⇒ the document state is unchanged ⇒ the next round computes exactly
 *    the same result; and `actualPrev` in `orderOk` below comes from a `type='i'`
 *    query (which can only be a listItem), never equal to the paragraph block `prevBlockId`,
 *    so every round it decides the "order is wrong" and moves again.
 *
 * ⇒ Doing **nothing** when the predecessor is unknown is correct: once the listItem is registered next round, it corrects itself.
 *   It must **not** degrade into `parentID` positioning — `moveBlock(id, parentID=<List>)`
 *   means "insert at the very front of that container"; using it when `index > 0` scrambles the sibling order.
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

const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');

/** Slice out the body of moveNodes (by matching brackets, not by indentation) */
function moveNodesBody(): string {
  const start = store.indexOf('private async moveNodes(');
  if (start < 0) return '';
  const open = store.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < store.length; i++) {
    if (store[i] === '{') depth++;
    else if (store[i] === '}') {
      depth--;
      if (depth === 0) return store.slice(open, i);
    }
  }
  return store.slice(open);
}

/** Slice out the small "compute the expected predecessor" part: `let prevBlockId = '';` → `const actualParentBlock` */
function anchorSegment(src: string): string {
  const start = src.indexOf("let prevBlockId = '';");
  if (start < 0) return '';
  const end = src.indexOf('const actualParentBlock', start);
  return src.slice(start, end < 0 ? start + 900 : end);
}

/**
 * Health-check the "expected predecessor" code and return all violations.
 *
 * ★ The same function runs both the **real code** and the **bad samples** built below —
 *   otherwise there is no proof that these criteria really can defend (AGENTS.md: break the implementation, confirm it turns red).
 */
function anchorViolations(seg: string): string[] {
  const bad: string[] = [];
  if (!seg) {
    bad.push('the prevBlockId computation segment is not found');
    return bad;
  }
  // ① must not fall back to a paragraph block
  if (/lastBlockMap/.test(seg)) {
    bad.push('prevBlockId fell back to lastBlockMap (a paragraph block)');
  }
  // ② must take the listItem
  if (!/lastListItems/.test(seg)) {
    bad.push('prevBlockId did not take lastListItems (a listItem)');
  }
  // ③ must skip when index>0 and the predecessor is unknown
  if (!/if \(!prevBlockId\)\s*continue;/.test(seg)) {
    bad.push('no continue when the predecessor is unknown');
  }
  return bad;
}

const body = moveNodesBody();
const seg = anchorSegment(body);

// ──────────────────────────────────────────────────────────────────
console.log('real code: the predecessor anchor can only be a listItem');

{
  check('moveNodes is found', body.length > 0);
  check('the prevBlockId computation segment is found', seg.length > 0);

  const v = anchorViolations(seg);
  check('★ no violations after the fix', v.length === 0, v.join('; '));

  // If the fallback comes back to life, it recreates a NodeListItem inside a NodeListItem
  check(
    '★ prevBlockId must not read lastBlockMap (that is a paragraph block and creates illegal nesting)',
    !/lastBlockMap/.test(seg),
  );
  check(
    '★ it must continue when the predecessor is unknown (do not degrade into parentID positioning)',
    /if \(!prevBlockId\)\s*continue;/.test(seg),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe parentID branch for index === 0 must be kept');

{
  // continue should only block index > 0; index === 0 must still take the parentID path
  // (moving a child that is listed first but actually sits in the middle back to the front).
  check(
    '★ the parentID branch for index===0 is still there',
    /if \(!prevBlockId\) \{/.test(body),
  );
  check(
    '★ the call that goes through parentID is still there (the first-position correction must not be deleted along with it)',
    /moveBlock\(blockId, wantListId\)/.test(body),
  );
  check(
    '★ with a predecessor it still positions by previousID',
    /moveBlock\(blockId, '', prevBlockId\)/.test(body),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criteria themselves are valid (feeding bad samples must fail)');

{
  // The real code from **before** the fix
  const OLD = `
      let prevBlockId = '';
      if (index > 0) {
        const prevNodeId = prevNodeOf.get(\`\${wantPid}#\${index}\`) ?? '';
        if (prevNodeId) {
          prevBlockId = this.lastListItems.get(prevNodeId) || this.lastBlockMap.get(prevNodeId) || '';
        }
      }
`;
  const oldV = anchorViolations(OLD);
  check(
    '★ the criteria recognize the pre-fix code (otherwise this test has no defensive value)',
    oldV.some((s) => s.includes('lastBlockMap')),
    oldV.join('; '),
  );

  // Half-baked fix: the paragraph-block fallback is gone, but **continue was forgotten**
  // — then prevBlockId is '' and falls into the parentID branch for index===0,
  //    inserting a node with index>0 at the very front of the container and scrambling the sibling order.
  const HALF = `
      let prevBlockId = '';
      if (index > 0) {
        const prevNodeId = prevNodeOf.get(\`\${wantPid}#\${index}\`) ?? '';
        prevBlockId = prevNodeId ? (this.lastListItems.get(prevNodeId) ?? '') : '';
      }
`;
  const halfV = anchorViolations(HALF);
  check(
    '★ the criteria recognize the half-baked fix that "drops the fallback but does not skip"',
    halfV.length > 0,
    halfV.join('; '),
  );

  // Reverse control: feed the correct code to the criteria; it must **not** fail
  check(
    '★ the criteria do not falsely fail correct code',
    anchorViolations(seg).length === 0 && anchorViolations(HALF).length > 0,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe semantics of the two tables must not be swapped');

{
  // This one guards the root cause itself: lastBlockMap must be **paragraph blocks**, lastListItems must be listItems.
  // If loadBlockMap ever fills the two the wrong way round, the fix above loses its meaning.
  check(
    '★ in loadBlockMap, lastBlockMap ← paragraph block (type === "p")',
    /para\.push\(\{\s*nodeId:\s*n\.id,\s*blockId:\s*p\.id\s*\}\)/.test(store) &&
      /lastBlockMap\.set\(p\.nodeId,\s*p\.blockId\)/.test(store),
  );
  check(
    '★ in loadBlockMap, lastListItems ← listItem (type === "i")',
    /items\.push\(\{\s*nodeId:\s*n\.id,\s*liId:\s*li\[i\]\.id\s*\}\)/.test(store) &&
      /lastListItems\.set\(it\.nodeId,\s*it\.liId\)/.test(store),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
