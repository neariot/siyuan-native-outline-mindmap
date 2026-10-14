# TODO

The single front door for **what is left to do**. `docs/AUDIT-FINDINGS.md` is one of its inputs, not the whole answer: that file carries the findings of one whole-repository review, while work also arrives from reports, from measurements, and from features deliberately deferred.

Keep this file **short**. It is an index of what somebody should do next, not an archive: detailed topic backlogs live in dedicated sub-files under `docs/todo/`.

---

## 1. Current Status: Active Queues are Clean

As of 2026-10-13, all primary defect queues are **0 open**:
- **Defect queue (`Now`)**: 0 open items (all previously tracked defects have been resolved and verified).
- **Tooling gaps queue**: 0 open items (all automated test & gate gaps resolved).
- **Audit queue (`docs/AUDIT-FINDINGS.md`)**: 0 open of 193 entries (all 193 struck and verified).

One item from the inline-markup audit of 2026-10-14 is still open and is tracked in its
topic file: **tables cannot live in a node** (a SiYuan table is its own block, and the node
model has no such kind yet). The insert-table entry point says so instead of corrupting a
node; the design and the measurements are in `docs/todo/inline-markup-sync.md` §D9.

Historical notes on resolved defects, retargeted citations (e.g. from `.logs/API-GOTCHAS.md` to `docs/kernel-api.md`), and fixed audit findings are committed in git history, `docs/AUDIT-FINDINGS.md`, and `docs/pitfalls/`.

---

## 2. Topic Sub-Files

Detailed backlogs and architectural notes are divided into topic sub-files:

| Topic | Document | Contents |
|---|---|---|
| **HAL Convergence** | [`docs/todo/hal-convergence.md`](todo/hal-convergence.md) | Phased execution plan for wiring `IHostDriver` and `TreeReconciler` into `mount.ts` and `store.ts` |
| **Modularity & Refactoring** | [`docs/todo/modularity.md`](todo/modularity.md) | File footprints (`Outliner.tsx`, `store.ts`, `mount.ts`), safety rule unification, stateful tree walks |
| **Deferred Features** | [`docs/todo/deferred.md`](todo/deferred.md) | Technical rationales and constraints for deliberately deferred features (free positioning, sibling ordering) |
| **Inline markup & toolbar sync** | [`docs/todo/inline-markup-sync.md`](todo/inline-markup-sync.md) | Measured write/read asymmetries that make formatting edits vanish or corrupt the document |

---

## 3. Maintenance & Verification Gates

- `python3 scripts/check-audit-findings.py`: Asserts every audit finding in `docs/AUDIT-FINDINGS.md` resolves to live code.
- `python3 scripts/check-todo-counts.py`: Asserts stated file line counts across documentation match tracked files on disk.
- `python3 scripts/check-citations.py`: Asserts tracked docs do not cite untracked development diaries.
