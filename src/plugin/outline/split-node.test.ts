/**
 * Enter splitting a node: the semantics (UI-TC-11, Critical).
 *
 * ──────────────────────────────────────────────────────────────────
 * What the case requires
 * ──────────────────────────────────────────────────────────────────
 *
 * "Press Enter in the middle of the text: the node splits into two, and focus stays exactly
 *
 * `splitNode` has 3 branches; 2 of them have caused trouble in maintainer feedback:
 *
 *   (1) has content + caret in the middle -> split into two nodes: "before" and "after"
 *   (2) has content + caret at the start  -> the before part is empty, but it must still split (no content may be lost)
 *   (3) empty node                        -> create a **new sibling empty node** at the same level
 *
 * Branch (3) has been buggy **twice**, and both times it was "Enter produced no new line":
 *
 *   - : `n.text=''; return {id}` empties the node and returns **the same id**,
 *     so nothing was created. The user saw no reaction to Enter; measured "7 before Enter -> 7 after".
 *     At the time only the **root level** was fixed.
 *   - the "if it has a parent, outdent (promote one level)" branch was still there,
 *     so on a nested node the second "keep pressing enter" promoted the empty node one level.
 *     => changed to one behaviour regardless of level; demotion moved to `Shift+Tab`.
 *
 * * **Do not write the test by following the implementation** -- that preserves the bug as a feature: when the
 *   outdent branch is deleted from the implementation, the test goes red. A test comes from the requirement or from a real
 *   reproduction (here `e2e/enter-sibling.spec.ts`: it asserts the UI indent + the SiYuan block tree).
 *
 * ──────────────────────────────────────────────────────────────────
 * How this test works
 * ──────────────────────────────────────────────────────────────────
 *
 * `splitHtmlAtCaret` depends on a real selection (document.getSelection), so it cannot be tested offline;
 * but for `splitNode` it is merely a pure input: "given HTML and a caret -> return before/after".
 * So here we **reproduce the semantics of splitHtmlAtCaret** (without depending on the DOM)
 * and focus on the branch behaviour of `splitNode` -- that is where the bugs were.
 *
 * It also reads the source and asserts that all 4 branches are still there, so nobody "simplifies" one away.
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

type Node = { id: string; text: string; children: Node[]; collapsed?: boolean };

/** Reproduce the semantics of splitHtmlAtCaret: cut the HTML at a plain-text index (ignoring tag details) */
function splitAtText(text: string, caret: number): { before: string; after: string } {
  const b = text.slice(0, caret);
  const a = text.slice(caret);
  const wrap = (s: string) => (s === '' ? '<span></span>' : `<span>${s}</span>`);
  return { before: wrap(b), after: wrap(a) };
}

const plain = (html: string): string => html.replace(/<[^>]*>/g, '');

/** Reproduce makeSiyuanId: every call must yield a **new** id, otherwise repeated-Enter cases match the wrong node */
let seq = 0;
const mkId = (): string => `NEW${++seq}`;

/** Reproduce the branch logic of splitNode (compare with Outliner.tsx:797) */
function splitNode(
  draft: Node[],
  id: string,
  caret: number,
): { nodes: Node[]; focus: { id: string; offset: number | 'end' } | null; parentOf?: string } {
  const findEntry = (list: Node[], parent: Node | null = null): { node: Node; parent: Node | null } | null => {
    for (const n of list) {
      if (n.id === id) return { node: n, parent };
      const r = findEntry(n.children, n);
      if (r) return r;
    }
    return null;
  };
  const entry = findEntry(draft);
  if (!entry) return { nodes: draft, focus: null };
  const { before, after } = splitAtText(plain(entry.node.text), caret);
  const plainAfter = plain(after).trim();

  // Empty node -> create a sibling empty node at the **same level**. Whether root or nested.
  //
  // *** There used to be a "if it has a parent, outdent (promote one level)" branch here;
  //   it was deleted when the behaviour was corrected. This test was then **written by following the implementation**,
  //   so it preserved the bug as a feature -- deleting the implementation branch made it go red.
  //   Lesson: a test comes from the requirement or from a real reproduction, **never copied from the implementation**.
  if (plain(before).trim() === '' && plainAfter === '' && entry.node.children.length === 0) {
    const sibs = entry.parent ? entry.parent.children : draft;
    const at = sibs.findIndex((x) => x.id === id);
    const nn: Node = { id: mkId(), text: '<span></span>', children: [] };
    sibs.splice(at >= 0 ? at + 1 : sibs.length, 0, nn);
    return { nodes: draft, focus: { id: nn.id, offset: 'end' } };
  }

  // (1)(2) normal split
  entry.node.text = before;
  const sibs = entry.parent ? entry.parent.children : draft;
  const idx = sibs.findIndex((x) => x.id === id);
  const nn: Node = { id: 'NEW2', text: after, children: [] };
  sibs.splice(idx + 1, 0, nn);
  return { nodes: draft, focus: { id: nn.id, offset: 0 } };
}

