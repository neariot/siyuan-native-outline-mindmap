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
  1. `layout.centerLayout` (standard desktop window)
  2. `layout.layout` (detached popout window mode introduced in 3.6+)
  3. Any dynamic child layouts
- **Pre-Model `data-initdata` Extraction**: When tabs are lazy-loaded or during dock transitions where `tab.model` is not yet mounted, parses the Tab header's `data-initdata` attribute (`{ instance: "Editor", rootId: "..." }`). This matches upstream SiYuan's own resolution in `app/src/window/setHeader.ts`.
- **Official Seam Injection**: Resolves `(plugin as any).app` directly injected by SiYuan's plugin runtime before falling back to `window.siyuan.ws.app`.
- **Mobile Accessors**: Checks `mobile.editor`, `mobile.popEditor`, and `mobile.protyle`.
- **Zero Ambiguity**: Returns an empty string rather than guessing from DOM containers when focus is ambiguous.

---

### Boundary 3: Wire Protocol Invariance & Fallback Chains (`src/siyuan/api.ts`)

Normalizes communication with the SiYuan kernel:

- **Direct DOM Block Mutations**: Rich text writes use `dataType: 'dom'`, sending native Protyle DOM fragments directly to the kernel's block operator. This bypasses markdown parsing nuances entirely.
- **Graceful Capability Fallbacks**: When calling endpoints that were introduced in specific kernel releases (e.g. `/api/block/updateTaskListItemMarker`), automatically degrades to block updates if the endpoint is unavailable.
- **Tolerant Error Recognition**: `isTargetGoneError` checks for the document ID in the error payload rather than relying on exact, brittle error strings.

---

### Boundary 4: Upstream Verification Sentinels & Virtual Kernel

Guarantees contract integrity without relying on manual checks:

1. **`check-block-rules.py`**: Compiles and executes Go tests directly against `siyuan-src/kernel/treenode/tree.go` to verify block containment rules before release.
2. **`check-kernel-shapes.py`**: Uses the TypeScript compiler API to verify that all wire shapes match `siyuan-src/app/src/types/api/index.d.ts`.
3. **`VirtualKernel` (`src/siyuan/virtual-kernel.ts`)**: Emulates the kernel's DOM AST generation, Kramdown serialization, and transaction streaming offline. Runs full store integration suites in <300 ms without requiring a live Chromium instance.
