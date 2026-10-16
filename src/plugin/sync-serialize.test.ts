// ★★★ The reported `Tab` bug, caught **without a browser and without SiYuan**.
//
// ## What this replaces
//
// "Shift+Tab then Tab, pressed back to back, does not reach SiYuan" was reported three times ("does not
// sync" → "works probabilistically" → "the second key does nothing"). Its root cause was in
// `serializeTree` —— the evidence behind the write-coalescing decision:
//
//     if (serializeTree(nodesRef.current) !== lastWrittenTreeRef.current) {
//       await writeLatestRef.current();   // one catch-up write-back
//     }
//
// The serialization emitted a flat `id:text` list with **no nesting and no child order**, so a re-parented
// tree compared **equal** to the flat one, the catch-up write was skipped, and the outline showed an indent
// SiYuan never received.
//
// Until now the only layer that could exercise this was `e2e/struct-sync.spec.ts` —— a Chromium run against a
// **live SiYuan**, ~16 minutes for the whole suite. It is a good case and it stays (it proves the whole path,
// keyboard included). This file proves the *decision rule* in milliseconds, which is what makes the rule hard
// to break by accident: a pure function, importable, no kernel, no DOM.
//
// ★ The two are not redundant. The E2E case answers "does the keyboard reach the document"; this answers "can
//   this function tell a re-parented tree from a flat one". The second is the precondition of the first, and it
//   is the one that was wrong for a long time.

import { serializeTree, structureFingerprint } from './sync';
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

// ---------------------------------------------------------------- the reported bug, as a comparison

{
  // The exact pair from the measurement. `甲 | 乙 | 丙` is the flat document; `甲(乙) | 丙` is what the
  // outline shows after `Tab` indents 乙. These MUST differ, or the catch-up write is skipped.
  const flat = [N('甲'), N('乙'), N('丙')];
  const indented = [N('甲', '甲', [N('乙')]), N('丙')];

  check(
    '★★★ a re-parented tree serializes DIFFERENTLY from the flat one (the reported Tab bug)',
    serializeTree(flat) !== serializeTree(indented),
    'they are byte-identical, so "did the tree change?" answers no and the indent never reaches SiYuan —— ' +
      'this is the defect verbatim',
  );
}

{
  // The other direction of the same gesture: `Shift+Tab` outdents 乙 back out of 甲.
  const indented = [N('甲', '甲', [N('乙')]), N('丙')];
  const flatAgain = [N('甲'), N('乙'), N('丙')];
  check(
    '★★★ out-denting also changes the serialization (the Shift+Tab half)',
    serializeTree(indented) !== serializeTree(flatAgain),
  );
}

// ---------------------------------------------------------------- order, which a flat list also loses

{
  const ab = [N('a'), N('b')];
  const ba = [N('b'), N('a')];
  check('★★ sibling order is part of the serialization', serializeTree(ab) !== serializeTree(ba));

  const abc = [N('a', 'a', [N('b'), N('c')])];
  const acb = [N('a', 'a', [N('c'), N('b')])];
  check('★★ child order inside a parent is part of it', serializeTree(abc) !== serializeTree(acb));
}

// ---------------------------------------------------------------- depth, which a flat list cannot express

{
  const one = [N('a', 'a', [N('b')])];
  const two = [N('a', 'a', [N('b', 'b', [N('c')])])];
  check('★★ a deeper nesting differs from a shallower one', serializeTree(one) !== serializeTree(two));

  // The pathological case the flat version could not see at all: same nodes, same order, different depth.
  const shallow = [N('a', 'a', [N('b'), N('c')])];
  const deep = [N('a', 'a', [N('b', 'b', [N('c')])])];
  check(
    '★★★ the SAME nodes in the SAME order at a different depth must differ (a flat list cannot)',
    serializeTree(shallow) !== serializeTree(deep),
  );
}

// ---------------------------------------------------------------- and it must still coalesce

{
  // ★ The fix must not make every tree look changed, or the coalescing win disappears: two structurally
  //   identical trees written independently must compare equal, or every keystroke triggers a full write.
  const a = [N('甲', '正文', [N('乙')])];
  const b = [N('甲', '正文', [N('乙')])];
  check('★★ two independently built but identical trees compare EQUAL (the coalescing win survives)', serializeTree(a) === serializeTree(b));

  // The same ids in the same shape, but a different body text —— that IS a change, and the write must happen.
  const t1 = [N('甲', '正文')];
  const t2 = [N('甲', '文本')];
  check('★ a changed body text differs (a text edit must still write)', serializeTree(t1) !== serializeTree(t2));

  // Attached paragraphs change block structure, so they must be in the serialization —— the measured
  // "truncated note" bug: only the first character was stored because the later ones compared equal.
  const p0 = [{ ...N('甲', '正文'), paragraphs: [] } as OutlineNode];
  const p2 = [{ ...N('甲', '正文'), paragraphs: ['正文', '文字'] } as OutlineNode];
  check(
    '★★ attached paragraphs are part of the serialization (the truncated-note bug)',
    serializeTree(p0) !== serializeTree(p2),
  );

  // taskStatus toggle changes block structure / marker, so it must be part of the serialization
  const k0 = [{ ...N('甲', '正文'), taskStatus: 0 } as OutlineNode];
  const k1 = [{ ...N('甲', '正文'), taskStatus: 1 } as OutlineNode];
  const k2 = [{ ...N('甲', '正文'), taskStatus: 2 } as OutlineNode];
  check(
    '★★ taskStatus is part of the serialization (todo toggle must trigger catch-up write)',
    serializeTree(k0) !== serializeTree(k1) && serializeTree(k1) !== serializeTree(k2),
  );

  // numbering toggles the list marker (`-` vs `1.`), which is a different block subtype in SiYuan
  // (`l/u` vs `l/o`, measured), so it must be part of the serialization too —— otherwise a pure
  // "number this node" edit compares equal and the catch-up write is skipped, the same silent-drop
  // shape as the taskStatus bug above.
  const u0 = [N('甲', '正文')];
  const u1 = [{ ...N('甲', '正文'), numbered: true } as OutlineNode];
  check(
    '★★ numbered is part of the serialization (number toggle must trigger catch-up write)',
    serializeTree(u0) !== serializeTree(u1),
  );
}

