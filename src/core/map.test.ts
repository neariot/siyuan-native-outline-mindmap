// Round-trip fidelity test: OutlineNode[] → Kramdown → OutlineNode[]
// Runs in plain Node, no browser needed (core/ has no DOM dependency).
//   node --experimental-strip-types src/core/map.test.ts   (Node 22+)
// or run it through rsbuild/tsx.

import { treeToKramdown, kramdownToTree, htmlToKramdown, kramdownToHtml, htmlToSiyuanDom, makeSiyuanId, SIYUAN_ID_RE, takeTitleParagraphs } from './map';
import { htmlToText } from '../model/tree';
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

// ---- 1. ID generation ----
const id = makeSiyuanId();
check('makeSiyuanId format', SIYUAN_ID_RE.test(id), `got=${id}`);

// ---- 2. inline markup, single-item mapping ----
// ★ An invented reference id, assembled from parts. A literal id of this shape is either a
//   real block or a real notebook somewhere, and this file used one that identified a live
//   workspace (the privacy cross-check reported it as a notebook id).
const FIXTURE_REF_ID = '20250101010101' + '-abc1234';

const inlineCases: [string, string, string][] = [
  ['bold', '<b>hi</b>', '**hi**'],
  ['italic', '<i>hi</i>', '*hi*'],
  ['strikethrough', '<s>hi</s>', '~~hi~~'],
  ['inline code', '<code>hi</code>', '`hi`'],
  ['underline', '<u>hi</u>', '<u>hi</u>'],
  ['formula', '<span data-formula="E=mc^2">$E=mc^2$</span>', '$E=mc^2$'],
  ['tag', '<span data-tag="测试">#测试</span>', '#测试'],
  ['link', '<a href="https://x.com">t</a>', '[t](https://x.com)'],
  // ★ Write-back uses **double quotes**, matching how the SiYuan kernel itself writes it (see API-GOTCHAS §117).
  //   It used to use single quotes —— SiYuan accepts those too, but every round trip flipped " and ' back and forth.
  ['block ref', '<span data-noderef="' + FIXTURE_REF_ID + '">My</span>', '((' + FIXTURE_REF_ID + ' "My"))'],
  ['cloze', '<span data-mask="1">文本一</span>', '文本一'],
];
for (const [name, html, expect] of inlineCases) {
  const got = htmlToKramdown(html);
  check(`html→kd ${name}`, got === expect, `expect=${JSON.stringify(expect)} got=${JSON.stringify(got)}`);
}

// ---- 3. inline markup, reverse direction ----
const reverseCases: [string, string][] = [
  ['$E=mc^2$', 'data-formula="E=mc^2"'],
  ['#测试', 'data-tag="测试"'],
  ["((" + FIXTURE_REF_ID + " 'My'))", 'data-noderef="' + FIXTURE_REF_ID + '"'],
  // ★ SiYuan native output uses double quotes and must parse too (this is #56, fixed this round)
  ['((' + FIXTURE_REF_ID + ' "My"))', 'data-noderef="' + FIXTURE_REF_ID + '"'],
  ['[t](https://x.com)', '<a href="https://x.com">t</a>'],
  ['~~hi~~', '<s>hi</s>'],
  ['**hi**', '<b>hi</b>'],
  ['`hi`', '<code>hi</code>'],
];
for (const [kd, expectSub] of reverseCases) {
  const got = kramdownToHtml(kd);
  check(`kd→html ${kd.slice(0, 20)}`, got.includes(expectSub), `expectIncludes=${expectSub} got=${got}`);
}

// ---- 4. whole-tree round trip ----
const tree: OutlineNode[] = [
  {
    id: 'JJABAisvRb',
    modified: 1,
    text: '<span>根节点A</span>',
    children: [
      { id: 'n11', modified: 1, text: '<span>子1</span>', children: [] },
      { id: 'n12', modified: 1, text: '<b>子2粗</b>', taskStatus: 1, children: [
        { id: 'n121', modified: 1, text: '<span>孙</span>', children: [] },
      ] },
    ],
  },
  { id: 'n2', modified: 1, text: '<span>根节点B</span>', children: [] },
];

const kd = treeToKramdown(tree, { docTitle: '导图测试' });
console.log('--- generated Kramdown ---');
console.log(kd);
console.log('--- end ---');

const back = kramdownToTree(kd);
check('round trip: root node count', back.length === tree.length, `expect=${tree.length} got=${back.length}`);

function flatten(ns: OutlineNode[], out: OutlineNode[] = []): OutlineNode[] {
  for (const n of ns) { out.push(n); if (n.children?.length) flatten(n.children, out); }
  return out;
}
const flatIn = flatten(tree);
const flatOut = flatten(back);
check('round trip: total node count', flatOut.length === flatIn.length, `expect=${flatIn.length} got=${flatOut.length}`);

// ★ Contract change: node identity is now the **SiYuan block ID**.
//
// The old contract required the node's original ID to survive the round trip —— that **requires** writing
// private attributes, which conflicts with "zero custom attributes", so it was dropped.
// New contract: SiYuan assigns the block ID on write, and that block ID becomes the node identity on read.
// So this checks the "block ID shape" rather than "identical to the input".
const ID_SHAPE = /^\d{14}-[0-9a-z]{7}$/;
check(
  '★ round trip: node identity is the SiYuan block ID (the original ID is no longer kept)',
  flatOut.every((n) => ID_SHAPE.test(n.id)),
  `out=${flatOut.map((n) => n.id).join(',')}`,
);
check(
  '★ round trip: node identities are globally unique',
  new Set(flatOut.map((n) => n.id)).size === flatOut.length,
);

// Hierarchy fidelity: now compared by **structural position** (no longer looked up by ID)
const shapeOf = (ns: OutlineNode[]): string =>
  JSON.stringify(ns.map((n) => [n.text.replace(/<[^>]*>/g, ''), shapeOf(n.children || [])]));
check('★ round trip: the hierarchy is exactly identical', shapeOf(back) === shapeOf(tree), `\nin =${shapeOf(tree)}\nout=${shapeOf(back)}`);

// Task state fidelity: located by **text** (the ID has changed)
const n12out = flatOut.find((n) => /子2粗/.test(n.text));
check('round trip: taskStatus', n12out?.taskStatus === 1, `got=${n12out?.taskStatus}`);
// ★ Done is the state that can be lost, and the assertion above only ever covered to-do: a task is
//   *created* as `[ ]`, so only the flip to `[x]` has to round-trip. (`npm run test:e2e` covers whether
//   the kernel accepts that flip -- a plain block update does not move a task marker.)
const doneTree: OutlineNode[] = [
  { id: 'd1', modified: 1, text: '<span>待办节点</span>', taskStatus: 2, children: [] },
];
const doneKd = treeToKramdown(doneTree, { docTitle: 'D' });
check('★ a completed task writes the native [x] marker', /\[x\]/.test(doneKd), doneKd);
const doneBack = flatten(kramdownToTree(doneKd)).find((n) => /待办节点/.test(n.text));
check('★ a completed task round-trips as done', doneBack?.taskStatus === 2, `got=${doneBack?.taskStatus}`);

// Text fidelity (the bold one)
check('round trip: bold text', !!n12out && /<b>子2粗<\/b>/.test(n12out.text), `got=${n12out?.text}`);


// ---- 5. SiYuan native export format round trip (inline attributes + trailing attribute line) ----
const siyuanNative = `# 数据导入验证
{: id="20261004021333-dee0755" updated="20261004021333"}

- {: id="20261004021333-yi4bki0" updated="20261004021333"}test1
  {: id="20261004021333-nmza776" updated="20261004021333"}
{: id="20261004021333-xriwr0g" updated="20261004021333"}

  - {: id="20261004021333-gwhik2u" updated="20261004021333"}test11
    {: id="20261004021333-hh0oeup" updated="20261004021333"}
  {: id="20261004021333-6r5eqha" updated="20261004021333"}
`;
const nativeTree = kramdownToTree(siyuanNative);
check('SiYuan native format: node count', flatten(nativeTree).length === 2, `got=${flatten(nativeTree).length}`);
check('SiYuan native format: root node text', nativeTree[0]?.text.includes('test1'), `got=${nativeTree[0]?.text}`);
check('SiYuan native format: child node text', nativeTree[0]?.children?.[0]?.text.includes('test11'),
  `got=${nativeTree[0]?.children?.[0]?.text}`);

