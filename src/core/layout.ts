// Mind map layout algorithm and theme definitions (pure logic).
// This file must NOT import React, DOM or any storage API (localStorage/indexedDB).

import type { OutlineNode } from '../model/types';
import { findNode, htmlToText } from '../model/tree';
import { htmlToRuns, mergeRuns, wrapRuns, type RichRun, type WrappedLine } from './richtext';
import { TASK_DONE, TASK_TODO } from '../model/types';

/**
 * The **phone** breakpoint: at or below this viewport width the layout is the mobile one.
 *
 * ★ One named constant, because the same 768 was a bare literal in six places in the outline, in
 *   `src/styles.css`'s media queries, and in a test that re-declared it (`keyboard-offset.test.ts`) ——
 *   a rule expressed four times is four rules that can drift apart, and the CSS one cannot be imported.
 *
 *   It decides things the **dock width cannot**: on a phone the dock still measures about 420px wide, so
 *   a width-only rule answers "wide screen" and leaves an expanded toolbar covering the mobile keyboard
 *   bar (measured: a 390px viewport, dock 420px, toolbar expanded).
 */
export const MOBILE_MAX_WIDTH = 768;

export type MmStructure = 'balanced' | 'right' | 'left' | 'org' | 'timeline';
export type MmLineStyle = 'curve' | 'rounded' | 'straight';

// Theme shape (local rendering semantics only; never written to the document).
export type MmTopicShape = 'roundedRect' | 'rect' | 'arcRect' | 'underline' | 'hexagon' | 'hexagon2' | 'tag';

/**
 * Shape → i18n entry name.
 *
 * ★ This file is the **pure logic layer** (importing React is forbidden), so it stores no copy, only keys,
 *   and the render layer looks the copy up with `t()`. Changing the copy language requires no change here.
 */
export const MM_SHAPE_KEYS: Record<MmTopicShape, string> = {
  roundedRect: 'shapeRoundedRect',
  rect: 'shapeRect',
  arcRect: 'shapeArcRect',
  underline: 'shapeUnderline',
  hexagon: 'shapeHexagon',
  hexagon2: 'shapeHexagon2',
  tag: 'shapeTag',
};

/** @deprecated use `MM_SHAPE_KEYS` + `t()`; kept only for compatibility with old references */
export const MM_SHAPE_LABELS = MM_SHAPE_KEYS;

const VALID_SHAPES: MmTopicShape[] = ['roundedRect', 'rect', 'arcRect', 'underline', 'hexagon', 'hexagon2', 'tag'];

export function normalizeShape(s: unknown): MmTopicShape {
  // Defaults to the official globalShape:"underline" (single author; rounded corners are no longer kept for the old look)
  return (VALID_SHAPES as string[]).includes(s as string) ? (s as MmTopicShape) : 'underline';
}

export interface BranchPalette {
  border: string;
  fill: string;
  line: string;
  text: string;
  badgeBg: string;
}

export interface MmTheme {
  /** i18n entry name (the render layer looks it up with `t(nameKey)`) */
  nameKey: string;
  bg: string;
  rootBg: string;
  rootText: string;
  nodeBg: string;
  line: string;
  text: string;
  isColorful?: boolean;
  branchColors?: BranchPalette[];
}

export const MM_BRANCH_PALETTES: BranchPalette[] = [
  { border: '#4a5ee0', fill: '#eef0fd', line: '#4a5ee0', text: '#232b7a', badgeBg: '#4a5ee0' }, // blue
  { border: '#0f9d76', fill: '#edfcf5', line: '#0f9d76', text: '#0a4f3b', badgeBg: '#0f9d76' }, // green
  { border: '#ea7317', fill: '#fff6ed', line: '#ea7317', text: '#682e05', badgeBg: '#ea7317' }, // orange
  { border: '#7b3ee6', fill: '#f6f0fe', line: '#7b3ee6', text: '#431987', badgeBg: '#7b3ee6' }, // purple
  { border: '#e5486f', fill: '#fff0f4', line: '#e5486f', text: '#6e1a30', badgeBg: '#e5486f' }, // pink
  { border: '#009688', fill: '#e6f7f5', line: '#009688', text: '#004d40', badgeBg: '#009688' }, // teal
  { border: '#d97706', fill: '#fef7e7', line: '#d97706', text: '#78350f', badgeBg: '#d97706' }, // gold
  { border: '#0284c7', fill: '#f0f9ff', line: '#0284c7', text: '#0c4a6e', badgeBg: '#0284c7' }, // sky blue
];

