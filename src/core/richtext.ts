/**
 * Rich text → visual runs (for SVG `<tspan>` rendering).
 *
 * ## Why this is needed
 *
 * The outline view puts node HTML straight into `dangerouslySetInnerHTML` inside `contentEditable`,
 * so colors / bold / italics **show up for free** there.
 *
 * But the mind map uses **SVG**: `<text>` is a plain-text element and **one element can have only one color**
 * (`fill` is an element-level property, not inherited from an inline `style="color:…"`).
 * The map used to strip HTML to plain text with `htmlToText()` and draw that —
 * so **all formatting information was lost unconditionally**, showing up as "red in SiYuan, still black in the map".
 *
 * ## Approach
 *
 * Parse the HTML into a list of runs, each carrying its own styles; render one `<tspan>` per run.
 * SVG allows a `<text>` to nest `<tspan>`, and each `tspan` can have its own `fill` /
 * `font-weight` / `font-style` / `text-decoration`.
 *
 * ★ This deliberately does **not** use `innerHTML` plus browser parsing (`DOMParser`),
 *   because the map's layout computation (`widthOf`) has to run in an environment **without a DOM**
 *   (unit tests / export), and only pure string processing can be shared by both sides.
 *
 * ★ Styles are **inherited**: in `<b><span style="color:red">X</span></b>`, X
 *   is both bold and red. So accumulate with a stack instead of looking only at the innermost tag.
 */

/** One visual run: a piece of text plus the styles it inherits. */
export interface RichRun {
  text: string;
  /** Text color (a CSS color string). undefined = use the theme's default color. */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  /** Superscript / subscript: faked in SVG by shrinking the font and shifting the baseline */
  sup?: boolean;
  sub?: boolean;
  /** Highlight: faked in SVG with a background block */
  mark?: boolean;
  /** Formula: displayed as `$…$`, not wrapped */
  formula?: boolean;
}

/** The style state being accumulated (the result of stacking). */
interface StyleState {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
  mark?: boolean;
}

/**
 * From `style="…"` take only **the properties we support and can map to SVG**.
 *
 * Deliberately nothing outside that set is parsed: anything unrecognised is ignored, so that
 * properties SVG cannot express today, such as `background-color`, are not mistaken for a text color.
 */
function parseStyleAttr(style: string): Partial<StyleState> {
  const out: Partial<StyleState> = {};
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!val) continue;
    if (prop === 'color') out.color = val;
    else if (prop === 'font-weight' && /^(bold|[6-9]00)$/i.test(val)) out.bold = true;
    else if (prop === 'font-style' && /^italic$/i.test(val)) out.italic = true;
    else if (prop === 'text-decoration') {
      if (/line-through/i.test(val)) out.strike = true;
      if (/underline/i.test(val)) out.underline = true;
    }
  }
  return out;
}

/** Semantic tags (`data-type` or native HTML tags) → style delta. */
function semanticDelta(tag: string, attrs: string): Partial<StyleState> {
  const out: Partial<StyleState> = {};
  const t = tag.toLowerCase();
  const dataType = (/\bdata-type="([^"]*)"/.exec(attrs)?.[1] || '').toLowerCase();

  const setBold = () => (out.bold = true);
  const setItalic = () => (out.italic = true);
  const setStrike = () => (out.strike = true);
  const setUnderline = () => (out.underline = true);
  const setCode = () => (out.code = true);
  const setSup = () => (out.sup = true);
  const setSub = () => (out.sub = true);
  const setMark = () => (out.mark = true);

  // Two passes: native tag names plus SiYuan's data-type. Both are accepted,
  // because SiYuan exports `<b>` and friends as `data-type="strong"`,
  // while the browser's execCommand produces native tags.
  for (const s of [t, dataType]) {
    if (s === 'strong' || s === 'b') setBold();
    else if (s === 'em' || s === 'i') setItalic();
    else if (s === 's' || s === 'del' || s === 'strike') setStrike();
    else if (s === 'u') setUnderline();
    else if (s === 'code') setCode();
    else if (s === 'sup') setSup();
    else if (s === 'sub') setSub();
    else if (s === 'mark') setMark();
  }
  // `<font color="…">`: a legacy artefact of `execCommand('foreColor')`.
  // Its argument is an **attribute**, not a style, so it is read separately.
  if (t === 'font') {
    const c = /\bcolor="([^"]*)"/i.exec(attrs)?.[1];
    if (c && c.trim()) out.color = c.trim();
  }
  const style = /\bstyle="([^"]*)"/.exec(attrs)?.[1];
  if (style) Object.assign(out, parseStyleAttr(style));
  return out;
}

