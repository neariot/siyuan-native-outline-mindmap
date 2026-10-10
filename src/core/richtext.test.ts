// Rich-text run parsing tests (the basis of mind-map `<tspan>` rendering).
//
// Background: mind-map nodes are drawn inside SVG `<text>`, and `fill` on `<text>` is an **element-level** property,
// so one element can have only one color. The map used to strip HTML to plain text with `htmlToText` and draw that,
// so colors/bold/italics were all lost (the outline view was fine because it goes through contentEditable).
//
// The fix is to parse the HTML into styled runs, one `<tspan>` per run.
// These tests keep the parser covering every output shape of the SiYuan kernel and of the browser's execCommand.

import { htmlToRuns, runsToText } from './richtext';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

/** Flatten runs into a readable string for assertions */
function sig(html: string): string {
  return htmlToRuns(html)
    .map((r) => {
      const flags = [
        r.color ? `[${r.color}]` : '',
        r.bold ? '[B]' : '',
        r.italic ? '[I]' : '',
        r.strike ? '[S]' : '',
        r.underline ? '[U]' : '',
        r.code ? '[C]' : '',
        r.sup ? '[SUP]' : '',
        r.sub ? '[SUB]' : '',
        r.mark ? '[MK]' : '',
        r.formula ? '[F]' : '',
      ].join('');
      return `"${r.text}"${flags}`;
    })
    .join(' + ');
}

// ---- plain text ----
check('plain text', sig('普通文字') === '"普通文字"', sig('普通文字'));
check('empty string', htmlToRuns('').length === 0);

// ---- SiYuan native inline styles ----
check('SiYuan color',
  sig('<span data-type="text" style="color: var(--b3-font-color8);">段落一</span>')
    === '"段落一"[var(--b3-font-color8)]',
  sig('<span data-type="text" style="color: var(--b3-font-color8);">段落一</span>'));

// ---- semantic tags ----
check('semantic strong', sig('<span data-type="strong">粗</span>') === '"粗"[B]');
check('semantic em', sig('<span data-type="em">斜</span>') === '"斜"[I]');
check('semantic s', sig('<span data-type="s">删</span>') === '"删"[S]');
check('native b', sig('<b>粗</b>') === '"粗"[B]');
check('native i', sig('<i>斜</i>') === '"斜"[I]');
check('native del', sig('<del>删</del>') === '"删"[S]');
check('native u', sig('<u>下划线一</u>') === '"下划线一"[U]');
check('native code', sig('<code>c</code>') === '"c"[C]');

// ---- style inheritance (nested) ----
// In `<b><span style="color:red">X</span></b>`, X is **both bold and red**
check('inheritance: bold wrapping color',
  sig('<b><span style="color:red">粗体文本四</span></b>') === '"粗体文本四"[red][B]',
  sig('<b><span style="color:red">粗体文本四</span></b>'));
check('inheritance: color wrapping bold',
  sig('<span style="color:red"><b>粗体文本四</b></span>') === '"粗体文本四"[red][B]',
  sig('<span style="color:red"><b>粗体文本四</b></span>'));
check('inheritance: three levels',
  sig('<b><i><span style="color:blue">x</span></i></b>') === '"x"[blue][B][I]',
  sig('<b><i><span style="color:blue">x</span></i></b>'));

// ---- multi-color runs ----
{
  const s = sig('<span style="color:red">红</span>中<span style="color:blue">蓝</span>');
  check('multi-color gives three runs', s === '"红"[red] + "中" + "蓝"[blue]', s);
}

// ---- font color (execCommand output) ----
check('font: hex', sig('<font color="#dc2a2a">红</font>') === '"红"[#dc2a2a]',
  sig('<font color="#dc2a2a">红</font>'));
check('font: uppercase', sig('<FONT COLOR="#dc2a2a">红</FONT>') === '"红"[#dc2a2a]');
check('font: no color', sig('<font>无</font>') === '"无"');
check('font: wrapping bold', sig('<font color="red"><b>粗体文本四</b></font>') === '"粗体文本四"[red][B]');

// ---- other properties inside style ----
check('style:font-weight bold', sig('<span style="font-weight:bold">粗</span>') === '"粗"[B]');
check('style:font-weight 700', sig('<span style="font-weight:700">粗</span>') === '"粗"[B]');
check('style:font-style italic', sig('<span style="font-style:italic">斜</span>') === '"斜"[I]');
check('style:text-decoration line-through',
  sig('<span style="text-decoration:line-through">删</span>') === '"删"[S]');
check('style:text-decoration underline',
  sig('<span style="text-decoration:underline">划</span>') === '"划"[U]');
// multiple declarations share one style attribute
check('style: multiple declarations',
  sig('<span style="color: red; font-weight: bold;">粗体文本四</span>') === '"粗体文本四"[red][B]',
  sig('<span style="color: red; font-weight: bold;">粗体文本四</span>'));