// ---------------------------------------------------------------- the shape the fix depends on

{
  // A regression guard for the *mechanism*: the parens are what encode depth, so if somebody "simplifies"
  // them away while keeping a per-node id list, the three cases above go red. Asserted directly so the
  // failure message names the mechanism rather than only the symptom.
  const one = serializeTree([N('a', 'a', [N('b')])]);
  check(
    '★★ the serialization carries the parens that encode nesting',
    one.includes('(') && one.includes(')'),
    JSON.stringify(one),
  );
  check(
    '★★ a leaf and a parent are distinguishable in the output',
    serializeTree([N('a')]) !== serializeTree([N('a', 'a', [N('b')])]),
  );
}

// ---------------------------------------------------------------- empty and degenerate inputs

{
  check('an empty tree serializes to an empty string', serializeTree([]) === '');
  check('a node with no children still serializes', serializeTree([N('solo')]).length > 0);
  check(
    'a node with an empty children array equals one with no children key',
    serializeTree([N('a', 'a', [])]) === serializeTree([N('a')]),
  );
  check('text is included, so a rename is a change', serializeTree([N('a', 'x')]) !== serializeTree([N('a', 'y')]));
}

// ---------------------------------------------------------------- tables

// ★ A table's cells are **content**, and this is the function that decides whether the write
//   coalescing believes anything changed at all.
//
//   A table node has no paragraph block, so its body never reaches `htmlToSiyuanDom` and never
//   appears in `saveNodesIncremental`'s text comparison. The only thing that makes a cell edit
//   count as a change is here. Without it the sequence is the one this file exists to prevent:
//   the first keystroke starts a write-back, the later ones compare **equal** and are dropped by
//   the catch-up, and the document keeps only the first character.
const T = (cells: string[][]): OutlineNode => ({
  id: 't1',
  modified: 0,
  text: '',
  table: { header: ['h1', 'h2'], rows: cells },
  children: [],
});

check(
  'a cell edit is a change (the first appearance of the pitfall, for table cells)',
  serializeTree([T([['a', 'b']])]) !== serializeTree([T([['a', 'b2']])]),
);
check(
  'adding a row is a change',
  serializeTree([T([['a', 'b']])]) !== serializeTree([T([['a', 'b'], ['c', 'd']])]),
);
check(
  'an unchanged table is not a change',
  serializeTree([T([['a', 'b']])]) === serializeTree([T([['a', 'b']])]),
);
check(
  'a table node is not equal to a text node of the same id',
  serializeTree([T([['a', 'b']])]) !== serializeTree([{ ...T([['a', 'b']]), table: undefined }]),
);

// ★ And the table's **shape** is structure: a row or column count decides how many blocks
//   exist, so it must not be judged by the text-only path.
check(
  'the structural fingerprint tells a 2-row table from a 3-row one',
  structureFingerprint([T([['a', 'b']])]) !== structureFingerprint([T([['a', 'b'], ['c', 'd']])]),
);
check(
  'the structural fingerprint does NOT change when only a cell is edited',
  structureFingerprint([T([['a', 'b']])]) === structureFingerprint([T([['a2', 'b']])]),
  'cell content is not structure; making it so would put every keystroke back on the structural path',
);

// ---------------------------------------------------------------- code blocks

// ★ A code edit is **content** that reaches the document through `syncCodeBlocks`,
//   never through a paragraph block — exactly like a table cell. Without it here the
//   coalescing drops every keystroke after the first (the same pitfall as cells).
const C = (code: string, lang = 'js'): OutlineNode => ({
  id: 'c1',
  modified: 0,
  text: '',
  codeBlock: { lang, code },
  children: [],
});

check(
  '★ a code edit is a change (the coalescing pitfall again, for code blocks)',
  serializeTree([C('const a = 1;')]) !== serializeTree([C('const a = 2;')]),
);
check(
  '★ an unchanged code block is not a change',
  serializeTree([C('const a = 1;')]) === serializeTree([C('const a = 1;')]),
);
check(
  '★ gaining a code block is a structural change (a block of its own appears)',
  structureFingerprint([C('const a = 1;')]) !==
    structureFingerprint([{ ...C('const a = 1;'), codeBlock: undefined }]),
);
check(
  '★ editing code only is NOT a structural change (content rides the text-only path)',
  structureFingerprint([C('const a = 1;')]) === structureFingerprint([C('const a = 2;')]),
  'code content is not structure; making it so would put every keystroke back on the structural path',
);

// ---------------------------------------------------------------- report

console.log(`sync-serialize: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
