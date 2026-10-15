// Node tree ⇄ SiYuan Kramdown mapping (pure logic, no React / no network)
//
// Design basis (measured, see PLAN-siyuan-plugin.md §2.5):
//   one node = one listItem + one paragraph inside it (a pair of blocks in SiYuan)
//   node hierarchy = nested lists (Kramdown uses 2-space indentation)
//   node text = the paragraph's Kramdown (this file handles HTML fragment ⇄ Kramdown)
//
// Inline markup mapping table (measured fidelity):
//   <b>              → **text**            ✅
//   <i>              → *text*              ✅
//   <s>              → ~~text~~            ✅
//   <code>           → `text`              ✅
//   <u>              → <u>text</u>         ⚠️ SiYuan preserves inline HTML
//   <span style=color>     → {: style="color:...;"}  ⚠️ custom convention
//   <span data-formula>    → $latex$       ✅
//   <span data-tag>        → #name         ✅
//   <a href>               → [text](href)  ✅
//   <span data-noderef>    → ((id 'text')) ⚠️ requires a block ID
//   <img data-img>         → ![alt](assets/...) ⚠️ requires asset management

import { flatNodes } from '../model/tree';
import type { CodeBlockData, OutlineNode, TableData } from '../model/types';

/** SiYuan block ID format: 14-digit timestamp + '-' + 7 lowercase alphanumerics */
export const SIYUAN_ID_RE = /^\d{14}-[0-9a-z]{7}$/;

/** Generate a SiYuan-style block ID (from the given timestamp; the current time when none is passed) */
export function makeSiyuanId(now?: number): string {
  const d = new Date(now ?? Date.now());
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const AB = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 7; i++) rand += AB[Math.floor(Math.random() * AB.length)];
  return `${ts}-${rand}`;
}

// ---------------------------------------------------------------- attribute encode/decode
//
// How SiYuan handles block attribute values (measured):
//   1. newlines are turned into the literal `_esc_newline_` (not \n, and not &#10;)
//   2. `{` `}` are re-encoded as `&#123;` `&#125;`
//   3. `<` `>` `&` `"` are encoded as `&lt;` `&gt;` `&amp;` `&quot;`
// Therefore: on write a value only has to be flattened to "one line + escaped quotes/braces",
// and on read it must handle all three forms: `&#10;`, `_esc_newline_` and a bare newline.

/** The literal marker SiYuan uses for a newline inside an attribute value */
const ESC_NEWLINE = '_esc_newline_';

