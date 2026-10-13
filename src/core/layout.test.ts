/**
 * Regression tests for mind map layout and colours (corresponding to agy's UI-TC-19 / 20 / 21).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this file exists
 * ──────────────────────────────────────────────────────────────────
 *
 * `src/core/layout.ts` has 6 layout structures, 8 colour schemes and 7 node shapes,
 * and it is **pure functions** (no dependency on React / DOM / the SiYuan SDK) —— this should be the easiest part to test
 * and the part that most deserves tests, yet previously it had **not a single test**.
 *
 * Mind map problems also depend heavily on the eye: wrong colours, overlapping nodes, text spilling out of the border,
 * none of which show up in DOM measurements (computed style says "no problem"); only drawing reveals them.
 * So these invariants must be pinned down at the pure-function level, not left to eyeball regression.
 *
 * ──────────────────────────────────────────────────────────────────
 * Focus on the parts where a change raises nothing and only makes things quietly uglier
 * ──────────────────────────────────────────────────────────────────
 *
 *   · dark conversion: a wrong result throws nothing, you just get grey background with black text / unreadable low contrast
 *   · layout coordinates: a wrong result throws nothing, it just makes nodes pile up
 *   · shapes: each of the 7 shapes has its own geometry branch; miss one and it cannot be drawn
 */

export {};

import type { OutlineNode } from '../model/types';
import {
  MM_BRANCH_PALETTES,
  MM_SHAPE_KEYS,
  MM_THEMES,
  calcSplitIndex,
  edgePath,
  exportFreemind,
  label,
  layoutHorizontal,
  layoutOrg,
  normalizeShape,
  normalizeStructure,
  normalizeLineStyle,
  normalizeThemeIdx,
  runsOf,
  themeToDark,
  widthOf,
  measureNode,
  type MmStructure,
  type MmTopicShape,
} from './layout';

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

const N = (id: string, text = id, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 0, text, children }) as OutlineNode;

// ──────────────────────────────────────────────────────────────────
console.log('colours: structural completeness of the 8 palettes');

{
  check('the number of palettes is 8', MM_BRANCH_PALETTES.length === 8);
  const fields = ['border', 'fill', 'line', 'text', 'badgeBg'] as const;
  let allHex = true;
  let missing: string[] = [];
  for (const [i, p] of MM_BRANCH_PALETTES.entries()) {
    for (const f of fields) {
      const v = p[f];
      if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
        allHex = false;
        missing.push(`#${i}.${f}=${v}`);
      }
    }
  }
  check('★ every field is 6-digit hex (the dark conversion only accepts that format)',
    allHex, missing.slice(0, 3).join(' '));
}

{
  // Within one palette the fill must be lighter than the border (otherwise the node looks like a solid block and the text is unreadable).
  // Compare relative luminance, not strings.
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  // ★ Separate accumulators per invariant: the old shared `ok`/`bad` let one invariant
  //   report the other's failure — a red run no longer said which invariant broke.
  let okBorder = true;
  const badBorder: string[] = [];
  for (const [i, p] of MM_BRANCH_PALETTES.entries()) {
    if (!(lum(p.fill) > lum(p.border))) { okBorder = false; badBorder.push(String(i)); }
  }
  check('★ in every palette fill is lighter than border (light fill, dark border)', okBorder, badBorder.join(' '));
  let okText = true;
  const badText: string[] = [];
  for (const [i, p] of MM_BRANCH_PALETTES.entries()) {
    if (!(lum(p.fill) > lum(p.text))) { okText = false; badText.push(`text${i}`); }
  }
  check('★ in every palette fill is lighter than text (keeps the text readable)', okText, badText.join(' '));
}

// ──────────────────────────────────────────────────────────────────
console.log('\ndark conversion: no grey background with black text / low contrast allowed');

{
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };

  let allDarkFill = true;
  let allLightText = true;
  const badFill: string[] = [];
  const badText: string[] = [];

  for (const [ti, t] of MM_THEMES.entries()) {
    const d = themeToDark(t);
    // `branchColors` is optional: a monochrome theme has none, and the render layer falls back to nodeBg/text.
    // So both kinds are covered here; testing only colourful themes is not enough.
    const pals = d.branchColors ?? [{
      border: d.line, fill: d.nodeBg, line: d.line, text: d.text, badgeBg: d.line,
    }];
    for (const [pi, p] of pals.entries()) {
      // In dark mode: the background must be dark and the text light
      if (!(lum(p.fill) < 0.4)) { allDarkFill = false; badFill.push(`t${ti}p${pi}:${p.fill}`); }
      if (!(lum(p.text) > 0.55)) { allLightText = false; badText.push(`t${ti}p${pi}:${p.text}`); }
    }
  }
  check('★ in dark mode every fill is dark (no white canvas)', allDarkFill, badFill.slice(0, 3).join(' '));
  check('★ in dark mode every text colour is light (no black text)', allLightText, badText.slice(0, 3).join(' '));
}

