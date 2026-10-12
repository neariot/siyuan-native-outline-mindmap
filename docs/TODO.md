# TODO

The single front door for **what is left to do**. `docs/AUDIT-FINDINGS.md` is one of its inputs, not the
whole answer: that file carries the findings of one whole-repository review, while work also arrives from
reports, from measurements, and from features deliberately deferred.

Keep this file **short**. It is a list of what somebody should do next, not an archive: an item leaves by
being done, by being refuted in writing (with the reasoning, below), or by being moved into
`docs/AUDIT-FINDINGS.md` when it is really an audit finding.

## Now

Ordered by what a user would notice. These are verified against the code as it stands, not copied from a
report. **Nothing is queued here right now** —— the five defects that stood here are all resolved (below),
and the next work is the tooling gaps and the modularity list, which are the honest "what is left".

The list is kept, empty, on purpose: the next defect that survives verification goes at the top, and an empty
section is a fact worth stating rather than a section to delete and re-invent.

**Resolved, verified, and removed from the queue:**

| Was | How it was checked |
|---|---|
| **Heading levels could never persist from either entry point** | Removed rather than fixed: a node is always a list item and SiYuan takes a level only from a non-list line, so the H1/H2/H3/¶ buttons, the `# ` + space shortcut and their docs are gone. `OutlineNode.heading` and the reader/writer stay, because a hand-written `# H1` really does round-trip (measured). `docs/pitfalls/data.md` |
| **A structural edit was silently dropped when the next key arrived too soon** (reported as "tab demote does not sync", then "it works probabilistically") | `serializeTree` —— the evidence behind the write-coalescing check —— emitted a flat `id:text` list with no nesting, so `甲\|乙\|丙` and `甲(乙)\|丙` compared **equal** and the catch-up write was skipped. Parentheses around each node's children now encode the shape. Case shown red with the markers removed: back-to-back fails, paused passes —— the reported asymmetry exactly (`e2e/struct-sync.spec.ts`). ★ **Re-verified later with the build deployed**, because the fix has to survive the code moving around it: removing the two "(" / ")" pushes makes `Shift+Tab then Tab, pressed back to back` fail (26.6s) while `a pause between the same two keys` passes (8.2s), and restoring them gives 3/3 green —— the same fast-broken / paused-fine split the report described |
| **A stray `placeholder` list item could survive an indent** | The kernel forces a dummy item while the intermediate `List` is created (an empty `List` is invisible to `moveBlock`, which then answers `code: 0` and does nothing). It was registered in the store's instance field while cleanup deleted from the caller's set, so with two write-backs in flight the wrong set was cleaned. The scope is now required and caller-owned —— a missing one is a compile error. Case shown red: `Expected substring: not "placeholder"` |
| A title containing `<` or `>` lost those characters in the map **and** the PNG | Fixed with the shared `escapeHtml`; regression case shown red (`Expected "E2E-角度<T>-测试"`, `Received "E2E-角度-测试"`) |
| The keyboard went dead after a context-menu command | `focusCanvas()` on the five affected items; case shown red twice (`activeElement` was `BODY`) |
| `record-demo.py`'s document guard was wrong in both directions | It accepted `--doc None` and refused a real id containing n-o-n-e; now tests the precondition |
| `TARGET=plugin npm run build` in `README.zh-CN.md` | The flag no longer exists in any README |
| Two i18n entries rendered wrong | **Refuted** —— the keys are in neither catalogue and `npm run i18n` is green |

Verified as a whole: the full E2E suite passed **112/112 in 14.6m** at load 1.2 with all five changes in
the build, and every gate is green.

★ **The two silent-loss defects above are the same failure shape, and it is worth naming.** Both dropped a
structural edit while every layer reported success:

- the write-coalescing check asked *"did the tree change?"* with a criterion that **could not see the
  change** (flat list, no nesting) —— the third time that function was fixed by adding a *field* rather
  than by encoding the *shape*;
- the placeholder was registered in one set and deleted from another, so the cleanup ran successfully on
  the wrong collection.