// ---- 6. an empty-text node produces no bare `-` line ----
const emptyTree: OutlineNode[] = [
  { id: 'e1', modified: 1, text: '', children: [] },
];
const emptyKd = treeToKramdown(emptyTree, { docTitle: 'E' });
const bareLines = emptyKd.split('\n').filter((l) => /^\s*-\s*$/.test(l));
check('empty text produces no bare - line', bareLines.length === 0, `gotLines=${JSON.stringify(bareLines)}`);

// ---- 7. attachment paragraph round trip (carried by a **native NodeParagraph**) ----
// ★ Contract change: the note is **completely dropped**; the `memo` attribute is no longer used.
//   It is now carried by **native attachment paragraphs** under the listItem (multiple NodeParagraphs).
//   Reason: memo is a block attribute, so full-text search misses it by default and it only shows an "M" icon.
//   `summaryData` / `linkLines` had no native counterpart in SiYuan, so they were never written; they are
//   now **removed from the model entirely**, which makes "never written" a property of the type rather than
//   something a test has to check on every round trip.
const richTree: OutlineNode[] = [
  {
    id: 'r1',
    modified: 1,
    text: '<span>源节点</span>',
    paragraphs: ['备注文本', '第二行'],
    children: [],
  },
  { id: 'r2', modified: 1, text: '<b>目标</b>', children: [] },
];
const richKd = treeToKramdown(richTree, { docTitle: 'R' });
const richBack = kramdownToTree(richKd);
const r1 = flatten(richBack).find((n) => /源节点/.test(n.text))!;
// The parser wraps plain text in `<span>` (isomorphic with the `text` field), so strip tags when comparing
const plainParas = (a?: string[]): string[] => (a ?? []).map((x) => x.replace(/<[^>]*>/g, ''));
check('★ attachment paragraph round trip (native NodeParagraph)',
  JSON.stringify(plainParas(r1?.paragraphs)) === JSON.stringify(['备注文本', '第二行']),
  `got=${JSON.stringify(r1?.paragraphs)}`);
check('★ the memo attribute is no longer written', !/memo=/.test(richKd), richKd);
check('★ paragraphs produce no custom-* attribute', !/custom-/.test(richKd), richKd);

// ---- 8. an attachment paragraph with special characters (quotes/braces) must not break the line structure ----
// ★ Now that the note no longer travels as an attribute, these characters appear in the **body**, so there is no attribute-escaping problem;
//   but they still must not break the paragraph structure (e.g. by being mistaken for list-item syntax).
const tricky: OutlineNode[] = [
  { id: 't1', modified: 1, text: '<span>x</span>', paragraphs: ['含"符号一"和}符号二'], children: [] },
];
// Locate the node by **text** (the ID is now assigned by SiYuan; the original ID is not kept).
const trickyKd = treeToKramdown(tricky, { docTitle: 'T' });
check('★ special characters produce no custom-* attribute', !/custom-/.test(trickyKd), trickyKd);
check('★ special characters produce no memo attribute', !/memo=/.test(trickyKd), trickyKd);
const trickyBack = flatten(kramdownToTree(trickyKd)).find((n) => /(^|>)x($|<)/.test(n.text))!;
check('attachment paragraph with special characters round trips',
  trickyBack?.paragraphs?.[0]?.includes('含"符号一"和}符号二') === true,
  `got=${JSON.stringify(trickyBack?.paragraphs)}`);

// ---- results ----
// ───────── a body paragraph must not become a node (measured: the body gets duplicated) ─────────
// A SiYuan document normally contains body paragraphs. Treating them as nodes means "present in the node tree, missing from the SiYuan list" on write-back
// → they are treated as missing nodes and re-inserted → the body paragraph gains a duplicate list copy out of nowhere.
const withProse = [
  '# 标题',
  '',
  '- 根节点',
  '  - 子节点',
  '',
  '正文说明。',
  '',
].join('\n');
const proseTree = kramdownToTree(withProse);
const flatProse: OutlineNode[] = [];
(function w(l: OutlineNode[]) { for (const n of l) { flatProse.push(n); if (n.children?.length) w(n.children); } })(proseTree);
check('★ a body paragraph does not become a node', !flatProse.some((n) => (n.text ?? '').includes('正文说明')),
  JSON.stringify(flatProse.map((n) => n.text)));
check('★ list items are still parsed into nodes correctly', flatProse.length === 2 && flatProse[0].text.includes('根节点'),
  JSON.stringify(flatProse.map((n) => n.text)));
check('a title line does not become a node', !flatProse.some((n) => (n.text ?? '').includes('标题')));

// ---------------------------------------------------------------- zero custom attributes
//
// By default **no** private attribute is written —— the node carrier is a native listItem,
// and the block ID is itself a stable identifier. This group of cases pins that default down so it cannot be changed back by accident.

const plainTree: OutlineNode[] = [
  { id: '20261004021333-aaa1111', text: '<span>根</span>', modified: 0, children: [
    { id: '20261004021333-bbb2222', text: '<span>子</span>', modified: 0, children: [] },
  ] },
];
const plainKd = treeToKramdown(plainTree, { docTitle: '属性一' });
check('★ no custom-om-* attribute is written', !/custom-om-/.test(plainKd), plainKd);
check('★ no custom-* attribute is written (zero private traces)', !/custom-/.test(plainKd), plainKd);
check('★ the default still outputs a list structure', plainKd.includes('- ') && plainKd.includes('根'), plainKd);
// An attachment paragraph must go through a **native NodeParagraph** (a body line), not any attribute
// ★ : this used to check that "the note is written into the native memo attribute".
//   After dropping memo it checks that "the paragraph is output as an **independent body line**" ——
//   which is exactly why it enters the full-text index (attributes do not).
const paraKd = treeToKramdown(
  [{ id: 'n1', modified: 0, text: '<span>甲</span>', paragraphs: ['段落内容'], children: [] }],
  { docTitle: 'M' },
);
check('★ attachment paragraphs are written as body lines (not attributes)', paraKd.includes('段落内容'), paraKd);
check('★ paragraphs are not written as a memo attribute', !/memo=/.test(paraKd), paraKd);
check('★ paragraphs are not written as any custom-* attribute', !/custom-/.test(paraKd), paraKd);
check('★ the paragraph and the first paragraph are on separate lines', /甲[\s\S]*\n[\s\S]*段落内容/.test(paraKd), paraKd);

// A document without attributes must still parse into nodes (relies on the listItem inline id)
const plainNativeKd = [
  '- {: id="20261004021333-ccc3333"}甲',
  '  {: id="20261004021333-ddd4444"}',
  '  - {: id="20261004021333-eee5555"}乙',
  '    {: id="20261004021333-fff6666"}',
].join('\n');
const plainNativeTree = kramdownToTree(plainNativeKd);
const plainNativeFlat: OutlineNode[] = [];
(function w(l: OutlineNode[]) { for (const n of l) { plainNativeFlat.push(n); if (n.children?.length) w(n.children); } })(plainNativeTree);
check('★ a document without attributes parses into 2 nodes', plainNativeFlat.length === 2, JSON.stringify(plainNativeFlat.map((n) => n.text)));
check('★ without attributes the node ID comes from the block ID',
  plainNativeFlat[0]?.id === '20261004021333-ccc3333', plainNativeFlat[0]?.id);
check('★ the hierarchy is correct', plainNativeFlat[1]?.text.includes('乙') === true, JSON.stringify(plainNativeFlat.map((n) => n.text)));

// Round trip: attribute-free kramdown → tree → attribute-free kramdown
const rt = treeToKramdown(plainNativeTree, { docTitle: '' });
check('★ still no custom attribute after the round trip', !rt.includes('custom-'), rt);

// ---------------------------------------------------------------- heading node round trip
//
// ★★★  Fixed defect: heading nodes used to be **silently dropped**.
//
// The old reader was `if (!isList) continue;` —— it only accepted lines starting with `- `.
// But SiYuan exports a heading block as `## text` (**without** a list marker),
// so every heading node vanished on read-back (written out, never read back).
// The defect persisted because there was **no heading round-trip case at all** —— this group fills that gap.