/**
 * Convert light colour schemes into dark variants for dark mode.
 *
 * Mind map node colours are **painted inside the SVG** (not CSS), so changing the stylesheet does nothing ——
 * The conversion has to happen here, otherwise you get "grey background with black text" and "a white canvas inside a dark UI".
 *
 * Conversion rules (keep the hue, flip the lightness):
 * - a very light fill colour (like `#f0f5ff`) → darkened into a dark background
 * - a very dark foreground colour (like `#143c8a`) → lightened into light text
 * - neutral white/black → inverted directly
 *
 * A separate hand-maintained dark theme is not used because there are 8 palettes × several fields,
 * which is easy to get wrong by hand, and every future theme would have to be changed in two places.
 */
function relativeLum(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  // Non-hex values (rgb() / transparent / empty) are treated as 0.5 —— that is, "cannot tell",
  // so the caller takes the neutral branch instead of assuming "definitely dark" or "definitely light".
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function toDarkColor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex; // Anything that is not 6-digit hex (transparent/rgb() included) is returned as-is
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // Relative luminance (sRGB approximation)
  const lum = relativeLum(hex);

  // Keep the hue, adjust only the lightness: in dark mode use "same hue + low lightness" for the background,
  // in light mode use "same hue + high lightness" for the text.
  const hsl = rgbToHsl(r, g, b);
  if (lum > 0.72) {
    // Light → dark background (lightness pushed down to 0.16~0.22, keeping a hint of hue)
    const l = 0.16 + (1 - lum) * 0.06;
    return hslToHex(hsl.h, Math.min(hsl.s, 0.45), l);
  }
  if (lum < 0.32) {
    // Dark → light text (lightness raised above 0.72 to keep contrast)
    const l = 0.74 + (0.32 - lum) * 0.2;
    return hslToHex(hsl.h, Math.max(hsl.s * 0.7, 0.35), Math.min(l, 0.92));
  }
  // Mid tones (line colours etc.): just lighten them a little
  const l = Math.min(0.62 + (0.5 - lum) * 0.15, 0.78);
  return hslToHex(hsl.h, hsl.s, l);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Convert a whole palette into its dark version */
function paletteToDark(p: BranchPalette): BranchPalette {
  return {
    border: toDarkColor(p.border),
    fill: toDarkColor(p.fill),
    line: toDarkColor(p.line),
    text: toDarkColor(p.text),
    badgeBg: toDarkColor(p.badgeBg),
  };
}

/**
 * Convert a whole theme into its dark version.
 *
 * ★ Idempotent: a theme that is already dark is **returned as-is**, with no second conversion (fixed).
 *
 *   Previously it ran `toDarkColor` over every theme unconditionally. `toDarkColor` is a "light→dark"
 *   one-way transform (light colours darkened, dark colours lightened), so converting an already-dark theme once more means
 *   flipping a dark background into a light one and light text into dark text —— exactly the opposite.
 *
 *   Measured: with the "dark" theme selected in dark SiYuan (themeDark, nodeBg=#2c2c2e, luminance 0.17)
 *   it was converted into nodeBg=#b0b0d9 (luminance 0.71) + text=#2a2a2a (luminance 0.17),
 *   that is, **light background with dark text** —— a light canvas suddenly appearing in an entirely dark UI,
 *   with the text almost invisible.
 *
 *   The criterion is "is the background already dark enough", not "does the theme name contain dark":
 *   a theme name is for humans and may be renamed later, while "background luminance" is the **essence** here ——
 *   whether to convert depends on whether it is light right now. Adding a theme needs no remembering to come back and add a special case.
 */
export function themeToDark(t: MmTheme): MmTheme {
  // Dark enough means no conversion (see above). 0.5 is the natural light/dark boundary:
  // ordinary light backgrounds (#ffffff/#f5f7fa) all have a luminance above 0.9,
  // dark backgrounds (#2c2c2e/#1e1e20) are all below 0.2, and nothing in between actually occurs.
  if (relativeLum(t.nodeBg) < 0.5) return t;
  return {
    ...t,
    bg: toDarkColor(t.bg),
    rootBg: toDarkColor(t.rootBg),
    rootText: toDarkColor(t.rootText),
    nodeBg: toDarkColor(t.nodeBg),
    line: toDarkColor(t.line),
    text: toDarkColor(t.text),
    ...(t.branchColors ? { branchColors: t.branchColors.map(paletteToDark) } : {}),
  };
}

export const MM_THEMES: MmTheme[] = [
  {
    nameKey: 'themeColorful',
    bg: '#ffffff',
    rootBg: '#4a5ee0',
    rootText: '#ffffff',
    nodeBg: '#f6f7fb',
    line: '#4a5ee0',
    text: '#20232b',
    isColorful: true,
    branchColors: MM_BRANCH_PALETTES,
  },
  {
    nameKey: 'themeMono',
    bg: '#f5f6f8',
    rootBg: '#19191c',
    rootText: '#ffffff',
    nodeBg: '#ffffff',
    line: '#c8cdd6',
    text: '#19191c',
  },
  {
    nameKey: 'themeSlate',
    bg: '#f2f4f8',
    rootBg: '#38414f',
    rootText: '#f2f4f8',
    nodeBg: '#ffffff',
    line: '#94a0b0',
    text: '#38414f',
  },
  {
    nameKey: 'themeBrown',
    bg: '#fafaf9',
    rootBg: '#715c42',
    rootText: '#ffffff',
    nodeBg: '#f5f4f1',
    line: '#b5a695',
    text: '#3d3428',
  },
  {
    nameKey: 'themeGreen',
    bg: '#fcfefc',
    rootBg: '#0f9d76',
    rootText: '#ffffff',
    nodeBg: '#f0f9f5',
    line: '#569152',
    text: '#12372a',
  },
  {
    nameKey: 'themeOrange',
    bg: '#fefdfc',
    rootBg: '#db6d2e',
    rootText: '#ffffff',
    nodeBg: '#fff7f2',
    line: '#ea7317',
    text: '#3b1d07',
  },
  {
    nameKey: 'themeBlue',
    bg: '#f4f9fc',
    rootBg: '#1784db',
    rootText: '#ffffff',
    nodeBg: '#eef6fc',
    line: '#1784db',
    text: '#0d3251',
  },
  {
    nameKey: 'themeDark',
    bg: '#1a1c22',
    rootBg: '#5a7cf5',
    rootText: '#ffffff',
    nodeBg: '#2c2c2e',
    line: '#4a5a8a',
    text: '#e8e8e8',
  },
];

export interface Box {
  id: string;
  label: string;
  /**
   * A run that keeps inline formatting (colour / bold / italic…).
   *
   * `label` is its plain-text form (used for width estimation, export and the `<title>` tooltip);
   * Rendering must draw each one with `runs` as a `<tspan>` —— the SVG `<text>` `fill`
   * is an element-level attribute, one element can only have one colour, so multiple colours require `tspan`.
   * Conversely: as long as rendering uses `label`, the formatting is necessarily lost.
   */
  runs: RichRun[];
  /**
   * The same runs broken into the lines this box was **sized** for. The renderer draws these, so there
   * is one wrapping decision for both —— the view must not wrap again (a second authority would let the
   * text disagree with the box it was measured for).
   */
  lines: WrappedLine[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  branchIdx: number;
  side: 1 | -1 | 0;
  node: OutlineNode;
  isCollapsed?: boolean;
  childCount?: number;
}

export interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  side: 1 | -1 | 0;
  branchIdx: number;
}

/** One line of node text, plus the padding above and below the text block. */
const NODE_LINE_H = 22;
const NODE_PAD_V = 12;
/** Height of a one-line node (22 + 12 = 34, the height the tree maths used to assume for every node). */
const NODE_MIN_H = NODE_LINE_H + NODE_PAD_V;
/** A label wraps inside this width and may take as many lines as it needs. */
const NODE_MAX_W = 320;
const NODE_MIN_W = 70;
const H_GAP = 56;
const V_GAP = 14;

/** A node's display runs: keep inline formatting and merge the due date into the last run. */
export function runsOf(n: OutlineNode): RichRun[] {
  // First parse the HTML into styled runs
  const runs = htmlToRuns(n.text);
  // Normalise whitespace: stay consistent with `label()`'s `\s+ → ' '`, otherwise
  // the width estimate (using label) and the actual rendering (using runs) drift apart
  for (const r of runs) r.text = r.text.replace(/\s+/g, ' ');
  // Merge adjacent runs with the same style —— the criterion comes from `mergeRuns` in core/richtext.
  // ★ Do not write a second merge loop here: with two criteria, any future new style bit
  //   (superscript / highlight…) will miss one of them, showing up as "some format bleeds colour in the mind map".
  const merged = mergeRuns(runs);
  // Trim leading/trailing whitespace (keep the middle, e.g. the space between two runs)
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^\s+/, '');
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, '');
  }
  const kept = merged.filter((r) => r.text !== '');
  if (kept.length === 0) kept.push({ text: '\u200b' });

  return kept;
}