/** Escape a value going into `{: key="value" }` (newlines/quotes/braces would break the line structure) */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ESC_NEWLINE)
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** Unescape an attribute value: tolerates SiYuan's several encoding forms */
function unescapeAttr(s: string): string {
  return s
    .split(ESC_NEWLINE)
    .join('\n') // SiYuan's literal newline marker
    .replace(/&#10;/g, '\n') // the form we ourselves may have written
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // &amp; must be handled last, otherwise &amp;lt; gets decoded twice
    .replace(/&amp;/g, '&');
}

/** Extract a named attribute value from one `{: k="v" k2="v2" }` line */
function readAttr(src: string, key: string): string | null {
  const m = new RegExp(`${key}="([^"]*)"`).exec(src);
  return m ? unescapeAttr(m[1]) : null;
}

// ---------------------------------------------------------------- HTML → Kramdown

/** Unescape HTML entities (&lt; etc.), because Kramdown needs the raw characters */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Turn a node's HTML fragment into SiYuan Kramdown inline text.
 *
 * Strategy: scan piecewise with regexes (no HTML parser, keeping core/ dependency-free).
 * Unrecognised tags are stripped and only their text is kept, so the SiYuan document is not polluted.
 */
export function htmlToKramdown(html: string): string {
  if (!html) return '';
  let s = html;

  // 0) First protect the "tags that must be kept as-is" with placeholders (e.g. <u>, <span style>),
  //    otherwise the final "strip all tags" fallback would delete them by mistake.
  const preserved: string[] = [];
  const stash = (frag: string): string => {
    preserved.push(frag);
    return `\u0000${preserved.length - 1}\u0000`;
  };

  // ★ Native rich-text markup: these have **no** markdown shorthand in SiYuan, so the HTML has to be kept as-is.
  //   (measured: after <u>/<sup>/<sub> are written into SiYuan, the kernel still exports tags of the same name.)
  //   They must be stashed here, otherwise the final "strip all tags" fallback eats them.
  s = s.replace(/<u>([\s\S]*?)<\/u>/g, (_m, t: string) => stash(`<u>${t}</u>`));
  s = s.replace(/<sup>([\s\S]*?)<\/sup>/g, (_m, t: string) => stash(`<sup>${t}</sup>`));
  s = s.replace(/<sub>([\s\S]*?)<\/sub>/g, (_m, t: string) => stash(`<sub>${t}</sub>`));
  // Highlight: SiYuan's native shorthand is `==text==` (corresponding to <span data-type="mark">)
  s = s.replace(
    /<span[^>]*data-type="mark"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, t: string) => `==${unescapeHtml(t)}==`,
  );
  // The `<mark>` SiYuan itself exports is normalised to `==` too
  s = s.replace(/<mark>([\s\S]*?)<\/mark>/g, (_m, t: string) => `==${unescapeHtml(t)}==`);

  // ★ Inline styles (color/background/font size/font family): SiYuan's native form is
  //   `<span data-type="text" style="…">text</span>`.
  //
  //   Two input forms are **both accepted** here:
  //     · with `data-type="text"` (the real shape of SiYuan's DOM)
  //     · a bare `<span style="…">` (as written by earlier versions / external imports)
  //   otherwise a bare span falls all the way through to the "strip tags" fallback and **the whole color is lost** (hit in practice).
  //
  //   Note: on export SiYuan also appends `{: style="…"}` after the text (an inline IAL attribute),
  //   which is the kernel's own format: it is not needed on write and is stripped in 2.5) on read.
  s = s.replace(
    /<span[^>]*\bstyle="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, style: string, t: string) => {
      const clean = style.trim();
      // ★ On write back, **keep the input's original form**.
      //
      //   The kernel preserves both forms as-is (measured):
      //     writing `<span data-type="text" style="…">red</span>` → comes back with data-type
      //     writing `<span style="…">bare</span>`              → comes back as a bare span
      //
      //   So "adding data-type" is wrong: that **rewrites** a bare span into the other form,
      //   which breaks the read→write→read identity. The correct rule is **keep it if present, do not add it if absent**.
      const hasDataType = /\bdata-type=/.test(_m);
      return clean
        ? stash(
            hasDataType
              ? `<span data-type="text" style="${clean}">${t}</span>`
              : `<span style="${clean}">${t}</span>`,
          )
        : t;
    },
  );

  // 1) Handle the "semantic structured spans" first; they are the most specific, so they match first
  //
  // ★ Images must be handled **first**, using the `data-img` path as src.
  // Hit in practice: without this step, `<img data-img="assets/x.png">` fell all the way to the final
  // "strip tags" fallback, keeping only the alt, and became `![test.png]()` when written back to SiYuan
  // — the file had actually uploaded successfully, but the reference was emptied, so the image did not show in SiYuan.
  s = s.replace(
    /<img[^>]*\bdata-img="([^"]*)"[^>]*>/g,
    (_m, path: string) => {
      if (!path || path.startsWith('imgid://')) return '';
      return `![image](${unescapeHtml(path)})`;
    },
  );
  // An img without data-img (an external image): convert from src directly, keeping a clickable link
  s = s.replace(
    /<img[^>]*\bsrc="([^"]*)"[^>]*>/g,
    (_m, src: string) => {
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) return '';
      return `![image](${unescapeHtml(src)})`;
    },
  );
  s = s.replace(
    /<span[^>]*data-formula="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, latex: string) => `$${unescapeHtml(latex)}$`,
  );
  s = s.replace(
    /<span[^>]*data-tag="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, name: string) => `#${unescapeHtml(name)}`,
  );
  // ★ Write back with **double quotes**, matching how the SiYuan kernel writes it itself (see the kramdownToHtml comment above).
  //   Single quotes were used before — SiYuan can still parse them, but every round trip flipped `"` and `'` back and forth,
  //   which showed up in the SiYuan editor as "the reference format changed by itself".
  s = s.replace(
    /<span[^>]*data-noderef="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, target: string, text: string) => `((${unescapeHtml(target)} "${unescapeHtml(text)}"))`,
  );

  // 2) color / background / font size / font family → SiYuan native inline styles
  //
  // ★  Rewritten: the original implementation **recognised hex colors only** (`#rrggbb`), whereas SiYuan's official
  //   colors use **CSS variables** (`var(--b3-font-colorN)` / `var(--b3-font-backgroundN)`,
  //   see INLINE_FONT_COLORS in app/src/protyle/toolbar/inlineStyle.ts).
  //   As a result, rich text using the official theme colors **had its color dropped entirely** on read.
  //   Now each "property name → value" is recognised individually, and the color form is no longer restricted.
  s = s.replace(
    /<span[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, style: string, text: string) => {
      // Allowed values: var(--b3-*), #hex, color keywords, font-size/font-family, etc.
      const keep: string[] = [];
      const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(';' + style);
      const bg = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(';' + style);
      const size = /(?:^|;)\s*font-size:\s*([^;]+)/.exec(';' + style);
      const family = /(?:^|;)\s*font-family:\s*([^;]+)/.exec(';' + style);
      if (color) keep.push(`color:${color[1].trim()};`);
      if (bg) keep.push(`background-color:${bg[1].trim()};`);
      if (size) keep.push(`font-size:${size[1].trim()};`);
      if (family) keep.push(`font-family:${family[1].trim()};`);
      const inner = unescapeHtml(text);
      if (!keep.length) return inner;
      // ★ Write it in SiYuan's native form: `data-type="text"` + style,
      //   so that the kernel recognises it as an "inline style" and renders it live.
      return `<span data-type="text" style="${keep.join('')}">${inner}</span>`;
    },
  );

  // 2.5) Drop the inline IAL suffix `{: style="…"}` that SiYuan attaches on export.
  //
  //   For inline styles SiYuan exports a double form: "HTML span + trailing IAL":
  //     `<span data-type="text" style="…">red</span>{: style="…"}after`
  //   That `{: }` is the kernel's own redundant notation and **is not part of the text content**.
  //   Left in place, it stays in the node text as literal characters and pollutes the content.
  s = s.replace(/\{:\s*style="[^"]*"\}/g, '');
  s = s.replace(/\{:\s*style='[^']*'\}/g, '');

  // 3) basic inline markup
  s = s.replace(/<b>([\s\S]*?)<\/b>/g, (_m, t: string) => `**${unescapeHtml(t)}**`);
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/g, (_m, t: string) => `**${unescapeHtml(t)}**`);
  s = s.replace(/<i>([\s\S]*?)<\/i>/g, (m, t: string) => {
    const u = unescapeHtml(t);
    // Avoid "**" being eaten: handle italic with a single *
    return `${u.startsWith('*') || u.endsWith('*') ? '_' : '*'}${u}${u.startsWith('*') || u.endsWith('*') ? '_' : '*'}`;
  });
  s = s.replace(/<em>([\s\S]*?)<\/em>/g, (_m, t: string) => `*${unescapeHtml(t)}*`);
  s = s.replace(/<s>([\s\S]*?)<\/s>/g, (_m, t: string) => `~~${unescapeHtml(t)}~~`);
  s = s.replace(/<del>([\s\S]*?)<\/del>/g, (_m, t: string) => `~~${unescapeHtml(t)}~~`);
  // ★ `<strike>` is what Blink actually emits (measured in a real browser for
  //   `document.execCommand('strikeThrough')`), and it is not in the `KNOWN_TAG` whitelist
  //   below either —— so it used to survive as literal `<strike>` text instead of a mark.
  s = s.replace(/<strike>([\s\S]*?)<\/strike>/g, (_m, t: string) => `~~${unescapeHtml(t)}~~`);
  s = s.replace(/<code>([\s\S]*?)<\/code>/g, (_m, t: string) => `\`${unescapeHtml(t)}\``);

  // 4) links
  s = s.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (_m, href: string, text: string) => `[${unescapeHtml(text)}](${unescapeHtml(href)})`,
  );

  // 5) image fallback: an <img> still unhandled here has neither data-img nor
  //    a usable src (step 1 covers both of those cases).
  //
  //    ★ This used to produce `![alt]()` — an **empty link**, which is a broken image in SiYuan.
  //    Measured: `<img alt="pic" />` produced `![pic]()`. Now they are all dropped,
  //    keeping only the alt text as visible content, and never producing an unopenable link.
  s = s.replace(
    /<img[^>]*alt="([^"]*)"[^>]*>/g,
    (_m, alt: string) => unescapeHtml(alt),
  );
  s = s.replace(/<img[^>]*>/g, '');

  // 6) fallback: strip all remaining tags and keep the text
  //
  // ★  Fix: the original implementation was `s.replace(/<[^>]+>/g, '')` — deleting tags **outright**,
  //   so a tag carrying line-break semantics **glued** the text on both sides into one run:
  //     `a<br>b`        → `"ab"`   ❌ (two words merged into one)
  //     `a<br>b<br>c`   → `"abc"`  ❌
  //     `<p>a</p><p>b</p>` → `"ab"` ❌
  //   This is **silent data corruption**: the user sees `ab`, and the fact that `a`/`b` were on separate lines is lost forever.
  //
  //   Fix: first turn `<br>` and paragraph/block tag boundaries into newline characters, then delete the remaining tags.
  //   A newline is a legal inline break inside a SiYuan paragraph block, so the user's intent to break lines is preserved faithfully.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\n');
  // ★★★ Delete **only tags on the whitelist**; `<…>` outside it stays as literal text.
  //
  //   The old code used `/<[^>]+>/g` indiscriminately — so angle brackets the user really wrote **vanished into thin air**:
  //     `using <T> for generics` → `using   for generics`
  //     `a<b>c`          → `ac`
  //   while SiYuan itself **stores and displays them as-is** (measured: getBlockKramdown returns
  //   `using <T> for generics`, `a<b>c`, `x < y`, `& and &`).
  //   Our own fallback was eating them.
  //
  //   ★ The whitelist must cover **every tag the upstream can produce** (see the stash rules above).
  //     Missing one means "a real tag is displayed as literal text" —
  //     more visible than losing characters, but still a bug; when changing this list, cross-check it with the stash list.
  //   ★ Keep this list **in sync with** `kramdownToHtml`'s KEEP_TAG:
  //     what gets stripped here are "the real tags the upstream produces", and the kernel was measured to produce only
  //     `span` / `u` / `sup` / `sub` (plus `b`/`code`/`br`/`mark`/`a`/`img` generated by this function itself).
  //     Any `<x>` outside the list stays as **literal text** — that is what the user actually wrote.
  const KNOWN_TAG =
    /<\/?(?:span|b|i|u|s|sup|sub|mark|code|kbd|br|p|div|font|a|img|strong|em|del|ins|ruby|rt|table|thead|tbody|tr|td|th)\b[^<>]*>/gi;
  s = s.replace(KNOWN_TAG, '');
  // Collapse 3+ consecutive blank lines into 2 (paragraph tags produce a trailing extra newline)
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  // Leading/trailing blank lines are meaningless (a SiYuan paragraph block already implies its boundaries)
  s = s.replace(/^\n+|\n+$/g, '');
  s = unescapeHtml(s);

  // 7) restore the protected tags (<u>, <sup>, <sub>, inline-style spans, etc.)
  //
  // ★  Fix: the original implementation unescaped only `<u>`; the other stashed tags
  //   (`<sup>`/`<sub>`/`<span style>`) were **returned with their text still escaped**,
  //   leaving entities such as `&lt;` behind in the node text.
  //   Now the rule is uniform: "keep the tag structure, unescape only the text inside the tags".
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
    const frag = preserved[Number(i)] ?? '';
    // Unescape the text content of the most common protected tags, one by one
    return frag
      .replace(/(<u>)([\s\S]*?)(<\/u>)/g, (_x, o: string, t: string, c: string) => `${o}${unescapeHtml(t)}${c}`)
      .replace(/(<sup>)([\s\S]*?)(<\/sup>)/g, (_x, o: string, t: string, c: string) => `${o}${unescapeHtml(t)}${c}`)
      .replace(/(<sub>)([\s\S]*?)(<\/sub>)/g, (_x, o: string, t: string, c: string) => `${o}${unescapeHtml(t)}${c}`)
      .replace(
        /(<span style="[^"]*">)([\s\S]*?)(<\/span>)/g,
        (_x, o: string, t: string, c: string) => `${o}${unescapeHtml(t)}${c}`,
      );
  });

  // 8) Strip the inline IAL suffix `{: style="…"}` that SiYuan attaches on export.
  //
  //   ★ This must happen **after** step 7: that suffix directly follows the stashed `</span>`,
  //     and before step 7 `</span>` is still the placeholder `\u0000N\u0000`,
  //     so a regex for "span end + IAL" does not match and the suffix is missed (hit in practice).
  //
  //   SiYuan exports inline styles in a double form:
  //     `<span data-type="text" style="…">red</span>{: style="…"}after`
  //   `{: }` is the kernel's own redundant notation and **is not part of the text content**;
  //   left in place it stays in the node text as literal characters and pollutes the content.
  s = s.replace(/\{:\s*style="[^"]*"\}/g, '');
  s = s.replace(/\{:\s*style='[^']*'\}/g, '');

  return s;
}

// ---------------------------------------------------------------- HTML → SiYuan DOM

/**
 * The kramdown a document holds → **the same inline DOM** `htmlToSiyuanDom` produces for a
 * node's text.
 *
 * ★★ It exists for one caller, and the reason is a measured defect.
 *
 *   `store.ts` decides "does this block need rewriting?" before it calls `updateBlockDom`.
 *   It used to compare a serialised node text against `blocks.content`, and **`blocks.content`
 *   is plain text** — every markup variant of a paragraph reads back as the same stripped
 *   string. So removing a strikethrough left both sides equal, `updateBlockDom` was never
 *   called, and the mark came back on the next reload while the outline showed it removed.
 *   Measured on the outline: the UI showed plain text and the document still held
 *   `<span data-type="text" style="font-weight: bold;">`.
 *
 *   Both sides are therefore reduced to the form the write actually sends, so "unchanged"
 *   means "the same bytes would be written" rather than "the same characters".
 *   The round trip through the reader is what makes that a fixed point: reading `**X**` back
 *   gives `<b>X</b>`, which serialises to the same span as a bold `<span style=…>`.
 */
export function markdownToInlineDom(markdown: string): string {
  return htmlToSiyuanDom(kramdownToHtml(markdown));
}

/**
 * Split a `style` attribute into the SiYuan **marks** it stands for and the style that is
 * left over.
 *
 * Why a split at all: the outline toolbar runs with `styleWithCSS` on, so bold / italic /
 * underline / strike arrive as CSS declarations rather than as `<b>` / `<i>` / `<u>` / `<s>`.
 * Passing them through unchanged stores them as an inline style, which the kernel renders
 * but SiYuan itself would never write (measured: `<span data-type="text"
 * style="font-weight: bold;">` stays that way instead of becoming `**X**`).
 *
 * A declaration that is only a mark is removed from the style; everything else — colour,
 * background, size, family — stays, and the caller puts `text` back into `data-type` when
 * something is left, because the kernel needs mark and style merged on one tag.
 */
const CSS_MARKS: Array<[RegExp, string]> = [
  [/^font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i, 'strong'],
  [/^font-style\s*:\s*(?:italic|oblique)\b/i, 'em'],
  [/^text-decoration(?:-line|-style)?\s*:.*\bunderline\b/i, 'u'],
  [/^text-decoration(?:-line|-style)?\s*:.*\bline-through\b/i, 's'],
];

function splitStyleMarks(raw: string): { marks: string[]; style: string } {
  const decls = raw.split(';').map((d) => d.trim()).filter(Boolean);
  const marks: string[] = [];
  const rest: string[] = [];
  for (const d of decls) {
    const hit = CSS_MARKS.find(([re]) => re.test(d));
    if (hit) {
      if (!marks.includes(hit[1])) marks.push(hit[1]);
    } else {
      rest.push(d);
    }
  }
  // Nothing was a mark: hand the attribute back **untouched**, so a plain colour span keeps
  // byte-for-byte the form the user (or the kernel) wrote. Rebuilding it here would quietly
  // reformat every style in the document on the next save.
  if (!marks.length) return { marks, style: raw };
  if (!rest.length) return { marks, style: '' };
  // Keep a trailing `;` when the input had one: the declaration list is rebuilt, but not
  // reformatted — `style="color: #dc2a2a;"` must not come back as `style="color: #dc2a2a"`.
  const tail = /;\s*$/.test(raw) ? ';' : '';
  return { marks, style: rest.join('; ') + tail };
}

/**
 * A node's HTML fragment → **SiYuan native inline DOM** (for writing).
 *
 * ★★★ Why this function is needed (measured conclusion):
 *
 * SiYuan represents inline styles in two ways:
 *   1. **DOM form** (what the editor really renders internally): `<span data-type="text" style="…">red</span>`
 *   2. **Kramdown form** (export/storage): `<span data-type="text" style="…">red</span>{: style="…"}`
 *
 * But `createDocWithMd` / `updateBlock(dataType:"markdown")` go through the **markdown parsing path**,
 * which **does not understand inline HTML/IAL** — the color is **escaped as literal text** and the user sees the source itself:
 *   measured: `<span style="color:red">red</span>` is displayed in the editor as `&lt;span style=...&gt;red`
 *
 * Going through `dataType:"dom"` has **zero conversion loss**: whatever SiYuan supports is stored, and colors render normally.
 *
 * So the write path is now uniform: internal fragment → this function → the SiYuan DOM.
 *
 * Mapping (internal format → SiYuan data-type):
 *   `<b>`/`<strong>` → `<span data-type="strong">`
 *   `<i>`/`<em>`     → `<span data-type="em">`
 *   `<s>`/`<del>`    → `<span data-type="s">`
 *   `<code>`         → `<span data-type="code">`
 *   `<u>`            → `<span data-type="u">`
 *   `<sup>`/`<sub>`  → `<span data-type="sup">` / `"sub"`
 *   `<mark>`         → `<span data-type="mark">`
 *   `<span style>`   → `<span data-type="text" style="…">`
 *   `<a href>`       → kept as-is (SiYuan understands a standard `<a>`)
 *
 * Any other unrecognised tags are stripped, but **their text is kept** (better to lose styling than content).
 */
export function htmlToSiyuanDom(fragment: string): string {
  if (!fragment) return '';
  let s = fragment;

  // 0) ★★★ The semantic spans this plugin's own **reader** produces.
  //
  //   Without a rule each of them reached the kernel as an ordinary span and the attribute
  //   was dropped (measured against the running kernel):
  //     `<span data-noderef="id">T</span>`  → `<span data-type="text">T</span>`   ← the reference is destroyed
  //     `<span data-formula="E=mc^2">…</span>` → `<span data-type="text">$E=mc^2$</span>`
  //     `<span data-tag="proj">#proj</span>`  → `<span data-type="text">#proj</span>`
  //   `htmlToKramdown` has always handled these, so the two writers disagreed and whichever
  //   one the save happened to use decided whether the markup survived. The forms below are
  //   the ones `parse/inline_html.go SetTextMarkNode` actually reads — `data-href`, `data-id`,
  //   `data-content` — and a tag, which SiYuan has **no** inline mark for, is plain text.
  s = s.replace(
    /<span[^>]*\bdata-formula="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, latex: string) =>
      `<span data-type="inline-math" data-subtype="math" data-content="${escapeAttr(latex)}">${latex ? `$${latex}$` : ''}</span>`,
  );
  s = s.replace(
    /<span[^>]*\bdata-noderef="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, id: string, text: string) => `<span data-type="block-ref" data-id="${escapeAttr(id)}">${text}</span>`,
  );
  // A mention has no inline mark in SiYuan at all, so the text is what can be kept.
  s = s.replace(/<span[^>]*\bdata-mention="[^"]*"[^>]*>([\s\S]*?)<\/span>/g, (_m, text: string) => text);
  s = s.replace(
    /<span[^>]*\bdata-tag="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, name: string) => `#${name}`,
  );

  // 0.1) ★★★ An inline image is a **span**, not a bare `<img>` (measured).
  //
  //   Written as `<img …>` the kernel answers `<protyle-html>`; written as
  //   `<span data-type="img"><span><img src data-src alt></span></span>` it comes back as
  //   `![alt](path)`. `data-img` is this plugin's carrier for the asset path, so that is what
  //   both attributes are filled from.
  s = s.replace(
    /<img[^>]*\b(?:data-img|src)="([^"]*)"[^>]*>/g,
    (_m, path: string, offset: number, whole: string) => {
      if (!path || path.startsWith('imgid://')) return '';
      const alt = /\balt="([^"]*)"/.exec(whole)?.[1] ?? '';
      return (
        `<span data-type="img"><span> </span><span>` +
        `<img src="${escapeAttr(path)}" data-src="${escapeAttr(path)}" alt="${escapeAttr(alt)}"/>` +
        `</span></span>`
      );
    },
  );

  // 0.2) ★★★ A link is `<span data-type="a" data-href>`, not `<a href>` (measured).
  //
  //   `<a href="…">` — what the toolbar inserts and the reader produces — is stored by the
  //   kernel as `<protyle-html>`. lute reads the address from `data-href` on a span carrying
  //   `a` (`util.GetTextMarkAData`).
  s = s.replace(/<a([^>]*)>([\s\S]*?)<\/a>/g, (_m, attrs: string, text: string) => {
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const title = /\btitle="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!href) return text;
    return (
      `<span data-type="a" data-href="${escapeAttr(href)}"` +
      (title ? ` data-title="${escapeAttr(title)}"` : '') +
      `>${text}</span>`
    );
  });

  // 1) inline-style span: split the CSS declarations into SiYuan marks and a real style.
  //
  //    The outline sets `styleWithCSS=true`, so Blink puts **CSS** in the node instead of a
  //    semantic tag — measured in the live outline:
  //      bold     → `<span style="font-weight: bold;">`
  //      italic   → `<span style="font-style: italic;">`
  //      underline→ `<span style="text-decoration-line: underline;">`
  //      strike   → `<span style="text-decoration-line: line-through;">`
  //    and the same arrives from any word processor. Handed through unchanged they are stored
  //    as `<span data-type="text" style=…>`, i.e. the document never gets `**bold**` /
  //    `*italic*` / `<u>` / `~~strike~~` and SiYuan's own toolbar does not recognise them.
  //
  //    ★ Mark and style must end up on **one** tag: nesting loses one of the two (measured
  //    against the kernel, see the round-trip table below).
  s = s.replace(/<span([^>]*?)\bstyle="([^"]*)"([^>]*?)>/g, (m, pre: string, style: string, post: string) => {
    // Already carries a SiYuan mark: this function must not reinterpret it.
    if (/\bdata-type=/.test(pre + post)) return m;
    const { marks, style: rest } = splitStyleMarks(style);
    if (!marks.length) return `<span data-type="text"${pre}style="${style}"${post}>`;
    // Mark and style on **one** tag: nesting loses one of them (measured, see the table above).
    const attr = rest ? `${pre}style="${rest}"${post}` : '';
    return `<span data-type="${marks.join(' ')}"${attr}>`;
  });

  // 2) `<font color="…">` → a span with style.
  //
  //   ★ Origin: the toolbar's color picker goes through `document.execCommand('foreColor', …)`,
  //   and Blink / WebKit **produce `<font color>` by default** inside contenteditable
  //   (not a span). `<font>` was missing from the mapping table, so it fell straight into the fallback strip —
  //   with the result that **the font color the user set was silently discarded when writing back to SiYuan**.
  //
  //   Measured (before the fix): `<font color="#dc2a2a">red text</font>` → `red text`, the color was gone.
  //
  //   It must come **before** the fallback strip. The color value is passed through as-is (SiYuan
  //   accepts `#rrggbb` / color names / `rgb(…)`).
  s = s.replace(
    /<font\s+color="([^"]*)"\s*>([\s\S]*?)<\/font>/gi,
    (_m, color: string, text: string) =>
      `<span data-type="text" style="color: ${color.trim()};">${text}</span>`,
  );
  // A `<font>` without color: strip only the tag, keep the text
  s = s.replace(/<\/?font[^>]*>/gi, '');

  // 3) semantic tags → SiYuan data-type
  //
  // ★ `strike` is in the list because that is what Blink produces: measured in a real
  //   browser, `document.execCommand('strikeThrough')` yields `<strike>`, not `<s>`. It used
  //   to fall through to the fallback strip below, which deleted the tags and kept the text —
  //   the mark vanished on the way to SiYuan, with no error.
  // ★ The attributes are carried across: `kramdownToHtml` folds a trailing IAL into
  //   `<b style="color: …">`, and a bold coloured word has to keep both.
  const SEMANTIC: Array<[RegExp, string]> = [
    [/<(\/?)(?:b|strong)\b([^<>]*)>/g, 'strong'],
    [/<(\/?)(?:i|em)\b([^<>]*)>/g, 'em'],
    [/<(\/?)(?:s|del|strike)\b([^<>]*)>/g, 's'],
    [/<(\/?)code\b([^<>]*)>/g, 'code'],
    [/<(\/?)u\b([^<>]*)>/g, 'u'],
    [/<(\/?)sup\b([^<>]*)>/g, 'sup'],
    [/<(\/?)sub\b([^<>]*)>/g, 'sub'],
    [/<(\/?)mark\b([^<>]*)>/g, 'mark'],
  ];
  for (const [re, type] of SEMANTIC) {
    s = s.replace(re, (_m, slash: string, attrs: string) =>
      slash ? '</span>' : `<span data-type="${type}"${attrs}>`,
    );
  }

  // 4) ★★★ **Merge the styles into the semantic tag** (a hard requirement of SiYuan).
  //
  //   Measured (against the real kernel) **round-trip results** for three nesting forms:
  //
  //   | form                                                             | kernel kramdown              | result |
  //   |------------------------------------------------------------------|----------------------------|------|
  //   | `<span data-type="text" style="…"><span data-type="strong">X`   | `<span style=…>X</span>{:…}` | ❌ bold lost |
  //   | `<span data-type="strong"><span data-type="text" style="…">X`   | `**X**`                     | ❌ color lost |
  //   | `<span data-type="strong" style="…">X</span>`                   | `**X**{: style="…"}`        | ✅ both kept |
  //
  //   In other words: **style and semantic must be merged onto the same tag**; parent/child nesting loses on both sides.
  //   Lifting the style to the outer tag silently loses the bold; keeping it inner silently loses the color.
  //
  //   Approach: rewrite both "semantic wrapping style" and "style wrapping semantic" into the merged form.
  const mergeInto = (semType: string, attrs: string, text: string): string => {
    // attrs looks like ` style="color:red"`
    return `<span data-type="${semType}"${attrs}>${text}</span>`;
  };
  // semantic outside, semantic inside (any pair of mark types)
  //
  // ★★ The type list may hold **several** types: lute reads `data-type` as a
  //    space-separated set (`data-type="code strong"` is measured to keep both), and a
  //    nested pair loses one of them — `<span data-type="code"><span data-type="strong">X`
  //    comes back as `` `X` ``, the bold gone. So two marks are merged onto one tag here
  //    rather than left nested.
  s = s.replace(
    /<span data-type="([a-z ]+)">\s*<span data-type="([a-z ]+)"([^>]*)>([\s\S]*?)<\/span>\s*<\/span>/g,
    (_m, outer: string, inner: string, attrs: string, text: string) =>
      // An inner `text` is only the carrier for a style, not a mark of its own: the outer
      // mark already describes the run. Folding it in as well would make every styled span
      // read `data-type="strong text"` where SiYuan writes `data-type="strong"`.
      mergeInto(inner.trim() === 'text' ? outer : `${outer} ${inner}`, attrs, text),
  );
  // style outside, semantic inside
  s = s.replace(
    /<span data-type="text"([^>]*)>\s*<span data-type="([a-z]+)">([\s\S]*?)<\/span>\s*<\/span>/g,
    (_m, attrs: string, semType: string, text: string) => mergeInto(semType, attrs, text),
  );

  // 5) fallback: strip tags still unrecognised (ones SiYuan does not understand), keeping the text
  s = s.replace(/<(?!\/?span\b|\/?a\b|\/?img\b|\/?br\b)[^>]+>/g, '');

  // 6) ★★★ Strip **empty spans**: wrappers like `<span></span>` / `<span>\u200b</span>`
  //    that hold no content are **escaped wholesale into literals** by the kernel and land in the database as:
  //
  //        <div contenteditable="true">&lt;protyle-html&gt;&lt;protyle-html&gt;</div>
  //
  //    Measured: three lines created by pressing Enter on an empty node are displayed in SiYuan as
  //    the literal text `<protyle-html><protyle-html>`, instead of blank lines.
  //
  //    Origin: "empty" in a node's data structure is `<span></span>` (`addSiblingNode`
  //    and similar use it to represent an empty node), while `store.ts` writes back with
  //    `htmlToSiyuanDom(html) || '\u200b'` — but **`'<span></span>'` is truthy**,
  //    so the `||` fallback never fires and the empty span reaches the kernel unchanged.
  //
  //    Collapsing it to an empty string here lets the caller's `|| '\u200b'` fallback actually take effect.
  //    (A zero-width space \u200b also counts as empty: it is an internal placeholder, not user-visible content.)
  s = s.replace(/<span(?:\s[^>]*)?>\s*(?:\u200b)?\s*<\/span>/g, '');

  // 7) ★★★ `<br>` and `<p>` must become line breaks and **must never be passed through as-is**.
  //
  //    SiYuan's inline DOM does not understand a bare `<br>` / `<p>`: they are **escaped wholesale** into literals,
  //    landing in the database as `&lt;protyle-html&gt;`, and that garbled string is what the user sees in the document.
  //
  //    Measured (the defect "a <protyle-html> residue appears in the document"):
  //    the browser **automatically fills in** a `<p><br></p>` placeholder for an empty contenteditable block,
  //    so the node's innerHTML becomes:
  //
  //        <span></span><p><br></p><p><br></p>
  //
  //    through `htmlToSiyuanDom` it becomes `<br><br>` → escaped by the kernel → and the document ends up with
  //    `<protyle-html>`. Every extra write added another layer, ending up as
  //    `<protyle-html><protyle-html></protyle-html></protyle-html>`.
  //
  //    Handling: strip the shell off block-level placeholder tags (p/div) directly, and convert `<br>` uniformly into
  //    a **zero-width space** (\u200b) — SiYuan uses it for "an empty line that has content", which fits paragraph semantics
  //    better than a real newline and is not lost in kramdown round trips.
  //    It must come **before** the final fallback tag strip so that it wins over the generic rules.
  s = s.replace(/<\/?(?:p|div)\b[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\u200b');

  return s;
}

// ---------------------------------------------------------------- tables
//
// ★ A SiYuan table is a **block of its own**, not inline content.
//
// Measured: the kernel stores a table with `parent_id` = the document, never inside a
// `NodeList`; writing `<table>` into a paragraph's inline DOM is stored as `<protyle-html>`,
// and `insertBlock` with a `NodeTable` **DOM** answers `code: 0` while creating nothing.
// The only route that works is the **markdown** form, which is what these two functions speak.
//
// The kernel's own export (measured) is:
//
//     |h1|h2|
//     | ----| ----|
//     |a|b|
//     {: id="…xm58ged" updated="…" colgroup="|"}
//
// so: consecutive `|`-lines, the **second** of which is the separator, and the block id on the
// attribute line that follows them.

/** One `|a|b|` line → its cells, with the leading/trailing pipe and padding removed. */
function tableRowCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return [];
  return trimmed.split('|').map((c) => c.trim());
}

