// ★★★ The structure fingerprint, driven directly —— no browser, no kernel.
//
// ## What it guards, and which way it fails
//
// `structureFingerprint` decides whether the **expensive** three-step structure reconciliation runs at all
// (`syncStructure` → `syncDeletions` → `saveNodesIncremental`). It was added because typing changes text only,
// and the full reconciliation was running for nothing: measured on a 240-node document, typing one character
// cost **189 API calls, 180 of them the same `SELECT id FROM blocks WHERE parent_id=? AND type='l'`**, and the
// write took ≈3 s where a 4-node document needed 11 calls / 291 ms.
//
// ★ The two directions of a mistake are **not** symmetric, and that is the whole reason this file exists:
//
//   * including too little —— a text edit counts as a structure change: the optimisation is void, nothing
//     breaks, the cost comes back. Annoying, visible, safe.
//   * including too much —— omitting a field that really is structure: a **real structure change is skipped**.
//     Nothing raises. The outline shows the change and SiYuan never receives it. That is the reported class of
//     bug, and it is why every structure field is listed in the function and pinned here.
//
// The criterion is therefore *asymmetric on purpose*: `text` **must not** count (or the optimisation is void),
// and every structural field **must** count (or a change is silently dropped).

import { structureFingerprint } from './sync';
import type { OutlineNode } from '../model/types';

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

const N = (id: string, text = id, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 0, text, children }) as OutlineNode;

const withParas = (n: OutlineNode, paragraphs: string[]): OutlineNode => ({ ...n, paragraphs }) as OutlineNode;

// ---------------------------------------------------------------- text must NOT count (the optimisation)

{
  // ★ The entire reason the function exists. If a text edit changed the fingerprint, every keystroke would run
  //   the full reconciliation again and the measured 189-call cost would come straight back.
  const before = [N('甲', '原文')];
  const after = [N('甲', '文本')];
  check(
    '★★★ a text edit does NOT change the fingerprint (or the typing-lag optimisation is void)',
    structureFingerprint(before) === structureFingerprint(after),
    'a text-only change produced a different fingerprint, so every keystroke pays the full structure ' +
      'reconciliation —— measured at 189 API calls / ≈3 s on a 240-node document',
  );

  // And the same for text nested deeper, which a top-level-only rule would miss.
  const deepBefore = [N('a', 'a', [N('b', '旧')])];
  const deepAfter = [N('a', 'a', [N('b', '文字')])];
  check('★★ a nested text edit does not change it either', structureFingerprint(deepBefore) === structureFingerprint(deepAfter));
}

// ---------------------------------------------------------------- structure MUST count (the dangerous way)

{
  // Node added / removed.
  check('★ adding a node changes the fingerprint', structureFingerprint([N('a')]) !== structureFingerprint([N('a'), N('b')]));
  check('★ removing a node changes it', structureFingerprint([N('a'), N('b')]) !== structureFingerprint([N('a')]));

  // Re-parenting —— the reported `Tab` bug's shape.
  const flat = [N('甲'), N('乙')];
  const nested = [N('甲', '甲', [N('乙')])];
  check(
    '★★★ re-parenting changes the fingerprint (a structure change must never be skipped)',
    structureFingerprint(flat) !== structureFingerprint(nested),
  );

  // Child order.
  check(
    '★★ child order changes it (a reorder is structure)',
    structureFingerprint([N('a', 'a', [N('b'), N('c')])]) !== structureFingerprint([N('a', 'a', [N('c'), N('b')])]),
  );

  // Sibling order.
  check('★★ sibling order changes it', structureFingerprint([N('a'), N('b')]) !== structureFingerprint([N('b'), N('a')]));

  // Depth.
  check(
    '★★ depth changes it',
    structureFingerprint([N('a', 'a', [N('b'), N('c')])]) !== structureFingerprint([N('a', 'a', [N('b', 'b', [N('c')])])]),
  );

  // Attached paragraphs each become their own block, so their COUNT is structure.
  check(
    '★★★ attaching a paragraph changes it (each one is its own block)',
    structureFingerprint([N('a', 'a')]) !== structureFingerprint([withParas(N('a', 'a'), ['一段'])]),
  );
  check(
    '★★ attaching a SECOND paragraph changes it (the count is part of the fingerprint)',
    structureFingerprint([withParas(N('a', 'a'), ['一段'])]) !==
      structureFingerprint([withParas(N('a', 'a'), ['正文', '文字'])]),
  );
  check(
    '★★★ the paragraph TEXT does not count —— only how many there are (the count is what makes blocks)',
    structureFingerprint([withParas(N('a', 'a'), ['正文'])]) ===
      structureFingerprint([withParas(N('a', 'a'), ['文字'])]),
    'the paragraph text leaked into a structure fingerprint, so editing a note would pay the full ' +
      'reconciliation —— while the risk it guards is a skipped structure change, not a wasted write',
  );
}

// ---------------------------------------------------------------- and it still coalesces

{
  const a = [N('甲', '正文', [N('乙')])];
  const b = [N('甲', '正文', [N('乙')])];
  check('★★ two independently built but identical trees compare EQUAL', structureFingerprint(a) === structureFingerprint(b));

  check('an empty tree gives an empty fingerprint', structureFingerprint([]) === '');
  check(
    'no children equals an empty children array',
    structureFingerprint([N('a', 'a', [])]) === structureFingerprint([N('a')]),
  );
}

// ---------------------------------------------------------------- report

console.log(`sync-fingerprint: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