export function label(n: OutlineNode): string {
  const t = htmlToText(n.text).replace(/\s+/g, ' ').trim();
  return (t || '\u200b').slice(0, 60);
}

/** A character's width in the layout's units: CJK is roughly twice a Latin character. */
function charWidth(ch: string): number {
  return ch.charCodeAt(0) > 255 ? 15 : 8;
}

/**
 * Wrap runs to an explicit width using this module's estimator —— for text drawn outside a node box
 * (the branch summary label), which still must break by the same units the nodes are measured in.
 */
export function wrapForWidth(runs: RichRun[], maxWidth: number): WrappedLine[] {
  return wrapRuns(runs, maxWidth, charWidth);
}

/** Distance between line baselines: the view needs it to lay lines out (and nothing else). */
export const LINE_HEIGHT = NODE_LINE_H;

export interface NodeMeasure {
  /** The lines the renderer must draw, already broken to fit the box. */
  lines: WrappedLine[];
  w: number;
  h: number;
}

/** Per node object, so the recursive tree maths can ask for a height repeatedly without re-wrapping. */
const MEASURED = new WeakMap<OutlineNode, NodeMeasure>();

/**
 * How a node's label is laid out: its lines, its box width and its box height.
 *
 * One authority for all three. The width is a wrap *target*, not a truncation point: the label breaks
 * into as many lines as it needs and the box grows taller, so nothing is hidden from the reader. The
 * measurement comes from `runsOf` —— what is actually drawn, due date included —— rather than from
 * `label`, which is the plain-text form used for titles and edge labels.
 */
