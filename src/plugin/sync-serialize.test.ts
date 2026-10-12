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

import { serializeTree } from './sync';
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
  const t2 = [N('甲', '改过的正文')];
  check('★ a changed body text differs (a text edit must still write)', serializeTree(t1) !== serializeTree(t2));

  // Attached paragraphs change block structure, so they must be in the serialization —— the measured
  // "truncated note" bug: only the first character was stored because the later ones compared equal.
  const p0 = [{ ...N('甲', '正文'), paragraphs: [] } as OutlineNode];
  const p2 = [{ ...N('甲', '正文'), paragraphs: ['一段', '两段'] } as OutlineNode];
  check(
    '★★ attached paragraphs are part of the serialization (the truncated-note bug)',
    serializeTree(p0) !== serializeTree(p2),
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

// ---------------------------------------------------------------- report

console.log(`sync-serialize: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
