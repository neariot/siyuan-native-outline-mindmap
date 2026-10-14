// The write side of inline markup: `htmlToSiyuanDom` is the **only** serializer the
// live write path uses (`store.ts` `saveNodesIncremental` → `updateBlockDom`,
// dataType="dom"), so what it does not map is markup that never reaches SiYuan.
//
// The expectations here are not opinions about SiYuan: every row is a measured
// kernel round trip (see `docs/todo/inline-markup-sync.md` §2, and the probes under
// `.tmp/audit-sync/`). Where a form has not been measured against the running kernel,
// it is deliberately absent from this file rather than guessed.
//
// Runs offline, no SiYuan needed (`core/` has no DOM dependency):
//   python3 scripts/run-tests.py inline-sync

import { htmlToSiyuanDom, htmlToKramdown, kramdownToHtml, markdownToInlineDom } from './map';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, got?: unknown, want?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

// ---------------------------------------------------------------- D2: colour survives a read

// ★ The kernel exports an inline style as "HTML span + trailing IAL", and the hex colour
//   inside `style` is what a `#`-anchored rule must never touch. Measured corruption:
//   `style="color: #dc2a2a;"` became `style="color: <span data-tag="dc2a2a;">…`.
check(
  'D2 reading a coloured span keeps the style attribute intact',
  kramdownToHtml('<span data-type="text" style="color: #dc2a2a;">甲</span>{: style="color: #dc2a2a;"}') ===
    '<span data-type="text" style="color: #dc2a2a;">甲</span>',
  kramdownToHtml('<span data-type="text" style="color: #dc2a2a;">甲</span>{: style="color: #dc2a2a;"}'),
  '<span data-type="text" style="color: #dc2a2a;">甲</span>',
);

// A tag in the *text* must still be recognised —— the fix is "do not look inside tags",
// not "stop matching #".
check(
  'D2 a tag written in the text is still recognised',
  kramdownToHtml('see #proj here') === 'see <span data-tag="proj">#proj</span> here',
  kramdownToHtml('see #proj here'),
  'see <span data-tag="proj">#proj</span> here',
);

// A # inside an href must not become a tag either.
check(
  'D2 a fragment in a URL is left alone',
  !kramdownToHtml('[go](https://x.test/#anchor)').includes('data-tag'),
  kramdownToHtml('[go](https://x.test/#anchor)'),
  '[go](https://x.test/#anchor)',
);

// ---------------------------------------------------------------- D4: <strike>

// Blink's execCommand('strikeThrough') emits <strike>, measured in a real browser.
check(
  'D4 <strike> becomes SiYuan strikethrough',
  htmlToSiyuanDom('<strike>甲</strike>') === '<span data-type="s">甲</span>',
  htmlToSiyuanDom('<strike>甲</strike>'),
  '<span data-type="s">甲</span>',
);
// And the markdown writer must recognise it too, or the two sides disagree again.
check(
  'D4 <strike> becomes ~~ in the markdown writer',
  htmlToKramdown('<strike>甲</strike>') === '~~甲~~',
  htmlToKramdown('<strike>甲</strike>'),
  '~~甲~~',
);

// ---------------------------------------------------------------- D5: CSS marks become SiYuan marks

// The outline sets styleWithCSS=true, so these are what bold/italic/underline/strike
// actually put in the DOM (measured in the live outline).
const CSS_MARKS: Array<[string, string, string]> = [
  ['bold', '<span style="font-weight: bold;">甲</span>', '<span data-type="strong">甲</span>'],
  ['italic', '<span style="font-style: italic;">甲</span>', '<span data-type="em">甲</span>'],
  ['underline', '<span style="text-decoration-line: underline;">甲</span>', '<span data-type="u">甲</span>'],
  ['strike', '<span style="text-decoration-line: line-through;">甲</span>', '<span data-type="s">甲</span>'],
];
for (const [label, input, want] of CSS_MARKS) {
  check(`D5 ${label} is written as a SiYuan mark`, htmlToSiyuanDom(input) === want, htmlToSiyuanDom(input), want);
}

// Bold + colour is one tag carrying both: the kernel needs them merged (measured).
check(
  'D5 bold plus colour stays one mark carrying a style',
  htmlToSiyuanDom('<span style="font-weight: bold; color: #dc2a2a;">甲</span>') ===
    '<span data-type="strong" style="color: #dc2a2a;">甲</span>',
  htmlToSiyuanDom('<span style="font-weight: bold; color: #dc2a2a;">甲</span>'),
  '<span data-type="strong" style="color: #dc2a2a;">甲</span>',
);