// unsupported properties must be ignored and must **not** be taken as a color
check('style: background is ignored',
  sig('<span style="background-color: yellow">高亮文本</span>') === '"高亮文本"',
  sig('<span style="background-color: yellow">高亮文本</span>'));

// ---- merge adjacent runs with the same style to reduce the tspan count ----
{
  const runs = htmlToRuns('<span style="color:red">节点</span><span style="color:red">六</span>');
  check('adjacent runs with the same style are merged', runs.length === 1 && runs[0].text === '节点六',
    `len=${runs.length} text=${runs[0]?.text}`);
}

// ---- formula / image ----
check('formula', sig('<span data-formula="E=mc^2">$E=mc^2$</span>') === '"$E=mc^2$"[F]',
  sig('<span data-formula="E=mc^2">$E=mc^2$</span>'));
check('image alt', sig('<img alt="图" src="x.png">') === '"[图]"');
check('image without alt', sig('<img src="x.png">') === '"[Image]"');

// ---- line breaks ----
// `<br>` becomes a real newline character (RichText turns it into a space when rendering, see Mindmap.tsx)
{
  const runs = htmlToRuns('上<br>下');
  check('br becomes a newline', runs.length === 1 && runs[0].text === '上\n下',
    JSON.stringify(runs.map((r) => r.text)));
}

// ---- zero-width character cleanup (SiYuan uses \u200b as a placeholder) ----
check('zero-width characters are stripped', sig('节点\u200b六') === '"节点六"', sig('节点\u200b六'));

// ---- runsToText matches the content ----
{
  const html = '<b>粗体</b><span style="color:red">文本五</span>文本六';
  check('runsToText concatenation', runsToText(htmlToRuns(html)) === '粗体文本五文本六',
    runsToText(htmlToRuns(html)));
}

// ---- superscript / subscript / highlight ----
// SVG has no native counterpart for these; RichText fakes them by shrinking the font, shifting the baseline, or adding a background.
// But they must **be recognised**, and must not silently degrade to plain text as before.
check('superscript sup', sig('<sup>2</sup>').includes('[SUP]'), sig('<sup>2</sup>'));
check('subscript sub', sig('<sub>i</sub>').includes('[SUB]'), sig('<sub>i</sub>'));
check('highlight mark', sig('<mark>高</mark>').includes('[MK]'), sig('<mark>高</mark>'));
check('SiYuan data-type=sup', sig('<span data-type="sup">2</span>').includes('[SUP]'),
  sig('<span data-type="sup">2</span>'));
check('SiYuan data-type=sub', sig('<span data-type="sub">i</span>').includes('[SUB]'),
  sig('<span data-type="sub">i</span>'));
check('SiYuan data-type=mark', sig('<span data-type="mark">高</span>').includes('[MK]'),
  sig('<span data-type="mark">高</span>'));
// ★ regression: superscript/highlight are newly added style bits; if they are forgotten in the `sameStyle` check,
//   adjacent plain text gets merged in by mistake, so the superscript shrinks the preceding body text too.
{
  const runs = htmlToRuns('普通<sup>2</sup>');
  check('superscript is not merged with the preceding run', runs.length === 2, `len=${runs.length}`);
  check('preceding run has no sup', !runs[0].sup, JSON.stringify(runs[0]));
}

// ---- real-world case: the complete paragraph shape SiYuan exports ----
{
  const real = '<span data-type="text" style="color: var(--b3-font-color8);">段落一</span>';
  check('real SiYuan shape', runsToText(htmlToRuns(real)) === '段落一',
    runsToText(htmlToRuns(real)));
}

// ── entities must decode back to literal characters (fixed regression)
//
// The upstream kramdownToHtml turns a literal `<` into `&lt;` (correct, otherwise tag stripping would eat it).
// If it were handed to React as-is, React would escape it **a second time** → the screen would show `&lt;`.
{
  const plain = (html: string): string => htmlToRuns(html).map((r) => r.text).join('');
  check('&lt; decodes back to <', plain('用 &lt;T&gt; 代码示例') === '用 <T> 代码示例', plain('用 &lt;T&gt; 代码示例'));
  check('&amp; decodes back to &', plain('A &amp; B') === 'A & B', plain('A &amp; B'));
  check('&quot; decodes back to a quote', plain('引用 &quot;文本五&quot;') === '引用 "文本五"', plain('引用 &quot;文本五&quot;'));
  check('&nbsp; decodes back to a space', plain('a&nbsp;b') === 'a b', plain('a&nbsp;b'));
  check('★ tags are still stripped, not treated as text', plain('<b>粗</b>体') === '粗体', plain('<b>粗</b>体'));
  check('★ tags are stripped before entities are decoded: &lt;b&gt; is not stripped as a tag', plain('&lt;b&gt;') === '<b>', plain('&lt;b&gt;'));
}

console.log(`${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} failures`);
}
