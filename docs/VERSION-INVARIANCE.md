# Version Invariance Architecture

> Design and verification strategy ensuring zero-maintenance resilience across SiYuan upstream releases.

## 1. The Problem: Why Plugins Break Across SiYuan Updates

Most SiYuan plugins break after upstream updates because they couple to **volatile host implementation details**:

1. **Fragile DOM and Layout Assumptions**: Assuming a single `window.siyuan.layout.centerLayout` or specific CSS class names (`.layout__wnd--active`). When SiYuan introduces detached popout windows, moves tabs, or animates docks, layout trees shift and plugins fail to resolve the active document.
2. **Private JavaScript Internals**: Calling undocumented objects such as `window.siyuan.ws.app` or monkey-patching Protyle methods.
3. **Custom Attributes and Private Schemas**: Storing map topologies in `custom-*` block attributes or SQLite tables. When SiYuan rebuilds its indexer or changes block attribute handling, custom data gets desynchronized or corrupted.
4. **Markdown Re-parsing Drift**: Sending raw markdown through `/api/block/updateBlock` (`dataType=markdown`). Each Lute or CommonMark parser change upstream risks altering escaped characters, colors, or inline styles.

## 2. The Four Invariant Boundaries

To prevent version rot, this project enforces four explicit **invariant boundaries**:

```
┌─────────────────────────────────────────────────────────────┐
│                      Plugin Core                            │
│  (Outliner, Mindmap, Tree Model, Incremental Sync, Undo)    │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│  1. Data Carrier Invariant   │    │  2. Host Runtime Adapter     │
│  · d → l → i → p CommonMark  │    │  · Multi-root layout search  │
│  · Zero custom-* attributes  │    │  · data-initdata tab decode  │
│  · Invariant in treenode     │    │  · Official plugin.app seam  │
└──────────────────────────────┘    └──────────────────────────────┘
            │                                     │
            ▼                                     ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│  3. Wire Protocol Fallbacks  │    │  4. Upstream Drift Sentinels │
│  · dataType='dom' mutations  │    │  · treenode.CanContainBlock  │
│  · Task marker fallbacks     │    │  · check-kernel-shapes.py    │
│  · Loose ID error matching   │    │  · VirtualKernel test engine │
└──────────────────────────────┘    └──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   SiYuan Host / Kernel                      │
└─────────────────────────────────────────────────────────────┘
```

---

### Boundary 1: Native Data Carrier Invariance

All mind map and outline nodes map 1:1 to native SiYuan Protyle blocks:

```
NodeDocument (d) ──> NodeList (l) ──> NodeListItem (i) ──> NodeParagraph (p)
```

- **Enforced Upstream**: Defined in Go's `kernel/treenode/tree.go` (`CanContainBlock`). SiYuan cannot break this hierarchy without breaking its own document editor.
- **Zero Custom Attributes**: Custom attributes (`custom-*`) written by this plugin = **0**.
- **Lifecycle Independent**: If the plugin is uninstalled, all documents remain completely readable, searchable, and editable in SiYuan.

---

### Boundary 2: Host Runtime Adapter (`src/plugin/active-doc.ts` & `src/siyuan/host-compat.ts`)

Isolates layout tree and client instance variations:

- **Multi-Root Candidate Traversal**: Rather than assuming `centerLayout`, resolves active tabs across:
  1. `layout.centerLayout` (the standard desktop window)
  2. `layout.layout` (the root a detached/popout window uses)
  3. Any dynamic child layouts

  ★ The second root is not a new field —— both are declared in `app/src/types/index.d.ts` at **v3.0.0**
  (the earliest stable tag that has the file), so this is a *shape* difference between window modes, not a
  version boundary. An earlier version of this page dated it "introduced in 3.6+", which nothing supported.
