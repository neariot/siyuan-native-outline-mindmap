import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { OutlineNode } from '../model/types';
import { findNode, htmlToText } from '../model/tree';
import { htmlToRuns, type RichRun } from '../core/richtext';
import { escapeHtml } from '../model/html-escape';
import { RichText } from './RichText';
import { LINE_HEIGHT, MOBILE_MAX_WIDTH, wrapForWidth } from '../core/layout';
import { centerBaselineDy } from './text-baseline';
import { tooltip } from '../plugin/tooltip';
import { RichContent } from '../plugin/outline/RichContent';
import { parseSiyuanDrop } from '../plugin/sync';
import { TASK_DONE, TASK_TODO } from '../model/types';
import { t } from '../plugin/i18n';
// Pure logic (layout algorithm / theme / shape / export) has been extracted into core/layout.ts.
// Explicit re-exports keep the component's public API identical to the original Mindmap.tsx.
/** Width a branch summary label wraps inside —— it is drawn beside the branch, not in a node box. */
const SUMMARY_WRAP_W = 220;

export * from '../core/layout';
export {
  normalizeShape,
  MM_SHAPE_LABELS,
  MM_THEMES,
  MM_BRANCH_PALETTES,
  layoutOrg,
  layoutHorizontal,
  edgePath,
  exportFreemind,
  label,
  widthOf,
  calcSplitIndex,
  LINE_HEIGHT,
  wrapForWidth,
} from '../core/layout';
export type {
  MmStructure,
  MmLineStyle,
  MmTopicShape,
  BranchPalette,
  MmTheme,
  Box,
  Edge,
  Layout,
} from '../core/layout';
import {
  normalizeShape,
  MM_SHAPE_LABELS,
  MM_THEMES,
  themeToDark,
  layoutOrg,
  layoutHorizontal,
  edgePath,
  exportFreemind,
  label,
  widthOf,
} from '../core/layout';
import type {
  MmStructure,
  MmLineStyle,
  MmTopicShape,
  Layout,
  Box,
  Edge,
} from '../core/layout';


/**
 * Detect whether SiYuan is in dark mode.
 *
 * ⚠️ The **attribute change** on `html[data-theme-mode]` must be observed —
 * when the user switches the theme, SiYuan does not reload the page, it only changes this attribute;
 * reading it only once leaves the mind map stuck on the old colors.
 */
