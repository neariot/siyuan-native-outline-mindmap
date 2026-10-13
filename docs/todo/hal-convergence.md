# Host Abstraction Layer (HAL) Convergence Plan

> Actionable execution plan for wiring `IHostDriver` and `TreeReconciler` into the live runtime path (`mount.ts` and `store.ts`).

## 1. Context & Objectives

- **Current State**:
  - Pure mathematical Tree Reconciler (`src/core/reconciler.ts`) and Host Driver SPI (`src/siyuan/host-driver.ts`, `native-driver.ts`, `virtual-driver.ts`) are implemented and pass unit tests (18/18 and 16/16).
  - Reconciler performance is verified at 54 µs per diff+apply on a 28-node tree.
  - **`src/siyuan/native-driver.ts` is now live runtime code** (Phase 1, below): `mount.ts` constructs it and routes host navigation through it, and the module was removed from the `scripts/check-unreachable-modules.ts` allowlist.
  - Write-back in `src/plugin/mount.ts` (`writeLatest`) still directly calls procedural methods on `SiYuanStore` (`syncNumbering`, `syncStructure`, `syncDeletions`, `saveNodesIncremental`).
- **Goal**:
  - ~~Incrementally wire `NativeHostDriver` into `mount.ts`.~~ **Done for navigation (Phase 1).**
  - Replace manual write-back loops with declarative `diffTrees(baseline, current)` and `driver.applyPatches(docId, patches)`. **Blocked —— see §3.**
  - Ensure zero regression across all 31 fast gates and the E2E suite (`npm run test:e2e`).

---

## 2. Phased Implementation Steps

### Phase 1: Initialize `NativeHostDriver` in `mount.ts` — ✅ DONE

Delivered:
1. `mount.ts` imports `NativeHostDriver` / `IHostDriver` and holds `driverRef`.
2. The driver is constructed in `loadDoc`, beside `storeRef.current = new SiYuanStore(...)`, sharing the same
   `client` and `store` —— a driver built at mount would hold the previous document's store.
3. `openSiyuanRef` routes the jump through `driverRef.current?.openBlock(target)`.
4. `src/siyuan/native-driver.ts` was removed from the `ALLOWED` map in
   `scripts/check-unreachable-modules.ts`; the gate now reports 41 shipped modules and no stale entry.

The existence check (`SELECT … FROM blocks WHERE id = …`) and the user-visible guards stay in `mount.ts`:
the driver's `openBlock` is a silent no-op when the host app is unresolved, and a silent no-op cannot raise
`errRefTargetGone` / `errClientNotReady`.

★ `openTab` is passed to the driver **explicitly** rather than left to its `import('siyuan')` fallback: the
static import in `mount.ts` is the call the 2×2 experiment measured, and a dynamic import cannot be
exercised offline. The driver's local was also renamed `fn` → `openTab` so the static probe in
`src/plugin/ref-nav.test.ts` can still read the call site (that guard now reads `native-driver.ts`, where the
call lives).

Red proofs (both green → red → restored byte-identical):
- removing the `NativeHostDriver` import from `mount.ts` makes `unreachable-modules` report
  `native-driver.ts` as test-only (exit 1);
- replacing `app: appRef` with `app: this.plugin` in the driver makes `ref-nav.test.ts` fail.

---

### Phase 2: Connect Reconciler & Declarative Patching to `writeLatest` — ⛔ BLOCKED (measurably unsound as specified)

The step is **not** a safe substitution for `writeLatest` in its present form. Two independent defects were
measured with the repository's own `VirtualHostDriver` + `diffTrees` (probes under `.tmp/hal-wiring/`):

**(a) The patches are applied to a different tree than they were computed against.**
`NativeHostDriver.applyPatches` does `loadDoc(docId)` and applies the patches to **that** tree, while the plan
computes them as `diffTrees(lastCommittedRef, tree)` against the **UI** baseline. So the tree that reaches
SiYuan is "host state now, transformed by deltas from the UI baseline" —— not the UI tree. Measured:

```
UI wants order : a b new c
host == baseline    -> a b new c   ✅
anchor moved on host-> a b new c   (recovered by the re-read)
anchor deleted      -> a new c     ❌ `b` is gone and the delta no longer says what the UI holds
```

A stale anchor is the dangerous case: `applyTreePatches`' `insertInto` falls back to `push()` when the
previous-sibling id is absent, so a node is written **to the end of the list, silently**, with no error.
The existing pipeline is not exposed to this because it writes the *UI tree itself*, not a delta against it.

**(b) It drops the `structureFingerprint` skip.**
`writeLatest` runs `syncNumbering` / `syncStructure` / `syncDeletions` only when the structure fingerprint
changed, which is the measured fix for typing lag (240 nodes: 189 API calls, 180 the same
`SELECT … WHERE parent_id=? AND type='l'`, ≈3 s per character; 4 nodes: 11 calls / 291 ms —— see
`src/plugin/sync-fingerprint.test.ts`). A reconciler-driven path that always runs the three steps brings that
cost straight back.

**What would make this phase safe** (for whoever picks it up): define the contract as *"write exactly this
tree"* —— i.e. the driver re-reads the host document and diffs **against that read**, so the delta and the
tree it is applied to are one and the same; and keep the fingerprint skip, or replace it with an equivalent
"the structure really changed" precheck. Until then the procedural path stays.

---

### Phase 3: Unify Active Document Observation — ⛔ NOT SAFE as specified

Replacing `mount.ts`'s dock effect with `driver.observeActiveDocId` changes **which document** is read, in
split view. The dock effect (and `loadDoc`) deliberately go through `resolveActiveDocId()`, and the comment
there records the measured defect that shaped it: with two `.protyle` in a split, the editor "containing the
focused element" is the **just-opened** one, not the one the user is viewing —— the panel read the empty
document and reported "this document has no content yet".

The driver instead prefers `event.detail.protyle.block.rootID`, and SiYuan's own emitter documents the same
ambiguity: `switch-protyle` carries `options.protyle` —— the editor just switched to. The two sources can
disagree, so this is a behaviour change to the document the panel follows, not a refactor.

★ A corrected form would keep `resolveActiveDocId()` as the authority and use the event only as a
"re-read now" signal —— which is what the current effect already does. Do not wire this phase without a
split-view case that shows the two sources agreeing.

---

## 3. Verification & Safety Constraints

1. **Child Block Preservation**:
   - Ensure task-marker toggles still route through `updateTaskMarkerWithFallback` with the full `subtreeKramdown` (`nodeSubtreeToKramdown(n)`), strictly preserving child list items.
2. **Anti-Lag Deletion Gate**:
   - Do not bypass `isUnseenButOurs` or `freshlyInserted` exemptions in `store.ts` when executing deletion sync through the driver.
3. **Fast Gates Verification**:
   - Run `npm run check` after each phase:
     - All 31 gates must stay green.
     - `check-unreachable-modules.ts` must pass.
     - `check-todo-counts.py` must pass.
4. **E2E Browser Validation**:
   - Run affected E2E specs on the isolated instance:
     ```bash
     npm run test:e2e struct-sync
     npm run test:e2e keyboard
     npm run test:e2e outline
     ```