- **Pre-Model `data-initdata` Extraction**: When tabs are lazy-loaded or during dock transitions where `tab.model` is not yet mounted, parses the Tab header's `data-initdata` attribute (`{ instance: "Editor", rootId: "..." }`). This matches upstream SiYuan's own resolution in `app/src/window/setHeader.ts`.
- **Official Seam Injection**: Resolves `(plugin as any).app` directly injected by SiYuan's plugin runtime before falling back to `window.siyuan.ws.app`.
- **Mobile Accessors**: Checks `mobile.editor`, `mobile.popEditor`, and `mobile.protyle`.
- **Zero Ambiguity**: Returns an empty string rather than guessing from DOM containers when focus is ambiguous.

---

### Boundary 3: Wire Protocol Invariance & Fallback Chains (`src/siyuan/api.ts`)

Normalizes communication with the SiYuan kernel:

- **Direct DOM Block Mutations**: Rich text writes use `dataType: 'dom'`, sending native Protyle DOM fragments directly to the kernel's block operator. This bypasses markdown parsing nuances entirely.
- **Graceful Capability Fallbacks**: an endpoint introduced in a specific kernel release (e.g.
  `/api/block/updateTaskListItemMarker`, first routed at **v3.6.4**) is guarded by a **version decision**
  — `supportsTaskMarkerApi` reads `/api/system/version` and compares it numerically against
  `TASK_MARKER_API_MIN_VERSION`, so a kernel known to predate the route goes straight to the markdown
  fallback instead of making a request destined to 404. ★ An unreadable or unparseable version is
  **attempted, not assumed absent** (`compareVersions` returns `null` and the call is made): the fallback
  is the data-losing path, so "cannot tell" must never select it. When the fallback runs it carries the
  node's **whole subtree**, because a marker-only markdown write replaces the listItem and drops its
  children (measured: marker API 1→1, subtree 1→1, node line only 1→**0**).
- **Tolerant Error Recognition**: `isTargetGoneError` requires the error text to name **this document's own
  ID** before it counts as "the document was deleted". The kernel has no stable error codes, so the text is
  matched — but the same wording is also produced by a stale *child* block, and treating that as a deleted
  document made the UI offer "save as a new document" to a user whose document was alive and well
  (measured: the flagged document had 25 blocks and answered `getBlockKramdown` normally).

---

### Boundary 4: Upstream Verification Sentinels & Virtual Kernel

Guarantees contract integrity without relying on manual checks. ★ **All three read a released tag, not the
working tree** —— `scripts/siyuan_tag.py` extracts the tag's own files from the local object store
(`git archive`, no checkout, no release download; `SIYUAN_TAG` pins one, otherwise the newest stable tag).
That matters because `SIYUAN_SRC` is often a fork or a feature branch: measured on this machine its HEAD is
in no release and differs from v3.8.6 by 8 lines in `kernel/api/router.go` and 127 in the generated contract
one of these reads.

1. **`check-block-rules.py`**: compiles and runs the kernel's own `treenode.CanContainBlock` (declared in
   `kernel/treenode/block_structure.go`) against the real `github.com/88250/lute/ast` types, so a
   containment claim in a comment is checked by the function the kernel calls rather than by a copy of it.
   It also scans the tag's route table for every `/api/...` path the product calls, and the kernel's own
   error strings the product matches on.
2. **`check-kernel-shapes.py`**: uses the TypeScript compiler API to verify that all wire shapes match the
   contract upstream generates into `app/src/types/api/index.d.ts`. (That file first appears at **v3.8.4**;
   a tag that predates it makes the check skip and say so rather than fall back to the tree.)
3. **`VirtualKernel` (`src/siyuan/virtual-kernel.ts`)**: emulates the kernel's DOM AST generation, Kramdown
   serialization, and transaction streaming offline. Runs full store integration suites in <300 ms without
   requiring a live Chromium instance. ★ Its field names and primitive kinds are checked against the
   generated contract by `check-kernel-shapes.py`, because a mirror that stands in for the real kernel is
   the one thing that cannot catch a drift in it.

---

## 5. Host Abstraction Layer (HAL) & Reconciler Architecture

For complete details on the pure mathematical Tree Reconciler and pluggable SPI drivers (`IHostDriver`, `NativeHostDriver`, `VirtualHostDriver`), see [HOST-ABSTRACTION-LAYER.md](HOST-ABSTRACTION-LAYER.md).

