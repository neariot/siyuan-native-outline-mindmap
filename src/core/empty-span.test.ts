// Empty spans must be collapsed, otherwise they turn into literal <protyle-html> leftovers in SiYuan.
//
// Defect (reported by a maintainer):
//   a `<protyle-html>` leftover showed up in "the second switch test".
//
// ── how it forms ────────────────────────────────────────────────────────
//
//   ① "empty" in a node is represented in the data structure as `<span></span>`
//      (used for an empty node in `addSiblingNode` / `splitNode` and elsewhere)
//   ② `store.ts` writes back with `htmlToSiyuanDom(html) || '\u200b'`
//      —— but **`'<span></span>'` is truthy**, so the `||` fallback never triggers at all
//   ③ so a bare empty span reaches the kernel, which escapes it into literal text
//   ④ the panel reads it back and `textContent` is literally `<protyle-html>`
//   ⑤ on write-back it **is parsed as HTML** → a real `<protyle-html>` element is created
//   ⑥ each round adds a level → `<protyle-html><protyle-html></protyle-html></protyle-html>`
//
// What the user sees is garbled text like `<protyle-html>` lying in the document instead of a blank line.
//
// Fix: `htmlToSiyuanDom` strips empty spans at the end, so that the `|| '\u200b'` in the caller actually takes effect.

import { htmlToSiyuanDom } from './map';

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

// Reproduce the store.ts write-back construct: `htmlToSiyuanDom(html) || '\u200b'`
const buildParagraphDom = (html: string): string =>
  `<div data-type="NodeParagraph">${htmlToSiyuanDom(html) || '\u200b'}</div>`;

// ---- 1. empty spans must be stripped ----
{
  const emptyVariants = [
    '<span></span>',
    '<span>\u200b</span>',
    '<span> </span>',
    '<span></span><span></span>',
  ];
  for (const v of emptyVariants) {
    const out = buildParagraphDom(v);
    check(
      `★ empty wrap ${JSON.stringify(v)} is collapsed to the zero-width placeholder`,
      !out.includes('<span></span>'),
      `got=${out}`,
    );
    // ★ Assert on the STRIPPED text, not the raw output: the old form
    //   (`out.includes('\u200b') || ...`) was satisfied by the placeholder inside the
    //   un-stripped `<span>\u200b</span>` — passing on the broken code this file exists to catch.
    const stripped = out.replace(/<[^>]*>/g, '');
    check(
      `★ and the stripped content is exactly the fallback placeholder`,
      stripped === '\u200b',
      `got=${JSON.stringify(stripped)} from ${out}`,
    );
  }
}

// ---- 2. spans with content must not be damaged ----
{
  check(
    '★ a span with text is kept as-is',
    htmlToSiyuanDom('<span>标签一</span>') === '<span>标签一</span>',
    `got=${JSON.stringify(htmlToSiyuanDom('<span>标签一</span>'))}`,
  );
  check(
    '★ a styled span gains data-type="text" and keeps its style',
    htmlToSiyuanDom('<span style="color:red">红</span>') ===
      '<span data-type="text" style="color:red">红</span>',
    `got=${JSON.stringify(htmlToSiyuanDom('<span style="color:red">红</span>'))}`,
  );
  check(
    '★ semantic tags (bold) are unaffected',
    htmlToSiyuanDom('<b>粗</b>') === '<span data-type="strong">粗</span>',
    `got=${JSON.stringify(htmlToSiyuanDom('<b>粗</b>'))}`,
  );
  // Nesting: an outer span wraps content —— the content must not be deleted along with it
  check(
    '★ an outer span wrapping content is not stripped',
    htmlToSiyuanDom('<span><b>粗</b></span>').includes('粗'),
    `got=${JSON.stringify(htmlToSiyuanDom('<span><b>粗</b></span>'))}`,
  );
}

// ---- 3. a truly empty string still uses the fallback ----
{
  check('empty string → zero-width placeholder', buildParagraphDom('') === '<div data-type="NodeParagraph">\u200b</div>');
  check('null semantics (undefined goes through ??) are unaffected', htmlToSiyuanDom('') === '');
}

// ---- 4. the caller's `|| '\u200b'` fallback can actually fire now ----
{
  // ★ This replaces a "reverse check" that hand-built a `legacy` function and asserted that **it** leaked
  //   `<span></span>` —— a strawman that never touched `htmlToSiyuanDom`, so its assertion was true by
  //   construction and could not fail however the product changed. The defect it meant to demonstrate is
  //   real, but the demonstration proved nothing; this one exercises the shipped function.
  //
  //   The defect's actual mechanism: `'<span></span>'` is **truthy**, so `htmlToSiyuanDom(h) || '\u200b'`
  //   never took the fallback and the bare span reached the kernel. The fix only works if the stripper makes
  //   the result **falsy** for a string that is nothing but an empty span. Assert that, on the real function.
  const strippedFromBareSpan = htmlToSiyuanDom('<span></span>');
  check(
    '★ an empty span strips to the empty string, so the fallback after || fires',
    strippedFromBareSpan === '',
    `got=${JSON.stringify(strippedFromBareSpan)}`,
  );
  check(
    '★ and it would have been truthy without the strip —— the defect form (a bare span is not falsy)',
    Boolean('<span></span>'),
  );
  // The end-to-end consequence the user saw: no bare empty span can reach the kernel.
  check(
    '★ no bare empty span survives into the paragraph DOM',
    !buildParagraphDom('<span></span>').includes('<span></span>'),
    `got=${buildParagraphDom('<span></span>')}`,
  );
  // And a span with real content must NOT be stripped along with the empty ones.
  check(
    'a span holding text survives (the stripper is not a blunt delete)',
    htmlToSiyuanDom('<span>甲</span>').includes('甲'),
    `got=${JSON.stringify(htmlToSiyuanDom('<span>甲</span>'))}`,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