export function measureNode(n: OutlineNode): NodeMeasure {
  const cached = MEASURED.get(n);
  if (cached) return cached;

  let extraW = 32;
  if (n.taskStatus) extraW += 20;
  // The attachment-paragraph indicator sits in the top-left corner, so leave room for it,
  // otherwise the icon covers the first character of the first paragraph.
  if (n.paragraphs?.length) extraW += 16;

  const lines = wrapRuns(runsOf(n), NODE_MAX_W - extraW, charWidth);
  const textW = lines.reduce((widest, line) => Math.max(widest, line.width), 0);
  const measure: NodeMeasure = {
    lines,
    w: Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, textW + extraW)),
    h: lines.length * NODE_LINE_H + NODE_PAD_V,
  };
  MEASURED.set(n, measure);
  return measure;
}

export function widthOf(n: OutlineNode): number {
  return measureNode(n).w;
}

export interface Layout {
  boxes: Box[];
  edges: Edge[];
  w: number;
  h: number;
}

export function calcSplitIndex(nodes: OutlineNode[], collapsedSet: Set<string>): number {
  if (nodes.length <= 1) return nodes.length;

  const isCollapsed = (n: OutlineNode): boolean => collapsedSet.has(n.id);
  const weight = (n: OutlineNode): number => {
    if (n.children.length === 0 || isCollapsed(n)) return 1;
    return n.children.reduce((acc, c) => acc + weight(c), 0);
  };

  const weights = nodes.map((n) => Math.max(1, weight(n)));
  const total = weights.reduce((acc, w) => acc + w, 0);
  const half = total / 2;

  let e = 0;
  let t = 0;
  for (let idx = 0; idx < weights.length; idx++) {
    const w = weights[idx];
    e = idx;
    t += w;
    const diff = t - half;
    if (diff >= 0) {
      if (diff <= w / 2) {
        e += 1;
      }
      break;
    }
  }
  return Math.max(1, Math.min(nodes.length - 1, e));
}

