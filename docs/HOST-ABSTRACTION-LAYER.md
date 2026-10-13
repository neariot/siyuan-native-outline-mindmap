# Host Abstraction Layer (HAL) & Virtual Kernel Architecture

> Architectural specification for the zero-maintenance Host Abstraction Layer (HAL), pure mathematical Tree Reconciler, and pluggable SPI drivers.

> **Status: this is the target architecture, not the runtime path.** Read the tiers below as a design the
> code is being moved onto, not as a description of what runs today. Measured on this tree:
>
> * **Tier 2 is real and wired**: `diffTrees` / `applyTreePatches` in `src/core/reconciler.ts`.
> * **Tier 3 is not**: `IHostDriver` has two implementations (`native-driver.ts`, `virtual-driver.ts`) and
>   **nothing outside those files and their own tests imports them** —— `scripts/check-unreachable-modules.ts`
>   records them in its allowlist for exactly that reason. The write-back is still `store.ts`'s, driven
>   directly by `mount.ts`.
> * `store.ts` also carries the version-compat piece that *is* used (`host-compat.ts`), which is why that
>   one is not in the allowlist.
>
> `docs/ARCHITECTURE.md` §2 carries the same note; it is repeated here because this file is where a reader
> arrives when looking up the HAL, and it is the one most likely to be read as a description of the product.


## 1. Architectural Motivation

Plugins built for extensible document systems (such as SiYuan) typically suffer from architectural coupling:
- Direct DOM manipulation couplings (`.layout__wnd--active`, `.protyle-wysiwyg`).
- Host API version churn (REST endpoint additions/deprecations, parameter format drifts).
- Asynchronous index lag issues (SQLite indexes lagging 1~3 seconds behind in-memory AST mutations).
- Inability to execute deterministic automated tests without launching heavy browser environments.

To provide zero-maintenance resilience against host updates, this project adopts an OS-inspired **Virtual Filesystem (VFS) / React Fiber Reconciler** pattern.

---

## 2. The 4-Tier Abstraction Hierarchy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Tier 1: Domain & UI                             │
│     (Outliner, Mindmap Canvas, User Interactions, Undo / Redo)         │
│          - Consumes and emits pure OutlineNode[] trees                 │
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
│   - 100% deterministic, zero I/O; 54 µs per diff+apply (28-node        │
│     tree, 2000 runs, node 24, arm64)                                   │
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
```

---

## 3. Tier 2: The Pure Mathematical Tree Reconciler

The reconciler (`src/core/reconciler.ts`) computes discrete, minimal structural and content deltas between two tree snapshots:

```ts
export type TreePatch =
  | { type: 'insert'; node: OutlineNode; parentId: string | null; prevSiblingId: string | null }
  | { type: 'remove'; nodeId: string }
  | { type: 'move'; nodeId: string; parentId: string | null; prevSiblingId: string | null }
  | { type: 'updateText'; nodeId: string; text: string }
  | { type: 'updateParagraphs'; nodeId: string; paragraphs: string[] }
  | { type: 'setTaskStatus'; nodeId: string; taskStatus: number }
  | { type: 'setNumbering'; nodeId: string; numbered: boolean }
  | { type: 'setHeading'; nodeId: string; heading?: 0 | 1 | 2 | 3 | 4 | 5 | 6 };
```

### Invariants:
1. **Ancestral Pruning**: Removals are emitted only for highest unmapped ancestor nodes; children are pruned implicitly with the detached subtree.
2. **Subtree Atomic Insert**: Inserting a node with children carries the full subtree in a single patch.
3. **Round-Trip Mathematical Invariant**:
   ```ts
   applyTreePatches(baseline, diffTrees(baseline, target)) === target
   ```
4. **Zero Host Coupling**: Runs without browser DOM, Node runtime globals, or SiYuan kernel APIs.

---

## 4. Tier 3: Host Driver SPI (`IHostDriver`)

The driver SPI (`src/siyuan/host-driver.ts`) provides a unified polymorphic interface:

```ts
export interface HostCapabilities {
  kernelVersion: string;
  hasTaskMarkerApi: boolean;
  supportsDomBlockUpdate: boolean;
}

export interface DocumentSnapshot {
  docId: string;
  title: string;
  paragraphs: string[];
  nodes: OutlineNode[];
  blockMap: Map<string, string>;
}

export interface IHostDriver {
  getCapabilities(): Promise<HostCapabilities>;
  loadDocument(docId: string): Promise<DocumentSnapshot>;
  applyPatches(docId: string, patches: TreePatch[]): Promise<SyncResult>;
  observeActiveDocId(callback: (docId: string) => void): () => void;
  openBlock(blockId: string, options?: { zoomIn?: boolean }): Promise<void>;
}
```

---

## 5. Tier 4: Concrete Pluggable Drivers

### 4.1 NativeHostDriver (`src/siyuan/native-driver.ts`)
- **Version Negotiation**: Probes `/api/system/version` once and adapts feature flags (`hasTaskMarkerApi`).
- **Event Dispatching**: Decodes `switch-protyle` custom events directly from official SDK detail objects (`detail.protyle.block.rootID`), eliminating frame lag and DOM layout traversal.
- **Safe Navigation**: Resolves host App reference via `getHostApp` and delegates to `openTab` dynamically, allowing offline compilation without static host dependencies.

### 4.2 VirtualHostDriver (`src/siyuan/virtual-driver.ts`)
- **Pure Memory Engine**: Holds virtual documents, block maps, and active document state entirely in memory.
- **Instant Testing**: Executes diff-patch synchronization cycles in <1ms without network calls.
- **Flakiness Immunity**: Completely isolates automated test suites from external network delays or OS-level file locking.

---

## 6. Verification & Sentinels

The abstraction layer is protected by multi-level verification gates:
1. `src/core/reconciler.test.ts`: Mathematical properties, round trips, deep subtree mutations.
2. `src/siyuan/driver.test.ts`: Capability negotiation, patch application, event subscription, and navigation delegation.
3. `scripts/check.py`: Static analysis over unsaved fields, dead methods, language compliance, and API signatures.
