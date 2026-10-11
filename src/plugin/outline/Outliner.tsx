import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta, OutlineNode } from '../../model/types';
import { TASK_DONE, TASK_NONE, TASK_TODO, NODE_WORD_LIMIT, TITLE_MAX, nextTaskStatus } from '../../model/types';
import {
  cloneNodes,
  findNode,
  findPath,
  flattenAll,
  flattenVisible,
  htmlToText,
  removeNode,
  touch,
} from '../../model/tree';
// Collapse granularity (recursive semantics) lives in tree-ops, where it is unit-testable offline.
// Alias it to avoid clashing with the local `toggleCollapse` below (the one wrapping mutate).
import { toggleCollapse as toggleCollapseAt } from '../tree-ops';import {
  indentNodes as indentInTree,
  outdentNodes as outdentInTree,
} from './indent';
import { shouldRollBackScroll } from './auto-scroll';

import { genId, now } from '../../model/ids';
import { makeSiyuanId } from '../../core/map';
import { putImage, getImageUrl } from './images';
import { TaskBox } from './RichContent';
import { renderFormula } from './katex';
import { t } from '../i18n';
import { tooltip } from '../tooltip';

export interface FocusReq {
  id: string;
  offset: number | 'start' | 'end';
}

interface OutlinerProps {
  nodes: OutlineNode[];
  externRev: number;
  onChange: (next: OutlineNode[], kind?: 'struct' | 'text') => void;
  onUndo: () => void;
  onRedo: () => void;
  docs: DocMeta[];
  docId: string;
  onOpenDoc: (id: string) => void;
  zoomId?: string | null;
  onZoomChange?: (id: string | null) => void;
  /**
   * Clicking a block ref `((id "anchor text"))` / a mention `@…` inside a node opens its target.
   *
   * ★ Injected by mount. mount used to not pass them, so the
   *   `onOpenNoderef` / `onOpenMention` pair in RichContent was **dead code**.
   */
  onOpenRef?: (target: string) => void;
  docTitle?: string;
  onTitleChange?: (title: string) => void;
  docParagraphs?: string[];
  onDocParagraphsChange?: (paragraphs: string[]) => void;
}

// The **single source of truth** for drop resolution is `drop-zone.ts` (pure functions, unit-testable offline).
// Here we only wire it in and no longer hand-roll 0.25/0.75 —— those two numbers used to be written
// once in desktop onDragOver and once in mobile touchHitTest, so fixing one and missing the other
// produced "mouse drag and finger drag land in different places".
import {
  dropZoneFor,
  nearestRowZone,
  type DropZone as RawDropZone,
} from './drop-zone';

type DropZone = RawDropZone | null;

function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

function ensureVisible(container: HTMLElement, el: HTMLElement, extraMargin: number = 24): void {
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const bar = isMobile ? (document.querySelector('.mobile-keyboard-bar') as HTMLElement | null) : null;
  const barTop = bar && bar.getBoundingClientRect().height > 0 ? bar.getBoundingClientRect().top : Number.POSITIVE_INFINITY;

  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const vvBottom = typeof window !== 'undefined' && window.visualViewport
    ? window.visualViewport.offsetTop + window.visualViewport.height
    : (typeof window !== 'undefined' ? window.innerHeight : cRect.bottom);
  const visibleBottom = Math.min(cRect.bottom, vvBottom, barTop);
  const bottomThreshold = visibleBottom - extraMargin;
  if (eRect.bottom > bottomThreshold) {
    const diff = eRect.bottom - bottomThreshold;
    container.scrollTop += diff;
  } else if (eRect.top < cRect.top + 10) {
    const diff = (cRect.top + 10) - eRect.top;
    container.scrollTop -= diff;
  }
}

function isCaretOnFirstLine(el: HTMLElement): boolean {
  if (el.clientHeight <= 40) return true;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return true;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const top = rects.length > 0 ? rects[0].top : range.getBoundingClientRect().top;
  const elTop = el.getBoundingClientRect().top;
  if (top === 0) return true;
  return top - elTop < 34;
}

function isCaretOnLastLine(el: HTMLElement): boolean {
  if (el.clientHeight <= 40) return true;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return true;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const bottom = rects.length > 0 ? rects[0].bottom : range.getBoundingClientRect().bottom;
  const elBottom = el.getBoundingClientRect().bottom;
  if (bottom === 0) return true;
  return elBottom - bottom < 34;
}

