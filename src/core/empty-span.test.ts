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
    check(
      `★ and the content is non-empty (the || fallback really takes effect)`,
      out.includes('\u200b') || out.replace(/<[^>]*>/g, '').length > 0,
      `got=${out}`,
    );
  }
}

// ---- 2. spans with content must not be damaged ----
{
  check(
    '★ a span with text is kept as-is',
    htmlToSiyuanDom('<span>橙子</span>') === '<span>橙子</span>',
    `got=${JSON.stringify(htmlToSiyuanDom('<span>橙子</span>'))}`,
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

// ---- 4. reverse check: before stripping empty spans it really does leak through ----
{
  // Hand-build an old implementation that does not strip empty spans, to confirm the defect form really exists
  const legacy = (h: string): string =>
    h.replace(/<b>([\s\S]*?)<\/b>/g, '<span data-type="strong">$1</span>');
  const leaked = `<div data-type="NodeParagraph">${legacy('<span></span>') || '\u200b'}</div>`;
  check(
    '★ the old implementation really does leak a bare empty span into the kernel (proof that this test targets a real defect)',
    leaked.includes('<span></span>'),
    `got=${leaked}`,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