{
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  // Contrast: in dark mode the luminance gap between text and fill must be large enough, otherwise the text is unreadable
  let minDiff = 1;
  let where = '';
  for (const [ti, t] of MM_THEMES.entries()) {
    const d = themeToDark(t);
    const pals = d.branchColors ?? [{
      border: d.line, fill: d.nodeBg, line: d.line, text: d.text, badgeBg: d.line,
    }];
    for (const [pi, p] of pals.entries()) {
      const diff = Math.abs(lum(p.text) - lum(p.fill));
      if (diff < minDiff) { minDiff = diff; where = `t${ti}p${pi}`; }
    }
  }
  check(`★ in dark mode the text/fill luminance difference >= 0.2 (measured minimum ${minDiff.toFixed(3)} @${where})`,
    minDiff >= 0.2);
}

{
  console.log('  idempotence and edge cases of the dark conversion');
  const t = MM_THEMES[0];
  const once = themeToDark(t);
  const twice = themeToDark(once);
  // A second conversion should not restore the original (it is not an involution), but it must still be valid hex
  const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);
  check('a second conversion still produces a valid colour (no NaN / empty string)',
    (twice.branchColors ?? []).every((p) => [p.border, p.fill, p.line, p.text, p.badgeBg].every(isHex)));

  // The conversion must not modify the source theme (pure function)
  const before = JSON.stringify(MM_THEMES[0]);
  themeToDark(MM_THEMES[0]);
  check('★ themeToDark does not modify its argument (pure function)', JSON.stringify(MM_THEMES[0]) === before);
}