Neither raised anything, and in the second case the visible symptom (a stray `placeholder` line) looked
like the feature working as designed. `docs/pitfalls/testing.md` carries both, because the lesson is about
criteria rather than about trees: **a check that cannot distinguish the failure from the success is worse
than no check**, and it is what `docs/pitfalls/` exists to collect.

**A measured gap in "the target document was deleted" (needs a decision, not a substring):**

- **`isTargetGoneError` misses the message the kernel returns for the first second after a deletion.**
  Measured on the isolated instance by deleting a document and writing to it: `updateBlock` answers
  `load block tree [<id>] failed: indexing` at t=0, and `... failed: tree not found` from about t=1s on.
  Only `tree not found` (and `parent block not found` / `block not found`) are recognised, so a write landing
  in that window is shown as a raw kernel message rather than "the document was deleted" —— and **the
  recovery button does not appear**, which is the silent-failure shape the fix exists to remove.
  Pinned as a check in `src/plugin/target-gone.test.ts` that asserts today's behaviour and says so.

  ★ Why it is not simply added to the list of substrings: `indexing` is also what a **freshly inserted
  block** reports while the SQL index lags (this repository has a whole section on that lag), so accepting it
  unconditionally would make an ordinary write-back look like a deleted document —— the exact false positive
  `isTargetGoneError`'s own doc comment records ("the document was alive and well, only a child block ID was
  stale, and the user thought the document was lost"). The honest criterion confirms **the document's own ID**
  is gone, which is a query rather than a string test, and that is a design decision to make deliberately.

- **A second measured detail, recorded because it misled a test attempt:** deleting the document currently
  open in SiYuan makes SiYuan **navigate to another document**, and the panel correctly follows it — so the
  write-back then succeeds against the new target instead of failing. Reproducing "the target is gone" from an
  E2E case is therefore not as simple as deleting the open document; the criterion is better unit-tested (it
  is), and an E2E case needs the document to disappear **without** the editor switching away.

**Tooling gaps (continued):**

- **The 9 uncalled store methods still need a pass.** `python3 scripts/check-dead-methods.py`
  reports them on every `npm run check` (the gate is now **strict**: it fails when one of them claims a
  capability, which `saveNodes` did):

  src/siyuan/api.ts:136  moveDocs
  src/siyuan/api.ts:519  getBlockAttrs
  src/siyuan/api.ts:524  setBlockAttrs
  src/siyuan/api.ts:591  listNotebooks
  src/siyuan/api.ts:595  createNotebook
  src/siyuan/store.ts:352  listDocs
  src/siyuan/store.ts:467  loadNodes
  src/siyuan/store.ts:2823  searchNodes
  src/siyuan/store.ts:2845  listFolders

  Each needs one of three answers: delete it, keep it with a comment saying who calls it from outside the
  repository, or wire it up —— and the last is only right if something actually needs it.
  (`saveNodes` was the one that misled: the only writer emitting `# ` for a heading, called from nowhere,
  and while it existed the H1 buttons looked supportable. Deleted. `treeToKramdown` was its companion and
  **stays** on purpose —— documented at the function, because it is the writer half of a tested round-trip
  and of the "no `custom-*` attributes" portability guarantee.)

  ★ Two methods left this list without being deleted, and both were **false positives in the checker**:
  `moveNodes` (private, called only from `syncStructure` in the same file —— the declaring file was not
  being scanned) and `setHeadingTitle` (called as `store?.setHeadingTitle(...)`, and the pattern required a
  plain identifier before the dot, so optional chaining hid the call). This codebase uses `store?.`
  heavily, so the second gap was hiding real callers rather than hypothetical ones. Both are pinned: the
  scan includes the declaring file, and the pattern allows `?.`.

## Known gaps in our own tooling

Defects in how we check things, rather than in the product. Each one means a class of defect can reach a
release while every gate stays green.

- ~~`src/plugin/mindmap-reparent.test.ts` inspects source text~~ —— **done**: the file and fourteen
  others of the same shape were deleted, and the cycle rule it claimed to cover is now an E2E case
  (`e2e/mindmap.spec.ts`, "dropping a node into its own subtree is refused"), shown red with the guard
  disabled. A gate (`check-source-text-tests.py`) stops the shape returning.
