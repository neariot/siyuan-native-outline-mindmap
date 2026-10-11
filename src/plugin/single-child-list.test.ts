/**
 * A child node must be **merged into the parent's existing child list**, not create a new child list for every insertion.
 *
 * Corresponds to .logs/API-GOTCHAS.md §108.
 *
 * ★ This is the **last layer** of root cause for defect #53:
 *   a wrong insertion anchor → **two sibling child lists** appear under 甲 →
 *   the child node's blockId is a List (not a listItem) →
 *   `moveNodes`'s `actualParentOf` (only accepts type='i') cannot find it →
 *   `if (!actualParentBlock) continue` skips it → **the order can never be corrected**.
 *
 * ★ The file used to build a `Blk[]` block table by hand and render it with a local `render()` —— a model of
 *   what the kernel does with each anchor, asserted against itself. What the plugin is responsible for is
 *   the **lookup before create**: `ensureChildList` must find the list that is already there and remember
 *   the one it created, instead of asking the kernel for a new List every time. That is what these cases
 *   read, from `src/siyuan/store.ts`, through the parser (`fnBody` strips comments, because the rules are
 *   also written out in prose).
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { fnBody } from './source-probe';

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

const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'siyuan', 'store.ts'), 'utf8');
const body = fnBody(storeSrc, 'private async ensureChildList(');

console.log('=== the existing child list is looked up before a new one is created ===');
{
  check('★ the method exists (precondition)', body.length > 0, 'ensureChildList was not found');

  // ★ The check names the **read** of the table, not any mention of it: the writes to the table also sit
  //   before the create call, so "some mention precedes it" would stay green with the lookup deleted.
  const readAt = body.indexOf('childListByItem.get(');
  const createAt = body.indexOf('insertBlock(');
  check('★ it asks the table for this list item\'s child list',
    readAt >= 0 && createAt >= 0, `read=${readAt} create=${createAt}`);
  check('★★★ that read comes **before** the call that creates a List',
    readAt >= 0 && createAt >= 0 && readAt < createAt,
    'a create before the lookup means a second child list per parent, which is defect #53\'s shape');
  check('★★ a cached hit is returned as it is —— nothing is created for a parent that already has a list',
    /if \(cached\) return \{ listId: cached/.test(body));

  // The list that is already there: found through the cached table or through SQL, and remembered either way.
  check('★★ a list found in the document is remembered for the rest of this round',
    /childListByItem\.set\(listItemId, (found\?\.\[0\]\?\.id|found\[0\]\.id)/.test(body),
    'without this, the next call for the same parent creates another List');
  check('★★ a list just created is remembered too',
    /childListByItem\.set\(listItemId, listId\)/.test(body),
    'moveNodes asks for the same parent repeatedly within one pass');
  check('★ "looked up and really absent" is cached as an empty string, not as "unknown"',
    /childListByItem\.set\(listItemId, ''\)/.test(body),
    'otherwise every call falls through to SQL again');
}

console.log('\n=== the probe sent to the kernel must produce a **List**, not a paragraph ===');
{
  // Measured: `data='placeholder'` produces a `p` block, so there is no List to indent into and the
  // indentation necessarily fails; `data='- placeholder'` produces `l` (a List) and returns its ID.
  check('★★ the placeholder markdown carries the list marker',
    body.includes("insertBlock('- placeholder'"), 'without `- ` the kernel returns a paragraph block');
  check('★ the returned ID is the List itself (the caller moves nodes into it)',
    /const listId = await this\.client\.insertBlock\(/.test(body), 'listId');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
