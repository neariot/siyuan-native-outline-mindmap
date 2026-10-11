// Tests for the shared HTML escape/decode module.
//
// These exist because the code they replace was five site-local copies across three files, two of which
// disagreed with the others about a detail nobody had written down: the order `&amp;` is decoded in.
import { escapeHtml, escapeAttr, unescapeHtml } from './html-escape';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    return;
  }
  fail++;
  failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
}

// ---- escapeHtml: HTML content --------------------------------------------------------------------
check('escapeHtml: & < >', escapeHtml('<b>a & b</b>') === '&lt;b&gt;a &amp; b&lt;/b&gt;');
check('escapeHtml: does NOT touch quotes (content context)', escapeHtml('say "hi"') === 'say "hi"');
check('escapeHtml: leaves ordinary text alone', escapeHtml('plain') === 'plain');
check('escapeHtml: empty string', escapeHtml('') === '');

// ---- escapeAttr: quoted attribute values ---------------------------------------------------------
check('escapeAttr: escapes the double quote', escapeAttr('a "b" c') === 'a &quot;b&quot; c');
check('escapeAttr: & < and the quote', escapeAttr('<x> & "y"') === '&lt;x> &amp; &quot;y&quot;');
// ★ `>` is deliberately left alone: it is legal unescaped inside a quoted attribute value, and this is
//   the behaviour the inline chain it replaced had. Pinned so a future "tidy-up" that adds `>` is a
//   visible decision rather than a silent change to every exported attribute.
check('★ escapeAttr: leaves > alone (legal inside a quoted value)', escapeAttr('a > b') === 'a > b');
check('escapeAttr: a single quote needs no escape inside a double-quoted attribute',
  escapeAttr("it's") === "it's");

// ★ The two are NOT interchangeable, and having both is the point.
check('★ escapeHtml and escapeAttr differ on the quote character',
  escapeHtml('"') !== escapeAttr('"'));

// ---- unescapeHtml, and the order that matters ----------------------------------------------------
check('unescapeHtml: the five entities',
  unescapeHtml('&lt;a&gt; &quot;q&quot; &#39;s&#39; &amp; b') === '<a> "q" \'s\' & b');
check('unescapeHtml: &nbsp; becomes a space', unescapeHtml('a&nbsp;b') === 'a b');
check('unescapeHtml: empty string', unescapeHtml('') === '');

// ★★ THE REGRESSION. A user's text containing the literal characters `&nbsp;` arrives from the kernel
//    escaped as `&amp;nbsp;`. Decoding `&amp;` before `&nbsp;` turns those six characters into one space
//    —— measured: a node reading `type &nbsp; to make a space` displayed as `type   to make a space`.
//    Decoding `&amp;` LAST is what keeps the user's text intact.
const LITERALS: Array<[string, string, string]> = [
  // [what the user typed, what the kernel stores, the entity name]
  ['&nbsp;', '&amp;nbsp;', 'nbsp'],
  ['&quot;', '&amp;quot;', 'quot'],
  ['&lt;', '&amp;lt;', 'lt'],
  ['&amp;', '&amp;amp;', 'amp'],
  ['&#39;', '&amp;#39;', '#39'],
];
for (const [typed, fromKernel, name] of LITERALS) {
  const got = unescapeHtml(fromKernel);
  check(`★★ literal &${name}; typed by the user survives as itself, not as the entity it names`,
    got === typed, `kernel=${JSON.stringify(fromKernel)} want=${JSON.stringify(typed)} got=${JSON.stringify(got)}`);
}

// Round trip: escaping then decoding returns the original, for text that has no entities to begin with.
for (const s of ['plain text', 'a < b > c', 'x & y', '']) {
  check(`round trip: ${JSON.stringify(s)}`, unescapeHtml(escapeHtml(s)) === s);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
