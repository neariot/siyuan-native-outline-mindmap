// Mount the React mind map component into SiYuan's Custom tab container.
//
// SiYuan hands the plugin a tab container via `custom.element` (HTMLElement),
// and here we create a React root and render Mindmap into it.
//
// Note: styles must be isolated —— SiYuan's global CSS affects our components,
// so the container carries a dedicated class and all styles are scoped under it (see plugin.css.js).

import * as React from 'react';
import { joinsUndoWindow } from '../core/undo-window';
import * as ReactDOM from 'react-dom/client';
import type { Custom } from 'siyuan';
import Mindmap from '../mindmap/Mindmap';
import Outliner from './outline/Outliner';
import { setOutlineImageClient } from './outline/images';
import type { OutlineNode } from '../model/types';
import { toggleTaskStatus } from '../model/types';
import { cloneNodes, collectIds, containsNode, flatNodes, touch } from '../model/tree';
import { openTab, showMessage } from 'siyuan';
import { SiYuanClient, isTargetGoneError } from '../siyuan/api';
import { SiYuanStore } from '../siyuan/store';
import { extractUpdates, extractDeletions, extractTouchedIds, EchoGuard, ConflictTracker, withEchoGuard, visibleText } from './sync';
import { escapeHtml } from '../model/html-escape';
import { makeSiyuanId } from '../core/map';
import { addChild, addSibling, countNodes, findNode, removeNode, removeNodes } from './tree-ops';
import type { IEventBus } from 'siyuan';
import { t } from './i18n';
import { getActiveDocId as resolveActiveDocId } from './active-doc';
// Component styles: Mindmap does not import CSS itself (it used to rely on App.tsx importing it),
// so the plugin's mount path must import them explicitly, or the mind map has no styles.
import '../styles.css';

  /**
   * Normalize a node's HTML into the plain text used for echo comparison.
   *
   * ★★★ Why both sides must share the same function (the measured false-conflict bug)
   *
   *   Every list node corresponds to **two** blocks in SiYuan: the listItem (structure) and a paragraph block (text carrier).
   *   A kernel transaction may report back either one, so both sides must take part in the comparison.
   *   But their `content` **formats differ**:
   *
   *       listItem  → ' A', ' '   ← carries a leading space (left behind by the list marker)
   *       paragraph → 'A', ''      ← clean
   *
   *   Measured (on a freshly created empty node):
   *       listItem.content = ' '
   *       paragraph.content = ''
   *
   *   The comparison used to call `.trim()` only on the mind map side and take the kernel value as-is ——
   *   so for an empty node the two sides were '' vs ' ', **never equal**.
   *   Every single Enter press falsely reported one more "content conflict":
   *
   *       ⚠ 1 content conflict → ⚠ 2 → ⚠ 3
   *
   *   Fix: one shared helper that strips tags + collapses whitespace + trims, used by both sides.
   *   That normalizes away the listItem's leading space, zero-width placeholders and `<br>`/`<p>` placeholders,
   *   leaving only the text the user actually sees in the comparison.
   */
  // ★ One authority with sync.ts. A second copy here disagreed about HTML entities, so a node containing
  //   `&`, `<` or `>` never matched its own echo and raised a conflict during every write-back.
  const plainNodeText = (html: string | undefined): string => visibleText(html ?? '');

/** Each tab instance owns one React root; remember to unmount it on teardown */
const roots = new WeakMap<HTMLElement, ReturnType<typeof ReactDOM.createRoot>>();

export interface MountDeps {
  /** Plugin event bus (on the Plugin instance, not on Custom) —— required for reverse sync */
  eventBus?: IEventBus;
  /** The plugin instance itself —— `openTab({ app })` needs it */
  plugin?: unknown;
}

/**
 * Mount the mind map into SiYuan's tab container.
 *
 * @param custom the Custom instance SiYuan passes in (`this`)
 */
export function mountMindmap(custom: Custom, deps: MountDeps = {}): void {
  const host = custom.element;
  if (!host) return;

  // Layout: make the container fill the tab and give inner components a positioning context
  host.classList.add('om-mm-host');
  host.style.height = '100%';
  host.style.overflow = 'hidden';

  const data = (custom.data ?? {}) as { docId?: string; followActive?: boolean };
  // In Dock mode `data.docId` is empty (it is meant for tabs).
  // So a `followActive` switch is added here: Dock passes true on mount,
  // and OmTabApp resolves the active document itself.
  const docId = data.docId ?? '';
  const followActive = data.followActive === true;

  const root = ReactDOM.createRoot(host);
  roots.set(host, root);
  root.render(
    React.createElement(OmTabApp, { docId, eventBus: deps.eventBus, followActive, plugin: deps.plugin }),
  );
}

/**
 * Get the currently active document ID (used by the Dock).
 *
 * Same source as the plugin-side `getActiveDocId`: on mobile it reads `siyuan.mobile.editor`,
 * on desktop `layout.centerLayout`, and finally falls back to DOM attributes.
 * It lives here on its own because the mount layer cannot conveniently import the plugin's main file (that would form a cycle).
 */
/** Clean up the React root on unmount to avoid a memory leak */
export function unmountMindmap(custom: Custom): void {
  const host = custom.element;
  if (!host) return;
  const root = roots.get(host);
  if (root) {
    root.unmount();
    roots.delete(host);
  }
}

