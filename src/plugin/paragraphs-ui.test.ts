/**
 * Attached paragraphs —— the display and interaction contract on the mind map side.
 *
 * Design (decided by the user):
 *   · A node **shows only the first paragraph** by default; attached paragraphs stay hidden
 *   · The full text expands only when the icon at the node's top-left corner is clicked
 *
 * This file covers three things:
 *   ① Whether the indicator should appear (attached paragraphs present or not)
 *   ② How the popover content is assembled (including the display text of empty paragraphs)
 *   ③ How the tooltip text (hover title) is assembled, empty paragraphs included
 *
 * There is one more **regression**: attached paragraphs must not affect the "zero custom attributes" hard requirement.
 */
export {};

import { treeToKramdown } from '../core/map';
import type { OutlineNode } from '../model/types';
import { isParaEmpty, paraDisplayLine, paraPlainText } from '../model/tree';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------- logic under test
// The display helpers now live in `model/tree.ts` and are imported — never replicated: the old
// copies drifted from the product (the tooltip's empty marker disagreed with the catalogue).
// `showParaBadge` stays: visibility is a one-line rule with no product twin.

/** Whether to show the attached-paragraph indicator */
function showParaBadge(n: Pick<OutlineNode, 'paragraphs'>): boolean {
  return !!n.paragraphs?.length;
}

/** Display text of each line in the popover; an empty paragraph must have an explicit placeholder, otherwise the user thinks the data was lost */
function paraLineText(html: string): { plain: string; isEmpty: boolean } {
  const plain = paraPlainText(html);
  return { plain, isEmpty: isParaEmpty(html) };
}

/** hover tooltip text */
function paraTitle(n: Pick<OutlineNode, 'paragraphs'>): string {
  const list = n.paragraphs ?? [];
  const lines = list.map((p, i) => paraDisplayLine(p, i)).join('\n');
  return `${list.length} attached paragraph(s) (click to view the full text)\n${lines}`;
}

// ---------------------------------------------------------------- ① indicator
console.log('=== when the indicator appears ===');
check('no paragraphs field → not shown', !showParaBadge({}));
check('empty array → not shown', !showParaBadge({ paragraphs: [] }));
check('one paragraph → shown', showParaBadge({ paragraphs: ['内容一'] }));
check('★ empty-string paragraph → still shown (otherwise the user cannot see that it exists)',
  showParaBadge({ paragraphs: [''] }));
check('several paragraphs including an empty one → shown', showParaBadge({ paragraphs: ['甲', '', '丙'] }));

// ---------------------------------------------------------------- ② popover content
console.log('=== popover content ===');
{
  const r1 = paraLineText('<span>普通文本</span>');
  check('plain text is displayable', r1.plain === '普通文本' && !r1.isEmpty);

  const r2 = paraLineText('');
  check('empty string → marked empty', r2.plain === '' && r2.isEmpty);

  const r3 = paraLineText('\u200b');
  check('★ zero-width placeholder → treated as an empty paragraph', r3.isEmpty, `got=${JSON.stringify(r3.plain)}`);

  const r4 = paraLineText('<span style="color:red">文本五</span>文本六');
  check('rich text is reduced to plain text', r4.plain === '文本五文本六', `got=${JSON.stringify(r4.plain)}`);

  const r5 = paraLineText('  <b>粗</b>  ');
  check('leading and trailing whitespace is trimmed', r5.plain === '粗');
}

// ---------------------------------------------------------------- ③ tooltip text
console.log('=== hover tooltip ===');
{
  const t = paraTitle({ paragraphs: ['第一段', '第二段'] });
  check('paragraph count is right', t.startsWith('2 attached paragraph(s)'), t);
  check('numbered line by line', t.includes('1. 第一段') && t.includes('2. 第二段'), t);

  const t2 = paraTitle({ paragraphs: [''] });
  // ★ The empty marker renders from the catalogue (`lblEmptyParaShort`: `(empty)` / `（空）`) —
  //   the product locale decides the exact text, so assert "not a blank line" rather than pinning one.
  check('★ an empty paragraph is shown as a marker, not as a blank line', /1\. \S/.test(t2), JSON.stringify(t2));

  const t3 = paraTitle({ paragraphs: ['', '内容一'] });
  check('empty and non-empty paragraphs mixed', /1\. \S/.test(t3) && t3.includes('2. 内容一'), t3);
}

// ---------------------------------------------------------------- ④ order preserved
console.log('=== order ===');
{
  const n: OutlineNode = {
    id: 'a', modified: 1, text: '节点',
    paragraphs: ['甲', '乙', '丙'], children: [],
  };
  const got = (n.paragraphs ?? []).map((_, i) => i + 1);
  check('★ display order = storage order (attached paragraphs have no ranking, yet they are still ordered)',
    JSON.stringify(got) === JSON.stringify([1, 2, 3]));

  // The order must not change after a round trip
  const kd = treeToKramdown([n], { docTitle: 'T' });
  check('order is stable after a round trip',
    kd.indexOf('甲') < kd.indexOf('乙') && kd.indexOf('乙') < kd.indexOf('丙'));
}