/** Is this line the `| ---| --- |` separator between a table's header and its body? */
function isTableSeparator(line: string): boolean {
  const cells = tableRowCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * A run of `|`-lines → a table, or `null` when the run is not one.
 *
 * ★ A run must be **at least two lines with a separator second**: a single line starting with `|`
 *   is ordinary text that happens to begin with a pipe, and treating it as a table would delete
 *   the user's words.
 */
export function parseTableLines(lines: string[]): TableData | null {
  if (lines.length < 2 || !isTableSeparator(lines[1])) return null;
  const header = tableRowCells(lines[0]);
  if (header.length === 0) return null;
  const width = header.length;
  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    const cells = tableRowCells(line);
    // Pad or trim to the header's width, so a ragged export cannot produce a ragged table.
    while (cells.length < width) cells.push('');
    rows.push(cells.slice(0, width));
  }
  return { header, rows };
}

/**
 * A code block → the markdown the kernel accepts.
 *
 * ★ Sources **verbatim**, never escaped, trimmed or re-indented. Two things decide the shape:
 *
 *   • the fence must be at least as long as the longest backtick run in the code, or a sample that
 *     contains a fence of its own would close the block early and spill the rest as prose —
 *     which is markup corruption of something the user stored as-is;
 *   • the info string goes immediately after the fence with no space, which is the form the kernel
 *     round-trips (` ```js `), and `''` for a plain fence.
 *
 * A trailing newline is always emitted: without it the closing fence would be glued to the last
 * line of code.
 */
