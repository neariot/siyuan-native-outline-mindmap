// **Offline** verification of mind-map `<tspan>` rendering (no browser / no SiYuan needed).
//
// Background: mind-map nodes are drawn inside SVG `<text>`, where `fill` is an element-level property —
// one `<text>` can have only one color. Multiple colors require `<tspan>`.
// The map used to strip HTML to plain text with `htmlToText` and draw that, so every format was silently lost.
//
// ★ Why `renderToStaticMarkup` instead of opening a browser and driving CDP:
//   the rendering logic is purely functional (runs → tspan), so SSR already yields the **complete output**,
//   it finishes in 2 seconds, with no port / no race / no 30-second page load.
//   Only things like "does the CSS take effect" or "does ResizeObserver fire" need a real browser.
//
// Run: see scripts/run-tests.sh

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from '../mindmap/RichText';
import { htmlToRuns } from '../core/richtext';
import { LINE_HEIGHT, wrapForWidth } from '../core/layout';

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

/**
 * Render an HTML snippet and return the static `<tspan>` markup.
 *
 * The lines are produced by the layout's own wrapper (`wrapForWidth`, the same estimator `measureNode`
 * sizes boxes with), so these cases exercise the real path rather than a test-only wrapping.
 */
function render(html: string, fallback = '#000', maxWidth = 10000): string {
  return renderToStaticMarkup(
    React.createElement(RichText, {
      lines: wrapForWidth(htmlToRuns(html), maxWidth),
      fallbackFill: fallback,
      x: 0,
      lineHeight: LINE_HEIGHT,
    }),
  );
}

// ---- basics: the color must land on the tspan fill ----
// Original bug: red in SiYuan, still black in the mind map
{
  const out = render('<span data-type="text" style="color: var(--b3-font-color8);">段落一</span>');
  check('color → tspan fill', out.includes('fill="var(--b3-font-color8)"'), out);
  check('colored node keeps its text', out.includes('段落一'), out);
  // Key point: there must not be only a single plain-text node (that would mean falling back to one color)
  check('colored node is not bare text', out.includes('<tspan'), out);
}

// ---- multi-color: two colors in one node must be **two** tspans ----
{
  const out = render('<span style="color:red">红</span>中<span style="color:blue">蓝</span>');
  check('multi-color → several tspans', (out.match(/<tspan/g) || []).length === 3, out);
  check('multi-color red', out.includes('fill="red">红<'), out);
  check('multi-color blue', out.includes('fill="blue">蓝<'), out);
  // the middle run has no color → use the fallback
  check('middle run uses the fallback', out.includes('fill="#000">中<'), out);
}

// ---- bold / italic → font-weight / font-style ----
{
  const out = render('<b>粗</b>');
  check('bold → font-weight', out.includes('font-weight="bold"'), out);
}
{
  const out = render('<i>斜</i>');
  check('italic → font-style', out.includes('font-style="italic"'), out);
}
// bold + color must both take effect (inheritance stack)
{
  const out = render('<b><span style="color:red">粗体文本四</span></b>');
  check('bold + color together', out.includes('font-weight="bold"') && out.includes('fill="red"'), out);
}

// ---- strikethrough / underline → text-decoration ----
{
  const out = render('<s>删</s>');
  check('strikethrough → text-decoration', out.includes('text-decoration="line-through"'), out);
}
{
  const out = render('<u>划</u>');
  check('underline → text-decoration', out.includes('text-decoration="underline"'), out);
}
{
  const out = render('<span data-type="s" style="text-decoration:underline">都有</span>');
  check('strikethrough + underline coexist',
    out.includes('line-through') && out.includes('underline'), out);
}

// ---- inline code → monospace font ----
{
  const out = render('<code>x</code>');
  check('inline code → monospace', out.includes('monospace'), out);
}

// ---- theme variables are passed through **verbatim**; the plugin hardcodes no color values ----
//
// Measured conclusion from UI-TC-27: `--b3-font-color8` is defined by the **SiYuan theme**
// (measured `#d23f31` → the browser resolves it to `rgb(210, 63, 49)`).
// The plugin only moves the variable name onto `fill`; it must **not** substitute a concrete color —
// otherwise after the user switches themes (dark / eye-care) the colors in the map no longer match the body text.
{
  for (const v of ['var(--b3-font-color1)', 'var(--b3-font-color8)', 'var(--b3-font-background3)']) {
    const out = render(`<span style="color: ${v}">x</span>`);
    check(`★ theme variable passed through verbatim: ${v}`, out.includes(`fill="${v}"`), out);
  }
}

// ---- `<font color>` (execCommand output) must be colored too ----
{
  const out = render('<font color="#dc2a2a">文本四</font>');
  check('font color → fill', out.includes('fill="#dc2a2a"'), out);
}

// ---- wrapping: labels break into as many lines as they need, and nothing is dropped ----
// (This replaced a character-count truncation with an ellipsis: a label that does not fit used to be
//  cut, so a reader could not see the node's text at all.)
{
  // 4 CJK characters at the layout's 15px each = 60px per line, so ten of them need three lines
  const out = render('第一节点第二节点第三节点', '#000', 60);
  const shown = [...out.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  check('a long label is broken into several lines', shown.length >= 3, out);
  check('wrapping loses no character', shown.join('') === '第一节点第二节点第三节点', out);
  check(
    'each line after the first repeats the anchor x (otherwise SVG continues inline)',
    (out.match(/x="0"/g) ?? []).length === shown.length - 1,
    out,
  );
}
{
  // A run crossing a line break must keep its style on every line it appears on
  const out = render('<span style="color:red">第一到第八</span>', '#000', 30);
  check('a run crossing a line break keeps its color', (out.match(/fill="red"/g) ?? []).length >= 2, out);
}
{
  // A single word wider than the line has to be broken: overflowing the box is worse
  const out = render('supercalifragilisticexpialidocious', '#000', 40);
  const shown = [...out.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  check('an over-wide word is broken rather than overflowing', shown.length >= 2, out);
  check('breaking a word loses no character', shown.join('') === 'supercalifragilisticexpialidocious', out);
}
// ---- a newline ends a line (SVG `<text>` cannot wrap by itself) ----
{
  const out = render('上<br>下');
  check('a newline starts a new line', out.includes('x="0"') && !out.includes('上 下'), out);
}
// ---- a short label: one line, unchanged geometry ----
{
  const out = render('短', '#000', 1000);
  check('a short label stays on one line', !out.includes('x="0"') && out.includes('>短<'), out);
}

// ---- empty content must not crash ----
{
  const out = render('');
  check('empty content renders as empty', out === '', JSON.stringify(out));
}

console.log(`${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} failures`);
}