// Horizontal tree layout (supports 'balanced', 'right', 'left', 'timeline')
export function layoutHorizontal(
  roots: OutlineNode[],
  mode: MmStructure,
  collapsedSet: Set<string>,
): Layout {
  const boxes: Box[] = [];
  const edges: Edge[] = [];

  const isCollapsed = (n: OutlineNode): boolean => collapsedSet.has(n.id);

  /**
   * The vertical band a subtree reserves. It must equal the extent the layout draws,
   * bounded below by the node's own measured height plus vertical separation gap.
   */
  const subtreeH = (n: OutlineNode): number => {
    const h = measureNode(n).h;
    if (n.children.length === 0 || isCollapsed(n)) return h + V_GAP;
    return Math.max(h + V_GAP, n.children.reduce((a, c) => a + subtreeH(c), 0));
  };

  const layoutSubtree = (
    n: OutlineNode,
    parentX: number,
    parentW: number,
    parentCy: number,
    cy: number,
    side: 1 | -1,
    depth: number,
    branchIdx: number,
  ): void => {
    const m = measureNode(n);
    const w = m.w;
    const x = side === 1 ? parentX + parentW + H_GAP : parentX - H_GAP - w;
    const y = cy - m.h / 2;
    const collapsed = isCollapsed(n);

    boxes.push({
      id: `${n.id}:${depth}:${boxes.length}`,
      label: label(n),
      runs: runsOf(n),
      lines: m.lines,
      x,
      y,
      w,
      h: m.h,
      depth,
      branchIdx,
      side,
      node: n,
      isCollapsed: collapsed,
      childCount: n.children.length,
    });

    if (side === 1) {
      edges.push({ x1: parentX + parentW, y1: parentCy, x2: x, y2: cy, side: 1, branchIdx });
    } else {
      edges.push({ x1: parentX, y1: parentCy, x2: x + w, y2: cy, side: -1, branchIdx });
    }

    if (n.children.length === 0 || collapsed) return;
    const totalCh = n.children.reduce((acc, c) => acc + subtreeH(c), 0);
    let startY = cy - totalCh / 2;
    for (const c of n.children) {
      const ch = subtreeH(c);
      const childCy = startY + ch / 2;
      layoutSubtree(c, x, w, cy, childCy, side, depth + 1, branchIdx);
      startY += ch;
    }
  };

  if (mode === 'balanced' && roots.length > 1) {
    // Multi-root document in bidirectional mode:
    // Split the root topics themselves into right and left branches.
    // Each root topic keeps all of its children together growing in its assigned direction!
    const splitIdx = calcSplitIndex(roots, collapsedSet);
    const rightRoots = roots.slice(0, splitIdx);
    const leftRoots = roots.slice(splitIdx);

    const rightH = rightRoots.reduce((acc, r) => acc + subtreeH(r), 0);
    const leftH = leftRoots.reduce((acc, r) => acc + subtreeH(r), 0);
    const totalTreeH = Math.max(rightH, leftH, NODE_MIN_H + V_GAP);

    const centerCy = totalTreeH / 2;
    const rightStartY = centerCy - rightH / 2;
    const leftStartY = centerCy - leftH / 2;

    const spineYs: number[] = [];

    // Right roots
    let curRightY = rightStartY;
    rightRoots.forEach((r, idx) => {
      const rh = subtreeH(r);
      const rootCy = curRightY + rh / 2;
      spineYs.push(rootCy);
      const rm = measureNode(r);
      const rw = rm.w;
      const rootX = H_GAP / 2;
      const rootY = rootCy - rm.h / 2;
      const collapsed = isCollapsed(r);

      boxes.push({
        id: `${r.id}:0:${boxes.length}`,
        label: label(r),
        runs: runsOf(r),
        lines: rm.lines,
        x: rootX,
        y: rootY,
        w: rw,
        h: rm.h,
        depth: 0,
        branchIdx: idx,
        side: 1,
        node: r,
        isCollapsed: collapsed,
        childCount: r.children.length,
      });

      edges.push({ x1: 0, y1: rootCy, x2: rootX, y2: rootCy, side: 1, branchIdx: idx });

      if (!collapsed && r.children.length > 0) {
        const totalCh = r.children.reduce((acc, c) => acc + subtreeH(c), 0);
        let startY = rootCy - totalCh / 2;
        r.children.forEach((c) => {
          const ch = subtreeH(c);
          const childCy = startY + ch / 2;
          layoutSubtree(c, rootX, rw, rootCy, childCy, 1, 1, idx);
          startY += ch;
        });
      }
      curRightY += rh;
    });

    // Left roots
    let curLeftY = leftStartY;
    leftRoots.forEach((r, idx) => {
      const rh = subtreeH(r);
      const rootCy = curLeftY + rh / 2;
      spineYs.push(rootCy);
      const rm = measureNode(r);
      const rw = rm.w;
      const rootX = -H_GAP / 2 - rw;
      const rootY = rootCy - rm.h / 2;
      const branchIdx = rightRoots.length + idx;
      const collapsed = isCollapsed(r);

      boxes.push({
        id: `${r.id}:0:${boxes.length}`,
        label: label(r),
        runs: runsOf(r),
        lines: rm.lines,
        x: rootX,
        y: rootY,
        w: rw,
        h: rm.h,
        depth: 0,
        branchIdx,
        side: -1,
        node: r,
        isCollapsed: collapsed,
        childCount: r.children.length,
      });

      edges.push({ x1: 0, y1: rootCy, x2: rootX + rw, y2: rootCy, side: -1, branchIdx });

      if (!collapsed && r.children.length > 0) {
        const totalCh = r.children.reduce((acc, c) => acc + subtreeH(c), 0);
        let startY = rootCy - totalCh / 2;
        r.children.forEach((c) => {
          const ch = subtreeH(c);
          const childCy = startY + ch / 2;
          layoutSubtree(c, rootX, rw, rootCy, childCy, -1, 1, branchIdx);
          startY += ch;
        });
      }
      curLeftY += rh;
    });

    // Vertical spine connecting root connections at x = 0
    if (spineYs.length > 1) {
      const minY = Math.min(...spineYs);
      const maxY = Math.max(...spineYs);
      edges.push({ x1: 0, y1: minY, x2: 0, y2: maxY, side: 0, branchIdx: 0 });
    }
  } else {
    let cursorY = 0;
    for (const r of roots) {
      const rm = measureNode(r);
      const rw = rm.w;
      let rightKids: OutlineNode[] = [];
      let leftKids: OutlineNode[] = [];

      if (mode === 'right') {
        rightKids = r.children;
      } else if (mode === 'left') {
        leftKids = r.children;
      } else if (mode === 'timeline') {
        // Timeline alternates left and right
        r.children.forEach((c, idx) => {
          if (idx % 2 === 0) rightKids.push(c);
          else leftKids.push(c);
        });
      } else {
        // balanced with single root: weight-balanced split of children
        const splitIdx = calcSplitIndex(r.children, collapsedSet);
        rightKids = r.children.slice(0, splitIdx);
        leftKids = r.children.slice(splitIdx);
      }

      const rightH = rightKids.length > 0 ? rightKids.reduce((acc, c) => acc + subtreeH(c), 0) : NODE_MIN_H + V_GAP;
      const leftH = leftKids.length > 0 ? leftKids.reduce((acc, c) => acc + subtreeH(c), 0) : NODE_MIN_H + V_GAP;
      const totalTreeH = Math.max(rightH, leftH, NODE_MIN_H + V_GAP);

      const rootCy = cursorY + totalTreeH / 2;
      const rootX = mode === 'balanced' || mode === 'timeline' ? -rw / 2 : 0;
      const rootY = rootCy - rm.h / 2;
      const collapsed = isCollapsed(r);

      boxes.push({
        id: `${r.id}:0:${boxes.length}`,
        label: label(r),
        runs: runsOf(r),
        lines: rm.lines,
        x: rootX,
        y: rootY,
        w: rw,
        h: rm.h,
        depth: 0,
        branchIdx: 0,
        side: 0,
        node: r,
        isCollapsed: collapsed,
        childCount: r.children.length,
      });

      if (!collapsed) {
        if (rightKids.length > 0) {
          let startY = rootCy - rightKids.reduce((acc, c) => acc + subtreeH(c), 0) / 2;
          rightKids.forEach((c, idx) => {
            const ch = subtreeH(c);
            const childCy = startY + ch / 2;
            layoutSubtree(c, rootX, rw, rootCy, childCy, 1, 1, idx);
            startY += ch;
          });
        }

        if (leftKids.length > 0) {
          let startY = rootCy - leftKids.reduce((acc, c) => acc + subtreeH(c), 0) / 2;
          leftKids.forEach((c, idx) => {
            const ch = subtreeH(c);
            const childCy = startY + ch / 2;
            layoutSubtree(c, rootX, rw, rootCy, childCy, -1, 1, rightKids.length + idx);
            startY += ch;
          });
        }
      }

      cursorY += totalTreeH + 48;
    }
  }

  if (boxes.length === 0) return { boxes: [], edges: [], w: 100, h: 100 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y + b.h);
  }

  const padX = 80;
  const padY = 60;
  const shiftX = padX - minX;
  const shiftY = padY - minY;

  for (const b of boxes) {
    b.x += shiftX;
    b.y += shiftY;
  }
  for (const e of edges) {
    e.x1 += shiftX;
    e.x2 += shiftX;
    e.y1 += shiftY;
    e.y2 += shiftY;
  }

  return {
    boxes,
    edges,
    w: maxX - minX + padX * 2,
    h: maxY - minY + padY * 2,
  };
}