// Plain colour must stay a plain style: it is not a mark, and the kernel keeps it.
check(
  'D5 colour on its own stays an inline style',
  htmlToSiyuanDom('<span style="color: #dc2a2a;">甲</span>') ===
    '<span data-type="text" style="color: #dc2a2a;">甲</span>',
  htmlToSiyuanDom('<span style="color: #dc2a2a;">甲</span>'),
  '<span data-type="text" style="color: #dc2a2a;">甲</span>',
);
// Highlight background likewise.
check(
  'D5 highlight background is an inline style, not a mark',
  htmlToSiyuanDom('<span style="background-color: rgb(255, 241, 118);">甲</span>') ===
    '<span data-type="text" style="background-color: rgb(255, 241, 118);">甲</span>',
  htmlToSiyuanDom('<span style="background-color: rgb(255, 241, 118);">甲</span>'),
  '<span data-type="text" style="background-color: rgb(255, 241, 118);">甲</span>',
);
// Underline + bold must merge into one multi-type mark rather than nest.
check(
  'D5 underline plus bold merges into one span',
  htmlToSiyuanDom('<span style="text-decoration-line: underline;"><span style="font-weight: bold;">甲</span></span>') ===
    '<span data-type="u strong">甲</span>',
  htmlToSiyuanDom('<span style="text-decoration-line: underline;"><span style="font-weight: bold;">甲</span></span>'),
  '<span data-type="u strong">甲</span>',
);

// ---------------------------------------------------------------- D6: links

// `<a href>` is stored as `<protyle-html>` by the kernel (measured). The accepted form
// is a span carrying `a` + `data-href`.
check(
  'D6 a link is written as the form the kernel accepts',
  htmlToSiyuanDom('<a href="https://x.test">text</a>') === '<span data-type="a" data-href="https://x.test">text</span>',
  htmlToSiyuanDom('<a href="https://x.test">text</a>'),
  '<span data-type="a" data-href="https://x.test">text</span>',
);
check(
  'D6 an anchor with a title keeps it',
  htmlToSiyuanDom('<a href="https://x.test" title="T">text</a>') ===
    '<span data-type="a" data-href="https://x.test" data-title="T">text</span>',
  htmlToSiyuanDom('<a href="https://x.test" title="T">text</a>'),
  '<span data-type="a" data-href="https://x.test" data-title="T">text</span>',
);

// ---------------------------------------------------------------- D7: tag / reference / formula

// All three degrade to a plain text span without a rule (measured).
check(
  'D7 a tag is written as the plain text SiYuan stores it as',
  htmlToSiyuanDom('<span data-tag="proj">#proj</span>') === '#proj',
  htmlToSiyuanDom('<span data-tag="proj">#proj</span>'),
  '#proj',
);
check(
  'D7 a block reference is written in the form the kernel reads back',
  htmlToSiyuanDom('<span data-noderef="20260101000000-abc1234">T</span>') ===
    '<span data-type="block-ref" data-id="20260101000000-abc1234">T</span>',
  htmlToSiyuanDom('<span data-noderef="20260101000000-abc1234">T</span>'),
  '<span data-type="block-ref" data-id="20260101000000-abc1234">T</span>',
);
check(
  'D7 an inline formula is written in the form the kernel reads back',
  htmlToSiyuanDom('<span data-formula="E=mc^2">$E=mc^2$</span>') ===
    '<span data-type="inline-math" data-subtype="math" data-content="E=mc^2">$E=mc^2$</span>',
  htmlToSiyuanDom('<span data-formula="E=mc^2">$E=mc^2$</span>'),
  '<span data-type="inline-math" data-subtype="math" data-content="E=mc^2">$E=mc^2$</span>',
);

// A mention is not an inline mark in SiYuan (measured: no data-type produces one), so the
// honest mapping is the plain text the reader will re-recognise.
check(
  'D7 a mention degrades to its text rather than to an attribute the kernel drops',
  htmlToSiyuanDom('<span data-mention="20260101000000-abc1234">@Doc</span>') === '@Doc',
  htmlToSiyuanDom('<span data-mention="20260101000000-abc1234">@Doc</span>'),
  '@Doc',
);

// ---------------------------------------------------------------- agreement between the two writers

// ★ The defect class: the reader produces a form the writer cannot store. For every
//   markup the reader emits, the writer must produce something the kernel keeps.
const AGREEMENT: Array<[string, string]> = [
  ['bold', '<b>甲</b>'],
  ['italic', '<i>甲</i>'],
  ['strike', '<s>甲</s>'],
  ['inline code', '<code>甲</code>'],
  ['underline', '<u>甲</u>'],
  ['mark', '<mark>甲</mark>'],
  ['tag', '<span data-tag="proj">#proj</span>'],
  ['block reference', '<span data-noderef="20260101000000-abc1234">T</span>'],
  ['formula', '<span data-formula="E=mc^2">$E=mc^2$</span>'],
];
for (const [label, readerForm] of AGREEMENT) {
  const written = htmlToSiyuanDom(readerForm);
  check(
    `agreement: the writer keeps ${label} (no markup is stripped away)`,
    !/^甲$/.test(written) && !written.startsWith('<protyle-html'),
    written,
    'something other than bare text',
  );
}

