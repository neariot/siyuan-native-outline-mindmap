# 0.2.0

Minor release. A host-abstraction layer with version-invariant to-do handling, an end-to-end fix for
numbered (ordered) list nodes, and several synchronization-integrity fixes. Storage format and
configuration remain fully compatible with 0.1.9 — no migration, nothing to reconfigure.

## Key changes

### ★ Native to-do toggle survives old kernels without losing children
The task-marker fallback used to rewrite only the node's own line. Measured on the isolated instance, a
marker-only markdown write **drops the node's children** (`updateTaskListItemMarker` 1→1, subtree write
1→1, node-line write **1→0**). On a kernel without the native endpoint, toggling a to-do therefore deleted
everything indented under it. The fallback now rewrites the marker on the subtree's first line and writes
the **whole subtree**, and it refuses to write at all when it has no subtree rather than dropping children.
Which path is taken is now decided by the kernel version (see below), not by letting a write fail first.

### ★ Kernel version is compared numerically, and drives the feature path
Version detection used a string comparison, so `'3.9.0' >= '3.10.0'` was **true** — the comparison answers
the wrong question as soon as the threshold gains a two-digit component. It is now a numeric comparison,
and an unparseable version answers "attempt the call" rather than "the feature is absent", so an
unidentified kernel does not fall back to the expensive markdown path. The native task-marker endpoint's
introductory version was also measured against SiYuan's **official release tags** and corrected: it is
**3.6.4**, not the 3.1.0 the plugin had assumed — a kernel in 3.1.0–3.6.3 was being told it had the
endpoint and spent a round trip on a 404 before every to-do toggle.

### ★★ Numbered (ordered) list nodes work end to end
Numbered nodes were **dropped** on write-back: the emission path wrote every node as an unordered list
item, and neither `serializeTree` nor `structureFingerprint` counted the `numbered` flag, so a numbering
change was invisible to the write-back and the catch-up write was silently skipped. Numbering is now
emitted as `1.` (the kernel creates an ordered list), is part of both fingerprints, and is read back
through ordered markers. Toggling numbering on an **already-synced** node is handled by deleting and
reinserting it with the correct marker in the same pass, with the id-reuse race around that reinsert
verified against the insert response's own DOM. Covered by a dedicated E2E suite.

### ★ A fresh "save as new document" no longer loses its alignment
After `createDoc`, the new document's block alignment could be dropped: the DOM branch of the block-map
read did not retain just-created blocks, and the top-list query returned the **child** list instead of the
document's own list (an unqualified `LIMIT 1`), which misaligned the first node and lost the second and
third. Both halves are fixed and pinned by a regression test.

### ★ Newly created siblings are exempt from the "destroyed by this insert" probe
The kernel's SQL index flushes 200 ms–2.8 s after an insert while the probe's double-confirm waited only
200 ms, so a sibling this session had just created could be judged destroyed, its mapping cleared, and the
node re-inserted as a **duplicate**. Blocks created in this session are now skipped before the probe runs.

### ★ Mentions button hides itself instead of opening a dead end
The `@`-mention control offered an empty document list when the document set was empty, so clicking it
opened a panel with nothing in it. It is now hidden in that state.

## Under the hood

- **Host Abstraction Layer is partly live.** A Host Driver SPI now carries host navigation (opening a
  block or document reference), with a version-negotiated native implementation and an offline in-memory
  one used by the test suite. `src/siyuan/native-driver.ts` is no longer reachable-only-from-tests, and the
  gate that tracks such modules was updated accordingly.
- **A gate for unreachable modules.** A shipped module that only its own tests import is a green suite
  describing a feature nobody can use; `check-unreachable-modules.ts` now fails on one that is not a
  recorded decision, and on a stale allowlist entry.
- **A virtual kernel** for offline testing: the kernel's block-tree shapes, its asynchronous SQL-index lag,
  and its transaction responses are modelled so the sync and race cases run in milliseconds, with the
  mirror's field names checked against SiYuan's own generated TypeScript contract.
- The reconciler and the driver's *write* half are implemented and unit-tested but are **not** on the
  runtime write path; `docs/todo/hal-convergence.md` records the measurement that blocks that substitution.