- **`scripts/check-vacuous-tests.py` cannot see the "block appended below the summary / `process.exit`"
  shape** —— a test file whose new checks run *after* the pass/fail line and the exit, so they can never
  fail the run. That shape was hit for real while adding the chain-descent checks.
- **The outline's drag-and-drop reorder has no E2E case for its three zones at the range level**
  (the 25% / 75% boundaries are unit-tested, and all three zones are now covered end-to-end —— what is
  missing is a case for the *boundary* values themselves).

## Modularity

The three big files are the obstacle: `Outliner.tsx` 4,686 lines, `store.ts` 2,982, `mount.ts` 2,352. The
work is not "split them up" but "stop the same idea being written twice", so each pass removes a
duplication rather than moving lines.

- **Done: the depth-first flatten.** Five copies existed —— two in `mount.ts`, two in `store.ts`, one
  private to `core/map.ts`. Measured equivalent on a chain, a wide tree, an empty list, a node with no
  `children` key and a five-deep chain, so consolidation needed no judgement. Now one `flatNodes` in
  `model/tree.ts`, with the equivalence pinned by unit cases.
- **Next candidates**, by how much a divergence would hurt rather than by size:
  - **Safety rules**, because two copies of one of these already disagreed once (the cycle guard, merged
    earlier). Look for: the deletion guards in `store.ts` (which nodes may be removed), and the
    write-back ordering rules in `mount.ts`.
  - **The id-`Set` collector** —— two copies (`mount.ts` baseline ids, `store.ts` alive ids). Small, but
    the same shape; fold it in the next time either file is touched.
  - **The state-carrying walks** (`store.ts:2027` carries `parentId`, `Outliner.tsx:1758` carries `depth`,
    `core/layout.ts:954` builds a string). These are *not* the same function, so they stay until a third
    caller wants the same extra state —— then the shared version takes the state as a callback.

- **Done: the shared escape/decode module.** Five site-local variants across three files; consolidating
  them exposed a real defect —— `model/tree.ts` decoded `&amp;` before the entities it can create, so a
  user's literal `&nbsp;` was displayed as a space. Pinned with a case that fails on the wrong order.
- **Done: an undo baseline that could be one edit stale.** `flushWrite` recorded its argument while
  `writeLatest()` writes `nodesRef.current`. The other six writes of that ref were checked and are correct.
- **Done: a performance self-test that was measuring the machine.** It failed at 2.29x on a loaded box; the
  linear sample was below `performance.now()`'s resolution, so its ratio was noise. n=6000 + a heavier
  linear body, and a sub-resolution sample is now its own failure.
- **Done: an E2E error message that blamed the plugin for a loaded machine.**
  Verified: the full suite passed **110/110 in 14.0m** at load 1.2, including all four cases that had
  failed at load 5.3 —— the same build, so the load was the whole difference. Measured both ways on one
  commit (46.7s failing / 11.6s passing), and `run-e2e.py` now warns about the load before any case runs.

- **`src/plugin/mindmap-focus.test.ts` pinned a *number* instead of a behaviour.** Its check read
  `callSites(src, /^focusCanvas$/).length === 4` —— "the restore is not called from anywhere unexpected
  (4 close paths)". Adding `focusCanvas()` to the six context-menu actions that needed it (the keyboard was
  dead after every one of them) made that count 10, so the test went **red for a fix**. A count of call sites
  cannot tell "unexpected new caller" from "more callers are now correct", and it never looked at whether
  focus actually returned. **Resolved by deletion**: `e2e/keyboard.spec.ts` drives the real menu, asserts on
  `document.activeElement`, and then presses Tab to prove the keyboard works rather than merely that focus is
  set. Two remaining uses of the same shape (a pinned call-site count) are worth auditing.

## Refuted / already resolved

The audit's own contract is "an entry leaves it by being fixed, **or by being refuted in writing**". The
first half leaves a commit behind; the second left nothing, so this section is where that writing goes.
These have been **removed** from `docs/AUDIT-FINDINGS.md` (whose header records the count), and the file
was trimmed from 209 entries to 206 by this pass.