export function codeBlockToKramdown(c: CodeBlockData): string {
  const code = c.code ?? '';
  // The longest run of backticks in the body, so the opening fence always outruns it.
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = code.endsWith('\n') || code === '' ? code : `${code}\n`;
  return `${fence}${c.lang ?? ''}\n${body}${fence}`;
}

/** A table → the markdown the kernel accepts (the separator is always emitted). */
export function tableToKramdown(t: TableData): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (cells: string[]): string => `|${cells.map(esc).join('|')}|`;
  const sep = `|${t.header.map(() => ' ---').join('|')}|`;
  return [line(t.header), sep, ...t.rows.map(line)].join('\n');
}

// ---------------------------------------------------------------- Kramdown → HTML

/**
 * Turn SiYuan Kramdown inline text back into a node's HTML fragment.
 * The inverse of htmlToKramdown (markup in the mapping table must round-trip equal).
 */
export function kramdownToHtml(kd: string): string {
  if (!kd) return '';
  // ★★★ Escape literal text at the entry point (fix: a `<` `>` in a node was being eaten).
  //
  //   Symptom (measured): a node saying "using <T> for generics"
  //     showed up in both the outline panel and the map as "using for generics" — the `<T>` was gone;
  //     `a<b>c` simply became `ac`. SiYuan's own editor displayed them correctly,
  //     so the user noticed the plugin dropping characters immediately.
  //
  //   Root cause: this function **never escaped** its input, so literal text went into the HTML as-is.
  //     Then downstream, `.replace(/<[^>]+>/g, '')` inside `htmlToText()`
  //     stripped `<T>` as if it were a tag — losing content.
  //
  //   ★ Why it has to be done at the **entry point** instead of as an exit fallback:
  //     at the exit there is no way to tell "a `<b>` we generated" from "a `<T>` the user wrote" —
  //     they look exactly alike. Shielding/restoring at the exit was tried,
  //     and `<T>` was restored as if it were generated, losing it just the same.
  //     Only at the entry point, before any tag has been produced, can they be told apart.
  //
  //   `&` is escaped only when it does **not** start an entity, so an existing `&amp;` does not become `&amp;amp;`.
  // ★★★ No escaping at all — consistent with the SiYuan kernel.
  //
  //   There used to be an "entry escaping" block here (`<`→`&lt;` etc.); the reasoning was written in earlier comments:
  //   "a `<T>` written by the user is stripped as a tag by `htmlToText`'s `.replace(/<[^>]+>/g,'')`".
  //
  //   Measurement disproved that premise (asking the kernel directly in an isolated instance):
  //   ```
  //   Typing these into a SiYuan document → the kernel's getBlockKramdown returns them as-is:
  //     a<b>c        → "a<b>c"
  //     x < y        → "x < y"
  //     using <T>      → "using <T>"
  //     & and &        → "& and &"        ← not even & is escaped
  //   ```
  //   **SiYuan does not escape, so neither should we.**
  //
  //   The cost of that escaping (a severe measured bug; users reported "syncing is very slow after typing"):
  //   it escaped SiYuan's **own** `<span data-type="text" style=…>` as well,
  //   so every "read→write" round added another layer, **never converging**:
  //     kernel <span data-type="text">X</span>
  //       → everything escaped into &lt;span…&gt; → written as plain text into a new span
  //       → on the next read htmlToKramdown restores the inner part to a real tag → escape again ……
  //   Measured: a single keypress triggered **13 updateBlock calls**, taking 13.3 seconds.
  //
  //   Without the escaping: what is read is exactly what the kernel gave, and it is written back unchanged — **convergent by nature**.
  //   ★ But **escaping cannot be dropped entirely** either — literal angle brackets still need handling (a second correction).
  //
  //   The kernel's two forms as measured (`getBlockDOM` vs `getBlockKramdown`):
  //   ```
  //   user types a<b>c   kramdown: a<b>c        DOM: a&lt;b&gt;c   ← literal, escaped in the DOM
  //   user types **bold** kramdown: **bold**       DOM: <strong>    ← real bold goes through markdown
  //   ```
  //   SiYuan's convention is: **inside kramdown an HTML tag is a real tag, and literal angle brackets are written as-is**;
  //   at the kramdown level the two **look identical**, and only the DOM tells them apart.
  //
  //   ⇒ On read, escape every `<` that does **not** start a whitelisted tag:
  //       `a<b>c`  → `a&lt;b&gt;c`   (then displayed literally, which is correct)
  //       `<span data-type="text" …>` → kept as-is (a real tag, which is correct)
  //     The **direction** is the opposite of the first fix: that one escaped "everything" (real tags included → the nesting bug),
  //     whereas this one "escapes only what is outside the whitelist".
  //   ★ The list holds **only the tags the kernel really produces** (measured):
  //     after writing every format once in an isolated instance and tallying the kramdown,
  //     only `u` / `sub` / `sup` / `span` appeared
  //     (`b` and `t` were **false positives** caused by `a<b>c` and `<T>`, not real tags).
  //   The narrower the list the better: add one `b` and `a<b>c` gets eaten as a tag.
  //
  // ★★★ The kept tags stay **stashed until the very end** of this function.
  //
  //   They used to be restored right here, before the text rules below ran. Every one of
  //   those rules is written against **text**, not markup —— and one of them is `#name`:
  //     `style="color: #dc2a2a;"` → `style="color: <span data-tag="dc2a2a;">…`
  //   i.e. a hex colour inside an attribute was rewritten into a tag, the node's text became
  //   that garbage, and the next save wrote it back: **the user's colour was destroyed, and
  //   `htmlToKramdown` does not repair it**. Measured:
  //     in   `<span data-type="text" style="color: #dc2a2a;">甲</span>{: style="color: #dc2a2a;"}`
  //     out  `<span data-type="text" style="color: <span data-tag="dc2a2a;">甲</span>{:">#dc2a2a;">…`
  //   Restoring last removes the whole class: no text rule can reach inside a tag again.
  const KEEP_TAG = /<\/?(?:span|u|sup|sub)\b[^<>]*>/gi;
  const keep: string[] = [];
  let s = kd.replace(KEEP_TAG, (m) => {
    keep.push(m);
    return `\u0002${keep.length - 1}\u0002`;
  });
  s = s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // formula (handled first so $ is not escaped)
  s = s.replace(/\$([^$]+)\$/g, (_m, latex: string) => `<span data-formula="${latex}">$${latex}$</span>`);
  // block references
  //
  // ★★★ Both **single and double quotes** must be accepted (measured fix).
  //
  //   The kramdown the SiYuan kernel itself produces uses **double quotes**:
  //     see ((<anchor-id> "target document"))
  //   But this code used to match single quotes only, `'([^']*)'` —
  //   so **every reference coming from SiYuan failed to match** and degraded to a line of plain text in the UI.
  //
  //   Measured: `((id 'text'))` → converted to <span data-noderef>; ✅
  //         `((id "text"))` → **no match**, still plain text. ❌
  //
  //   ⇒ Both quote styles are accepted. This also covers titles containing the other kind of quote.
  s = s.replace(
    /\(\(([^)\s]+)\s+(?:"([^"]*)"|'([^']*)')\)\)/g,
    (_m, id: string, dq: string, sq: string) =>
      `<span data-noderef="${id}">${dq !== undefined ? dq : sq}</span>`,
  );
  // image
  //
  // ★★ The asset path goes in `data-img`, **not** in `src` (measured).
  //
  //   `data-img` is this plugin's own carrier for "a path inside SiYuan's assets" — it is
  //   what `hydrateEditable` resolves into a real URL, and what `htmlToSiyuanDom` reads to
  //   rebuild the kernel's inline-image span. Emitting `src` instead produced a third shape
  //   for the same thing: the writer never saw `data-img`, so the image was not hydrated on
  //   load and was rewritten as a bare `<img src>` the kernel answers with `<protyle-html>`.
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string, src: string) => `<img data-img="${src}" alt="${alt}" />`);
  // link
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, text: string, href: string) => `<a href="${href}">${text}</a>`);
  // inline styles (color/highlight)
  s = s.replace(/<span style="([^"]*)">([\s\S]*?)<\/span>/g, (_m, style: string, text: string) => {
    return `<span style="${style}">${text}</span>`;
  });
  // emphasis
  //
  // ★★ `==…==` is SiYuan's own shorthand for a highlight (`<span data-type="mark">`, measured:
  //   writing the span comes back as `==X==`). The writer maps `<mark>` to that span, so the
  //   reader has to understand the shorthand too — without this rule a highlighted word came
  //   back as the literal characters `==X==` on every reload.
  s = s.replace(/==([\s\S]*?)==/g, '<mark>$1</mark>');
  s = s.replace(/~~([\s\S]*?)~~/g, '<s>$1</s>');
  s = s.replace(/\*\*([\s\S]*?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  s = s.replace(/`([^`]*)`/g, '<code>$1</code>');
  s = s.replace(/<u>([\s\S]*?)<\/u>/g, '<u>$1</u>');

  // ★★★ Fold a trailing inline IAL into the element it belongs to, **before** dropping it.
  //
  //   SiYuan exports "mark + style" as the mark's markdown followed by an IAL
  //   (measured: writing `<span data-type="strong" style="color: #dc2a2a;">X</span>` comes back
  //   as `**X**{: style="color: #dc2a2a;"}`). Deleting the IAL as "a suffix that is not part
  //   of the text" — which is what the rule below does — threw the **colour** away with it, so
  //   a bold coloured word came back plain on every reload.
  //
  //   A `<span>` that already carries a `style` is left alone: its style already survived the
  //   round trip, and adding a second `style=` attribute would produce invalid markup.
  s = s.replace(
    /(<(span|b|strong|i|em|u|s|del|code|mark|sup|sub)\b)((?![^<>]*\bstyle=)[^<>]*)>([\s\S]*?)<\/\2>\s*\{:\s*style="([^"]*)"\}/g,
    (_m, open: string, tag: string, attrs: string, inner: string, style: string) =>
      `${open}${attrs} style="${style.replace(/"/g, '&quot;')}">${inner}</${tag}>`,
  );

  // ★★★ Strip the inline IAL suffix `{: style="…"}` that SiYuan attaches.
  //
  //   SiYuan exports inline styles in the double form "HTML span + trailing IAL":
  //     `<span data-type="text" style="…">red</span>{: style="…"}after`
  //   That suffix is the kernel's own redundant notation and **is not part of the text content**.
  //   Left in place it enters the node text as literal characters and the user sees a raw `{: style="…"}`.
  //
  //   ★ It must come **after all replacements**: the IAL follows `</span>`,
  //     and if handled earlier the inline-style regex above consumes that span first,
  //     so no later regex ever sees the "span end + IAL" combination again (hit in practice).
  s = s.replace(/\{:\s*style="[^"]*"\}/g, '');
  s = s.replace(/\{:\s*style='[^']*'\}/g, '');

  // tag
  //
  // ★★ Runs **after** the IAL has been dealt with, not before, and with every tag present
  //   stashed again while it matches.
  //
  //   Two ways this rule used to reach inside an attribute value and rewrite it as a tag:
  //     1. the bare IAL — `{: style="color: #dc2a2a;"}` is text, so a hex colour became
  //        `{: style="color: <span data-tag="dc2a2a;">#dc2a2a;"}`. Measured: the node's text
  //        became that garbage and the next save wrote it back, destroying the colour for good.
  //     2. a tag this function produced itself — the IAL fold above leaves
  //        `<b style="color: #dc2a2a;">`, and `<b>` is not in `KEEP_TAG`, so the colour was
  //        rewritten there too.
  //   Stashing everything that is left of the string closes both, and a tag in the **text**
  //   is still recognised —— that is the point of the rule.
  {
    const tags: string[] = [];
    const masked = s.replace(/<[^<>]+>/g, (m) => {
      tags.push(m);
      return `\u0003${tags.length - 1}\u0003`;
    });
    s = masked
      .replace(/(^|[\s(])#([^\s#]+)/g, (_m, pre: string, name: string) => `${pre}<span data-tag="${name}">#${name}</span>`)
      .replace(/\u0003(\d+)\u0003/g, (_m, i: string) => tags[Number(i)] ?? '');
  }

  // ★ Restore the stashed tags **last**: until here no text rule above could see a real `<…>`,
  //   which is what keeps `style="color: #dc2a2a;"` from being read as a tag. See KEEP_TAG.
  s = s.replace(/\u0002(\d+)\u0002/g, (_m, i: string) => keep[Number(i)] ?? '');

  // ★ The outer fallback span is added only when it is **really needed**.
  //
  //   The code used to `return \`<span>${s}</span>\`` unconditionally, which wrapped even **plain text** in a
  //   `<span>` — and on write back to SiYuan (see htmlToSiyuanDom) that span got
  //   `data-type="text"` added, conjuring a style node out of nowhere.
  //   Now: no extra shell is added when the content already contains tags.
  return /<[a-z][\s\S]*>/i.test(s) ? s : `<span>${s}</span>`;
}

// ---------------------------------------------------------------- node tree → Kramdown document

/** One node → one line of Kramdown (without indentation) */
export function nodeToLine(n: OutlineNode): string {
  const body = htmlToKramdown(n.text);
  let prefix = '';
  if (n.taskStatus === 2) prefix = '[x] ';
  else if (n.taskStatus === 1) prefix = '[ ] ';
  // ★  Fix: it used to clamp to 1~3, which **silently degraded h4/h5/h6 into plain list items**.
  //
  // SiYuan natively supports heading levels 1~6 and the read side parses 4/5/6 correctly;
  // but the write side's `<= 3` treated 4/5/6 all as "not a heading" and wrote `- text`.
  // After one round trip, `#### level four` became a plain list item — the heading level was lost forever.
  const heading = n.heading && n.heading >= 1 && n.heading <= 6 ? n.heading : 0;
  if (heading) {
    // A heading is its own block (not wrapped in a list), so SiYuan recognises it as h1-h6.
    //
    // ★ h1 keeps its level and is **no longer downgraded**.
    //
    //   A flush-left `# X` can be either a document title block or a real h1 node in SiYuan,
    //   and the read side tells them apart by "is it the document's first block" (see the kramdownToTree notes),
    //   so writing `# ` here is safe:
    //     · in a document written from a node tree, the first block is the heading block itself — but it is a **node**,
    //       not the document title (the title is supplied separately by createDoc's file header).
    //     · so that a written h1 falling on the first line is not mistaken for the title,
    //       an attribute line `{: id="…"}` is always added after it,
    //       and the read side identifies it correctly as "not the first block".
    const hashes = '#'.repeat(heading);
    return `${hashes} ${prefix}${body}`;
  }
  // An ordered list item: SiYuan creates an ordered List (`l/o`) for `1. x` and an unordered one
  // (`l/u`) for `- x` (measured on the isolated instance —— mixed siblings are even split into
  // separate lists), and the read side parses `1.` back into `numbered`. So the marker is the whole
  // representation: writing `- ` here would drop the numbering on every write-back, while neither
  // the toolbar `1.` button nor the `1. ` inline shortcut changes any other field that the write
  // path compares.
  if (n.numbered) return `1. ${prefix}${body}`;
  return `- ${prefix}${body}`;
}

/**
 * The single line `syncStructure` inserts for a brand-new node, carrying the node's own ID so the
 * kernel adopts it instead of assigning a fresh block ID (see the defect #54 note at the call site).
 *
 * ★ The marker follows `numbered`: `1. {: id="…"}text` creates an ordered List (`l/o`) with the ID
 *   adopted (measured on the isolated instance), exactly like `- {: id="…"}text` does for unordered.
 *   Kept as its own function (rather than reusing `nodeToLine`) because the insert deliberately omits
 *   the task marker and heading form —— those go through their own conversion paths after the insert.
 */
export function nodeInsertLine(n: OutlineNode, text: string): string {
  const marker = n.numbered ? '1.' : '-';
  return SIYUAN_ID_RE.test(n.id) ? `${marker} {: id="${n.id}"}${text}` : `${marker} ${text}`;
}

/**
 * One pasted plain-text line → display body + ordered flag.
 *
 * A pasted `1. x` line carries numbering as *syntax*: keeping the marker as text would show a
 * literal "1. " in the node, while dropping it silently (as the old inline regex did) loses the
 * numbering on the very first write-back. Mirrors the read side's marker rules (`-` / `1. `).
 */
export function pasteLineInfo(raw: string): { body: string; numbered: boolean } {
  const m = /^(?:\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/.exec(raw);
  return { body: (m ? m[1] : raw).trim(), numbered: /^\s*\d+[.)]\s+/.test(raw) };
}

/**
 * Append one node and its subtree as Kramdown lines —— the walk `treeToKramdown` performs, shared
 * so that writing a **single** node back and exporting a whole document cannot drift apart.
 */
function walkNodesToLines(list: OutlineNode[], depth: number, lines: string[]): void {
  for (const n of list) {
    // ★ A table node emits its **markdown table**, not a list item.
    //
    //   A `NodeList` cannot contain a table (measured: the kernel stores one with `parent_id`
    //   = the document), so indenting these lines would ask the kernel for an invalid structure.
    //   They therefore always sit flush left, and a table node has no children by construction.
    if (n.table) {
      lines.push(tableToKramdown(n.table));
      lines.push('');
      continue;
    }
    const line = nodeToLine(n);
    const indent = '  '.repeat(depth);
    // Measured: the attribute must be on the "same line" as the list item, after `- `,
    // in the form `- {: memo="X"}body`, for SiYuan to attach it to the listItem.
    // On a line of its own (especially indented) it is parsed as an ordinary paragraph block (a pitfall already hit).
    // ★ Notes no longer go through the `memo` attribute (deprecated) — they are carried by **native attached paragraphs**
    //   instead (`paragraphs`, see the attached-paragraph serialization below). `memo` is a block attribute
    //   that full-text search does not find by default, and it shows only as an "M" icon that has to be opened to be seen,
    //   which contradicts "what you see is what you get in SiYuan's own editing".
    //   attrs is used only to pass the id through to later parsing.
    const attrs: string[] = [];
    // Note: do **not** leave a space before `}`. Measured: `{: a="x" }body` is rendered by SiYuan as
    // `{: a="x"}}body` (an extra `}` before the body), polluting the content.
    const attr = attrs.length ? `{: ${attrs.join(' ')}}` : '';
    const isHeading = line.startsWith('#');
    // ★ Ordered items keep their own marker: this walk used to strip nodeToLine's `- ` and reassemble
    //   `- …` unconditionally, so a numbered node came out as `- 1. item` —— which the read side takes
    //   for a plain node whose text starts with "1. " (measured: the round trip lost both the numbering
    //   and the marker text). `1. {: id="…"}body` is a form SiYuan itself writes, so it reassembles the
    //   same way, with the ordered marker.
    const isOrdered = /^\d+\.\s/.test(line);
    if (isHeading) {
      // A heading block does not support list-item attributes; the attribute goes on its own flush-left line
      lines.push(`${indent}${line}`);
      if (attr) lines.push(attr);
    } else {
      // Strip nodeToLine's `- `/`1. ` prefix and reassemble
      let bodyOnly = line.replace(/^(?:-\s?|\d+\.\s?)/, '');
      // Empty-text node: SiYuan does not keep an empty list item's body, so a zero-width placeholder keeps the node round-trippable.
      if (!bodyOnly.trim()) bodyOnly = '\u200b';
      lines.push(`${indent}${isOrdered ? '1. ' : '- '}${attr}${bodyOnly}`);
      // Attached paragraphs: in SiYuan a listItem can have several sibling NodeParagraph blocks.
      //
      // ★ **Every attached paragraph must be preceded by a blank line** (confirmed by ablation):
      //   in markdown two consecutive lines belong to **the same paragraph**; a blank line is the paragraph separator.
      //   Without the blank line the attached paragraph is taken as a continuation of the first paragraph and the two merge into one block:
      //     ❌ p 'root⏎attached'      (⏎ = a line break inside the block; two paragraphs merged into one)
      //     ✅ p 'root' + p 'attached'
      //
      // ⚠️ The first paragraph must be non-empty, otherwise **the whole set of attached paragraphs escapes the listItem to the document root**.
      // `\u200b` already covers that above; the same placeholder is applied to the attached paragraphs themselves here.
      for (const p of n.paragraphs ?? []) {
        const kd = htmlToKramdown(p);
        lines.push('');
        lines.push(`${indent}  ${kd.trim() ? kd : '\u200b'}`);
      }
    }
    if (n.children?.length) {
      // **No** blank lines around the child list (ablation conclusion).
      //
      // Earlier this said "leave one blank line on each side, otherwise attached paragraphs shift position",
      // but the ablation could not reproduce that necessity — see the "blank line rules" note at the end of the file.
      walkNodesToLines(n.children, depth + 1, lines);
    }
  }
}

/**
 * One node **and its subtree** as Kramdown, with no document title —— what a single block has to be
 * written back with.
 *
 * ★ Writing only the node's own line is not equivalent: measured on the kernel, updating a list item
 *   that has children with just its own line does not convert the block in place —— without a marker the
 *   kernel **appends a nested copy** beside the children, with a marker it **drops the children**.
 *   Carrying the subtree (`- [ ] parent` plus its indented children) converts it in place, keeps every
 *   block id in it, and shows the text once.
 */
export function nodeSubtreeToKramdown(n: OutlineNode): string {
  const lines: string[] = [];
  walkNodesToLines([n], 0, lines);
  return lines.join('\n');
}

/**
 * Node tree → a complete Kramdown document.
 *
 * - top-level nodes are `- xxx`, children indent by 2 spaces per level (SiYuan's nested-list syntax)
 * - heading nodes are emitted as `# xxx`, and their children still indent as a list (keeping the hierarchy)
 * ★★★ This function **produces no `custom-*` attributes** and no `memo`.
 *
 * Design principle: the document must be a **self-explanatory, ordinary SiYuan document** — after uninstalling this plugin,
 * its content, hierarchy, attached paragraphs and task states all stay readable and editable, leaving no private traces behind.
 *
 * Native carriers for each kind of data:
 *   · node identity       → the listItem's own block ID
 *   · attached paragraphs → several NodeParagraph blocks under the listItem (body text, indexed for full-text search)
 *   · task state          → a native task list `- [ ]` / `- [x]` (subtype=t)
 *   · heading             → native h1~h6 blocks
 */
/**
 * ★ No caller in `src/` today —— kept on purpose, and this note is why.
 *
 * `SiYuanStore.saveNodes` was its only shipping caller and was removed as dead code (17 lines wrapping
 * `updateBlock(docId, markdown)`, called from nowhere). The **document paths do not use markdown at all**:
 * `createDoc` and `saveNodesIncremental` both go through native block DOM, because the markdown route runs
 * Lua/Lute parsing that cannot express rich text (see the long note in `createDoc`).
 *
 * It stays because it is the writer half of a **tested contract** with `kramdownToTree`:
 *   · `core/map.test.ts` round-trips a tree through it and checks the tree comes back;
 *   · `plugin/paragraphs-ui.test.ts` uses it to assert it produces **no `custom-*` attributes** —— the
 *     guarantee that a document stays an ordinary SiYuan document after this plugin is uninstalled.
 * Deleting it would delete those checks' subject, and with it the only defence of the portability rule.
 *
 * If a future export feature needs "the whole tree as a SiYuan document", this is it.
 */
export function treeToKramdown(
  nodes: OutlineNode[],
  opts: {
    docTitle?: string;
    fallbackTitle?: string;
    titleParagraphs?: string[];
    docParagraphs?: string[];
  } = {},
): string {
  // ★ The fallback title is passed in by the caller (this file is pure logic and hardcodes no language's default)
  const { docTitle = opts.fallbackTitle ?? '' } = opts;
  const lines: string[] = [`# ${docTitle}`, ''];

  const titleParas =
    opts.titleParagraphs ??
    opts.docParagraphs ??
    [];
  for (const p of titleParas) {
    const kd = htmlToKramdown(p);
    lines.push(kd.trim() ? kd : '\u200b');
    lines.push('');
  }

  walkNodesToLines(nodes, 0, lines);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- Kramdown document → node tree

/**
 * Kramdown document → node tree (the inverse of treeToKramdown).
 *
 * Parsing strategy: scan line by line, use the indent width to decide the level, and rebuild the tree with a stack.
 * Ignore the indentation of `<!-- om-id:... -->` lines (they sit at the same level as the node they belong to).
 */
let lastTitleParagraphs: string[] = [];

/** Read and reset "the heading node's leading paragraphs extracted by the last kramdownToTree" */
export function takeTitleParagraphs(): string[] {
  const v = lastTitleParagraphs;
  lastTitleParagraphs = [];
  return v;
}

/**
 * The task state one block's own Kramdown line carries: 0 not a to-do, 1 unchecked, 2 checked.
 *
 * ★ One definition for two readers. `kramdownToTree` asks it what a document line means, and the store
 *   asks it what a block already holds before writing a change —— so the write-back cannot disagree with
 *   the reader about what counts as a to-do.
 *
 * Tolerates the two shapes the same text arrives in: a `blocks.markdown` value (`- [ ] x`) and a
 * `getBlockKramdown` value, which carries the block's attribute group between the bullet and the body
 * (`- {: id="..."}[ ] x`).
 */
export function taskStateOfKramdownLine(line: string): 0 | 1 | 2 {
  // ★ Ordered markers count too: `1. [x] y` is a checked task in an ordered list, and the store
  //   compares this against SQL markdown on every save —— without the `\d+\.` alternative a numbered
  //   task would read as "no task" and be rewritten on every write-back.
  let body = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
  for (let i = 0; i < 2 && /^\{:/.test(body); i++) body = body.replace(/^\{:[^}]*\}\s*/, '');
  if (/^\[x\]\s*/i.test(body)) return 2;
  if (/^\[ \]\s*/.test(body)) return 1;
  return 0;
}

export function kramdownToTree(kramdown: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const titleParagraphs: string[] = [];
  const stack: { depth: number; node: OutlineNode }[] = [];
  let lastNode: OutlineNode | null = null;
  // Whether "the document's first block" has been seen — used to recognise the document title (see below)
  let sawFirstBlock = false;
  // Whether the previous "meaningful" line was a block attribute line — used to recognise **empty attached paragraphs** (see below)
  let prevWasAttr = false;
  // ★ Consecutive `|`-lines waiting to be judged as one table block (see `parseTableLines`).
  let tableRun: string[] = [];
  /**
   * A fenced code block's lines, from the opening fence until the closing one.
   *
   * ★★★ Held here, before any other branch can claim them, and this is **not** tidiness.
   *
   *   Measured defect: a document holding
   *
   *       ```js
   *       const a = 1;
   *       ```
   *
   *   was read as *no node at all*. Each line fell through to the generic branch below, where a
   *   flush-left line becomes an attached paragraph of the nearest node —— so the fence became
   *   `` <code></code>`js `` (the inline-code rule biting a fence), the source became a plain
   *   paragraph, and the whole block was **folded into the document title's paragraphs**. The block
   *   appeared nowhere in the outline, and because it was not a node it could not be deleted: the
   *   user reported it as "a code block can't be deleted at all".
   *
   *   `null` means "not inside a fence"; an array means the run is open.
   */
  let codeFence: string[] | null = null;
  /** The backtick count of the fence that opened the current run (see the closing-fence rule). */
  let openFence = 3;
  /** Backticks at the start of a line, for the closing-fence comparison above. */
  const fenceLen = (line: string): number => (line.match(/^\s*(`+)/)?.[1] ?? '').length;
  /** A fence that has closed and is waiting for the attribute line that carries its block id. */
  let pendingCode: string[] | null = null;
  /** Push a collected table run as a node, using the id from the attribute line that closed it. */
  const flushTable = (idFromAttr: string | null): void => {
    const lines = tableRun;
    tableRun = [];
    const table = parseTableLines(lines);
    if (!table) {
      // Not a table after all: these are ordinary lines, and dropping them would delete the
      // user's text. They are re-emitted as plain body lines of the nearest node above.
      for (const l of lines) {
        const t = kramdownToHtml(l.replace(/^\|/, '').trim());
        if (lastNode) {
          if (!lastNode.paragraphs) lastNode.paragraphs = [];
          lastNode.paragraphs.push(t);
        } else {
          titleParagraphs.push(t);
        }
      }
      return;
    }
    roots.push({
      id: idFromAttr ?? '',
      modified: 0,
      // A table has no paragraph of its own; `text` is unused and stays empty.
      text: '',
      table,
      children: [],
    });
    lastNode = null;
  };

  /**
   * Close an open fence and push it as a code-block node.
   *
   * ★ The block's **id comes from the attribute line that follows** the closing fence (SiYuan's
   *   convention for a non-list block: ` ``` ` … `{: id="…"}`), so it is passed in rather than read
   *   from the fence lines. Without the id the node would be judged "new in the UI" on every load
   *   and re-inserted beside the original — the duplication shape this reader has hit before.
   *
   * A fence with **no closing line** is still emitted rather than dropped: the kernel can hold an
   * unterminated fence, and silently discarding the user's code is worse than showing it.
   */
  const flushCode = (idFromAttr: string | null): void => {
    const lines = pendingCode;
    pendingCode = null;
    if (lines === null) return;
    const open = lines[0];
    void open;
    // The info string is whatever follows the opening backticks: ```js -> "js", ``` -> "".
    const lang = (open.match(/^\s*`{3,}\s*([^`\s]*)/)?.[1] ?? '').trim();
    const body = lines.slice(1);
    // Drop the closing fence only when it really is one; otherwise the last line is source.
    if (body.length && /^\s*`{3,}\s*$/.test(body[body.length - 1])) body.pop();
    const node: OutlineNode = {
      id: idFromAttr ?? '',
      modified: 0,
      text: '',
      codeBlock: { lang, code: body.join('\n') },
      children: [],
    };
    roots.push(node);
    lastNode = null;
  };

  for (const rawLine of kramdown.split('\n')) {
    // ★★★ Inside a fence, **every** line belongs to the code block and nothing else may look at it.
    //   This is the whole point: a code sample contains `|`, `#`, `-`, `{: …}` and blank lines,
    //   all of which the branches below would happily claim as markup. Blank lines are part of the
    //   code, and so is a line that looks exactly like an attribute line.
    if (codeFence !== null) {
      codeFence.push(rawLine);
      // ★★★ The closing fence must be **at least as long as the opening one** — the CommonMark rule,
      //   and the reason a writer that lengthens the fence works at all. Measured: a block whose
      //   source contains a fence of its own is emitted with four backticks (` ````md ` ), and a
      //   reader that closed on *any* three would cut it off at the first inner ` ``` ` and lose the
      //   rest of the code. `openFence` holds the opening run for exactly this comparison.
      if (/^\s*`{3,}\s*$/.test(rawLine) && fenceLen(rawLine) >= openFence) {
        // The closing fence ends the run; the id arrives on the next attribute line, if there is one.
        // `pendingCode` carries the finished block until that line is seen.
        pendingCode = codeFence;
        codeFence = null;
      }
      continue;
    }
    // ★ An **unterminated** fence is still a block: the loop above ends with the run open, and
    //   closing it here keeps the user's code instead of dropping it. Measured: without this the
    //   document read as zero nodes, because every line from the fence on was consumed and never
    //   emitted —— the most silent possible form of losing a code block.
    if (!rawLine.trim()) {
      flushCode(null);
      flushTable(null);
      continue;
    }

    // Block attribute lines: SiYuan exports "two" attribute lines per listItem:
    //   1) inner (deeper indent): belongs to the paragraph block inside the listItem
    //   2) outer (the next line, at the node's own level): belongs to the listItem itself.
    // Hence the rule: **take only the outermost** id=, so the paragraph's id does not
    // overwrite the node (listItem)'s own block ID.
    if (/^\s*\{:/.test(rawLine)) {
      // ★ A table's id sits on the attribute line **after** its rows, not before them
      //   (`… |a|b| / {: … colgroup="|"}`), which is the opposite of every other block.
      //   `colgroup="|"` is what marks it as a table's line, so it cannot be confused with a
      //   listItem's own closing attribute line.
      if (tableRun.length && /\bcolgroup="/.test(rawLine)) {
        const id = /\bid="([^"]+)"/.exec(rawLine)?.[1] ?? null;
        flushTable(id);
        prevWasAttr = true;
        continue;
      }
      // ★ A closed code fence is followed by **its own** attribute line, exactly like a table's —
      //   and that line carries the block's id. Consumed here for the same reason the table's is:
      //   without the id the node reads as "new in the UI" on every load and gets re-inserted
      //   beside the original.
      if (pendingCode !== null) {
        const id = /\bid="([^"]+)"/.exec(rawLine)?.[1] ?? null;
        flushCode(id);
        prevWasAttr = true;
        continue;
      }
      flushTable(null);
      // ★★ Recognising an empty attached paragraph (measured).
      //
      // SiYuan's `getBlockKramdown` **does not export an empty paragraph's body line**, but it does export its
      // attribute line. So "two adjacent attribute lines" in the kramdown means an empty paragraph sits between them:
      //
      //     - {: id=…}node            ← listItem
      //       {: id=…}                ← the first paragraph's attribute line
      //
      //       first paragraph          ← attached paragraph body
      //       {: id=…}                ← attached paragraph attribute line
      //       {: id=…}                ← ★ adjacent to the line above → an empty paragraph sits here
      //
      //       third paragraph
      //       {: id=…}
      //     {: id=…}                  ← the listItem's closing attribute line
      //
      // The test must also constrain the indent: the listItem's own closing attribute line is adjacent to a paragraph attribute line too,
      // but it does not belong to that node (it marks the end of the list item) and must not count as an empty paragraph.
      if (prevWasAttr) {
        const ind = Math.floor(/^(\s*)/.exec(rawLine)![1].length / 2);
        if (lastNode) {
          const nodeInd = nodeDepth.get(lastNode) ?? 0;
          if (ind === nodeInd + 1) {
            // one level deeper than the node → an attached paragraph; add an empty-paragraph placeholder
            if (!lastNode.paragraphs) lastNode.paragraphs = [];
            lastNode.paragraphs.push('');
          }
        } else if (ind === 0 && titleParagraphs.length > 0) {
          // a flush-left attribute line adjacent before the node → an empty attached paragraph of a heading node
          titleParagraphs.push('');
        }
      }
      if (lastNode) applyAttrs(lastNode, rawLine);
      prevWasAttr = true;
      continue;
    }
    prevWasAttr = false;

    // ★★★ A code block opens with a fence at the start of a line (` ``` ` or ` ```lang `).
    //   Claimed here, before the table run and before every other branch: the lines inside a fence
    //   are code, and none of them is markup. Committed only once it is open, so a stray run of
    //   backticks in prose cannot swallow the document.
    if (/^\s*`{3,}/.test(rawLine)) {
      flushTable(null);
      flushCode(null);
      codeFence = [rawLine];
      openFence = fenceLen(rawLine) || 3;
      prevWasAttr = false;
      continue;
    }

    // ★★ A table's rows are consecutive `|`-lines, and they are **not** list items.
    //
    //   Collected here, before any other branch can claim them: further down, a non-list
    //   flush-left line is folded into the node above as an attached paragraph, which would
    //   have turned the table into a line of garbage text on the node and lost it on the next
    //   save. `flushTable` decides what the run was, once it ends.
    if (/^\s*\|/.test(rawLine)) {
      tableRun.push(rawLine);
      continue;
    }
    flushTable(null);

    // ★ A flush-left `# X` has two identities that must be told apart: a **document title block** vs a **real h1 node**.
    //
    // Both have type/subtype h/h1, both have the document root as parent, both carry a `{: id=… }` attribute line,
    // and both have `# X` as their kramdown text — the line alone cannot tell them apart.
    //
    // A reliable criterion (confirmed by measuring the real kernel):
    //   **The document title block is always the document's first block** (it is the file header itself,
    //   and nothing can be inserted before it). So in the kramdown,
    //   "first content line + flush-left `# `" = the document title; any other flush-left `# ` = a real h1 node.
    //
    // Measured comparison:
    //   document A (with a title): `# doc title`(line 1) / `# real h1`(block 2) → only the first is skipped
    //   document B (no title): `body…`(line 1) / `# a real h1`(block 2)      → h1 kept ✅
    //
    // Note: SQL's `sort` column **cannot** be used — the title block and an h1 block often share the same sort (not unique),
    // so the ordering does not match the real document order (hit in practice; it was once misjudged as "indistinguishable").
    if (rawLine.trim() && !sawFirstBlock) {
      sawFirstBlock = true;
      const firstHeading = /^(#{1,6})\s+(.*)$/.exec(rawLine.trim());
      if (firstHeading && firstHeading[1].length === 1 && !/^\s/.test(rawLine)) {
        // The document's first block is a flush-left `# ` → the document title, not a node
        continue;
      }
    }

    const depth = Math.floor(/^(\s*)/.exec(rawLine)![1].length / 2);
    let body = rawLine.trim();

    // Heading line: SiYuan exports `## text` plus an attribute line for a heading block, **without** a list bullet.
    // ★ Non-list lines must not all be discarded — heading nodes would silently disappear.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(body);

    // Strip the list bullet first, then parse the inline attribute prefix
    // (SiYuan writes it as `- {: id="X"}body` or `1. {: id="X"}body`, with the attribute after the marker)
    const listMatch = /^(-\s+|\d+\.\s+)/.exec(body);
    const isList = !!listMatch;
    const isNumbered = /^\d+\.\s+/.test(body);
    if (isList) body = body.slice(listMatch![0].length);
    const isHeading = !isList && !!headingMatch;
    if (isHeading) body = headingMatch![2];

    // ⚠️ Non-list, non-heading lines are **not taken into the node tree**.
    //
    // A SiYuan document normally contains body paragraphs (`this is a note.`). If they were treated as nodes,
    // they would enter the node tree with their own block IDs; on write back, items that are "in the node tree but not in SiYuan's list"
    // are re-inserted as missing nodes — with the result that body paragraphs get **duplicated** into list items.
    // (Hit in practice: after dragging a block into the map, the document's body paragraph gained a duplicate out of nowhere.)
    //
    // Map nodes are always based on native list items or native headings — the representation consistent with SiYuan's structure.
    //
    // ★ Exception: an **indented** ordinary paragraph is an "attached paragraph" belonging to the node above it.
    // SiYuan was measured to export all of a listItem's NodeParagraph child blocks as
    // ordinary lines indented by 2 spaces, and they may appear **after** the child list:
    //     - node
    //
    //       attached A
    //
    //       - child node
    //
    //       attached B          ← attachment is still possible after the list
    // So the criterion is "indented + not a list + not a heading", not "before the list".
    if (!isList && !isHeading) {
      // Note: do not filter out "empty paragraphs" here.
      // SiYuan does not export an empty paragraph's body line, only its attribute line, which is handled
      // specifically by the adjacent-attribute-line logic above (`prevWasAttr`); adding another emptiness test here
      // would disable that path entirely (measured: it broke empty-paragraph round trips).
      const t = kramdownToHtml(body.replace(/\u200b/g, ''));
      if (depth > 0 && lastNode && depth > stackDepthOf(lastNode)) {
        // this line is indented deeper than the node → an attached paragraph of lastNode
        if (!lastNode.paragraphs) lastNode.paragraphs = [];
        lastNode.paragraphs.push(t);
        continue;
      }
      // A flush-left body paragraph belongs to **the nearest node above it**.
      //
      // "Not duplicating it into a list item" does not mean "it can be dropped" — dropping makes the flush-left paragraph disappear entirely
      // (measured: "the sentence in the task is invisible in the map"):
      //
      //     - [X] record a video and a slide deck for every remaining issue
      //     open the screenshot tool       ← flush-left paragraph, silently dropped
      //
      // This line is a note on the task above and is a perfectly reasonable way to write it. After the drop the user can neither see the content
      // nor know that anything was lost.
      //
      // Now it is attached to lastNode's attached paragraphs instead (handled the same way as indented paragraphs).
      // On write back, attached paragraphs go through the "paragraph blocks under the node" path and do **not** become new list items,
      // so the duplication worry from back then does not arise.
      //
      // Paragraphs appearing before any list-item/heading node belong to the heading node (the document root),
      // rather than being dropped or ignored.
      if (lastNode) {
        if (!lastNode.paragraphs) lastNode.paragraphs = [];
        lastNode.paragraphs.push(t);
      } else {
        titleParagraphs.push(t);
      }
      continue;
    }
    const headingLevel = isHeading ? headingMatch![1].length : 0;

    // inline attribute prefix: `{: id="..."}body`
    let inlineSiyuanId: string | null = null;
    let inlineAttrsSrc = '';
    const inlineAttr = /^\{:([^}]*)\}\s*/.exec(body);
    if (inlineAttr) {
      inlineAttrsSrc = inlineAttr[1];
      const sid = /\bid="([^"]+)"/.exec(inlineAttr[1]);
      if (sid && SIYUAN_ID_RE.test(sid[1])) inlineSiyuanId = sid[1];
      body = body.slice(inlineAttr[0].length);
    }

    // a heading block may also carry a prefix attribute; strip once more as a fallback
    const lateAttr = /^\{:([^}]*)\}\s*/.exec(body);
    if (lateAttr) {
      inlineAttrsSrc += ' ' + lateAttr[1];
      const sid = /\bid="([^"]+)"/.exec(lateAttr[1]);
      if (sid && SIYUAN_ID_RE.test(sid[1])) inlineSiyuanId = sid[1];
      body = body.slice(lateAttr[0].length);
    }

    let taskStatus: number | undefined;
    const taskState = taskStateOfKramdownLine(body);
    if (taskState) {
      taskStatus = taskState;
      body = body.replace(/^\[[ xX]\]\s*/, '');
    }

    let heading = 0;
    // An indented heading (`  ## X`) already got its level from headingMatch above;
    // as a fallback, try body once more (tolerating forms such as `## X` after an inline attribute).
    if (headingLevel) {
      heading = headingLevel;
    } else {
      const hm = /^(#{1,3})\s+(.*)$/.exec(body);
      if (hm) {
        heading = hm[1].length;
        body = hm[2];
      }
    }

    // Empty-text node: SiYuan keeps its block attributes, so it must not be dropped.
    // Only lines with "no text and no ID clue at all" are real noise (e.g. blank lines SiYuan itself generates).
    if (!body && !taskStatus && !heading && !inlineSiyuanId) continue;

    const node: OutlineNode = {
      // Left empty for now, waiting for an attribute line / inline attribute to give the real ID; generated only if none ever appears.
      id: inlineSiyuanId || '',
      modified: Date.now(),
      // the zero-width placeholder (empty-node protection) decodes back to empty text
      text: kramdownToHtml(body.replace(/\u200b/g, '')),
      children: [],
    };
    if (inlineAttrsSrc) applyAttrs(node, inlineAttrsSrc);
    if (taskStatus) node.taskStatus = taskStatus;
    if (heading) node.heading = heading as OutlineNode['heading'];
    if (isNumbered) node.numbered = true;

    // Rebuild the hierarchy from the indentation with a stack: pop every ancestor with depth >= the current one
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
    nodeDepth.set(node, depth);
    lastNode = node;
  }

  // ★ A table run that never met a closing attribute line is still a table run: judge it now,
  //   so a document whose last block is a table does not lose it.
  flushTable(null);
  // An unterminated fence: the run is still open at EOF, and `flushCode` reads `pendingCode`, so
  // the open run is handed over first. Dropping it would read the document as zero nodes from the
  // fence onward —— the most silent possible way to lose a code block.
  if (codeFence !== null) {
    pendingCode = codeFence;
    codeFence = null;
  }
  flushCode(null);

  // Fallback: give a SiYuan-style ID to nodes for which the whole text never provided an ID
  for (const n of flatNodes(roots)) if (!n.id) n.id = makeSiyuanId();

  lastTitleParagraphs = titleParagraphs;
  return roots;
}

/**
 * The "attached paragraph" criterion: whether the line is indented **deeper than the node it belongs to**.
 *
 * SiYuan exports "node indent + 2 spaces", so an attached paragraph's depth is exactly one more than the node's.
 * This uses the recorded node-depth table rather than guessing — because attached paragraphs can still appear after a child list,
 * and comparing against "the previous node" alone would misjudge them.
 */
function stackDepthOf(node: OutlineNode): number {
  return nodeDepth.get(node) ?? 0;
}

/** Node → its indent level in the kramdown (filled in by kramdownToTree) */
const nodeDepth = new WeakMap<OutlineNode, number>();

/**
 * Apply one attribute fragment (the contents of `{: ... }`) to a node.
 *
 * ID rule (required, measured): the listItem's own `id=` is the node's identity.
 */
function applyAttrs(node: OutlineNode, src: string): void {
  // identity = the SiYuan native block ID
  if (!node.id) {
    const sid = readAttr(src, 'id');
    if (sid && SIYUAN_ID_RE.test(sid)) node.id = sid;
  }

  // ★ Notes are carried by **native attached paragraphs** (`paragraphs`) and restored in the indented-line parsing.
  //   Summaries / edges: no native counterpart in SiYuan, and this plugin writes no private attributes — neither read nor written.
  //   (They are local, session-only view semantics and are not persisted across sessions.)
}
