# Architecture

> Updated: 2026-10-13 · Implementation: `src/` · Verification: the offline suites under
> `src/**/*.test.ts` plus the Playwright specs under `e2e/` — run them, do not count them here.

## 1. Positioning

Turning the outline and mind map editing experience into a native **SiYuan plugin**, with one core claim:

> **A node is a native SiYuan list block** — not JSON stuffed into some attribute.

Most mind map plugins serialize the whole map into a JSON string stored in a custom attribute (`custom-*`). The price is that SiYuan's **search, backlinks, outline, and block references** cannot see anything inside the mind map.

This plugin does the opposite:

```
Mind map / Outline node  ⇄  SiYuan list item (listItem) + paragraph
```

So search, bidirectional links, outline view, Markdown export, and mobile viewing **all work automatically** on the document's native Protyle blocks.

---

## 2. Layering & Abstraction Hierarchy

To guarantee resilience against SiYuan host updates and internal refactorings, the system is structured as a **4-tier decoupled hierarchy**:

> **Status: the HAL tiers are the target architecture, not yet the runtime path.** Tier 1 and the
> compatibility pieces of Tier 3 are live; the reconciler (Tier 2) and the two concrete drivers
> (Tier 4) are built and unit-tested but **no shipped module imports them** — the write-back still
> runs through `store.ts`'s own `syncStructure` / `syncDeletions` / `saveNodesIncremental`
> (section 4). Read the tiers below as the design the code is converging on, and section 4 as what
> runs today. The one place the runtime does negotiate a capability is the task-marker fallback
> (`host-compat.ts`), which picks the marker API or a subtree markdown write.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Tier 1: Domain & UI                             │
│     (Outliner editor, Mindmap SVG canvas, Tab App, Undo / Redo)        │
│          - Consumes and edits pure OutlineNode[] trees                 │
│          - Zero knowledge of REST, WebSockets, DOM, or SQL             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Tier 2: Mathematical Reconciler                       │
│                       (`src/core/reconciler.ts`)                       │
│   - diffTrees(baseline, target): TreePatch[]                           │
│   - applyTreePatches(tree, patches): OutlineNode[]                     │
│   - Pure functional diffing: Insert, Remove, Move, UpdateText,         │
│     UpdateParagraphs, SetTaskStatus, SetNumbering, SetHeading          │
│   - 100% deterministic, zero I/O, runs in sub-millisecond offline      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Tier 3: Host Driver SPI (HAL)                        │
│                       (`src/siyuan/host-driver.ts`)                    │
│   interface IHostDriver {                                              │
│     getCapabilities(): Promise<HostCapabilities>;                      │
│     loadDocument(docId: string): Promise<DocumentSnapshot>;            │
│     applyPatches(docId: string, patches: TreePatch[]): SyncResult;     │
│     observeActiveDocId(callback: (docId: string) => void): () => void; │
│     openBlock(blockId: string, options?: OpenOptions): Promise<void>;  │
│   }                                                                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │                                                   │
          ▼                                                   ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│  Tier 4a: NativeHostDriver           │  │  Tier 4b: VirtualHostDriver          │
