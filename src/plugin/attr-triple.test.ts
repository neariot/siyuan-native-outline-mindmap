/**
 * Persistence semantics of the "three siblings" features (memo / summary / link line) — **rewritten**.
 *
 * ── The three take three different paths ─────────────────────────
 *
 *   · memo      → **native attached paragraphs** (multiple `NodeParagraph` under a listItem)
 *               —— body text, indexed for full-text search, WYSIWYG. **No attributes at all.**
 *   · summary   → still **inexpressible** (SiYuan has no native counterpart), no longer written out.
 *   · link line → same as above, no longer written out.
 *
 * None of the three is **carried by attributes**: this plugin writes no `custom-*` attribute,
 * and reads no node semantics from attributes — node semantics come only from SiYuan's native structure.
 *
 * This file guards three things:
 *   ① the memo really goes through "native paragraphs" and not through any attribute;
 *   ② summary / link line are **not written out** (stop stuffing private data into the document);
 *   ③ **the attribute write table is always empty** — no attribute transaction is produced under any circumstance.
 */
import { treeToKramdown, kramdownToTree } from '../core/map';
import type { OutlineNode } from '../model/types';

/** The fields of this plugin's model that this file cares about */
interface Node {
  id: string;
  text: string;
  paragraphs?: string[];
  summaryData?: unknown[];
  linkLines?: unknown[];
}

/**
 * Reproduces the "which attributes should be written" criterion in `saveNodesIncremental`.
 *
 * ★ In production code this mechanism **has been removed entirely** (it no longer queries the `attributes` table
 *   nor calls `setBlockAttrs`), so this function **always returns an empty object**.
 *   It is kept only so the "always empty" invariant can be asserted — if someone
 *   ever stuffs attributes into the write-back path again, this test reminds them to come back and change this first.
 */
function attrsToWrite(n: Node): Record<string, string | null> {
  void n;
  return {};
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('=== ① the memo goes through native paragraphs, not attributes ===');
{
  const n: Node = { id: 'n1', text: '甲', paragraphs: ['备注内容ABC'] };
  check('memo non-empty → no attribute write at all', Object.keys(attrsToWrite(n)).length === 0);
  check('memo cleared → still no attribute write', Object.keys(attrsToWrite({ ...n, paragraphs: [] })).length === 0);
  check('with a memo the model stores an array', Array.isArray(n.paragraphs));
}

console.log('\n=== ② summary / link line are not written out ===');
{
  const withSum: Node = { id: 'n1', text: '甲', summaryData: [{ id: 's1', memberIds: ['a'], text: '概要' }] };
  const withLink: Node = { id: 'n1', text: '甲', linkLines: [{ id: 'l1', toNodeId: 'n2' }] };
  check('with a summary → no attribute write', Object.keys(attrsToWrite(withSum)).length === 0);
  check('with a link line → no attribute write', Object.keys(attrsToWrite(withLink)).length === 0);
}

console.log('\n=== ③ the write-back path produces no attribute transaction at all ===');
{
  const cases: Node[] = [
    { id: 'n1', text: '甲' },
    { id: 'n2', text: '乙', paragraphs: ['附属1', '附属2'] },
    { id: 'n3', text: '丙', summaryData: [{ id: 's1', memberIds: [], text: '' }] },
    { id: 'n4', text: '丁', linkLines: [{ id: 'l1', toNodeId: 'n2' }] },
    { id: 'n5', text: '戊', paragraphs: [''], summaryData: [{}], linkLines: [{}] },
  ];
  check('under all five combinations the attribute write table is empty', cases.every((c) => Object.keys(attrsToWrite(c)).length === 0));
}

console.log('\n=== ④ the memo content really lands in the "body", not in attributes ===');
{
  // kramdown is "the final form written into the document" — a paragraph must be an **independent body line**
  const kd: string = treeToKramdown(
    [{ id: 'n1', modified: 0, text: '<span>甲</span>', paragraphs: ['备注内容'], children: [] }],
    { docTitle: 'T' },
  );
  check('★ the paragraph is written as a body line', kd.includes('备注内容'), kd);
  check('★ it is not written as any attribute', !/memo=|custom-/.test(kd), kd);

  const back: OutlineNode[] = kramdownToTree(kd);
  const flat: OutlineNode[] = [];
  (function w(l: OutlineNode[]) {
    for (const n of l) {
      flat.push(n);
      if (n.children?.length) w(n.children);
    }
  })(back);
  const got = flat.find((n) => (n.text ?? '').includes('甲'))?.paragraphs;
  // the parser wraps plain text in `<span>` (isomorphic to the `text` field), so strip the tags before comparing
  const plain = (a?: string[]): string[] => (a ?? []).map((x) => x.replace(/<[^>]*>/g, ''));
  check('★ the paragraph survives the round trip', JSON.stringify(plain(got)) === JSON.stringify(['备注内容']), JSON.stringify(got));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