function setCaret(el: HTMLElement, offset: number | 'start' | 'end'): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (offset === 'start') {
    range.selectNodeContents(el);
    range.collapse(true);
  } else if (offset === 'end') {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let rest = offset;
    let node: Text | null = null;
    let last: Text | null = null;
    while ((node = walker.nextNode() as Text | null)) {
      last = node;
      if (rest <= (node.textContent || '').length) break;
      rest -= (node.textContent || '').length;
    }
    if (node && rest <= (node.textContent || '').length) {
      range.setStart(node, rest);
    } else if (last) {
      range.setStart(last, (last.textContent || '').length);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function splitHtmlAtCaret(el: HTMLElement): { before: string; after: string } {
  const sel = window.getSelection();
  const tmp = document.createElement('div');
  if (!sel || sel.rangeCount === 0) return { before: el.innerHTML, after: '' };
  const r = sel.getRangeAt(0);
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  try {
    pre.setEnd(r.endContainer, r.endOffset);
  } catch {
    return { before: el.innerHTML, after: '' };
  }
  const frag = pre.cloneContents();
  tmp.appendChild(frag);
  const before = tmp.innerHTML;
  const post = r.cloneRange();
  const endRange = document.createRange();
  endRange.selectNodeContents(el);
  try {
    post.setEnd(endRange.endContainer, endRange.endOffset);
  } catch {
    return { before, after: '' };
  }
  const frag2 = post.cloneContents();
  const tmp2 = document.createElement('div');
  tmp2.appendChild(frag2);
  return { before, after: tmp2.innerHTML };
}

// ---------- attached paragraph (paragraphs) semantics helpers ----------
//
// In the old model a note was **one** HTML string `note` (written to the SiYuan block attribute `memo`).
// Now it is carried by `paragraphs: string[]` (native attached paragraphs) ——
// corresponding to the NodeParagraph blocks after the first one under a SiYuan listItem:
//
//     listItem
//     ├── p   first paragraph (= node.text)
//     ├── p   attached paragraph[0]
//     ├── p   attached paragraph[1]
//     └── l   child node list
//
// Why the switch was necessary (instead of keeping memo):
//   `memo` is a **block attribute**: full-text search does not find it by default, and it shows only as an "M" icon,
//   visible only after clicking it open —— which violates "what you see is what you get". Attached paragraphs are body paragraphs,
//   so they are indexed naturally and shown directly under the node.
//
// The three empty states (the easiest thing to get wrong in this module, keep them apart):
//   · `undefined`   —— **no** attached paragraphs (never created). Nothing is rendered at all.
//   · `[]`          —— empty array, equivalent to "none". Readers always treat it as 0 paragraphs.
//   · `['', ...]`   —— an empty-string paragraph **is legitimate content**!
//
// ★ Why empty-string paragraphs must not all be filtered out:
//   empty nodes and empty attached paragraphs have to be supported.
//   An empty paragraph is a placeholder the user **deliberately** typed (matching a blank line in SiYuan body text);
//   filtering it out automatically makes the blank line the user just typed vanish immediately —— that is data loss.
//   Collapsing happens only on "whole-block degeneration" (see paraToStore): when the user deletes **every** paragraph,
//   the block itself should no longer exist, and only then is it cleared to undefined.

/** Read a node's paragraph list (undefined → []). Read-only, does not touch the model. */
function parasOf(n: OutlineNode | undefined): string[] {
  return n?.paragraphs ?? [];
}

/**
 * Paragraph list → the value stored in the model.
 *
 * The **only** condition that returns `undefined`: not a single paragraph (empty array).
 * Note this does **not** test "are they all empty strings" —— all-empty means "N empty paragraphs",
 * which is legitimate user content and must be preserved as-is; collapsing it to undefined makes the
 * blank lines the user typed vanish into thin air.
 */
function paraToStore(list: string[]): string[] | undefined {
  return list.length > 0 ? list : undefined;
}

/** Whether an HTML paragraph "looks empty" (only zero-width placeholders / whitespace / empty tags). */
function isBlankPara(html: string): boolean {
  return htmlToText(html).replace(/\u200b/g, '').trim() === '';
}

function hydrateEditable(el: HTMLElement): void {
  el.querySelectorAll<HTMLImageElement>('img[data-img]').forEach((img) => {
    const id = img.getAttribute('data-img');
    if (!id || img.src.startsWith('blob:')) return;
    getImageUrl(id).then((url) => {
      if (url) img.src = url;
    });
  });
  // ★ Formula rendering.
  //
  // This is the **only** rendering entry point: outline nodes go through ref + imperative DOM (not
  // the dangerouslySetInnerHTML path of RichContent), so the katex.render block in
  // RichContent was never executed at all —— the symptom was
  // "the formula is shown verbatim as $E=mc^2$". The KaTeX instance reuses SiYuan's own copy via ./katex.
  el.querySelectorAll<HTMLElement>('[data-formula]:not([data-rendered])').forEach((span) => {
    const tex = span.getAttribute('data-formula') || '';
    span.setAttribute('data-rendered', '1'); // guard against double rendering
    void renderFormula(tex, span);
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Insert html at saved range (or end of el). Returns nothing; caller syncs. */
function insertHtml(range: Range | null, el: HTMLElement, html: string): void {
  el.focus();
  const sel = window.getSelection();
  let r = range;
  if (!r || !el.contains(r.commonAncestorContainer)) {
    r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
  }
  try {
    (sel as Selection).removeAllRanges();
    (sel as Selection).addRange(r);
    const ok = document.execCommand('insertHTML', false, html);
    if (!ok) {
      const frag = r.createContextualFragment(html);
      r.deleteContents();
      const last = frag.lastChild;
      r.insertNode(frag);
      if (last) {
        const nr = document.createRange();
        nr.setStartAfter(last);
        nr.collapse(true);
        (sel as Selection).removeAllRanges();
        (sel as Selection).addRange(nr);
      }
    }
  } catch {
    el.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Keyboard shortcut help content.
 *
 * ★ The "⌨ shortcuts" button and `Ctrl+/` used to both be bound to `onOpenShortcuts?.()`,
 *   but `mount.ts` **never passed that prop**, and the plugin had **no** shortcut popup at all ——
 *   so clicking the button did nothing and pressing the shortcut did nothing (measured popup count 0 → 0).
 *   Here the content is filled in and routed through this component's own `openPanel` (which also gives focus restoration, §91).
 *
 * ★ Entries must match the keys actually implemented in the code; do not copy the official docs verbatim ——
 *   a help text that "looks right but cannot be pressed" is worse than no help text at all.
 */
const SHORTCUTS: { group: string; items: { keys: string; desc: string }[] }[] = [
  {
    group: t('skGroupEdit'),
    items: [
      { keys: 'Enter', desc: t('skNewSibling') },
      { keys: 'Tab', desc: t('skDemote') },
      { keys: 'Shift+Tab', desc: t('skPromote') },
      { keys: 'Ctrl+D', desc: t('skDuplicate') },
      { keys: 'Ctrl+B / I / U', desc: t('skBoldItalicUnderline') },
      { keys: 'Ctrl+Enter', desc: t('skStrike') },
    ],
  },
  {
    group: t('skGroupDeleteMerge'),
    items: [
      { keys: 'Backspace', desc: t('skMergePrev') },
      { keys: 'Delete', desc: t('skMergeNext') },
      { keys: 'Ctrl+Shift+Backspace', desc: t('skQuickDelete') },
    ],
  },
  {
    group: t('skGroupSelect'),
    items: [
      { keys: 'Shift+↑ / ↓', desc: t('skExtendSelection') },
      { keys: 'Ctrl+Click', desc: t('skToggleSelect') },
      { keys: 'Shift+Click', desc: t('skRangeSelect') },
      { keys: 'Ctrl+A', desc: t('skSelectSiblings') },
      { keys: 'Esc', desc: t('skClearSelection') },
    ],
  },
  {
    group: t('skGroupMove'),
    items: [
      { keys: 'Alt+↑ / ↓', desc: t('skMoveUpDown') },
      { keys: 'Ctrl+. / Alt+.', desc: t('skCollapseExpand') },
      { keys: 'Ctrl+Shift+.', desc: t('skCollapseSiblings') },
      { keys: 'Alt+Shift+.', desc: t('skCollapseAll') },
      { keys: 'Ctrl+Alt+1 / 2 / 3', desc: t('skCollapseToLevel') },
      { keys: 'Alt+Click', desc: t('skCollapseBranch') },
      { keys: 'Drag', desc: t('skMoveByDrag') },
    ],
  },
  {
    group: t('skGroupView'),
    items: [
      { keys: 'Alt+→', desc: t('skEnterZoom') },
      { keys: 'Alt+←', desc: t('skBackUp') },
      { keys: 'Ctrl+F', desc: t('skFindReplace') },
      { keys: 'Ctrl+/', desc: t('skThisHelp') },
      { keys: 'Ctrl+Z / Shift+Ctrl+Z', desc: t('skUndoRedo') },
    ],
  },
];

const EMOJIS = [
  '👍', '📝', '📚', '💡', '🔥', '✅', '❌', '⭐', '🎯', '📌',
  '🚀', '🎉', '💪', '🧠', '📊', '🗓', '💰', '🏠', '✈️', '🎨',
  '❓', '❗', '➡️', '🔗', '📎', '🖼', '➗', '😄', '🤔', '👏',
];

export default function Outliner(props: OutlinerProps) {
  const {
    nodes,
    externRev,
    onChange,
    onUndo,
    onRedo,
    docs,
    docId,
    onOpenDoc,
    zoomId,
    onZoomChange,
    onOpenRef,
    docTitle,
    onTitleChange,
    docParagraphs,
    onDocParagraphsChange,
  } = props;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const rootRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleParaRefs = useRef<(HTMLDivElement | null)[]>([]);
  const elMap = useRef(new Map<string, HTMLDivElement>());
  /**
   * Editable divs for a node's attached paragraphs, **an array per node** (index = paragraph index).
   *
   * Why this changed from a single div (the old `noteMap: Map<id, div>`) to an array:
   *   the old model's `note` was **one** HTML string; it is now `paragraphs: string[]`,
   *   one node can have several paragraphs, each with its own contenteditable box.
   *   Writing back must locate that exact paragraph by **index** (`syncPara(id, idx)`),
   *   so the map has to keep the array shape and must not keep only the first one.
   *
   * ⚠️ The array may contain null holes: a paragraph not yet attached to the DOM (deleted mid-render,
   *   or simply not rendered). A null placeholder is safer than compacting the array —— compacting would let a later
   *   div slide onto an earlier paragraph's **index**, and the write-back would land on the wrong paragraph (index shift).
   */
  const paraMap = useRef(new Map<string, (HTMLDivElement | null)[]>());
  // nodes whose model text was rewritten by shortcut transform while focused:
  // force DOM sync even though the element keeps focus
  const corrected = useRef(new Set<string>());
  const lastRange = useRef<Range | null>(null);
  const pendingFocus = useRef<FocusReq | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isDraggingBulletRef = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = ctxMenu.x;
    let y = ctxMenu.y;
    if (x + r.width + m > vw) x = ctxMenu.x - r.width;
    if (y + r.height + m > vh) y = ctxMenu.y - r.height;
    x = Math.max(m, Math.min(x, vw - r.width - m));
    y = Math.max(m, Math.min(y, vh - r.height - m));
    setMenuPos({ x, y });
  }, [ctxMenu]);

  const [drop, setDrop] = useState<{ id: string; zone: Exclude<DropZone, null> } | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  /**
   * ★★★ Touch dragging (added; a measured gap):
   *
   *   Desktop dragging relies on HTML5 drag (`draggable="true"` on `.bullet`),
   *   but **touch devices never fire dragstart at all**. Measured: with a mobile viewport and a real touch sequence,
   *   dragging from "C3" to above "A1" left both the UI and SiYuan **completely unchanged**, with no error.
   *   The same operation works on desktop via dragstart/dragover/drop.
   *
   *   As a result, mobile could only move one step at a time with the "move up / move down / indent" buttons —— cross-level moves were painful.
   *
   *   Fix: add a **long-press then drag** gesture (the common mobile interaction);
   *   once a long press is detected it enters drag state and then uses the **same** `moveDrop` as desktop
   *   to complete the drop —— reusing the same zone resolution instead of writing a second move implementation.
   */
  /**
   * Auto-scroll when dragging to an edge.
   *
   * ★ Why it is needed: once the list grows, dragging to a spot **off screen** first requires scrolling,
   *   but the finger is busy dragging and cannot swipe —— hence "you cannot drag to a place you cannot see".
   *
   * ★ Measured background: only after "content is clipped and out of reach" was fixed (see the
   *   comment on `.om-mm-root` in styles.css) did a real scroll container exist,
   *   which is what gives auto-scroll something to scroll.
   */
  const autoScrollRef = useRef<number | null>(null);
  const scrollBoxRef = useRef<HTMLElement | null>(null);
  const touchDragRef = useRef<{
    /** Long-press timer */
    timer: number | null;
    /** Currently dragging */
    active: boolean;
    /** Node being dragged */
    dragId: string;
    /** Current finger coordinates */
    x: number;
    y: number;
    /** Long-press origin (cancelled once movement passes the threshold, to avoid false triggers) */
    startX: number;
    startY: number;
  } | null>(null);
  /** Whether a long-press drag is in progress (drives visual feedback in the UI) */
  const [touchDragging, setTouchDragging] = useState(false);
  const [panel, setPanel] = useState<null | 'emoji' | 'mention' | 'noderef' | 'table' | 'shortcuts'>(null);
  const [panelQ, setPanelQ] = useState('');
  const [tableRC, setTableRC] = useState({ r: 3, c: 3 });
  const [find, setFind] = useState({ open: false, q: '', rep: '', total: 0 });
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  /**
   * Focus position before a panel was opened, so it can be restored on close.
   *
   * ★★★ Why it is required (a measured **one-way focus migration** bug):
   *
   *   The "@ reference document" and "backlinks" panels both have `autoFocus` inputs,
   *   so opening them steals focus from `DIV.node-text` to `INPUT`;
   *   but **nobody is responsible for giving it back on close** —— focus lands on `BODY`.
   *
   *   Measured (click a node → open panel → close → type):
   *   ```
   *   after the panel opens, activeElement: INPUT.
   *   ★ after close, activeElement: BODY.fn__flex-column
   *   typing after close: ['A','B','C'] → ['A','B','C']   ← characters lost
   *   ```
   *   The user concludes "the input box is broken" when in fact focus simply never came back.
   *
   *   Contrast: the "Emoji" and "table" panels have no autoFocus, so focus stays on
   *   `DIV.node-text` and typing after close works —— so this is not a "panel" problem
   *   but "**whoever takes focus must give it back**".
   */
  const panelReturnFocus = useRef<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState<number>(0);
  /** Whether the mobile soft keyboard is up (replaces the global class previously put on document.body) */
  const [keyboardOpen, setKeyboardOpen] = useState<boolean>(false);
  const [formatDrawerOpen, setFormatDrawerOpen] = useState(true);
  const [activeColorPicker, setActiveColorPicker] = useState<'none' | 'highlight' | 'color'>('none');
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const keyboardBarRef = useRef<HTMLDivElement>(null);
  const [mobileBarHeight, setMobileBarHeight] = useState<number>(() => {
    return typeof window !== 'undefined' && window.innerWidth <= 768 ? 134 : 0;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || window.innerWidth > 768) return;
    const barEl = keyboardBarRef.current || (document.querySelector('.mobile-keyboard-bar') as HTMLElement | null);
    if (!barEl) return;
    const updateH = () => {
      const h = Math.round(barEl.getBoundingClientRect().height);
      if (h > 0) setMobileBarHeight(h);
    };
    updateH();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateH());
      ro.observe(barEl);
      return () => ro.disconnect();
    }
  }, [formatDrawerOpen, activeColorPicker]);

  // ── Open/closed state of the format toolbar above, **exactly the same approach as the mindmap view**.
  //
  //   On narrow screens (phones) it overlaps the bottom keyboard bar and eats a large part of the screen,
  //   while the bottom bar is already sufficient ⇒ collapsed by default on narrow screens, yielding room to content.
  //   Desktop keeps the usual habit (expanded by default).
  //
  //   ★ Mirrors `barOpen` in `Mindmap.tsx` one for one:
  //     same localStorage key, same first-visit criterion, same toggle semantics.
  //     Change one and check the other —— inconsistent behaviour between the two is harder to track down than having only one.
  const [barOpen, setBarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('om-outline-bar-open');
      if (saved !== null) return saved === '1';
    } catch {
      /* read failure: use the default */
    }
    // On a first visit (no memory) start with "expanded" —— the DOM is not mounted yet, so the bar width cannot be measured.
    // The real criterion is in the useLayoutEffect below, which corrects it using the **container width**.
    return true;
  });

  // ★★★ The first-visit default follows the **container width**, not the window width (same reason as the mindmap).
  //   The toolbar lives in the **SiYuan right dock**, and the dock width is unrelated to the window width;
  //   using `window.innerWidth` as a stand-in misjudges "large window + narrow dock" as a wide screen.
  React.useLayoutEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('om-outline-bar-open');
    } catch {
      /* storage unavailable: treat as "no memory" */
    }
    if (saved !== null) return; // the user has chosen, leave it alone
    const w = rootRef.current?.clientWidth ?? 0;
    if (w <= 0) return; // not mounted / not measurable yet, keep the default
    setBarOpen(w > 560);
    // Run once only: this is the "first-visit default", not "live tracking of the dock width"
    // (live tracking would override the user's manual open/close).
  }, []);

  const toggleBar = useCallback((): void => {
    setBarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem('om-outline-bar-open', next ? '1' : '0');
      } catch {
        /* storage unavailable does not affect functionality */
      }
      return next;
    });
  }, []);

  const scrollActiveIntoView = useCallback((el?: HTMLElement | null) => {
    if (typeof window === 'undefined' || window.innerWidth > 768) return;
    const target = el || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!target) return;
    const wrap = rootRef.current;
    if (!wrap) return;
    ensureVisible(wrap, target, 24);
  }, []);

  useEffect(() => {
    // ★★ Keyboard bar positioning: back to the **original formula** (the user confirmed this version of the toolbar is right).
    //
    //   Formula: bottom = innerHeight − visualViewport.height
    //
    //   ★ Four "improvements" were tried here and all were rejected on real devices; recorded so they are not repeated:
    //     ① `vvTop > 20` criterion           → misjudges when the keyboard is not up, bar drops to the very bottom of the screen
    //     ② `min(innerHeight, vvTop+vvH)`    → while scrolling the bar is dragged along by the viewport
    //     ③ switch to absolute `top` coords (copying SiYuan) → the bar floats in the middle of the screen
    //        (SiYuan's version only runs in the desktop App WebView; Safari's coordinate system differs)
    //     ④ `top = 2*vvTop + vvH − barH`     → even worse
    //
    //   The common mistake: adding and subtracting vvTop / vvH / innerHeight, three values from **different coordinate systems**
    //   —— on a real device, in one frame `vvTop+vvH` computes 834 while `innerHeight` is only 350.
    //   The original formula uses only the single difference `innerHeight − vv.height`, which is why it is stable.
    //
    //   ★ Two fixes **unrelated to positioning** are kept (neither changes the toolbar position):
    //     · do not setState when the value is unchanged —— fixes "constant jitter while the keyboard is up"
    //     · scroll the caret into view only when the keyboard **just came up** —— fixes "one scroll and it jumps back"
    //       (the original scrolled on every viewport event, so manual scrolling was repeatedly overridden)
    let lastOffset = -1;
    let lastOpen: boolean | null = null;

    const handleViewport = () => {
      if (!window.visualViewport) return;
      const vv = window.visualViewport;
      const isMobile = window.innerWidth <= 768;
      // On iOS Safari, when keyboard appears, vv.height shrinks while window.innerHeight remains layout height (if interactive-widget is not supported).
      // If interactive-widget=resizes-content resized window.innerHeight, diff will be near 0 and bottom: 0 naturally docks to keyboard.
      // If window.innerHeight is not resized by browser, rawOffset is the keyboard height.
      // vv.offsetTop must NOT be added/subtracted here because during typing iOS Safari scrolls/pans the visual viewport,
      // which previously caused the offset to drop to 0 and the toolbar to be covered by the keyboard!
      const rawOffset = window.innerHeight - vv.height;
      const isKbOpen = isMobile && rawOffset > 60;
      const offset = isKbOpen ? Math.max(0, Math.round(rawOffset)) : 0;

      if (isMobile) {
        const bar = keyboardBarRef.current || (document.querySelector('.mobile-keyboard-bar') as HTMLElement | null);
        const barH = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
        if (barH > 0) setMobileBarHeight(barH);
      }

      if (offset !== lastOffset) {
        lastOffset = offset;
        setKeyboardOffset(offset);
      }

      // ★★ No longer adding a global class to `document.body` (fixed).
      //   Plugin CSS is injected globally, and adding a class to SiYuan's own <body> affects other views;
      //   a maintainer stated clearly that "a plugin must not change SiYuan UI unrelated to the plugin's own features".
      //   Instead component state is set and the keyboard bar decides its own styling.
      //
      //   ★ Order matters: first test "did it just change from closed to open", then update lastOpen.
      //     Writing it the other way round (assign first, then test) makes the condition always true, which means no fix at all.
      const justOpened = isKbOpen && lastOpen !== true;
      if (isKbOpen !== lastOpen) {
        lastOpen = isKbOpen;
        setKeyboardOpen(isKbOpen);
      }

      if (isMobile && window.scrollY > 0) {
        window.scrollTo(0, 0);
      }

      // ★ Scroll the caret into view only on the frame the keyboard **just came up**, not on every viewport event.
      if (justOpened) {
        if (window.scrollY > 0) {
          window.scrollTo(0, 0);
        }
        setTimeout(() => {
          scrollActiveIntoView();
        }, 80);
      }
    };

    const handleWindowScroll = () => {
      if (typeof window !== 'undefined' && window.innerWidth <= 768 && window.scrollY > 0) {
        window.scrollTo(0, 0);
      }
    };

    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewport);
      window.visualViewport.addEventListener('scroll', handleViewport);
      window.addEventListener('scroll', handleWindowScroll, { passive: true });
      handleViewport();
      return () => {
        window.visualViewport?.removeEventListener('resize', handleViewport);
        window.visualViewport?.removeEventListener('scroll', handleViewport);
        window.removeEventListener('scroll', handleWindowScroll);
        setKeyboardOpen(false);
      };
    }
  }, [scrollActiveIntoView]);

  const zoomNode = zoomId ? findNode(nodes, zoomId) : null;
  const zoomPath = zoomId ? findPath(nodes, zoomId) : null;

  useEffect(() => {
    if (zoomId && !findNode(nodes, zoomId)) {
      onZoomChange?.(null);
    }
  }, [zoomId, nodes, onZoomChange]);

  const displayedNodes = useMemo(() => (zoomNode ? [zoomNode] : nodes), [zoomNode, nodes]);
  const flat = useMemo(() => flattenVisible(displayedNodes), [displayedNodes]);
  const flatAll = useMemo(() => flattenAll(nodes), [nodes]);
  const nodeById = useMemo(() => {
    const m = new Map<string, OutlineNode>();
    for (const e of flatAll) m.set(e.node.id, e.node);
    return m;
  }, [flatAll]);

  useEffect(() => {
    document.execCommand('styleWithCSS', false, 'true');
    const onSel = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (rootRef.current && rootRef.current.contains(r.commonAncestorContainer)) {
          lastRange.current = r.cloneRange();
        }
      }
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  // apply pending focus immediately after DOM layout, before paint
  useLayoutEffect(() => {
    if (pendingFocus.current) {
      const req = pendingFocus.current;
      pendingFocus.current = null;
      const el = elMap.current.get(req.id);
      if (el) {
        setCaret(el, req.offset);
        setActiveNodeId(req.id);
        if (rootRef.current) {
          ensureVisible(rootRef.current, el, 20);
        }
      }
    }
    // ★★ The dependencies must include the panel open state: when a panel / find bar closes, `nodes` usually **does not change**,
    //    so with only nodes as a dependency this effect does not re-run and `pendingFocus` stays pending
    //    → focus never comes back. The dependencies must include `panel` and `find.open`.
  }, [nodes, formatDrawerOpen, panel, find.open]);

  // External model rewrite (undo/redo while focused): force-sync every
  // visible editor DOM from model. Runs after render, before caret restore.
  useEffect(() => {
    if (externRev === 0) return;
    for (const [id, el] of elMap.current) {
      const n = nodeById.get(id);
      if (n && el.innerHTML !== (n.text || '')) {
        el.innerHTML = n.text || '';
      }
    }
    for (const [id, els] of paraMap.current) {
      const n = nodeById.get(id);
      if (!n) continue;
      const paras = parasOf(n);
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        // That index no longer exists in the model (fewer paragraphs) → leave the DOM alone, let React re-render and unmount it
        if (i >= paras.length) continue;
        const html = paras[i] || '';
        if (el.innerHTML !== html) el.innerHTML = html;
      }
    }
    // ★ The dependencies must include both externRev and nodeById.
    // With only externRev (measured, hit for real): an undo replaces the whole tree, setNodes and
    // setExternRev commit in the same batch, and this effect may run once while nodeById is still
    // the old value, overwriting the text just written into the DOM with the **old text**, which shows up as
    // the lag of "one undo does nothing, a second undo jumps one step".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externRev, nodeById]);

  // Shortcut-rewritten focused node (model holds stripped html, ref guard
  // skipped it): force-sync after every render. Also covers limit-truncated notes.
  useEffect(() => {
    if (corrected.current.size === 0) return;
    for (const id of corrected.current) {
      const el = elMap.current.get(id);
      const n = nodeById.get(id);
      if (el && n && el.innerHTML !== (n.text || '')) {
        el.innerHTML = n.text || '';
      }
      const els = paraMap.current.get(id);
      if (els && n && n.paragraphs !== undefined) {
        const paras = parasOf(n);
        for (let i = 0; i < els.length && i < paras.length; i++) {
          const pel = els[i];
          if (!pel) continue;
          if (pel.innerHTML !== (paras[i] || '')) pel.innerHTML = paras[i] || '';
        }
      }
    }
    corrected.current.clear();
  });

  const focusReq = (id: string, offset: number | 'start' | 'end'): void => {
    pendingFocus.current = { id, offset };
  };

  /**
   * Open a panel —— first remember the node that currently has focus, to restore it on close.
   * See the comment on `panelReturnFocus` for details.
   */
  /**
   * Escape handling inside a panel.
   *
   * ★★★ Why it must be handled on the **panel itself** (measured).
   *
   *   `closePanel()` used to be called only from the **node's onKeyDown**:
   *   ```ts
   *   if (e.key === 'Escape') { ...; closeFind(); closePanel(); return; }
   *   ```
   *   But as soon as a panel opens, focus is inside the panel's `INPUT` —— the event **never reaches**
   *   the node handler, so `Esc` could not close **any** panel.
   *
   *   Measured (pressing Esc on each of the five panels):
   *   ```
   *   @ reference document   Esc closed=False  focus=INPUT.
   *   backlinks              Esc closed=False  focus=INPUT.
   *   table                  Esc closed=False  focus=BODY...
   *   shortcut help          Esc closed=False  focus=BUTTON.tb-pill
   *   ```
   *   The panels did not move at all, and the user could only click the "close" button (the table / shortcut panels do not even have one).
   *
   *   ★ General rule: **whoever takes focus is responsible for handling Esc** —— this is the natural extension of §91
   *     "whoever takes focus must give it back":
   *     it is not only about returning focus but also about being able to leave.
   */
  /**
   * Panel container ref —— focus is moved into it after opening.
   *
   * ★ Why: `onKeyDown` fires only when **focus is inside that element**.
   *   The Emoji / shortcut panels have no `autoFocus` element (Emoji is a row of buttons,
   *   and the shortcut panel's close button does not autofocus either), so focus stays on the toolbar button
   *   and `panelKeyDown` never receives Escape —— the panel cannot be closed (confirmed by measurement).
   *
   *   Moving focus into the panel is the correct popup behaviour and incidentally makes Esc work.
   */
  const panelBoxRef = useRef<HTMLDivElement>(null);

  const panelKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  };

  const openPanel = (name: 'emoji' | 'mention' | 'noderef' | 'table' | 'shortcuts'): void => {
    // ★★ Fallback: when a panel is opened by clicking a **toolbar button**, focus has already left the node,
    //   `activeNodeId` is usually null ⇒ `closePanel` has no focus to restore,
    //   so after closing, focus stays on the button and **typing does not reach the node** (confirmed by measurement).
    //   With no activeNodeId, record the "first visible node" as the next best thing.
    panelReturnFocus.current = activeNodeId || flattenVisible(displayedNodes)[0]?.node.id || null;
    if (name === 'mention' || name === 'noderef') setPanelQ('');
    setPanel(name);
    // Move focus into the panel (so Escape reaches panelKeyDown).
    // The panel's `autoFocus` input takes over after this rAF, so there is no need to worry about stealing focus.
    requestAnimationFrame(() => {
      const box = panelBoxRef.current;
      if (box && !box.contains(document.activeElement)) box.focus();
    });
  };

  /**
   * Close a panel —— give focus back to the node that had it before opening.
   *
   * ★ Without restoring focus, the `autoFocus` input leaves focus on `BODY`,
   *   and typing fails after closing (measured on both "@ reference document" and "backlinks").
   */
  const closePanel = (): void => {
    const back = panelReturnFocus.current;
    panelReturnFocus.current = null;
    setPanel(null);
    if (back) focusReq(back, 'end');
  };

  /**
   * Open / close the find bar.
   *
   * ★ The same "one-way focus migration" pitfall (measured):
   *   The find bar's "find" input has `autoFocus`, so opening it steals focus from
   *   `DIV.node-text` to `INPUT`; after closing, focus lands on `BODY`,
   *   and everything the user types next is **lost** (measured ['A','B','C'] → ['A','B','C']).
   */
  const openFind = (): void => {
    panelReturnFocus.current = activeNodeId || null;
    setFind((f) => ({ ...f, open: !f.open }));
  };

  const closeFind = (): void => {
    const back = panelReturnFocus.current;
    panelReturnFocus.current = null;
    setFind((f) => ({ ...f, open: false }));
    if (back) focusReq(back, 'end');
  };

  const commit = (next: OutlineNode[], focus?: FocusReq): void => {
    if (focus) pendingFocus.current = focus;
    nodesRef.current = next;
    onChange(next);
  };

  /**
   * Single entry point for structural changes (adding / removing nodes, changing level, formatting, todos…).
   *
   * ★★★ `'struct'` must be passed explicitly (a measured **discrete operations wrongly merged** bug):
   *
   *   The second argument of `onChange` was originally passed by only a few call sites,
   *   and `mutate` went through `commit(next)`, **dropping the kind**.
   *   So the merge window on the mount side judged only by "node ID + 1.2 seconds",
   *   treating two completely different things alike:
   *     · continuous typing (should merge, otherwise Ctrl+Z undoes one character at a time)
   *     · three indents / three moves up (**must not** merge, they are three independent user decisions)
   *   Measured: 3 Tab indents (500ms apart) produced only 1 undo point,
   *   so a single Ctrl+Z undid all three steps.
   *
   *   Fix: mark structural operations as `'struct'` so the merge window **applies to text editing only**.
   */
  const mutate = (fn: (draft: OutlineNode[]) => FocusReq | void): void => {
    const draft = cloneNodes(nodesRef.current);
    const focus = fn(draft);
    if (focus) pendingFocus.current = focus;
    nodesRef.current = draft;
    onChange(draft, 'struct');
  };

  // ---------- structural ops ----------
  const splitNode = (id: string): void => {
    const el = elMap.current.get(id);
    if (!el) return;
    const { before, after } = splitHtmlAtCaret(el);
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      const plainAfter = htmlToText(after).trim();
      const entry = flattenVisible(draft).find((e) => e.node.id === id);
      // Empty node: Enter **creates a new sibling at the same level**. No exceptions.
      //
      // ★ This used to be `n.text = ''; return { id, offset: 0 };` —— clearing the node and
      //   returning the **same id**, which creates nothing at all. The consequence was that pressing Enter on an empty node
      //   showed no reaction and the node count stayed the same, so users thought Enter was broken or that "only one empty node is allowed"
      //   (maintainer feedback). Confirmed by measurement:
      //
      //       Enter on an empty node: 7 before → 7 after
      //
      //   The semantics match the user's intuition in SiYuan body text: Enter starts another empty node
      //   right after the current node, and it can be pressed repeatedly to create them in a row.
      //
      // ★★★  Correction: **no demotion even when there is a parent**.
      //
      //   The previous change covered only the **root level**; an empty node with a parent still went through outdent
      //   (moved after the parent node, i.e. promoted one level). That inconsistency broke a very natural operation:
      //
      //     Enter at the end of a level-2 node → creates an empty level-2 node ✅
      //     Enter again                    → that empty node **jumps to level 1** ❌
      //
      //   Measured (`- A / - B`, caret at the end of B, Enter pressed twice), the block tree in SiYuan:
      //   ```
      //   - A
      //     (p)
      //     - B
      //     {: id="...60ymy5h"}      ← A's child list ends here
      //   - {: id="...50rs3d9"}      ← ★ the empty node was moved out of A's child list
      //   ```
      //   The UI indent also went from 815 to 788. In the user's words, "why would it change the level, that is strange".
      //
      //   ★ Why demotion should not be Enter's job: `Shift+Tab` is "decrease indent"
      //     (see docs/SHORTCUTS.md), and `Backspace` on an empty node is **deletion**.
      //     If Enter steals demotion, a "create" key quietly performs a "move" ——
      //     whereas the user pressing Enter always expects "add a line".
      //     `docs/SHORTCUTS.md` has always said "when the node is empty, create a **sibling** node directly",
      //     and never limited that to the root level.
      if (htmlToText(before).trim() === '' && plainAfter === '' && n.children.length === 0) {
        const sibsOf = entry && entry.parent ? entry.parent.children : draft;
        const at = sibsOf.findIndex((x) => x.id === id);
        const nnRoot: OutlineNode = { id: makeSiyuanId(), modified: now(), text: '<span></span>', children: [] };
        sibsOf.splice(at >= 0 ? at + 1 : sibsOf.length, 0, nnRoot);
        return { id: nnRoot.id, offset: 'end' };
      }
      n.text = before;
      touch(n);
      const sibs = entry && entry.parent ? entry.parent.children : draft;
      const idx = sibs.findIndex((x) => x.id === id);
      const nn: OutlineNode = { id: makeSiyuanId(), modified: now(), text: after, children: [] };
      sibs.splice(idx + 1, 0, nn);
      return { id: nn.id, offset: 0 };
    });
  };

  const addSiblingNode = (id: string): void => {
    mutate((draft) => {
      const entry = flattenAll(draft).find((e) => e.node.id === id);
      const sibs = entry && entry.parent ? entry.parent.children : draft;
      const idx = sibs.findIndex((x) => x.id === id);
      const nn: OutlineNode = { id: makeSiyuanId(), modified: now(), text: '<span></span>', children: [] };
      sibs.splice(idx >= 0 ? idx + 1 : sibs.length, 0, nn);
      return { id: nn.id, offset: 0 };
    });
  };

  const addChildNode = (id: string): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      n.collapsed = false;
      const nn: OutlineNode = { id: makeSiyuanId(), modified: now(), text: '<span></span>', children: [] };
      n.children.push(nn);
      touch(n);
      return { id: nn.id, offset: 0 };
    });
  };

  const dismissKeyboard = (): void => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setKeyboardOffset(0);
    setKeyboardOpen(false);
  };

  const mergeWithPrev = (id: string): void => {
    const vis = flattenVisible(nodes);
    const i = vis.findIndex((e) => e.node.id === id);
    if (i <= 0) return;
    const prev = vis[i - 1].node;
    const prevLen = htmlToText(prev.text).length;
    mutate((draft) => {
      const cur = findNode(draft, id);
      const p = findNode(draft, prev.id);
      if (!cur || !p) return;
      p.text = (p.text || '') + (cur.text || '');
      if (cur.children.length > 0) p.children.push(...cur.children);
      // Attached paragraphs: if the current node still has paragraphs, **append them in order to the end of the previous node**.
      // Use paraToStore rather than `p.paragraphs = [...]`: what is merged in may be
      // an empty array (`cur.paragraphs === []`), which must not conjure up
      // an "empty paragraph block" on the target node; if no paragraph is merged, the target node stays as it is.
      if (cur.paragraphs && cur.paragraphs.length > 0) {
        p.paragraphs = paraToStore([...parasOf(p), ...cur.paragraphs]);
      }
      touch(p);
      removeNode(draft, id);
      // ★ Same as mergeWithNext: the element merged away is the activeElement,
      //   so the ref-based sync is blocked by `activeElement !== el` and the DOM must be written explicitly.
      const el = elMap.current.get(p.id);
      if (el) {
        el.innerHTML = p.text || '';
        hydrateEditable(el);
      }
      return { id: p.id, offset: prevLen };
    });
  };

  const mergeWithNext = (id: string): void => {
    const vis = flattenVisible(nodes);
    const i = vis.findIndex((e) => e.node.id === id);
    if (i < 0 || i >= vis.length - 1) return;
    const next = vis[i + 1].node;
    // don't merge across different parents silently? allow, simple concat
    mutate((draft) => {
      const cur = findNode(draft, id);
      const nx = findNode(draft, next.id);
      if (!cur || !nx) return;
      const len = htmlToText(cur.text).length;
      cur.text = (cur.text || '') + (nx.text || '');
      if (nx.children.length > 0) cur.children.push(...nx.children);
      // ★ Symmetric with mergeWithPrev: the attached paragraphs merged in must be appended in order to the end of the current node.
      //   Merging only text would mean that on a "merge forward" the next node's
      //   note is silently discarded (while merging backward keeps it) —— a pair of reverse operations behaving asymmetrically,
      //   which is data loss. Now both sides merge, and both use paraToStore to collapse empty arrays.
      if (nx.paragraphs && nx.paragraphs.length > 0) {
        cur.paragraphs = paraToStore([...parasOf(cur), ...nx.paragraphs]);
      }
      touch(cur);
      removeNode(draft, next.id);
      // ★★ After a merge, the merged-away element **is the current activeElement**,
      //    and the node DOM sync in the ref has the `document.activeElement !== el` guard,
      //    so the new text is **never written into the DOM**: the UI still shows the old (empty) text.
      //    Worse, the next keystroke reads that **stale empty string** back into the model,
      //    and the merged-in text is **permanently lost** (measured 4 nodes → 2).
      //    Here the content is written straight into the DOM to bypass the activeElement guard.
      const el = elMap.current.get(id);
      if (el) {
        el.innerHTML = cur.text || '';
        hydrateEditable(el);
      }
      return { id, offset: len };
    });
  };

  const topLevelIds = (ids: string[]): string[] => {
    const set = new Set(ids);
    return ids.filter((id) => {
      let p = flatAll.find((e) => e.node.id === id)?.parent;
      while (p) {
        if (set.has(p.id)) return false;
        p = flatAll.find((e) => e.node.id === p!.id)?.parent || null;
      }
      return true;
    });
  };

  // The indent / outdent implementation was extracted into `indent.ts` (pure tree operations, unit-testable offline,
  // see indent.test.ts). Here we only wrap mutate and set the focus after writing back.
  //
  // ★ Order matters with multi-selection: it must be processed **back to front**, otherwise selecting all siblings yields
  //   a "flat" result rather than a "staircase". See the notes on indentNodes in indent.ts ——
  //   SiYuan's own listIndent also has staircase semantics.
  const indentNodes = (ids: string[]): void => {
    const tops = topLevelIds(ids);
    if (tops.length === 0) return;
    mutate((draft) => {
      indentInTree(draft, tops);
      return { id: tops[tops.length - 1], offset: 'end' };
    });
  };

  const outdentNodes = (ids: string[]): void => {
    const tops = topLevelIds(ids);
    if (tops.length === 0) return;
    mutate((draft) => {
      outdentInTree(draft, tops);
      return { id: tops[tops.length - 1], offset: 'end' };
    });
  };

  const moveNodes = (ids: string[], dir: -1 | 1): void => {
    const tops = topLevelIds(ids);
    if (tops.length === 0) return;
    mutate((draft) => {
      const ordered = tops.slice().sort((a, b) => {
        const ea = flattenAll(draft).find((e) => e.node.id === a);
        const eb = flattenAll(draft).find((e) => e.node.id === b);
        const la = ea && ea.parent ? ea.parent.children : draft;
        const lb = eb && eb.parent ? eb.parent.children : draft;
        if (la !== lb) return 0;
        return la.findIndex((x) => x.id === a) - la.findIndex((x) => x.id === b);
      });
      if (dir === -1) {
        for (const id of ordered) {
          const e = flattenAll(draft).find((x) => x.node.id === id);
          if (!e) continue;
          const list = e.parent ? e.parent.children : draft;
          const i = list.findIndex((x) => x.id === id);
          if (i > 0) {
            [list[i - 1], list[i]] = [list[i], list[i - 1]];
            touch(list[i]);
          }
        }
      } else {
        for (const id of ordered.reverse()) {
          const e = flattenAll(draft).find((x) => x.node.id === id);
          if (!e) continue;
          const list = e.parent ? e.parent.children : draft;
          const i = list.findIndex((x) => x.id === id);
          if (i >= 0 && i < list.length - 1) {
            [list[i + 1], list[i]] = [list[i], list[i + 1]];
            touch(list[i]);
          }
        }
      }
      return { id: tops[0], offset: 'end' };
    });
  };

  const deleteNodes = (ids: string[]): void => {
    if (ids.length === 0) return;
    const vis = flattenVisible(nodes);
    const firstIdx = Math.min(...ids.map((id) => vis.findIndex((e) => e.node.id === id)).filter((i) => i >= 0));
    const fallback = vis[Math.max(0, firstIdx - 1)] || vis[1];
    const tops = topLevelIds(ids);
    mutate((draft) => {
      const goneIds = new Set<string>();
      const collect = (n: OutlineNode): void => {
        goneIds.add(n.id);
        n.children.forEach(collect);
      };
      for (const id of tops) {
        const gone = removeNode(draft, id);
        if (gone) {
          collect(gone);
          const imgs: string[] = [];
          const walk = (n: OutlineNode) => {
            const m = n.text.match(/data-img="([^"]+)"/g) || [];
            m.forEach((x) => {
              const mm = /data-img="([^"]+)"/.exec(x);
              if (mm) imgs.push(mm[1]);
            });
            n.children.forEach(walk);
          };
          walk(gone);
          // fire-and-forget image cleanup
          imgs.forEach((imgId) => {
            import('./images').then((mod) => mod.deleteImage(imgId));
          });
        }
      }
      if (fallback && findNode(draft, fallback.node.id)) return { id: fallback.node.id, offset: 'end' };
      const f2 = flattenVisible(draft)[0];
      if (f2) return { id: f2.node.id, offset: 'end' };
    });
    setSelected([]);
  };

  // Collapse/expand. The implementation lives in pure functions in `tree-ops.ts` (offline-unit-testable, see
  // the "collapse granularity" section of tree-ops.test.ts) -- here we only wrap it in mutate.
  const toggleCollapse = (id: string, recursive: boolean): void => {
    mutate((draft) => {
      toggleCollapseAt(draft, id, recursive);
    });
  };

  const setCollapseAll = (v: boolean): void => {
    mutate((draft) => {
      const walk = (list: OutlineNode[]) => {
        for (const n of list) {
          if (n.children.length > 0) n.collapsed = v;
          walk(n.children);
        }
      };
      walk(draft);
    });
  };

  const setCollapseByLevel = (targetLevel: number): void => {
    mutate((draft) => {
      const walk = (list: OutlineNode[], currentLevel: number) => {
        for (const n of list) {
          if (n.children.length > 0) {
            n.collapsed = currentLevel >= targetLevel;
          }
          walk(n.children, currentLevel + 1);
        }
      };
      walk(draft, 1);
    });
  };

  // Matches X's official behavior: collapse/expand sibling topics (Ctrl+Shift+.)
  const toggleSiblings = (id: string): void => {
    mutate((draft) => {
      const entry = flattenAll(draft).find((e) => e.node.id === id);
      const sibs = entry && entry.parent ? entry.parent.children : draft;
      const withKids = sibs.filter((s) => s.children.length > 0);
      if (withKids.length === 0) return;
      const anyOpen = withKids.some((s) => !s.collapsed);
      for (const s of withKids) {
        s.collapsed = anyOpen;
        touch(s);
      }
    });
  };

  const toggleTask = (id: string): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      n.taskStatus = nextTaskStatus(n.taskStatus);
      touch(n);
    });
  };

  const setTaskMany = (ids: string[], s: number): void => {
    mutate((draft) => {
      for (const id of ids) {
        const n = findNode(draft, id);
        if (n) {
          n.taskStatus = s;
          touch(n);
        }
      }
    });
  };

  // Matches X's official behavior (help/14): Ctrl+D creates a duplicate topic
  const duplicateNodes = (ids: string[]): void => {
    mutate((draft) => {
      const tops = topLevelIds(ids);
      let lastFocus = '';
      for (const tid of tops) {
        const entry = flattenAll(draft).find((e) => e.node.id === tid);
        if (!entry) continue;
        const sibs = entry.parent ? entry.parent.children : draft;
        const idx = sibs.findIndex((x) => x.id === tid);
        const copy = cloneNodes([entry.node])[0];
        const reid = (n: OutlineNode): void => {
          n.id = makeSiyuanId();
          touch(n);
          n.children.forEach(reid);
        };
        reid(copy);
        sibs.splice(idx + 1, 0, copy);
        lastFocus = copy.id;
      }
      if (lastFocus) {
        setAnchor(lastFocus);
        return { id: lastFocus, offset: 0 };
      }
    });
  };

  const setHeadingMany = (ids: string[], h: 0 | 1 | 2 | 3): void => {
    mutate((draft) => {
      for (const id of ids) {
        const n = findNode(draft, id);
        if (n) {
          n.heading = h;
          touch(n);
        }
      }
    });
  };

  const toggleNumberedMany = (ids: string[]): void => {
    mutate((draft) => {
      // if all numbered -> unnumber, else number all
      const all = ids.every((id) => findNode(draft, id)?.numbered);
      for (const id of ids) {
        const n = findNode(draft, id);
        if (n) {
          n.numbered = !all;
          touch(n);
        }
      }
    });
  };

  /**
   * Whole-block toggle: no paragraphs -> create one empty paragraph and focus it; paragraphs exist -> if **all** of them are empty, clear the whole block.
   *
   * Why not "always clear":
   *   as long as one paragraph still has content, pressing Esc / clicking the button must not wipe the user's content.
   *   Note that this is **multiple paragraphs**; judging a single string is not enough,
   *   the criterion must become "**all** paragraphs are empty" for the block to count as empty -- a missed check deletes content by mistake,
   *   while an extra check leaves an empty block that can never be cleared.
   *
   * ⚠️ Turning all-empty (e.g. ['','']) into undefined here is **intentional**:
   *   this is the user actively triggering "collapse the attached paragraphs", which means "I do not want this block anymore".
   *   This differs from paraToStore's collapse condition -- there it collapses only when "not one paragraph is left",
   *   whereas here the user explicitly asked to collapse. Neither affects the rule that "an empty paragraph is itself legal".
   */
  const togglePara = (id: string): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      const list = parasOf(n);
      if (list.length === 0) {
        n.paragraphs = [''];
        touch(n);
        // The paragraph box is only mounted on the next frame, so focusing must wait for the render to finish (same as the old setTimeout(…,0))
        setTimeout(() => {
          const els = paraMap.current.get(id);
          const el = els?.[0];
          if (el) {
            setCaret(el, 'end');
            setActiveNodeId(id);
          }
        }, 0);
      } else if (list.every(isBlankPara)) {
        delete n.paragraphs;
        touch(n);
      } else {
        touch(n);
      }
    });
  };

  /**
   * Close the attached paragraph box (keeping its content) and give focus back to the node.
   *
   * ★★★ Why this is needed (a measured **user trapped inside the note** bug, still applies):
   *
   *   Escape in the note box used to call `toggleNote` directly. `toggleNote`'s semantics are
   *   "toggle **existence**":
   *   ```
   *   } else {
   *     if ((n.note || '').trim() === '') delete n.note;   // only an empty note is deleted
   *   }
   *   ```
   *   When the note is **non-empty** this branch does nothing -- so pressing Esc:
   *   - the note box does not disappear
   *   - focus stays inside the note box
   *   - characters still go into the note (not into the body)
   *
   *   ```
   *   after clicking the note, active: DIV.node-note
   *   ★ after Esc, note box count: 1          ← not closed
   *   ★ after Esc, active: DIV.node-note ← focus did not leave
   *   ★ after Esc, typing: ['A','B','C'] → ['A','B','C']  ← the characters went into the note, not the body
   *   ```
   *   The user expects "Esc should collapse the note and let me keep typing in the node", but is actually trapped.
   *
   *   Fix: Esc = **keep content + collapse + return focus** (consistent with SiYuan's native block note).
   *   To delete the note, use "Esc after clearing all paragraphs" or click the note button again.
   *
   * ⚠️ Requirement added once there were multiple paragraphs: **the box itself does not disappear** (otherwise the user cannot move between paragraphs),
   *   so here we **do not clear to undefined**, we only send focus back to the node body.
   *   Only if every paragraph is empty do we also collapse the whole block (equivalent to the old "delete an empty note").
   */
  const closePara = (id: string): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      const list = parasOf(n);
      // All empty -> collapse the whole block; if anything has content keep it as-is (the content was already written back to the model by syncPara)
      if (list.length > 0 && list.every(isBlankPara)) delete n.paragraphs;
      touch(n);
    });
    // ★ After collapsing, focus must be given back to the node -- the same rule as the other overlays:
    //   "whoever takes it gives it back". Otherwise focus falls to BODY,
    //   and everything the user types next is lost (a pitfall this project has hit many times).
    focusReq(id, 'end');
  };

  const moveDrop = (targetId: string, zone: Exclude<DropZone, null>, ids: string[]): void => {
    const tops = topLevelIds(ids.filter((i) => i !== targetId));
    if (tops.length === 0) return;
    // prevent dropping into own descendant
    const desc = new Set<string>();
    const collect = (n: OutlineNode) => {
      desc.add(n.id);
      n.children.forEach(collect);
    };
    for (const id of tops) {
      const n = nodeById.get(id);
      if (n) collect(n);
    }
    if (desc.has(targetId)) return;
    mutate((draft) => {
      const moving: OutlineNode[] = [];
      for (const id of tops) {
        const g = removeNode(draft, id);
        if (g) moving.push(g);
      }
      // ⚠️ Do not call this `t` -- it is the i18n lookup function
      const tgt = flattenAll(draft).find((e) => e.node.id === targetId);
      if (!tgt) {
        draft.push(...moving);
        return;
      }
      if (zone === 'child') {
        tgt.node.children.push(...moving);
        tgt.node.collapsed = false;
      } else {
        const list = tgt.parent ? tgt.parent.children : draft;
        let idx = list.findIndex((x) => x.id === targetId);
        if (zone === 'below') idx += 1;
        list.splice(idx, 0, ...moving);
      }
      moving.forEach(touch);
    });
    setSelected([]);
  };

  /**
   * Which row the finger's current position falls on, and which zone it belongs to.
   *
   * Uses the **same** 25%/75% split as desktop `onDragOver`, so both input methods feel identical.
   */
  const touchHitTest = (
    x: number,
    y: number,
    skipId: string,
  ): { id: string; zone: Exclude<DropZone, null> } | null => {
    const el = document.elementFromPoint(x, y);
    // ★ When `.node-row` is not hit, **do not give up immediately** -- see the comment below.
    //   (a finger resting at the bottom edge of the screen usually hits the `.mobile-bar-fixed` keyboard bar,
    //     or the 380px of empty padding after scrolling to the bottom.)
    const row = (el as HTMLElement | null)?.closest?.('.node-row') as HTMLElement | null;
    if (row) {
      const id = row.getAttribute('data-node-id');
      if (id && id !== skipId) {
        const r = row.getBoundingClientRect();
        const zone = dropZoneFor(y, r.top, r.height);
        if (!zone) return null;
        return { id, zone };
      }
      return null;
    }
    // ★★★ Fallback: find the **vertically nearest visible node**.
    //
    //   Why it is needed: `.om-outline-wrap` reserves room below the last node
    //   (`padding-bottom: 40vh` on desktop; `24px` under `@media (max-width: 768px)` -- `src/styles.css`).
    //   Measured at the bottom of the scroll range (scrollTop=max): every node was above the top of the
    //   screen (node 20: top=-66, visible node count=0), so a finger at the edge lands on no row
    //   -> the drop indicator disappears -> releasing the drag does nothing.
    //
    //   Falling back to the visible node nearest the finger keeps "drag to the very bottom" meaningful.
    const rows = Array.from(document.querySelectorAll('.om-outline-wrap .node-row')) as HTMLElement[];
    // Only **valid** rows go to the check (rows without data-node-id and the row being dragged are skipped)
    const cand: Array<{ id: string; top: number; height: number }> = [];
    for (const r of rows) {
      const id = r.getAttribute('data-node-id');
      if (!id || id === skipId) continue;
      const rr = r.getBoundingClientRect();
      cand.push({ id, top: rr.top, height: rr.height });
    }
    // Only accept ones **not too far from the finger** (within one screen), otherwise drops are arbitrary
    const hit = nearestRowZone(y, cand, window.innerHeight * 0.6);
    return hit ? { id: cand[hit.index].id, zone: hit.zone } : null;
  };

  /** Find the scroll container used while dragging (`.outline-wrap` with overflow-y:auto) */
  const findScrollBox = (from: HTMLElement | null): HTMLElement | null => {
    let el: HTMLElement | null = from;
    while (el && el !== document.body) {
      const cs = window.getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  };

  /**
   * Decide whether to auto-scroll from the finger's current position and update the drop target.
   *
   * ★ Driven by a rAF loop instead of touchmove events --
   *   when the finger **rests** at the edge without moving, touchmove no longer fires,
   *   but the user expects "keep scrolling", so we must advance it on a timer ourselves.
   */
  const stepAutoScroll = (): void => {
    const st = touchDragRef.current;
    const box = scrollBoxRef.current;
    if (!st || !st.active || !box) {
      autoScrollRef.current = null;
      return;
    }
    const r = box.getBoundingClientRect();
    // ★ The bottom must avoid the **mobile keyboard bar** (measured `.mobile-bar-fixed`:
    //   with a finger at y=834 that is what gets hit, and no node-row is found).
    //   Raising the bottom edge above the keyboard bar keeps the scroll region where nodes are.
    const bar = document.querySelector('.mobile-keyboard-bar') as HTMLElement | null;
    const barH = bar && bar.getBoundingClientRect().height > 0 ? bar.getBoundingClientRect().height : 0;
    const bottomLimit = Math.min(r.bottom, window.innerHeight) - barH;
    // Scrolling starts within 90px of the top/bottom edge; the closer to the edge, the faster
    const EDGE = 90;
    const MAX = 18; // px / frame
    let dy = 0;
    if (st.y > bottomLimit - EDGE) {
      const f = Math.min(1, (st.y - (bottomLimit - EDGE)) / EDGE);
      dy = Math.ceil(f * MAX);
    } else if (st.y < r.top + EDGE) {
      const f = Math.min(1, (r.top + EDGE - st.y) / EDGE);
      dy = -Math.ceil(f * MAX);
    }
    if (dy !== 0) {
      const before = box.scrollTop;
      const beforeLastBottom = (() => {
        const rows = document.querySelectorAll('.om-outline-wrap .node-row');
        const last = rows[rows.length - 1] as HTMLElement | undefined;
        return last ? last.getBoundingClientRect().bottom : 0;
      })();
      box.scrollTop = before + dy;
      // ★★★ Out-of-range guard (fixed from measurements).
      //
      //   `.om-outline-wrap` reserves room below the last node (`padding-bottom: 40vh` on desktop;
      //   `24px` under `@media (max-width: 768px)` -- `src/styles.css`), so "scrolling down forever"
      //   ends with the **last node above the top of the screen**.
      //   Probe measurements (position of the last node while scrolling to the bottom):
      //     {t: 5,  b: 39}  →  {t: -13, b: 21}  →  {t: -31, b: 3}
      //     →  {t: -49, b: -15}  →  {t: -66, b: -32}   ← all of them off screen
      //
      //   ⇒ After reaching the bottom there is **no node left to drop on**; the drop indicator disappears and releasing does nothing.
      //
      //   Fix: while scrolling down, if the **last node has moved entirely above the bottom of the viewport**
      //   (i.e. further scrolling only moves it further up), **roll back** the scroll to where it just touches the bottom edge.
      if (shouldRollBackScroll(dy, beforeLastBottom, bottomLimit)) {
        box.scrollTop = before;
      }
      // Once it cannot scroll any more (top/bottom reached) there is no need to compute the drop target
      if (box.scrollTop !== before) {
        const hit = touchHitTest(st.x, st.y, st.dragId);
        setDrop((d) => {
          if (!hit) return d === null ? d : null;
          return d && d.id === hit.id && d.zone === hit.zone ? d : hit;
        });
      }
    }
    autoScrollRef.current = window.requestAnimationFrame(stepAutoScroll);
  };

  const startAutoScroll = (): void => {
    if (autoScrollRef.current !== null) return;
    autoScrollRef.current = window.requestAnimationFrame(stepAutoScroll);
  };

  const stopAutoScroll = (): void => {
    if (autoScrollRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
    scrollBoxRef.current = null;
  };

  /** End the touch drag (timers and state must be cleaned up whether or not the drop succeeded) */
  const endTouchDrag = (commit: boolean): void => {
    const st = touchDragRef.current;
    if (!st) return;
    if (st.timer !== null) window.clearTimeout(st.timer);
    stopAutoScroll();
    touchDragRef.current = null;
    setTouchDragging(false);
    if (!commit) {
      setDrop(null);
      setDragIds([]);
      return;
    }
    const target = drop;
    if (target && target.id !== st.dragId) {
      // ★ Exactly the same path as the desktop drop -- no separate mobile logic
      moveDrop(target.id, target.zone, [st.dragId]);
    }
    setDrop(null);
    setDragIds([]);
  };

  /**
   * Long-press start (triggered on `.bullet`).
   *
   * Mobile has no hover/right-click, so long-press is the most universal "pick up" gesture.
   * A 350ms long press enters drag mode; moving the finger more than 8px meanwhile counts as scrolling/selecting and cancels it.
   */
  const onBulletTouchStart = (e: React.TouchEvent<HTMLElement>, id: string): void => {
    if (readOnly) return;
    // ⚠️ Do not call this `t` -- it is the i18n lookup function
    const touch = e.touches[0];
    if (!touch) return;
    touchDragRef.current = {
      timer: null,
      active: false,
      dragId: id,
      x: touch.clientX,
      y: touch.clientY,
      startX: touch.clientX,
      startY: touch.clientY,
    };
    const st = touchDragRef.current;
    st.timer = window.setTimeout(() => {
      const cur = touchDragRef.current;
      if (!cur || cur.dragId !== id) return;
      cur.active = true;
      setTouchDragging(true);
      setDragIds([id]);
      // ★ After entering drag mode, find the scroll container and start edge auto-scroll
      scrollBoxRef.current = findScrollBox(
        (document.querySelector('.om-outline-wrap') as HTMLElement | null) ?? null,
      );
      startAutoScroll();
      // Light haptic feedback (on devices that support it)
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore it if unsupported */
      }
    }, 350);
  };

  const onBulletTouchMove = (e: React.TouchEvent<HTMLElement>): void => {
    const st = touchDragRef.current;
    if (!st) return;
    // ⚠️ Do not call this `t` -- it is the i18n lookup function
    const touch = e.touches[0];
    if (!touch) return;
    st.x = touch.clientX;
    st.y = touch.clientY;
    if (!st.active) {
      // Moved too much before entering drag mode -> the user is scrolling, cancel the long press
      if (Math.abs(touch.clientX - st.startX) > 8 || Math.abs(touch.clientY - st.startY) > 8) {
        if (st.timer !== null) window.clearTimeout(st.timer);
        touchDragRef.current = null;
      }
      return;
    }
    // ★ Already in drag mode: scrolling must be prevented, otherwise the page follows the finger and drop targets are wrong
    e.preventDefault();
    const hit = touchHitTest(touch.clientX, touch.clientY, st.dragId);
    setDrop((d) => {
      if (!hit) return d === null ? d : null;
      return d && d.id === hit.id && d.zone === hit.zone ? d : hit;
    });
  };

  const onBulletTouchEnd = (e: React.TouchEvent<HTMLElement>): void => {
    const st = touchDragRef.current;
    if (!st) return;
    if (st.active) e.preventDefault();
    endTouchDrag(true);
  };

  // ---------- clipboard ----------
  const serializeNodes = (ids: string[]): { json: string; text: string; html: string } => {
    const tops = topLevelIds(ids);
    const list: OutlineNode[] = [];
    for (const id of tops) {
      const n = nodeById.get(id);
      if (n) list.push(JSON.parse(JSON.stringify(n)));
    }
    const lines: string[] = [];
    const htmlParts: string[] = [];
    const walk = (ns: OutlineNode[], depth: number) => {
      for (const n of ns) {
        // ⚠️ Do not call this `t` -- it is the i18n lookup function
        const text = htmlToText(n.text);
        lines.push(`${'  '.repeat(depth)}- ${text}`);
        htmlParts.push(`<li>${n.text || ''}${n.children.length > 0 ? '<ul>' : ''}`);
        if (n.children.length > 0) walk(n.children, depth + 1);
        htmlParts.push(`${n.children.length > 0 ? '</ul>' : ''}</li>`);
      }
    };
    walk(list, 0);
    return {
      json: JSON.stringify({ app: 'om/nodes', nodes: list }),
      text: lines.join('\n'),
      html: `<ul>${htmlParts.join('')}</ul>`,
    };
  };

  const onCopy = (e: React.ClipboardEvent, id: string): void => {
    const sel = window.getSelection();
    // if user selected text inside node, let native copy work
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      const el = elMap.current.get(id);
      if (el && el.contains(r.commonAncestorContainer)) return;
    }
    const ids = selected.includes(id) && selected.length > 0 ? selected : [id];
    const s = serializeNodes(ids);
    e.preventDefault();
    e.clipboardData.setData('application/x-om-nodes', s.json);
    e.clipboardData.setData('text/html', s.html);
    e.clipboardData.setData('text/plain', s.text);
  };

  const onCut = (e: React.ClipboardEvent, id: string): void => {
    onCopy(e, id);
    const ids = selected.includes(id) && selected.length > 0 ? selected : [id];
    // only structural cut when no text selection
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    deleteNodes(ids);
  };

  const pasteNodesAt = (id: string, list: OutlineNode[]): void => {
    mutate((draft) => {
      const entry = flattenAll(draft).find((e) => e.node.id === id);
      const cur = findNode(draft, id);
      // replace current if empty
      if (cur && htmlToText(cur.text).trim() === '' && cur.children.length === 0) {
        const lst = entry && entry.parent ? entry.parent.children : draft;
        const idx = lst.findIndex((x) => x.id === id);
        const fresh = cloneNodes(list);
        const stamp = (n: OutlineNode) => {
          n.id = makeSiyuanId();
          n.modified = now();
          n.children.forEach(stamp);
        };
        fresh.forEach(stamp);
        lst.splice(idx, 1, ...fresh);
        return { id: fresh[fresh.length - 1].id, offset: 'end' };
      }
      const lst = entry && entry.parent ? entry.parent.children : draft;
      const idx = entry ? lst.findIndex((x) => x.id === id) : lst.length - 1;
      const fresh = cloneNodes(list);
      const stamp = (n: OutlineNode) => {
        n.id = makeSiyuanId();
        n.modified = now();
        n.children.forEach(stamp);
      };
      fresh.forEach(stamp);
      lst.splice(idx + 1, 0, ...fresh);
      return { id: fresh[fresh.length - 1].id, offset: 'end' };
    });
  };

  const onPaste = (e: React.ClipboardEvent, id: string): void => {
    const dt = e.clipboardData;
    const files = dt.files;
    if (files && files.length > 0) {
      const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (imgs.length > 0) {
        e.preventDefault();
        insertImageFiles(id, imgs);
        return;
      }
    }
    const custom = dt.getData('application/x-om-nodes');
    if (custom) {
      try {
        const parsed = JSON.parse(custom);
        if (parsed && parsed.app === 'om/nodes' && Array.isArray(parsed.nodes)) {
          e.preventDefault();
          pasteNodesAt(id, parsed.nodes);
          return;
        }
      } catch {
        // fall through
      }
    }
    const text = dt.getData('text/plain');
    if (text && text.includes('\n')) {
      e.preventDefault();
      const lines = text.split('\n');
      // build nested by indent (2 spaces or tab = 1 level)
      const roots: OutlineNode[] = [];
      const stack: { n: OutlineNode; d: number }[] = [];
      for (const raw of lines) {
        const m = /^(?:\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/.exec(raw);
        const body = (m ? m[1] : raw).trim();
        if (!body && raw.trim() === '') continue;
        const indent = raw.match(/^(\s*)/)?.[1] || '';
        const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
        const nn: OutlineNode = {
          id: makeSiyuanId(),
          modified: now(),
          text: `<span>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`,
          children: [],
        };
        while (stack.length > 0 && stack[stack.length - 1].d >= depth) stack.pop();
        if (stack.length === 0) roots.push(nn);
        else stack[stack.length - 1].n.children.push(nn);
        stack.push({ n: nn, d: depth });
      }
      if (roots.length > 0) pasteNodesAt(id, roots);
      return;
    }
    // single line or rich: paste as plain text
    if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
      syncText(id);
    }
  };

  // ---------- text sync ----------
  // Single DOM-write rule: onInput only reads DOM -> writes model.
  // Markdown shortcuts ($..$ formula, #/[]/1./- prefixes) are applied here
  // synchronously inside the same model update (no setTimeout, no direct
  // el.innerHTML writes), so fast typing can never race the render.
  const syncText = (id: string): void => {
    const el = elMap.current.get(id);
    if (!el) return;
    const html = el.innerHTML;
    const n = findNode(nodesRef.current, id) ?? nodeById.get(id);
    if (!n || n.text === html) return;
    const draft = cloneNodes(nodesRef.current);
    // ⚠️ Do not call this `t` -- it is the i18n lookup function
    const node = findNode(draft, id);
    if (!node) return;
    node.text = html;
    touch(node);
    applyInlineShortcuts(node);
    enforceLimit(node);
    nodesRef.current = draft;
    onChange(draft, 'text');
  };

  /** Matches X's official nodeWordLimit=2000: over-limit plain text is truncated and written back to the focused DOM via corrected. */
  const enforceLimit = (t: OutlineNode): void => {
    const plain = htmlToText(t.text);
    if (plain.length > NODE_WORD_LIMIT) {
      t.text = `<span>${escapeHtml(plain.slice(0, NODE_WORD_LIMIT))}</span>`;
      corrected.current.add(t.id);
    }
  };

  /** Markdown/formula shortcuts on freshly synced model text.
   *  Mutates the draft node in place. When a transform fires, record the id
   *  in `corrected` so the render pass force-syncs the focused DOM (React
   *  normally skips focused nodes to preserve IME/caret stability). */
  const applyInlineShortcuts = (t: OutlineNode): void => {
    // work on plain text (strip tags), keep it simple: only whole-line patterns
    const div = document.createElement('div');
    div.innerHTML = t.text;
    const plain = (div.textContent || '').replace(/\u00a0/g, ' ');
    let m: RegExpMatchArray | null;
    if ((m = /^(#{1,3})\s+(.*)\s$/.exec(plain))) {
      const level = m[1].length as 1 | 2 | 3;
      t.heading = level;
      t.text = `<span>${escapeHtml(m[2])}</span>`;
      pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
      return;
    }
    if (/^\[\]\s+/.test(plain) || plain === '[] ') {
      t.taskStatus = TASK_TODO;
      t.text = `<span>${escapeHtml(plain.replace(/^\[\]\s*/, ''))}</span>`;
      pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
      return;
    }
    if (/^\[x\]\s+/i.test(plain) || /^\[x\] $/i.test(plain)) {
      t.taskStatus = TASK_DONE;
      t.text = `<span>${escapeHtml(plain.replace(/^\[x\]\s*/i, ''))}</span>`;
      pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
      return;
    }
    if (/^1\.\s+/.test(plain) || plain === '1. ') {
      t.numbered = true;
      t.text = `<span>${escapeHtml(plain.replace(/^1\.\s*/, ''))}</span>`;
      pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
      return;
    }
    if (/^-\s+/.test(plain) && !/-\s\[/.test(plain)) {
      t.text = `<span>${escapeHtml(plain.replace(/^-\s+/, ''))}</span>`;
      pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
      return;
    }
    // trailing $latex$ + space -> formula span (match on html, keep tags intact)
    if (/\$[^$\n]{1,200}\$\s$/.test(plain)) {
      const html = t.text;
      const idx = html.lastIndexOf('$');
      if (idx > 0) {
        const start = html.lastIndexOf('$', idx - 1);
        if (start >= 0) {
          const latex = html.slice(start + 1, idx).replace(/<[^>]*>/g, '');
          if (latex.trim()) {
            const frag = `<span data-formula="${escapeAttr(latex)}" class="formula">$${escapeAttr(latex)}$</span>&nbsp;`;
            t.text = html.slice(0, start) + frag + html.slice(idx + 1).replace(/^(\s|&nbsp;)/, '');
            pendingFocus.current = { id: t.id, offset: 'end' };
      corrected.current.add(t.id);
          }
        }
      }
    }
  };

  /**
   * Write the DOM content of the idx-th paragraph box back into the model.
   *
   * Three differences from the old `syncNote` (all forced by multiple paragraphs):
   *   ① It must carry an **index**: one node has several boxes, so without knowing which paragraph changed there is no way to write back.
   *   ② A short paragraph list must be **padded**: the array can be shorter than the DOM (e.g. a paragraph just inserted has not yet been
   *      through a model update); padding uses empty strings, and the write must never be abandoned because of `undefined`
   *      -- that amounts to silently dropping what the user just typed.
   *   ③ Over-limit truncation applies only to **this paragraph** and does not affect sibling paragraphs.
   *
   * Empty-value semantics: every value written back goes through `paraToStore` -- it collapses to
   * `undefined` only when the paragraph array is empty; **empty-string paragraphs are kept as-is** (a blank line the user typed on purpose must not be swallowed).
   */
  const syncPara = (id: string, idx: number): void => {
    const els = paraMap.current.get(id);
    const el = els?.[idx];
    if (!el) return;
    let html = el.innerHTML;
    if (htmlToText(html).length > NODE_WORD_LIMIT) {
      html = `<span>${escapeHtml(htmlToText(html).slice(0, NODE_WORD_LIMIT))}</span>`;
      corrected.current.add(id);
    }
    const draft = cloneNodes(nodesRef.current);
    // ⚠️ Do not call this `t` -- it is the i18n lookup function
    const node = findNode(draft, id);
    if (!node) return;
    const list = parasOf(node);
    if (idx >= list.length) {
      // Padding: fill the missing middle positions with empty strings to keep indices aligned (do not splice elsewhere)
      while (list.length < idx) list.push('');
      list.push(html);
    } else {
      if (list[idx] === html) return;
      list[idx] = html;
    }
    node.paragraphs = paraToStore(list);
    touch(node);
    nodesRef.current = draft;
    onChange(draft, 'text');
  };

  /**
   * Split the idx-th paragraph into two at the caret: this paragraph keeps `before`, the new one (index idx+1) gets `after`.
   *
   * ★★★ Why this must be done **atomically in a single mutate**, and cannot be split into
   *   two calls of "syncPara(this paragraph=before) + insertParaAfter(new paragraph=after)":
   *
   *   `syncPara` / `insertParaAfter` both start from `cloneNodes(nodes)`,
   *   and `nodes` is a **snapshot of this frame's props**; at the mount level `onChange` is
   *   `void handleOutlineChange(...)` (async persist + setState).
   *   Calling it twice in a row means the second call still clones from the **same old snapshot**,
   *   so the paragraph change written by the first call is **entirely overwritten** --
   *   the symptom is "pressing Enter in the middle of a paragraph makes the second half vanish".
   *   This is the same class of defect as the comment on `mergeWithNext` (write-back race / lost text).
   *   Merged into a single mutate it produces **one** onChange, and the snapshot always matches.
   *
   * The new paragraph is inserted at index idx+1 rather than pushed to the end: when the user presses Enter in a middle paragraph,
   * they expect the new line right there; pushing to the end would make the content jump away.
   */
  const splitParaAt = (id: string, idx: number, before: string, after: string): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      const list = parasOf(n);
      if (idx < 0 || idx >= list.length) return;
      const next = [...list];
      // This paragraph keeps `before`; an empty string is a legal value, so no truthiness check
      next[idx] = before;
      // Out-of-range guard: idx comes from a DOM callback and the node may already have been changed externally
      const at = idx + 1;
      next.splice(at, 0, after);
      n.paragraphs = next;
      touch(n);
      // After the split the caret must land at the **start of the new paragraph** (i.e. the old caret position). Write the DOM first, then place focus:
      // the new box is not mounted in this frame, so wait for the next one; otherwise the caret falls to BODY,
      // and everything the user types next is lost.
      //
      // ⚠️ This paragraph's DOM must also be rewritten explicitly: `cur` is the activeElement,
      //    and the render-time ref skips it because of the `document.activeElement !== el` guard;
      //    leaving it alone still shows the whole pre-split text in the UI (which is then read back into the model on write-back,
      //    duplicating the content). Same reasoning as the fix described in mergeWithNext.
      const curEl = paraMap.current.get(id)?.[idx] ?? null;
      if (curEl) curEl.innerHTML = before;
      setTimeout(() => {
        const el = paraMap.current.get(id)?.[at];
        if (el) {
          setCaret(el, 'start');
          setActiveNodeId(id);
        }
      }, 0);
    });
  };

  /**
   * Delete the idx-th paragraph. If not one paragraph is left afterwards -> the whole block collapses to undefined.
   *
   * ★ This is the path where "only an explicit user deletion removes it":
   *   only an explicit call to this function (backspacing an empty paragraph away, etc.) really removes a paragraph,
   *   and empty-string paragraphs are **never** filtered out automatically.
   */
  const removePara = (id: string, idx: number): void => {
    mutate((draft) => {
      const n = findNode(draft, id);
      if (!n) return;
      const list = parasOf(n);
      if (idx < 0 || idx >= list.length) return;
      const next = list.filter((_, i) => i !== idx);
      n.paragraphs = paraToStore(next);
      touch(n);
      // Focus return: after deleting the current paragraph, hand the caret to the previous one (or to the node body if there is none).
      // ★ Focus falling to BODY makes every later keyboard action useless.
      if (next.length > 0) {
        const at = Math.max(idx - 1, 0);
        setTimeout(() => {
          const els = paraMap.current.get(id);
          const el = els?.[at];
          if (el) {
            setCaret(el, 'end');
            setActiveNodeId(id);
          }
        }, 0);
      } else {
        setTimeout(() => {
          const el = elMap.current.get(id);
          if (el) {
            setCaret(el, 'end');
            setActiveNodeId(id);
          }
        }, 0);
      }
    });
  };

  // ---------- Attached paragraphs of the title node (docParagraphs) management ----------
  const syncDocPara = (idx: number): void => {
    const el = titleParaRefs.current[idx];
    if (!el) return;
    let html = el.innerHTML;
    if (htmlToText(html).length > NODE_WORD_LIMIT) {
      html = `<span>${escapeHtml(htmlToText(html).slice(0, NODE_WORD_LIMIT))}</span>`;
    }
    const list = [...(docParagraphs ?? [])];
    if (idx >= list.length) {
      while (list.length < idx) list.push('');
      list.push(html);
    } else {
      if (list[idx] === html) return;
      list[idx] = html;
    }
    onDocParagraphsChange?.(list);
  };

  const splitDocParaAt = (idx: number, before: string, after: string): void => {
    const list = [...(docParagraphs ?? [])];
    if (idx < 0 || idx >= list.length) return;
    const next = [...list];
    next[idx] = before;
    const at = idx + 1;
    next.splice(at, 0, after);
    onDocParagraphsChange?.(next);

    const curEl = titleParaRefs.current[idx];
    if (curEl) curEl.innerHTML = before;
    setTimeout(() => {
      const el = titleParaRefs.current[at];
      if (el) {
        setCaret(el, 'start');
        setActiveNodeId('__root__');
      }
    }, 0);
  };

  const removeDocPara = (idx: number): void => {
    const list = [...(docParagraphs ?? [])];
    if (idx < 0 || idx >= list.length) return;
    const next = list.filter((_, i) => i !== idx);
    onDocParagraphsChange?.(next);
    if (next.length > 0) {
      const at = Math.max(idx - 1, 0);
      setTimeout(() => {
        const el = titleParaRefs.current[at];
        if (el) {
          setCaret(el, 'end');
          setActiveNodeId('__root__');
        }
      }, 0);
    } else {
      setTimeout(() => {
        if (titleInputRef.current) {
          titleInputRef.current.focus();
          setActiveNodeId('__root__');
        }
      }, 0);
    }
  };

  const toggleDocPara = (): void => {
    const list = docParagraphs ?? [];
    if (list.length === 0) {
      onDocParagraphsChange?.(['']);
      setTimeout(() => {
        const el = titleParaRefs.current[0];
        if (el) {
          setCaret(el, 'end');
          setActiveNodeId('__root__');
        }
      }, 0);
    } else if (list.every(isBlankPara)) {
      onDocParagraphsChange?.([]);
      if (titleInputRef.current) titleInputRef.current.focus();
    } else {
      if (titleInputRef.current) titleInputRef.current.focus();
    }
  };

  const handleTitleParaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, pi: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (titleInputRef.current) titleInputRef.current.focus();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const cur = e.currentTarget;
      const { before, after } = splitHtmlAtCaret(cur);
      splitDocParaAt(pi, before, after);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (titleInputRef.current) {
        titleInputRef.current.focus();
        setActiveNodeId('__root__');
      }
      return;
    }
    if (e.key === 'Backspace') {
      const cur = e.currentTarget;
      if (cur.innerText.trim() === '' || cur.innerHTML === '') {
        e.preventDefault();
        removeDocPara(pi);
        return;
      }
    }
    if (e.key === 'ArrowUp') {
      if (!isCaretOnFirstLine(e.currentTarget)) return;
      e.preventDefault();
      const prev = pi > 0 ? titleParaRefs.current[pi - 1] : null;
      if (prev) {
        setCaret(prev, 'end');
      } else if (titleInputRef.current) {
        titleInputRef.current.focus();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (!isCaretOnLastLine(e.currentTarget)) return;
      e.preventDefault();
      const next = pi < (docParagraphs?.length ?? 0) - 1 ? titleParaRefs.current[pi + 1] : null;
      if (next) {
        setCaret(next, 'start');
      } else {
        const vis = flattenVisible(displayedNodes);
        if (vis.length > 0) {
          const firstId = vis[0].node.id;
          const el = elMap.current.get(firstId);
          if (el) {
            setCaret(el, 'start');
            setActiveNodeId(firstId);
          }
        }
      }
      return;
    }
  };


  // ---------- keyboard ----------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, id: string): void => {
    const el = e.currentTarget;
    const ids = selected.includes(id) && selected.length > 0 ? selected : [id];
    const mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (mod && e.key === 'y') {
      e.preventDefault();
      onRedo();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) outdentNodes(ids);
      else indentNodes(ids);
      return;
    }
    if (e.altKey && e.key === 'Enter') {
      // Matches X's official behavior (help/14): Alt+Enter adds an image
      e.preventDefault();
      setAnchor(id);
      setActiveNodeId(id);
      fileRef.current?.click();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      splitNode(id);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      // Matches X's official behavior (help/20): Shift+Enter enters/exits the description area instead of inserting a line break
      e.preventDefault();
      togglePara(id);
      return;
    }
    if (e.key === ' ') {
      // markdown/formula shortcuts run synchronously inside syncText (onInput);
      // nothing to do on keydown.
      return;
    }
    if (e.key === 'Backspace') {
      // Matches X's official behavior (help/14): Ctrl+Shift+Backspace quickly deletes a topic
      if (mod && e.shiftKey) {
        e.preventDefault();
        deleteNodes(ids);
        setSelected([]);
        setAnchor(null);
        return;
      }      const sel = window.getSelection();
      if (sel && sel.isCollapsed && getCaretOffset(el) === 0) {
        const vis = flattenVisible(displayedNodes);
        const i = vis.findIndex((x) => x.node.id === id);
        const cur = nodeById.get(id);
        if (cur && htmlToText(cur.text).trim() === '' && cur.children.length === 0) {
          e.preventDefault();
          if (i > 0) {
            deleteNodes([id]);
            focusReq(vis[i - 1].node.id, 'end');
          } else if (vis.length > 1) {
            deleteNodes([id]);
          }
          return;
        }
        if (i > 0) {
          e.preventDefault();
          if (selected.length > 1 && selected.includes(id)) deleteNodes(selected);
          else mergeWithPrev(id);
          return;
        }
      }
      return;
    }
    if (e.key === 'Delete') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        const plainLen = htmlToText(el.textContent ? `<span>${el.textContent}</span>` : '').length;
        const atEnd = getCaretOffset(el) >= plainLen;
        if (atEnd) {
          const vis = flattenVisible(displayedNodes);
          if (vis.findIndex((x) => x.node.id === id) < vis.length - 1) {
            e.preventDefault();
            mergeWithNext(id);
            return;
          }
        }
        // ★★★ Delete must also be handled when the caret is **not at the end of the line** (a measured **empty shell node** bug).
        //
        //   The original implementation had only two paths:
        //     · caret at end of line → mergeWithNext
        //     · multi-select ≥2     → deleteNodes
        //   **single selection + caret not at end of line** fell straight through and did nothing -- so
        //   the browser ran its **native forward-delete**, removing the text while **the node stayed**.
        //
        //   Measured (click "B" → press Home → press Delete):
        //   ```
        //   UI: ['A','B','C']  →  ['A','','C']     ← empty shell
        //   SiYuan: ['A','B','C']  →  ['A','','C']     ← the empty shell was persisted too
        //   ```
        //   The user thinks "I deleted this topic", but actually an empty node is left behind,
        //   and pressing Delete again still cannot remove it (for an empty node `getCaretOffset>=plainLen`
        //   is true, so it goes to mergeWithNext → swallowing the **next** node instead).
        //
        //   Fix: match Backspace's symmetric semantics -- an empty node is deleted outright,
        //   otherwise it merges with the next one (same as end-of-line behavior, which matches outline-editing intuition).
        const vis = flattenVisible(displayedNodes);
        const i = vis.findIndex((x) => x.node.id === id);
        const cur = nodeById.get(id);
        if (cur && htmlToText(cur.text).trim() === '' && cur.children.length === 0) {
          e.preventDefault();
          if (vis.length > 1) {
            deleteNodes([id]);
            // Hand focus to the next one (or the previous one if there is none) so focus never dangles
            const next = vis[i + 1]?.node.id ?? vis[i - 1]?.node.id;
            if (next) focusReq(next, 'end');
          }
          return;
        }
        e.preventDefault();
        if (i < vis.length - 1) mergeWithNext(id);
        return;
      }
      if (selected.length > 1 && selected.includes(id)) {
        e.preventDefault();
        deleteNodes(selected);
        setSelected([]);
      }
      return;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      onZoomChange?.(id);
      return;
    }
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (zoomId) {
        const path = findPath(nodes, zoomId);
        if (path && path.length > 1) {
          onZoomChange?.(path[path.length - 2].id);
        } else {
          onZoomChange?.(null);
        }
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      if (e.altKey) {
        e.preventDefault();
        moveNodes(ids, -1);
        return;
      }
      if (!isCaretOnFirstLine(el)) {
        return;
      }
      e.preventDefault();
      const vis = flattenVisible(displayedNodes);
      const i = vis.findIndex((x) => x.node.id === id);
      const j = i - 1;
      if (j < 0) {
        if (!zoomNode && titleInputRef.current) {
          titleInputRef.current.focus();
          const len = titleInputRef.current.value.length;
          titleInputRef.current.setSelectionRange(len, len);
          setActiveNodeId(null);
        }
        return;
      }
      const target = vis[j].node;
      if (e.shiftKey) {
        const a = anchor || id;
        const ai = vis.findIndex((x) => x.node.id === a);
        const lo = Math.min(ai < 0 ? i : ai, j);
        const hi = Math.max(ai < 0 ? i : ai, j);
        setAnchor(a);
        setSelected(vis.slice(lo, hi + 1).map((x) => x.node.id));
      } else {
        setSelected([]);
        setAnchor(null);
      }
      // ★ When the target node has attached paragraphs: ArrowUp first enters the **end of its last paragraph** (visually
      //   right above the line), instead of jumping straight to the previous node -- otherwise the paragraph content in between
      //   is simply unreachable from the keyboard.
      const targetParas = parasOf(target);
      const targetParaEls = paraMap.current.get(target.id);
      const lastParaEl =
        targetParas.length > 0 ? targetParaEls?.[targetParas.length - 1] ?? null : null;
      if (lastParaEl && !e.shiftKey) {
        setCaret(lastParaEl, 'end');
        setActiveNodeId(target.id);
        if (rootRef.current) ensureVisible(rootRef.current, lastParaEl);
      } else {
        const targetEl = elMap.current.get(target.id);
        if (targetEl) {
          setCaret(targetEl, 'end');
          setActiveNodeId(target.id);
          if (rootRef.current) ensureVisible(rootRef.current, targetEl);
        }
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      if (e.altKey) {
        e.preventDefault();
        moveNodes(ids, 1);
        return;
      }
      if (!isCaretOnLastLine(el)) {
        return;
      }
      // ★ When the current node has attached paragraphs: ArrowDown first dives into the **first paragraph** (visually right below the body),
      //   instead of jumping straight to the next node. With multiple paragraphs it then walks down one by one.
      const curNode = nodeById.get(id);
      const curParas = parasOf(curNode);
      const curParaEls = paraMap.current.get(id);
      const firstParaEl = curParas.length > 0 ? curParaEls?.[0] ?? null : null;
      if (firstParaEl && !e.shiftKey) {
        e.preventDefault();
        setCaret(firstParaEl, 'start');
        setActiveNodeId(id);
        if (rootRef.current) ensureVisible(rootRef.current, firstParaEl);
        return;
      }
      e.preventDefault();
      const vis = flattenVisible(displayedNodes);
      const i = vis.findIndex((x) => x.node.id === id);
      const j = i + 1;
      if (j >= vis.length) return;
      const target = vis[j].node;
      if (e.shiftKey) {
        const a = anchor || id;
        const ai = vis.findIndex((x) => x.node.id === a);
        const lo = Math.min(ai < 0 ? i : ai, j);
        const hi = Math.max(ai < 0 ? i : ai, j);
        setAnchor(a);
        setSelected(vis.slice(lo, hi + 1).map((x) => x.node.id));
      } else {
        setSelected([]);
        setAnchor(null);
      }
      const targetEl = elMap.current.get(target.id);
      if (targetEl) {
        setCaret(targetEl, 'start');
        setActiveNodeId(target.id);
        if (rootRef.current) ensureVisible(rootRef.current, targetEl);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && getCaretOffset(el) === 0) {
        const vis = flattenVisible(displayedNodes);
        const i = vis.findIndex((x) => x.node.id === id);
        if (i > 0) {
          e.preventDefault();
          const prevId = vis[i - 1].node.id;
          const prevEl = elMap.current.get(prevId);
          if (prevEl) {
            setCaret(prevEl, 'end');
            setActiveNodeId(prevId);
            if (rootRef.current) ensureVisible(rootRef.current, prevEl);
          }
        }
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        const plainLen = (el.textContent || '').length;
        if (getCaretOffset(el) >= plainLen) {
          const vis = flattenVisible(displayedNodes);
          const i = vis.findIndex((x) => x.node.id === id);
          if (i >= 0 && i < vis.length - 1) {
            e.preventDefault();
            const nextId = vis[i + 1].node.id;
            const nextEl = elMap.current.get(nextId);
            if (nextEl) {
              setCaret(nextEl, 'start');
              setActiveNodeId(nextId);
              if (rootRef.current) ensureVisible(rootRef.current, nextEl);
            }
          }
        }
      }
      return;
    }
    if (e.key === 'Escape') {
      setSelected([]);
      setAnchor(null);
      // ★ Use closeFind / closePanel rather than a bare setState --
      //   only that way does focus return to the node (see the closePanel comment)
      closeFind();
      closePanel();
      return;
    }
    // Collapse keys match X's official behavior (help/14 + evidence from the bundle):
    // current Ctrl/Alt+. | siblings Ctrl+Shift+. | all Alt+Shift+./Ctrl+Alt+Shift+.
    if ((mod || e.altKey) && (e.key === '.' || e.key === '\u3002')) {
      e.preventDefault();
      if (e.altKey && e.shiftKey) {
        const anyOpen = displayedNodes.some((n) => !n.collapsed && n.children.length > 0);
        const next = cloneNodes(nodesRef.current);
        const setAll = (list: OutlineNode[], val: boolean) => {
          for (const item of list) {
            if (item.children.length > 0) item.collapsed = val;
            setAll(item.children, val);
          }
        };
        setAll(next, anyOpen);
        nodesRef.current = next;
        onChange(next, 'struct');
      } else if (e.shiftKey) {
        toggleSiblings(id);
      } else {
        toggleCollapse(id, e.altKey);
      }
      return;
    }
    if (mod && e.altKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault();
      setCollapseByLevel(Number(e.key));
      return;
    }
    if (mod && (e.key === '/' || e.key === '?')) {
      e.preventDefault();
      e.stopPropagation(); // Stop propagation to the App's global listener, so it is not toggled back after opening
      openPanel('shortcuts');
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
      // Matches X's official behavior (help/14): Ctrl+D creates a duplicate topic
      e.preventDefault();
      duplicateNodes(ids);
      return;
    }
    if (mod && e.altKey && (e.key === 't' || e.key === 'T')) {
      // Matches X's official behavior (help/14): Ctrl+Alt+T adds a table
      e.preventDefault();
      openPanel('table');
      return;
    }
    if (mod && e.key === 'Enter') {
      // Matches X's official behavior (help/14): Ctrl+Enter = strikethrough; the task toggle uses Ctrl+Shift+L/K
      e.preventDefault();
      fmt('strikeThrough');
      return;
    }
    if (mod && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      setTaskMany(ids, TASK_TODO);
      return;
    }
    if (mod && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      setTaskMany(ids, TASK_DONE);
      return;
    }
    if (mod && e.key === 'f') {
      e.preventDefault();
      openFind();
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      const sel = window.getSelection();
      const text = (e.currentTarget.textContent || '').trim();
      const isAllTextSelected =
        sel &&
        sel.rangeCount > 0 &&
        (sel.toString().trim() === text || text === '');
      if (isAllTextSelected) {
        // ★ All text inside the node is already selected, or the node is empty: select every node in the outline
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.blur();
        setSelected(flat.map((x) => x.node.id));
        setAnchor(flat[0]?.node.id || null);
        return;
      }
      return;
    }
  };


  // ---------- toolbar actions (operate on saved range) ----------
  const fmt = (cmd: string, val?: string): void => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el.isContentEditable && rootRef.current?.contains(el)) {
      document.execCommand(cmd, false, val);
      const id = el.getAttribute('data-node-id');
      if (id) syncText(id);
    }
  };

  const fmtSafe = (cmd: string, val?: string): void => {
    let el = document.activeElement as HTMLElement | null;
    if (!el || !el.isContentEditable || !rootRef.current?.contains(el)) {
      const id = activeNodeId || flat[0]?.node.id;
      if (id) {
        el = elMap.current.get(id) || null;
        if (el) el.focus();
      }
    }
    if (el && el.isContentEditable && rootRef.current?.contains(el)) {
      document.execCommand(cmd, false, val);
      const id = el.getAttribute('data-node-id');
      if (id) syncText(id);
    }
  };

  const wrapSelection = (before: string, after: string): void => {
    const el = document.activeElement as HTMLElement | null;
    const r = lastRange.current;
    if (el && el.isContentEditable && rootRef.current?.contains(el) && r) {
      insertHtml(r, el, `${before}${after}`);
      const id = el.getAttribute('data-node-id');
      if (id) {
        // move caret between
        setTimeout(() => {
          const cur = elMap.current.get(id);
          if (cur) setCaret(cur, getCaretOffset(cur));
        }, 0);
        syncText(id);
      }
    }
  };

  const insertAtCaret = (html: string): void => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el.isContentEditable && rootRef.current?.contains(el)) {
      insertHtml(lastRange.current, el, html);
      const id = el.getAttribute('data-node-id');
      if (id) syncText(id);
    }
  };

  const insertImageFiles = (id: string, files: File[]): void => {
    (async () => {
      const parts: string[] = [];
      for (const f of files) {
        // Upload straight to SiYuan assets and store the **returned path** in data-img.
        // getImageUrl returns asset paths unchanged, so the render path needs no change.
        const path = await putImage(f, f.name || 'image.png');
        parts.push(`<img data-img="${escapeAttr(path)}" alt="${escapeAttr(f.name)}" />`);
      }
      const el = elMap.current.get(id);
      if (el) {
        insertHtml(lastRange.current, el, parts.join('') + '&nbsp;');
        hydrateEditable(el);
        syncText(id);
      }
    })();
  };

  const clearFormat = (id: string): void => {
    const n = nodeById.get(id);
    if (!n) return;
    document.execCommand('removeFormat', false);
    // unwrap custom spans but keep formula/img/table/link
    const div = document.createElement('div');
    div.innerHTML = n.text;
    div.querySelectorAll('span').forEach((s) => {
      if (s.hasAttribute('data-formula') || s.querySelector('img,table')) return;
      if (s.hasAttribute('data-tag') || s.hasAttribute('data-mention') || s.hasAttribute('data-noderef')) {
        // ⚠️ Do not call this `t` -- it is the i18n lookup function
        const textNode = document.createTextNode(s.textContent || '');
        s.replaceWith(textNode);
        return;
      }
      s.removeAttribute('style');
      if (!s.attributes.length) {
        const frag = document.createDocumentFragment();
        while (s.firstChild) frag.appendChild(s.firstChild);
        s.replaceWith(frag);
      }
    });
    div.querySelectorAll('[style]').forEach((x) => x.removeAttribute('style'));
    div.querySelectorAll('b,i,s,u,code').forEach((x) => {
      const frag = document.createDocumentFragment();
      while (x.firstChild) frag.appendChild(x.firstChild);
      x.replaceWith(frag);
    });
    mutate((draft) => {
      // ⚠️ Do not call this `t` -- it is the i18n lookup function
      const node = findNode(draft, id);
      if (node) {
        node.text = div.innerHTML;
        touch(node);
      }
    });
  };

  const insertTable = (id: string, r: number, c: number): void => {
    let rows = '';
    for (let i = 0; i < r; i++) {
      rows += `<tr>${'<td>&nbsp;</td>'.repeat(c)}</tr>`;
    }
    const el = elMap.current.get(id);
    if (el) {
      insertHtml(lastRange.current, el, `<table><tbody>${rows}</tbody></table><div><br></div>`);
      syncText(id);
    }
    closePanel();
  };

  // ---------- find & replace ----------
  /**
   * Find & replace must cover both the **body text** and **every attached paragraph**.
   *
   * ★ After moving from "one note string" to a "paragraphs array", the indexing has to change:
   *   the old `n[key]` (`key: 'text' | 'note'`) is simply unusable on an array field --
   *   assigning `n['paragraphs']` gets you the **whole array**, and writing it back to `div.innerHTML`
   *   turns the array into a string, destroying the paragraph structure on the spot.
   *   So here "text field" and "paragraph index" are handled separately.
   *
   * ⚠️ Trailing empty paragraphs must be preserved (a measured pitfall):
   *   after replacing `['A','', '']`, filtering out the empty strings before `paraToStore`
   *   makes the two empty lines the user typed **vanish into thin air**. An empty-string paragraph is legal content,
   *   so here we use `map` to replace one by one and **never filter**, which keeps the length unchanged by construction.
   */
  const doReplace = (all: boolean): void => {
    const q = find.q;
    if (!q) return;
    let total = 0;
    const draft = cloneNodes(nodes);
    /** Replace within a single HTML fragment and return the resulting html (mutating the TreeWalker's text nodes in place) */
    const replaceInHtml = (html: string): string => {
      const div = document.createElement('div');
      div.innerHTML = html;
      const tw = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      // ⚠️ Do not call this `t` -- it is the i18n lookup function
      let textNode: Text | null;
      while ((textNode = tw.nextNode() as Text | null)) texts.push(textNode);
      for (const tx of texts) {
        const v = tx.textContent || '';
        if (!v.includes(q)) continue;
        if (all) {
          const cnt = v.split(q).length - 1;
          total += cnt;
          tx.textContent = v.split(q).join(find.rep);
        } else if (total === 0) {
          total = 1;
          tx.textContent = v.replace(q, find.rep);
        }
      }
      return div.innerHTML;
    };
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        if (n.text) {
          n.text = replaceInHtml(n.text);
          touch(n);
        }
        // Replace paragraph by paragraph: map keeps the length, empty-string paragraphs stay as they are (no filtering!)
        if (n.paragraphs && n.paragraphs.length > 0) {
          n.paragraphs = n.paragraphs.map((p) => (p ? replaceInHtml(p) : p));
          touch(n);
        }
        if (n.children.length > 0) walk(n.children);
      }
    };
    walk(draft);
    commit(draft);
    setFind((f) => ({ ...f, total }));
  };

  const countMatches = (): number => {
    if (!find.q) return 0;
    let total = 0;
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        total += htmlToText(n.text).split(find.q).length - 1;
        // Count the attached paragraphs one by one (undefined / [] are naturally 0 matches)
        for (const p of parasOf(n)) {
          total += htmlToText(p).split(find.q).length - 1;
        }
        if (n.children.length > 0) walk(n.children);
      }
    };
    walk(nodes);
    return total;
  };

  // ---------- selection helpers ----------
  const onRowClick = (e: React.MouseEvent, id: string): void => {
    // ★ Order matters: check Shift first (it needs the **previous** anchor),
    //   then Ctrl, and only then a plain click setting the anchor.
    if (e.shiftKey) {
      const actualAnchor = anchor || activeNodeId || id;
      const lo = flat.findIndex((x) => x.node.id === actualAnchor);
      const hi = flat.findIndex((x) => x.node.id === id);
      if (lo >= 0 && hi >= 0) {
        setSelected(flat.slice(Math.min(lo, hi), Math.max(lo, hi) + 1).map((x) => x.node.id));
      }
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
      setAnchor(id);
    } else {
      // ★ Plain click: set a new anchor and clear the old selection.
      //
      //   It used to set anchor without clearing selected, so "Ctrl-select A/B → plain-click D"
      //   left a self-contradictory state: the caret is in D, yet A and B are still highlighted and
      //   the bulk toolbar still says "2 items selected". The user wants to edit D but sees A/B selected.
      //
      //   The semantics of a plain click are "I want to edit this line", not "I want to add to the selection",
      //   so it should clear the selection. (Use Ctrl+click to accumulate.)
      setSelected([]);
      setAnchor(id);
    }
  };

  const handleWrapKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        return;
      }
      if (active && active.classList.contains('node-text')) {
        const sel = window.getSelection();
        const text = (active.textContent || '').trim();
        const isAllTextSelected =
          sel &&
          sel.rangeCount > 0 &&
          (sel.toString().trim() === text || text === '');
        if (!isAllTextSelected) {
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement as HTMLElement)?.blur?.();
      setSelected(flat.map((x) => x.node.id));
      setAnchor(flat[0]?.node.id || null);
    } else if (e.key === 'Escape') {
      if (ctxMenu) {
        setCtxMenu(null);
        return;
      }
      if (selected.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setSelected([]);
        setAnchor(null);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const active = document.activeElement;
      if (selected.length > 0 && (!active || !active.classList.contains('node-text'))) {
        e.preventDefault();
        e.stopPropagation();
        deleteNodes(selected);
      }
    }
  };

  const onBulletDown = (e: React.MouseEvent, id: string): { x: number; y: number } => {
    return { x: e.clientX, y: e.clientY };
  };

  // ---------- render ----------
  const selSet = useMemo(() => new Set(selected), [selected]);

  const renderNode = (entry: (typeof flatAll)[number], siblingNumberedIdx: Map<string, number>): JSX.Element => {
    const { node: n, depth } = entry;
    const isSel = selSet.has(n.id);
    const kids = n.children;
    const numIdx = n.numbered ? siblingNumberedIdx.get(n.id) : undefined;

    return (
      <div key={n.id}>
        <div
          className={`node-row${isSel ? ' selected' : ''}${n.heading ? ` om-h${n.heading}` : ''}${n.collapsed ? ' collapsed' : ''}${drop?.id === n.id ? ` drop-${drop.zone}` : ''}${touchDragging && dragIds[0] === n.id ? ' touch-dragging' : ''}`}
          data-node-id={n.id}
          onMouseDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              e.preventDefault();
              (document.activeElement as HTMLElement)?.blur?.();
            }
          }}
          onClick={(e) => onRowClick(e, n.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selected.includes(n.id)) {
              setSelected([n.id]);
              setAnchor(n.id);
            }
            setCtxMenu({
              id: n.id,
              x: e.clientX,
              y: e.clientY,
            });
          }}
          onDragOver={(e) => {
            // ★ preventDefault is also required when files are dragged in, otherwise the browser **refuses the drop outright**
            // and onDrop never fires at all (the other half of the bug: fixing only onDrop still does nothing).
            // The check uses types rather than files -- during dragover, files is usually still empty.
            const types = e.dataTransfer?.types;
            if (types && Array.prototype.indexOf.call(types, 'Files') >= 0) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              return;
            }
            if (dragIds.length === 0) return;
            e.preventDefault();
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const zone = dropZoneFor(e.clientY, rect.top, rect.height);
            if (!zone) return;
            setDrop((d) => (d && d.id === n.id && d.zone === zone ? d : { id: n.id, zone }));
          }}
          onDragLeave={() => setDrop((d) => (d && d.id === n.id ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            // ★ Handle "files dragged in" first -- symmetric with onPaste.
            //
            // Measured pitfall: this used to handle only node reordering (dragIds),
            // so dropping an image file on a node did **absolutely nothing** (with no error either),
            // while pasting the same image worked fine. Paste and drag are two independent paths,
            // and implementing only one produces "some images get in, some do not".
            const dt = e.dataTransfer;
            const dropped = dt?.files ? Array.from(dt.files) : [];
            const imgs = dropped.filter((f) => f.type.startsWith('image/'));
            if (imgs.length > 0) {
              insertImageFiles(n.id, imgs);
              setDrop(null);
              setDragIds([]);
              return;
            }
            if (dragIds.length > 0 && drop && drop.id === n.id) {
              moveDrop(n.id, drop.zone, dragIds);
            }
            setDrop(null);
            setDragIds([]);
          }}
        >
          <span
            className={`om-bullet${kids.length > 0 ? ' has-children' : ''}${n.collapsed ? ' collapsed' : ''}`}
            draggable
            title={
              n.id === zoomId
                ? t('tipBulletZoomed')
                : t('tipBulletNormal')
            }
            onDoubleClick={(e) => {
              e.stopPropagation();
              onZoomChange?.(n.id);
            }}
            // ★ Touch drag (drag after a 350ms long press). Desktop uses HTML5 drag,
            //   touch devices do not fire dragstart, so a parallel gesture path is provided here.
            onTouchStart={(e) => onBulletTouchStart(e, n.id)}
            onTouchMove={onBulletTouchMove}
            onTouchEnd={onBulletTouchEnd}
            onTouchCancel={() => endTouchDrag(false)}
            onMouseDown={(e) => {
              onBulletDown(e, n.id);
            }}
            onDragStart={(e) => {
              isDraggingBulletRef.current = true;
              const ids = selSet.has(n.id) && selected.length > 0 ? selected : [n.id];
              setDragIds(ids);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', `om-nodes:${ids.length}`);
            }}
            onDragEnd={() => {
              setTimeout(() => {
                isDraggingBulletRef.current = false;
              }, 100);
              setDragIds([]);
              setDrop(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (isDraggingBulletRef.current) return;
              if (e.ctrlKey || e.metaKey) {
                setSelected((s) => (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]));
                setAnchor(n.id);
                return;
              }
              if (e.shiftKey) {
                const actualAnchor = anchor || activeNodeId || n.id;
                const lo = flat.findIndex((x) => x.node.id === actualAnchor);
                const hi = flat.findIndex((x) => x.node.id === n.id);
                if (lo >= 0 && hi >= 0) {
                  setSelected(flat.slice(Math.min(lo, hi), Math.max(lo, hi) + 1).map((x) => x.node.id));
                }
                return;
              }
              if (e.altKey && kids.length > 0) {
                toggleCollapse(n.id, true);
              } else if (n.id === zoomId) {
                if (zoomPath && zoomPath.length > 1) {
                  onZoomChange?.(zoomPath[zoomPath.length - 2].id);
                } else {
                  onZoomChange?.(null);
                }
              } else {
                onZoomChange?.(n.id);
              }
            }}
          >
            <span className="bullet-border">
              <span className="bullet-dot dot" />
            </span>
          </span>
          {n.taskStatus ? <TaskBox status={n.taskStatus} onCycle={() => toggleTask(n.id)} /> : null}
          {numIdx !== undefined && (
            <span className="num-badge">{numIdx}.</span>
          )}
          <div className="node-body">
            <div
              ref={(el) => {
                if (el) {
                  elMap.current.set(n.id, el);
                  if (el.innerHTML !== (n.text || '') && document.activeElement !== el) {
                    el.innerHTML = n.text || '';
                    hydrateEditable(el);
                  }
                } else {
                  elMap.current.delete(n.id);
                }
              }}
              className="node-text"
              data-placeholder={t('phNodeText')}
              contentEditable={!readOnly}
              suppressContentEditableWarning
              spellCheck={false}
              data-node-id={n.id}
              onInput={() => syncText(n.id)}
              /**
               * ★★★ Clicking a block reference / mention inside a node → open the target (added).
               *
               *   Defect: `onOpenNoderef` / `onOpenMention` are two callbacks
               *   **declared but never passed a value anywhere in the project** -- so a
               *   `((id "Title"))` reference inside a node did **nothing when clicked** (with no error either).
               *
               *   ★ The rendering was fixed along the way: `kramdownToHtml` used to accept only single quotes
               *     `'...'`, whereas the SiYuan kernel produces double quotes `"..."` --
               *     so every reference coming from SiYuan degraded to plain text with no clickable element at all.
               */
              onClick={(e) => {
                // ⚠️ Do not call this `t` -- it is the i18n lookup function
                const targetEl = e.target as HTMLElement;
                const nr = targetEl.closest?.('[data-noderef]') as HTMLElement | null;
                const mn = targetEl.closest?.('[data-mention]') as HTMLElement | null;
                const target = nr?.getAttribute('data-noderef') || mn?.getAttribute('data-mention') || '';
                if (!target) return;
                e.preventDefault();
                e.stopPropagation();
                onOpenRef?.(target);
              }}
              onKeyDown={(e) => onKeyDown(e, n.id)}
              onCopy={(e) => onCopy(e, n.id)}
              onCut={(e) => onCut(e, n.id)}
              onPaste={(e) => onPaste(e, n.id)}
              onFocus={(e) => {
                // ★ Do **not** setAnchor here (the bug that was fixed).
                //
                //   `anchor` is "the start of a range selection" and should only be set by a **deliberate selection**
                //   (Ctrl+click, keyboard Shift+arrow). Focus, however, is a **side effect** --
                //   the browser focuses on mousedown already, **before** click:
                //
                //     mousedown D → focusin D (setAnchor(D)) → click D(shift)
                //
                //   So on Ctrl+click A then Shift+click D, anchor has already been changed to D,
                //   `lo === hi` ⇒ `flat.slice(3, 4)` ⇒ **only 1 node is selected**,
                //   and range selection breaks entirely (the `anchor || id` fallback makes it look fine).
                setActiveNodeId(n.id);
                if (typeof window !== 'undefined' && window.innerWidth <= 768) {
                  const targetEl = e.currentTarget;
                  setTimeout(() => {
                    if (rootRef.current) ensureVisible(rootRef.current, targetEl);
                  }, 120);
                }
              }}
            />
            {/*
              Attached paragraphs: one node → N editable boxes, **one per paragraph**.
              Paragraphs are carried by several `.node-para` elements,
              the `n.paragraphs` array, so they must be rendered paragraph by paragraph and each ref stored by index in
              `paraMap` -- write-back locates them by index (see syncPara).

              ⚠️ Use `parasOf(n).length > 0` rather than `n.paragraphs !== undefined`:
                 both `[]` and `undefined` mean "no attached paragraphs", and neither should render
                 an empty box (that would add a placeholder line out of nowhere).
            */}
            {parasOf(n).length > 0 && (
              <div className="node-paras">
                {parasOf(n).map((html, pi) => (
                  <div
                    key={pi}
                    ref={(el) => {
                      // ★ The array is stored **by index** and may contain null holes: using push without holes
                      //   would shift a later paragraph's div onto an earlier index and misalign the write-back.
                      const arr = paraMap.current.get(n.id) ?? [];
                      arr[pi] = el;
                      paraMap.current.set(n.id, arr);
                      if (el && el.innerHTML !== (html || '') && document.activeElement !== el) {
                        el.innerHTML = html || '';
                      }
                    }}
                    className="node-para"
                    data-placeholder={t('phNodePara')}
                    contentEditable={!readOnly}
                    suppressContentEditableWarning
                    spellCheck={false}
                    data-para-id={n.id}
                    data-para-idx={pi}
                    onFocus={(e) => {
                      setActiveNodeId(n.id);
                      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
                        const targetEl = e.currentTarget;
                        setTimeout(() => {
                          if (rootRef.current) ensureVisible(rootRef.current, targetEl);
                        }, 120);
                      }
                    }}
                    onInput={() => syncPara(n.id, pi)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        // ★ preventDefault is required: otherwise Escape also bubbles to the global
                        //   handler, which wipes the selection/multi-selection as well (measured).
                        e.preventDefault();
                        e.stopPropagation();
                        closePara(n.id);
                        return;
                      }
                      // ★ Enter in a paragraph box = **split into two paragraphs** at the caret (continuing SiYuan's body-text
                      //   paragraph semantics) rather than delegating to the node body's splitNode --
                      //   the latter would add a sibling topic in the mind map, while the user just wants a line break in the description.
                      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        const cur = e.currentTarget;
                        // ⚠️ splitHtmlAtCaret only **reads** the selection and does not touch the DOM; it returns
                        //   the two halves { before, after }. Here we must put after back ourselves:
                        //   an earlier version overwrote innerHTML with before directly, which threw away
                        //   the whole run of text **after** the caret (measured: pressing Enter after "A" in the paragraph "ABC"
                        //   made the remaining "BC" vanish). This is the same class of defect this project
                        //   has hit repeatedly: "a pair of reverse operations / a split operation must land both halves".
                        const { before, after } = splitHtmlAtCaret(cur);
                        splitParaAt(n.id, pi, before, after);
                        return;
                      }
                      // ★ Enter+Shift inside a paragraph: same as the body text, go back to the end of the node body
                      if (e.key === 'Enter' && e.shiftKey) {
                        e.preventDefault();
                        const el = elMap.current.get(n.id);
                        if (el) {
                          setCaret(el, 'end');
                          setActiveNodeId(n.id);
                          if (rootRef.current) ensureVisible(rootRef.current, el);
                        }
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        if (!isCaretOnFirstLine(e.currentTarget)) return;
                        e.preventDefault();
                        // Prefer moving into the **previous paragraph of the same node** (paragraph by paragraph when there are several),
                        // and only fall back to the end of the node body when this is already the first paragraph.
                        const arr = paraMap.current.get(n.id) ?? [];
                        const prev = pi > 0 ? arr[pi - 1] ?? null : null;
                        const target = prev ?? elMap.current.get(n.id) ?? null;
                        if (target) {
                          setCaret(target, 'end');
                          setActiveNodeId(n.id);
                          if (rootRef.current) ensureVisible(rootRef.current, target);
                        }
                        return;
                      }
                      if (e.key === 'ArrowDown') {
                        if (!isCaretOnLastLine(e.currentTarget)) return;
                        e.preventDefault();
                        const arr = paraMap.current.get(n.id) ?? [];
                        // The same node still has a next paragraph → go down one at a time
                        const next = pi < arr.length - 1 ? arr[pi + 1] ?? null : null;
                        if (next) {
                          setCaret(next, 'start');
                          setActiveNodeId(n.id);
                          if (rootRef.current) ensureVisible(rootRef.current, next);
                          return;
                        }
                        // Last paragraph → go to the start of the next visible node's body
                        const vis = flattenVisible(displayedNodes);
                        const i = vis.findIndex((x) => x.node.id === n.id);
                        if (i >= 0 && i < vis.length - 1) {
                          const nextId = vis[i + 1].node.id;
                          const nextEl = elMap.current.get(nextId);
                          if (nextEl) {
                            setCaret(nextEl, 'start');
                            setActiveNodeId(nextId);
                            if (rootRef.current) ensureVisible(rootRef.current, nextEl);
                          }
                        }
                        return;
                      }
                      // ★ Backspace at the start of an **empty paragraph**: delete that paragraph (only an explicit
                      //   user deletion removes it; this is the only removal path besides "an empty paragraph is itself legal").
                      if (e.key === 'Backspace') {
                        const cur = e.currentTarget;
                        const sel = window.getSelection();
                        const empty = htmlToText(cur.innerHTML).replace(/\u200b/g, '').trim() === '';
                        if (empty && sel && sel.isCollapsed && getCaretOffset(cur) === 0) {
                          e.preventDefault();
                          // Note: this does **not** recurse into the end of the previous paragraph (that would require merging two paragraphs
                          // and handling the caret, which is complex), keeping the simple "delete this paragraph" semantics.
                          removePara(n.id, pi);
                          return;
                        }
                      }
                      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
                        e.preventDefault();
                        if (e.shiftKey) onRedo();
                        else onUndo();
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          {kids.length > 0 && (
            <button
              type="button"
              className={`outliner-node-sidebar node-sidebar-arrow${n.collapsed ? ' collapsed' : ''}`}
              title={n.collapsed ? t('tipExpandCollapseChildren') : t('tipCollapseChildren')}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(n.id, e.altKey);
              }}
            >
              <div className="sidebar-border" />
              <span className="sidebar-arrow sidebar-arrow-icon" />
            </button>
          )}
        </div>
        {!n.collapsed && kids.length > 0 && (
          <div className="node-children">{renderChildren(kids, depth + 1, n)}</div>
        )}
      </div>
    );
  };

  const renderChildren = (
    list: OutlineNode[],
    _depth: number,
    _parent: OutlineNode | null,
  ): JSX.Element[] => {
    // numbered index among siblings
    const numMap = new Map<string, number>();
    let c = 0;
    for (const n of list) {
      if (n.numbered) {
        c += 1;
        numMap.set(n.id, c);
      }
    }
    const out = list.map((n) => {
      const entry = flatAll.find((e) => e.node.id === n.id);
      if (!entry) return <React.Fragment key={n.id} />;
      return renderNode(entry, numMap);
    });
    return out;
  };

  const matchDocs = docs
    .filter((d) => d.id !== docId && d.name.toLowerCase().includes(panelQ.toLowerCase()))
    .slice(0, 20);
  const matchNodes = panelQ
    ? flatAll
        .filter((e) => htmlToText(e.node.text).toLowerCase().includes(panelQ.toLowerCase()))
        .slice(0, 20)
    : flatAll.slice(0, 20);

  const currentActiveId =
    document.activeElement?.getAttribute?.('data-node-id') ||
    document.activeElement?.getAttribute?.('data-para-id') ||
    activeNodeId ||
    flat[0]?.node.id ||
    '';
  const currentActiveIds = selected.length > 0 ? selected : currentActiveId ? [currentActiveId] : [];
  const activeId = currentActiveId;
  const activeIds = currentActiveIds;

  return (
    <>
      <div
        className="om-outline-wrap"
        ref={rootRef}
        tabIndex={-1}
        data-prevent-swipe="true"
        onKeyDown={handleWrapKeyDown}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('.node-row')) return;
          e.preventDefault();
          setCtxMenu({
            id: '',
            x: e.clientX,
            y: e.clientY,
          });
        }}
        style={{
          marginBottom: isMobile
            ? (keyboardOpen ? `${keyboardOffset + (mobileBarHeight || 134)}px` : `${mobileBarHeight || 88}px`)
            : undefined,
          paddingBottom: isMobile ? '24px' : undefined,
        }}
      >
      {/* Toolbar open/close switch -- **the same one as the mind map view** (collapsed by default on narrow screens, can be expanded/collapsed).
          Shown only on narrow screens (`@container (max-width: 560px)`); on desktop it is always expanded. */}
      <button
        type="button"
        onClick={toggleBar}
        aria-expanded={barOpen}
        {...tooltip(barOpen ? t('tipCollapseBar') : t('tipExpandBar'), 'om-toolbar-toggle')}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d={barOpen ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{t('lblFormat')}</span>
      </button>
      {/* toolbar */}
      <div className={`om-toolbar${barOpen ? '' : ' om-toolbar--collapsed'}`} onMouseDown={(e) => e.preventDefault()}>
        <button title={t('tipTaskToggle')} onClick={() => setTaskMany(activeIds, TASK_TODO)}>☐</button>
        <button title={t('tipHeading1Hash')} onClick={() => setHeadingMany(activeIds, 1)} className={nodeById.get(activeIds[0])?.heading === 1 ? 'on' : ''}>H1</button>
        <button title={t('tipHeading2')} onClick={() => setHeadingMany(activeIds, 2)}>H2</button>
        <button title={t('tipHeading3')} onClick={() => setHeadingMany(activeIds, 3)}>H3</button>
        <button title={t('lblBodyText')} onClick={() => setHeadingMany(activeIds, 0)}>¶</button>
        <span className="sep" />
        <button title={t('tipBold')} onClick={() => fmt('bold')}><b>B</b></button>
        <button title={t('tipItalic')} onClick={() => fmt('italic')}><i>I</i></button>
        <button title={t('tipStrike')} onClick={() => fmt('strikeThrough')}><s>S</s></button>
        <button title={t('tipInlineCode')} onClick={() => wrapSelection('<code>', '</code>')}>&lt;/&gt;</button>
        <button title={t('tipUnderline')} onClick={() => fmt('underline')}><u>U</u></button>
        <label title={t('tipTextColor')} style={{ padding: '4px 7px', cursor: 'pointer' }}>
          A
          <input
            type="color"
            style={{ display: 'none' }}
            onChange={(e) => fmt('foreColor', e.target.value)}
          />
        </label>
        <label title={t('tipHighlightColor')} style={{ padding: '4px 7px', cursor: 'pointer', background: '#fff59d', borderRadius: 6 }}>
          H
          <input
            type="color"
            style={{ display: 'none' }}
            onChange={(e) => fmt('hiliteColor', e.target.value)}
          />
        </label>
        <button title={t('tipClearFormat')} onClick={() => activeId && clearFormat(activeId)}>⌫</button>
        <span className="sep" />
        <button title={t('tipHyperlink')} onClick={() => {
          const url = prompt(t('phLinkUrl'), 'https://');
          if (url && activeId) {
            const el = elMap.current.get(activeId);
            if (el) insertHtml(lastRange.current, el, `<a href="${escapeAttr(url)}">${escapeAttr(url)}</a>&nbsp;`);
            if (activeId) syncText(activeId);
          }
        }}>🔗</button>
        <button title={t('tipFormula')} onClick={() => {
          const latex = prompt(t('phLatexFormula'), 'E=mc^2');
          if (latex && activeId) {
            const el = elMap.current.get(activeId);
            if (el) insertHtml(lastRange.current, el, `<span data-formula="${escapeAttr(latex)}" class="formula">$${escapeAttr(latex)}$</span>&nbsp;`);
            syncText(activeId);
          }
        }}>∑</button>
        <button title={t('tipImage')} onClick={() => fileRef.current?.click()}>🖼</button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const fs = Array.from(e.target.files || []);
            if (fs.length > 0 && activeId) insertImageFiles(activeId, fs);
            e.target.value = '';
          }}
        />
        <button title={t('tipRemoteImage')} onClick={() => {
          const url = prompt(t('phImageUrl'), 'https://');
          if (url && activeId) {
            const el = elMap.current.get(activeId);
            if (el) insertHtml(lastRange.current, el, `<img src="${escapeAttr(url)}" alt="image" />&nbsp;`);
            syncText(activeId);
          }
        }}>🌐</button>
        <button title={t('tipTable')} onClick={() => (panel === 'table' ? closePanel() : openPanel('table'))}>▦</button>
        <button title="Emoji" onClick={() => (panel === 'emoji' ? closePanel() : openPanel('emoji'))}>😄</button>
        <button title={t('tipTagHash')} onClick={() => {
          const tag = prompt(t('phTagName'));
          if (tag && activeId) {
            const el = elMap.current.get(activeId);
            if (el) insertHtml(lastRange.current, el, `<span data-tag="${escapeAttr(tag)}">#${escapeAttr(tag)}</span>&nbsp;`);
            syncText(activeId);
          }
        }}>#</button>
        <button title={t('tipMentionDoc')} onClick={() => openPanel('mention')}>@</button>
        <button title={t('tipNodeRef')} onClick={() => openPanel('noderef')}>⛓</button>
        <span className="sep" />
        <button title={t('tipNumbered')} onClick={() => toggleNumberedMany(activeIds)}>1.</button>
        <button title={t('tipNote')} onClick={() => activeId && (activeId === '__root__' ? toggleDocPara() : togglePara(activeId))}>📝</button>
        <button title={t('tipZoomNode')} onClick={() => activeId && onZoomChange?.(activeId)}>⊙</button>
        <button title={t('tipCollapseAll')} onClick={() => setCollapseAll(true)}>⏩</button>
        <button title={t('tipExpandAll')} onClick={() => setCollapseAll(false)}>⏪</button>
        {/* Undo/redo lives here —— the desktop toolbar originally had **no** such buttons,
            only the mobile-bar strip has them (width:0, invisible on desktop),
            so Ctrl+Z responded but had no discoverable entry point. */}
        <span className="sep" />
        <button title={t('tipUndoCtrlZ')} onClick={onUndo}>↩</button>
        <button title={t('tipRedoBoth')} onClick={onRedo}>↪</button>
        <select
          aria-label={t('tipCollapseByLevel')} title={t('tipCollapseByLevel')}
          className="level-select ariaLabel"
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'all_collapse') setCollapseAll(true);
            else if (v === 'all_expand') setCollapseAll(false);
            else if (v) setCollapseByLevel(Number(v));
            e.target.value = '';
          }}
          style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }}
          defaultValue=""
        >
          <option value="" disabled>{t('lblLevel')}</option>
          <option value="1">{t('lblLevel1')}</option>
          <option value="2">{t('lblLevel2')}</option>
          <option value="3">{t('lblLevel3')}</option>
          <option value="all_collapse">{t('cmdCollapseAll')}</option>
          <option value="all_expand">{t('cmdExpandAll')}</option>
        </select>
        <button title={t('tipFindReplace')} onClick={openFind}>🔍</button>
        <button title={t('tipSelectAllNodes')} onClick={() => setSelected(flat.map((e) => e.node.id))}>☑</button>
      </div>

      {/* insert panels */}
      {panel === 'shortcuts' && (
        <div ref={panelBoxRef} tabIndex={-1} className="shortcuts-panel" onKeyDown={panelKeyDown} style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong>{t('lblKeyboardShortcuts')}</strong>
            <button onClick={() => closePanel()}>{t('cmdClose')}</button>
          </div>
          <div className="shortcuts-grid">
            {SHORTCUTS.map((g) => (
              <div key={g.group} className="shortcuts-group">
                <div className="shortcuts-title">{g.group}</div>
                {g.items.map((it) => (
                  <div key={it.keys} className="shortcuts-row">
                    <span className="shortcuts-keys">{it.keys}</span>
                    <span className="shortcuts-desc">{it.desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {panel === 'emoji' && (
        <div ref={panelBoxRef} tabIndex={-1} onKeyDown={panelKeyDown} style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)', fontSize: 20, lineHeight: 2 }}>
          {EMOJIS.map((e) => (
            <button key={e} onClick={() => { insertAtCaret(e); }} style={{ padding: 2 }}>{e}</button>
          ))}
        </div>
      )}
      {panel === 'mention' && (
        <div ref={panelBoxRef} tabIndex={-1} onKeyDown={panelKeyDown} style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)' }}>
          <input autoFocus placeholder={t('phSearchDoc')} value={panelQ} onChange={(e) => setPanelQ(e.target.value)} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, width: 260, maxWidth: '100%', boxSizing: 'border-box' }} />
          <button onClick={() => closePanel()} style={{ marginLeft: 8 }}>{t('cmdClose')}</button>
          <div className="match-list">
            {matchDocs.map((d) => (
              <div
                key={d.id}
                className="match-item"
                onClick={() => {
                  if (activeId) {
                    const el = elMap.current.get(activeId);
                    if (el) insertHtml(lastRange.current, el, `<span data-mention="${d.id}">@${escapeAttr(d.name)}</span>&nbsp;`);
                    syncText(activeId);
                  }
                  closePanel();
                }}
              >
                @ {d.name}
              </div>
            ))}
          </div>
        </div>
      )}
      {panel === 'noderef' && (
        <div ref={panelBoxRef} tabIndex={-1} onKeyDown={panelKeyDown} style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)' }}>
          <input autoFocus placeholder={t('phSearchNode')} value={panelQ} onChange={(e) => setPanelQ(e.target.value)} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, width: 260, maxWidth: '100%', boxSizing: 'border-box' }} />
          <button onClick={() => closePanel()} style={{ marginLeft: 8 }}>{t('cmdClose')}</button>
          <div className="match-list">
            {matchNodes.map((e) => (
              <div
                key={e.node.id}
                className="match-item"
                onClick={() => {
                  const label = htmlToText(e.node.text).slice(0, 40) || t('lblEmptyParen');
                  if (activeId) {
                    const el = elMap.current.get(activeId);
                    if (el) insertHtml(lastRange.current, el, `<span data-noderef="${e.node.id}">${escapeAttr(label)}</span>&nbsp;`);
                    syncText(activeId);
                  }
                  closePanel();
                }}
              >
                {'·'.repeat(Math.min(e.depth, 6))} {htmlToText(e.node.text).slice(0, 60) || t('lblEmptyParen')}
              </div>
            ))}
          </div>
        </div>
      )}
      {panel === 'table' && (
        <div ref={panelBoxRef} tabIndex={-1} onKeyDown={panelKeyDown} style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          {t('lblRows')} <input type="number" min={1} max={20} value={tableRC.r} onChange={(e) => setTableRC((s) => ({ ...s, r: Number(e.target.value) || 1 }))} style={{ width: 56 }} />
          {t('lblCols')} <input type="number" min={1} max={10} value={tableRC.c} onChange={(e) => setTableRC((s) => ({ ...s, c: Number(e.target.value) || 1 }))} style={{ width: 56 }} />
          <button className="btn primary" onClick={() => activeId && insertTable(activeId, tableRC.r, tableRC.c)}>{t('cmdInsert')}</button>
          <button onClick={() => closePanel()}>{t('cmdClose')}</button>
        </div>
      )}

      {/* multi-select bar */}
      {selected.length > 1 && (
        <div className="selbar">
          {t('lblSelectedN', { n: selected.length })}
          <button onClick={() => indentNodes(selected)}>{t('cmdIndent')} <span className="kbd">Tab</span></button>
          <button onClick={() => outdentNodes(selected)}>{t('cmdOutdent')}</button>
          <button onClick={() => moveNodes(selected, -1)}>{t('cmdMoveUp')} <span className="kbd">Alt+↑</span></button>
          <button onClick={() => moveNodes(selected, 1)}>{t('cmdMoveDown')} <span className="kbd">Alt+↓</span></button>
          <button onClick={() => setTaskMany(selected, TASK_TODO)}>{t('cmdMarkTodo')}</button>
          <button onClick={() => setTaskMany(selected, TASK_DONE)}>{t('cmdMarkDone')}</button>
          <button onClick={() => setTaskMany(selected, TASK_NONE)}>{t('cmdClearTodo')}</button>
          <button onClick={() => deleteNodes(selected)}>{t('cmdDelete')} <span className="kbd">Del</span></button>
          <button onClick={() => { setSelected([]); setAnchor(null); }}>{t('cmdCancel')}</button>
        </div>
      )}

      {/* find bar */}
      {find.open && (
        <div className="om-findbar">
          <input
            autoFocus
            placeholder={t('phFind')}
            value={find.q}
            onChange={(e) => setFind((f) => ({ ...f, q: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const ok = (window as unknown as { find: (s: string) => boolean }).find(find.q);
                if (!ok) setFind((f) => ({ ...f, total: 0 }));
              }
              if (e.key === 'Escape') closeFind();
            }}
          />
          <input placeholder={t('phReplaceWith')} value={find.rep} onChange={(e) => setFind((f) => ({ ...f, rep: e.target.value }))} />
          <button className="btn" onClick={() => doReplace(false)}>{t('cmdReplace')}</button>
          <button className="btn" onClick={() => doReplace(true)}>{t('cmdReplaceAll')}</button>
          <span style={{ color: 'var(--text-weak)' }}>
            {find.q ? t('lblMatchCount', { n: countMatches() }) : ''}
            {find.total ? t('lblReplacedCount', { n: find.total }) : ''}
          </span>
          <button onClick={closeFind}>{t('cmdClose')}</button>
        </div>
      )}

      {zoomNode && (
        <div className="breadcrumbs">
          <button className="crumb-btn" onClick={() => onZoomChange?.(null)}>{t('cmdAllNodes')}</button>
          {zoomPath && zoomPath.slice(0, -1).map((p) => (
            <React.Fragment key={p.id}>
              <span className="crumb-sep">/</span>
              <button className="crumb-btn" onClick={() => onZoomChange?.(p.id)}>
                {htmlToText(p.text) || t('lblUntitled')}
              </button>
            </React.Fragment>
          ))}
          <span className="crumb-sep">/</span>
          <span className="crumb-cur">{htmlToText(zoomNode.text) || t('lblUntitled')}</span>
          <button
            className="crumb-back-btn ariaLabel"
            onClick={() => {
              if (zoomPath && zoomPath.length > 1) onZoomChange?.(zoomPath[zoomPath.length - 2].id);
              else onZoomChange?.(null);
            }}
            aria-label={t('tipBackUpAltLeft')} title={t('tipBackUpAltLeft')}
          >
            {t('cmdBackUp')}
          </button>
        </div>
      )}

      {!zoomNode && (
        <div className="outliner-title">
          <input
            ref={titleInputRef}
            className="title"
            placeholder={t('phUntitled')}
            maxLength={TITLE_MAX}
            value={docTitle ?? ''}
            onChange={(e) => onTitleChange?.(e.target.value)}
            onFocus={() => {
              setActiveNodeId('__root__');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                toggleDocPara();
                return;
              }
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (docParagraphs && docParagraphs.length > 0 && titleParaRefs.current[0]) {
                  setCaret(titleParaRefs.current[0], 'start');
                  setActiveNodeId('__root__');
                  return;
                }
                const vis = flattenVisible(displayedNodes);
                if (vis.length > 0) {
                  const firstId = vis[0].node.id;
                  setAnchor(firstId);
                  const el = elMap.current.get(firstId);
                  if (el) {
                    setCaret(el, 'start');
                    setActiveNodeId(firstId);
                    if (rootRef.current) ensureVisible(rootRef.current, el);
                  } else {
                    focusReq(firstId, 'start');
                    nodesRef.current = cloneNodes(nodesRef.current);
                    onChange(nodesRef.current);
                  }
                } else {
                  const newId = makeSiyuanId();
                  const newNode: OutlineNode = {
                    id: newId,
                    text: '<span></span>',
                    modified: now(),
                    children: [],
                  };
                  nodesRef.current = [newNode];
                  onChange([newNode], 'struct');
                  setAnchor(newId);
                  focusReq(newId, 'start');
                }
              }
            }}
          />
          {docParagraphs && docParagraphs.length > 0 && (
            <div className="node-paras outliner-title-paras">
              {docParagraphs.map((html, pi) => (
                <div
                  key={pi}
                  ref={(el) => {
                    titleParaRefs.current[pi] = el;
                    if (el && el.innerHTML !== (html || '') && document.activeElement !== el) {
                      el.innerHTML = html || '';
                    }
                  }}
                  className="node-para"
                  data-placeholder={t('phNodePara')}
                  contentEditable={!readOnly}
                  suppressContentEditableWarning
                  spellCheck={false}
                  data-para-id="__root__"
                  data-para-idx={pi}
                  onFocus={() => {
                    setActiveNodeId('__root__');
                  }}
                  onInput={() => syncDocPara(pi)}
                  onKeyDown={(e) => handleTitleParaKeyDown(e, pi)}
                />
              ))}
            </div>
          )}

        </div>
      )}

      <div
        className="outline"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.node-row')) {
            if (selected.length > 0) {
              setSelected([]);
              setAnchor(null);
            }
          }
          if (displayedNodes.length === 0) {
            const newId = makeSiyuanId();
            const newNode: OutlineNode = {
              id: newId,
              text: '<span></span>',
              modified: now(),
              children: [],
            };
            nodesRef.current = [newNode];
            onChange([newNode], 'struct');
            setAnchor(newId);
            focusReq(newId, 'start');
          }
        }}
      >
        {displayedNodes.length === 0 ? (
          <div
            className="node-row node-row-empty"
            style={{ cursor: 'text' }}
            onClick={(e) => {
              e.stopPropagation();
              const newId = makeSiyuanId();
              const newNode: OutlineNode = {
                id: newId,
                text: '<span></span>',
                modified: now(),
                children: [],
              };
              nodesRef.current = [newNode];
              onChange([newNode], 'struct');
              setAnchor(newId);
              focusReq(newId, 'start');
            }}
          >
            <span className="om-bullet">
              <span className="bullet-border">
                <span className="bullet-dot dot" />
              </span>
            </span>
            <div className="node-body">
              <div
                className="node-text empty-placeholder"
                style={{ color: 'var(--b3-theme-surface-lighter, #999)', userSelect: 'none' }}
              >
                {t('lblEmptyClickToStart')}
              </div>
            </div>
          </div>
        ) : (
          renderChildren(displayedNodes, 0, null)
        )}
      </div>
    </div>

      {/* mobile virtual keyboard accessory toolbar */}
      <div
        ref={keyboardBarRef}
        className={`mobile-keyboard-bar${keyboardOpen ? ' keyboard-open' : ''}`}
        style={{ bottom: keyboardOffset ? `${keyboardOffset}px` : '0px' }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {/* Secondary Font Style Drawer (Aa Panel) */}
        {formatDrawerOpen && (
          <div className="mobile-format-drawer">
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipBold')} title={t('tipBold')}
              onClick={() => fmtSafe('bold')}
            >
              <b>B</b>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipItalic')} title={t('tipItalic')}
              onClick={() => fmtSafe('italic')}
            >
              <i>I</i>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipUnderline')} title={t('tipUnderline')}
              onClick={() => fmtSafe('underline')}
            >
              <u>U</u>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipStrike')} title={t('tipStrike')}
              onClick={() => fmtSafe('strikeThrough')}
            >
              <s>S</s>
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className={`m-btn ${activeColorPicker === 'highlight' ? 'active' : ''}`}
              title={t('tipBgHighlight')}
              onClick={() => setActiveColorPicker((prev) => (prev === 'highlight' ? 'none' : 'highlight'))}
            >
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.5 3.3l4.2 4.2-9.2 9.2H3.3v-4.2l9.2-9.2zM15 16.7h3.3" />
              </svg>
            </button>
            <button
              type="button"
              className={`m-btn ${activeColorPicker === 'color' ? 'active' : ''}`}
              title={t('tipTextColor')}
              onClick={() => setActiveColorPicker((prev) => (prev === 'color' ? 'none' : 'color'))}
            >
              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
                <span style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'serif' }}>A</span>
                <span style={{ width: '13px', height: '2px', background: 'var(--accent, #3da8f5)', borderRadius: '1px' }} />
              </span>
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className={`m-btn ${currentActiveIds.length > 0 && nodeById.get(currentActiveIds[0])?.heading === 1 ? 'active' : ''}`}
              title={t('tipHeading1')}
              onClick={() => {
                if (currentActiveIds.length > 0) {
                  const curH = nodeById.get(currentActiveIds[0])?.heading || 0;
                  setHeadingMany(currentActiveIds, curH === 1 ? 0 : 1);
                }
              }}
            >
              H1
            </button>
            <button
              type="button"
              className={`m-btn ${currentActiveIds.length > 0 && nodeById.get(currentActiveIds[0])?.heading === 2 ? 'active' : ''}`}
              title={t('tipHeading2')}
              onClick={() => {
                if (currentActiveIds.length > 0) {
                  const curH = nodeById.get(currentActiveIds[0])?.heading || 0;
                  setHeadingMany(currentActiveIds, curH === 2 ? 0 : 2);
                }
              }}
            >
              H2
            </button>
            <button
              type="button"
              className={`m-btn ${currentActiveIds.length > 0 && nodeById.get(currentActiveIds[0])?.heading === 3 ? 'active' : ''}`}
              title={t('tipHeading3')}
              onClick={() => {
                if (currentActiveIds.length > 0) {
                  const curH = nodeById.get(currentActiveIds[0])?.heading || 0;
                  setHeadingMany(currentActiveIds, curH === 3 ? 0 : 3);
                }
              }}
            >
              H3
            </button>
            <button
              type="button"
              className={`m-btn ${currentActiveIds.length > 0 && (nodeById.get(currentActiveIds[0])?.heading || 0) === 0 ? 'active' : ''}`}
              title={t('lblBodyText')}
              onClick={() => {
                if (currentActiveIds.length > 0) {
                  setHeadingMany(currentActiveIds, 0);
                }
              }}
            >
              ¶
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipCodeMask')} title={t('tipCodeMask')}
              onClick={() => wrapSelection('`', '`')}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '12px' }}>[··]</span>
            </button>
          </div>
        )}

        {/* Color / Highlight Subbar */}
        {formatDrawerOpen && activeColorPicker === 'highlight' && (
          <div className="mobile-color-subbar">
            {[
              { label: t('lblHighlightYellow'), color: '#fff3a8' },
              { label: t('lblHighlightRed'), color: '#ffd1d1' },
              { label: t('lblHighlightGray'), color: '#e0e0e0' },
              { label: t('lblHighlightGreen'), color: '#d7e8b6' },
              { label: t('lblHighlightBlue'), color: '#cce3ff' },
              { label: t('lblHighlightPink'), color: '#fcd6eb' },
              { label: t('lblHighlightCyan'), color: '#cef1e7' },
            ].map((item) => (
              <button
                key={item.color}
                type="button"
                className="mobile-color-swatch ariaLabel"
                aria-label={item.label} title={item.label}
                style={{ background: item.color }}
                onClick={() => {
                  fmtSafe('hiliteColor', item.color);
                  setActiveColorPicker('none');
                }}
              />
            ))}
            <button
              type="button"
              className="mobile-color-swatch clear ariaLabel"
              aria-label={t('tipClearHighlight')} title={t('tipClearHighlight')}
              onClick={() => {
                fmtSafe('hiliteColor', 'transparent');
                setActiveColorPicker('none');
              }}
            />
          </div>
        )}

        {formatDrawerOpen && activeColorPicker === 'color' && (
          <div className="mobile-color-subbar">
            {[
              { label: t('lblColorBlack'), color: '#333333' },
              { label: t('lblColorGray'), color: '#797979' },
              { label: t('lblColorBlue'), color: '#3da8f5' },
              { label: t('lblColorGreen'), color: '#75c044' },
              { label: t('lblColorOrange'), color: '#ffa000' },
              { label: t('lblColorRed'), color: '#dc2a2a' },
            ].map((item) => (
              <button
                key={item.color}
                type="button"
                className="mobile-color-swatch ariaLabel"
                aria-label={item.label} title={item.label}
                style={{ background: item.color }}
                onClick={() => {
                  fmtSafe('foreColor', item.color);
                  setActiveColorPicker('none');
                }}
              />
            ))}
          </div>
        )}

        {/* Main Toolbar Row */}
        <div className="mobile-bar-main">
          <div className="mobile-bar-scroll">
            <button
              type="button"
              className={`m-btn aa-btn ${formatDrawerOpen ? 'active' : ''}`}
              title={t('tipFontStyle')}
              onClick={() => {
                setFormatDrawerOpen((prev) => !prev);
                setActiveColorPicker('none');
              }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 16L5.2 5.3a.2.2 0 0 1 .38 0L9.8 16M2.8 12.1h5.3M18.3 10v5.8M15.4 15.8a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8z" />
              </svg>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipToggleNote')} title={t('tipToggleNote')}
              onClick={() => currentActiveId && (currentActiveId === '__root__' ? toggleDocPara() : togglePara(currentActiveId))}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.2 4.2H2.5M17.5 10H6.7M17.5 15.8H6.7M2.5 10v5.8" />
              </svg>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipInsertImage')} title={t('tipInsertImage')}
              onClick={() => fileRef.current?.click()}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="2.5" width="15" height="15" rx="2" />
                <circle cx="7.5" cy="7.5" r="1.5" />
                <path d="M17.5 12.5l-2.6-2.6a1.7 1.7 0 0 0-2.4 0L5 17.5" />
              </svg>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipToggleTaskStatus')} title={t('tipToggleTaskStatus')}
              onClick={() => {
                if (currentActiveIds.length > 1) {
                  const anyTodo = currentActiveIds.some((id) => nodeById.get(id)?.taskStatus === TASK_TODO);
                  setTaskMany(currentActiveIds, anyTodo ? TASK_DONE : TASK_TODO);
                } else if (currentActiveId) {
                  toggleTask(currentActiveId);
                }
              }}
            >
              {nodeById.get(currentActiveId)?.taskStatus === TASK_DONE ? (
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="2.5" width="15" height="15" rx="2" fill="rgba(16,185,129,0.12)" />
                  <path d="M6.2 10l2.5 2.5 5-5" />
                </svg>
              ) : nodeById.get(currentActiveId)?.taskStatus === TASK_TODO ? (
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="2.5" width="15" height="15" rx="2" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="2.5" width="15" height="15" rx="2" />
                  <path d="M6.2 10l2.5 2.5 5-5" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipInsertToday')} title={t('tipInsertToday')}
              onClick={() => insertAtCaret(new Date().toLocaleDateString('zh-CN'))}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="4" width="15" height="13.5" rx="2" />
                <path d="M6 2v4M14 2v4M2.5 8h15" />
              </svg>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipInsertTable')} title={t('tipInsertTable')}
              onClick={() => currentActiveId && insertTable(currentActiveId, 3, 3)}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="2.5" width="15" height="15" rx="2" />
                <path d="M10 2.5v15M2.5 10h15" />
              </svg>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipMention')} title={t('tipMention')}
              onClick={() => insertAtCaret('@')}
            >
              <span style={{ fontSize: '15px', fontWeight: 600 }}>@</span>
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipTag')} title={t('tipTag')}
              onClick={() => insertAtCaret('#')}
            >
              <span style={{ fontSize: '15px', fontWeight: 600 }}>#</span>
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipAddSiblingEnter')} title={t('tipAddSiblingEnter')}
              onClick={() => currentActiveId && addSiblingNode(currentActiveId)}
            >
              ↵
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipAddChild')} title={t('tipAddChild')}
              onClick={() => currentActiveId && addChildNode(currentActiveId)}
            >
              ↳
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipMoveUpAltUp')} title={t('tipMoveUpAltUp')}
              onClick={() => currentActiveIds.length > 0 && moveNodes(currentActiveIds, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipMoveDownAltDown')} title={t('tipMoveDownAltDown')}
              onClick={() => currentActiveIds.length > 0 && moveNodes(currentActiveIds, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={nodeById.get(currentActiveId)?.collapsed ? t('tipExpandNode') : t('tipCollapseNode')} title={nodeById.get(currentActiveId)?.collapsed ? t('tipExpandNode') : t('tipCollapseNode')}
              onClick={() => currentActiveId && toggleCollapse(currentActiveId, false)}
            >
              {nodeById.get(currentActiveId)?.collapsed ? '▸' : '▾'}
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipZoomCurrent')} title={t('tipZoomCurrent')}
              onClick={() => currentActiveId && onZoomChange?.(currentActiveId)}
            >
              ⊙
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipUndoCtrlZ')} title={t('tipUndoCtrlZ')}
              onClick={onUndo}
            >
              ↩
            </button>
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipRedoCtrlY')} title={t('tipRedoCtrlY')}
              onClick={onRedo}
            >
              ↪
            </button>
          </div>

          <div className="mobile-bar-fixed">
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipOutdentShiftTab')} title={t('tipOutdentShiftTab')}
              onClick={() => currentActiveIds.length > 0 && outdentNodes(currentActiveIds)}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 16V4M10.8 5l-5 5 5 5M5.8 10h11.7" />
              </svg>
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn ariaLabel"
              aria-label={t('tipIndentTab')} title={t('tipIndentTab')}
              onClick={() => currentActiveIds.length > 0 && indentNodes(currentActiveIds)}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.2 10H2.5M9.2 15l5-5-5-5M17.5 4v12" />
              </svg>
            </button>
            {/*
              ★★★ Delete button (measured gap):

                Previously the mobile side had **no delete entry at all**. Measured tally: 37 reachable buttons in the mobile viewport,
                covering bold/heading/color/insert/indent/move-up-down…, yet **not a single "delete"**,
                and a long press raises no menu either.

                The desktop side relies on `Del` / `Ctrl+Shift+Backspace`, which mobile has no keys for,
                so **a node created on the phone can never be deleted on the phone** ——
                the only recourse was to go back to the desktop, or to empty the node's text and leave a hollow shell.

                This reuses the same desktop `deleteNodes` (which carries the confirmation and delete-fallback logic),
                placed next to indent, forming one group of structural operations with "outdent / indent".
            */}
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn del-btn ariaLabel"
              aria-label={t('tipDeleteNodeDel')} title={t('tipDeleteNodeDel')}
              onClick={() => {
                if (currentActiveIds.length === 0) return;
                deleteNodes(currentActiveIds);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.8 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-10M8.5 9v5M11.5 9v5" />
              </svg>
            </button>
            <span className="m-sep" />
            <button
              type="button"
              className="m-btn done-btn ariaLabel"
              aria-label={t('tipDoneCollapseKeyboard')} title={t('tipDoneCollapseKeyboard')}
              onClick={dismissKeyboard}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10.5l4 4 8-9" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Outline view: bottom floating icon action bar */}
      <div className="om-dock" onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          {...tooltip(t('tipAddSiblingEnter'), 'dock-btn add-btn')}
          onClick={() => {
            if (currentActiveId) addSiblingNode(currentActiveId);
            else if (flat.length > 0) addSiblingNode(flat[flat.length - 1].node.id);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          className={`dock-btn lock-btn${readOnly ? ' active' : ''}`}
          title={readOnly ? t('tipLocked') : t('tipUnlocked')}
          onClick={() => setReadOnly(!readOnly)}
        >
          {readOnly ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          )}
        </button>
        <div className="dock-level-wrapper" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`dock-btn level-btn${levelMenuOpen ? ' active' : ''}`}
            title={t('tipLevelCollapseExpand')}
            onClick={() => setLevelMenuOpen(!levelMenuOpen)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="15" y2="12" />
              <line x1="3" y1="18" x2="18" y2="18" />
            </svg>
          </button>
          {levelMenuOpen && (
            <div className="dock-level-popover">
              <button type="button" onClick={() => { setCollapseByLevel(1); setLevelMenuOpen(false); }}>{t('lblLevel1')}</button>
              <button type="button" onClick={() => { setCollapseByLevel(2); setLevelMenuOpen(false); }}>{t('lblLevel2')}</button>
              <button type="button" onClick={() => { setCollapseByLevel(3); setLevelMenuOpen(false); }}>{t('lblLevel3')}</button>
              <div className="popover-sep" />
              <button type="button" onClick={() => { setCollapseByLevel(99); setLevelMenuOpen(false); }}>{t('cmdExpandAll')}</button>
              <button type="button" onClick={() => { setCollapseByLevel(0); setLevelMenuOpen(false); }}>{t('cmdCollapseAll')}</button>
            </div>
          )}
        </div>
        <button
          type="button"
          className={`dock-btn search-btn${find.open ? ' active' : ''}`}
          title={t('tipFindInDoc')}
          onClick={openFind}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </div>

      {ctxMenu && (
        <>
          <div
            className="mm-ctx-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="mm-ctx-menu"
            ref={ctxMenuRef}
            style={{ left: menuPos.x, top: menuPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {ctxMenu.id ? (
              selected.length > 1 && selected.includes(ctxMenu.id) ? (
                <>
                  <div className="mm-ctx-item" style={{ opacity: 0.6, fontSize: 12 }}>
                    {t('lblSelectedN', { n: selected.length })}
                  </div>
                  <div className="mm-ctx-sep" />
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); indentNodes(selected); }}>
                    {t('cmdIndent')} <span className="mm-ctx-key">Tab</span>
                  </div>
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); outdentNodes(selected); }}>
                    {t('cmdOutdent')} <span className="mm-ctx-key">Shift+Tab</span>
                  </div>
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); moveNodes(selected, -1); }}>
                    {t('cmdMoveUp')} <span className="mm-ctx-key">Alt+↑</span>
                  </div>
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); moveNodes(selected, 1); }}>
                    {t('cmdMoveDown')} <span className="mm-ctx-key">Alt+↓</span>
                  </div>
                  <div className="mm-ctx-sep" />
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); setTaskMany(selected, TASK_TODO); }}>
                    {t('cmdMarkTodo')}
                  </div>
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); setTaskMany(selected, TASK_DONE); }}>
                    {t('cmdMarkDone')}
                  </div>
                  <div className="mm-ctx-item" onClick={() => { setCtxMenu(null); setTaskMany(selected, TASK_NONE); }}>
                    {t('cmdClearTodo')}
                  </div>
                  <div className="mm-ctx-sep" />
                  <div
                    className="mm-ctx-item mm-ctx-danger"
                    onClick={() => {
                      setCtxMenu(null);
                      deleteNodes(selected);
                    }}
                  >
                    {t('cmdDelete')} <span className="mm-ctx-key">Del</span>
                  </div>
                </>
              ) : (
                <>
                  {!readOnly && (
                    <>
                      <div
                        className="mm-ctx-item"
                        onClick={() => {
                          const id = ctxMenu.id;
                          setCtxMenu(null);
                          focusReq(id, 'end');
                        }}
                      >
                        {t('cmdEditNode')}
                      </div>
                      {/* Note/description —— the same action as that 📝 button in the toolbar (`togglePara`).
                          The context menu is the usual entry point here; keeping it only in the toolbar would leave users unable to find it. */}
                      <div
                        className="mm-ctx-item"
                        onClick={() => {
                          const id = ctxMenu.id;
                          setCtxMenu(null);
                          togglePara(id);
                        }}
                      >
                        {t('tipNote')}
                      </div>
                      <div
                        className="mm-ctx-item"
                        onClick={() => {
                          const id = ctxMenu.id;
                          setCtxMenu(null);
                          addSiblingNode(id);
                        }}
                      >
                        {t('cmdAddSibling')} <span className="mm-ctx-key">Enter</span>
                      </div>
                      <div
                        className="mm-ctx-item"
                        onClick={() => {
                          const id = ctxMenu.id;
                          setCtxMenu(null);
                          addChildNode(id);
                        }}
                      >
                        {t('cmdAddChild')} <span className="mm-ctx-key">Tab</span>
                      </div>
                      <div className="mm-ctx-sep" />
                    </>
                  )}
                  <div
                    className="mm-ctx-item"
                    onClick={() => {
                      const id = ctxMenu.id;
                      setCtxMenu(null);
                      toggleTask(id);
                    }}
                  >
                    {t('tipToggleTaskStatus')} <span className="mm-ctx-key">Ctrl+Enter</span>
                  </div>
                  {(() => {
                    const node = flatAll.find((x) => x.node.id === ctxMenu.id)?.node;
                    if (node && node.children.length > 0) {
                      return (
                        <div
                          className="mm-ctx-item"
                          onClick={() => {
                            const id = ctxMenu.id;
                            setCtxMenu(null);
                            toggleCollapse(id, true);
                          }}
                        >
                          {node.collapsed ? t('cmdExpandAll') : t('cmdCollapseAll')}
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <div
                    className="mm-ctx-item"
                    onClick={() => {
                      const id = ctxMenu.id;
                      setCtxMenu(null);
                      if (id === zoomId) {
                        onZoomChange?.(null);
                      } else {
                        onZoomChange?.(id);
                      }
                    }}
                  >
                    {ctxMenu.id === zoomId ? t('cmdAllNodes') : t('cmdFocusNode')}
                  </div>
                  {!readOnly && (
                    <>
                      <div className="mm-ctx-sep" />
                      <div
                        className="mm-ctx-item mm-ctx-danger"
                        onClick={() => {
                          const id = ctxMenu.id;
                          setCtxMenu(null);
                          deleteNodes([id]);
                        }}
                      >
                        {t('cmdDeleteNodeWithChildren')} <span className="mm-ctx-key">Del</span>
                      </div>
                    </>
                  )}
                </>
              )
            ) : (
              <>
                <div
                  className="mm-ctx-item"
                  onClick={() => {
                    setCtxMenu(null);
                    setSelected(flat.map((x) => x.node.id));
                    setAnchor(flat[0]?.node.id || null);
                  }}
                >
                  {t('tipSelectAllNodes')} <span className="mm-ctx-key">Ctrl+A</span>
                </div>
                <div
                  className="mm-ctx-item"
                  onClick={() => {
                    setCtxMenu(null);
                    setCollapseAll(false);
                  }}
                >
                  {t('cmdExpandAll')}
                </div>
                <div
                  className="mm-ctx-item"
                  onClick={() => {
                    setCtxMenu(null);
                    setCollapseAll(true);
                  }}
                >
                  {t('cmdCollapseAll')}
                </div>
                {zoomId && (
                  <div
                    className="mm-ctx-item"
                    onClick={() => {
                      setCtxMenu(null);
                      onZoomChange?.(null);
                    }}
                  >
                    {t('cmdAllNodes')}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

// re-export for App (mention navigation)
export function handleMentionClick(docId: string, onOpenDoc: (id: string) => void): void {
  onOpenDoc(docId);
}
