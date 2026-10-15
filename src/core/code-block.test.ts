// ★★★ A code block is its own block, and it must reach the document unchanged.
//
// ## The defect this covers (D21)
//
// A document holding
//
//     ```js
//     const a = 1;
//     ```
//
// was read as **no node at all**. Every line fell through to the generic reader branch, where a
// flush-left line becomes an attached paragraph of the nearest node: the fence became
// `` <code></code>`js `` (the *inline*-code rule biting a fence), the source became a plain
// paragraph, and the whole block was folded into the **document title's** paragraphs. The block
// showed nowhere in the outline, and because it was not a node it could not be deleted — reported
// as "a code block can't be deleted at all".
//
// A SiYuan code block is its own block (`data-type="NodeCodeBlock"`, a root-level child of the
// document, no listItem), so it cannot be a node's text. It is a node of its own, exactly like a
// table (`docs/todo/inline-markup-sync.md` §D9).
//
// Runs offline: python3 scripts/run-tests.py code-block

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeBlockToKramdown, kramdownToTree } from './map';

/** A kramdown document holding exactly one fenced block, with its attribute line. */
const doc = (fence: string): string =>
  `${fence}\n{: id="20260101120000-cbfence" updated="1"}\n\n- {: id="20260101120000-nodeaaa" updated="1"}甲\n`;

test('a fenced block is read as its own node, not folded into a title paragraph', () => {
  const tree = kramdownToTree(doc('```js\nconst a = 1;\n```'));
  // ★ The node count is the assertion that matters: the defect was that the block produced
  //   **no node at all**, so "the code is somewhere" would have passed while it stayed undeletable.
  assert.equal(tree.length, 2, 'the code block must be a node of its own');
  assert.deepEqual(tree[0].codeBlock, { lang: 'js', code: 'const a = 1;' });
  assert.equal(tree[0].text, '', 'a code block has no inline text');
  assert.equal(tree[0].id, '20260101120000-cbfence', 'the id comes from the attribute line');
  assert.equal(tree[1].id, '20260101120000-nodeaaa', 'and the list item is untouched');
});

test('the code body is never parsed as markup', () => {
  // ★★★ The lines below are all things the reader treats as markup elsewhere. Inside a fence they
  //   are code, and a single one being "recognised" corrupts the user's sample. This is why the run
  //   is claimed before every other branch.
  const body = '| a | b |\n# heading\n- list item\n{: id="not-a-real-attr"}\n![x](y)';
  const tree = kramdownToTree(doc('```\n' + body + '\n```'));
  assert.equal(tree.length, 2);
  // Everything between the fences, byte for byte. The newline before the closing fence is the
  // **separator**, not part of the body: kramdown splits the block into lines, so it is not content.
  assert.deepEqual(tree[0].codeBlock, { lang: '', code: body });
});

test('the language tag is read, and a plain fence has none', () => {
  assert.equal(kramdownToTree(doc('```python\nx = 1\n```'))[0].codeBlock?.lang, 'python');
  assert.equal(kramdownToTree(doc('```\nx = 1\n```'))[0].codeBlock?.lang, '');
});

test('the writer round-trips through the reader, unchanged', () => {
  // ★ The criterion is a **fixed point**: write, read back, and the value must be identical. A
  //   writer that escaped anything at all would fail here, and escaping is corruption for code.
  const cases = [
    { lang: 'js', code: 'const a = 1;' },
    { lang: '', code: 'plain' },
    { lang: 'python', code: 'def f():\n    return 1\n' },
    { lang: 'js', code: '' },
    // The case a naive writer corrupts: the source contains a fence of its own.
    { lang: 'md', code: '```\ninner\n```' },
  ];
  for (const c of cases) {
    const tree = kramdownToTree(doc(codeBlockToKramdown(c)));
    assert.equal(tree.length, 2, `${JSON.stringify(c)} must still be one block`);
    assert.deepEqual(
      { lang: tree[0].codeBlock?.lang, code: (tree[0].codeBlock?.code ?? '').replace(/\n$/, '') },
      { lang: c.lang, code: c.code.replace(/\n$/, '') },
      `round trip changed ${JSON.stringify(c)}`,
    );
  }
});

test('a fence containing a longer backtick run is not closed early', () => {
  // ★ Measured: the writer emits a **four**-backtick fence for source containing ` ``` `, and a
  //   reader that closed on *any* three cut the block off at the first inner fence and lost the
  //   rest. The rule is CommonMark's: the closing fence must be at least as long as the opening one.
  const written = codeBlockToKramdown({ lang: 'md', code: '```\ninner\n```' });
  assert.match(written, /^````/, 'the writer must lengthen the fence past the longest run inside');
  const tree = kramdownToTree(doc(written));
  assert.equal(tree[0].codeBlock?.code.replace(/\n$/, ''), '```\ninner\n```');
});

test('an unterminated fence keeps its code instead of dropping the block', () => {
  // ★ A run that is still open at end-of-document is still a block: the kernel can hold one, and
  //   silently discarding the user's code is worse than showing it.
  const tree = kramdownToTree('```py\nprint(1)\n');
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].codeBlock, { lang: 'py', code: 'print(1)\n' });
});

test('a table and a code block in one document do not claim each other', () => {
  // ★ Both are root-level non-list blocks collected as runs before the other branches; a shared
  //   reader is exactly where one run's lines end up in the other's node.
  const md =
    '```js\nconst a = 1;\n```\n{: id="20260101120000-cbfence" updated="1"}\n\n' +
    '| h1 | h2 |\n| --- | --- |\n| a | b |\n{: id="20260101120000-tblaaaa" colgroup="|" updated="1"}\n\n' +
    '- {: id="20260101120000-nodeaaa" updated="1"}甲\n';
  const tree = kramdownToTree(md);
  assert.equal(tree.length, 3, 'one code block, one table, one node');
  assert.deepEqual(tree[0].codeBlock, { lang: 'js', code: 'const a = 1;' });
  assert.deepEqual(tree[1].table, { header: ['h1', 'h2'], rows: [['a', 'b']] });
  assert.equal(tree[2].text, '<span>甲</span>');
});