/** App shell inside a tab; wires SiYuan data into the Mindmap component */
function OmTabApp({
  docId: givenDocId,
  eventBus,
  followActive,
  plugin,
}: {
  docId: string;
  eventBus?: IEventBus;
  /** Dock mode: not bound to a fixed document; follows "the active document" and reloads when it changes */
  followActive?: boolean;
  /** The plugin instance —— `openTab({ app })` needs it */
  plugin?: unknown;
}): React.ReactElement {
  // The Dock has no `data.docId`, so the active document is resolved at runtime instead;
  // when the user switches documents (frequently on mobile) the content must follow.
  const [activeDoc, setActiveDoc] = React.useState<string>(givenDocId);
  React.useEffect(() => {
    if (!followActive) return;
    const read = (): void => {
      const id = resolveActiveDocId();
      setActiveDoc(id);
      // Resolution is complete only once a definite document ID is known, and only then may "empty document" be shown.
      if (id) setDocResolved(true);
    };

    // Read an initial value first (a document may already be open at mount time).
    read();

    // Afterwards it is event-driven, not polled.
    //
    // SiYuan emits `switch-protyle` when the editor switches (app/src/editor/util.ts),
    // on both desktop and mobile. On receipt, re-read the active document.
    //
    // Why not poll: the poll interval is a lower bound on the latency. The old 1200ms poll meant
    // the panel could lag up to 1.2 seconds behind after a document switch (measured 1021ms);
    // and it ran all the time, purely spinning.
    //
    // The event carries `protyle`, but it is **not used directly**:
    // split view has several editors and `event.detail.protyle` is the one just switched to,
    // not necessarily the one the user is looking at. Everything goes through `resolveActiveDocId()`, which decides from the DOM,
    // matching the initial-value source so the two paths cannot give different answers.
    const onSwitch = (): void => {
      // Wait one frame before reading: when the event fires the DOM may not yet carry the new data-node-id.
      window.requestAnimationFrame(read);
    };
    eventBus?.on('switch-protyle', onSwitch);
    return () => {
      eventBus?.off('switch-protyle', onSwitch);
    };
  }, [followActive, eventBus]);
  // ★ docId override used by Save As:
  //   after the target document is deleted externally, "save as new document" must switch the working target to the new document.
  //   in tab mode `givenDocId` is an immutable prop, so an overridable state layer is added here;
  //   setting it to empty restores the original docId semantics.
  const [docIdOverride, setDocIdOverride] = React.useState<string>('');
  const setDocId = React.useCallback((id: string): void => {
    setDocIdOverride(id);
  }, []);

  const docId = docIdOverride || (followActive ? activeDoc : givenDocId);

  const [nodes, setNodes] = React.useState<OutlineNode[] | null>(null);
  /**
   * When "following the active document", docId is resolved **asynchronously** (see `read()` above).
   *
   * On the first render it is still an empty string, but that **does not mean** "this document has no content" ——
   * it has just not been resolved yet. Without that distinction, every panel open would first show
   * "this document has no content yet" and only refresh the real content about 1 second later (measured).
   */
  const [docResolved, setDocResolved] = React.useState<boolean>(!followActive);
  // Document title (the root node shows it instead of a block ID)
  const [docTitle, setDocTitle] = React.useState<string>('');
  // The title node's attached paragraph (the document's leading paragraph)
  const [docParagraphs, setDocParagraphs] = React.useState<string[]>([]);
  const docParagraphsRef = React.useRef<string[]>([]);
  // View mode: outline (structured editing, good for fast entry and re-organizing levels) / mind map (whole-picture view)
  const [view, setView] = React.useState<'outline' | 'mindmap'>('outline');
  // External-change counter: a block changed on the SiYuan side → increment → drive the outline view to re-render.
  // (Outliner uses controlled DOM internally, so a nodes change alone is not enough to refresh an already-focused editor)
  const [externRev, setExternRev] = React.useState(0);
  const [err, setErr] = React.useState<string>('');
  // ★ Whether the target document has been deleted externally (write-back gets "parent block not found" from the kernel).
  //   Once true, the UI offers a recoverable "save as new document" entry point,
  //   instead of letting the user keep typing into an interface that can never be written to.
  const [docGone, setDocGone] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  /**
   * The node the local (zoom) view is currently focused on.
   *
   * ★★★ This state **did not exist at all** before —— the zoom feature inside `Outliner` is complete:
   *   `Alt+→` / `Alt+←` to enter and leave by keyboard, double-click the dot to enter, single-click the dot to enter and leave,
   *   even the `title` tooltip text was written ("click to enter this topic" / "currently in local view…"),
   *   but when rendering `Outliner`, `mount.ts` **passed no `zoomId` / `onZoomChange`**.
   *
   *   So all those `onZoomChange?.(...)` calls landed on `undefined`,
   *   silently swallowed by the optional chain —— clicking the dot **did nothing at all**, with a normal UI and no error.
   *   Measured:
   *   ```
   *   Double-click the "A" dot → panel ['A','A1','A2','B'] (not a thing moved)
   *   Alt+→         → panel unchanged, focus unchanged
   *   ```
   *
   *   The §88 lesson surfaces once more: **if a single link in the chain fails to pass an optional parameter,
   *   the whole chain fails silently**. What was missed here was not a parameter but an entire props pair.
   */
  const [zoomId, setZoomId] = React.useState<string | null>(null);
  // Number of unresolved conflicts (when >0 the UI warns instead of silently swallowing the user's edits)
  const [conflictCount, setConflictCount] = React.useState(0);
  const storeRef = React.useRef<SiYuanStore | null>(null);
  // Mutable reference to the current tree: write-back needs the latest tree, while setState is asynchronous
  const nodesRef = React.useRef<OutlineNode[] | null>(null);
  // Loop guard: ignore kernel events during write-back and for a short window right after it finishes
  const guardRef = React.useRef(new EchoGuard());
  // Conflict tracking: when an external change collides with an uncommitted local intent, keep the local value and tell the user
  const conflictRef = React.useRef(new ConflictTracker());
  // Block ID → node ID reverse lookup (reverse sync uses it to translate "block changed" into "node must update")
  const blockToNodeRef = React.useRef(new Map<string, string>());
  // Undo/redo stack: stores **deep copies of the entire tree** as snapshots.
  //
  // Why not SiYuan's /api/transactions/undo: measured, that path **corrupts block structure**
  // (the original paragraph block simply disappears, extra empty paragraphs appear under the listItem, stray blocks show up in the document).
  // The plugin's own write-back goes through updateBlock, which keeps block IDs stable; undo is replayed along the same path,
  // and only then does it leave the document intact. The cost is snapshot memory —— hence a cap, dropping the oldest beyond it.
  const undoStackRef = React.useRef<OutlineNode[][]>([]);
  const redoStackRef = React.useRef<OutlineNode[][]>([]);
  const UNDO_LIMIT = 50;
  /**
   * Baseline "tree already committed to SiYuan" —— the only reliable source for undo snapshots.
   *
   * Why not use nodesRef directly: it is a **mutable reference**; reverse sync, the current write-back
   * and undo replay all rewrite it, so what you read is not necessarily the state "before this round of editing".
   * This ref is updated only after a successful write-back, so its meaning is unambiguous.
   */
  const lastCommittedRef = React.useRef<OutlineNode[] | null>(null);
  /**
   * The tree "before the current change" —— **for the undo stack only**, updated **synchronously** on every change.
   *
   * ★ Why this must be separate from `lastCommittedRef` (probe measurements):
   * `lastCommittedRef` advances only **after an asynchronous write-back succeeds**; its meaning is
   * "the tree confirmed on disk", used as the conflict baseline, so it **must lag**.
   * But the undo stack needs "the tree as of that moment", which **must stay in sync with the change**.
   * Packing both into the same ref is contradictory; measured evidence (creating nodes 3 times in a row):
   * ```
   * 1st create → push [A,B,C]          correct
   * 2nd create → push [A,B,C]          ★ wrong, New1 already exists by then
   * 3rd create → push [A,B,C,New1]      ★ one step behind
   * ```
   * → a single Ctrl+Z restores a state "earlier than expected",
   *   so New1/New2 are still in the UI while the blocks in SiYuan **have already been deleted** (silent data loss).
   */
  const prevTreeRef = React.useRef<OutlineNode[] | null>(null);

  /**
   * Write-back serialization queue.
   *
   * ★ Why it is mandatory (measured, **silent data loss**):
   * Write-back is `async`, and the user can keep working **before the previous write-back has finished**.
   * For example, four rapid Enter presses to create nodes:
   * ```
   * UI:     A B C Quick1 Quick2 Quick3 Quick4     ← 7 nodes, displayed fine
   * SiYuan: C B A                                 ← **not one** of Quick1~Quick4 **landed on disk**
   * ```
   * All 4 new nodes **are lost**, and `errs` is empty —— **no error is reported at all**.
   * The user only finds out after closing and reopening the document.
   *
   * Root cause: several `syncStructure` calls run **concurrently**, each runs `loadBlockMap` from scratch
   * and then `insertBlock` in sequence, racing each other and overwriting one another's results.
   * Same root cause as the undo merge window —— **write-back was not serialized**.
   *
   * Fix: wrap every write-back in a Promise chain (`queueRef.current = prev.then(...)`).
   * The next write-back starts only after the previous one has really finished, so `loadBlockMap` always reads
   * the blocks the previous one just inserted.
   */
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());

  /** Enqueue one write-back into the serial queue; the returned Promise resolves once that write-back is done */
  const enqueue = React.useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task);
    // The queue itself swallows exceptions, so one failure cannot stall every later write-back
    queueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  /**
   * Merge-style write-back that writes **the current tree** back to SiYuan.
   *
   * ★ The key difference from `enqueue(() => syncStructure(docId, tree in the closure))` (measured):
   * that form captures the tree **at enqueue time**, while `syncDeletions` reads the block map **at execution time**
   * —— the mismatch **deletes blocks that just landed on disk**. Measured:
   * ```
   * right after creating: SiYuan = A B C Quick1 Quick2 Quick3   ← on disk
   * 12 seconds later:    SiYuan = B C A Quick4                  ← Quick1~3 were deleted instead!
   * ```
   * Because the tree enqueued first was `[A,B,C,Quick1]`, and when it ran,
   * `lastListItems` already contained Quick2/Quick3 → judged as "deleted in the UI" → really deleted.
   *
   * Fix: **every write-back reads `nodesRef.current` at execution time**,
   * so the stale write-backs in between automatically become "write the latest state again", which is idempotent and safe.
   *
   * Going further, **write coalescing**: if a write-back is already queued, queue one more for the latest tree only ——
   * ten nodes created in rapid succession produce ~2 write-backs instead of 10.
   */
  /** The write-back currently queued (used for write coalescing) */
  const pendingWriteRef = React.useRef<Promise<void> | null>(null);
  /** The catch-up branch used by write coalescing calls itself recursively (a useCallback self-reference needs a ref) */
  /**
   * Open a SiYuan reference target (block ID / document ID).
   *
   * ★★★ Must use the **official `openTab` imported from the `siyuan` module** (measured).
   *
   *   Pitfall hit: assuming `window.siyuan.ws.app.openTabById` could be used ——
   *   measured, that `app` is only the **low-level WebSocket client**, with just two keys:
   *     appKeys = ["plugins", "appId"]
   *     hasOpenTabById = false
   *   `window.siyuan` has no model / layout.openTab either.
   *   ⇒ after probing, go back to the official API; do not guess at internal objects.
   */
  const openSiyuanRef = React.useCallback(async (target: string): Promise<void> => {
    if (!target) return;
    try {
      // First look up what this ID is (document / block) to decide how to open it
      const cli = new SiYuanClient({ baseUrl: '', token: '' });
      const rows = await cli.sql<{ id: string; root_id: string; type: string }>(
        `SELECT id, root_id, type FROM blocks WHERE id = '${target}' LIMIT 1`,
        1,
      );
      const hit = rows?.[0];
      if (!hit) {
        showMessage(t('errRefTargetGone'), 4000, 'error');
        return;
      }
      // Document → open it directly; block → open the document it belongs to (SiYuan scrolls to the block)
      const docId = hit.type === 'd' ? hit.id : hit.root_id;
      if (!docId) {
        showMessage(t('errRefDocNotFound'), 4000, 'error');
        return;
      }
      // ★★★ Use the `doc` branch of the official `openTab`.
      //
      //   2×2 controlled experiment (.tmp/k1-run.py, ):
      //
      //     app      action   page error   body
      //     ─────────────────────────────────────
      //     real app no       0            renders fine ✅
      //     real app yes      0            renders fine ✅
      //     plugin   no       1            blank     ❌
      //     plugin   yes      1            blank     ❌
      //
      //   ⇒ **the only independent variable is `app`**; whether `action` is passed makes no difference at all.
      //     (the claim "action must be passed" was inferred from kernel assembly and does not match measurement.)
      //
      //   `app` must be the real app instance: in the kernel's `class Ks` constructor
      //     s.plugins.forEach(...)     // s === app
      //   the plugin instance has no `plugins` field → undefined.forEach → crash.
      //
      //   `action` is still passed: it decides the "focus/scroll into place after opening" user experience
      //   (SiYuan itself uses this combination when a block reference is clicked), but it is unrelated to the crash.
      const appRef = (window as { siyuan?: { ws?: { app?: unknown } } }).siyuan?.ws?.app;
      // ★ No fallback to the plugin instance. It was `appRef ?? plugin`, and the table above measures what a
      //   plugin instance does: the kernel throws `undefined.forEach` inside its own constructor, the tab
      //   comes up **blank**, and the error stays in the background console —— the user gets a broken click
      //   and the plugin reports nothing. Substituting an argument that is known to fail is worse than
      //   saying the precondition is missing.
      if (!appRef) {
        showMessage(t('errClientNotReady'), 5000, 'error');
        return;
      }
      openTab({
        app: appRef,
        doc: {
          id: target,
          // The target may be a block ID —— the kernel resolves its owning document and locates the block
          action: ['cb-get-focus', 'cb-get-scroll'],
        },
        keepAlive: true,
      });
    } catch (e) {
      showMessage(t('errJumpFailed', { msg: (e as Error).message }), 5000, 'error');
    }
  }, [plugin]);

  const writeLatestRef = React.useRef<() => Promise<void>>(() => Promise.resolve());
  /**
   * Snapshot of the tree the last write-back **actually wrote to SiYuan**.
   *
   * ★ Why it is needed (the measured silent character-loss bug):
   *   The write-coalescing branch used to assume "the queued write-back will carry my change" and returned immediately.
   *   But that write-back **had already read the tree**, so edits arriving afterwards were never written back.
   *   Measured: typing the 4 characters "ReplaceOK" in one go, only the write-back for the 1st character landed,
   *   SiYuan stopped at 'R' while the UI still showed "ReplaceOK".
   *
   *   The criterion must compare **what the write-back actually wrote out** against the current tree,
   *   not "on entering the coalescing branch vs after waiting" —— because the tree had already changed before that.
   */
  const lastWrittenTreeRef = React.useRef<string>('');
  /**
   * The structure fingerprint from the last time the full structure reconciliation **ran successfully**.
   *
   * null = has never run yet → the first write-back must take the full path.
   * Advanced only **after structure reconciliation succeeds**; on a throw it stays put and the next run takes the full path again (safe).
   * Reset by loadDoc when the document changes.
   */
  const lastStructureRef = React.useRef<string | null>(null);
  /**
   * Serialize the node tree into a comparable string (a flat sequence of id + text only).
   * Used to tell whether the tree changed again after this write-back —— far cheaper than a deep-equal.
   */
  const serializeTree = (tree: OutlineNode[]): string => {
    const parts: string[] = [];
    const walk = (l: OutlineNode[]): void => {
      for (const n of l) {
        parts.push(`${n.id}:${n.text ?? ''}`);
        // ★★★ Fields **beyond the body text** must be included as well (the measured **truncated-note** bug).
        //
        //   This serialization is used to tell whether the tree changed again after the previous write-back:
        //   ```
        //   if (serializeTree(nodesRef.current) !== lastWrittenTreeRef.current) {
        //     await writeLatestRef.current();   // one catch-up write-back
        //   }
        //   ```
        //   It used to take only `id:text` —— so when **only the note changed, not the body**,
        //   the two serializations were **exactly identical** and the catch-up write was skipped.
        //
        //   Measured (typing the note "NoteContentABC" character by character on "A"):
        //   ```
        //   note in UI:  ['NoteContentABC']
        //   written:  only 'N'                   ← only the first character
        //   ```
        //   Because the first character triggered a write-back and the write-backs for the later characters
        //   were all dropped by the coalescing logic as "tree unchanged" —— the same as §77, where "only 'R' of 'ReplaceOK' was stored"
        //   it is **the second appearance of the same pitfall**: the premise of write coalescing must be genuinely asserted.
        //
        //   ★ : now that the note is carried by `paragraphs` (native attached paragraphs),
        //     this must switch to `paragraphs` as well —— otherwise the same truncation bug
        //     **replays unchanged** on attached paragraphs.
        parts.push(`${n.id}:paras=${JSON.stringify(n.paragraphs ?? [])}`);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return parts.join('\u0001');
  };

  /**
   * A fingerprint of **structure only**: node set + parent-child relations + order.
   *
   * ★★★ Why it is needed (the fix; measured root cause of **typing lag**):
   *
   *   `writeLatest` ran the full three-step structure reconciliation every time:
   *     syncStructure (including moveNodes, one DB lookup per node) → syncDeletions → saveNodesIncremental
   *   but **typing changes text only, not a single byte of structure** —— so those two steps ran for nothing.
   *
   *   Measured (240-node document, typing 1 character):
   *   ```
   *   189 API calls, 180 of them the same
   *     SELECT id FROM blocks WHERE parent_id=? AND type='l'
   *   the write to disk took ≈3 seconds; a 4-node document needed only 11 calls / 291 ms
   *   ```
   *   Call stack: `syncStructure → moveNodes → resolveWantList → ensureChildList`.
   *
   *   The criterion must contain structure fields only —— **`text` must not be counted in**, or a text edit would
   *   pass for a structure change and the optimization would be void. Conversely, omitting any structure field lets
   *   real structure changes be skipped (which is the dangerous direction), so every field is listed here:
   *   node id (add/remove), child order (move/reorder), and the fields that change block shape:
   *   attached paragraphs and summaries/connectors (each of them corresponds to its own block).
   */
  const structureFingerprint = (tree: OutlineNode[]): string => {
    const parts: string[] = [];
    const walk = (l: OutlineNode[]): void => {
      for (const n of l) {
        // Child order is expressed with ids: order changed → fingerprint changes
        const kids = (n.children ?? []).map((c) => c.id).join(',');
        // Attached paragraphs each produce their own block, so they are structure
        parts.push(
          `${n.id}[${kids}]p${(n.paragraphs ?? []).length}`,
        );
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return parts.join('\u0001');
  };

  /**
   * Collect "block ID → the plain text we wrote this round" so EchoGuard can recognize its own intermediate-state echoes.
   *
   * ★ Why it is needed (the measured false-conflict bug): during incremental typing every intermediate state
   *   produces a write-back and an echo; by the time the echo arrives the UI is usually further ahead,
   *   so "content != current value" and it is taken for an external change and **falsely reported as a conflict**.
   *   Registering these values with EchoGuard tells them apart from "another client really did change it".
   */
  const collectWrittenValues = React.useCallback(
    (tree: OutlineNode[]): Map<string, string> => {
      const store = storeRef.current;
      const out = new Map<string, string>();
      if (!store) return out;
      const walk = (l: OutlineNode[]): void => {
        for (const n of l) {
          // Text value of each block: both the listItem (structure block) and the paragraph block are registered,
          // because a kernel transaction may report back either one
          const text = plainNodeText(n.text);
          for (const bid of store.blockIdsOf(n.id)) out.set(bid, text);
          if (n.children?.length) walk(n.children);
        }
      };
      walk(tree);
      return out;
    },
    [],
  );

  /** The latest docId for writeLatest to read (so a closure cannot capture a stale value) */
  const docIdRef = React.useRef<string>(docId);

  /**
   * Turn a write-back exception into a **readable** UI message and light up the recovery entry point when "the target document was deleted".
   *
   * ★★★ Background (the measured **edits lost without a word** bug):
   *   After the target document is deleted externally, the outline UI **keeps displaying and keeps accepting input**,
   *   but every write-back is rejected by the kernel. The error used to be shown only as `block not found` ——
   *   it neither said the document had been deleted nor offered a remedy, so the user kept typing and kept losing.
   */
  const describeWriteError = React.useCallback((e: unknown): string => {
    // ★ docId is passed in: "document deleted" is concluded only when the error really names **this document's** ID
    //   (a stale child block ID reports the same `block not found`, so it cannot be generalized).
    if (isTargetGoneError(e, docIdRef.current)) {
      setDocGone(true);
      return t('msgTargetDocDeleted');
    }
    return e instanceof Error ? e.message : String(e);
  }, []);
  const writeLatest = React.useCallback((): Promise<void> => {
    const docIdNow = docIdRef.current;
    const store = storeRef.current;
    if (!docIdNow || !store) return Promise.resolve();
    // A write-back is already queued —— **but the caller must still wait for it to finish**,
    // otherwise the caller immediately reads `blockToNodeRef` (e.g. handleAddNode verifying a new node landed on disk)
    // before that write-back has run, and the check necessarily fails.
    const prev = pendingWriteRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (prev) {
      // A "write the latest tree" job is already queued —— but **it may already be past its tree read**.
      //
      // ★★★ There used to be a severe bug here (measured): a write-back read the tree at t0,
      //   keystrokes afterwards entered the queue at t1..t3 believing "the queued write-back will carry my change"
      //   and returned immediately —— but that one **had already read the tree**, so the text from t1..t3
      //   **was never written back**.
      //
      //   Measured (selection replaced + "ReplaceOK" typed in one go):
      //   ```
      //   handleOutlineChange called 4 times: R / Rep / Repl / ReplaceOK
      //   writeLatest called 4 times: hasPrev = [False, True, True, True]
      //   tasks actually queued: only 1, and the tree it read was ['R', 'B']
      //   SiYuan ends up with: ['R']   ← the last 3 characters are all lost while the UI shows "ReplaceOK"
      //   ```
      //
      //   Fix: **confirm once more** after waiting. If `nodesRef` changed again meanwhile
      //   (which means a later edit really was not covered by that write-back), **queue one more write-back yourself**.
      //   This keeps write coalescing (continuous typing still costs only one extra write) without losing the last edit.
      const wait = prev.then(async () => {
        const again = pendingWriteRef.current;
        if (again) await again;
        // The previous write-back has finished. If **the current tree** differs from "what was just written out",
        // a later edit was not covered —— do one catch-up write-back.
        // (idempotent: when the content is identical, saveNodesIncremental skips updateBlock internally)
        if (serializeTree(nodesRef.current ?? []) !== lastWrittenTreeRef.current) {
          await writeLatestRef.current();
        }
      });
      return wait;
    }
    const p = enqueue(async () => {
      const tree = nodesRef.current ?? [];
      // ★★★ Register "the values to be written at this instant" immediately, **before any request goes out**
      //   (the measured false-conflict bug).
      //
      //   An echo can even arrive before our own registration —— measured, when the first echo arrived
      //   the registration map was **completely empty**:
      //   ```
      //   {'inc':'F','isEcho':True,'ownVal':False,'dbg':{'has':False,'vals':[],'keys':[]}}
      //   ```
      //   Because while `saveNodesIncremental` was still awaiting, the kernel transaction had already
      //   been pushed back over ws. Registering after the write-back necessarily misses intermediate states,
      //   and the missed intermediate states are exactly the values later falsely reported as conflicts.
      //   Every intermediate state that is registered has its echo recognized by isOwnValue and skipped.
      guardRef.current.noteWrittenValues(collectWrittenValues(tree));
      // ★★ Open a "write-back transaction": inside it loadBlockMap really queries the DB only once.
      //
      //   The three steps below **each** call loadBlockMap, and it is
      //   `SELECT ... WHERE root_id=... AND type='i'` —— a scan of **the whole document**.
      //   Measured (300-node document, typing 10 characters):
      //   ```
      //   26 SQL calls in total, 16 of them this "fetch every listItem" query
      //   ```
      //   This is the largest single cost on the write-back path, and it grows linearly with document size
      //   (measured input latency: 34 ms at 300 nodes vs 12 ms at 20 nodes).
      //
      //   Kernel state does not change within one transaction, so the result can safely be reused.
      //   ★ The cache lives only for this write-back and never spans write-backs —— otherwise external changes would be invisible.
      store.beginWrite(docIdNow);
      let structChanged = false;
      try {
        // ★ syncStructure **rebuilds the reverse lookup tables** (lastBlockMap / lastListItems / lastByBlock) ——
        //   once it inserts a new block internally it records "node ID → new block ID".
        //   So syncDeletions must run **right after it** to see which node the just-inserted block belongs to.
        //   (in writeLatest the reverse lookup tables used to not be refreshed before syncDeletions,
        //   so the just-inserted blocks were judged "deleted in the UI" and **deleted right away** —— measured, all 4 new nodes lost.)
        // ★ Placeholder entries are produced by syncStructure and cleaned up by syncDeletions. Explicitly open one
          //   collection window and pass the set down, so concurrent write-backs cannot share an instance-level Set and step on each other.
          const phs = store.beginPlaceholderScope();
          // ★★★ Skip the first two steps when the structure has not changed (the fix; measured root cause of typing lag).
          //
          //   Typing changes text only, so structure reconciliation (syncStructure→moveNodes with one DB lookup per node,
          //   syncDeletions) ran for nothing: measured, in a 240-node document 180 of the
          //   `resolveWantList → ensureChildList` SQL calls all came from syncStructure.
          //
          //   The criterion uses `structureFingerprint` (structure fields only). The first write-back
          //   (`lastStructureRef` is null) always takes the full path, which guarantees that new documents,
          //   external changes and undo/redo are never skipped.
          //
          //   ★ Deletions take the full path too: `syncDeletions` removes the blocks that are "deleted in the UI",
          //     and fewer nodes is exactly a structure change → a different fingerprint → so it is naturally not skipped.
          const structNow = structureFingerprint(tree);
          structChanged = lastStructureRef.current !== structNow;
          if (structChanged) {
            await store.syncStructure(docIdNow, tree, phs);
            await store.syncDeletions(docIdNow, tree);
            // The baseline advances only after the structure write succeeds; on failure it keeps the old value and the next run takes the full path again
            lastStructureRef.current = structNow;
            // ★ A newly created node has by now registered its real block ID in the store's internal reverse table, so register the write-back values again
            //   to keep the kernel's subsequent echo from being taken for an external change and falsely reported as a conflict
            guardRef.current.noteWrittenValues(collectWrittenValues(tree));
          }
          await store.saveNodesIncremental(docIdNow, tree);
      } finally {
        // ★ It must sit in finally: even a write-back that throws midway must close the cache,
        //   otherwise the next write-back reads a **stale mapping** (and may judge healthy blocks as deleted).
        store.endWrite();
      }
      // Record what was **really written out** this time, so the coalescing branch can decide whether a catch-up write is needed
      lastWrittenTreeRef.current = serializeTree(tree);

      try {
        // ★ A plain text edit changes no block ID and no structure, so the reverse lookup tables need re-querying only when the structure changed
        if (structChanged) {
          await store.loadBlockMap(docIdNow);
          blockToNodeRef.current = store.blockToNode();
        }
      } catch {
        /* A failed reverse-table rebuild does not affect the main flow */
      }
    }).finally(() => {
      pendingWriteRef.current = null;
    });
    pendingWriteRef.current = p as Promise<void>;
    return p as Promise<void>;
  }, [enqueue, serializeTree]);
  // Lets the "catch-up write" branch of write coalescing call itself recursively (a useCallback cannot self-reference)
  writeLatestRef.current = writeLatest;

  React.useEffect(() => {
    docIdRef.current = docId;
  }, [docId]);
  /**
   * Undo merge window.
   *
   * While editing, `onInput` fires `onChange` on every keystroke (measured, a single
   * execCommand can even push two steps), and pushing one snapshot per event would make Ctrl+Z
   * "step back one character at a time". Here **consecutive edits to the same node within 1.2 seconds**
   * are merged into a single step: no repeated pushes inside the window, and the pre-edit state is recorded only on the first edit.
   */
  const mergeRef = React.useRef<{ key: string; at: number }>({ key: '', at: 0 });

  /**
   * Load a document from SiYuan (both the initial load and "use SiYuan as the source of truth" go through here).
   *
   * Loading resets local state: reverse lookup tables, the loop-guard window and conflict records.
   */
  const loadDoc = React.useCallback(async (): Promise<OutlineNode[]> => {
    // No target document → return an empty tree and let the UI show "please open a document first".
    // ★ This used to return sampleNodes() (the phase-3 demo data),
    //   so "opening the mind map with no document" showed a **fake document**:
    //   it looked like real content and was even editable, leaving the user no way to tell.
    //   Measured: the UI showed 5 demo nodes while the real document had other nodes entirely.
    //   (Luckily write-back has a docId guard, so the document was not actually damaged, but it was badly misleading.)
    if (!docId) return [];
    // Inside the plugin the origin is the same, so no explicit token is needed
    const client = new SiYuanClient({ baseUrl: '', token: '' });

    storeRef.current = new SiYuanStore({ client, notebook: '', basePath: '/' });

      // ★★★ Give the store a reader for "the current UI tree" (the fix for nodes lost when Enter is pressed repeatedly).
      //
      //   `syncDeletions` calls it once more **right before actually deleting**:
      //   the tree snapshot taken by a write-back may predate the latest creations, so a just-created node
      //   "does not exist" in the snapshot → judged "deleted in the UI" → really removed by deleteBlock,
      //   even though it is on screen right now (measured: nodes 1 and 4 were deleted while Enter was pressed repeatedly).
      //
      //   ★ It reads `nodesRef.current` —— the latest tree **at the moment of the call**,
      //     not a cache, not reused for reads or writes, just one final confirmation before deletion.
      storeRef.current.liveTreeProbe = (): Set<string> => {
        const ids = collectIds(nodesRef.current);
        return ids;
      };
    // ★ Hand the same client to the outline editor's image adapter layer.
    // What happens when this step is missing (measured): pasting an image into a node throws
    // "the SiYuan client is not ready, cannot save the image" and the image cannot be stored at all.
    setOutlineImageClient(client);
    const doc = await storeRef.current.loadDoc(docId);
    const tree = doc.nodes;
    // The root node title comes from the document title; when there is none it stays empty and Mindmap falls back to "untitled"
    setDocTitle(doc.meta.name === t('phUntitledDoc') ? '' : doc.meta.name);
    const paras = doc.meta.paragraphs ?? [];
    setDocParagraphs(paras);
    docParagraphsRef.current = paras;
    // When the document really has no content, show empty —— never pass demo data off as the user's content
    const finalTree = tree;
    // Build the "block ID → node ID" reverse table for reverse-sync matching
    try {
      const bmap = await storeRef.current.loadBlockMap(docId);
      // ★ Use store.blockToNode() —— it registers **both the paragraph block and the listItem** block IDs.
      //   Reversing it by hand yields only the paragraph block, so "external delete" events fail to match (see the method comment).
      blockToNodeRef.current = storeRef.current.blockToNode();
    } catch {
      blockToNodeRef.current = new Map();
    }
    // Key point: register the baseline "every node matches SiYuan right now".
    // Without this step the first external change would be misjudged as a conflict and refused.
    const flat: OutlineNode[] = flatNodes(finalTree);
    conflictRef.current.noteAllSynced(flat);
    // ★ Switching documents or reloading must set the structure baseline back to null:
    //   otherwise the new document's first write-back compares against **the previous document's** structure fingerprint,
    //   and if the two happen to be equal it skips structure reconciliation —— the new document's blocks are never created at all.
    lastStructureRef.current = null;
    return finalTree;
  }, [docId]);

  // ★ The `ws-main` callback (reload when the tree is empty) needs the **latest** `loadDoc`.
  //   The subscription effect depends on `[eventBus, docId]`, so its closure captures the
  //   `loadDoc` from the moment of subscription; and `loadDoc` is rebuilt whenever `docId` changes.
  //   Forwarding through a ref means the callback always gets the current version and never the previous document's loader.
  const loadDocRef = React.useRef(loadDoc);
  React.useEffect(() => {
    loadDocRef.current = loadDoc;
  }, [loadDoc]);

  React.useEffect(() => {
    // Document switch: the old conflict records and loop-guard window are void
    conflictRef.current.clear();
    setConflictCount(0);
    // On a document switch, set nodes back to null first (= loading).
    // Otherwise the previous round's `[]` lingers: the moment docId turns from an empty string into a real ID,
    // the UI renders the old empty array once as "this document has no content yet"
    // before the real data replaces it (measured: flashes for about 47ms).
    if (docId) setNodes(null);
    let alive = true;
    (async () => {
      try {
        const tree = await loadDoc();
        if (!alive) return;
        nodesRef.current = tree;
        setNodes(tree);
        // Initial baseline + clear the undo stack (old undo points are meaningless after a document switch)
        lastCommittedRef.current = snapshot(tree);
        // ★★★ `prevTreeRef` must be initialized at the same time (the probe-measured
        //   **first edit cannot be undone** bug).
        //
        //   `pushUndo` is implemented as:
        //     const src = before ?? prevTreeRef.current;
        //     if (!src) return;              ← skipped silently
        //   and every caller passes `pushUndo(prevTreeRef.current)`.
        //   If loading a document sets lastCommittedRef but not prevTreeRef,
        //   then the **first edit** passes in null → it is skipped silently → the undo stack stays empty.
        //
        //   Probe measurement (create a document, type, then Ctrl+Z):
        //   ```
        //   after typing: push=1, skip=1     ← called, but skipped by if (!src) return
        //   Ctrl+Z:       undo=1, depth=0    ← the stack is empty, undo has nothing to do
        //   after the 2nd edit: push=2, skip=1, depth=1  ← normal only from the 2nd edit on
        //   ```
        //   In other words, "the first edit after loading a document **can never be undone**".
        //
        //   The defect hides well: the user tries Ctrl+Z once, nothing happens, and assumes it is a focus problem;
        //   and after the second edit everything is normal, so it is easily taken for a fluke.
        prevTreeRef.current = tree;
        undoStackRef.current = [];
        redoStackRef.current = [];
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
        // ★ On error show **empty** and keep the error message; never stuff in demo data ——
        //   otherwise the user neither knows an error occurred nor realizes the fake content is not their document.
        nodesRef.current = [];
        setNodes([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId, loadDoc]);

  /** "Use SiYuan as the source of truth": discard local changes and reload */
  /**
   * After the target document is deleted externally, save **the current tree in memory** as a new document and switch to it.
   *
   * ★★★ Why it is needed (the measured **edits lost without a word** bug):
   *   After the document is deleted externally the outline UI still accepts input as usual, but every write-back is rejected
   *   by the kernel (`parent block not found`). The user's edits exist only in memory,
   *   so once the document is gone they are **lost for good** —— measured, a whole typed string left not one character on the SiYuan side.
   *
   *   This entry point turns "lost" into "recoverable": it uses `store.createDoc` to write the current tree
   *   as-is into a new document (`treeToKramdown`; node identity is carried by SiYuan block IDs),
   *   then switches docId over and the plugin works normally again.
   */
  const saveAsNewDoc = React.useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    const tree = nodesRef.current ?? [];
    if (!store) return;
    if (!tree.length) {
      setErr(t('errNoContentToSaveAs'));
      return;
    }
    setSaving(true);
    try {
      const title = t('phRestoredDocTitle', { time: new Date().toISOString().slice(0, 16).replace('T', ' ') });
      // ★★ It must go through the enqueue serial queue (the fix):
      //   This entry point used to **bypass** the queue and call `createDoc` + `loadBlockMap(newDocId)` directly.
      //   But `loadBlockMap` resets the instance-level `lastBlockMap / lastListItems /
      //   lastByBlock` tables wholesale —— they are **not keyed by docId**, the whole store has only one set.
      //   If a write-back for the old document is still in flight in the queue (syncStructure → syncDeletions),
      //   the old document's deletion check looks up `lastByBlock` with the **new document's** mapping:
      //   no owner is found → the block is judged "added externally, never seen before" → the safety gate stops it and the delete is missed forever,
      //   showing up as the silent inconsistency "deleted in the UI, block still there in SiYuan".
      //   Once queued, save-as necessarily happens **after** every in-flight write-back and cannot interleave.
      const newDocId = await enqueue(async () => {
        // The original docId is passed so the store can resolve the notebook —— otherwise an empty notebook string reports
        // `invalid ID argument` (the document is deleted, but its box may still be in the index)
        const created = await store.createDoc(title, tree, docIdRef.current);
        if (!created) return '';
        // The reverse tables are rebuilt in the same queued task, so another write-back cannot clobber them right after
        await store.loadBlockMap(created);
        return created;
      });
      if (!newDocId) {
        setErr(t('errSaveAsCreateFailed'));
        return;
      }
      // Switch docId: later write-backs all target the new document
      setDocId(newDocId);
      docIdRef.current = newDocId;
      setDocGone(false);
      setErr('');
      blockToNodeRef.current = store.blockToNode();
      showMessage(t('msgSavedAsNewDoc', { title }), 6000, 'info');
    } catch (e) {
      setErr(t('errSaveAsFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }, [enqueue, setDocId, showMessage]);

  const reloadFromSiYuan = React.useCallback(async (): Promise<void> => {
    try {
      const tree = await loadDoc();
      nodesRef.current = tree;
      setNodes(tree);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [loadDoc]);

  /**
   * Reverse sync: a block changed in SiYuan → the mind map updates automatically.
   *
   * Subscribes to `ws-main` through the plugin event bus and takes only `transactions` messages;
   * EchoGuard filters out the echoes produced by "our own write-backs" to avoid an infinite loop.
   */
  React.useEffect(() => {
    if (!eventBus || !docId) return;
    // ★ Coalesced whole-document re-read. See the "do not setNodes(null)" note in onWs.
    //   A read is in progress → just mark "read once more when done"; no read in progress → read immediately.
    let reloading = false;
    let reloadAgain = false;
    const doReload = (): void => {
      // ★★★ Let our **own write-back finish before reading** —— measured, this is the whole defect.
      //
      //   Drag-to-reparent in the mind map creates a listItem block, and its transaction arrives while the
      //   write is still running. That ID is neither known nor yet an echo, so it is judged "an external
      //   change I cannot map" and a whole-document re-read starts. The measured order was:
      //
      //     reparent builds and assigns the nested tree      ← the local tree is CORRECT here
      //     re-read starts, re-read lands: 3 flat roots      ← reads the kernel BEFORE our write landed
      //     our write finally finishes
      //
      //   So the read was not fighting a race against another reader; it was simply **early**. It faithfully
      //   returned the pre-write shape and overwrote the correct tree, which is why both views stayed flat
      //   while the document on disk held the nested one —— and why nothing about object identity or a
      //   "did a local edit happen" counter could catch it: the edit had already finished by then.
      //
      //   Waiting for `pendingWriteRef` is what makes the read see our own change. The echo guard is not
      //   enough on its own here, and this is the general form of the problem: any re-read triggered by a
      //   transaction we caused must not overtake the write that caused it.
      const waitForOwnWrite = pendingWriteRef.current ?? Promise.resolve();
      void waitForOwnWrite.catch(() => undefined).then(() => loadDocRef.current?.()).then((tree: OutlineNode[] | undefined) => {
        if (!tree) return;
        nodesRef.current = tree;
        setNodes(tree);
      }).catch(() => {
        /* A failed read does not affect the main flow: the next transaction triggers another */
      }).finally(() => {
        reloading = false;
        if (reloadAgain) {
          reloadAgain = false;
          scheduleReload();
        }
      });
    };
    const scheduleReload = (): void => {
      if (reloading) {
        reloadAgain = true;
        return;
      }
      reloading = true;
      doReload();
    };
    const onWs = (e: unknown): void => {
      const detail = (e as { detail?: { cmd?: string; data?: unknown } })?.detail;
      if (!detail || detail.cmd !== 'transactions') return;

      guardRef.current.prune();
      // ★★★ Reverse sync when the tree is empty (the fix).
      //
      //   The incremental path below relies entirely on `blockToNodeRef` to map a block ID to a node.
      //   When the document **was empty to begin with** that table is empty —— so **any** external change fails to match,
      //   is dropped outright ⇒ the panel stays forever on "this document has no content yet".
      //
      //   Measured (create an empty document → open the panel → type in the body):
      //     before typing  empty=true   rows=0
      //     after typing   empty=**still true**  rows=0     ← the content did go in
      //
      //   ★ The captured real messages: typing into an empty document sends **only update**, not a single insert
      //     —— so do not go adding an insert branch; follow the real messages:
      //       action=update  type=NodeParagraph  id=<paragraph block ID>
      //
      //   Fix: when **there is not a single node** current, a non-echo transaction triggers a whole-document re-read.
      //   An empty tree has no "increment" to speak of; re-reading is the least trouble and the least error-prone way;
      //   a non-empty tree still takes the original path and leaves what the user is editing alone.
      // ★★★ The criterion must be "**is there a block I cannot map**", **not** "is the tree empty".
      //
      //   The criterion "re-read only when the tree is empty" holds only for the step "the document was empty from the start",
      //   and **fails from the second node onwards**:
      //
      //   ```
      //   ① empty doc    → panel has 0 → criterion holds → re-read → "Node 1" appears ✓
      //   ② add "Node 2"  → panel has 1 → criterion **does not hold** → take the incremental path
      //                  → the incremental path looks block IDs up via blockToNodeRef,
      //                    which knows only the single block of "Node 1" (created at the last loadDoc)
      //                  → Node 2~5 all fail to match → dropped silently ✗
      //   ③ the panel stays at 1 forever —— as the user measured, "I typed 5 and the plugin kept showing only 1; a refresh fixed it"
      //   ```
      //
      //   Correct criterion: among the block IDs in this transaction, **as soon as one is not in my mapping table**,
      //   my picture of this document is already behind —— re-read the whole document once.
      //   A re-read is idempotent and costs one read; a missed read leaves the UI permanently out of step, and **reports nothing**.
      //
      //   It is still done only for non-echo events, so it cannot interrupt a write-back of our own that is underway.
      //
      //   ★★★ A re-read must **not** call `setNodes(null)` first.
      //
      //   Setting null makes the UI render "loading…". And while typing **every keystroke** brings
      //   a block I do not know yet → one `null` per keystroke → "the loading state flashes non-stop".
      //   The user's own words: "it keeps flashing loading! extremely annoying".
      //
      //   Correct approach: **keep the current tree** and replace it wholesale once the background read finishes.
      //   The cost is that the UI is briefly stale until the read lands (acceptable); what it buys is **no flashing**.
      //
      //   ★ High-frequency re-reads must also be **coalesced**: continuous typing fires several transactions in a row,
      //     otherwise transaction B reads A's stale result, C reads B's, … many reads for nothing.
      //     One "reading" flag plus one "read again when done" flag caps the tail at two reads.
      const known = blockToNodeRef.current;
      const touched = extractTouchedIds(detail.data);
      const unknown = [...touched].filter((id) => id !== docId && !guardRef.current.isEcho(id) && !known.has(id));
      if (unknown.length) {
        scheduleReload();
        return;
      }
      const updates = extractUpdates(detail.data);
      // ★ External **deletions** must be handled too (a follow-up fix).
      //   Only update transactions used to be parsed, so "deleting a list item in SiYuan" left
      //   that node in the mind map forever" —— it just hangs there,
      //   and clicking it again even writes this ghost node back to SiYuan.
      const deletions = extractDeletions(detail.data);
      const removeIds = new Set<string>();
      for (const blockId of deletions) {
        // A delete produced by our own write-back is an echo as well and must not be taken for an external deletion
        if (guardRef.current.isEcho(blockId)) continue;
        const nodeId = blockToNodeRef.current.get(blockId);
        if (!nodeId) continue;
        const node = findNode(nodesRef.current ?? [], nodeId);
        // The node is already gone locally → we just deleted it ourselves, no need to handle it again
        if (!node) continue;
        removeIds.add(nodeId);
      }
      if (removeIds.size) {
        const pruned = removeNodes(nodesRef.current ?? [], removeIds);
        // An external deletion must also forget conflicts and the baseline (same reasoning as handleDeleteNode)
        conflictRef.current.forget(removeIds);
        setConflictCount(conflictRef.current.list().length);
        // A deletion we started does not push to the undo stack (a "before deletion" snapshot is already there)
        // The undo stack needs the tree "before the change", so it must be saved in sync with the change
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = pruned;
        setNodes(pruned);
        setSelectedId(null);
        setExternRev((v) => v + 1);
      }
      if (!updates.size) return;

      // Decide conflicts one by one: external changes vs uncommitted local intents
      const conflicts: string[] = [];
      const safe = new Map<string, string>();
      for (const [blockId, incoming] of updates) {
        const nodeId = blockToNodeRef.current.get(blockId);
        if (!nodeId) continue;
        const node = findNode(nodesRef.current ?? [], nodeId);
        if (!node) continue;
        // Both sides use plainNodeText: the kernel-side listItem content carries a leading space,
        // so trimming only our side would leave empty nodes permanently mismatched (see the plainNodeText note)
        const current = plainNodeText(node.text);
        const incText = plainNodeText(incoming);

        // ⚠️ Skipping on isEcho alone is wrong: while a write-back is in flight applying=true,
        // and then **any** event is judged an echo —— including changes another client got in first with.
        // External changes would then be swallowed silently. So the echo check needs one more condition, "is the content ours":
        //   - content == current mind map value → really an echo of our own write-back, skip
        //   - content != current mind map value → someone else changed it, conflict handling is mandatory
        if (guardRef.current.isEcho(blockId) && (current === incoming || current === incText)) continue;
        // ★★★ "content != current value" is not enough (the measured false-conflict bug):
        //   it may be **someone else's change**, or **the echo of an earlier intermediate state of our own write-back**.
        //   During incremental typing the latter necessarily happens:
        //   ```
        //   write-back 1 → 'F'     by the time the echo arrives current is already 'Fast1'
        //   write-back 2 → 'Fast'  likewise != current
        //   ```
        //   The condition above takes both for external changes → one conflict recorded per keystroke.
        //   Measured, editing 3 nodes in a row → a banner "⚠ 3 content conflicts" with **no external change at all**.
        //   So one more condition: if this value is some version we wrote ourselves → an echo, skip.
        if (guardRef.current.isOwnValue(blockId, incoming) || guardRef.current.isOwnValue(blockId, incText)) continue;

        // ★ An external change received while a write-back is in flight will be overwritten by that in-flight write-back → it must be recorded as a conflict,
        //   otherwise the change vanishes without a word (see the writeInFlight note in ConflictTracker.check).
        if (
          conflictRef.current.check(
            nodeId,
            current,
            incText,
            guardRef.current.isApplying(),
          )
        ) {
          // ★ Conflict: keep the mind map's current value, do not overwrite silently
          conflictRef.current.record({
            nodeId,
            blockId,
            mine: current,
            theirs: incText,
            at: Date.now(),
          });
          conflicts.push(current);
          continue;
        }
        safe.set(blockId, incText);
      }
      if (conflicts.length) {
        setConflictCount(conflictRef.current.list().length);
      }
      if (!safe.size) return;
      const next = applyBlockUpdates(
        nodesRef.current ?? [],
        safe,
        blockToNodeRef.current,
        guardRef.current,
      );
      // An accepted change must update the baseline, or the next one would be misjudged as a conflict
      for (const [blockId, text] of safe) {
        const nid = blockToNodeRef.current.get(blockId);
        if (nid) conflictRef.current.acceptExternal(nid, text);
      }
      if (next) {
        // The undo stack needs the tree "before the change", so it must be saved in sync with the change
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = next;
        setNodes(next);
      }
    };
    eventBus.on('ws-main', onWs);
    return () => {
      eventBus.off('ws-main', onWs);
    };
  }, [eventBus, docId]);

  /**
   * Write a node edit back.
   *
   * Incremental sync first (only changed blocks are updated, block IDs are preserved and SiYuan references keep working);
   * if there is a structural change (nodes added or removed) that the incremental path cannot cover, tell the user plainly,
   * instead of quietly replacing the whole document —— that would rebuild every block ID and break references.
   */
  /**
   * Outline view change → write back to SiYuan.
   *
   * `kind` is used to merge undo stack entries ('text' merges continuous typing into one step),
   * but in this plugin the SiYuan blocks are the only data source and undo is left to SiYuan itself, so it is ignored here.
   */
  /** Deep-copy the node tree (for snapshots; the structure is simple, a JSON round trip suffices and is hard to get wrong) */
  const snapshot = (tree: OutlineNode[] | null): OutlineNode[] =>
    JSON.parse(JSON.stringify(tree ?? []));

  /**
   * Push the "tree before the edit" onto the undo stack and clear the redo stack (a new edit branch).
   *
   * ★ The **old value held by the caller** must be passed in; `nodesRef.current` must not be read.
   * Measured pitfall: when `onChange` fires, `nodesRef.current` may already have been
   * rewritten by reverse sync (the SiYuan → plugin feed-back) or by this round's sync, so reading it pushes
   * the **post-edit** state as the snapshot, and every undo then lags one step behind
   * (three undos give B→A→A rather than three distinct earlier states).
   */
  const pushUndo = React.useCallback((before: OutlineNode[] | null): void => {
    // Passing null falls back to "the tree before the change" —— the most common intent,
    // and callers usually just mean "push one step", so a missing exact value must not turn into a silent no-push.
    const src = before ?? prevTreeRef.current;
    if (!src) return;
    const st = undoStackRef.current;
    st.push(snapshot(src));
    if (st.length > UNDO_LIMIT) st.shift();
    redoStackRef.current = [];
  }, []);

  // Debounce timer for text edits: continuous typing is merged into one write-back, so per-character typing cannot fire frequent network requests
  const textDebounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The logic that actually writes back to SiYuan (called directly or triggered by the debounce) */
  const flushWrite = React.useCallback(
    async (treeToWrite: OutlineNode[]): Promise<void> => {
      if (textDebounceTimerRef.current) {
        clearTimeout(textDebounceTimerRef.current);
        textDebounceTimerRef.current = null;
      }
      const store = storeRef.current;
      const curDocId = docIdRef.current;
      if (!store || !curDocId) return;
      setSaving(true);
      setErr('');
      try {
        // ★ withEchoGuard opens and closes the echo window, so a **failed** write cannot leave the apply
        //   count above zero. Called by hand, a rejection skipped endApply and `isApplying()` stayed true
        //   for the rest of the session —— external edits stopped arriving and local ones were reported as
        //   conflicts, with no message.
        await withEchoGuard(
          guardRef.current,
          // ★ Reuse the reverse tables the store has already updated, so each write-back avoids an extra full SQL scan
          () => [curDocId, ...store.blockToNode().keys()],
          () => collectWrittenValues(nodesRef.current ?? []),
          async () => {
            conflictRef.current.noteAllSynced(treeToWrite);
            await writeLatest();
          },
        );
        // ★ Record the tree the write-back **actually wrote**, not the argument this call was given.
        //
        //   `writeLatest()` reads `nodesRef.current` inside its enqueued callback (mount.ts, the `const tree`
        //   line), and this call has already awaited —— so between the argument arriving and the write
        //   happening, a debounced edit or another structural change can replace the tree. Recording
        //   `treeToWrite` then leaves the baseline **older than what is in SiYuan**, and this ref is the
        //   baseline `pushUndo` uses for "the state before this change": a stale baseline makes one Ctrl+Z
        //   step jump further than the edit it should undo.
        //
        //   Measured to matter, not assumed: the two agree on every path where no edit interleaves, which is
        //   why this was invisible. The ref's own doc says "updated only after a successful write-back" ——
        //   so what it holds must be what the write-back wrote.
        lastCommittedRef.current = snapshot(nodesRef.current ?? treeToWrite);
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
    },
    [writeLatest],
  );

  const flushWriteRef = React.useRef(flushWrite);
  React.useEffect(() => {
    flushWriteRef.current = flushWrite;
  }, [flushWrite]);

  // On a document switch, immediately flush any debounced write-back still pending
  React.useEffect(() => {
    return () => {
      if (textDebounceTimerRef.current) {
        clearTimeout(textDebounceTimerRef.current);
        textDebounceTimerRef.current = null;
        if (nodesRef.current) {
          void flushWriteRef.current(nodesRef.current);
        }
      }
    };
  }, [docId]);

  const handleOutlineChange = React.useCallback(
    async (next: OutlineNode[], kind?: 'struct' | 'text'): Promise<void> => {
      // Merge window: consecutive edits to the same node within a short time count as a single undo step
      const mergeKey = (() => {
        try {
          const a = JSON.stringify(lastCommittedRef.current ?? []);
          const b = JSON.stringify(next);
          // Find the first differing node ID and use it as the merge key
          const fa = flatNodes(lastCommittedRef.current ?? []);
          const fb = flatNodes(next);
          for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
            if (JSON.stringify(fa[i]) !== JSON.stringify(fb[i])) return fb[i]?.id ?? fa[i]?.id ?? '?';
          }
          return a === b ? '' : '?';
        } catch {
          return '?';
        }
      })();
      const now = Date.now();
      // ★★★ The merge window **applies to text edits only** (the measured bug where discrete operations were merged wrongly).
      //
      //   It used to look only at "same node ID + within 1.2 seconds", treating two completely different kinds of thing alike:
      //     · continuous typing —— should merge (otherwise Ctrl+Z steps back one character at a time)
      //     · three indents / three moves up —— **must not merge**, they are three separate user decisions
      //
      //   Measured: 3 Tab indents (500ms apart) produced only 1 undo point,
      //   so a single Ctrl+Z undid all three steps and the user could not step back one at a time.
      //
      //   Structural operations always **become their own step**: when `kind === 'struct'`
      //   the window is neither reused nor refreshed —— every structural operation pushes a new undo point.
      const isStruct = kind === 'struct';
      const inWindow = joinsUndoWindow({
        kind,
        mergeKey,
        lastKey: mergeRef.current.key,
        elapsedMs: now - mergeRef.current.at,
      });
      if (!inWindow) {
        // The snapshot takes "the tree the last successful write-back sent to SiYuan" —— a pre-edit state with clear meaning
        pushUndo(prevTreeRef.current);
        // Clear the key after a structural operation so the next text edit cannot "join" the previous window
        mergeRef.current = { key: isStruct ? '' : mergeKey, at: now };
      } else {
        mergeRef.current.at = now;
      }
      setErr('');
      setNodes(next);
      // The undo stack needs the tree "before the change", so it must be saved in sync with the change
      prevTreeRef.current = nodesRef.current;
      nodesRef.current = next;

      if (isStruct) {
        // Structural operations (Enter, indent, delete node, …) must be written back immediately, without debouncing
        if (textDebounceTimerRef.current) {
          clearTimeout(textDebounceTimerRef.current);
          textDebounceTimerRef.current = null;
        }
        await flushWrite(next);
      } else {
        // Plain text input (typing): 250ms debounce, merging several keystrokes into one write-back
        if (textDebounceTimerRef.current) {
          clearTimeout(textDebounceTimerRef.current);
        }
        textDebounceTimerRef.current = setTimeout(() => {
          textDebounceTimerRef.current = null;
          void flushWriteRef.current(nodesRef.current ?? next);
        }, 250);
      }
    },
    [flushWrite, pushUndo],
  );

  /**
   * Write a snapshot tree **back to SiYuan** (shared by undo and redo).
   *
   * It takes exactly the same three-step path as ordinary editing, so block IDs stay stable, no loop occurs and no structure is destroyed.
   * Note that nothing is **pushed onto the undo stack** here —— undoing must not create a new undo point,
   * or Ctrl+Z would fall into an endless loop of "undoing its own undo".
   */
  const applySnapshot = React.useCallback(
    async (tree: OutlineNode[]): Promise<void> => {
      if (textDebounceTimerRef.current) {
        clearTimeout(textDebounceTimerRef.current);
        textDebounceTimerRef.current = null;
      }
      const store = storeRef.current;
      setNodes(tree);
      nodesRef.current = tree;
      setExternRev((v) => v + 1);
      if (!store || !docId) return;
      setSaving(true);
      setErr('');
      try {
        // ★ The echo window is opened and released by `withEchoGuard`, so a failed write cannot leave it
        //   open. Written out by hand, a rejection jumped past the release: `applyingCount` stayed above
        //   zero for the rest of the session, every later event was judged our own echo, and reverse sync
        //   stopped accepting external edits —— silently.
        await withEchoGuard(
          guardRef.current,
          () => [docId, ...store.blockToNode().keys()],
          () => collectWrittenValues(nodesRef.current ?? []),
          async () => {
            conflictRef.current.noteAllSynced(tree);   // ★ as above: the baseline is registered before the write-back
            await writeLatest();
          },
        );
        lastCommittedRef.current = snapshot(tree);
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
    },
    [docId, writeLatest],
  );

  const handleUndo = React.useCallback((): void => {
    const st = undoStackRef.current;
    if (!st.length) return;
    const prev = st.pop() as OutlineNode[];
    const cur = nodesRef.current;
    if (cur) {
      redoStackRef.current.push(snapshot(cur));
      if (redoStackRef.current.length > UNDO_LIMIT) redoStackRef.current.shift();
    }
    void applySnapshot(prev);
  }, [applySnapshot]);

  const handleRedo = React.useCallback((): void => {
    const st = redoStackRef.current;
    if (!st.length) return;
    const next = st.pop() as OutlineNode[];
    const cur = nodesRef.current;
    if (cur) {
      undoStackRef.current.push(snapshot(cur));
      if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    }
    void applySnapshot(next);
  }, [applySnapshot]);

  /** Document title edited in the outline view → use SiYuan's rename API (setBlockAttrs is not an option) */
  const handleTitleChange = React.useCallback(
    async (title: string): Promise<void> => {
      const name = title.trim();
      if (!docId || !name) return;
      setDocTitle(name);
      try {
        // ★★ **Both places must be written** (the measured bug where the title silently reverted).
        //
        //   A document has two "titles"; renaming only one of them makes them diverge for good:
        //     · the document block's (`type='d'`) own `content` —— the document name SiYuan recognizes
        //     · the `# Title` **heading block** in the body (it may not exist)
        //   Measured: after renaming, the title looks fine, but reopening brings the old value back, with no error at all.
        //
        //   (from now on `loadDoc` reads **the document block's content first**
        //    —— that is where SiYuan really stores the title; see the note in store.ts.
        //   Both places are still written here: if the heading block exists it is synced as well,
        //   so the user cannot see a stale title in the body, nor leave documents from older versions diverged.)
        const store = storeRef.current;
        await store?.renameDoc(docId, name);
        // The heading block is the one `loadDoc` falls back on, so it must take the new value
        await store?.setHeadingTitle(docId, name);
      } catch (e) {
        showMessage(t('errRenameFailed', { msg: (e as Error).message }), 5000, 'error');
      }
    },
    [docId],
  );

  const handleEdit = React.useCallback(
    async (id: string, text: string) => {
      // ★ Every mind map change must be pushed onto the undo stack.
      //   Only the outline's `handleOutlineChange` used to call pushUndo,
      //   while mind map edits/deletions/additions **pushed nothing at all** —— so Ctrl+Z did nothing in the mind map
      //   (`handleUndo` returned straight away at `if (!st.length) return`),
      //   even though the same data was undoable in the outline view. Added after measurement confirmed it.
      pushUndo(prevTreeRef.current);
      let updated = mapNodes(nodesRef.current ?? [], id, text);
      const store = storeRef.current;
      if (!docId || !store) {
        // The undo stack needs the tree "before the change", so it must be saved in sync with the change
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = updated;
        setNodes(updated);
        setExternRev((v) => v + 1);
        return;
      }

      // A pasted image may be inline `data:image/...;base64,...`.
      // Writing it straight into the block would bloat the block and make it invisible to other clients, so it is uploaded as a SiYuan asset first and then written back.
      try {
        const mig = await store.migrateInlineImages(updated);
        if (mig.migrated > 0) updated = mig.nodes;
      } catch {
        /* A failed migration does not block saving the edit; the image stays inline */
      }

      // The undo stack needs the tree "before the change", so it must be saved in sync with the change
      prevTreeRef.current = nodesRef.current;
      nodesRef.current = updated;
      setNodes(updated);

      setSaving(true);
      setErr('');
      // Lock before writing back: the kernel transactions produced meanwhile are all our own echoes and must be ignored (loop guard)
      // ★ The window is opened and released by `withEchoGuard`: a hand-written pair released from a `finally`
      //   still claimed the write on failure, and one without a `finally` left `applyingCount` above zero
      //   for the rest of the session, after which every later event was judged our own echo.
      try {
        await withEchoGuard(
          guardRef.current,
          // The blocks involved, as a backstop for the short window after it ends (events may arrive late)
          () => [...blockToNodeRef.current.values()],
          () => collectWrittenValues(nodesRef.current ?? []),
          async () => {
            // ★★★ The baseline is registered before the write-back (audit follow-up).
            //   Putting it after `await writeLatest()` is too late: echoes that arrive during the write-back round trip
            //   are compared against the old baseline and judged an external conflict (measured: disabling isOwnValue reproduces it).
            //   What is registered here is "our intended value" —— only if SiYuan later reports different content is it a real conflict.
            conflictRef.current.noteSynced(
              id,
              plainNodeText(findNode(updated, id)?.text),
            );
            // All three write-back steps go through writeLatest
            await writeLatest();
            // Rebuild the reverse tables after the write-back so reverse sync stays usable
            try {
              await store.loadBlockMap(docId);
              blockToNodeRef.current = store.blockToNode();
            } catch {
              /* A failed reverse-table rebuild does not affect the main flow */
            }
          },
        );
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
      // ★ The baseline advances after a successful write-back (see the long comment in handleDeleteNode for why)
      lastCommittedRef.current = snapshot(updated);
    },
    [docId, pushUndo],
  );

  /**
   * Attached paragraph edit (written back to SiYuan from the plugin side).
   *
   * Key differences from handleEdit:
   *   · the change lands in `paragraphs` (several paragraphs), not `text` (one)
   *   · **an empty string is a valid value** —— it stands for an empty paragraph and must not be filtered out,
   *     or the empty paragraph the user deliberately left would be deleted silently
   *
   * Everything else (pushing the undo stack, locking against echoes, advancing the baseline) is identical to handleEdit,
   * and skipping any one step brings back the problems fixed before.
   */
  const handleEditParagraphs = React.useCallback(
    async (id: string, paragraphs: string[]) => {
      pushUndo(prevTreeRef.current);
      // Plain text → HTML fragment (matching the mapNodes convention: wrap it in a <span>)
      const html = paragraphs.map((p) => (p ? `<span>${escapeHtml(p)}</span>` : ''));
      if (id === '__root__') {
        setDocParagraphs(html);
        docParagraphsRef.current = html;
        const store = storeRef.current;
        if (!docId || !store) return;
        setSaving(true);
        setErr('');
        try {
          await store.syncDocParagraphs(docId, html);
        } catch (e) {
          setErr(describeWriteError(e));
        } finally {
          setSaving(false);
        }
        return;
      }
      const applyParas = (ns: OutlineNode[]): OutlineNode[] =>
        ns.map((n) => {
          if (n.id === id) return { ...n, paragraphs: html, modified: Date.now() };
          if (n.children?.length) {
            const kids = applyParas(n.children);
            return kids === n.children ? n : { ...n, children: kids };
          }
          return n;
        });
      const updated = applyParas(nodesRef.current ?? []);
      const store = storeRef.current;

      if (!docId || !store) {
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = updated;
        setNodes(updated);
        setExternRev((v) => v + 1);
        return;
      }

      // The undo stack needs the tree "before the change", so it must be saved in sync with the change
      prevTreeRef.current = nodesRef.current;
      nodesRef.current = updated;
      setNodes(updated);

      setSaving(true);
      setErr('');
      // ★ The echo window is opened and released by `withEchoGuard`: releasing it from a `finally` kept the
      //   counter balanced but still recorded the write as ours when it had failed, which swallows a real
      //   external change that arrives in the short window afterwards; and a hand-written pair without a
      //   `finally` left `applyingCount` above zero for the rest of the session.
      try {
        await withEchoGuard(
          guardRef.current,
          () => [...blockToNodeRef.current.values()],
          () => collectWrittenValues(nodesRef.current ?? []),
          async () => {
            await writeLatest();
            try {
              await store.loadBlockMap(docId);
              blockToNodeRef.current = store.blockToNode();
            } catch {
              /* A failed reverse-table rebuild does not affect the main flow */
            }
          },
        );
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
      lastCommittedRef.current = snapshot(updated);
    },
    [docId, pushUndo],
  );

  const handleDocParagraphsChange = React.useCallback(
    async (paragraphs: string[]) => {
      setDocParagraphs(paragraphs);
      docParagraphsRef.current = paragraphs;
      const store = storeRef.current;
      if (!docId || !store) return;
      setSaving(true);
      setErr('');
      try {
        await store.syncDocParagraphs(docId, paragraphs);
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
    },
    [docId],
  );

  /**
   * Add a node. Insert it into the local tree first (the UI responds at once), then write it into SiYuan through structure sync.
   *
   * The new node ID uses a SiYuan-style ID —— so it is already "a real block ID in shape",
   * which makes later debugging and matching easier (the actual block ID is generated by SiYuan on insert,
   * and loadBlockMap then maps the two onto each other).
   */
  /**
   * Delete a node (subtree included).
   *
   * Ask for confirmation first —— the deletion writes the whole subtree into SiYuan as well, and it is an irreversible, destructive operation.
   */
  const handleDeleteNode = React.useCallback(
    async (id: string) => {
      const base = nodesRef.current ?? [];
      const target = findNode(base, id);
      if (!target) return;
      const kids = countNodes(target) - 1;
      const label =
        plainNodeText(target.text) ||
        t('lblEmptyNodeParen');
      const msg =
        kids > 0
          ? t('msgConfirmDeleteSubtrees', { label, n: kids })
          : t('msgConfirmDeleteNode', { label });
      if (!window.confirm(msg)) return;

      // ⚠️ This uses removeNode from `./tree-ops` (**not** the same-named function in `model/tree`):
      //   it returns a **new tree** and **refuses to delete a top-level node** (returns null) —— the top level counts as the root.
      //   "Expand as sub-document" moves the children away, leaving the parent as the document's only/top-level node,
      //   and a right-click delete then hits that rule and reports "the root node cannot be deleted".
      const updated = removeNode(base, id);
      if (!updated) {
        setErr(t('errRootNotDeletable'));
        return;
      }
      // Placed after confirmation and before the real change —— cancelling must not create an undo point
      pushUndo(prevTreeRef.current);
      // ★ The deleted node's conflicts and baseline (the whole subtree included) must be forgotten as well.
      //   Otherwise "⚠ N content conflicts" never returns to zero —— those nodes are no longer in the tree
      //   and no further event will clear their conflicts (see the ConflictTracker.forget comment).
      const gone: string[] = [];
      const collectGone = (l: OutlineNode[]): void => {
        for (const x of l) {
          gone.push(x.id);
          if (x.children?.length) collectGone(x.children);
        }
      };
      const removed = findNode(base, id);
      if (removed) collectGone([removed]);
      conflictRef.current.forget(gone);
      setConflictCount(conflictRef.current.list().length);
      // The undo stack needs the tree "before the change", so it must be saved in sync with the change
      prevTreeRef.current = nodesRef.current;
      nodesRef.current = updated;
      setNodes(updated);
      setSelectedId(null);

      const store = storeRef.current;
      if (!docId || !store) return;
      setSaving(true);
      setErr('');
      // ★★ Also wrapped in a write-back transaction (the fix): an external delete event may arrive while the main write-back
      //   is in flight, and without the wrapper the two would clear each other's placeholders and mapping cache.
      store.beginWrite(docId);
      try {
        // ★ The echo window is opened and released by `withEchoGuard`. Releasing it from a `finally` kept the
        //   counter balanced but still recorded the blocks as written when the write had failed, so a real
        //   external change arriving in the short window afterwards was swallowed as our own echo.
        await withEchoGuard(
          guardRef.current,
          () => [...blockToNodeRef.current.values()],
          () => collectWrittenValues(nodesRef.current ?? []),
          async () => {
            const del = await store.syncDeletions(docId, updated);
            try {
              await store.loadBlockMap(docId);
              // ★ Use store.blockToNode() —— it registers **both the paragraph block and the listItem** block IDs.
              //   Reversing it by hand yields only the paragraph block, so "external delete" events fail to match (see the method comment).
              blockToNodeRef.current = store.blockToNode();
            } catch {
              /* A failed reverse-table rebuild does not affect the main flow */
            }
            if (!del.removed) setErr(t('errDeleteNotWritten'));
          },
        );
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        store.endWrite();
        setSaving(false);
      }
      // ★ The baseline advances after a successful write-back —— without this step the mind map's undo granularity is wrong.
      //   `pushUndo(lastCommittedRef.current)` means "the state **before** this change",
      //   yet lastCommittedRef is updated only in loadDoc / handleOutlineChange / applySnapshot.
      //   So after N consecutive edits in the mind map the **same** snapshot (the one from load time) is pushed →
      //   one Ctrl+Z **undoes all N edits at once**.
      //   The outline path does not have this problem, because handleOutlineChange calls `snapshot(next)` after writing.
      lastCommittedRef.current = snapshot(updated);
    },
    [docId, pushUndo],
  );

  /**
   * Expand a node into a SiYuan sub-document.
   *
   * The child nodes are moved into the new document, and the node text keeps a native document reference ——
   * that is SiYuan's own structure, so backlinks, the outline and search all work automatically.
   */
  const handleExtractSubDoc = React.useCallback(
    async (id: string) => {
      const base = nodesRef.current ?? [];
      const target = findNode(base, id);
      if (!target) return;
      const label =
        plainNodeText(target.text) ||
        t('lblEmptyNodeParen');
      const kids = target.children ?? [];
      if (!kids.length) {
        setErr(t('errNoChildrenToExtract'));
        return;
      }
      if (
        !window.confirm(
          t('msgConfirmExtractSubDoc', { label, n: kids.length }) +
            t('msgConfirmExtractSubDocHint'),
        )
      ) {
        return;
      }

      const store = storeRef.current;
      if (!docId || !store) return;
      setSaving(true);
      setErr('');
      // Declared outside the try so the baseline can advance after a successful write-back (catch/finally must see it too)
      let committed = base;
      try {
        const subId = await store.nodeToSubDoc(docId, id, kids);
        if (!subId) {
          setErr(t('errCreateSubDocFailed'));
          return;
        }
        // Local tree sync: keep the node (it is a document reference now) and clear its children
        let updated = base.map(function walk(n): OutlineNode {
          if (n.id === id) {
            return {
              ...n,
              // ★★★ The reference must **replace** the original text, not be **appended** (the fix).
              //
              //   The original implementation was `${old text} <span data-noderef=…>title</span>`,
              //   so the node became "Branch A Branch A" —— the old text was still there,
              //   and the reference rendered the title a second time, **the same word appearing twice**.
              //   store concatenated the same way when writing back to SiYuan:
              //   `Branch A ((id 'Branch A'))`, so SiYuan showed two "Branch A" on one line as well.
              //
              //   Semantically it should be a replacement too: after expansion this node's identity is
              //   "a reference to the new sub-document", and the original text is already carried by the sub-document's title.
              text: `<span data-noderef="${subId}">${escapeHtml(label)}</span>`, 
              children: [],
              modified: Date.now(),
            };
          }
          if (n.children?.length) return { ...n, children: n.children.map(walk) };
          return n;
        });
        pushUndo(prevTreeRef.current);
        // The undo stack needs the tree "before the change", so it must be saved in sync with the change
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = updated;
        setNodes(updated);
        committed = updated;
        try {
          const bmap = await store.loadBlockMap(docId);
          // ★ Use store.blockToNode() —— it registers **both the paragraph block and the listItem** block IDs.
          //   Reversing it by hand yields only the paragraph block, so "external delete" events fail to match (see the method comment).
          blockToNodeRef.current = store.blockToNode();
        } catch {
          /* A failed reverse-table rebuild does not affect the main flow */
        }
      } catch (e) {
        setErr(describeWriteError(e));
      } finally {
        setSaving(false);
      }
      // ★ The baseline advances after a successful write-back (see the long comment in handleDeleteNode for why)
      lastCommittedRef.current = snapshot(committed);
    },
    [docId, pushUndo],
  );

  /**
   * **Drag a block from the SiYuan body into the mind map**.
   *
   * Since nodes are SiYuan blocks to begin with, no content has to be "imported" here ——
   * the dragged block's **text** is simply inserted into the mind map as a new node,
   * and on write-back it naturally becomes a real new list item in the document.
   *
   * Dropped onto a node → it becomes that node's child; dropped on blank space → it becomes a top-level node.
   */
  const handleDropBlocks = React.useCallback(
    async (blockIds: string[], targetId: string | null) => {
      const base = nodesRef.current ?? [];
      const store = storeRef.current;
      if (!docId || !store || !blockIds.length) return;
      setSaving(true);
      setErr('');
      // Declared outside the try so the baseline can advance after a successful write-back
      let committed = base;
      try {
        // Read the text of each SiYuan block one by one
        const texts: string[] = [];
        for (const bid of blockIds) {
          try {
            const plain = await store.blockPlainText(bid);
            if (plain) texts.push(plain.slice(0, 200));
          } catch {
            /* One block failing to read does not affect the others */
          }
        }
        if (!texts.length) {
          setErr(t('errDroppedBlocksNoText'));
          return;
        }

        // Create the new nodes first (addChild takes only an ID; the node contents are filled in afterwards in one pass)
        const fresh = texts.map((text) => ({
          id: makeSiyuanId(),
          modified: Date.now(),
          text: `<span>${escapeHtml(text)}</span>`,
          children: [] as OutlineNode[],
        }));

        let next: OutlineNode[] = base;
        for (const node of fresh) {
          if (targetId) {
            const withChild = addChild(next, targetId, node.id) ?? next;
            next = withChild.map(function fill(n): OutlineNode {
              return n.id === node.id ? { ...node } : { ...n, children: (n.children ?? []).map(fill) };
            });
          } else {
            next = [...next, node];
          }
        }
        pushUndo(prevTreeRef.current);
        // The undo stack needs the tree "before the change", so it must be saved in sync with the change
        prevTreeRef.current = nodesRef.current;
        nodesRef.current = next;
        setNodes(next);
        committed = next;

        // Write back: make the new nodes real blocks in the SiYuan document
        // ★★ Here too it must be **locked before writing** (same reasoning as the long comment in handleOutlineChange):
        //    syncStructure sends insertBlock, and if the lock is not held when the transaction comes back,
        //    reverse sync takes it for an external change and may trigger a false conflict or overwrite the tree back.
        // ★★ This write path used to skip the write-back transaction (the fix):
        //   it bypassed the enqueue serial queue, and running concurrently with the main write-back the two would clear each other's
        //   `pendingPlaceholders` / mapping cache. Wrapping it in beginWrite's depth count
        //   makes it share one transaction semantics with the main write-back (the cache really closes only when the outermost frame ends).
        store.beginWrite(docId);
        try {
          // ★ The echo window is opened and released by `withEchoGuard`. Balancing it by hand leaked: when
          //   `syncStructure` threw, neither release ran, `applyingCount` stayed above zero and every later
          //   external change was ignored silently (real external edits swallowed as echoes).
          await withEchoGuard(
            guardRef.current,
            () => [...blockToNodeRef.current.values()],
            () => collectWrittenValues(nodesRef.current ?? []),
            async () => {
              // ★ Explicitly open one placeholder-collection window and pass the set down:
              //   same convention as handleOutlineChange. Without it syncStructure falls
              //   back to the instance-level `pendingPlaceholders` and steps on concurrent write-backs.
              const phs2 = store.beginPlaceholderScope();
              await store.syncStructure(docId, next, phs2);
              try {
                await store.loadBlockMap(docId);
                // ★ Use store.blockToNode() —— it registers **both the paragraph block and the listItem** block IDs.
                //   Reversing it by hand yields only the paragraph block, so "external delete" events fail to match (see the method comment).
                blockToNodeRef.current = store.blockToNode();
              } catch {
                /* A failed reverse-table rebuild does not affect the main flow */
              }
            },
          );
        } finally {
          store.endWrite();
        }
        conflictRef.current.noteAllSynced(next);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
      // ★ The baseline advances after a successful write-back (see the long comment in handleDeleteNode for why)
      lastCommittedRef.current = snapshot(committed);
    },
    [docId, pushUndo],
  );

  /**
   * **Synchronously** add a node: update React state and return the new id at once, without waiting for the kernel to write to disk.
   *
   * Why this is split into a synchronous part:
   * after adding a node the mind map must show the editor box at once, or characters the user types before the write to disk finishes
   * all land on the canvas (they are swallowed, and extra empty nodes get created).
   * Putting a node into React state is synchronous anyway, so "create the node" and "write to SiYuan" are decoupled.
   */
  const handleAddNodeSync = React.useCallback(
    (parentId: string, mode: 'child' | 'sibling', afterId: string): string | null => {
      const newId = makeSiyuanId();
      const base = nodesRef.current ?? [];
      const updated =
        mode === 'child'
          ? addChild(base, parentId, newId)
          : addSibling(base, afterId, newId);
      if (!updated) return null;
      pushUndo(prevTreeRef.current);
      // The undo stack needs the tree "before the change", so it must be saved in sync with the change
      prevTreeRef.current = nodesRef.current;
      nodesRef.current = updated;
      setNodes(updated);
      setSelectedId(newId);
      return newId;
    },
    [pushUndo],
  );

  const handleAddNode = React.useCallback(
    async (parentId: string, mode: 'child' | 'sibling', afterId: string): Promise<string | null> => {
        // ★★★ The whole "change the tree → open the guard window → write back → close the guard window" must be serialized **as one unit**
        //   (the fix; the root cause of data loss and duplicated nodes when Enter is pressed repeatedly).
        //
        //   Original implementation: **first** change `nodesRef` synchronously, **then** await writeLatest().
        //   Only inside writeLatest does it enter the enqueue queue. With Enter pressed 4 times in a row:
        //   ```
        //   t0  1st: change tree (with node 1)  → enqueue
        //   t1  2nd: change tree (nodes 1,2)    → enqueue   ← the two beginApply calls open almost simultaneously
        //   t2  3rd: change tree (…)            → enqueue
        //   t3  4th: change tree (…)            → enqueue
        //   ```
        //   The write-backs are serialized by the queue, but `beginApply/endApply` are **separate windows**:
        //   the 1st endApply runs only **after** the 4th beginApply →
        //   the guard-window count goes wrong → ws echoes arriving meanwhile are misjudged as external changes
        //   → a re-read is triggered that **rolls `nodesRef` back to the old tree**.
        //
        //   Two measured symptoms (the same race, appearing at random):
        //   ```
        //   Enter pressed 1/2/3/4:
        //     panel ["Start","1","2","3","4"] SiYuan ["Start","2","3"]       ← 1 and 4 lost
        //     panel ["Start","1","2","3","4"] SiYuan ["Start","1","1","2"...] ← 1 duplicated
        //   accompanied by `tree not found`: updateBlock is called with a block ID that the rollback already destroyed
        //   ```
        //   ★ Neither **reports an error**; the user only notices the wrong content after closing and reopening.
        //
        //   Fix: move `handleAddNodeSync` (the tree change) **into the queue as well**,
        //         so "change tree + write back" becomes one indivisible step.
        //         The next tree change happens only after the previous one has fully finished —— the guard windows cannot overlap.
        return await enqueue(async () => {
          const newId = handleAddNodeSync(parentId, mode, afterId);
          if (!newId) return null;
          const updated = nodesRef.current ?? [];

          const store = storeRef.current;
          if (!docId || !store) return newId;
          setSaving(true);
          setErr('');
          // ★ The echo window is opened and released by `withEchoGuard`, so a failed write cannot leave it
          //   open. Written out by hand (`beginApply(); await writeLatest(); endApply(...)`), a rejection
          //   jumped straight past the release: `applyingCount` stayed above zero for the rest of the
          //   session and every later event was judged our own echo, so external edits stopped arriving.
          try {
            await withEchoGuard(
              guardRef.current,
              // The blocks involved, as a backstop for the short window after it ends (events may arrive late)
              () => [...blockToNodeRef.current.values()],
              () => collectWrittenValues(nodesRef.current ?? []),
              async () => {
                await writeLatest();
                try {
                  blockToNodeRef.current = store.blockToNode();
                } catch {
                  /* A failed reverse-table rebuild does not affect the main flow */
                }
                // Keep the "did the addition really land on disk" warning: after write-back the new node should be findable in the reverse tables.
                //   Not finding it means the block was never created (previously, when resolveListItem could not find a block,
                //   the UI looked fine while SiYuan had nothing, and **no error was raised** —— measured, whole batches of nodes were lost).
                if (!blockToNodeRef.current.has(newId)) {
                  setErr(t('errAddNodeNotWritten'));
                }
              },
            );
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setSaving(false);
          }
          // ★ The baseline advances after a successful write-back (see the long comment in handleDeleteNode for why).
          //   ★ It must sit here and not in `handleAddNodeSync` —— the latter is **synchronous** and
          //     only changes React state; SiYuan has nothing on disk at that point, so the baseline must not advance early.
          lastCommittedRef.current = snapshot(updated);
          return newId;
        });
      },
      [docId, enqueue],
  );

  if (nodes === null) {
    return React.createElement(
      'div',
      { className: 'om-mm-root om-mm-loading' },
      t('msgLoading'),
    );
  }

  // While "which document to follow" is still being resolved, show loading as well ——
  // an empty docId at that point is **temporary** and must not be read as "no content yet".
  // (The fix: opening the panel used to flash
  //   "this document has no content yet" first, and only refresh the real content about 1 second later.)
  if (!docResolved) {
    return React.createElement(
      'div',
      { className: 'om-mm-root om-mm-loading' },
      t('msgLoading'),
    );
  }

  // ★ Empty state: tell the user plainly **why** it is empty instead of showing a blank area ——
  //   and never pass demo data off as content.
  if (!docId) {
    return React.createElement(
      'div',
      { className: 'om-mm-root om-mm-empty' },
      React.createElement('div', { className: 'om-mm-empty__title' }, t('lblNoDocLinked')),
      React.createElement(
        'div',
        { className: 'om-mm-empty__hint' },
        t('msgOpenDocHint'),
      ),
    );
  }


  return React.createElement(
    'div',
    { className: 'om-mm-root', style: { height: '100%', width: '100%' } },
    err
      ? React.createElement(
          'div',
          { className: 'om-mm-err' },
          err,
          // ★ The target document was deleted externally → offer an **actionable** recovery entry point.
          //   Without this button the user can only keep typing into an interface that can never be written to,
          //   with every edit staying in memory and finally lost without a word (measured).
          docGone
            ? React.createElement(
                'button',
                {
                  className: 'om-mm-err-btn',
                  onClick: () => void saveAsNewDoc(),
                  disabled: saving,
                },
                t('cmdSaveAsNewDoc'),
              )
            : null,
        )
      : null,
    // Conflict notice: tell the user plainly **which edit was not accepted** instead of swallowing it silently
    conflictCount > 0
      ? React.createElement(
          'div',
          { className: 'om-mm-conflict' },
          t('msgConflictBanner', { n: conflictCount }),
          React.createElement(
            'button',
            {
              className: 'om-mm-conflict-btn',
              onClick: () => {
                // Use SiYuan as the source of truth: re-fetch the document and overwrite the local copy
                conflictRef.current.clear();
                setConflictCount(0);
                void reloadFromSiYuan();
              },
            },
            t('cmdReloadFromSiYuan'),
          ),
        )
      : null,
    saving
      ? React.createElement('div', { className: 'om-mm-saving' }, t('msgSaving'))
      : null,
    React.createElement(
      'div',
      { className: 'om-mm-viewswitch' },
      React.createElement(
        'button',
        { className: view === 'outline' ? 'active' : '', onClick: () => setView('outline') },
        t('lblViewOutline'),
      ),
      React.createElement(
        'button',
        { className: view === 'mindmap' ? 'active' : '', onClick: () => setView('mindmap') },
        t('lblViewMindmap'),
      ),
    ),
    view === 'outline'
      ? React.createElement(Outliner, {
          nodes,
          docId,
          docTitle,
          // External-change counter: incremented when a block changes in SiYuan, driving the outline to re-render
          externRev,
          docParagraphs,
          onDocParagraphsChange: (p: string[]) => {
            void handleDocParagraphsChange(p);
          },
          onChange: (next: OutlineNode[], kind?: 'struct' | 'text') => {
            // ★ `kind` must be passed through to handleOutlineChange:
            //   This used to read `(next) => { void handleOutlineChange(next); }`,
            //   dropping the second argument —— so structural operations (indent/move up/delete/…)
            //   went through the same 1.2-second merge window as continuous typing,
            //   three indents produced only 1 undo point and one Ctrl+Z undid them all.
            void handleOutlineChange(next, kind);
          },
          onTitleChange: (t: string) => {
            void handleTitleChange(t);
          },
          // Undo/redo is left to SiYuan itself (blocks are the only data source), so no local stack is wired up here
          onUndo: handleUndo,
          onRedo: handleRedo,
          // ★★★ Clicking a block reference / mention inside a node → open the target (added).
          //   Defect: in Outliner `onOpenNoderef` / `onOpenMention` were
          //   callbacks that were **declared but never given a value**: clicking did not jump and raised no error.
          onOpenRef: (target: string) => {
            void openSiyuanRef(target);
          },
          // ★ Local view (zoom): it must be wired up, or the whole zoom UI inside Outliner is dead code
          zoomId,
          onZoomChange: (id: string | null) => {
            setZoomId(id);
            // After entering or leaving the local view, give focus back to the focused node,
            // or keyboard actions after Alt+→ all miss (§90's "one-way focus migration" defect).
            if (id) setSelectedId(id);
          },
          // Document list / open sub-document: not needed in the plugin for now (sub-documents go through the mind map context menu)
          docs: [],
          onOpenDoc: () => {},
        })
      : React.createElement(Mindmap, {
      nodes,
      title: docTitle || t('mindmapTitle'),
      docParagraphs,
      onEditNode: (id: string, text: string) => {
        void handleEdit(id, text);
      },
      onEditParagraphs: (id: string, paragraphs: string[]) => {
        void handleEditParagraphs(id, paragraphs);
      },
      // ★ The mind map needs undo/redo as well. It used to be passed to the outline only,
      //   so Ctrl+Z did nothing in the mind map (while the same data was undoable in the outline).
      onUndo: handleUndo,
      onRedo: handleRedo,
      // ★ The new node's id must be returned **synchronously** so the mind map can enter edit mode at once.
      //
      //   Returning handleAddNode's Promise is not an option —— that Promise waits for
      //   `syncStructure` (several kernel API round trips) before it resolves, about 1 second when measured.
      //   During that second the editor box is not up yet and every character the user types **lands on the canvas**:
      //   measured, typing A/B/C right after Enter targeted
      //   `DIV.mm-canvas` in all three cases, the characters were lost outright and extra empty nodes were created.
      //
      //   But a node appearing in React state is **synchronous** (handleAddNode calls
      //   setNodes right at the start), so handing the id out synchronously lets edit mode start at once;
      //   writing to disk continues in the background and a failure still calls setErr as usual.
        // ★★★ A **write-back must be triggered** here (the fix; the root cause of nodes lost or duplicated when Enter is pressed repeatedly).
        //
        //   The original implementation called only `handleAddNodeSync` —— it changed the tree without writing to disk.
        //   So a node created in the mind map/outline lived in the UI only, waiting for **the next**
        //   arbitrary write-back (even one that just edits other text) to notice it and insert it late.
        //   The late insert and this creation take two different paths → the same node lands on disk twice
        //   (measured: "the last node of every batch is duplicated"),
        //   or one of the two blocks has been destroyed by the other → `tree not found` and the node is lost.
        //
        //   Fix: queue the change for write-back **immediately**.
        //   ★ Use `writeLatestRef` rather than wrapping another enqueue:
        //     it already carries the "take the latest tree + coalesce with the previous write" logic,
        //     so in rapid succession a later call coalesces with the unfinished earlier one
        //     and does **not** become "one write-back per keystroke".
        //
        //   ★ The id is still returned **synchronously**: Mindmap needs to enter edit mode at once.
        //     Returning a Promise (waiting ~1 second for the kernel to write to disk) means that during that second
        //     characters the user types land on the canvas and are swallowed (measured: A/B/C all lost).
        onAddNode: (parentId: string, mode: 'child' | 'sibling', afterId: string): string | null => {
          const id = handleAddNodeSync(parentId, mode, afterId);
          if (!id) return null;
          // Queue one write-back. A failure still calls setErr as usual and does not affect the id already returned synchronously.
          void writeLatestRef.current().catch((e: unknown) => {
            setErr(describeWriteError(e));
          });
          return id;
        },
      selectedId,
      onSelectNode: setSelectedId,
      // ★ The mind map draws a to-do's checkbox with a pointer cursor and handles its click, but **nothing
      //   ever passed `onToggleTask`**, so clicking it did nothing at all (measured: the box stays unfilled
      //   and no check mark appears, whatever the state). Same cycle as the outline's own checkbox, and the
      //   same path as every other structural change, so it becomes an undo step and is written at once.
      onToggleTask: (id: string) => {
        const draft = cloneNodes(nodesRef.current ?? []);
        const node = findNode(draft, id);
        if (!node) return;
        node.taskStatus = toggleTaskStatus(node.taskStatus);
        touch(node);
        void handleOutlineChange(draft, 'struct');
      },
      onDeleteNode: (id: string) => {
        void handleDeleteNode(id);
      },
      deletable: true,
      onExtractSubDoc: (id: string) => {
        void handleExtractSubDoc(id);
      },
      onDropBlocks: (ids: string[], target: string | null) => {
        void handleDropBlocks(ids, target);
      },
      // ★★ Local view (zoom): it shares the same state as the outline view and must be wired up as well.
      //
      //   `Outliner` above got `zoomId` / `onZoomChange` (the earlier fix),
      //   but **`Mindmap` was missed** —— so in the mind map view "focus this node" / "back to full map"
      //   and dot clicks on nodes all go through `onZoomChange?.()`,
      //   and the optional chain silently swallowed `undefined`: the menu opened, clicking did nothing, and no error appeared.
      //
      //   The same pitfall hit once more: **if a single link in the chain misses an optional argument, the whole chain fails silently**.
      //   Caught by E2E (keyboard.spec.ts "only the subtree shows after focusing a node" asserts the node count should drop; measured, nothing moved).
      zoomId,
      onZoomChange: (id: string | null) => {
        setZoomId(id);
        // Sync the selection after focusing, or keyboard actions still act on the old node
        if (id) setSelectedId(id);
      },
      /**
       * Open a SiYuan reference target (block ID or document ID).
       *
       * ★ `openTabById` is the official entry point: it opens documents and blocks alike,
       *   **reuses an already-open tab** and scrolls to the block automatically.
       *   Do not assemble a tab by hand —— that is an internal implementation detail.
       */
      /**
       * ★ Clicking a block reference / mention → open the target.
       */
      // ★ Reparenting by drag in the mind map (added).
      //   Dropped **onto a node** → becomes its child. One zone, not the outline's three: a map has no
      //   meaningful "between two nodes", so the drop position can only mean *which node you aimed at*.
      //   Releasing on blank space is a no-op and the node returns to its computed place —— positions come
      //   from the layout, and the node model has no per-node coordinate to move.
      //   Dragging here used to pan the canvas only, so nodes could not be reparented at all (measured).
      onReparent: (ids: string[], targetId: string) => {
        const base = nodesRef.current ?? [];
        // A node must not be dragged into its own descendant (that would create a cycle)
        const target = findNode(base, targetId);
        if (!target) return;
        const moving = ids.filter((i) => i !== targetId);
        if (!moving.length) return;
        // Refuse a drop into the moved node's own subtree. `containsNode` also reports the node itself,
        // which `moving` has already excluded, so this is the descendant case and that case in one test.
        for (const id of moving) {
          const n = findNode(base, id);
          if (n && containsNode(n, targetId)) return; // dropped into its own subtree → ignore
        }
        // ★ Take the node itself out first (removeNode returns only a **new array**, not the removed node)
        const grabbed: OutlineNode[] = [];
        for (const id of moving) {
          const n = findNode(base, id);
          if (n) grabbed.push({ ...n, modified: Date.now() });
        }
        if (!grabbed.length) return;
        pushUndo(prevTreeRef.current);
        prevTreeRef.current = nodesRef.current;
        let draft = base;
        for (const id of moving) {
          const next = removeNode(draft, id);
          if (next) draft = next;
        }
        // Append to the **end** of the target node's children (consistent with the outline's drop zone='child')
        draft = draft.map(function attach(n): OutlineNode {
          if (n.id === targetId) {
            return { ...n, collapsed: false, children: [...(n.children ?? []), ...grabbed] };
          }
          return n.children?.length ? { ...n, children: n.children.map(attach) } : n;
        });
        nodesRef.current = draft;
        setNodes(draft);
        void writeLatest();
      },
      onFocusNode: (id: string) => {
        // For a later "mind map → SiYuan block" jump link
        void id;
      },
    }),
  );
}

/**
 * Apply "SiYuan block updates" to the node tree and return the new tree; return null when nothing changed.
 *
 * A pure function (guard's isEcho is only read), which keeps it unit-testable.
 * - `updates`: block ID → new plain text
 * - `blockToNode`: block ID → node ID
 * - blocks judged an echo by EchoGuard are skipped outright (loop guard)
 */
export function applyBlockUpdates(
  nodes: OutlineNode[],
  updates: Map<string, string>,
  blockToNode: Map<string, string>,
  guard: { isEcho(blockId: string): boolean },
): OutlineNode[] | null {
  let touched = false;
  const walk = (list: OutlineNode[]): OutlineNode[] =>
    list.map((n) => {
      const kids = n.children?.length ? walk(n.children) : n.children;
      // Reverse lookup block by block: a node may match several blocks (in theory only one)
      for (const [blockId, text] of updates) {
        if (guard.isEcho(blockId)) continue;
        if (blockToNode.get(blockId) !== n.id) continue;
        const plain = plainNodeText(n.text);
        if (plain === text) continue;
        touched = true;
        return {
          ...n,
          text: text ? `<span>${escapeHtml(text)}</span>` : '',
          modified: Date.now(),
          children: kids,
        };
      }
      return kids === n.children ? n : { ...n, children: kids };
    });

  const next = walk(nodes);
  return touched ? next : null;
}

/** Replace the text by node ID and return a new tree (an immutable update, so React cannot miss a render) */
function mapNodes(nodes: OutlineNode[], id: string, text: string): OutlineNode[] {
  return nodes.map((n) => {
    if (n.id === id) {
      // What comes down is plain text; here it is wrapped in a span per the export convention
      return { ...n, text: text ? `<span>${escapeHtml(text)}</span>` : '', modified: Date.now() };
    }
    if (n.children?.length) {
      const kids = mapNodes(n.children, id, text);
      return kids === n.children ? n : { ...n, children: kids };
    }
    return n;
  });
}