/**
 * HTML → array of runs.
 *
 * Supported input shapes (covering what the SiYuan kernel and the browser's `execCommand` produce):
 *   - `<span data-type="text" style="color: var(--b3-font-colorN);">`
 *   - `<span data-type="strong|em|s|u|code" …>`
 *   - native `<b> <i> <s> <u> <code> <strong> <em> <del> <mark>`
 *   - `<font color="…">` (a legacy artefact of `execCommand('foreColor')`)
 *   - `<span data-formula="…">` → a `$…$` formula run
 *   - `<img alt="…">` → `[alt]`
 *   - `<br>` → a line break
 */
export function htmlToRuns(html: string): RichRun[] {
  if (!html) return [];
  const runs: RichRun[] = [];
  const stack: StyleState[] = [];
  let cur: StyleState = {};

  const pushText = (s: string) => {
    if (!s) return;
    // ★★★ HTML entities **must be decoded** (fix: a `<` `>` in a node showed up as `&lt;`).
    //
    //   Symptom (measured): a node saying "use <T> for generics" appeared in the map as
    //   "use &lt;T&gt; for generics" — the literal entity names, not angle brackets.
    //
    //   Why the **double escaping** happened: upstream `kramdownToHtml` turns a literal `<` into `&lt;`
    //   (that step is correct, otherwise tag stripping downstream would eat it).
    //   If `&lt;` were handed to React as-is here, React would escape it **once more** into `&amp;lt;`,
    //   and the screen would show `&lt;`.
    //
    //   ⇒ After tags are stripped, text runs must be **decoded back to literal characters** per the HTML rules before they reach React.
    //     The order must not be reversed: strip tags first, then decode entities —
    //     reversed, `&lt;script&gt;` would be decoded into a real tag and then stripped, losing the content again.
    const decoded = s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // `&amp;` goes last: decoding the others first keeps `&amp;lt;` from being decoded twice into `<`
      .replace(/&amp;/g, '&');
    if (!decoded) return;
    const last = runs[runs.length - 1];
    // Merge adjacent runs whose styles are exactly the same, to reduce the tspan count.
    // The criterion always goes through `sameStyle`, so copies cannot drift apart.
    if (last && sameStyle(last, { text: decoded, ...cur })) {
      last.text += decoded;
      return;
    }
    runs.push({ text: decoded, ...cur });
  };

  // Scan tag by tag; text runs are kept as-is
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html))) {
    pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2];
    const attrs = m[3] || '';
    const t = tag.toLowerCase();

    // Special handling for self-closing / empty elements
    if (t === 'br') {
      pushText('\n');
      continue;
    }
    if (t === 'img') {
      const alt = /\balt="([^"]*)"/.exec(attrs)?.[1] || '';
      pushText(alt ? `[${alt}]` : '[Image]');
      continue;
    }
    if (!closing && /\bdata-formula="/.test(attrs)) {
      const f = /\bdata-formula="([^"]*)"/.exec(attrs)?.[1] || '';
      runs.push({ text: `$${f}$`, formula: true, ...cur });
      // skip its closing tag
      const close = html.indexOf('</', tagRe.lastIndex);
      const gt = close >= 0 ? html.indexOf('>', close) : -1;
      if (gt >= 0) {
        tagRe.lastIndex = gt + 1;
        last = gt + 1;
      }
      continue;
    }

    if (closing) {
      cur = stack.pop() || {};
    } else {
      stack.push(cur);
      const delta = semanticDelta(tag, attrs);
      cur = { ...cur, ...delta };
    }
  }
  pushText(html.slice(last));

  // Strip zero-width characters (SiYuan uses them as placeholders) but keep real spaces
  for (const r of runs) r.text = r.text.replace(/\u200b/g, '');
  return runs.filter((r) => r.text !== '');
}

/** Array of runs → plain text (for the edit box / width estimation). */
export function runsToText(runs: RichRun[]): string {
  return runs.map((r) => r.text).join('');
}

