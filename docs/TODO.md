# TODO

The single front door for **what is left to do**. `docs/AUDIT-FINDINGS.md` is one of its inputs, not the whole answer: that file carries the findings of one whole-repository review, while work also arrives from reports, from measurements, and from features deliberately deferred.

Keep this file **short**. It is a list of what somebody should do next, not an archive: an item leaves by being done, by being refuted in writing, or by being moved into `docs/AUDIT-FINDINGS.md` when it is an audit finding.

---

## 1. Current Status: Active Queues are Clean

As of 2026-10-13, all primary defect queues are **0 open**:
- **Defect queue (`Now`)**: 0 open items (all previously tracked defects have been resolved and verified).
- **Tooling gaps queue**: 0 open items (all automated test & gate gaps resolved).
- **Audit queue (`docs/AUDIT-FINDINGS.md`)**: 0 open of 193 entries (all 193 struck and verified).

Historical notes on resolved defects, retargeted citations (e.g. from `.logs/API-GOTCHAS.md` to `docs/kernel-api.md`), and fixed audit findings are committed in git history, `docs/AUDIT-FINDINGS.md`, and `docs/pitfalls/`.

---

## 2. Modularity & Refactoring Roadmap

These are candidates for future structural consolidation rather than defect fixes. Take each candidate the next time the respective file is touched:

- **Large file footprints**:
  - `Outliner.tsx` 4,642 lines, `store.ts` 3,255, `mount.ts` 2,353 (measured; checked by `scripts/check-todo-counts.py`).
- **Safety rules**:
  - Unify deletion guards in `store.ts` (which nodes may be removed) with write-back ordering rules in `mount.ts`.
- **ID set collectors**:
  - Deduplicate ID set collection across `mount.ts` (baseline IDs) and `store.ts` (alive IDs).
- **State-carrying tree walks**:
  - `store.ts` (`collect` in move planner carrying `parentId`), `Outliner.tsx` (`walk` in export carrying `depth`), and `core/layout.ts` (label builder building strings). Consolidate if a third caller needs similar stateful traversal.
- **Host Abstraction Layer (HAL) Convergence**:
  - Progressively connect `IHostDriver` (`NativeHostDriver`, `VirtualHostDriver`) and `TreeReconciler` (`src/core/reconciler.ts`) into `mount.ts` and `store.ts` to replace manual write-back loops.

---

## 3. Deferred on Purpose

Recorded so context is preserved, with the engineering rationale:

- **Free positioning of mind-map nodes**:
  Dragging a node to blank canvas space is a no-op; the node returns to its auto-layout position. Deferred until there is concrete demand (`docs/MAPPING.md` §0.1).
- **Exact sibling ordering in mind-map canvas**:
  Mind map drag has a single parent-attachment zone; exact sibling reordering is an outline editor feature. Deliberate design (`docs/MAPPING.md` §0.1).

---

## 4. Maintenance & Verification

- `python3 scripts/check-audit-findings.py`: Asserts every audit finding in `docs/AUDIT-FINDINGS.md` resolves to live code.
- `python3 scripts/check-todo-counts.py`: Asserts stated file line counts match tracked files on disk.
- `python3 scripts/check-citations.py`: Asserts tracked docs do not cite untracked development diaries.