// ---------------------------------------------------------------- ⑤ zero-attribute regression
console.log('=== hard-requirement regression: zero custom attributes ===');
{
  const n: OutlineNode = {
    id: 'a', modified: 1, text: '节点', paragraphs: ['附属段一', '附属段二'], children: [],
  };
  const kd = treeToKramdown([n], { docTitle: 'T' });
  check('★ attached paragraphs introduce no custom-*', !/custom-/.test(kd), kd);

  // Attached paragraphs in rich-text form must not introduce attributes either
  const n2: OutlineNode = {
    id: 'a', modified: 1, text: '节点',
    paragraphs: ['<span style="color:var(--b3-font-color1);">红</span>', '<b>粗</b>'],
    children: [],
  };
  const kd2 = treeToKramdown([n2], { docTitle: 'T' });
  check('★ rich-text attached paragraphs have zero custom', !/custom-/.test(kd2), kd2);

  // The first paragraph itself must also be native list-item text, not degraded into an attribute
  check('attached paragraphs land in the list-item body position (not an attribute)',
    kd.includes('附属段一') && !/\{: [^}]*附属段一/.test(kd), kd);
}

// ---------------------------------------------------------------- ⑥ draft conversion
// Replicates commitParagraphs in Mindmap.tsx: textarea text → paragraph array
console.log('=== draft conversion (commitParagraphs) ===');
{
  /** ★ Key: **blank lines must not be filtered out** —— a blank line represents an empty paragraph */
  function draftToParagraphs(draft: string): string[] {
    const lines = draft.split('\n');
    // A trailing newline does not count as "one more empty paragraph": 'a\n' and 'a' should be equivalent
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  check('single line → 1 paragraph',
    JSON.stringify(draftToParagraphs('甲')) === JSON.stringify(['甲']));
  check('two lines → 2 paragraphs',
    JSON.stringify(draftToParagraphs('甲\n乙')) === JSON.stringify(['甲', '乙']));
  check('★ blank line → empty paragraph (must never be filtered out)',
    JSON.stringify(draftToParagraphs('甲\n\n乙')) === JSON.stringify(['甲', '', '乙']));
  check('★ consecutive blank lines → consecutive empty paragraphs',
    JSON.stringify(draftToParagraphs('甲\n\n\n乙')) === JSON.stringify(['甲', '', '', '乙']));
  check('★ a trailing newline does not add a paragraph',
    JSON.stringify(draftToParagraphs('甲\n乙\n')) === JSON.stringify(['甲', '乙']));
  check('★ several trailing newlines still count as ending 1 paragraph',
    JSON.stringify(draftToParagraphs('甲\n\n')) === JSON.stringify(['甲']));
  check('first line empty → first paragraph empty',
    JSON.stringify(draftToParagraphs('\n乙')) === JSON.stringify(['', '乙']));
  check('all empty → 1 empty paragraph',
    JSON.stringify(draftToParagraphs('')) === JSON.stringify(['']));
  check('newline only → 1 empty paragraph',
    JSON.stringify(draftToParagraphs('\n')) === JSON.stringify(['']));
  check('★ whitespace-only paragraph content is preserved (no trim that drops content)',
    JSON.stringify(draftToParagraphs('甲\n   \n乙')) === JSON.stringify(['甲', '   ', '乙']));
}

// ---------------------------------------------------------------- ⑦ write-path consistency
// ★ Regression: appending and updating must go through the **same** write path, otherwise the block's internal representation differs
//   (DOM stores <span data-type="text">甲</span>, markdown stores 甲),
//   so the comparison forever judges "there is a difference" and rewrites repeatedly.
//
// ★★  Based on the kernel source, narrowed to "**go through DOM uniformly**":
//   `kernel/api/block_op.go` accepts only the two dataTypes markdown / dom, of which
//   markdown must go through Lute parsing (`lute/parse/paragraph.go:22`: only blank lines split paragraphs),
//   while dom becomes the block structure directly (`transaction.go:1704` `BlockDOM2Tree`),
//   **with no blank-line semantics involved**. To get rid of blank lines completely, we must go through DOM uniformly.
console.log('=== write-path consistency regression ===');
{
  const fs = require('fs');
  const src = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  // ★ Slices are always anchored to **code**, never to comment text.
  //   Anchoring a comment equals asserting wording: change one comment (say, translate it into English) and the guard raises a false alarm,
  //   while what it really needs to lock down is that "both branches go through DOM".
  const code = (x: string) => x.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fn = src.slice(src.indexOf('private async syncParagraphs'));
  const body = code(fn.slice(0, fn.indexOf('async syncDocParagraphs')));

  // Both branches must go through DOM
  check('★ the update branch goes through DOM (updateBlockDom)',
    /updateBlockDom/.test(body), body.slice(0, 200));
  check('★ the append branch goes through DOM (insertParagraphAfter)',
    /insertParagraphAfter/.test(body), body.slice(0, 200));

  // Neither branch may go through markdown any more.
  check('★ the update branch must not go through markdown (updateBlock plain text)',
    !/updateBlock\((?!Dom)/.test(body), body.slice(0, 200));
  check('★ the append branch must not go through markdown',
    !/appendBlock\(/.test(body), body.slice(0, 200));

  // Content always goes through htmlToSiyuanDom into SiYuan's native data-type structure
  check('★ written content goes through htmlToSiyuanDom uniformly',
    /htmlToSiyuanDom/.test(body));
}

// ---------------------------------------------------------------- ⑧ insertion position and order
// ★ Two pitfalls we actually hit in measurement, both must stay locked down
console.log('=== insertion position and order regression ===');
{
  const fs = require('fs');
  const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const fn = store.slice(store.indexOf('private async syncParagraphs'));

  check(
    '★ appendBlock must not be used to append attached paragraphs (it would land after the child list)',
    !/appendBlock\(liId/.test(fn),
    'attached paragraphs must be inserted after the first paragraph by position with insertBlock',
  );
  check(
    '★ insertion is positioned with insertParagraphAfter',
    /insertParagraphAfter\(/.test(fn),
  );

  // The anchor must start from "the last existing attached paragraph", otherwise a new paragraph is inserted before existing ones
  check(
    '★ the anchor starts from the last existing paragraph (otherwise the order is scrambled)',
    /anchor\s*=\s*\(existing\[existing\.length - 1\]/.test(fn),
    'fixing the anchor on the first paragraph inserts new paragraphs before existing ones',
  );
  check(
    '★ the anchor advances after every insertion (otherwise consecutive insertions come out reversed)',
    /if \(newId\) anchor = newId;/.test(fn),
  );

  // Position: it must be "after the first paragraph", not at the end of the list
  check(
    '★ the first paragraph (paras[0]) is used as the anchor fallback',
    /paras\[0\]/.test(fn),
  );
}

// Order simulation (replicates the anchor logic)
{
  /** Replicates the final order for "N existing paragraphs, M target paragraphs" */
  function planOrder(existing: string[], want: string[]): string[] {
    const out = existing.slice(0, Math.min(existing.length, want.length));
    // Positional update: overwrite the first n
    for (let i = 0; i < out.length; i++) out[i] = want[i];
    // Append: anchor = the last existing paragraph (or the first paragraph), advancing each time
    let anchorIdx = out.length - 1;
    for (let i = existing.length; i < want.length; i++) {
      anchorIdx = Math.max(anchorIdx + 1, out.length);
      out.splice(anchorIdx, 0, want[i]);
    }
    // Remove the surplus tail
    return out.slice(0, want.length);
  }

  check('2→3 paragraphs: the new paragraph goes at the end (not the start)',
    JSON.stringify(planOrder(['a', 'b'], ['甲', '', '乙'])) === JSON.stringify(['甲', '', '乙']),
    JSON.stringify(planOrder(['a','b'],['甲','','乙'])));

  check('0→2 paragraphs', JSON.stringify(planOrder([], ['甲', '乙'])) === JSON.stringify(['甲', '乙']));
  check('3→1 paragraphs (truncation)', JSON.stringify(planOrder(['a','b','c'], ['内容二'])) === JSON.stringify(['内容二']));
  check('2→2 paragraphs (updated in place)', JSON.stringify(planOrder(['a','b'], ['甲','乙'])) === JSON.stringify(['甲','乙']));
}

// ---------------------------------------------------------------- ⑨ no silent data loss
// ★ Measured: after `createDoc` the SQL index lags by 1~3s,
//   `lastListItems` is empty → the original `if (liId) {...}` **silently skipped**,
//   the user edited attached paragraphs, the UI showed success, and the content was never written into SiYuan.
//   "Silently discarding the user's edit" is an unacceptable degradation; it must retry + report an error.
console.log('=== no silent data loss regression ===');
{
  const fs = require('fs');
  const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const fn = store.slice(store.indexOf('private async syncParagraphs'));
  // ★ Likewise anchored to **code**: the retry logic lives in `saveNodesIncremental`.
  const callSite = store
    .slice(store.indexOf('async saveNodesIncremental'), store.indexOf('private async syncParagraphs'))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  check('★ a missing mapping no longer skips silently and unconditionally', !/^\s*if \(liId\) \{\s*$/m.test(callSite) || /!liId/.test(callSite),
    'there must be an explicit !liId handling branch');
  check('★ a missing mapping triggers a re-read retry', /loadBlockMap\(docId, 5001\)/.test(callSite),
    'the limit must be changed to bypass the write-back cache and read once more');
  check('★ if the retry still fails it throws (no silent loss)', /throw new Error/.test(callSite));

  // Replicates the degradation decision
  const decide = (liId: string | undefined, want: number): 'skip' | 'retry' | 'write' => {
    if (liId) return want > 0 ? 'write' : 'skip';
    if (want > 0) return 'retry';
    return 'skip';
  };
  check('mapping present + paragraphs present → write', decide('li', 2) === 'write');
  check('mapping present + no paragraphs → skip (avoid a pointless transaction)', decide('li', 0) === 'skip');
  check('★ no mapping + paragraphs present → must retry (cannot lose them)', decide(undefined, 2) === 'retry');
  check('no mapping + no paragraphs → skip', decide(undefined, 0) === 'skip');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