★ Found by `python3 scripts/check-audit-findings.py`, which is now a gate: five entries pointed at a place
  that no longer existed —— two files deleted, three files shrunk past the citation. A queue whose
  citations have rotted is a queue nobody can act on, and nothing had noticed.

- **Fifteen test files that asserted on the text of product source** (most of them flagged by the audit as
  `test-quality`). **Resolved by deletion.** None imported the product, so none could execute it; every
  check was a string match on a `.tsx`/`.ts` file, which goes red when the product is *reworded* rather
  than when it breaks. Measured: merging two hand-written cycle guards into one shared helper broke
  `mindmap-reparent.test.ts` while the behaviour was identical and every E2E case passed. The two rules
  worth keeping are now E2E cases (the cycle refusal, above) or covered by the existing suites. The 12
  ledger entries that named these files left with them.

- **`src/plugin/kernel-bugs.test.ts` ran every case against a local stand-in of the kernel** (medium ·
  test-quality). **Resolved:** the file was deleted by `c7e1de8` and replaced by
  `src/siyuan/blockmap-anchor.test.ts`, which drives the mapping the write-back actually depends on.
- **`src/plugin/panel-escape-focus.test.ts` compared two byte-identical hardcoded arrays** (medium ·
  test-quality). **Resolved:** deleted by `7e8c64b`, and the focus behaviour it was meant to cover now lives
  in `e2e/keyboard.spec.ts` —— see the note below on why `mindmap-focus.test.ts` went too.
- **`src/plugin/kernel-side-effects.test.ts` asserted against literals it defined itself.** **Resolved:**
  rewritten —— the file's header now records the old defect and states the plugin discipline it holds
  instead.
- **`scripts/env.py` did not strip quotes around a value** so a quoted path kept its quote characters, and
  the docstring claimed quotes and comments were supported (medium · bug). **Resolved:** `env.py` now strips
  matched quotes and treats a `#` inside quotes as data, with the unquoted ` #` comment rule separate.
- **`blockmap-namespace.test.ts`'s "SQL wins" check could not fail** —— the stale entry was registered
  under key `N1` while the assertion read key `L1`, which the row loop set unconditionally (low ·
  test-quality). **Resolved:** neither key exists in the file any more; the test was rewritten.
- **`mindmap-reparent.test.ts`'s check was named for a behaviour it never tested** (low · test-quality).
  **Still open, re-stated:** the entry's citation was 11 lines past the end of the file. The check asserts
  the handler's **source text** contains `tgt !== src` and `'__root__'`, so it goes red only when those
  characters are rewritten. Moved into "Known gaps in our own tooling" above, where the rest of that file's
  text-vs-behaviour problem already lives.
- **`Outliner.tsx`'s `handleMentionClick` was exported but never called** (low · dead-code). **Resolved:**
  the symbol is gone from the tree —— 0 references anywhere.

## Deferred on purpose

Recorded so it is not lost, with the reason it is not being done.

- **Free positioning of mind-map nodes.** Dragging a node to blank space is a no-op and the node returns to
  its layout-computed place. "Leave it where I dropped it" was considered and **deferred until there is real
  demand** —— positions are computed by `layoutHorizontal` / `layoutOrg`, and the node model carries no
  per-node coordinate, so the feature needs a position field, its serialization and its interaction with the
  auto-layout. `docs/MAPPING.md` §0.1 records the decision.
- **Exact sibling order is an outline edit, not a mind-map one.** The map's drop has one zone; the outline
  has three. Deliberate, recorded in `docs/MAPPING.md` §0.1.

## How this file is kept honest

- `python3 scripts/check-audit-findings.py` reports every audit citation that no longer resolves
  (`stale-file`, `stale-line`), that has drifted away from the finding's own identifiers (`drifted`), or
  that names no symbol at all (`cannot-judge` —— the ones a reader must open first). It cannot tell whether
  a defect is *fixed*; that needs a person, and the tool says so rather than guessing.
- A finding that leaves `docs/AUDIT-FINDINGS.md` lands here first, in "Refuted / already resolved", with the
  commit that did it.
