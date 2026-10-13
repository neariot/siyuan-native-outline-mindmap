# Modularity & Refactoring Roadmap

> Detailed technical roadmap for future structural consolidation across large modules.

## 1. Large File Footprints

The three largest files in the repository represent the primary targets for gradual modularization:
- `Outliner.tsx` 4,642 lines
- `store.ts` 3,255 lines
- `mount.ts` 2,353 lines

*(Measured and monitored by `scripts/check-todo-counts.py` to prevent untracked code bloat).*

The objective is not arbitrary file splitting, but eliminating duplicate domain concepts so single invariants have a single home.

---

## 2. Refactoring Candidates

Candidates ordered by the risk of behavioral divergence:

### 2.1 Safety Rules Unification
- **Current state**: Deletion guards live in `store.ts` (determining which blocks may safely be deleted without erasing external additions), while write-back ordering and loop-prevention rules live in `mount.ts` (`withEchoGuard`).
- **Goal**: Consolidate safety invariants into a cohesive document mutation controller so write-ordering and deletion-safety share a unified transaction lifecycle.

### 2.2 ID Set Collectors
- **Current state**: Two separate walks collect node ID sets: `mount.ts` collects baseline IDs for echo filtering, while `store.ts` collects alive IDs for pruning checks.
- **Goal**: Deduplicate into a single shared utility in `model/tree.ts` the next time either file is modified.

### 2.3 State-Carrying Tree Walks
- **Current state**: Three specialized tree walks exist:
  - `store.ts`: `collect` in the move planner (accumulates `parentId`).
  - `Outliner.tsx`: `walk` in export routines (accumulates `depth`).
  - `core/layout.ts`: label builder (accumulates hierarchical prefix strings).
- **Goal**: When a new caller requires stateful tree descent, extract a generic callback-driven higher-order traversal rather than writing a fourth copy.

### 2.4 Host Abstraction Layer (HAL) Convergence
- **Current state**: The pure mathematical Tree Reconciler (`src/core/reconciler.ts`) and Host Driver SPI (`src/siyuan/host-driver.ts`, `native-driver.ts`, `virtual-driver.ts`) are built and unit-tested offline. The runtime write-back currently runs through `store.ts`'s internal mutation methods.
- **Goal**: Progressively wire `NativeHostDriver` and `TreeReconciler` into `mount.ts` and `store.ts`, replacing procedural mutation sequences with atomic diff patches.
- **Detailed Plan**: See [`docs/todo/hal-convergence.md`](hal-convergence.md) for the 3-phase execution roadmap.