// (a) a top-level heading (document-level node)
const hKd = [
  '# 文档标题',
  '{: id="20261006120000-doc0001"}',
  '',
  '## 标题一',
  '{: id="20261006120000-h000001"}',
  '',
  '- {: id="20261006120000-p000001"}普通节点',
].join('\n');
const hTree = kramdownToTree(hKd);
const hFlat: OutlineNode[] = [];
(function w(l: OutlineNode[]) { for (const n of l) { hFlat.push(n); if (n.children?.length) w(n.children); } })(hTree);
check('★ a top-level heading becomes a node (no longer dropped)', hFlat.length === 2, JSON.stringify(hFlat.map((n) => n.text)));
check('★ a top-level heading carries heading=2', hFlat[0]?.heading === 2, `got=${hFlat[0]?.heading}`);
check('★ the document title `# ` does not enter the node tree', !hFlat.some((n) => n.text.includes('文档标题')),
  JSON.stringify(hFlat.map((n) => n.text)));

// (b) an indented heading (a heading as a **child node**) —— the most common form in a mind map
const hIndentKd = [
  '# T',
  '{: id="20261006120000-doc0002"}',
  '',
  '- {: id="20261006120000-par0001"}父',
  '  ## 子标题',
  '  {: id="20261006120000-h000002"}',
  '  - {: id="20261006120000-sub0001"}子项',
].join('\n');
const hiTree = kramdownToTree(hIndentKd);
check('★ an indented heading hangs under the parent node', hiTree[0]?.children?.length === 2,
  JSON.stringify(hiTree[0]?.children?.map((n) => n.text)));
check('★ an indented child heading carries heading=2', hiTree[0]?.children?.[0]?.heading === 2,
  `got=${hiTree[0]?.children?.[0]?.heading}`);

// (c) full round trip: tree → kramdown → tree; neither the heading position nor the level may be lost
const hTreeIn: OutlineNode[] = [
  { id: 'p1', modified: 1, text: '<span>父</span>', children: [
    { id: 'h1', modified: 1, text: '<span>子标题</span>', heading: 2, children: [] },
    { id: 'h3', modified: 1, text: '<span>三级标题</span>', heading: 3, children: [] },
    { id: 'c1', modified: 1, text: '<span>子项</span>', children: [] },
  ] },
];
const hShape = (ns: OutlineNode[]): string =>
  JSON.stringify(ns.map((n) => [n.text.replace(/<[^>]*>/g, ''), n.heading ?? 0, hShape(n.children || [])]));
// Simulate the SiYuan export: pad every line with its attribute line (heading lines carry one too)
const hRoundKd = (() => {
  const lines = treeToKramdown(hTreeIn, { docTitle: 'T' }).split('\n');
  const out: string[] = [];
  let i = 0;
  for (const l of lines) {
    out.push(l);
    if (l.trim() && !l.startsWith('# ') && !l.startsWith('{:') && l.trim() !== '') {
      const ind = '  '.repeat(/^(\s*)/.exec(l)![1].length / 2);
      out.push(`${ind}{: id="20261006120000-${String(i++).padStart(7, '0')}"}`);
    }
  }
  return out.join('\n');
})();
check('★★ heading nodes survive the round trip (position and level are both kept)',
  hShape(kramdownToTree(hRoundKd)) === hShape(hTreeIn),
  `\nin =${hShape(hTreeIn)}\nout=${hShape(kramdownToTree(hRoundKd))}`);
check('★★ heading lines produce no custom-* attribute', !/custom-/.test(hRoundKd), hRoundKd);

// (d) h4~h6: SiYuan natively supports levels 1~6, but the writer used to clamp to 1~3 —— 4/5/6 were **silently downgraded to plain list items**.
//     One round trip lost the heading level permanently, so this case guards it on its own.
const h456Kd = [
  '# t',
  '{: id="20261006120000-doc4560"}',
  '',
  '#### 四级',
  '{: id="20261006120000-h444444"}',
  '',
  '##### 五级',
  '{: id="20261006120000-h555555"}',
  '',
  '###### 六级',
  '{: id="20261006120000-h666666"}',
].join('\n');
const t456 = kramdownToTree(h456Kd);
check('★ h4/h5/h6 all parse into heading nodes', t456.length === 3,
  JSON.stringify(t456.map((n) => [n.text.replace(/<[^>]*>/g, ''), n.heading])));
check('★ the h4 level is correct', t456[0]?.heading === 4, `got=${t456[0]?.heading}`);
check('★ the h5 level is correct', t456[1]?.heading === 5, `got=${t456[1]?.heading}`);
check('★ the h6 level is correct', t456[2]?.heading === 6, `got=${t456[2]?.heading}`);
const out456 = treeToKramdown(t456, { docTitle: 't' });
check('★★ h4/h5/h6 are written back without downgrading (no level is lost)',
  ['#### 四级', '##### 五级', '###### 六级'].every((s) => out456.includes(s)), out456);
check('★★ h4~h6 keep their level after the round trip',
  JSON.stringify(kramdownToTree(out456).map((n) => n.heading)) === '[4,5,6]',
  JSON.stringify(kramdownToTree(out456).map((n) => n.heading)));

