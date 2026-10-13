/**
 * Kernel side effects: every probe is green, yet the kernel changed the data.
 *
 * Corresponds to `docs/kernel-api.md` §7.1 / §7.15 / §7.16.
 *
 * ★ Core point: `code:0` only means "the transaction was accepted", **not that the result matches expectations** ——
 *   the same insert lands at the top level, inside the child list, or overwrites an existing item depending
 *   on the structure its anchor sits in, and all three return `code: 0`. The measurements are in
 *   `docs/kernel-api.md` §7.16 (with the table of the three anchor forms).
 *
 * ★ What this file asserts is the plugin's **discipline** in the face of that, because the measurements
 *   themselves were previously modelled here with local functions returning hand-written literals ——
 *   `anchorUnresolved.landedAt === 'top'` for an object constructed with `landedAt: 'top'` —— so no change
 *   to the plugin could turn them red. The rules it holds now:
 *
 *   · an insert takes the anchor form that cannot lose data (the parent's **paragraph**), and
 *   · the position is never assumed: the real structure is read back from the kernel's in-memory AST, the
 *     target container is resolved per parent, and a node whose real parent cannot be resolved is
 *     **skipped** instead of moved somewhere arbitrary.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { callSites, fnBody } from './source-probe';

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

// ★ `fnBody` strips comments by default: these assertions must be satisfied by **code**, since the names
//   also appear in the paragraphs that explain the rule.
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'siyuan', 'store.ts'), 'utf8');

console.log('=== the insert anchor is the form that cannot lose data ===');
{
  const body = fnBody(storeSrc, 'private async ensureChildList(');
  check('★ the child list is created for a list item (precondition: the method was found)', body.length > 0);
  check('★★ the anchor is the parent\'s **paragraph** block, taken from the live AST or the mapping',
    body.includes('itemToParagraph') && body.includes('lastBlockMap'),
    'an anchor that is the List itself is the measured overwrite/top-level form');
  check('★ the anchor is handed to the kernel as previousID',
    /previousID/.test(body) || /insertBlock/.test(body), body.slice(0, 120));
}

console.log('\n=== the position is never assumed: it is read back and corrected ===');
{
  const body = fnBody(storeSrc, 'private async moveNodes(');
  check('★ the method exists (precondition)', body.length > 0);
  check('★★ the real structure comes from the kernel AST (`actualParentOf`), not from the call\'s return value',
    body.includes('actualParentOf'), 'the return type of insertBlock is not fixed (§7.16)');
  check('★★★ a node whose real parent cannot be resolved is **skipped**, never moved blind',
    body.includes('if (!actualParentBlock) continue;'),
    'the guard is what stops "moved: 0" from meaning "somebody looked at it"');
  check('★★ the target container is resolved per parent, not derived from the node id',
    body.includes('resolveWantList(') && body.includes('wantListId'),
    'the container the node should be under is looked up for its parent');
}

console.log('\n=== the resolution helper really exists and is called ===');
{
  // Precondition of the check above: a call to a helper that does not exist would be a compile error, but a
  // helper that is never called would leave the container resolution in the caller's hands —— so both ends
  // are asserted, found through the parser because the name also appears in prose.
  const defs = callSites(storeSrc, /^resolveWantList$/);
  check('★★ resolveWantList() is called from the move pass (and only there)', defs.length === 1, defs.join(', '));
  check('★ it reads the top list from the AST rather than assuming the first list in the document',
    fnBody(storeSrc, 'const resolveWantList = async (').includes('topListId'),
    'topListId');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