// Vertical org layout
export function layoutOrg(roots: OutlineNode[], collapsedSet: Set<string>): Layout {
  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const V_NODE_GAP_X = 20;
  const V_LEVEL_GAP = 64;

  const isCollapsed = (n: OutlineNode): boolean => collapsedSet.has(n.id);

  const subtreeW = (n: OutlineNode): number => {
    if (n.children.length === 0 || isCollapsed(n)) return widthOf(n) + V_NODE_GAP_X;
    return Math.max(
      widthOf(n) + V_NODE_GAP_X,
      n.children.reduce((a, c) => a + subtreeW(c), 0),
    );
  };

  const place = (n: OutlineNode, cx: number, y: number, depth: number, branchIdx: number): number => {
    const m = measureNode(n);
    const w = m.w;
    const collapsed = isCollapsed(n);
    boxes.push({
      id: `${n.id}:${depth}:${boxes.length}`,
      label: label(n),
      runs: runsOf(n),
      lines: m.lines,
      x: cx - w / 2,
      y,
      w,
      h: m.h,
      depth,
      branchIdx,
      side: 0,
      node: n,
      isCollapsed: collapsed,
      childCount: n.children.length,
    });

    if (n.children.length === 0 || collapsed) return subtreeW(n);
    const total = n.children.reduce((a, c) => a + subtreeW(c), 0);
    let cx2 = cx - total / 2;
    n.children.forEach((c, idx) => {
      const cw = subtreeW(c);
      const ccx = cx2 + cw / 2;
      const bIdx = depth === 0 ? idx : branchIdx;
      // A wrapped node can be taller than the nominal level gap, so the gap has to follow the node.
      const levelGap = Math.max(V_LEVEL_GAP, m.h + V_GAP * 2);
      edges.push({ x1: cx, y1: y + m.h, x2: ccx, y2: y + levelGap, side: 0, branchIdx: bIdx });
      place(c, ccx, y + levelGap, depth + 1, bIdx);
      cx2 += cw;
    });
    return total;
  };

  let y = 0;
  for (const r of roots) {
    const total = subtreeW(r);
    place(r, total / 2, y, 0, 0);
    let maxTreeY = y;
    for (const b of boxes) maxTreeY = Math.max(maxTreeY, b.y + b.h);
    y = maxTreeY + 64;
  }

  if (boxes.length === 0) return { boxes: [], edges: [], w: 100, h: 100 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y + b.h);
  }

  const padX = 80;
  const padY = 60;
  const shiftX = padX - minX;
  const shiftY = padY - minY;

  for (const b of boxes) {
    b.x += shiftX;
    b.y += shiftY;
  }
  for (const e of edges) {
    e.x1 += shiftX;
    e.x2 += shiftX;
    e.y1 += shiftY;
    e.y2 += shiftY;
  }

  return {
    boxes,
    edges,
    w: maxX - minX + padX * 2,
    h: maxY - minY + padY * 2,
  };
}