{
  // Invalid input must not be silently swallowed into an empty value —— on the SVG that becomes "no colour"
  const d = themeToDark({
    ...MM_THEMES[0],
    branchColors: [{ border: 'rgb(1,2,3)', fill: '#ABCDEF', line: 'transparent', text: '#000', badgeBg: '#fff' }],
  });
  check('non-hex input is kept as-is (it does not become undefined)', d.branchColors?.[0].border === 'rgb(1,2,3)');
  check('uppercase hex is handled too', /^#[0-9a-f]{6}$/.test(d.branchColors?.[0].fill ?? ''));
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ the dark conversion must be idempotent (an already-dark theme must not be converted again)');

{
  // This is the regression test for a **real defect** (fixed).
  //
  // The original implementation ran toDarkColor over every theme unconditionally, while toDarkColor is a "light→dark"
  // one-way transform. Converting the already-dark themeDark once more means flipping a dark background into a light one and
  // light text into dark text —— exactly the opposite.
  //
  // Measured: with the "dark" theme selected in dark SiYuan, a node background was computed as #b0b0d9 (luminance 0.71),
  // text colour #2a2a2a (luminance 0.17) —— a light canvas popping out of an entirely dark UI,
  // with the text almost invisible.
  //
  // Fix: if the background is already dark enough, return it as-is. The criterion is "luminance", not "does the theme name contain
  // dark" —— a theme name is for humans; luminance is what this is really about.
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };

  let allGood = true;
  const bad: string[] = [];
  for (const [ti, t] of MM_THEMES.entries()) {
    const d = themeToDark(t);
    const bg = lum(d.nodeBg);
    const fg = lum(d.text);
    // After conversion, whether the theme was light or dark, the result must be "dark background, light text"
    if (!(bg < 0.4)) { allGood = false; bad.push(`t${ti}(${t.nameKey}) bg=${d.nodeBg}/${bg.toFixed(2)}`); }
    if (!(fg > 0.55)) { allGood = false; bad.push(`t${ti}(${t.nameKey}) fg=${d.text}/${fg.toFixed(2)}`); }
  }
  check('★ after darkening every theme is dark background with light text (including the already-dark themeDark)', allGood, bad.slice(0, 4).join('; '));
}

{
  // The direct statement of idempotence: converting an already-dark theme again should leave it **completely unchanged**.
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  const darkThemes = MM_THEMES.filter((t) => lum(t.nodeBg) < 0.5);
  check('a theme that is already dark really exists (otherwise this test is meaningless)', darkThemes.length > 0);

  for (const [i, t] of darkThemes.entries()) {
    const once = themeToDark(t);
    check(`★ already-dark theme ${t.nameKey} is identical to the original after conversion`,
      JSON.stringify(once) === JSON.stringify(t));
    check(`★ already-dark theme ${t.nameKey} is still itself after a second conversion`,
      JSON.stringify(themeToDark(once)) === JSON.stringify(once));
  }
}

{
  // A light theme must **really be converted** (the idempotence guard must not skip it)
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  const lightThemes = MM_THEMES.filter((t) => lum(t.nodeBg) >= 0.5);
  check('a light theme really exists', lightThemes.length > 0);
  for (const t of lightThemes) {
    const d = themeToDark(t);
    check(`★ light theme ${t.nameKey} really is converted (its background gets darker)`,
      lum(d.nodeBg) < lum(t.nodeBg));
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthemes: structure and keywords');

{
  check('the number of themes is 8', MM_THEMES.length === 8);
  let ok = true;
  const bad: string[] = [];
  for (const t of MM_THEMES) {
    // The field is nameKey (an i18n entry name), not key
    if (typeof t.nameKey !== 'string' || !t.nameKey) { ok = false; bad.push('nameKey'); }
    // branchColors is **optional**: a monochrome theme has none, and the render layer falls back to nodeBg/text
    if (t.branchColors !== undefined && !Array.isArray(t.branchColors)) { ok = false; bad.push('branchColors'); }
    if (typeof t.bg !== 'string' || typeof t.rootBg !== 'string') { ok = false; bad.push('bg'); }
    if (typeof t.nodeBg !== 'string' || typeof t.text !== 'string') { ok = false; bad.push('nodeBg/text'); }
  }
  check('★ every theme has nameKey / bg / rootBg / nodeBg / text', ok, bad.join(' '));
}

{
  const keys = MM_THEMES.map((t) => t.nameKey);
  check('★ theme nameKeys are unique (the dropdown distinguishes entries by them)', new Set(keys).size === keys.length);
}

{
  check('at least one theme uses a multi-colour palette (otherwise the 8 branchColors palettes are dead code)',
    MM_THEMES.some((t) => (t.branchColors?.length ?? 0) > 0));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nshapes: 7 of them, and unknown input has a definite fallback');

{
  check('the number of shapes is 7', Object.keys(MM_SHAPE_KEYS).length === 7);
  const names: MmTopicShape[] = ['roundedRect', 'rect', 'arcRect', 'underline', 'hexagon', 'hexagon2', 'tag'];
  let ok = true;
  for (const n of names) {
    if (!(n in MM_SHAPE_KEYS)) ok = false;
    if (!MM_SHAPE_KEYS[n]) ok = false;
  }
  check('★ all 7 shapes have a key and a display name', ok);
}

{
  // normalizeShape is the entry point for "reading back from settings". Settings may come from an older version,
  // hand-edited JSON, or have been overwritten by something else —— an unknown value must have a definite fallback,
  // and undefined must not travel all the way into the SVG geometry branches.
  // The fallback value is underline (following the official globalShape), not roundedRect.
  // This does not hardcode the concrete value; it asserts that "the fallback result is itself a valid shape and is stable" ——
  // which one exactly is a product decision (it may change again), but it **must be definite and valid**.
  const fallback = normalizeShape('空节点二');
  check('★ an unknown shape has a definite fallback (not undefined)', typeof fallback === 'string' && fallback.length > 0);
  check('★ the fallback value itself is a valid shape', normalizeShape(fallback) === fallback);
  check('undefined falls back the same way as an unknown value', normalizeShape(undefined) === fallback);
  check('null falls back the same way as an unknown value', normalizeShape(null) === fallback);
  check('a number falls back the same way as an unknown value', normalizeShape(123) === fallback);
  check('an object falls back the same way as an unknown value', normalizeShape({}) === fallback);
  check('★ the fallback never returns undefined (otherwise the SVG has no geometry branch)', fallback !== undefined && fallback !== null);
  check('a valid value is returned as-is', normalizeShape('hexagon') === 'hexagon');
  check('★ the fallback result is stable (repeated calls agree)',
    normalizeShape('???') === fallback && normalizeShape('???') === fallback);
}

{
  // The other three preferences are read from the same localStorage record as `shape`, and used to be
  // taken on trust: `structure`/`lineStyle` were cast straight into their unions and `themeIdx` into a
  // number, so `{"structure":"tree"}` reached the layout as a `MmStructure` no branch handles.
  // Each validator now answers "is this a member of the union" and returns the caller's fallback if not.
  console.log('\npreference validators: a stored value is a member of its union or the fallback');

  check('★ an unknown structure falls back', normalizeStructure('tree', 'balanced') === 'balanced');
  check('an absent structure falls back', normalizeStructure(undefined, 'balanced') === 'balanced');
  check('a number as a structure falls back', normalizeStructure(3, 'balanced') === 'balanced');
  check('an object as a structure falls back', normalizeStructure({}, 'balanced') === 'balanced');
  check('a valid structure is returned as-is', normalizeStructure('org', 'balanced') === 'org');
  check('★ the caller\'s fallback is what comes back, not a fixed one',
    normalizeStructure('???', 'timeline') === 'timeline');

  check('★ an unknown line style falls back', normalizeLineStyle('wavy', 'curve') === 'curve');
  check('an absent line style falls back', normalizeLineStyle(undefined, 'curve') === 'curve');
  check('a valid line style is returned as-is', normalizeLineStyle('straight', 'curve') === 'straight');

  check('★ a theme index outside the list falls back', normalizeThemeIdx(MM_THEMES.length, 0) === 0);
  check('a negative theme index falls back', normalizeThemeIdx(-1, 0) === 0);
  check('a fractional theme index falls back', normalizeThemeIdx(1.5, 0) === 0);
  check('NaN falls back', normalizeThemeIdx(Number.NaN, 0) === 0);
  check('a numeric string falls back (JSON can hold one)', normalizeThemeIdx('1', 0) === 0);
  check('an absent theme index falls back', normalizeThemeIdx(undefined, 2) === 2);
  check('★ the last valid theme index is accepted', normalizeThemeIdx(MM_THEMES.length - 1, 0) === MM_THEMES.length - 1);
  check('a valid theme index is returned as-is', normalizeThemeIdx(1, 0) === 1);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nlayout: all 6 structures produce valid coordinates');

{
  const tree = [N('root', '根', [N('a', '甲'), N('b', '乙', [N('b1', '节点八')])])];
  const structures: MmStructure[] = ['balanced', 'right', 'left', 'org', 'timeline'];

  for (const s of structures) {
    const empty = new Set<string>();
    let lay;
    try {
      lay = s === 'org' ? layoutOrg(tree, empty) : layoutHorizontal(tree, s, empty);
    } catch (e) {
      check(`structure ${s} should not throw`, false, String(e));
      continue;
    }
    const boxes = lay.boxes;
    check(`structure ${s}: produced node boxes`, boxes.length > 0);

    // Coordinates must be finite numbers —— NaN makes the whole SVG element disappear, and **raises nothing**
    const finite = boxes.every((b) =>
      [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v)));
    check(`★ structure ${s}: all coordinates are finite numbers (NaN makes nodes silently disappear)`, finite);

    // Width and height must be positive
    const positive = boxes.every((b) => b.w > 0 && b.h > 0);
    check(`★ structure ${s}: width and height are both positive`, positive);
  }
}

{
  console.log('  nodes do not overlap (overlap is invisible in DOM measurements; only drawing reveals it)');
  const tree = [N('root', '根', [N('a', '甲'), N('b', '乙'), N('c', '丙')])];
  const lay = layoutHorizontal(tree, 'right', new Set<string>());
  let overlaps = 0;
  const boxes = lay.boxes;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (hit) overlaps++;
    }
  }
  check('★ three sibling nodes do not overlap each other', overlaps === 0, `${overlaps} overlapping pairs`);
}

{
  // ★★★ Sibling subtrees each holding exactly ONE child —— the shape that produced a staircase.
  //
  //   `subtreeH` decided how tall a subtree is, and the layout stacks those bands to place siblings. For a
  //   node with a single child it returned the **child's** band alone, ignoring that `childCyOf` forces the
  //   child *below* its parent (a chain must descend, or `a > b > c > d` draws as one flat line). So the band
  //   under-reported the extent by one node height per chain level, and each chain child spilled into the
  //   next sibling's space. Measured on the built plugin, three parents each holding one child:
  //
  //       父一 y=345 · 子节点一 y=374 · 父二 y=374 · 子节点二 y=403 · 父三 y=403 · 子节点三 y=432
  //
  //   —— one descending step per node instead of three level rows of two.
  //
  //   The three-child check above could not see it: with siblings that have no children, centring already
  //   separates them and no forced descent happens. A shape is only covered when the *forcing* path runs,
  //   which is why this case is its own block rather than another assertion in that one.
  console.log('  a single-child subtree reserves the band it actually draws');
  const chainTree = [
    N('root', '根', [
      N('p1', '父一', [N('c1', '子节点一')]),
      N('p2', '父二', [N('c2', '子节点二')]),
      N('p3', '父三', [N('c3', '子节点三')]),
    ]),
  ];
  const chainLay = layoutHorizontal(chainTree, 'right', new Set<string>());

  // (a) no two boxes overlap anywhere
  let chainOverlaps = 0;
  const cb = chainLay.boxes;
  for (let i = 0; i < cb.length; i++) {
    for (let j = i + 1; j < cb.length; j++) {
      const a = cb[i], b = cb[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) chainOverlaps++;
    }
  }
  // ★★★ The assertion that actually distinguishes correct from staircase: **no two nodes share a y**.
  //
  //   The staircase is *evenly spaced*, so an "are the siblings evenly spaced?" check passes on it —— the
  //   bug satisfies that property. Boxes also do not overlap, because a parent and the previous sibling's
  //   child land in **different x columns**. Measured on the buggy build, the whole defect is one number:
  //
  //       父一 y=345 · 子节点一 y=374 · 父二 y=374 · 子节点二 y=403 · 父三 y=403 · 子节点三 y=432
  //                              ^^^^ shares its y with 子节点一          ^^^^ shares its y with 子节点二
  //
  //   A parent drawn level with the previous sibling's child is the thing a reader sees as "the children
  //   drifted down", and it is the thing this pins. Two earlier versions of this check were written and
  //   thrown away because they passed on the bug: an overlap scan (different columns), and an even-spacing
  //   scan (the staircase is even). Both are recorded here so the next person does not re-derive them.
  // ★★ The invariant: each sibling's subtree occupies its own vertical range, so reading down the page
  //    alternates parent → child → next parent → its child. Measured with the fix:
  //
  //       父一 60 · 子节点一 108 · 父二 139 · 子节点二 187 · 父三 218 · 子节点三 266
  //
  //    and with the bug (one band too short per level):
  //
  //       父一 60 · 子节点一 108 · 父二 108 · 子节点二 156 · 父三 156 · 子节点三 204
  //
  //    —— in the buggy one, 父二 is drawn **level with 子节点一**. That is what "the children drifted down"
  //    looks like: every node takes one step, so a subtree's child ends up beside the next subtree's parent.
  //
  //    ★ The root is excluded, and legitimately so: it is centred over its **entire** band, so it can share
  //      a y with a descendant. That is centring working, not a defect —— and including it here was a third
  //      wrong assertion, caught before keeping it.
  //
  //    ★ Two earlier versions of this check were thrown away because they passed on the bug: an overlap scan
  //      (a parent and the previous child are in different x columns, so they never "overlap"), and an
  //      even-spacing scan (the staircase is *perfectly* evenly spaced — 48, 48). Both are recorded so the
  //      next person does not re-derive them.
  // Each depth-1 parent and its only child are parallel (share the exact same y level):
  const at = (id: string) => cb.find((b) => b.id.startsWith(id + ':'))!.y;
  check(
    '★★ each single child is parallel with its parent (same y)',
    at('p1') === at('c1') && at('p2') === at('c2') && at('p3') === at('c3'),
    `p1=${at('p1')}, c1=${at('c1')}, p2=${at('p2')}, c2=${at('c2')}, p3=${at('p3')}, c3=${at('c3')}`,
  );

  check(
    '★★ sibling parent rows are ordered down the page with separation',
    at('p1') < at('p2') && at('p2') < at('p3'),
  );

  check('★★ no two boxes overlap in sibling rows of single-child parents', chainOverlaps === 0);
}

{
  console.log('  a collapsed subtree does not appear in the layout');
  const tree = [N('root', '根', [N('a', '甲', [N('a1', '节点一')])])];
  const open = layoutHorizontal(tree, 'right', new Set<string>());
  const collapsed = layoutHorizontal(tree, 'right', new Set(['a']));
  check('★ collapsing yields fewer nodes', collapsed.boxes.length < open.boxes.length);
  // ★ Note: Box.id is a **path string** (like "root:0:0"), not a node id.
  //   The real node id is at box.node.id —— comparing with b.id will never match.
  const nodeIds = (l: { boxes: { node: OutlineNode }[] }) => l.boxes.map((b) => b.node.id);
  check('the children of a collapsed node do not appear', !nodeIds(collapsed).includes('a1'));
  check('★ the collapsed node itself is still there (only its children are hidden)', nodeIds(collapsed).includes('a'));
}

{
  console.log('  empty tree / single node does not crash');
  for (const s of ['balanced', 'right', 'left', 'org', 'timeline'] as MmStructure[]) {
    try {
      const lay = s === 'org' ? layoutOrg([], new Set()) : layoutHorizontal([], s, new Set());
      check(`empty tree ${s}: does not crash and boxes is empty`, lay.boxes.length === 0);
    } catch (e) {
      check(`empty tree ${s} does not throw`, false, String(e));
    }
  }
  const single = layoutHorizontal([N('only', '仅')], 'balanced', new Set());
  check('single node: produces one box', single.boxes.length === 1);
}

{
  console.log('  the left structure is the horizontal mirror of right (left/right split semantics)');
  const tree = [N('root', '根', [N('a', '甲'), N('b', '乙')])];
  const r = layoutHorizontal(tree, 'right', new Set());
  const l = layoutHorizontal(tree, 'left', new Set());
  check('both structures have the same node count', r.boxes.length === l.boxes.length);
  // The root is horizontally centred: in the left structure the children should be to the left of the root
  // Same as above: find nodes with box.node.id, not box.id
  const rootR = r.boxes.find((b) => b.node.id === 'root');
  const childR = r.boxes.find((b) => b.node.id === 'a');
  const rootL = l.boxes.find((b) => b.node.id === 'root');
  const childL = l.boxes.find((b) => b.node.id === 'a');
  if (rootR && childR && rootL && childL) {
    check('★ right: the child node is to the right of the root', childR.x > rootR.x);
    check('★ left: the child node is to the left of the root', childL.x < rootL.x);
  } else {
    check('both layouts can locate the root and the child', false);
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\ncalcSplitIndex: the split point for left/right branching');

{
  const nodes = [N('a'), N('b'), N('c'), N('d')];
  const empty = new Set<string>();
  const idx = calcSplitIndex(nodes, empty);
  check('the split index is within [0, len]', idx >= 0 && idx <= nodes.length);
  check('an empty list splits at 0', calcSplitIndex([], empty) === 0);
  check('single node', calcSplitIndex([N('a')], empty) >= 0);
}

{
  // The split index must be stable: the same input yields the same value on repeated calls (otherwise nodes jump left/right on every redraw)
  const nodes = [N('a'), N('b'), N('c')];
  const once = calcSplitIndex(nodes, new Set());
  let stable = true;
  for (let i = 0; i < 5; i++) {
    if (calcSplitIndex(nodes, new Set()) !== once) stable = false;
  }
  check('★ the split index is stable (instability makes nodes jump left/right on every redraw)', stable);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ the export writes the product\'s wording, not an empty attribute');

{
  // ★ The two copies used to default to `''`, and the single caller passed `undefined`, so a node with no
  //   text was exported as `TEXT=""` and a map with no title likewise —— an empty attribute in the file,
  //   where the product shows a label on screen. The parameters are required now, so a caller cannot omit
  //   them; these cases pin that the copies are really used.
  const xml = exportFreemind([N('a', '')], '', '(untitled)', 'Untitled');
  check('★ a node with no text exports the supplied node copy',
    xml.includes('TEXT="(untitled)"'), xml);
  check('★ a map with no title exports the supplied map copy',
    xml.includes('TEXT="Untitled"'), xml);
  check('★ … and no empty TEXT attribute is written at all',
    !/TEXT=""(\s|>)/.test(xml), xml);

  // The opposite direction: real text is exported as it is, with no fallback mixed in.
  const named = exportFreemind([N('a', '文本')], '标题', '(untitled)', 'Untitled');
  check('a real title and node text are exported unchanged',
    named.includes('TEXT="标题"') && named.includes('TEXT="文本"'), named);

  // Attached paragraphs export to FreeMind note richcontent with unescaped <br> and escaped text
  const withNotes = exportFreemind(
    [{ ...N('a', '节点'), paragraphs: ['段落一', '段落二 <test>'] }],
    '标题',
    '(untitled)',
    'Untitled',
    ['文档段落一', '文档段落二 & extra'],
  );
  check('★ root note contains unescaped <br> and escaped text in richcontent',
    withNotes.includes('文档段落一<br>文档段落二 &amp; extra'), withNotes);
  check('★ node note contains unescaped <br> and escaped text in richcontent',
    withNotes.includes('段落一<br>段落二 &lt;test&gt;'), withNotes);
  check('★ richcontent does not contain literal &lt;br&gt;',
    !withNotes.includes('&lt;br&gt;'), withNotes);
}

console.log('\n★ a formula keeps its own run (it is drawn whole, so it must not be merged away)');

{
  // ★ This is the product path for the merge criterion: `runsOf` calls `mergeRuns`, and `mergeRuns` used to
  //   test the `formula` flag on the first run only. A formula whose styles matched the plain run before it
  //   was then merged in and lost the flag, after which `units()` split the `$…$` at word boundaries —— so a
  //   formula wider than the line was cut in half, which `units` documents as never happening.
  const runs = runsOf(N('x', '文本<span data-formula="x^2">$x^2$</span>'));
  check('★ a formula stays its own run through runsOf', runs.length === 2,
    `len=${runs.length} ${JSON.stringify(runs)}`);
  check('★ … and it still carries the formula flag',
    runs.filter((r) => r.formula === true).length === 1, JSON.stringify(runs));
  check('★ … and the plain run before it is untouched',
    runs[0]?.formula === undefined && runs[0]?.text === '文本', JSON.stringify(runs[0]));
}

console.log('\ntext measurement and runsOf');

{
  check('label takes text', label(N('x', '文字')) === '文字');
  check('an empty text does not crash', typeof label(N('x', '')) === 'string');
  const w1 = widthOf(N('x', '短'));
  const w2 = widthOf(N('x', '长'.repeat(50)));
  check('★ longer text is wider (otherwise it overflows onto other nodes)', w2 > w1);
  check('the width is a finite positive number', Number.isFinite(w1) && w1 > 0);
}

{
  // ★ A label wraps instead of being cut, and the box grows with it: the line count is what the height
  //   (and therefore the whole tree's spacing) is derived from.
  const short = measureNode(N('x', '短'));
  const longText = '长'.repeat(60);
  const longNode = N('x', longText);
  const long = measureNode(longNode);
  check('a short label is one line', short.lines.length === 1, String(short.lines.length));
  check('a short label keeps the single-line height (34)', short.h === 34, String(short.h));
  // 320px box minus the 32px padding is 288px of text; at 15px per CJK character that is 19 per line,
  // so 60 characters need four lines.
  check('a long label wraps into several lines', long.lines.length === 4, String(long.lines.length));
  check('the box grows with the lines', long.h > short.h, `${long.h} vs ${short.h}`);
  check(
    'no line is wider than the wrap target',
    long.lines.every((l) => l.width <= 320 - 32),
    JSON.stringify(long.lines.map((l) => l.width)),
  );
  check(
    '★ wrapping loses no character (a cut label hides the node text from the reader)',
    long.lines.map((l) => l.runs.map((r) => r.text).join('')).join('') === longText,
  );
  check('the width stays inside the box limits', long.w <= 320 && long.w >= 70, String(long.w));

  // The tree maths must use each node's own height, or a tall node overlaps its siblings
  const tree = N('root', 'R', [longNode, N('b', 'B', [])]);
  const boxed = layoutHorizontal([tree], 'right', new Set<string>());
  check(
    'every box carries the lines it was sized for',
    boxed.boxes.every((b) => Array.isArray(b.lines) && b.lines.length >= 1),
  );
  const overlap = (a: (typeof boxed.boxes)[number], b: (typeof boxed.boxes)[number]) =>
    a.side === b.side && a.y < b.y + b.h && b.y < a.y + a.h && a.x < b.x + b.w && b.x < a.x + a.w;
  const clashes = boxed.boxes.filter((a, i) => boxed.boxes.slice(i + 1).some((b) => overlap(a, b)));
  check('no two nodes on the same side overlap after wrapping', clashes.length === 0, JSON.stringify(clashes.map((b) => b.label)));
}

{
  const r = runsOf(N('x', '文本二'));
  check('runsOf returns an array', Array.isArray(r));
  check('plain text produces at least one run', r.length >= 1);
  check('does not throw: empty text', Array.isArray(runsOf(N('x', ''))));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nedgePath: all three line styles produce a valid SVG path');

{
  const e = { from: 'a', to: 'b', x1: 0, y1: 0, x2: 100, y2: 50 };
  for (const style of ['curve', 'rounded', 'straight'] as const) {
    for (const vertical of [true, false]) {
      let d = '';
      try {
        d = edgePath(e as never, vertical, style);
      } catch (err) {
        check(`line style ${style} vertical=${vertical} does not throw`, false, String(err));
        continue;
      }
      check(`${style} vertical=${vertical}: non-empty path`, typeof d === 'string' && d.length > 0);
      // NaN makes the whole line disappear without raising anything
      check(`★ ${style} vertical=${vertical}: the path contains no NaN`, !d.includes('NaN'));
      check(`★ ${style} vertical=${vertical}: the path contains no undefined`, !d.includes('undefined'));
    }
  }
  check('different line styles produce different paths', edgePath(e as never, false, 'curve') !== edgePath(e as never, false, 'straight'));
}

{
  // Degenerate case: start and end coincide; it must not produce NaN
  const same = { from: 'a', to: 'b', x1: 10, y1: 10, x2: 10, y2: 10 };
  for (const style of ['curve', 'rounded', 'straight'] as const) {
    const d = edgePath(same as never, false, style);
    check(`★ start and end coincide (${style}) produces no NaN`, !d.includes('NaN'));
  }
}


{
  console.log('  ★ a single-child chain is parallel horizontally (same vertical level)');
  const chain = [N('a', 'a', [N('b', 'b', [N('c', 'c', [N('d', 'd')])])])];
  for (const mode of ['balanced', 'right', 'left', 'timeline'] as const) {
    const lay = layoutHorizontal(chain, mode, new Set<string>());
    const byId = new Map(lay.boxes.map((b) => [b.node.id, b]));
    const order = ['a', 'b', 'c', 'd'];
    const ys = order.map((id) => byId.get(id)?.y ?? NaN);
    const sameY = ys.every((y) => Math.abs(y - ys[0]) < 1e-4);
    check(
      `${mode}: each level of a single-child chain is parallel with the one before it (measured y: ${ys.join(', ')})`,
      sameY,
    );
    // And nothing may overlap:
    let overlaps = 0;
    for (let i = 0; i < lay.boxes.length; i++) {
      for (let j = i + 1; j < lay.boxes.length; j++) {
        const a = lay.boxes[i], b = lay.boxes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
      }
    }
    check(`${mode}: no two boxes overlap in a chain`, overlaps === 0);
  }

  // A taller parent's single child stays vertically centered on it
  {
    for (const lines of [1, 2, 3]) {
      const long = 'x'.repeat(lines * 30);
      const lay = layoutHorizontal([N('p', long, [N('c', 'child')])], 'right', new Set<string>());
      const by = new Map(lay.boxes.map((b) => [b.node.id, b]));
      const p = by.get('p')!, c = by.get('c')!;
      const parentCy = p.y + p.h / 2;
      const childCy = c.y + c.h / 2;
      check(
        `parent with ${lines} line(s) keeps its only child vertically centered (cy diff: ${Math.abs(parentCy - childCy).toFixed(3)})`,
        Math.abs(parentCy - childCy) < 1e-4,
      );
    }
  }

  // The other half: siblings must still spread **around** the parent, not be pushed below it.
  const tree = [N('p', 'p', [N('c1', 'c1'), N('c2', 'c2'), N('c3', 'c3')])];
  const lay = layoutHorizontal(tree, 'right', new Set<string>());
  const byId = new Map(lay.boxes.map((b) => [b.node.id, b]));
  const p = byId.get('p')!, kids = ['c1', 'c2', 'c3'].map((id) => byId.get(id)!);
  check(
    'a parent with three children still keeps the tree shape (some children above, some below the parent)',
    kids[0].y < p.y && kids[2].y > p.y,
  );
  check('the middle child is the one centred on the parent', Math.abs(kids[1].y - p.y) === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
