/**
 * Both sides of the "echo comparison" for an empty node must use the same measure.
 *
 * Background (a measured **false conflict** bug):
 *   Click an empty node in the outline, press Enter 3 times to create empty nodes, and the top banner accumulates:
 *
 *       ⚠ 1 content conflict → ⚠ 2 → ⚠ 3
 *
 *   yet with **no external change at all**. Measured diagnostic log (printed by temporary instrumentation):
 *
 *       {"blockId":"20261008033142-2r4n4k4",
 *        "incoming":"\u200b\u200b",   ← kernel echo
 *        "current":"",                ← mind map side
 *        "isEcho":true,               ← indeed something we wrote ourselves
 *        "ownVals":[""]}              ← the value we registered
 *
 *   That is: `isEcho` recognised it, but the value we wrote (`""`) and the echo (`"\u200b\u200b"`)
 *   are **not string-equal**, so `isOwnValue` returns false and it falls into the conflict decision.
 *
 * ── Why both sides share one set of normalisation rules ──────────────────────────────────
 *
 *   The same "empty" takes a different form in three places:
 *     · mind map node      `<span></span>` / `<span></span><p><br></p>`  → empty string
 *     · what we write out  a zero-width space `\u200b` (the kernel uses it to mean "an empty line that has content")
 *     · the kernel echo    `<div contenteditable="true">\u200b\u200b</div>`
 *
 *   If even one side fails to strip the zero-width space, an empty node is judged "changed outside" forever.
 *
 * This test pins down: the two accessor functions give the **same** result for the same batch of "empty" inputs.
 */
export {};

import { htmlFragmentToText, visibleText } from './sync';

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

/**
 * Replicates `mount.ts`'s `plainNodeText` (the measure used on the mind map side).
 * The two must agree -- that is exactly the invariant this test guards.
 */
const plainNodeText = (html: string | undefined): string =>
  (html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u200b/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

console.log('the various forms of an empty node should normalise to the same value:');
{
  // mind map side forms
  const mapSide = [
    '<span></span>',
    '<span></span><p><br></p><p><br></p>',
    '',
    '\u200b',
    '<span>\u200b</span>',
  ];
  for (const v of mapSide) {
    check(
      `mind map side ${JSON.stringify(v)} → ""`,
      plainNodeText(v) === '',
      `got=${JSON.stringify(plainNodeText(v))}`,
    );
  }

  // kernel side forms (wrapped in a contenteditable div)
  const kernelSide = [
    '<div contenteditable="true">\u200b\u200b</div>',
    '<div contenteditable="true">\u200b</div>',
    '<div contenteditable="true"></div>',
    '<div contenteditable="true"><br></div>',
  ];
  for (const v of kernelSide) {
    check(
      `kernel side ${JSON.stringify(v)} → ""`,
      htmlFragmentToText(v) === '',
      `got=${JSON.stringify(htmlFragmentToText(v))}`,
    );
  }
}

console.log('\nboth sides must give the same result for the same logical content:');
{
  // (mind map side HTML, kernel side HTML) -- both are semantically "empty"
  const pairs: Array<[string, string]> = [
    ['<span></span>', '<div contenteditable="true">\u200b\u200b</div>'],
    ['<span></span><p><br></p>', '<div contenteditable="true">\u200b</div>'],
    ['', '<div contenteditable="true"></div>'],
  ];
  for (const [m, k] of pairs) {
    const a = plainNodeText(m);
    const b = htmlFragmentToText(k);
    check(
      `★ empty: mind map side ${JSON.stringify(a)} == kernel side ${JSON.stringify(b)}`,
      a === b,
      `map=${JSON.stringify(a)} kernel=${JSON.stringify(b)}`,
    );
  }

  // non-empty must agree too (fixing empty nodes must not break normal text)
  const textPairs: Array<[string, string]> = [
    ['<span>甲</span>', '<div contenteditable="true">甲</div>'],
    ['<span>节点四</span>', '<div contenteditable="true">节点四</div>'],
  ];
  for (const [m, k] of textPairs) {
    const a = plainNodeText(m);
    const b = htmlFragmentToText(k);
    check(
      `★ has text: ${JSON.stringify(a)} == ${JSON.stringify(b)}`,
      a === b && a !== '',
      `map=${JSON.stringify(a)} kernel=${JSON.stringify(b)}`,
    );
  }
}

console.log('\nreverse check: without stripping the zero-width space they do not match (proving this test targets a real defect):');
{
  // how the old htmlFragmentToText was written (trim only, no \u200b stripping)
  const legacy = (html: string): string => {
    const m = /<div[^>]*contenteditable="true"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    if (!m) return '';
    return m[1].replace(/<[^>]+>/g, '').trim();
  };
  const kernelEcho = '<div contenteditable="true">\u200b\u200b</div>';
  check(
    '★ under the old implementation the two sides of an empty node really are unequal (the defective form exists)',
    plainNodeText('<span></span>') !== legacy(kernelEcho),
    `map=${JSON.stringify(plainNodeText('<span></span>'))} legacy=${JSON.stringify(legacy(kernelEcho))}`,
  );
}


// ── entities: the two sides must agree on the same node ──
// A node whose text contains &, < or > comes back from the kernel as &amp;/&lt;/&gt;. When mount.ts had
// its own normalizer that decoded only &nbsp;, that node never matched its own echo and every write-back
// raised a conflict on text nobody had touched.
{
  const same = (label: string, plain: string, fragmentBody: string): void => {
    const fromKernel = htmlFragmentToText(`<div contenteditable="true">${fragmentBody}</div>`);
    check(label, fromKernel !== null && fromKernel === visibleText(plain));
  };
  same('an ampersand agrees on both sides', 'a & b', 'a &amp; b');
  // Both sides receive **HTML** in real use (the kernel's fragment, and the node's stored content), so a
  // literal `<tag>` here would be testing the wrong thing: `visibleText` would strip it as a tag. That is
  // correct for HTML and is why this normalizer must not be handed decoded text.
  same('angle brackets agree on both sides', '&lt;tag&gt;', '&lt;tag&gt;');
  same('a quote agrees on both sides', '&quot;q&quot; and &#39;s&#39;', '&quot;q&quot; and &#39;s&#39;');
  check('a tag-like span in HTML is dropped, as a tag is', visibleText('a <b>bold</b> c') === 'a bold c');
  same('a non-breaking space agrees on both sides', 'a b', 'a&nbsp;b');
  same('a line break agrees on both sides', 'a b', 'a<br>b');
  check('an entity is decoded, not left as text', visibleText('a &amp; b') === 'a & b');
  check('an unknown entity is left alone rather than eaten', visibleText('&weird;') === '&weird;');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