function useDarkMode(): boolean {
  const [dark, setDark] = React.useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    const el = document.documentElement;
    return el.getAttribute('data-theme-mode') === 'dark' ||
           el.getAttribute('data-theme') === 'dark';
  });
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    const read = () =>
      setDark(el.getAttribute('data-theme-mode') === 'dark' ||
              el.getAttribute('data-theme') === 'dark');
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme-mode', 'data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export default function Mindmap({
  nodes,
  title,
  docParagraphs,
  onFocusNode,
  zoomId,
  onZoomChange,
  onToggleTask,
  onDeleteLink,
  // ★ Default structure: right (changed to a single direction as requested by the user).
  //
  //   It used to be `'balanced'` ("mind map (both sides)") — that splits child nodes by weight
  //   evenly to the left and right with the root centered. In a multi-root document it even splits the **root nodes** to both sides.
  //
  //   With `'right'`, every child grows to the right and the root aligns to the left.
  //   For the "outline → mind map" use case this is closer to reading intuition: depth is visible at a glance,
  //   with no need to search back and forth on both sides.
  //
  //   ★ Only the **default** changed; `'balanced'` (both sides) is still in the structure dropdown, and the user can switch at any time.
  initialStructure = 'right',
  initialThemeIdx = 0,
  initialLineStyle = 'curve',
  initialShape = 'roundedRect',
  onEditNode,
  onEditParagraphs,
  editable = true,
  onAddNode,
  onUndo,
  onRedo,
  selectedId,
  onSelectNode,
  onDeleteNode,
  deletable = true,
  onExtractSubDoc,
  onDropBlocks,
  onReparent,
}: {
  nodes: OutlineNode[];
  title: string;
  docParagraphs?: string[];
  onFocusNode?: (id: string) => void;
  zoomId?: string | null;
  onZoomChange?: (id: string | null) => void;
  onToggleTask?: (id: string) => void;
  onDeleteLink?: (fromId: string, linkId: string) => void;
  initialStructure?: MmStructure;
  initialThemeIdx?: number;
  initialLineStyle?: MmLineStyle;
  initialShape?: MmTopicShape;
  /**
   * Callback for a finished node-text edit (the plugin uses it to write back to SiYuan).
   * Plain text is passed in (HTML markup already stripped); the caller decides how to persist it.
   */
  onEditNode?: (id: string, text: string) => void;
  /**
   * Callback for a finished attached-paragraph edit (the plugin uses it to write back to SiYuan).
   *
   * An **array of plain text** is passed in (HTML markup already stripped); the caller decides how to persist it.
   * An empty string means an empty paragraph — it must be kept, not dropped as "nothing".
   */
  onEditParagraphs?: (id: string, paragraphs: string[]) => void;
  /** Set to false to disable double-click editing (read-only mode) */
  editable?: boolean;
  /**
   * Add a node.
   * - `mode: 'child'`  add a child under the currently selected node (Tab)
   * - `mode: 'sibling'` add a sibling after the selected node (Enter)
   * The parent node ID ('' at the top level) and the number of existing nodes on that level are passed in; the caller decides the new ID.
   */
  /**
   * Add a node. **The return value is the new node's id** (null / undefined when unavailable) —
   * the map uses it to enter inline editing right after the addition, so the user can keep typing.
   */
  onAddNode?: (
    parentId: string,
    mode: 'child' | 'sibling',
    afterId: string,
  ) => string | null | undefined;
  /** Currently selected node (for keyboard add/delete) */
  selectedId?: string | null;
  onSelectNode?: (id: string | null) => void;
  /**
   * Delete a node (including its subtree).
   *
   * The caller decides whether to confirm — the component itself shows no dialog.
   * Passing undefined means deletion is unsupported (that entry is greyed out in the context menu).
   */
  onDeleteNode?: (id: string) => void;
  /** Whether Delete/Backspace on a node may delete it */
  deletable?: boolean;
  /**
   * Undo / redo.
   *
   * ★ Previously **only the outline view** wired up these two callbacks; the map wired up neither —
   *   so pressing Ctrl+Z after editing a node in the map did nothing (not even a hint),
   *   while the same data was undoable in the outline view. Added after being confirmed by measurement.
   */
  onUndo?: () => void;
  onRedo?: () => void;
  /**
   * Expand a node into a SiYuan child document (native document reference + backlink).
   * Passing undefined means unsupported (the menu entry does not appear).
   */
  onExtractSubDoc?: (id: string) => void;
  /**
   * Fired when a block is dragged from SiYuan's body into the mind map.
   * `blockIds` are the SiYuan block IDs; `targetId` is the drop-target node (null when dropped on empty space).
   */
  onDropBlocks?: (blockIds: string[], targetId: string | null) => void;
  /**
   * Drag a node **onto another node** → change its parent (drag to re-parent).
   *
   * ★★ This is a **one-zone** gesture, and that is a deliberate difference from the outline, which has
   *   three (`above` / `child` / `below` in `outline/drop-zone.ts`) because a list has a meaningful
   *   "between two rows". A map does not: the only thing a drop position can mean is **which node you
   *   aimed at**, so aiming at a node reparents and aiming at blank space does nothing. An earlier version
   *   of this comment claimed "the same semantics as the outline's moveDrop" —— it never was, and the
   *   claim is the kind that gets "made true" later by adding zone logic nobody asked for.
   *
   *   ★ Releasing on blank space is a **no-op, not a promotion**: the node goes back to where the layout
   *   puts it. Positions in this view are computed entirely by `layoutHorizontal` / `layoutOrg` and the
   *   node model has no per-node coordinate, so "leave it where I dropped it" is a feature that would need
   *   a position field, its serialization and its interaction with the auto-layout —— not a behaviour to
   *   invent here. (Measured: releasing 22px outside a node's box leaves the document untouched.)
   *
   *   Dragging in the map used to be **panning the canvas** only, and nodes could not be re-parented —
   *   while the outline supported it, so the two views differed (measured: after dragging in the map, SiYuan
   *   showed no change at all).
   */
  onReparent?: (nodeIds: string[], targetId: string) => void;
}) {
  // ★★★ Mind-map preferences must survive **switching views / refreshing** (fix).
  //
  //   Defect: `structure` / `themeIdx` / `lineStyle` / `shape` / `collapsedIds`
  //   were all **useState inside the component**, while mount.ts used a ternary expression:
  //       view === 'outline' ? <Outliner/> : <Mindmap/>
  //   switching to the outline **unmounted** Mindmap, and those states vanished along with the zoom.
  //   Measured: set the structure to "balanced", the theme to "green", collapse one branch, zoom to 31%,
  //   click "outline" and back → everything returns to the defaults (right / colorful / expanded / 26%).
  //   Even a page refresh lost them.
  //
  //   By contrast, `selectedId` is **lifted into mount.ts**, so it **does** survive a view switch —
  //   two states of the same data having different fates is not a design, it is an omission.
  //
  //   Approach: persist to localStorage like `om-mm-bar-open` does.
  //   Chosen over lifting into mount.ts because these preferences **live longer than the component**
  //   (they should be remembered across documents and refreshes), whereas the selected node belongs to the current document, so lifting is right for it.
  //
  //   ★ Collapsed state is stored **per document**: node IDs differ between documents, so mixing them would bleed across.
  const PREF_KEY = 'om-mm-prefs';
  const readPrefs = (): Partial<{
    structure: MmStructure; themeIdx: number;
    lineStyle: MmLineStyle; shape: MmTopicShape;
  }> => {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      return raw ? (JSON.parse(raw) as Record<string, never>) : {};
    } catch {
      // Unavailable storage / broken JSON must not affect functionality; fall back to the defaults
      return {};
    }
  };
  const saved = readPrefs();

  const [structure, setStructure] = useState<MmStructure>(
    () => saved.structure ?? initialStructure,
  );
  const [themeIdx, setThemeIdx] = useState<number>(() => saved.themeIdx ?? initialThemeIdx);
  const [lineStyle, setLineStyle] = useState<MmLineStyle>(
    () => saved.lineStyle ?? initialLineStyle,
  );
  const [shape, setShape] = useState<MmTopicShape>(() => normalizeShape(saved.shape ?? initialShape));
  // ★ Whole-object override rather than per-field `??`: when the caller explicitly passes initial*, the caller wins.
  //   But mount.ts currently passes none of them, so localStorage is what actually applies.
  useEffect(() => {
    try {
      localStorage.setItem(
        PREF_KEY,
        JSON.stringify({ structure, themeIdx, lineStyle, shape }),
      );
    } catch {
      /* unavailable storage does not affect functionality */
    }
  }, [structure, themeIdx, lineStyle, shape]);

  // Collapsed state is stored **per document**: node IDs differ between documents, so mixing them would bleed across.
  // The first node's ID is used as the document fingerprint — it is stable and differs per document.
  // (The root node is the synthetic `__root__`, which cannot distinguish documents.)
  const docKey = nodes.length > 0 ? nodes[0].id : '';
  const COLLAPSE_KEY = `om-mm-collapsed:${docKey}`;
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    if (!docKey) return new Set();
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  // Re-read when the document changes (the component is not unmounted by a document change)
  useEffect(() => {
    if (!docKey) return;
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      setCollapsedIds(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch {
      setCollapsedIds(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Write back. Collapsing is pure view state; losing it raises no error but feels like "the click did nothing", so it is stored every time.
  useEffect(() => {
    if (!docKey) return;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedIds]));
    } catch {
      /* unavailable storage does not affect functionality */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedIds, docKey]);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [isDragging, setIsDragging] = useState(false);
  /** Context menu: {node ID, screen coordinates}; null means not open */
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  // The menu's **actual** position. It can only be fixed once rendering has measured the real size,
  // so the click position is used as a placeholder (it flickers on the first frame, but that beats ending up off-screen).
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  /**
   * ★★★ The context menu must **stay inside the viewport** (fix).
   *
   *   Symptom (measured): with the map expanding to the right, a node on the right sits against the window's right edge,
   *   the menu opens **down and to the right** from the click point → straight off the window.
   *   Scanned 13 nodes: **12** of the menus overflowed, by up to 83px.
   *   Overflow means "delete node (with children)" gets cut off —
   *   the text is unreadable and the click target is unreliable (the most dangerous action becomes the hardest to hit).
   *
   *   Approach: measure the real size after rendering; when it touches an edge, **flip to the other side** (right→left, bottom→top),
   *   then clamp to the boundary as a final safeguard, so it stays inside the viewport in every case.
   *
   *   ★ Why not `position: fixed` plus CSS `inset` and the like:
   *     the menu size varies with the text (Chinese/English, whether a shortcut hint is present),
   *     CSS cannot guess the height, so it has to be measured.
   */
  React.useLayoutEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8; // leave a small gap from the window edge; do not sit flush against it
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = ctxMenu.x;
    let y = ctxMenu.y;
    // does not fit on the right → flip to the left of the click point
    if (x + r.width + m > vw) x = ctxMenu.x - r.width;
    // does not fit below → flip above the click point
    if (y + r.height + m > vh) y = ctxMenu.y - r.height;
    // Final clamp: after those two flips it can still go out of bounds (e.g. the click point itself is very close to an edge)
    x = Math.max(m, Math.min(x, vw - r.width - m));
    y = Math.max(m, Math.min(y, vh - r.height - m));

    setMenuPos((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
  }, [ctxMenu]);
  // The node being edited (triggered by F2 / double-click outside blank space); null means not editing
  const [dropHint, setDropHint] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The id of the node that should enter editing after a new node is created.
  //
  // ★ **state** is required here, not useRef:
  //   `onAddNode` returns a Promise (the caller has to write a SiYuan block), and by the time it resolves
  //   the render that produced `nodes` is **long gone**. Assigning to a ref triggers no re-render,
  //   so an effect depending on [nodes] never re-runs — the symptom being "created but never enters editing".
  //   This pitfall was hit in practice (the probe showed the promise resolving with the new id, yet the UI did nothing).
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  /**
   * Attached-paragraph overlay: null = closed.
   *
   * A map node shows only its first paragraph (label) by default; the full text of attached paragraphs appears only after clicking the icon at the top left —
   * this keeps long text from stretching nodes taller and unbalancing the map.
   */
  const [paraView, setParaView] = useState<{ id: string; node: OutlineNode } | null>(null);
  /** Whether the attached paragraphs are being edited; false shows the read-only full-text view */
  const [paraEditing, setParaEditing] = useState(false);
  /** Edit draft: one paragraph per line, an empty line = an empty paragraph (it must be expressible, not swallowed) */
  const [paraDraft, setParaDraft] = useState('');
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const didDragRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    viewX: number;
    viewY: number;
    pointers: Map<number, { x: number; y: number }>;
    initDist?: number;
    initK?: number;
    srcNodeId: string;
    lastX: number;
    lastY: number;
  }>({
    startX: 0,
    startY: 0,
    viewX: 0,
    viewY: 0,
    pointers: new Map(),
    // ★ When a single finger presses **on a node**, record it; releasing over a different node triggers re-parenting.
    //   Pressing on blank space is pure panning (the original behaviour is unchanged).
    srcNodeId: '' as string,
    lastX: 0,
    lastY: 0,
  });
  const svgRef = useRef<SVGSVGElement>(null);
  // In dark mode the palette is converted to dark automatically.
  // Node colors are painted inside the SVG (not CSS), so the conversion has to happen here —
  // otherwise a dark UI would keep a white canvas with node text too dark to read.
  const darkRef = useDarkMode();
  const theme = React.useMemo(() => {
    const base = MM_THEMES[themeIdx] || MM_THEMES[0];
    return darkRef ? themeToDark(base) : base;
  }, [themeIdx, darkRef]);
  const vertical = structure === 'org';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if ((e.target as HTMLElement)?.closest?.('button, select, a, input')) return;
    dragRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (dragRef.current.pointers.size === 1) {
      dragRef.current.startX = e.clientX;
      dragRef.current.startY = e.clientY;
      dragRef.current.viewX = view.x;
      dragRef.current.viewY = view.y;
      didDragRef.current = false;
      // ★ Record the node hit on press (for "drag elsewhere to re-parent").
      //   Use closest to walk up to `.mm-node`; its data-node-id is the node ID.
      const nodeEl = (e.target as Element)?.closest?.('.mm-node') as HTMLElement | null;
      dragRef.current.srcNodeId = nodeEl?.getAttribute('data-node-id') ?? '';
    } else if (dragRef.current.pointers.size === 2) {
      const pts = Array.from(dragRef.current.pointers.values());
      dragRef.current.initDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      dragRef.current.initK = view.k;
    }
  };


  /**
   * Whether the viewport has been taken over manually by the user (pan / zoom).
   *
   * A container resize automatically re-`fit()`s, but **once the user has adjusted the viewport it must not auto-fit again** —
   * that would yank the view they just arranged back, which is a far more annoying interruption.
   *
   * ⚠️ It must be declared **before** callbacks such as `onPointerMove` / `onWheel`.
   *   Referencing it inside those function bodies is fine at runtime (the component has long finished rendering when a callback fires),
   *   but `const` has a temporal dead zone, so declaring it later plants a landmine for the future.
   */
  const userAdjustedView = useRef(false);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.pointers.has(e.pointerId)) return;
    dragRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;

    if (dragRef.current.pointers.size === 1) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 5) {
        if (!didDragRef.current) {
          didDragRef.current = true;
          setIsDragging(true);
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        e.preventDefault();
        // ★★★ A gesture that presses **on a node** does not pan the canvas (measured).
        //
        //   The original implementation panned unconditionally, so dragging a node moved the whole canvas —
        //   the thing under the cursor **was always the source node itself**, so the re-parent test necessarily failed
        //   (probe measurement: dragging node C → node A, C was always under the cursor in the hit rectangle, src === tgt).
        //
        //   ⇒ When a node is hit, the gesture only does "drag to re-parent"; panning is left to pressing on blank space.
        if (!dragRef.current.srcNodeId) {
          userAdjustedView.current = true;
          setView((v) => ({
            ...v,
            x: dragRef.current.viewX + dx,
            y: dragRef.current.viewY + dy,
          }));
        }
      }
    } else if (dragRef.current.pointers.size === 2 && dragRef.current.initDist && dragRef.current.initK) {
      didDragRef.current = true;
      e.preventDefault();
      const pts = Array.from(dragRef.current.pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const factor = dist / dragRef.current.initDist;
      const newK = Math.min(3, Math.max(0.2, dragRef.current.initK * factor));
      userAdjustedView.current = true;
      setView((v) => ({ ...v, k: newK }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    dragRef.current.pointers.delete(e.pointerId);
    if (dragRef.current.pointers.size === 0) {
      // ★★★ Drag to re-parent (new).
      //
      //   Measured: dragging a node in the map only **panned the canvas**, with no change in SiYuan —
      //   while the outline supported drag-to-re-parent, so the two views differed.
      //   The same semantics are reused here: drop onto a node → become its child.
      //
      //   ★ Only when the pointer "really dragged" (didDragRef), the source is a node, and the drop target is **another**
      //     node; panning that started on blank space does not trigger it.
      // ★★★ Hit-test with the **last position we recorded ourselves**, not with `e.clientX/Y`.
      //
      //   Pitfall measured in practice: `setPointerCapture` redirects later events to the capturing element, and
      //   combining the `pointerup` coordinates with `elementFromPoint` returns the **source node**
      //   instead of the drop target (probe measurement: dragging node C → node A, src and tgt were both C).
      //
      //   Also, inside SVG `elementFromPoint` often returns child elements such as `text`/`rect`,
      //   and `closest('.mm-node')` is not reliable either ⇒ so **iterate and compare rectangles ourselves**.
      const src = dragRef.current.srcNodeId;
      const px = dragRef.current.lastX;
      const py = dragRef.current.lastY;
      if (src && didDragRef.current && onReparent && (px || py)) {
        let tgt = '';
        const all = document.querySelectorAll('.mm-node');
        for (const el of Array.from(all)) {
          const r = el.getBoundingClientRect();
          if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
            tgt = el.getAttribute('data-node-id') ?? '';
            break;
          }
        }
        if (tgt && tgt !== src && tgt !== '__root__') {
          onReparent([src], tgt);
        }
      }
      dragRef.current.srcNodeId = '';
      setIsDragging(false);
      if (didDragRef.current) {
        setTimeout(() => {
          didDragRef.current = false;
        }, 120);
      }
    }
  };

  const zoomNode = zoomId ? findNode(nodes, zoomId) : null;
  const rootNode = useMemo<OutlineNode>(() => {
    if (zoomNode) return zoomNode;
    return {
      id: '__root__',
      // ★ `title` is **plain text from `blocks.content`**, not HTML —— so it must be escaped before it
      //   goes into markup. Unescaped, a document titled `use <T> for generics` renders as
      //   `use  for generics` (the `<T>` is parsed as a tag and dropped) and `a<b>c` renders as `ac`.
      //   The characters are lost in the root node **and** in the exported PNG, because the export draws
      //   the same rendered runs. Measured through `htmlToRuns`, which is what RichText feeds.
      //   The `.mm` export escapes its title already (`exportFreemind`'s `esc`), which is why only the
      //   on-screen and PNG paths were affected.
      text: title ? `<span>${escapeHtml(title)}</span>` : `<span>${t('phUntitled')}</span>`,
      modified: Date.now(),
      children: nodes,
      paragraphs: docParagraphs,
    };
  }, [zoomNode, title, nodes, docParagraphs]);

  const displayNodes = useMemo(() => [rootNode], [rootNode]);

  const layout = useMemo<Layout>(() => {
    if (displayNodes.length === 0) return { boxes: [], edges: [], w: 100, h: 100 };
    if (structure === 'org') return layoutOrg(displayNodes, collapsedIds);
    return layoutHorizontal(displayNodes, structure, collapsedIds);
  }, [displayNodes, structure, collapsedIds]);

  // node id → visible Box (collapsed ones have no Box; related summaries and edges skip them automatically)
  const boxById = useMemo(() => {
    const m = new Map<string, Box>();
    for (const b of layout.boxes) {
      if (!m.has(b.node.id)) m.set(b.node.id, b);
    }
    return m;
  }, [layout]);

  const W = Math.max(layout.w, 600);
  const H = Math.max(layout.h, 400);

  /**
   * Zoom to "just fit the whole map".
   *
   * ## fit means fit; no lower bound (change)
   *
   * There used to be a `MIN_READABLE_K` (0.55 on narrow screens / 0.3 on wide ones), on the grounds that
   * a hard fit on a narrow screen shrinks the text beyond legibility. That made the button lie —
   * its tooltip says "zoom to just show all nodes", yet with the clamp it could not fit all the nodes;
   * and `fit()` is also called when opening the panel, switching the structure and dragging the splitter,
   * so relaxing only the button would leave the most common path broken.
   *
   * Now it **does not decide for the user**: if it does not fit, it does not fit, and that is reported truthfully.
   * To read the content, zoom in yourself.
   */
  const fit = (): void => {
    const el = svgRef.current;
    if (!el || layout.boxes.length === 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const cw = el.clientWidth || window.innerWidth;
    const ch = el.clientHeight || window.innerHeight;
    // less padding on narrow screens
    const narrow = cw < 560;
    const pad = narrow ? 24 : 48;
    // ★ No lower bound and no upper bound — fitK is min(1, …) itself, as small as it needs to be
    const k = Math.min(1, (cw - pad) / layout.w, (ch - pad) / layout.h);
    const x = (cw - layout.w * k) / 2;
    const y = Math.max(narrow ? 12 : 20, (ch - layout.h * k) / 2);
    // fit means "auto-fit", so the program takes the viewport over again
    userAdjustedView.current = false;
    setView({ x, y, k });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fit();
    }, 60);
    return () => clearTimeout(timer);
  }, [structure, zoomId, layout.boxes.length]);

  /**
   * Re-fit when the container resizes (new).
   *
   * ## What this fixes
   *
   * Previously **the component had no resize observation at all**: `fit()` ran only on mount, structure changes,
   * and entering/leaving focus. So after dragging the right-hand Dock wider (400px → 800px),
   * the SVG canvas did grow, but `view.x / view.y / view.k` were still computed from the old size —
   * which left the map on the old viewport's absolute offset, visibly off-center or even outside the visible area.
   *
   * ## Why we check whether the user manually adjusted the viewport
   *
   * As soon as the user has panned or zoomed themselves, it must **not** auto-fit again —
   * that would yank the view they just arranged back, which is a far more annoying interruption.
   * So a ref records "whether the viewport has been taken over by the user" (see the `userAdjustedView` declaration above).
   */

  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Ignore sub-pixel jitter so dragging does not trigger endless re-layout
      if (Math.abs(w - lastW) < 8 && Math.abs(h - lastH) < 8) return;
      lastW = w;
      lastH = h;
      if (userAdjustedView.current) return;
      // Dragging the splitter fires continuously, so debounce before fitting
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fit(), 120);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [layout.boxes.length, structure, zoomId]);

  const handleStructureChange = (s: MmStructure) => {
    setStructure(s);
  };

  const handleThemeChange = (idx: number) => {
    setThemeIdx(idx);
  };

  const handleLineStyleChange = (ls: MmLineStyle) => {
    setLineStyle(ls);
  };

  const handleShapeChange = (sh: MmTopicShape) => {
    const v = normalizeShape(sh);
    setShape(v);
  };

  const toggleCollapse = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const zoom = (f: number): void => {
    userAdjustedView.current = true;
    setView((v) => ({ ...v, k: Math.min(3, Math.max(0.2, v.k * f)) }));
  };

  // ---- node inline editing ----

  /** Enter edit mode; the input is pre-filled with the node's current plain text */
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  /** Reference to `.mm-wrap`: used to measure the **dock** width (the criterion for the first-visit default, see below) */
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  /** The attached-paragraph panel, so focus can be moved to it when it opens (never per render) */
  const paraPanelRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * Give focus back to the canvas.
   *
   * ★★★ Why this is required (a measured **mind-map keyboard works only once** bug):
   *
   *   After the editing overlay's `<textarea>` closes, browser focus returns to `BODY` and
   *   does **not** automatically return to `.mm-canvas`. The map's keyboard handling is attached to
   *   `.mm-canvas`'s `onKeyDown` — with focus elsewhere,
   *   Tab / Enter / Delete / F2 **not one of them fires**.
   *
   *   Measured (two Enters in a row to create sibling nodes):
   *   ```
   *   1st: Enter lands on DIV.mm-canvas   → node created normally ✓
   *          editing overlay opens/closes
   *   after the 1st: activeElement = BODY.fn__flex-column   ← focus lost
   *   2nd: Enter lands on BODY             → no reaction at all ✗
   *   ```
   *   In other words the user **had to click a node before every single action**, which is extremely painful when creating several nodes in a row.
   *
   *   Fix: give focus back to the canvas once the overlay closes (retried with rAF, for the same reason as beginEdit).
   */
  const focusCanvas = React.useCallback((): void => {
    let tries = 0;
    const focusNow = (): void => {
      const el = canvasRef.current;
      if (el) {
        el.focus();
        return;
      }
      if (tries++ < 10) requestAnimationFrame(focusNow);
    };
    requestAnimationFrame(focusNow);
  }, []);

  const beginEdit = (id: string, initial: string): void => {
    if (!editable) return;
    setEditingId(id);
    setEditingText(initial);
    // ★ Focusing must be **retried until it succeeds**, not attempted for a single frame.
    //   A requestAnimationFrame callback may run before React commits the DOM,
    //   in which case editInputRef.current is still null and focus stays on the canvas —
    //   every keystroke the user types next lands on the canvas and is swallowed (measured: the A/B/C keys were all lost,
    //   and extra empty nodes were created). Retry recursively with rAF, at most 10 frames (≈160ms).
    let tries = 0;
    const focusNow = (): void => {
      const el = editInputRef.current;
      if (el) {
        el.focus();
        el.select();
        return;
      }
      if (tries++ < 10) requestAnimationFrame(focusNow);
    };
    requestAnimationFrame(focusNow);
  };

  /**
   * Add a node and **enter edit mode immediately** once it appears.
   *
   * The three triggers (Tab / Enter / context menu) all share this path —
   * previously each only called onAddNode, so a new empty node appeared but **did not enter editing**,
   * typing right away did "nothing at all" (the map swallowed the keys),
   * and pressing Enter again created yet another empty node. That is exactly what was measured.
   */
  const addAndEdit = React.useCallback(
    (parentId: string, mode: 'child' | 'sibling', afterId: string): void => {
      if (!onAddNode) return;
      const ret = onAddNode(parentId, mode, afterId);
      // ★ The new id must be returned **synchronously**: the node enters React state synchronously while the disk write happens in the background.
      //   so the edit box mounts on the next frame. Awaiting the Promise instead (the kernel write takes about 1 second),
      //   anything the user types during that second would land on the canvas and be swallowed.
      if (typeof ret === 'string') setPendingEditId(ret);
    },
    [onAddNode],
  );

  // Once the node awaiting editing actually appears in nodes, enter edit mode
  useEffect(() => {
    const want = pendingEditId;
    if (!want) return;
    // ★ The lookup must be **recursive**, not a top-level scan only.
    //   `nodes` holds the document's top-level nodes (e.g. [A, B]), while nodes created with Tab/Enter
    //   are mostly **nested children** (attached under A.children).
    //   Scanning one level only would never find a child.
    if (!findNode(nodes, want)) return;
    setPendingEditId(null);
    beginEdit(want, '');
    // beginEdit depends on layout, but only id/initial text are used here, so it is left out of the deps to avoid retriggering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, pendingEditId]);

  /** Commit the edit (empty text counts as clearing, but the node is kept and the caller writes back a placeholder) */
  const commitEdit = (): void => {
    if (editingId === null) return;
    const id = editingId;
    const next = editingText.replace(/\s+$/, '');
    setEditingId(null);
    setEditingText('');
    onEditNode?.(id, next);
    // ★ After the overlay closes, focus returns to BODY and must be given back to the canvas,
    //   otherwise the very next Enter/Tab all fail (see the focusCanvas comment)
    focusCanvas();
  };

  /** Cancel editing without changing the data */
  const cancelEdit = (): void => {
    setEditingId(null);
    setEditingText('');
    focusCanvas();
  };

  /** Open the attached-paragraph overlay (a node shows only its first paragraph by default) */
  const openParagraphs = (node: OutlineNode): void => {
    setParaView({ id: node.id, node });
  };

  /**
   * Close the attached-paragraph overlay.
   *
   * ★ Focus must be given back to the canvas: after the overlay unmounts, activeElement falls back to BODY,
   *   after which only the first keyboard action takes effect (this pitfall was already hit with the "map overlay" in this project).
   *   The same focusCanvas() as commitEdit is reused here.
   */
  /**
   * Move focus into the attached-paragraph panel when it opens.
   *
   * ★ Not through an inline `ref` callback. Such a callback gets a **new identity on every render**, so
   * React calls it again each time (null, then the element), and the guard it used —— comparing against
   * `document.activeElement` —— was satisfied while the user typed, because the active element is the
   * textarea *inside* the panel. The panel took focus back on every keystroke, so the editor accepted one
   * character per click. Keyed on the view, the focus happens once per opening: opening it makes Esc work
   * immediately and lets a keyboard user scroll the content.
   */
  React.useEffect(() => {
    if (paraView === null) return;
    paraPanelRef.current?.focus();
  }, [paraView]);

  const closeParagraphs = (): void => {
    setParaView(null);
    setParaEditing(false);
    setParaDraft('');
    focusCanvas();
  };

  /** Enter edit mode: turn the existing paragraphs into a plain-text draft with one paragraph per line */
  const startParagraphEdit = (): void => {
    if (!paraView || !onEditParagraphs) return;
    const lines = (paraView.node.paragraphs ?? []).map((p) =>
      htmlToText(p).replace(/\u200b/g, '').trim(),
    );
    setParaDraft(lines.join('\n'));
    setParaEditing(true);
  };

  /**
   * Save the draft.
   *
   * ★ Key point: **empty lines must not be filtered out** after `split('\n')` — an empty line represents an empty paragraph,
   *   and filtering them out silently deletes empty paragraphs the user deliberately left.
   */
  const commitParagraphs = (): void => {
    if (!paraView || !onEditParagraphs) return;
    const lines = paraDraft.split('\n');
    // A trailing newline does not count as "one extra empty paragraph": 'a\n' and 'a' must be equivalent
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    onEditParagraphs(paraView.id, lines);
    setParaEditing(false);
    setParaDraft('');
    setParaView(null);
    focusCanvas();
  };

  /** Cancel editing: discard the draft and return to the read-only full-text view */
  const cancelParagraphs = (): void => {
    setParaEditing(false);
    setParaDraft('');
    // ★ The textarea carries `autoFocus`, so unmounting it moves focus to **BODY** —— and the panel is still
    //   open (`paraView` is unchanged, so the effect above does not re-run). Both the panel's own keys
    //   (Escape, Ctrl+Enter) and every canvas shortcut would then be dead until the user clicks again: the
    //   same one-way focus migration this file's overlay handling exists to prevent. Focus goes back to the
    //   panel container —— the element that effect focuses when the panel opens.
    paraPanelRef.current?.focus();
  };

  const exportPng = (): void => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;

    // ★★★ Every branch junction in the exported image showed a big "−" circle (fix).
    //
    //   Those circles are the node collapse buttons `.mm-badge`. They are invisible on the page because of this rule
    //   in the plugin's stylesheet:
    //       .om-mm-host .mm-node:not(.mm-collapsed) .mm-badge { opacity: 0 }
    //
    //   but `cloneNode` + `XMLSerializer` carry over only the **class attribute**, not the **page CSS**;
    //   the serialized SVG is a standalone document with no stylesheet to interpret those classes,
    //   so `opacity` fell back to its default of 1 — and every circle became visible.
    //
    //   Both steps are required; neither can be skipped:
    //     ① **embed the plugin's own styles into the SVG** (only styles carrying the plugin marker, not SiYuan's);
    //     ② add `.om-mm-host` to the cloned root node — that rule requires an ancestor to have it,
    //        and the standalone SVG's root does not, so without it the rule never matches (embedding styles alone is not enough).
    //
    //   With that in place the export matches what is on screen.
    const pluginCss = [...document.querySelectorAll('style')]
      .map((s) => s.textContent ?? '')
      .filter((t) => t.includes('om-mm-') || t.includes('.mm-'))
      .join('\n');
    if (pluginCss) {
      const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      styleEl.textContent = pluginCss;
      clone.insertBefore(styleEl, clone.firstChild);
    }
    clone.setAttribute('class', `${svg.getAttribute('class') ?? ''} om-mm-host`.trim());

    clone.setAttribute('width', String(W));
    clone.setAttribute('height', String(H));
    const g = clone.querySelector('g');
    if (g) {
      g.setAttribute('transform', '');
    }
    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = W * 2;
      canvas.height = H * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => {
        if (!b) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `${title || 'mindmap'}.png`;
        a.click();
      }, 'image/png');
    };
    img.src = url;
  };

  const downloadMm = (): void => {
    // The two fallback copies are the wording the product already shows: the root node's label on the
    // canvas, and the outline's label for a node with no text. Required parameters, so this cannot be
    // passed `undefined` again without a compile error.
    const blob = new Blob(
      [exportFreemind(nodes, title, t('lblUntitled'), t('phUntitled'), docParagraphs)],
      { type: 'text/xml' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title || 'mindmap'}.mm`;
    a.click();
  };

  // Color resolver for branch and edge
  const getBranchStyle = (b: Box) => {
    if (b.depth === 0) {
      return {
        fill: theme.rootBg,
        stroke: theme.rootBg,
        text: theme.rootText,
        strokeWidth: 2,
        rx: 10,
        fontWeight: 700,
        fontSize: 15,
      };
    }
    if (theme.isColorful && theme.branchColors && theme.branchColors.length > 0) {
      const palette = theme.branchColors[b.branchIdx % theme.branchColors.length];
      if (b.depth === 1) {
        return {
          fill: palette.fill,
          stroke: palette.border,
          text: palette.text,
          strokeWidth: 2,
          rx: 8,
          fontWeight: 600,
          fontSize: 14,
        };
      }
      return {
        fill: theme.nodeBg,
        stroke: palette.border,
        text: theme.text,
        strokeWidth: 1.5,
        rx: 6,
        fontWeight: 400,
        fontSize: 13,
      };
    }
    return {
      fill: theme.nodeBg,
      stroke: theme.line,
      text: theme.text,
      strokeWidth: 1.5,
      rx: 8,
      fontWeight: b.depth === 1 ? 600 : 400,
      fontSize: b.depth === 1 ? 14 : 13,
    };
  };

  const getEdgeStroke = (e: Edge) => {
    if (theme.isColorful && theme.branchColors && theme.branchColors.length > 0) {
      return theme.branchColors[e.branchIdx % theme.branchColors.length].line;
    }
    return theme.line;
  };

  // Themed shape body for non-root nodes (the root keeps its current shape); hexagon2/arcRect/tag are approximations, not pixel-calibrated against the real app
  const renderShape = (
    b: Box,
    st: { fill: string; stroke: string; strokeWidth: number; rx: number },
  ): React.ReactNode => {
    if (b.depth === 0 || shape === 'roundedRect') {
      return <rect width={b.w} height={b.h} rx={st.rx} fill={st.fill} stroke={st.stroke} strokeWidth={st.strokeWidth} />;
    }
    const w = b.w;
    const h = b.h;
    switch (shape) {
      case 'rect':
        return <rect width={w} height={h} rx={0} fill={st.fill} stroke={st.stroke} strokeWidth={st.strokeWidth} />;
      case 'arcRect':
        return <rect width={w} height={h} rx={h / 2} fill={st.fill} stroke={st.stroke} strokeWidth={st.strokeWidth} />;
      case 'underline':
        return (
          <g>
            <rect width={w} height={h} fill="transparent" stroke="none" />
            <line x1={8} y1={h - 3} x2={w - 8} y2={h - 3} stroke={st.stroke} strokeWidth={2} strokeLinecap="round" />
          </g>
        );
      case 'hexagon': {
        const k = Math.min(14, w / 4);
        return (
          <polygon
            points={`${k},0 ${w - k},0 ${w},${h / 2} ${w - k},${h} ${k},${h} 0,${h / 2}`}
            fill={st.fill}
            stroke={st.stroke}
            strokeWidth={st.strokeWidth}
            strokeLinejoin="round"
          />
        );
      }
      case 'hexagon2': {
        const k = Math.min(10, h / 2 - 1, w / 4);
        return (
          <polygon
            points={`${k},0 ${w - k},0 ${w},${k} ${w},${h - k} ${w - k},${h} ${k},${h} 0,${h - k} 0,${k}`}
            fill={st.fill}
            stroke={st.stroke}
            strokeWidth={st.strokeWidth}
            strokeLinejoin="round"
          />
        );
      }
      case 'tag': {
        const k = Math.min(12, h / 2);
        return (
          <polygon
            points={`${k},0 ${w},0 ${w},${h} ${k},${h} 0,${h / 2}`}
            fill={st.fill}
            stroke={st.stroke}
            strokeWidth={st.strokeWidth}
            strokeLinejoin="round"
          />
        );
      }
      default:
        return <rect width={w} height={h} rx={st.rx} fill={st.fill} stroke={st.stroke} strokeWidth={st.strokeWidth} />;
    }
  };

  // On a narrow screen the toolbar takes about 1/3 of the screen, so it is collapsed by default; the user's expand/collapse choice is remembered.
  // On a wide screen (desktop) it is expanded by default, keeping the previous habit.
    const [barOpen, setBarOpen] = React.useState<boolean>(() => {
      try {
        const saved = localStorage.getItem('om-mm-bar-open');
        if (saved !== null) return saved === '1';
      } catch {
        /* on a read failure use the default */
      }
      // On a first visit (nothing remembered) start with "expanded" — the DOM is not mounted yet, so the dock width cannot be measured.
      // The real criterion is in the useLayoutEffect below, which corrects it using the **dock width**.
      return true;
    });

    // ★★★ The first-visit default must be based on the **dock width**, not the window width.
    //
    //   It used to be `window.innerWidth > 560` — yet another criterion that "uses the window width as a stand-in"
    //   (four instances of this same mistake were already fixed in this file / the stylesheet). The toolbar lives in SiYuan's **right-hand dock**,
    //   and the dock width is **unrelated** to the window width.
    //
    //   Measured (first visit, no localStorage, window 1440px, right dock 237px):
    //     the expanded toolbar takes **239px** of height, while the panel is only 798px in total
    //     ⇒ the canvas is left with 529px, so **the toolbar eats a third of the panel**.
    //   On first opening the map, the user saw a wall of settings instead of the map.
    //
    //   ⇒ After mounting, decide once more using the actual width of `.mm-wrap`.
    //     Correct only when **nothing is remembered for the user** — once the user has clicked, their choice is respected.
    React.useLayoutEffect(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem('om-mm-bar-open');
      } catch {
        /* storage unavailable: treat it as "nothing remembered" */
      }
      if (saved !== null) return; // the user has chosen; leave it alone
      // ★ A phone collapses whatever the dock measures —— the reason is the mobile bottom keyboard bar,
      //   and the dock width cannot see it (measured: a 390px viewport still has a ~420px dock). Checked
      //   before the width, and kept identical to the outline's rule: the two views must agree.
      if (typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH) {
        setBarOpen(false);
        return;
      }

      // ★★★ "Measure it once, in a layout effect" is not the same as "it is measurable by then", and the
      //   difference is visible: on the **first** open the root measures its final width and then briefly
      //   **0** while the panel is still settling (measured samples right after mount: 420, 0, 0, 0, ...).
      //   The old code returned on `w <= 0` —— and because the effect ran **once**, that return was final:
      //   the effect never ran again, the initial `true` default stood, and the toolbar stayed expanded in a
      //   420px dock where the rule says collapse. A reload looked correct only because the second mount
      //   measured a stable width, which is exactly the kind of "it works on the second try" that hides a
      //   first-run defect.
      //
      //   So an unmeasurable moment is now **retried** on the next frame instead of ending the effect. The
      //   user's own choice still wins: anything in storage stops this before it starts.
      let raf = 0;
      const apply = (): void => {
        const w = wrapRef.current?.clientWidth ?? 0;
        if (w <= 0) {
          // Not measurable *yet* —— try again next frame rather than giving up for good.
          raf = requestAnimationFrame(apply);
          return;
        }
        setBarOpen(w > 560);
      };
      apply();
      // Decides the "first-visit default" only; never tracks the dock width afterwards (that would
      // override the user's manual open/close).
      return () => { if (raf) cancelAnimationFrame(raf); };
        }, []);
  // ★★★ An effect that "did nothing" was deleted.
  //
  //   It used to look like this:
  //
  //     const onResize = () => {
  //       const narrow = window.innerWidth <= 560;
  //       if (narrow && !barOpen) return;
  //       if (!narrow && barOpen) return;
  //     };                       // ← both branches only return and never call setBarOpen
  //     window.addEventListener('resize', onResize);
  //
  //   The comment said "reset to the default when crossing the breakpoint", but **it never changed a single piece of state** —
  //   it is exactly equivalent to not having that code, apart from attaching a useless resize listener.
  //   Measured: before and after changing the window width, `collapsed` and localStorage **never changed**.
  //
  //   Why not "make it actually reset":
  //   · the criterion itself is wrong — this is the **dock** width, not the window width
  //     (the same mistake was in the toggle-visibility condition in styles.css and was changed to a container query as well).
  //   · and forcing a reset would **override the user's choice**: a user who manually collapses the toolbar in a narrow dock
  //     would be bounced back to expanded as soon as the window changes, which is worse behaviour.
  //   The current semantics (the user's choice is stored in localStorage unless they click again) are more sensible.
  const toggleBar = (): void => {
    setBarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem('om-mm-bar-open', next ? '1' : '0');
      } catch {
        /* unavailable storage does not affect functionality */
      }
      return next;
    });
  };

  return (
    <div className="mm-wrap" ref={wrapRef}>
      <button
        type="button"
        onClick={toggleBar}
        {...tooltip(barOpen ? t('tipCollapseBar') : t('tipExpandBar'), 'mm-bar-toggle')}
        aria-expanded={barOpen}
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
        <span>{t('lblSettings')}</span>
      </button>
      <div className={`mm-bar${barOpen ? '' : ' mm-bar--collapsed'}`}>
        <label>
          {t('lblStructure')}{' '}
          <select value={structure} onChange={(e) => handleStructureChange(e.target.value as MmStructure)}>
            {/* ★ "Right" comes first: it is already the default structure,
                so the list order matches the default and the user sees the one actually in use at first glance. */}
            <option value="right">{t('structRight')}</option>
            <option value="balanced">{t('structBalanced')}</option>
            <option value="left">{t('structLeft')}</option>
            <option value="org">{t('structDown')}</option>
            <option value="timeline">{t('structAlternating')}</option>
          </select>
        </label>
        <label>
          {t('lblLine')}{' '}
          <select value={lineStyle} onChange={(e) => handleLineStyleChange(e.target.value as MmLineStyle)}>
            <option value="curve">{t('lineCurve')}</option>
            <option value="rounded">{t('lineRounded')}</option>
            <option value="straight">{t('lineStraight')}</option>
          </select>
        </label>
        <label>
          {t('lblTheme')}{' '}
          <select value={themeIdx} onChange={(e) => handleThemeChange(Number(e.target.value))}>
            {MM_THEMES.map((th, i) => (
              <option key={th.nameKey} value={i}>
                {t(th.nameKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('lblShape')}{' '}
          <select value={shape} onChange={(e) => handleShapeChange(e.target.value as MmTopicShape)}>
            {(Object.keys(MM_SHAPE_LABELS) as MmTopicShape[]).map((s) => (
              <option key={s} value={s}>
                {t(MM_SHAPE_LABELS[s])}
              </option>
            ))}
          </select>
        </label>
        <span className="theme-swatches">
          {MM_THEMES.map((th, i) => (
            <button
              key={th.nameKey}
              title={t(th.nameKey)}
              className={i === themeIdx ? 'on' : ''}
              style={{ background: th.rootBg }}
              onClick={() => handleThemeChange(i)}
            />
          ))}
        </span>
        {zoomNode && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button className="btn" onClick={() => { onZoomChange?.(null); focusCanvas(); }}>{t('cmdBackToFullMap')}</button>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {t('lblFocusBranch')}{label(zoomNode)}
            </span>
          </div>
        )}
        <button className="btn ariaLabel" onClick={() => zoom(1.2)} aria-label={t('tipZoomIn')} title={t('tipZoomIn')}>+</button>
        <button
          className="btn ariaLabel"
          style={{ minWidth: 54, fontWeight: 500 }}
          onClick={() => {
            // Resetting the zoom restores the "auto-fit" semantics, letting later size changes keep auto-fitting
            userAdjustedView.current = false;
            setView((v) => ({ ...v, k: 1 }));
          }}
          aria-label={t('tipResetZoom')} title={t('tipResetZoom')}
        >
          {Math.round(view.k * 100)}%
        </button>
        <button className="btn ariaLabel" onClick={() => zoom(1 / 1.2)} aria-label={t('tipZoomOut')} title={t('tipZoomOut')}>-</button>
        <button className="btn" onClick={() => fit()}>{t('cmdFit')}</button>
        <button className="btn" onClick={exportPng}>{t('cmdExportImage')}</button>
        <button className="btn" onClick={downloadMm}>{t('cmdExportMm')}</button>
        <span style={{ color: 'var(--text-weak)' }}>
          {t('lblTopicCount', { n: layout.boxes.length })} · {t('lblCanvasHint')}
        </span>
      </div>
      <div
        ref={canvasRef}
        className={`mm-canvas${isDragging ? ' dragging' : ''}${dropHint ? ' drop-hint' : ''}`}
        style={{ background: theme.bg }}
        tabIndex={0}
        /**
         * ★★★ Mobile: stop SiYuan's "swipe to switch sidebar" from stealing the gesture (fix).
         *
         * Defect: dragging the map left/right on a touch screen **slid the sidebar out / back in**,
         * while the map itself barely moved — horizontal panning was completely unusable.
         *
         * Root cause: SiYuan mobile has a global `sidebarSwipe` gesture
         * (`handleTouchStart` in `app/src/mobile/util/touch.ts`),
         * enabled by default: a horizontal swipe switches the sidebar. Its **only opt-out mechanism** is to look
         * up from the target for the `data-prevent-swipe` attribute on `touchstart`:
         *
         *     preventSwipe = !!target.closest(".av__widthdrag") ||
         *         !!hasClosestByAttribute(target, "data-prevent-swipe", null, true);
         *     if (preventSwipe) return;      // this gesture round is left to the content itself
         *
         * The plugin **set this attribute nowhere** before, so every horizontal drag on the map
         * was taken by the layer above as a sidebar gesture.
         *
         * SiYuan's own "list mind map" does the same
         * (`protyle/render/listMindmap/view.ts` sets it on its viewport),
         * so the same mechanism is reused here instead of patching SiYuan itself.
         *
         * ⚠️ Only the presence of the attribute matters; `hasClosestByAttribute(…, null, true)`
         *   only checks whether the attribute exists; "true" is written for readability.
         */
        data-prevent-swipe="true"
        onContextMenu={(e) => {
          // Right-click on blank space: only close an open menu, do not show the browser's default menu
          if ((e.target as HTMLElement).closest('.mm-node')) return;
          e.preventDefault();
          setCtxMenu(null);
        }}
        onDragOver={(e) => {
          // Accept only SiYuan block drags; drop is allowed only after preventDefault
          if (!onDropBlocks) return;
          const types = Array.from(e.dataTransfer.types || []);
          // ★ Do not name the arrow parameter `t`: this file already imports the i18n lookup `t`,
          //   and a parameter of the same name would shadow it (even though `t()` is not used here, the same convention is followed).
          if (!types.some((ty) => ty.startsWith('application/siyuan-gutter'))) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropHint(true);
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={(e) => {
          setDropHint(false);
          if (!onDropBlocks) return;
          const d = parseSiyuanDrop(e.dataTransfer);
          if (!d || !d.ids.length) return;
          e.preventDefault();
          // Drop target: onto a node means attach under it, otherwise attach to the root
          const el = (e.target as HTMLElement).closest('.mm-node') as HTMLElement | null;
          const wantId = el?.getAttribute('data-node-id') ?? null;
          const targetId = wantId && layout.boxes.some((b) => b.node.id === wantId) ? wantId : null;
          onDropBlocks(d.ids, targetId);
        }}
        onKeyDown={(e) => {
          // When the attached-paragraph overlay is open: Esc closes it and no other key is intercepted.
          // Placed first, and it **does not rely on the overlay holding focus itself** —
          // When the overlay has just opened, focus may still be on the canvas (see the focusCanvas comment),
          // so relying on the overlay's onKeyDown alone would miss that beat.
          if (paraView !== null) {
            if (e.key === 'Escape') {
              e.preventDefault();
              closeParagraphs();
            }
            return;
          }
          // Do not intercept keys while the editing overlay is open
          // When the context menu is open: Esc closes it.
          // Consistent with SiYuan's native menu; previously only "click elsewhere" and "right-click again" worked,
          // so pressing Esc as a keyboard user did nothing at all (caught by E2E).
          if (ctxMenu !== null) {
            if (e.key === 'Escape') {
              e.preventDefault();
              setCtxMenu(null);
            }
            return;
          }
          if (editingId !== null) return;
          // Undo / redo: consistent with the outline view (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).
          // It must come **before** `if (!selectedId) return` —
          // otherwise there is nothing to undo when no node is selected, yet undo is exactly what is used after "just deleted".
          const mod = e.ctrlKey || e.metaKey;
          if (mod && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (e.shiftKey) onRedo?.();
            else onUndo?.();
            return;
          }
          if (mod && e.key === 'y') {
            e.preventDefault();
            onRedo?.();
            return;
          }
          if (!onAddNode || !selectedId) return;
          // Tab = add a child node; Enter = add a sibling node (consistent with mainstream mind-map tools)
          if (e.key === 'Tab') {
            e.preventDefault();
            addAndEdit(selectedId, 'child', selectedId);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            addAndEdit(selectedId, 'sibling', selectedId);
          } else if (
            deletable &&
            onDeleteNode &&
            (e.key === 'Delete' || e.key === 'Backspace')
          ) {
            // Delete/Backspace deletes the node — the caller handles the confirmation
            e.preventDefault();
            onDeleteNode(selectedId);
          } else if (e.key === 'F2' && editable && onEditNode) {
            // F2 enters editing (the habit from file explorers)
            e.preventDefault();
            const hit = layout.boxes.find((b) => b.node.id === selectedId);
            beginEdit(selectedId, htmlToText(hit?.node.text ?? ''));
          }
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          } else {
            userAdjustedView.current = true;
            setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg ref={svgRef} width="100%" height="100%" style={{ display: 'block', touchAction: 'none' }}>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {layout.edges.map((e, i) => (
              <path
                key={i}
                d={edgePath(e, vertical, lineStyle)}
                fill="none"
                stroke={getEdgeStroke(e)}
                strokeWidth={2}
              />
            ))}
            {layout.boxes.map((b) => {
              const bStyle = getBranchStyle(b);
              const isDone = b.node.taskStatus === TASK_DONE;
              const isTodo = b.node.taskStatus === TASK_TODO;
              const hasTask = isDone || isTodo;

              // Collapse badge position:
              // right/root -> at b.w, b.h/2 (right border)
              // left       -> at 0, b.h/2 (left border)
              // org        -> at b.w/2, b.h (bottom border)
              const badgeX = vertical ? b.w / 2 : b.side === -1 ? 0 : b.w;
              const badgeY = vertical ? b.h : b.h / 2;

              return (
                <g
                  key={b.id}
                  data-node-id={b.node.id}
                  className={`mm-node${b.isCollapsed ? ' mm-collapsed' : ''}${selectedId === b.node.id ? ' mm-selected' : ''}`}
                  transform={`translate(${b.x},${b.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (didDragRef.current) return;
                    onSelectNode?.(b.node.id);
                    onFocusNode?.(b.node.id);
                    // ★ The menu is an overlay of `div`s, so clicking an item leaves `activeElement` on
                    //   `BODY` —— and the map's shortcuts live on `.mm-canvas`'s `onKeyDown`, so Tab /
                    //   Enter / Delete / F2 / Ctrl+Z all go dead with no visible sign. Measured:
                    //   `activeElement.className === 'fn__flex-column body--toolbar-hide'` after this item.
                    //   Items that open the editor or the paragraph panel set their own focus and need none.
                    focusCanvas();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectNode?.(b.node.id);
                    setCtxMenu({
                      id: b.node.id,
                      x: (e as unknown as MouseEvent).clientX,
                      y: (e as unknown as MouseEvent).clientY,
                    });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (didDragRef.current) return;
                    // Double-click enters inline editing when editable; in read-only mode it falls back to "focus this node"
                    if (editable && onEditNode) {
                      beginEdit(b.node.id, htmlToText(b.node.text ?? ''));
                    } else {
                      onZoomChange?.(b.node.id);
                    }
                  }}
                >
                  {renderShape(b, bStyle)}

                  {/* Task Checkbox */}
                  {hasTask && (
                    <g
                      className="mm-checkbox"
                      transform={`translate(10, ${b.h / 2 - 7})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTask?.(b.node.id);
                      }}
                      style={{ cursor: 'pointer', pointerEvents: 'all' }}
                    >
                      <rect
                        width={14}
                        height={14}
                        rx={3}
                        fill={isDone ? (theme.isColorful ? bStyle.stroke : '#3370ff') : 'none'}
                        stroke={bStyle.stroke}
                        strokeWidth={1.5}
                      />
                      {isDone && (
                        <path
                          d="M3 7 L6 10 L11 4"
                          fill="none"
                          stroke="#ffffff"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                    </g>
                  )}

                  {/* Text Label — RichText preserves the inline formatting.
                      Do not fall back to `{b.label}`: an SVG <text> has only one fill,
                      so that form would silently drop every color/bold. */}
                  <text
                    x={hasTask ? 30 + (b.w - 30) / 2 : b.w / 2}
                    y={(b.h - b.lines.length * LINE_HEIGHT) / 2 + LINE_HEIGHT / 2}
                    dy={centerBaselineDy(bStyle.fontSize, LINE_HEIGHT)}
                    textAnchor="middle"
                    fill={isDone ? '#8f959e' : bStyle.text}
                    fontSize={bStyle.fontSize}
                    fontWeight={bStyle.fontWeight}
                    style={isDone ? { textDecoration: 'line-through' } : undefined}
                  >
                    <RichText
                      lines={b.lines}
                      fallbackFill={isDone ? '#8f959e' : bStyle.text}
                      x={hasTask ? 30 + (b.w - 30) / 2 : b.w / 2}
                      lineHeight={LINE_HEIGHT}
                    />
                  </text>
                  {/* The hover tooltip must go **outside** <text>:
                      SVG's <title> merges into the parent element's textContent,
                      so putting it inside <text> makes the text read as "label" twice. */}
                  <title>
                    {b.label}
                    {b.node.paragraphs?.length
                      ? '\n' +
                        b.node.paragraphs
                          .filter((p) => p.trim())
                          .map((p) => htmlToText(p))
                          .join('\n')
                      : ''}
                  </title>

                  {/* ★ There used to be a "note indicator" here (a small dot at the top right, for the old note/memo),
                      the attached paragraphs are now rendered below the node,
                      and the "attached paragraph indicator" below is its replacement —
                      keeping both would show two duplicate little dots.
                      The note body is now shown only in the tooltip and the paragraph overlay. */}

                  {/* Attached-paragraph indicator — moved to a floating micro-badge outside the node's top-right corner, to avoid confusion with the title background color and clashes with node text or the collapse badge */}
                  {!!b.node.paragraphs?.length && (
                    <g
                      className="mm-para-badge"
                      transform={`translate(${b.w - 4}, -4)`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openParagraphs(b.node);
                      }}
                    >
                      {/* Enlarged transparent hit circle */}
                      <circle cx={0} cy={0} r={12} fill="transparent" />
                      {/* Solid badge background ring */}
                      <circle
                        cx={0}
                        cy={0}
                        r={8}
                        fill={b.depth === 0 ? '#ffffff' : (theme.nodeBg || '#ffffff')}
                        stroke={bStyle.stroke}
                        strokeWidth={1.2}
                      />
                      {/* Three horizontal lines, hinting at "multiple paragraphs" */}
                      {[-2.5, 0, 2.5].map((dy, i) => (
                        <rect
                          key={dy}
                          x={i === 2 ? -2.2 : -3.5}
                          y={dy - 0.7}
                          width={i === 2 ? 4.5 : 7}
                          height={1.4}
                          rx={0.7}
                          fill={bStyle.stroke}
                        />
                      ))}
                      <title>
                        {t('tipParaBadge', { n: b.node.paragraphs!.length }) + '\n' +
                          b.node.paragraphs!
                            .map((p, i) => `${i + 1}. ${htmlToText(p).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim() || t('lblEmptyParaShort')}`)
                            .join('\n')}
                      </title>
                    </g>
                  )}

                  {/* Collapse / Expand Badge */}
                  {b.depth > 0 && b.childCount && b.childCount > 0 ? (
                    <g
                      className="mm-badge"
                      transform={`translate(${badgeX}, ${badgeY})`}
                      onClick={(e) => toggleCollapse(b.node.id, e)}
                    >
                      {b.isCollapsed ? (
                        b.childCount >= 10 ? (
                          <rect
                            x={-13}
                            y={-9}
                            width={26}
                            height={18}
                            rx={9}
                            fill={theme.isColorful ? bStyle.stroke : theme.rootBg}
                            stroke={bStyle.stroke}
                            strokeWidth={1}
                          />
                        ) : (
                          <circle
                            r={9}
                            fill={theme.isColorful ? bStyle.stroke : theme.rootBg}
                            stroke={bStyle.stroke}
                            strokeWidth={1}
                          />
                        )
                      ) : (
                        <circle
                          r={8}
                          fill={theme.bg}
                          stroke={bStyle.stroke}
                          strokeWidth={1.5}
                        />
                      )}
                      <text
                        dy={centerBaselineDy(b.isCollapsed ? 10 : 12, b.h)}
                        textAnchor="middle"
                        fontSize={b.isCollapsed ? 10 : 12}
                        fontWeight={700}
                        fill={b.isCollapsed ? '#ffffff' : bStyle.stroke}
                      >
                        {b.isCollapsed ? b.childCount : '−'}
                      </text>
                      <title>{b.isCollapsed ? t('tipExpandChildren', { n: b.childCount }) : t('tipCollapseBranch')}</title>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Map overlay: floating action bar at the bottom */}
      <div className="mm-floating-dock" onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          {...tooltip(t('tipToggleTheme'), 'dock-btn')}
          onClick={() => handleThemeChange((themeIdx + 1) % MM_THEMES.length)}
        >
          <span style={{ fontSize: 18 }}>🎨</span>
        </button>
        <button
          type="button"
          // The text must state what it really does: scale and pan all nodes so they just fit the canvas.
          // There is **no** full-screen feature here (no requestFullscreen anywhere in the code),
          // so it must not say "fit the full-screen canvas" — that would make the user think clicking it goes full screen.
          // The fallback must match tipFitCanvas in i18n, otherwise a failed i18n lookup
          // falls back to this old misleading text (which is exactly what happened before this fix).
          {...tooltip(t('tipFitCanvas'), 'dock-btn')}
          onClick={() => fit()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {/* Attached-paragraph overlay: a node shows only its first paragraph by default; this expands the full text.
          Esc or clicking the scrim closes it, and closing must give focus back to the canvas (see closeParagraphs). */}
      {paraView !== null && (
        <div
          className="mm-para-overlay"
          onMouseDown={(e) => {
            // Clicking the scrim closes it; clicking the panel itself does not
            if (e.target === e.currentTarget) {
              e.preventDefault();
              closeParagraphs();
            } else {
              e.stopPropagation();
            }
          }}
        >
          <div
            className="mm-para-panel"
            tabIndex={-1}
            ref={paraPanelRef}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeParagraphs();
              }
            }}
          >
            <div className="mm-para-head">
              <div className="mm-para-title">
                {htmlToText(paraView.node.text).replace(/\s+/g, ' ').trim() || t('lblEmptyNode')}
              </div>
              <button className="mm-para-close ariaLabel" onClick={closeParagraphs} aria-label={t('tipCloseEsc')} title={t('tipCloseEsc')}>
                ×
              </button>
            </div>
            <div className="mm-para-count">
              {t('lblParaCount', { n: paraView.node.paragraphs?.length ?? 0 })}
            </div>
            <div className="mm-para-list">
              {(paraView.node.paragraphs ?? []).map((p, i) => {
                // ★ The zero-width placeholder \u200b must also count as empty:
                //   it is written by the serialization side (empty-paragraph protection) and String.trim() does not remove it,
                //   otherwise an empty paragraph would render as an invisible blank line and the user would think the data was lost.
                const plain = htmlToText(p).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
                return (
                  <div className="mm-para-item" key={i}>
                    <span className="mm-para-idx">{i + 1}</span>
                    <div className="mm-para-body">
                      {plain ? (
                        // Render inline rich text when there is content (colors/bold/underline shown as they are)
                        <RichContent html={p} />
                      ) : (
                        <span className="mm-para-empty">{t('lblEmptyParagraph')}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {(paraView.node.paragraphs ?? []).length === 0 && (
                <div className="mm-para-empty-tip">{t('msgNoParagraphs')}</div>
              )}
            </div>

            {/* Edit area: one paragraph per line; **an empty line represents an empty paragraph**, which must be expressible and must not be swallowed.
                The read-only list and the edit area are mutually exclusive — showing both at once makes it unclear which content is on screen. */}
            {paraEditing ? (
              <div className="mm-para-edit">
                <div className="mm-para-edit-hint">
                  {t('tipParaEditHint')}
                </div>
                <textarea
                  className="mm-para-textarea"
                  value={paraDraft}
                  autoFocus
                  onChange={(e) => setParaDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      commitParagraphs();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelParagraphs();
                    }
                  }}
                  rows={Math.max(3, Math.min(12, paraDraft.split('\n').length + 1))}
                />
                <div className="mm-para-actions">
                  <button className="btn" onClick={commitParagraphs}>
                    {t('cmdSave')}
                  </button>
                  <button className="btn" onClick={cancelParagraphs}>
                    {t('cmdCancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mm-para-actions">
                <button className="btn" onClick={startParagraphEdit}>
                  {t('cmdEdit')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Inline edit overlay: covers the top-left of the canvas so it does not have to tangle with node coordinates */}
      {editingId !== null && (
        <div className="mm-edit-overlay" onMouseDown={(e) => e.stopPropagation()}>
          <div className="mm-edit-label">{t('lblEditNode')}</div>
          <textarea
            ref={editInputRef}
            className="mm-edit-input"
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            onKeyDown={(e) => {
              // Enter commits; Shift+Enter inserts a line break; Esc cancels
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              }
            }}
            rows={2}
          />
          <div className="mm-edit-actions">
            <button className="btn" onClick={commitEdit}>
              {t('cmdSave')}
            </button>
            <button className="btn" onClick={cancelEdit}>
              {t('cmdCancel')}
            </button>
            <span className="mm-edit-hint">{t('tipEditHint')}</span>
          </div>
        </div>
      )}

      {/* Node context menu: visually consistent with SiYuan's native menu (light, compact, with separators) */}
      {ctxMenu && (
        <>
          {/* Clicking elsewhere closes it */}
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
            {editable && onEditNode && (
              <div
                className="mm-ctx-item"
                onClick={() => {
                  const n = ctxMenu.id;
                  setCtxMenu(null);
                  const hit = layout.boxes.find((b) => b.node.id === n);
                  beginEdit(n, htmlToText(hit?.node.text ?? ''));
                }}
              >
                {t('cmdEditNode')}
              </div>
            )}
            {/* Note/description — the same action as the badge at the node's top right (`openParagraphs`).
                The badge is tiny and needs a precise hit, so the context menu is the usual entry point.
                No `editable` guard is added: the overlay itself is a read-only view,
                and entering edit mode is gated separately by the button inside the overlay via `onEditParagraphs`. */}
            <div
              className="mm-ctx-item"
              onClick={() => {
                const n = ctxMenu.id;
                setCtxMenu(null);
                const hit = layout.boxes.find((b) => b.node.id === n);
                if (hit) openParagraphs(hit.node);
              }}
            >
              {t('tipNote')}
            </div>
            {editable && onAddNode && (
              <div
                className="mm-ctx-item"
                onClick={() => {
                  const n = ctxMenu.id;
                  setCtxMenu(null);
                  addAndEdit(n, 'child', n);
                }}
              >
                {t('cmdAddChild')} <span className="mm-ctx-key">Tab</span>
              </div>
            )}
            {editable && onAddNode && (
              <div
                className="mm-ctx-item"
                onClick={() => {
                  const n = ctxMenu.id;
                  setCtxMenu(null);
                  addAndEdit(n, 'sibling', n);
                }}
              >
                {t('cmdAddSibling')} <span className="mm-ctx-key">Enter</span>
              </div>
            )}
            {onExtractSubDoc && (
              <div
                className="mm-ctx-item"
                onClick={() => {
                  const n = ctxMenu.id;
                  setCtxMenu(null);
                  onExtractSubDoc(n);
                  focusCanvas();
                }}
              >
                {t('cmdExtractSubDoc')}
              </div>
            )}
            <div className="mm-ctx-sep" />
            <div
              className="mm-ctx-item"
              onClick={() => {
                const n = ctxMenu.id;
                setCtxMenu(null);
                onZoomChange?.(n);
                focusCanvas();
              }}
            >
              {t('cmdFocusNode')}
            </div>
            <div
              className="mm-ctx-item"
              onClick={() => {
                setCtxMenu(null);
                onZoomChange?.(null);
                focusCanvas();
              }}
            >
              {t('cmdBackToFullMap')}
            </div>
            {deletable && onDeleteNode && (
              <>
                <div className="mm-ctx-sep" />
                <div
                  className="mm-ctx-item mm-ctx-danger"
                  onClick={() => {
                    const n = ctxMenu.id;
                    setCtxMenu(null);
                    onDeleteNode(n);
                    focusCanvas();
                  }}
                >
                  {t('cmdDeleteNodeWithChildren')}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
