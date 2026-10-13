// ★★★ The synchronous verdict on a reused-id insert, driven directly.
//
// `insertPreVerified` reads the new paragraph's text out of the insert response's own DOM
// (`op.data`) instead of polling the lagging SQL index. A clean insert's paragraph holds the
// bare sent text; a mangled reuse (`{: id}` of a recently-deleted block, measured on the undo +
// toggle paths) holds the leaked `<span data-type="text">…</span>`. `firstParagraphText` extracts
// that text verbatim — no tag stripping, because the span IS the verdict.

import { firstParagraphText } from './store';

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

const opData = (paraInner: string): string =>
  `<div data-subtype="o" data-node-id="20261013043046-xi5u119" data-type="NodeList" class="list" updated="20261013043046">` +
  `<div data-marker="1." data-subtype="o" data-node-id="20261013043044-7gdf775" data-type="NodeListItem" class="li" updated="20261013043044">` +
  `<div class="protyle-action protyle-action--order" contenteditable="false" draggable="true">1.</div>` +
  `<div data-node-id="20261013043046-1ykcv2a" data-type="NodeParagraph" class="p" updated="20261013043046">` +
  `<div contenteditable="true" spellcheck="false">${paraInner}</div>` +
  `<div class="protyle-attr" contenteditable="false">​</div></div>` +
  `<div class="protyle-attr" contenteditable="false">​</div></div>` +
  `<div class="protyle-attr" contenteditable="false">​</div></div>`;

// ---------------------------------------------------------------- the verdict

{
  check(
    '★ a clean insert reads back the bare text',
    firstParagraphText(opData('乙')) === '乙',
    String(firstParagraphText(opData('乙'))),
  );
  check(
    '★ a mangled reuse reads back the leaked span VERBATIM (that difference is the verdict)',
    firstParagraphText(opData('<span data-type="text">乙</span>')) === '<span data-type="text">乙</span>',
    String(firstParagraphText(opData('<span data-type="text">乙</span>'))),
  );
  check(
    '★ clean and mangled are distinguishable',
    firstParagraphText(opData('乙')) !== firstParagraphText(opData('<span data-type="text">乙</span>')),
  );
}

// ---------------------------------------------------------------- degenerate inputs

{
  check('★ an empty response carries no verdict', firstParagraphText('') === null);
  check(
    '★ a response with no paragraph carries no verdict',
    firstParagraphText('<div data-type="NodeList"></div>') === null,
  );
}

// ---------------------------------------------------------------- report

console.log(`insert-verdict: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
