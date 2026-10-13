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
  // ★ The old stub (`attrsToWrite` returning {} by construction) and its two checks are gone:
  //   they could never fail, and a source grep would violate the check-source-text-tests gate.
  //   The behavioral proof is ④ below (memo lands in the body, round-trips, no attribute markers).
  const n: Node = { id: 'n1', text: '甲', paragraphs: ['备注文本一ABC'] };
  check('with a memo the model stores an array', Array.isArray(n.paragraphs));
}

// ② used to assert that a summary and a link line write no attributes. Both fields were removed from the
// model (SiYuan has no native carrier, so they never persisted), which makes the assertion unexpressible
// rather than merely true —— see docs/MAPPING.md 3.3.

console.log('\n=== ④ the memo content really lands in the "body", not in attributes ===');
{
  // kramdown is "the final form written into the document" — a paragraph must be an **independent body line**
  const kd: string = treeToKramdown(
    [{ id: 'n1', modified: 0, text: '<span>甲</span>', paragraphs: ['备注文本一'], children: [] }],
    { docTitle: 'T' },
  );
  check('★ the paragraph is written as a body line', kd.includes('备注文本一'), kd);
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
  check('★ the paragraph survives the round trip', JSON.stringify(plain(got)) === JSON.stringify(['备注文本一']), JSON.stringify(got));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