// ---------------------------------------------------------------- D3: the change detector

// `store.ts` decides "does this block need rewriting?" before it calls `updateBlockDom`.
// The two sides must be reduced to the **same** form, or an edit is invisible to the check
// and never reaches the document.
//
// The stored column it used was `blocks.content`, which measured **plain text**: every markup
// variant of a paragraph reads back as the same stripped string, so removing a mark left both
// sides equal and the write was skipped. This is the reported "strikethrough is not synced",
// and it is fixed by comparing in SiYuan inline DOM — the form the write actually sends.
//
// Three properties, all needed:
//   ① a real edit must be seen  (otherwise the user's change is dropped)
//   ② an unchanged reload must compare equal  (otherwise every save rewrites every node)
//   ③ a removed mark must be seen as removed  (this is ① applied to the reported defect)

// `label -> [node text the outline holds, the kramdown the kernel really stored]`
// The kramdown column is what `.logs/audit-roundtrip-probe5.log` measured.
const DETECTOR: Array<[string, string, string]> = [
  ['plain', '<span>文字</span>', '文字'],
  ['bold', '<span style="font-weight: bold;">文字</span>', '**文字**'],
  ['italic', '<span style="font-style: italic;">文字</span>', '*文字*'],
  ['strike', '<span style="text-decoration-line: line-through;">文字</span>', '~~文字~~'],
  ['underline', '<span style="text-decoration-line: underline;">文字</span>', '<u>文字</u>'],
  ['bold and colour', '<span style="font-weight: bold; color: #dc2a2a;">文字</span>', '**文字**{: style="color: #dc2a2a;"}'],
  ['highlight', '<span style="background-color: #fff176;">文字</span>', '<span data-type="text" style="background-color: #fff176;">文字</span>{: style="background-color: #fff176;"}'],
  ['inline code', '<code>文字</code>', '`文字`'],
  ['highlight mark', '<mark>文字</mark>', '==文字=='],
  ['link', '<a href="https://x.test">文字</a>', '[文字](https://x.test)'],
  ['tag', '<span data-tag="proj">#proj</span>', '#proj'],
  ['formula', '<span data-formula="E=mc^2">$E=mc^2$</span>', '$E=mc^2$'],
  ['image', '<img data-img="assets/a.png" alt="a" />', '![a](assets/a.png)'],
];

// ② An unchanged reload must be a no-op for the detector.
for (const [label, nodeText, stored] of DETECTOR) {
  const a = htmlToSiyuanDom(nodeText);
  const b = markdownToInlineDom(stored);
  check(`detector ② ${label}: an unchanged reload is recognised as unchanged`, a === b, b, a);
}

// ① + ③ A real edit must not be skipped.
const EDITS: Array<[string, string, string]> = [
  ['bold removed', '<span>文字</span>', '**文字**'],
  ['italic removed', '<span>文字</span>', '*文字*'],
  ['strikethrough removed', '<span>文字</span>', '~~文字~~'],
  ['underline removed', '<span>文字</span>', '<u>文字</u>'],
  ['inline code removed', '<span>文字</span>', '`文字`'],
  ['colour removed', '<span>文字</span>', '<span data-type="text" style="color: #dc2a2a;">文字</span>{: style="color: #dc2a2a;"}'],
  ['colour changed', '<span style="color: #00ff00;">文字</span>', '<span data-type="text" style="color: #dc2a2a;">文字</span>{: style="color: #dc2a2a;"}'],
  ['text typed', '<span>文字丁</span>', '文字'],
  ['a reference removed', '<span>文字</span>', '((20260101000000-abc1234 "T")) 文字'],
];
for (const [label, nodeText, stored] of EDITS) {
  const a = htmlToSiyuanDom(nodeText);
  const b = markdownToInlineDom(stored);
  check(`detector ① ${label}: the change is seen, so the write is not skipped`, a !== b, b, a);
}

// The comparison must not be defeated by the plain-text column it used to read.
check(
  'detector: the plain content column cannot stand in for the markup',
  markdownToInlineDom('<span data-type="text" style="color: #dc2a2a;">文字</span>{: style="color: #dc2a2a;"}') !==
    htmlToSiyuanDom('<span>文字</span>'),
  markdownToInlineDom('<span data-type="text" style="color: #dc2a2a;">文字</span>{: style="color: #dc2a2a;"}'),
  htmlToSiyuanDom('<span>文字</span>'),
);

// ---------------------------------------------------------------- report

if (fail > 0) {
  console.error(`\n${fail} failed, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ninline-sync: ${pass} passed`);
}