│  (`src/siyuan/native-driver.ts`)     │  │  (`src/siyuan/virtual-driver.ts`)    │
│  - Live SiYuan Kernel & Host App     │  │  - In-Memory Virtual Kernel Engine   │
│  - Protyle event detail decoding     │  │  - Instant, zero-network unit tests  │
│  - Multi-version feature negotiation │  │  - Deterministic state validation    │
│  - Atomic block transactions         │  │  - Offline E2E simulation            │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 4c: Storage, Wire Mapping & Protocol Adapters                    │
│  - store.ts: Block ID mapping, anti-lag index sentinels, transactions  │
│  - api.ts: SiYuan kernel HTTP client                                   │
│  - map.ts & blockdom.ts: Kramdown parsing (read) & native DOM (write)  │
│  - host-compat.ts: Host version probing & layout adapter               │
└────────────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| File | Area | Responsibility |
|---|---|---|
| `core/reconciler.ts` | Tier 2 | ★ Pure mathematical diffing and patching (`TreePatch`) |
| `siyuan/host-driver.ts` | Tier 3 | Host Abstraction Layer (HAL) SPI interface |
| `siyuan/native-driver.ts` | Tier 4a | Production host driver connecting to live SiYuan |
| `siyuan/virtual-driver.ts` | Tier 4b | In-memory driver for offline simulation and tests |
| `core/map.ts` | Mapping | ★ Format mapping (pure logic, Kramdown → tree read) |
| `core/blockdom.ts` | Mapping | Node tree → SiYuan DOM (pure logic, write) |
| `core/layout.ts` | Layout | Mind map layout algorithm and geometric themes |
| `model/types.ts` | Model | Core data model (`OutlineNode`, `DocMeta`) |
| `model/tree.ts` | Model | Tree traversal, cycle guards, node manipulation |
| `siyuan/api.ts` | Storage | SiYuan kernel HTTP client |
| `siyuan/store.ts` | Storage | Document I/O, incremental writeback, anti-lag mapping |
| `siyuan/host-compat.ts` | Compat | Host App resolution, version probing, task marker fallback |
| `plugin/mount.ts` | UI | React mounting and interaction orchestration |
| `plugin/index.ts` | Plugin | Plugin entry lifecycle, dock, commands, slash menu |
| `plugin/outline/Outliner.tsx`| UI | Controlled outline tree editor |
| `mindmap/Mindmap.tsx` | UI | SVG mind map view |
| `plugin/sync.ts` | Sync | Two-way kernel transaction sync and loop prevention |
| `plugin/tree-ops.ts` | Ops | UI-level node manipulation primitives |

---

## 3. Data Flow

### 3.1 Read Path (SiYuan → Mind Map / Outliner)

```
SiYuan Kernel Document
  → IHostDriver.loadDocument(docId)
    → SiYuanStore.loadDoc(docId)
      → api.getBlockKramdown()
      → map.kramdownToTree()       ★ parse into OutlineNode[]
      → store.loadBlockMap(docId)  build reverse mapping table
  → DocumentSnapshot               carry nodes, title, paragraphs, blockMap
  → React View State               render in Outliner or Mindmap
```

### 3.2 Write Path (User Edit → SiYuan Kernel)

```
User Edit in UI (Typing, Indent, Move, Delete)
  → Draft Tree (OutlineNode[])
  → diffTrees(baseline, draft)     ★ Pure Tree Reconciler
  → TreePatch[] (insert, remove, move, updateText, setTaskStatus, setNumbering)
  → IHostDriver.applyPatches(docId, patches)
    → store.beginWrite(docId)      lock mapping snapshot
    → store.syncNumbering()        reconcile ordered/unordered list subtypes
    → store.syncStructure()        insert new nodes & reposition moved blocks
    → store.syncDeletions()        remove deleted blocks (safety gated)
    → store.saveNodesIncremental() update modified text via dataType='dom'
    → store.endWrite()
```

### 3.3 Incremental Strategy

**Never `updateBlock` the whole document** — that rebuilds every block ID, destroying references, bookmarks, and backlinks. Only altered blocks are touched, preserving block identities and external references.

---

## 4. Core Design Invariants

### 4.1 Native Data Carrier Invariance (`custom-* = 0`)

All data lives on SiYuan's **native carriers** strictly adhering to the Go kernel's `treenode.CanContainBlock` grammar:

```
NodeDocument (d) ──> NodeList (l) ──> NodeListItem (i) ──> NodeParagraph (p)
```

| Data | Native carrier | After uninstalling the plugin |
|---|---|---|
| Node identity | The `listItem`'s own block ID | ✅ Preserved |
| Node note | **Multiple paragraphs** under the listItem | ✅ Shown directly below the node |
| Todo | `- [ ]` / `- [x]` (`taskStatus`) | ✅ Native checkbox |
| Mirror / Ref | Native embed `{{(( docId ))}}` | ✅ Rendered directly |
| Rich text | Native inline markers + inline styles | ✅ Native typography |

Measured count of `custom-*` write points = **0**.

### 4.2 Mathematical Tree Reconciliation