/** Whether two runs have exactly the same styles (formulas count as non-mergeable). */
export function sameStyle(a: RichRun, b: RichRun): boolean {
  return (
    !a.formula &&
    a.color === b.color &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.strike === !!b.strike &&
    !!a.underline === !!b.underline &&
    !!a.code === !!b.code &&
    !!a.sup === !!b.sup &&
    !!a.sub === !!b.sub &&
    !!a.mark === !!b.mark
  );
}

/**
 * Merge adjacent runs with the same style.
 *
 * ★ Extracting this into a shared function is **deliberate**: the merge criterion must be defined in exactly one place.
 *   With two copies, adding a style bit would leave one of them unupdated,
 *   showing up as hard-to-find bugs like "some format bleeds the wrong color in the mind map".
 */
export function mergeRuns(runs: RichRun[]): RichRun[] {
  const out: RichRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

/** One rendered line: the runs that fit inside the wrap width, in order. */
export interface WrappedLine {
  runs: RichRun[];
  width: number;
}

/**
 * Width of one character —— supplied by the caller (`core/layout.ts` owns the estimator).
 *
 * The layout *sizes* a box with this and the renderer *draws* with it, so there is exactly one
 * authority: a second estimator here would let text overflow the box measured for it.
 */
export type CharWidth = (ch: string) => number;

/** CJK and full-width punctuation: breakable between any two characters, and twice as wide. */
const BREAK_ANYWHERE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** Split one run's text into units that may not be broken up further (a Latin word is one unit). */
function units(text: string, formula?: boolean): string[] {
  if (formula) return [text]; // `$…$` is drawn whole: half a formula is meaningless
  const out: string[] = [];
  let word = '';
  const flushWord = () => {
    if (word) {
      out.push(word);
      word = '';
    }
  };
  for (const ch of text) {
    if (ch === '\n') {
      flushWord();
      out.push('\n');
    } else if (BREAK_ANYWHERE.test(ch) || ch === ' ' || ch === '\t') {
      flushWord();
      out.push(ch);
    } else {
      word += ch;
    }
  }
  flushWord();
  return out;
}

/**
 * Break runs into lines that fit `maxWidth`, with no limit on the number of lines.
 *
 * Breaking rules:
 *   - CJK may break between any two characters; Latin breaks at whitespace;
 *   - a single word wider than the line is broken between characters —— overflowing the box is worse,
 *     and a mind-map node with a long URL or identifier has to be shown somehow;
 *   - an explicit newline always ends a line;
 *   - a `formula` run is never split.
 *
 * Always returns at least one line (an empty one for empty input), so callers can derive a height from
 * `lines.length` without special-casing the empty label.
 */
export function wrapRuns(runs: RichRun[], maxWidth: number, charWidth: CharWidth): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let current: RichRun[] = [];
  let width = 0;

  const measure = (s: string) => {
    let total = 0;
    for (const ch of s) total += charWidth(ch);
    return total;
  };

  const push = (run: RichRun, text: string) => {
    if (!text) return;
    const last = current[current.length - 1];
    if (last && sameStyle(last, run)) last.text += text;
    else current.push({ ...run, text });
    width += measure(text);
  };

  const flush = () => {
    // A line never ends in whitespace: the space that triggered the break belongs to neither line.
    const last = current[current.length - 1];
    if (last && !last.code && !last.formula) last.text = last.text.replace(/[ \t]+$/, '');
    lines.push({ runs: current.filter((r) => r.text), width });
    current = [];
    width = 0;
  };

  for (const run of runs) {
    for (const unit of units(run.text, run.formula)) {
      if (unit === '\n') {
        if (current.length) flush();
        continue;
      }
      const unitWidth = measure(unit);
      if (width > 0 && width + unitWidth > maxWidth) {
        const blank = unit === ' ' || unit === '\t';
        flush();
        if (blank) continue; // the break consumed it
      }
      if (unitWidth > maxWidth && !run.formula) {
        // A single unit wider than the line: fill what fits, then carry the rest to the next line.
        let chunk = '';
        let chunkWidth = 0;
        for (const ch of unit) {
          const chWidth = charWidth(ch);
          if (chunkWidth > 0 && chunkWidth + chWidth > maxWidth) {
            push(run, chunk);
            flush();
            chunk = '';
            chunkWidth = 0;
          }
          chunk += ch;
          chunkWidth += chWidth;
        }
        push(run, chunk);
        continue;
      }
      push(run, unit);
    }
  }
  flush();
  return lines.length ? lines : [{ runs: [], width: 0 }];
}