export function edgePath(e: Edge, vertical: boolean, style: MmLineStyle = 'curve'): string {
  if (style === 'straight') {
    if (vertical) {
      const my = (e.y1 + e.y2) / 2;
      return `M ${e.x1} ${e.y1} V ${my} H ${e.x2} V ${e.y2}`;
    }
    const mx = (e.x1 + e.x2) / 2;
    return `M ${e.x1} ${e.y1} H ${mx} V ${e.y2} H ${e.x2}`;
  }

  if (style === 'rounded') {
    if (vertical) {
      const my = (e.y1 + e.y2) / 2;
      const r = Math.min(8, Math.abs(my - e.y1), Math.abs(e.x2 - e.x1) / 2);
      const sX = e.x2 >= e.x1 ? 1 : -1;
      return `M ${e.x1} ${e.y1} V ${my - r} Q ${e.x1} ${my} ${e.x1 + sX * r} ${my} H ${e.x2 - sX * r} Q ${e.x2} ${my} ${e.x2} ${my + r} V ${e.y2}`;
    }
    const mx = (e.x1 + e.x2) / 2;
    const r = Math.min(8, Math.abs(mx - e.x1), Math.abs(e.y2 - e.y1) / 2);
    const sX = e.x2 >= e.x1 ? 1 : -1;
    const sY = e.y2 >= e.y1 ? 1 : -1;
    return `M ${e.x1} ${e.y1} H ${mx - sX * r} Q ${mx} ${e.y1} ${mx} ${e.y1 + sY * r} V ${e.y2 - sY * r} Q ${mx} ${e.y2} ${mx + sX * r} ${e.y2} H ${e.x2}`;
  }

  // default 'curve' S-bezier
  if (vertical) {
    const my = (e.y1 + e.y2) / 2;
    return `M ${e.x1} ${e.y1} C ${e.x1} ${my}, ${e.x2} ${my}, ${e.x2} ${e.y2}`;
  }
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}