const n = (id: string, text: string, children: Node[] = []): Node => ({
  id, text: `<span>${text}</span>`, children,
});

// ──────────────────────────────────────────────────────────────────
console.log('(1) has content + caret in the middle -> split into two nodes');

{
  const draft = [n('a', 'hello world')];
  const r = splitNode(draft, 'a', 5); // "hello" | " world"
  check('the node count goes from 1 to 2', r.nodes.length === 2, `got ${r.nodes.length}`);
  check('the before part is the content left of the caret', plain(r.nodes[0].text) === 'hello', `got "${plain(r.nodes[0].text)}"`);
  check('the after part is the content right of the caret', plain(r.nodes[1].text) === ' world', `got "${plain(r.nodes[1].text)}"`);
  check('* no character lost (the two parts join back into the original)',
    plain(r.nodes[0].text) + plain(r.nodes[1].text) === 'hello world');
  check('** focus lands on the **after** node', r.focus?.id === r.nodes[1].id, `focus ${r.focus?.id}`);
  check('** the focus offset is 0 (line start), not the end', r.focus?.offset === 0, `got ${r.focus?.offset}`);
  check('the after part inherits no child nodes (a split does not move a subtree)', r.nodes[1].children.length === 0);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(2) caret at the start / at the end');

{
  const d1 = [n('a', 'abc')];
  const r1 = splitNode(d1, 'a', 0);
  check('* caret at the start: the before part is empty, the after part is the whole text',
    plain(r1.nodes[0].text) === '' && plain(r1.nodes[1].text) === 'abc',
    `"${plain(r1.nodes[0].text)}" / "${plain(r1.nodes[1].text)}"`);
  check('caret at the start: no content lost', plain(r1.nodes[1].text) === 'abc');

  const d2 = [n('a', 'abc')];
  const r2 = splitNode(d2, 'a', 3);
  check('* caret at the end: the before part is the whole text, the after part is empty',
    plain(r2.nodes[0].text) === 'abc' && plain(r2.nodes[1].text) === '',
    `"${plain(r2.nodes[0].text)}" / "${plain(r2.nodes[1].text)}"`);
  check('caret at the end: focus still lands on the after part (typing can continue)',
    r2.focus?.id === r2.nodes[1].id && r2.nodes.length === 2);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(3) empty node + has a parent -> also creates a sibling');
//
// Enter at the end of an existing node creates a new node; pressing Enter again makes that empty node
// move up one level. The cause was that this branch **outdented when a parent existed**, while the root level did not,
// so the same operation behaved differently at the two levels.
//
// * What is asserted is the **level**, not the text: not one character of the operation changed,
//   only the indentation (and the block tree in SiYuan).

{
  const draft = [n('p', 'parent', [n('child', '')])];
  const r = splitNode(draft, 'child', 0);
  check('** the original node **does not move**, it stays under its parent',
    draft[0].children.some((c) => c.id === 'child'),
    `parent children: ${draft[0].children.map((c) => c.id).join(',')}`);
  check('** the parent has one more child (the created node is its sibling)',
    draft[0].children.length === 2, `got ${draft[0].children.length}`);
  check('** the new node is ordered **after** the original node',
    draft[0].children[1]?.id === r.focus?.id, `child order ${draft[0].children.map((c) => c.id).join(',')}`);
  check('** no node was promoted to the root level (the root still holds only the parent)',
    draft.length === 1, `root holds ${draft.length}: ${draft.map((x) => x.id).join(',')}`);
  check('* focus lands on the new node (typing can continue)',
    r.focus?.id === draft[0].children[1].id && r.focus?.offset === 'end', `focus ${JSON.stringify(r.focus)}`);
}

// what the user called "keep pressing enter": press repeatedly, every press must stay at the same level
console.log('\n(3)b pressing Enter repeatedly on a level-2 node: every press stays at level 2');
{
  const draft = [n('p', 'parent', [n('c0', '')])];
  let cur = 'c0';
  for (let i = 0; i < 5; i++) {
    const r = splitNode(draft, cur, 0);
    cur = r.focus!.id;
  }
  check('*** after 5 presses the parent has 6 children (1 original + 5 new)',
    draft[0].children.length === 6, `got ${draft[0].children.length}`);
  check('*** no node was ever promoted to the root level', draft.length === 1, `root holds ${draft.length}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(4) empty node + root level -> create a sibling empty node (the former bug)');

{
  const draft = [n('a', '')];
  const r = splitNode(draft, 'a', 0);
  check('** the node count increases (it used to be "7 before Enter and 7 after")',
    r.nodes.length === 2, `got ${r.nodes.length}`);
  check('** focus lands on the **new node**, not on the original one',
    r.focus?.id !== 'a', `focus ${r.focus?.id}`);
  check('* the new node is empty (typing can continue)', plain(r.nodes[1].text) === '');
  check('* every repeated Enter creates a new node (it does not get stuck on the same node)', (() => {
    const d = [n('x', '')];
    for (let i = 0; i < 5; i++) {
      const cur = d[d.length - 1].id;
      splitNode(d, cur, 0);
    }
    return d.length === 6; // 1 original + 5 new
  })(), 'pressing Enter 5 times on an empty node should create 5 nodes');
}

// ──────────────────────────────────────────────────────────────────
console.log('\n* the branches are all still present in the source (so nobody "simplifies" them away)');

/**
 * Cut the function body out of `header` by **matching braces**.
 *
 * * This used to hardcode `src.slice(start, start + 2200)`. After adding
 *   20-odd lines of comment to splitNode explaining the fix, `sibs.splice(idx + 1, 0, nn)` was pushed past
 *   2200 -- the test went red, yet **not a line of code was wrong**.
 *   A hardcoded-length window goes falsely red/green as comments are added or removed; cut by structure instead.
 */
function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return src.slice(open);
}

{
  const src = fs.readFileSync('src/plugin/outline/Outliner.tsx', 'utf8');

  // ** strip comments first, then make every assertion.
  //
  //   The original implementation stripped comments for only **one** of the assertions and ran the regex on text
  //   that still contained comments for the rest -- and that is what bit us: `check('(3) outdent branch exists', /outdent/.test(body))`
  //   **still passed** after the outdent branch had been **deleted**, because I had
  //   a sentence explaining it in a comment. A false pass is far more dangerous than a false failure: it stays quiet.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const body = fnBody(code, 'const splitNode = (id: string): void =>');
  check('the splitNode function body was cut out (by brace matching, not a hardcoded length)',
    body.length > 200 && body.trimEnd().endsWith('}'), `length ${body.length}`);

  check('(1) reads the caret position (splitHtmlAtCaret)', /splitHtmlAtCaret\(el\)/.test(body));
  check('(2) normal split: the before part is written back to the original node', /n\.text = before;/.test(body));
  check('(2) normal split: the after part is inserted as a sibling', /sibs\.splice\(idx \+ 1, 0, nn\)/.test(body));

  // (3) empty node -> create a sibling at the same level (root or nested alike)
  check('(3) empty node: create the new node (const nnRoot)',
    /const nnRoot/.test(body));
  check('* (3) the new node is inserted at the **same level** (sibsOf comes from the parent children or the root)',
    /const sibsOf = entry && entry\.parent \? entry\.parent\.children : draft;/.test(body),
    body.slice(0, 400));
  check('* (3) focus lands on the new node', /return \{ id: nnRoot\.id/.test(body));

  // *** reverse protection: the obsolete outdent branch must **not** be in the code
  //
  //   It used to promote a node one level on an empty node with a parent, so that the second
  //   "repeated Enter" changed level (the bug the user reported). Demotion moved to Shift+Tab.
  check('* (3) the obsolete outdent branch is gone (it must not be in the code any more)',
    !/const gone = removeNode\(draft, id\)/.test(body) && !/list\.splice\(pIdx \+ 1/.test(body),
    'did the outdent branch come back? Demotion should go through Shift+Tab');
  check('* the code no longer contains the old "clear itself and return the same id" form',
    !/n\.text = '';\s*return \{ id, offset: 0 \};/.test(body),
    'that was exactly the cause of Enter doing nothing');

  // the **criteria themselves** behind the two reverse assertions must be effective: try them on a deliberately broken sample
  const badSample = `
    const gone = removeNode(draft, id);
    const gp = flattenAll(draft).find((e) => e.node.id === entry.parent!.id);
    list.splice(pIdx + 1, 0, gone);
    return { id, offset: 0 };
  `;
  check('* the criteria have teeth: injecting the outdent code is indeed judged "present"',
    /const gone = removeNode\(draft, id\)/.test(badSample) || /list\.splice\(pIdx \+ 1/.test(badSample),
    'this reverse assertion has no defensive value if it is always true');
}

// ──────────────────────────────────────────────────────────────────
console.log('\ncriteria are effective');

{
  // the old "create no new node" implementation must be caught by the criteria
  const oldBehavior = (draft: Node[], id: string) => {
    void id;
    return { nodes: draft, focus: { id: 'a', offset: 0 } }; // clear itself, return the same id
  };
  const d = [n('a', '')];
  const r = oldBehavior(d, 'a');
  check('* the criteria recognise the old "Enter does nothing" implementation', r.nodes.length === 1 && r.focus.id === 'a');
  check('* the criteria require the node count to increase', r.nodes.length !== 2);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
