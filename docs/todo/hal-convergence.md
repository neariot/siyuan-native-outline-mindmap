# Host Abstraction Layer (HAL) Convergence Plan

> Actionable execution plan for wiring `IHostDriver` and `TreeReconciler` into the live runtime path (`mount.ts` and `store.ts`).

## 1. Context & Objectives

- **Current State**:
  - Pure mathematical Tree Reconciler (`src/core/reconciler.ts`) and Host Driver SPI (`src/siyuan/host-driver.ts`, `native-driver.ts`, `virtual-driver.ts`) are implemented and pass unit tests (18/18 and 16/16).
  - Reconciler performance is verified at 54 µs per diff+apply on a 28-node tree.
  - `src/siyuan/native-driver.ts` is currently on the `scripts/check-unreachable-modules.ts` allowlist because no production module imports it yet.
  - Write-back in `src/plugin/mount.ts` (`writeLatest`) directly calls procedural methods on `SiYuanStore` (`syncNumbering`, `syncStructure`, `syncDeletions`, `saveNodesIncremental`).
- **Goal**:
  - Incrementally wire `NativeHostDriver` into `mount.ts`.
  - Replace manual write-back loops with declarative `diffTrees(baseline, current)` and `driver.applyPatches(docId, patches)`.
  - Remove `src/siyuan/native-driver.ts` from the `check-unreachable-modules.ts` allowlist as it becomes live runtime code.
  - Ensure zero regression across all 31 fast gates and the E2E suite (`npm run test:e2e`).

---

## 2. Phased Implementation Steps

### Phase 1: Initialize `NativeHostDriver` in `mount.ts`

1. **Import and instantiate driver**:
   - In `src/plugin/mount.ts`:
     ```ts
     import { NativeHostDriver } from '../siyuan/native-driver';
     import type { IHostDriver } from '../siyuan/host-driver';
     ```
   - Add a ref in `OmTabApp`:
     ```ts
     const driverRef = React.useRef<IHostDriver | null>(null);
     ```
   - In `loadDoc` (around line 681 where `storeRef.current` is instantiated):
     ```ts
     const store = new SiYuanStore({ client, notebook: '', basePath: '/' });
     storeRef.current = store;
     driverRef.current = new NativeHostDriver({
       client,
       store,
       plugin,
       eventBus,
     });
     ```
2. **Wire block navigation through driver**:
   - In `handleJumpToDoc` (around line 380 in `mount.ts`):
     - Replace manual `openTab` and `getHostApp` lookups with `await driverRef.current?.openBlock(target)`.
3. **Retire allowlist entry in `check-unreachable-modules.ts`**:
   - Once `mount.ts` imports `native-driver.ts`, remove `'src/siyuan/native-driver.ts'` from `ALLOWED` in `scripts/check-unreachable-modules.ts`.
   - Run `npx tsx scripts/check-unreachable-modules.ts` to verify the gate remains green without the allowlist entry.

---

### Phase 2: Connect Reconciler & Declarative Patching to `writeLatest`

1. **Compute minimal patches before write-back**:
   - In `src/plugin/mount.ts` (`writeLatest` enqueue task, around line 609):
     ```ts
     import { diffTrees } from '../core/reconciler';
     ```
   - Instead of checking `structureFingerprint(tree)` and manually calling 4 store methods, compute:
     ```ts
     const baseline = lastCommittedRef.current ?? [];
     const patches = diffTrees(baseline, tree);
     ```
2. **Execute atomic patch application via driver**:
   - Delegate to driver:
     ```ts
     if (patches.length > 0) {
       const syncResult = await driverRef.current?.applyPatches(docIdNow, patches);
       if (!syncResult?.success) {
         throw new Error(syncResult?.error || 'Failed to apply patches to host');
       }
     }
     ```
   - `NativeHostDriver.applyPatches` already wraps `beginWrite`, `syncNumbering`, `syncStructure`, `syncDeletions`, `saveNodesIncremental`, and `endWrite` in `try...finally`.
3. **Loop-Guard and Baseline Synchronization**:
   - Ensure `guardRef.current.noteWrittenValues(collectWrittenValues(tree))` continues to register values before patch execution to prevent false echo conflicts.
   - Update `lastCommittedRef.current = snapshot(tree)` upon successful patch application.

---

### Phase 3: Unify Active Document Observation

1. **Delegate dock mode observation to driver**:
   - In `src/plugin/mount.ts` dock effect (around lines 137–170):
     - Replace the custom `switch-protyle` listener and `requestAnimationFrame(read)` with:
       ```ts
       const driver = driverRef.current;
       if (driver) {
         return driver.observeActiveDocId((id) => {
           setActiveDoc(id);
           if (id) setDocResolved(true);
         });
       }
       ```
   - `NativeHostDriver.observeActiveDocId` already inspects `event.detail.protyle.block.rootID` first before falling back to frame-scheduled DOM layout inspection.

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