/**
 * Export FreeMind `.mm`.
 *
 * @param untitled  the fallback copy for a node with an empty title (passed in by the render layer's `t()` —— this file is the pure logic layer,
 *                  it does not import i18n and has no built-in default in any language)
 * @param defTitle  the fallback copy when the whole map has no title, same as above
 *
 * ★ Both copies are **required**, and that is the fix rather than a style choice: they used to default to
 *   `''`, and the one caller passed `undefined`, so every export of a map whose nodes or title were empty
 *   wrote `TEXT=""` —— an empty attribute in the file, instead of the wording the product shows on screen.
 *   A default here is a silent fallback: it made a missing argument look like a deliberate empty string.
 *   Required parameters turn the omission into a compile error, which `npm run typecheck` catches.
 */
export function exportFreemind(
  nodes: OutlineNode[],
  title: string,
  untitled: string,
  defTitle: string,
  titleParagraphs?: string[],
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rootBody = (titleParagraphs ?? [])
    .map((p) => esc(htmlToText(p)))
    .filter((t) => t.trim())
    .join('<br>');
  const rootNote = rootBody
    ? `<richcontent TYPE="NOTE"><html><head></head><body>${rootBody}</body></html></richcontent>`
    : '';
  const walk = (ns: OutlineNode[]): string =>
    ns
      .map((n) => {
        // Attachment paragraphs → FreeMind's native `richcontent TYPE="NOTE"` (the node note area).
        // Multiple paragraphs are joined with `<br>`; after export they still hang under the node, so nothing is lost.
        const body = (n.paragraphs ?? [])
          .map((p) => esc(htmlToText(p)))
          .filter((t) => t.trim())
          .join('<br>');
        const note = body
          ? `<richcontent TYPE="NOTE"><html><head></head><body>${body}</body></html></richcontent>`
          : '';
        return `<node TEXT="${esc(htmlToText(n.text) || untitled)}">${note}${walk(n.children)}</node>`;
      })
      .join('');
  return `<map version="1.0.1"><node TEXT="${esc(title || defTitle)}">${rootNote}${walk(nodes)}</node></map>`;
}