By computing pure `TreePatch` diffs before mutating blocks:
- Structural edits (moves, reparenting, indents) are cleanly separated from text edits.
- Ancestral pruning ensures that removing a parent removes its entire subtree without redundant delete calls.
- Atomic subtree insertions ensure new nodes and their children are materialized cleanly.

### 4.3 Anti-Lag Deletion Safety Gate

The SQLite search index lags 1~3 seconds behind kernel memory updates:
- Blocks are only deleted if they were **previously observed in the live session and are now explicitly absent**.
- Freshly inserted blocks are tracked in an anti-lag exemption set (`freshlyInserted`) to prevent premature deletion.

### 4.4 Self-Healing Host Version Invariance

- Probes `/api/system/version` once and configures driver capabilities (`hasTaskMarkerApi`).
- Uses official SDK event payloads (`event.detail.protyle.block.rootID`) before falling back to multi-root layout DOM searches.
- Degrades gracefully across SiYuan versions without breaking user documents.

---

## 5. Rich Text & DOM Mutation Invariance

SiYuan inline rich text has two distinct write paths:
- `dataType=markdown`: parses through Lute; strips custom HTML styles and inline span attributes.
- `dataType=dom`: hands native DOM fragments directly to `PerformBlockOperation` with zero Lute re-parsing.

### Strategy: Direct Native DOM Path

```ts
updateBlockDom(htmlToSiyuanDom(html))     // dataType=dom
```

Every text edit writes native Protyle DOM directly, guaranteeing:
- Inline formatting (bold, italic, strikethrough, code, underline, mark) is preserved.
- Inline styles (colors, background highlights) stay intact.
- Nested spans are normalized into single tags (`<span strong style="...">`).
- Theme colors use SiYuan CSS variables (`var(--b3-font-colorN)`).

---

## 6. Two-Way Sync and Loop Prevention

`sync.ts` subscribes to the plugin's `ws-main` event and handles kernel `transactions` messages:
- **Listening only**: edit events pushed directly by the kernel provide the lowest latency with zero polling.
- **Loop Prevention**:
  1. `EchoGuard`'s `applying` flag drops events arriving during an active writeback.
  2. **Block ID Whitelist & Value Matching**: records recently written block IDs and values within a sliding window, correctly handling out-of-order WebSocket frames.
  3. Reverse lookup table (`blockToNode`) matches incoming transactions by block ID, overcoming the kernel's empty `rootID` in update operations.

---

## 7. Testing & Verification Strategy

The test suite enforces multi-tier defense:

1. **Pure Mathematical Unit Tests** (`reconciler.test.ts`, `tree.test.ts`, `map.test.ts`):
   - Fast, offline, deterministic tests asserting diff-patch identities and Kramdown conversions.
2. **Host Driver Simulation** (`driver.test.ts`, `virtual-kernel.test.ts`):
   - In-memory execution verifying capabilities, transaction processing, and block mapping without network I/O.
3. **Regression Tests**:
   - Each fixed pitfall has a corresponding unit regression test (e.g. `kernel-bugs.test.ts`, `echo-guard.test.ts`, `stale-mapping.test.ts`, `target-gone.test.ts`, `conflict-tracker.test.ts`).
4. **Fast Gates Suite (`npm run check`)**:
   - 26 static and runtime gates enforcing typechecking, 69 offline test suites, dead methods, language compliance, privacy audits, and CSS scope isolation.
5. **Browser E2E (`npm run test:e2e`)**:
   - Playwright suites running against an isolated test instance for desktop and mobile interactions.

---

## 8. Supported Scope & Boundaries

| Feature | Carrier / Status | Notes |
|---|---|---|
| Topic hierarchy | Native `NodeList` / `NodeListItem` | Indent / outdent / reparent / reorder |
| Body & Notes | Native `NodeParagraph` | First paragraph = title; subsequent = attached paragraphs |
| To-do checkboxes | Native task list marker (`- [ ]`, `- [x]`) | Checked state toggleable from both views |
| Math formulas | Native KaTeX syntax | Formula edit modal with live preview |
| Images | SiYuan asset storage (`assets/`) | Inline base64 pasted images automatically migrated |
| Summary / Link lines | Removed from model | SiYuan has no native block carrier; removed to prevent data loss |