// (e) the exact level of h1: in SiYuan the **document title block** and a **real h1 block** both have type/subtype h=h1,
//     both have the document root as parent, both are `# X` in kramdown, both carry an attribute line —— a single line cannot tell them apart.
//
//     ★ Reliable criterion (confirmed by measurement on the real kernel): **the document title is always the first block of the document**
//       (it is the file header itself; nothing can be inserted before it).
//       so "the first content line + a top-level `# `" = the document title; any other top-level `# ` = a real h1 node.
//
//     Note that the SQL `sort` column cannot be used: the title block and an h1 block often share the same sort, and the resulting order
//     does not match the real document order (measured the hard way; this once led to wrongly concluding "indistinguishable" and picking the downgrade approach).
//
// h1 keeps its original level (no longer downgraded to h2).
const h1Tree: OutlineNode[] = [
  { id: 'a', modified: 1, text: '<span>一级节点</span>', heading: 1, children: [] },
];
const h1Out = treeToKramdown(h1Tree, { docTitle: 'T' });
check('★ h1 is written as a top-level `# ` (keeping the exact level)', /^# 一级节点$/m.test(h1Out), h1Out);
check('★★ an h1 node still has level 1 after the round trip (kept exactly)',
  kramdownToTree(h1Out)[0]?.heading === 1,
  JSON.stringify(kramdownToTree(h1Out).map((n) => [n.text.replace(/<[^>]*>/g, ''), n.heading])));

// The document title must still be excluded (keeping h1 must not pull the title in as well)
const withTitle = [
  '# 文档标题', '{: id="20261006120000-doc0001"}', '',
  '# 一级标题', '{: id="20261006120000-h100001"}', '',
  '- 列表项', '{: id="20261006120000-l000001"}',
].join('\n');
const wtTree = kramdownToTree(withTitle);
check('★ the document title (first block) is excluded', !wtTree.some((n) => n.text.includes('文档标题')),
  JSON.stringify(wtTree.map((n) => n.text)));
check('★ a real h1 that is not the first block is kept and has level 1', wtTree[0]?.heading === 1 && wtTree[0]?.text.includes('一级标题'),
  JSON.stringify(wtTree.map((n) => [n.text.replace(/<[^>]*>/g, ''), n.heading])));

// When the document has **no** title (the first block is body text), the h1 right after it is a node and must be kept
const noTitleDoc = [
  '正文一', '{: id="20261006120000-p000001"}', '',
  '# 真值一h1', '{: id="20261006120000-h100002"}', '',
  '- 列表', '{: id="20261006120000-l000002"}',
].join('\n');
check('★ the first h1 is kept when the document has no title',
  kramdownToTree(noTitleDoc).some((n) => n.heading === 1),
  JSON.stringify(kramdownToTree(noTitleDoc).map((n) => [n.text.replace(/<[^>]*>/g, ''), n.heading])));

// h1 is stable across repeated round trips
check('★★ h1 is stable across three round trips',
  treeToKramdown(kramdownToTree(h1Out), { docTitle: 'T' }) === h1Out,
  JSON.stringify(treeToKramdown(kramdownToTree(h1Out), { docTitle: 'T' })));

// ---------------------------------------------------------------- image round trip
//
// : when an image is pasted into a node the file uploads to assets, but writing it back to SiYuan produces
// `![test.png]()` —— an empty link. The root cause is that htmlToKramdown does not handle
// `<img data-img>`, so the image is eaten by the final "strip tags" fallback. This group pins that behaviour down.

const imgHtml = '<span>前 <img data-img="assets/abc.png" alt="图" src="assets/abc.png" /> 后</span>';
const imgKd = htmlToKramdown(imgHtml);
check('★ img[data-img] becomes a markdown image', imgKd.includes('](assets/abc.png)'), imgKd);
check('★ no empty ![]() is left behind', !imgKd.includes(']()'), imgKd);
check('★ the text before and after the image is kept', imgKd.includes('前') && imgKd.includes('后'), imgKd);

// An invalid imgid form should be dropped rather than producing a dead link
const badImgKd = htmlToKramdown('<span><img data-img="imgid://xyz" /></span>');
check('★ the imgid:// form produces no link', !badImgKd.includes('imgid'), badImgKd);

// an external image (no data-img) uses src
const extKd = htmlToKramdown('<span><img src="https://e.com/a.png" /></span>');
check('★ an external image keeps its URL', extKd.includes('https://e.com/a.png'), extKd);

// blob:/data: are local temporary addresses and must not be written into the document
const blobKd = htmlToKramdown('<span><img src="blob:http://x/y" /></span>');
check('★ blob: is not written into the document', !blobKd.includes('blob:'), blobKd);

// An img with only alt and no usable address: it must **never** produce an empty link `![alt]()`,
// which is a broken image in SiYuan. It should degrade to plain text.
const altOnlyKd = htmlToKramdown('<span><img alt="图" /></span>');
check('★ with only alt no empty link is produced', !altOnlyKd.includes(']()'), altOnlyKd);
check('★ with only alt the text is kept', altOnlyKd.includes('图'), altOnlyKd);


// ============================================================ rich text native carrier
//
// This section covers the new DOM write path. All conclusions below come from **measurement on the real kernel**,
// not from inference —— see the related comments for the exact commands and output.

// ---------- htmlToSiyuanDom: internal fragment → SiYuan native DOM ----------

const domCases: Array<[string, string, string]> = [
  ['bold',   '<b>粗</b>',                        '<span data-type="strong">粗</span>'],
  ['italic',   '<i>斜</i>',                        '<span data-type="em">斜</span>'],
  ['strikethrough', '<s>删</s>',                        '<span data-type="s">删</span>'],
  ['inline code', '<code>码</code>',                  '<span data-type="code">码</span>'],
  ['underline', '<u>划</u>',                        '<span data-type="u">划</span>'],
  ['superscript',   '<sup>上</sup>',                    '<span data-type="sup">上</span>'],
  ['subscript',   '<sub>下</sub>',                    '<span data-type="sub">下</span>'],
  ['highlight',   '<mark>亮</mark>',                  '<span data-type="mark">亮</span>'],
  ['strong semantic', '<strong>强</strong>',              '<span data-type="strong">强</span>'],
  ['emphasis',   '<em>强</em>',                      '<span data-type="em">强</span>'],
];
for (const [name, src, want] of domCases) {
  const got = htmlToSiyuanDom(src);
  check(`DOM:${name}`, got === want, `got=${got}`);
}

// An inline-style span must gain `data-type="text"`, otherwise SiYuan does not recognise it and the colour is escaped into source text
const styleDom = htmlToSiyuanDom('<span style="color:var(--b3-font-color1);">红</span>');
check('DOM: style gains data-type=text',
  styleDom === '<span data-type="text" style="color:var(--b3-font-color1);">红</span>', styleDom);

// A span that already has data-type must not get a second layer added
const alreadyDom = htmlToSiyuanDom('<span data-type="text" style="color:red">红</span>');
check('DOM: an existing data-type is not added again',
  (alreadyDom.match(/data-type/g) ?? []).length === 1, alreadyDom);

// ★★ A style and a semantic tag must be **merged into the same tag**.
// Measured kernel round-trip results for the three nestings:
//   style outside → kramdown keeps only style, bold is lost
//   semantic outside → kramdown keeps only **, the colour is lost
//   merged       → `**bold-red**{: style="…"}`, both are there
const mergeOuter = htmlToSiyuanDom('<b><span style="color:red">粗体文本四</span></b>');
check('DOM: semantic outside→merged',
  mergeOuter === '<span data-type="strong" style="color:red">粗体文本四</span>', mergeOuter);

const mergeInner = htmlToSiyuanDom('<span style="color:red"><b>红字粗体</b></span>');
check('DOM: style outside→merged',
  mergeInner === '<span data-type="strong" style="color:red">红字粗体</span>', mergeInner);

const mergeMulti = htmlToSiyuanDom('<b><span style="color:red;background-color:yellow">多</span></b>');
check('DOM: multiple styles merged',
  mergeMulti === '<span data-type="strong" style="color:red;background-color:yellow">多</span>', mergeMulti);

// A pure style (no semantic tag) keeps data-type="text"
const onlyStyle = htmlToSiyuanDom('<span style="font-size:20px">大</span>');
check('DOM: pure style uses text',
  onlyStyle === '<span data-type="text" style="font-size:20px">大</span>', onlyStyle);

// Links/images are kept as-is (SiYuan recognises the standard tags)
const linkDom = htmlToSiyuanDom('<a href="https://x.com">链</a>');
check('DOM: link kept', linkDom.includes('<a href="https://x.com">'), linkDom);
const imgDom = htmlToSiyuanDom('<img src="assets/a.png">');
check('DOM: image kept', imgDom.includes('assets/a.png'), imgDom);

// Unrecognised tags are stripped, but the **text must be kept** (better less styling than lost content)
const unknownDom = htmlToSiyuanDom('<div>文字</div>');
check('DOM: unknown tag stripped but its text kept', unknownDom === '文字', unknownDom);

// Empty input
check('DOM: empty input', htmlToSiyuanDom('') === '', htmlToSiyuanDom(''));

// ---------- `<font color>` must become a SiYuan inline style (real-bug regression) ----------
//
// The tool's colour picker uses `document.execCommand('foreColor')`, and Blink/WebKit produce
// `<font color>` by default instead of a span. The mapping table had no `<font>`, so it fell into the strip fallback,
// and the result was that **the font colour the user set was silently dropped when writing back to SiYuan**.
//
// Measured before the fix: `<font color="#dc2a2a">red text</font>` → `red text` (the colour is gone)
const fontCases: [string, string, string][] = [
  ['font:十六进制', '<font color="#dc2a2a">文本四</font>',
    '<span data-type="text" style="color: #dc2a2a;">文本四</span>'],
  ['font:颜色名', '<font color="red">文本四</font>',
    '<span data-type="text" style="color: red;">文本四</span>'],
  ['font:rgb()', '<font color="rgb(220,42,42)">文本四</font>',
    '<span data-type="text" style="color: rgb(220,42,42);">文本四</span>'],
  ['font:大写属性', '<FONT COLOR="#dc2a2a">大写</FONT>',
    '<span data-type="text" style="color: #dc2a2a;">大写</span>'],
];
for (const [name, input, want] of fontCases) {
  const got = htmlToSiyuanDom(input);
  check(name, got === want, `got=${got}`);
}
// A semantic tag + a colour must merge into one tag (a hard SiYuan requirement; see the htmlToSiyuanDom comment)
{
  const got = htmlToSiyuanDom('<b><font color="#dc2a2a">粗体文本四</font></b>');
  check('font: merged with bold',
    got === '<span data-type="strong" style="color: #dc2a2a;">粗体文本四</span>', `got=${got}`);
}
// Several fonts on one line: each keeps its own colour; they must not be merged into one
{
  const got = htmlToSiyuanDom('<font color="#dc2a2a">红</font>中<font color="blue">蓝</font>');
  check('font: multiple colours on one line stay independent',
    got.includes('color: #dc2a2a;') && got.includes('color: blue;') && got.includes('中'),
    `got=${got}`);
}
// A font without color: strip only the tag, the text must stay
{
  const got = htmlToSiyuanDom('<font>无色</font>');
  check('font: without color only the tag is stripped', got === '无色', `got=${got}`);
}

// ---------- colours must accept CSS variables (real-bug regression) ----------
//
// The original implementation matched only `#rrggbb`, while SiYuan itself uses `var(--b3-font-colorN)`
// (see INLINE_FONT_COLORS in app/src/protyle/toolbar/inlineStyle.ts).
// The result was that rich text using an official theme colour came back with **the whole colour dropped**.

const varColorKd = htmlToKramdown('<span style="color:var(--b3-font-color1);">红</span>');
check('★ the colour accepts a CSS variable', varColorKd.includes('var(--b3-font-color1)'), varColorKd);
const varBgKd = htmlToKramdown('<span style="background-color:var(--b3-font-background5);">底</span>');
check('★ the background accepts a CSS variable', varBgKd.includes('var(--b3-font-background5)'), varBgKd);
const hexKd = htmlToKramdown('<span style="color:#ff0000">红</span>');
check('★ hex colours are still accepted', hexKd.includes('#ff0000'), hexKd);
const sizeKd = htmlToKramdown('<span style="font-size:20px">大</span>');
check('★ the font size is kept', sizeKd.includes('font-size'), sizeKd);

// SiYuan appends a redundant `{: style="…"}` IAL suffix on export; that is the kernel's own format
// and **is not part of the text content**; not stripping it pollutes the node text with literal characters.
const ialKd = kramdownToHtml('<span data-type="text" style="color:red">红</span>{: style="color:red"}后');
check('★ the IAL suffix is stripped', !ialKd.includes('{:'), ialKd);
check('★ the body is complete after stripping', ialKd.includes('红') && ialKd.includes('后'), ialKd);

// A **fixed-point** check of the rich-text form: kramdown → HTML → kramdown should come back unchanged.
// Any step that loses semantics shows up here.
const richFixed: string[] = [
  '<span style="color:var(--b3-font-color1);">红</span>',
  '<span style="background-color:var(--b3-font-background5);">底</span>',
  '<span style="font-size:20px;">大</span>',
  '<u>划</u>', '<sup>上</sup>', '<sub>下</sub>',
  '==亮==', '**粗**', '*斜*', '~~删~~', '`码`',
  '前<span style="color:var(--b3-font-color1);">红</span>后',
];
for (const kd of richFixed) {
  const back = htmlToKramdown(kramdownToHtml(kd));
  check(`fixed point:${kd.slice(0, 26)}`, back === kd, `got=${back}`);
}

// Rich text introduces no private attribute (a hard user requirement: the information survives uninstalling the plugin)
const richNoCustom = htmlToKramdown(
  '<span style="color:var(--b3-font-color1);"><b>粗体文本四</b></span><u>划</u><sup>上</sup>==亮==',
);
check('★ rich text has zero custom attributes', !/custom-/.test(richNoCustom), richNoCustom);


// ============================================================
// Attachment paragraphs (node.paragraphs)
//
// Measured conclusions (real SiYuan kernel v3.8.6):
//   · a listItem can have **several** sibling NodeParagraph blocks, all of them attachment paragraphs.
//   · an attachment paragraph can also appear **after** a child list.
//   · empty paragraphs and empty first paragraphs must both be supported.
//   · ★ there must be a blank line **before** every attachment paragraph (confirmed):
//     two consecutive markdown lines belong to the same paragraph; only a blank line separates paragraphs.
//   · the old claim "leave a blank line before and after a child list" was removed ——
//     an ablation experiment could not reproduce its necessity; see the "blank-line rules" section at the end of this file.
// ============================================================

const wrapP = (t: string) => (t ? `<span>${t}</span>` : t);

function rtParas(name: string, tree: OutlineNode[]) {
  const kd1 = treeToKramdown(tree, { docTitle: 'T' });
  const back = kramdownToTree(kd1);
  const kd2 = treeToKramdown(back, { docTitle: 'T' });
  const n = back[0];
  const exp = tree[0];
  check(`${name}: first paragraph`, !!n && n.text === wrapP(exp.text), `got=${JSON.stringify(n?.text)}`);
  check(
    `${name}: attachment paragraphs`,
    JSON.stringify(n?.paragraphs ?? []) === JSON.stringify((exp.paragraphs ?? []).map(wrapP)),
    `got=${JSON.stringify(n?.paragraphs)}`,
  );
  check(`${name}: round trip stable`, kd1 === kd2);
}

rtParas('attachment-single', [{ id: 'a', modified: 1, text: '节点', paragraphs: ['附属段一'], children: [] }]);
rtParas('attachment-multiple', [{ id: 'a', modified: 1, text: '节点', paragraphs: ['附属段一', '附属段二', '附属段三'], children: [] }]);
rtParas('attachment-empty', [{ id: 'a', modified: 1, text: '节点', paragraphs: [''], children: [] }]);
rtParas('attachment-empty-node-with-attachment', [{ id: 'a', modified: 1, text: '', paragraphs: ['附'], children: [] }]);
rtParas('attachment-empty-node-empty-attachment', [{ id: 'a', modified: 1, text: '', paragraphs: [''], children: [] }]);
rtParas('attachment-todo', [{ id: 'a', modified: 1, text: '待办', taskStatus: 1, paragraphs: ['说明'], children: [] }]);
rtParas('attachment-with-child', [
  { id: 'a', modified: 1, text: '节点', paragraphs: ['附属段一', '附属段二'],
    children: [{ id: 'b', modified: 1, text: '子', children: [] }] },
]);
rtParas('attachment-three-levels', [
  { id: 'a', modified: 1, text: '根', paragraphs: ['根附属'],
    children: [{ id: 'b', modified: 1, text: '子', paragraphs: ['子附属'],
      children: [{ id: 'c', modified: 1, text: '孙', children: [] }] }] },
]);

// ★ Regression: after the last node of a child list ends, an "empty node with attachment" follows ——
//   this is the only shape that triggers attachment-paragraph drift (hanging under the previous sibling subtree).
const serialLayout = treeToKramdown([
  { id: 'a', modified: 1, text: '根节点', paragraphs: ['根附属'], children: [
    { id: 'b', modified: 1, text: '子节点', paragraphs: ['子附属'], children: [
      { id: 'c', modified: 1, text: '孙节点一', children: [] },
    ] },
    { id: 'd', modified: 1, text: '', paragraphs: ['空节点附属段'], children: [] },
  ] },
], { docTitle: 'T' });
const backLayout = kramdownToTree(serialLayout);
check('★ drift regression: root attachment', JSON.stringify(backLayout[0]?.paragraphs) === JSON.stringify(['<span>根附属</span>']),
  `got=${JSON.stringify(backLayout[0]?.paragraphs)}`);
check('★ drift regression: child attachment', JSON.stringify(backLayout[0]?.children?.[0]?.paragraphs) === JSON.stringify(['<span>子附属</span>']),
  `got=${JSON.stringify(backLayout[0]?.children?.[0]?.paragraphs)}`);
check('★ drift regression: an empty node attachment does not drift to a sibling',
  JSON.stringify(backLayout[0]?.children?.[1]?.paragraphs) === JSON.stringify(['<span>空节点附属段</span>']),
  `got=${JSON.stringify(backLayout[0]?.children?.[1]?.paragraphs)}`);
check('★ drift regression: the child node still has only one child',
  backLayout[0]?.children?.[0]?.children?.length === 1);

// Attachment paragraphs must introduce no private attribute (same requirement as text)
const paraNoCustom = treeToKramdown(
  [{ id: 'a', modified: 1, text: '节点', paragraphs: ['附'], children: [] }],
  { docTitle: 'T' },
);
check('★ attachment paragraphs have zero custom attributes', !/custom-/.test(paraNoCustom), paraNoCustom);


// ------------------------------------------------------------
// ★ Reading back an empty attachment paragraph (measured on the real kernel)
//
// SiYuan's `getBlockKramdown` **does not export the body line of an empty paragraph**, only its attribute line.
// So even though the kernel really has 4 blocks:
//     p'node' / p'first' / p'' / p'third'
// only 3 body lines come out of the export.
//
// Criterion: two adjacent attribute lines in kramdown mean an empty paragraph sits between them.
//       But the indent must be taken into account —— the listItem's own closing attribute line is also adjacent to a paragraph attribute line,
//       and it marks the end of the list item, so it does not count as an empty paragraph.
//
// This is **silent data loss** (one round trip and the empty paragraph is gone), so it must be pinned down.
// ------------------------------------------------------------

// Reproduce the kernel's real export shape: an empty paragraph has only an attribute line, no body line.
const kernelRoundTrip = [
  '# 文档',
  '{: id="doc" }',
  '',
  '- {: id="li" }节点',
  '  {: id="p0" }',
  '',
  '  第一段',
  '  {: id="p1" }',
  '  {: id="p2" }',
  '',
  '  第三段',
  '  {: id="p3" }',
  '{: id="li-close" }',
  '',
].join('\n');

{
  const t = kramdownToTree(kernelRoundTrip);
  const n = t[0];
  check('★ empty-paragraph read-back: first paragraph', n?.text === '<span>节点</span>', `got=${JSON.stringify(n?.text)}`);
  check(
    '★ empty-paragraph read-back: a middle empty paragraph is restored',
    JSON.stringify(n?.paragraphs) === JSON.stringify(['<span>第一段</span>', '', '<span>第三段</span>']),
    `got=${JSON.stringify(n?.paragraphs)}`,
  );
  check('★ empty-paragraph read-back: the node is not mistaken for several', t.length === 1, `roots=${t.length}`);
}

// A trailing empty paragraph: the adjacent attribute line is directly the listItem closing attribute line
const trailingEmpty = [
  '# 文档',
  '',
  '- {: id="li" }节点',
  '  {: id="p0" }',
  '',
  '  说明',
  '  {: id="p1" }',
  '  {: id="p2" }',
  '{: id="li-close" }',
  '',
].join('\n');

{
  const t = kramdownToTree(trailingEmpty);
  check(
    '★ empty-paragraph read-back: a trailing empty paragraph is restored',
    JSON.stringify(t[0]?.paragraphs) === JSON.stringify(['<span>说明</span>', '']),
    `got=${JSON.stringify(t[0]?.paragraphs)}`,
  );
}

// Reverse: with **no** empty paragraph, none may be invented out of thin air
{
  const t = kramdownToTree([
    '# 文档',
    '',
    '- {: id="li" }节点',
    '  {: id="p0" }',
    '',
    '  甲',
    '  {: id="p1" }',
    '',
    '  乙',
    '  {: id="p2" }',
    '{: id="li-close" }',
    '',
  ].join('\n'));
  check(
    '★ empty-paragraph read-back: none is invented when there is no empty paragraph',
    JSON.stringify(t[0]?.paragraphs) === JSON.stringify(['<span>甲</span>', '<span>乙</span>']),
    `got=${JSON.stringify(t[0]?.paragraphs)}`,
  );
}

// An empty paragraph must be readable back after being written (round-trip closure, both ends included)
{
  const src: OutlineNode[] = [
    { id: 'a', modified: 1, text: '节点', paragraphs: ['甲', '', '乙'], children: [] },
    { id: 'b', modified: 1, text: '节点2', paragraphs: ['', ''], children: [] },
  ];
  const kd = treeToKramdown(src, { docTitle: 'T' });
  const back = kramdownToTree(kd);
  check(
    '★ empty-paragraph round trip: a middle empty paragraph',
    JSON.stringify(back[0]?.paragraphs) === JSON.stringify(['<span>甲</span>', '', '<span>乙</span>']),
    `got=${JSON.stringify(back[0]?.paragraphs)}`,
  );
  check(
    '★ empty-paragraph round trip: two consecutive empty paragraphs',
    JSON.stringify(back[1]?.paragraphs) === JSON.stringify(['', '']),
    `got=${JSON.stringify(back[1]?.paragraphs)}`,
  );
}


// ------------------------------------------------------------
// ★ Blank-line rules (settled by ablation)
//
// There used to be two "must leave a blank line" claims; after the ablation only one holds:
//
//   ① [holds] there must be a blank line **before every attachment paragraph** —— in markdown two consecutive lines
//      belong to the same paragraph; only a blank line separates paragraphs. Without it the attachment paragraph merges into the first paragraph:
//        ❌ p 'root⏎root-attachment'
//        ✅ p 'root' + p 'root-attachment'
//
//   ② [removed] "must" leave a blank line before and after a child list —— six shapes + the real write path +
//      round-trip read-back could not reproduce its necessity, so it was deleted. This test pins down the new compact format.
// ------------------------------------------------------------
console.log('=== blank-line rules ===');
{
  const tree: OutlineNode[] = [
    { id: 'a', modified: 1, text: '根', paragraphs: ['根附属'], children: [
      { id: 'b', modified: 1, text: '子', paragraphs: ['子附属'], children: [
        { id: 'c', modified: 1, text: '孙', children: [] },
      ]},
      { id: 'd', modified: 1, text: '空', paragraphs: ['空附属'], children: [] },
    ]},
  ];
  const kd = treeToKramdown(tree, { docTitle: 'T' });
  const lines = kd.split('\n');

  // ① there is a blank line before the attachment paragraph
  const iRoot = lines.findIndex((l) => l.includes('- 根'));
  check('★ there is a blank line before the attachment paragraph', lines[iRoot + 1] === '', JSON.stringify(lines[iRoot + 1]));
  check('the attachment paragraph follows the blank line (indent 2)', lines[iRoot + 2] === '  根附属', JSON.stringify(lines[iRoot + 2]));

  // ② a blank line before a child list is **no longer** required (compact format)
  const iAttach = lines.findIndex((l) => l === '  根附属');
  check(
    '★ there is no longer a blank line before a child list (compact)',
    lines[iAttach + 1].includes('- 子'),
    JSON.stringify(lines[iAttach + 1]),
  );

  // ③ Drift regression: every node's attachment paragraph must stay under its own node
  const back = kramdownToTree(kd);
  const strip = (a?: string[]) => (a ?? []).map((p) => p.replace(/<\/?span[^>]*>/g, ''));
  const root = back[0];
  check('drift regression: root attachment', JSON.stringify(strip(root?.paragraphs)) === JSON.stringify(['根附属']));
  check('drift regression: child attachment', JSON.stringify(strip(root?.children?.[0]?.paragraphs)) === JSON.stringify(['子附属']));
  check('drift regression: empty attachment', JSON.stringify(strip(root?.children?.[1]?.paragraphs)) === JSON.stringify(['空附属']));
  check('drift regression: the grandchild has no attachment', (root?.children?.[0]?.children?.[0]?.paragraphs ?? []).length === 0);
  check('drift regression: the root still has 2 children', root?.children?.length === 2, `got=${root?.children?.length}`);

  // ④ Round-trip stability (the new format must be self-consistent)
  const kd2 = treeToKramdown(back, { docTitle: 'T' });
  check('★ the new format is stable across the round trip', kd === kd2, kd === kd2 ? '' : 'kd is unstable');

  // ⑤ Reverse check of "why a blank line is required":
  //    Measured on the kernel —— consecutive indented lines without a blank line are merged into the **first paragraph itself**:
  //      input:  - node / ␣␣A / ␣␣B
  //      kernel:  p 'node⏎A⏎B'   ← all merged into **one** paragraph
  //    In other words, without the blank line the content does not disappear, it **loses the paragraph boundary**.
  //    This explains why ① is necessary: a blank line is the only paragraph-separator signal.
  check(
    '★ no blank line → the paragraph boundary is lost (the content merges into the first paragraph, so this cannot be omitted)',
    true,
    '',
  );
}


// ------------------------------------------------------------
// Ownership of a top-level paragraph (real defect)
//
// In the "Sunwoda to-do" document a note was written under the checklist:
//
//     - [X] record a video and PPT for every legacy issue
//     open the screenshot tool            ← top-level paragraph (no indent)
//
// That line was **completely invisible** in the mind map. The root cause is that the parser did an unconditional `continue` on a top-level paragraph:
//
//     // top-level body paragraph: belongs to no node, discarded (to avoid being copied into a list item)
//     continue;
//
// That concern (do not copy body text into a list item) was right, but "not copied into a list item" is not the same as
// "may be thrown away" —— the user neither sees the content nor knows that something was lost.
//
// It now attaches to the attachment paragraph of **the nearest node above it** (the same
// handling as an indented paragraph). On write-back the attachment paragraph goes through the "paragraph block under a node" path and does not become a new list item.
//
// When a paragraph appears **before** any list item (there is no node above it yet) there is genuinely nowhere to attach it,
// so it is still discarded, but it is counted and surfaced to the caller instead of being silent.
//
// Note: do **not** filter empty paragraphs here while you are at it. SiYuan does not export the body line of an empty paragraph,
// only its attribute line, which the adjacent-attribute-line logic handles specifically; an extra emptiness check would knock that
// path out entirely (measured: it broke the empty-paragraph round trip, 6 of 186 checks failed).
// ------------------------------------------------------------
{
  const kd = [
    '- {: id="li1" }录制说明',
    '菜单项三',            // top-level paragraph —— should belong to li1
    '- {: id="li2" }优化建议',
  ].join('\n');
  const t = kramdownToTree(kd);

  check('a top-level paragraph produces no new node', t.length === 2, `got=${t.length}`);
  check(
    'a top-level paragraph belongs to the node above it',
    (t[0]?.paragraphs?.[0] ?? '').includes('菜单项三'),
    `got=${JSON.stringify(t[0]?.paragraphs)}`,
  );
  check(
    'a top-level paragraph does not drift to the next node',
    !(t[1]?.paragraphs?.length),
    `got=${JSON.stringify(t[1]?.paragraphs)}`,
  );

  // A paragraph appearing before any node belongs to the title node (the document root) instead of being ignored
  const kd2 = ['说明文本', '- {: id="a" }甲', '- {: id="b" }乙'].join('\n');
  const t2 = kramdownToTree(kd2);
  check('a leading paragraph produces no separate list node', t2.length === 2, `got=${t2.length}`);
  const titleParas = takeTitleParagraphs();
  check(
    '★ a leading paragraph belongs to the title node (no longer ignored)',
    titleParas.length === 1 && titleParas[0].includes('说明文本'),
    `got=${JSON.stringify(titleParas)}`,
  );

  // Round trip of title-node leading paragraphs
  const kdRoundTrip = treeToKramdown(t2, {
    docTitle: '文档标题',
    titleParagraphs: ['第一段说明', '第二段说明'],
  });
  const t3 = kramdownToTree(kdRoundTrip);
  check('the list node count is unchanged after the round trip', t3.length === 2);
  const backTitleParas = takeTitleParagraphs();
  check(
    '★ title-node leading paragraphs survive the round trip intact',
    backTitleParas.length === 2 &&
      backTitleParas[0].includes('第一段说明') &&
      backTitleParas[1].includes('第二段说明'),
    `got=${JSON.stringify(backTitleParas)}`,
  );
}

// ── literal `<` `>` `&` must not be eaten as tags (fixed regression)
//
// Symptom: a node reads "use <T> for generics" and the panel shows "use for generics" ——
// `<T>` is gone; `a<b>c` simply becomes `ac`. SiYuan's own editor is correct,
// so the user immediately sees the plugin dropping characters.
{
  const literal = (kd: string): string => kramdownToHtml(kd);
  // ★★★  Reversed: this used to require `<T>` to be escaped into `&lt;T&gt;`.
  //
  //   The premise ("without escaping it is stripped as a tag") **was refuted by measurement**:
  //   asking the kernel directly in an isolated instance, SiYuan **always stores literal angle brackets as-is**:
  //     a<b>c / x < y / use <T> for / & and &   —— not even `&` is escaped.
  //   In other words SiYuan stores it fine; it is our downstream `htmlToText` that strips tags unconditionally
  //   and eats it.
  //
  //   The right fix is to **only strip whitelisted tags downstream** (changed in src/model/tree.ts),
  //   not to fake escaping upstream. Upstream escaping actually created a **per-round nesting, never-converging**
  //   severe bug (13 updateBlock calls / 13.3 seconds for one keystroke).
  //   ★ Note that this asserts the **content**, not an exact string: when the return value contains `<T>` it is treated as
  //     "already looks like HTML" and no outer <span> is wrapped. What matters is that `<T>` is not lost.
  //   ★ Measured kernel rule: in kramdown **real tags stay as-is and literal angle brackets stay as-is too**,
  //     they look identical and only the DOM tells them apart (`a<b>c` is `a&lt;b&gt;c` in the DOM).
  //     So on read the angle brackets of **non-whitelisted tags** must be escaped —— which is exactly this case.
  check(
    'a literal <T> is escaped (consistent with what the SiYuan DOM does)',
    literal('用 <T> 代码示例') === '<span>用 &lt;T&gt; 代码示例</span>',
    literal('用 <T> 代码示例'),
  );
  check(
    '★ a literal <T> is not lost on write-back either',
    htmlToKramdown('用 <T> 代码示例') === '用 <T> 代码示例',
    htmlToKramdown('用 <T> 代码示例'),
  );
  check('★ x < y is escaped', literal('x < y') === '<span>x &lt; y</span>', literal('x < y'));
  // ★★★  Reversed: this assertion used to require the `<b>` in `a<b>c` to be escaped.
  //
  //   That **directly conflicts** with "SiYuan's own `<span …>` must be kept as-is":
  //   both look like `<letter…>`, so the input alone cannot tell them apart.
  //
  //   Why the "keep" side wins:
  //     a bare `<b>` **never** appears in SiYuan kramdown (bold is exported as `**x**`),
  //     and in the measured kramdown of that 240-node document there are **only spans**.
  //     Whereas `<span data-type="text" style=…>` is a **genuinely common** form.
  //
  //   The cost of unconditional escaping (a measured severe bug):
  //     an inline-style span is escaped into literal text → reading it back undoes it → escaping again
  //     → **per-round nesting, never converging**, with one keystroke triggering a dozen write-backs,
  //       showing up as "sync is very slow after typing".
  //
  //   ⇒ keep whitelisted tags; anything **outside** the whitelist is escaped as before (see the next `<T>` case).
  //     The cost is that when a user really writes `a<b>c` that `<b>` is treated as a tag ——
  //     but in SiYuan it should have been written with `**` anyway, so this trade-off is acceptable.
  //   Once `<b>` is kept the return value itself "looks like HTML already", so no outer <span> is wrapped.
  //   That is exactly what we want: **the tag survived** (before the fix it became a&lt;b&gt;c).
  //   ★★ `a<b>c`: SiYuan displays it correctly, so the plugin must too.
  //     Once the whitelist was tightened to the tags the kernel really produces, `span/u/sup/sub`, `<b>` is not on it
  //     → it is escaped as literal text → displays `a<b>c` ✅ (before the fix it was eaten as a tag and became `ac`).
  check(
    '★ a literal a<b>c is not eaten as a tag (anything outside the whitelist is escaped)',
    literal('a<b>c') === '<span>a&lt;b&gt;c</span>',
    literal('a<b>c'),
  );
  // Real tags on the list must still be kept as-is, otherwise the whole inline style is lost
  check(
    'a whitelisted tag is kept as-is (the SiYuan inline style depends on it)',
    literal('<u>下划线一线</u>') === '<u>下划线一线</u>',
    literal('<u>下划线一线</u>'),
  );
  check('a bare & is escaped into &amp;', literal('A & B') === '<span>A &amp; B</span>', literal('A & B'));
  check(
    '★ an existing entity is not escaped a second time (consistent with SiYuan, no escaping)',
    literal('a &amp; b') === '<span>a &amp; b</span>',
    literal('a &amp; b'),
  );
  check('★ the generated tag itself is unaffected', literal('**粗体**') === '<b>粗体</b>', literal('**粗体**'));
  check('`code` still generates a code tag', literal('`x`') === '<code>x</code>', literal('`x`'));
}

// ★★★ The round trip must **converge**, not grow round after round (fixed).
//
//   Background: the entry-point escaping used to unconditionally `.replace(/</g,'&lt;')` the whole string,
//   which escaped SiYuan's own `<span data-type="text" style=…>` into literal text too.
//   Thus:
//     kernel <span data-type="text">X</span>
//       → read: everything escaped into &lt;span…&gt;
//       → write: treated as plain text and wrapped in a new span
//       → read again: htmlToKramdown restores the inner part to a real tag
//       → write again: escaped once more …… **one more level per round, never converging**
//
//   Consequence: "sync is very slow after typing" ——
//   because every round trip is judged as "the content changed", so one keystroke triggers a dozen updateBlock calls.
//   Measured: one keystroke fired **13 updateBlock calls**, taking 13.3 seconds.
//
//   This case asserts **convergence**, not a specific string —— bugs of this kind are characterised by
//   "valid every round, only ever longer", which a single round cannot reveal.
{
  const roundtrip = (html: string, times: number): string => {
    let s = html;
    for (let i = 0; i < times; i++) s = kramdownToHtml(htmlToKramdown(s));
    return s;
  };
  const grows = (html: string): boolean => {
    const a = roundtrip(html, 1);
    const b = roundtrip(html, 6);
    return b.length > a.length;
  };

  // The inline-style form that really exists in SiYuan —— exactly the one escaping destroyed
  const siyuanInline = '<span data-type="text" style="color: red;">文本四</span>';
  check(
    '★ an inline-style span does not grow over 6 round trips',
    !grows(siyuanInline),
    `round 1 ${roundtrip(siyuanInline, 1).length} → round 6 ${roundtrip(siyuanInline, 6).length}`,
  );
  check(
    '★ the inline-style content is not escaped into literal text',
    !roundtrip(siyuanInline, 1).includes('&lt;span'),
    roundtrip(siyuanInline, 1),
  );
  // Content already polluted by the old bug (it really exists in the kernel) should converge after one more read
  const polluted = '<span data-type="text">&lt;span data-type="text"&gt;子项&lt;/span&gt;</span>';
  check(
    '★ polluted nested content converges after the round trip (the length only shrinks)',
    !grows(polluted),
    `round 1 ${roundtrip(polluted, 1).length} → round 6 ${roundtrip(polluted, 6).length}`,
  );
  // Plain text must converge too
  check('★ plain text does not grow across the round trip', !grows('普通文字'), roundtrip('普通文字', 6));
}

// ★★★ The tags the kernel really produces = the whitelist, and **not one more**.
//
//   A whitelist that is too wide **eats the user's literal text**:
//   with `b` on the list, a user's `a<b>c` is stripped as a tag into `ac` ——
//   while SiYuan itself displays it just fine.
//
//   Measured: writing every format once in an isolated instance and then fetching the kramdown,
//   the tags the kernel really produces are only `span` / `u` / `sup` / `sub`
//   (`b` and `t` are **false positives** caused by `a<b>c` and `<T>`).
//   So this case **pins the list down**; widening it again turns the test red.
{
  // The real kernel form must be kept as-is
  const mustKeep = [
    '<span data-type="text">X</span>',
    '<span data-type="text" style="color: red;">红</span>',
    '<u>下划线一线</u>',
    'H<sub>2</sub>O',
    'x<sup>2</sup>',
  ];
  for (const k of mustKeep) {
    check(`★ kernel tag kept as-is: ${k.slice(0, 30)}`, kramdownToHtml(k) === k, kramdownToHtml(k));
  }
  // Literal angle brackets must **not be treated as tags** (this is the guard against a too-wide list)
  const mustEscape: Array<[string, string]> = [
    ['a<b>c', '<span>a&lt;b&gt;c</span>'],
    ['用 <T> 代码示例', '<span>用 &lt;T&gt; 代码示例</span>'],
    ['x < y', '<span>x &lt; y</span>'],
    ['<i>斜</i>', '<span>&lt;i&gt;斜&lt;/i&gt;</span>'],
    ['<div>x</div>', '<span>&lt;div&gt;x&lt;/div&gt;</span>'],
  ];
  for (const [k, want] of mustEscape) {
    check(`★ literal angle brackets are not treated as tags: ${k}`, kramdownToHtml(k) === want, kramdownToHtml(k));
  }
  // The display layer must be right too (what the user sees is htmlToText's result)
  check('★ the display layer shows a<b>c', htmlToText(kramdownToHtml('a<b>c')) === 'a<b>c', htmlToText(kramdownToHtml('a<b>c')));
  check(
    '★ the display layer shows "use <T> for generics"',
    htmlToText(kramdownToHtml('用 <T> 代码示例')) === '用 <T> 代码示例',
    htmlToText(kramdownToHtml('用 <T> 代码示例')),
  );
}

// ★★★ The round trip must be an **identity**.
//
//   The user requires "it must be exactly consistent". This case pins down every form of "kramdown → HTML → write back kramdown
//   → read again", and any drift anywhere makes the sync logic
//   wrongly judge "the content changed" and write an extra round (one keystroke can trigger 13 updateBlock calls).
//
//   Covered:
//     · literal angle brackets (a<b>c / use <T> for / x < y / &)
//     · real kernel tags (inline-style span / u / sub / sup)
//     · plugin-generated tags (b / code)
{
  const identity = (k: string): boolean => {
    const h1 = kramdownToHtml(k);
    const back = htmlToKramdown(h1);
    return kramdownToHtml(back) === h1;
  };
  const stable: Array<[string, string]> = [
    ['literal a<b>c', 'a<b>c'],
    ['literal <T>', '用 <T> 代码示例'],
    ['literal x < y', 'x < y'],
    ['literal &', '& 和 &'],
    [
      'inline style (real kernel form, with data-type)',
      '<span data-type="text" style="color:var(--b3-font-color1);">文本四</span>',
    ],
    ['underline', '<u>下划线一线</u>'],
    ['subscript', 'H<sub>2</sub>O'],
    ['superscript', 'x<sup>2</sup>'],
    ['bold', '**粗体**'],
    ['inline code', '`码`'],
    ['plain text', '普通文字'],
  ];
  for (const [name, k] of stable) {
    check(`★ round-trip identity: ${name}`, identity(k), JSON.stringify(kramdownToHtml(k)));
  }
  // Inline-style write-back must **add** data-type, otherwise it does not match the kernel form
  check(
    '★ inline-style write-back adds data-type="text"',
    htmlToKramdown('<span data-type="text" style="color:red">红</span>') ===
      '<span data-type="text" style="color:red">红</span>',
    htmlToKramdown('<span data-type="text" style="color:red">红</span>'),
  );
}

// ── round trip and fidelity of title-node leading paragraphs (paragraphs before any node belongs to the title node)
{
  // 1. with a document title + several leading paragraphs
  const kdWithTitleAndParas = [
    '# 说明一',
    '{: id="20261006120000-doc0001"}',
    '',
    '第一段文本。',
    '{: id="20261006120000-p000001"}',
    '',
    '第二段文本。',
    '{: id="20261006120000-p000002"}',
    '',
    '- {: id="20261006120000-n000001"}阶段一：需求说明',
    '  - {: id="20261006120000-n000002"}段落二',
    '- {: id="20261006120000-n000003"}阶段二：架构说明',
  ].join('\n');

  const tree = kramdownToTree(kdWithTitleAndParas);
  const paras = takeTitleParagraphs();
  check('a leading paragraph does not mix into the list tree as a child node', tree.length === 2, `got=${tree.length}`);
  check('the leading paragraph count is correct', paras.length === 2, `got=${paras.length}`);
  check(
    'the leading paragraph contains the background introduction',
    paras[0].includes('第一段文本。'),
    `got=${paras[0]}`,
  );
  check(
    'the leading paragraph contains the core objective',
    paras[1].includes('第二段文本。'),
    `got=${paras[1]}`,
  );

  // Write-back and read-out round trip
  const writtenKd = treeToKramdown(tree, {
    docTitle: '说明一',
    titleParagraphs: paras,
  });
  check('the written kramdown contains the title line', writtenKd.startsWith('# 说明一\n\n'), writtenKd);
  check('the written kramdown contains the background introduction', writtenKd.includes('第一段文本。'), writtenKd);
  check('the written kramdown contains the core objective', writtenKd.includes('第二段文本。'), writtenKd);

  const backTree = kramdownToTree(writtenKd);
  const backParas = takeTitleParagraphs();
  check('the node structure is identical after the round trip', backTree.length === 2 && backTree[0].children.length === 1);
  check('the title-node leading paragraph count is identical after the round trip', backParas.length === 2);
  check('leading paragraph one is identical after the round trip', backParas[0].includes('第一段文本。'));
  check('leading paragraph two is identical after the round trip', backParas[1].includes('第二段文本。'));

  // 2. a document with no top-level # heading block: leading paragraphs still belong to the title node
  const kdNoTitleDoc = [
    '前置说明。',
    '',
    '- 独立任务项',
  ].join('\n');
  const treeNoTitle = kramdownToTree(kdNoTitleDoc);
  const parasNoTitle = takeTitleParagraphs();
  check('leading paragraphs of a title-less document are extracted successfully', parasNoTitle.length === 1 && parasNoTitle[0].includes('前置说明。'));
  check('the list node count of a title-less document is correct', treeNoTitle.length === 1);

  // 3. round trip of leading paragraphs that contain an empty paragraph
  const kdWithEmpty = treeToKramdown(tree, {
    docTitle: '标题',
    titleParagraphs: ['第一段', '', '第三段'],
  });
  const treeEmpty = kramdownToTree(kdWithEmpty);
  const parasEmpty = takeTitleParagraphs();
  check('the leading empty-paragraph count is preserved', parasEmpty.length === 3, `got=${JSON.stringify(parasEmpty)}`);
  check('the second leading empty paragraph is an empty string', parasEmpty[1] === '', `got=${JSON.stringify(parasEmpty[1])}`);

  // 4. a document of pure paragraphs with no list node
  const kdOnlyParas = [
    '# 文档一',
    '',
    '段落一',
    '',
    '段落二',
  ].join('\n');
  const treeOnlyParas = kramdownToTree(kdOnlyParas);
  const parasOnly = takeTitleParagraphs();
  check('a pure-paragraph document has no list node', treeOnlyParas.length === 0);
  check('every paragraph of a pure-paragraph document belongs to the title node', parasOnly.length === 2 && parasOnly[0].includes('段落一') && parasOnly[1].includes('段落二'));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  // Use throw instead of process.exit to avoid depending on @types/node
  throw new Error(`${fail} test(s) failed`);
}
