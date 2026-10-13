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

**Resolved, verified, and removed from the queue (numbering pass + audit finding, measured):**

- **`pruneDestroyedSiblings` probed freshly-inserted siblings.** The SQL index flushes 200ms~2.8s
  after insertBlock (measured), while the prune's double-confirm waits only 200ms — a sibling from
  the previous write-back missed both rounds while alive, losing its mapping and duplicating next
  pass. Fixed by skipping `freshlyInserted` blocks before any probe SQL (`prune-fresh.test.ts`,
  red-proofed; the assertion is on the probe SQL itself, since the retention would revive a cleared
  fresh mapping and hide the defect from a mapping assertion).

- **Numbering a node never reached SiYuan.** The toolbar `1.` button and the `1. ` shortcut set
  `numbered` with no text change, yet every write path emitted `- `. Fixed: `1. ` emission
  (`nodeToLine`/`walkNodesToLines`/`nodeInsertLine`), `num` in both gates (`serializeTree`,
  `structureFingerprint`), `\d+\.` in the task reader, `numbered` kept through multi-line paste
  (`pasteLineInfo`). Unit red 0/4 → 4/4; live kernel bytes create `l/o`; E2E green.
- **Toggling numbering on an already-synced node is converted in place.** The kernel has no
  in-place `u`↔`o` conversion (four avenues probed, all silent no-ops), so `syncNumbering`
  deletes + reinserts with the right marker in the same pass (`planNumberingConversion` skips
  tasks/task-lists/unmapped/fresh/unknown, pinned by `numbering-plan.test.ts`). E2E green.
- **Reuse-id inserts are verified against the insert response's own DOM.** Reusing a
  recently-deleted id races (clean back-to-back, mangled `1. <span…>` mid-window, fresh id late,
  once `-1`): `insertPreVerified` reads the new paragraph out of `op.data` synchronously and
  reinserts fresh on a mangled verdict (`insert-verdict.test.ts`, red-proofed).
- **A just-inserted block is not rewritten by the same pass's text sync.** `saveNodesIncremental`
  rewrote index-unknown blocks via the DOM path, downgrading `<span>乙</span>` to
  `<span data-type="text">乙</span>` on every reuse-insert (`no-rewrite-fresh.test.ts`, red-proofed).
- **Fresh-document alignment survived only half the path.** `refreshMapsAfterCreate` built the
  node-id→block-id alignment but (1) never registered its blocks as freshly-inserted, so the next
  `loadBlockMap`'s DOM branch dropped every entry, and (2) its top-list SQL picked whichever list
  flushed first — measured, the *child* list — misaligning n1 and dropping n2/n3, so every later
  write-back duplicated them. Fixed both; `refresh-align.test.ts` pins each half (both red-proofed).
- **Stale i18n finding closed without a change.** The `msgSummaryHint`/`msgSummaryTopLevel` encoding
  mismatch died with the summary feature (`9d06fda`); catalogue key sets are identical and a
  same-class scan is clean. The neighbouring literal-tooltip finding on the same lines was live
  (`title="Emoji"`), fixed with `tipEmoji` in both catalogues.
- **CDP errors dissolved into empty data.** `send()` dropped the CDP `error` member and `ev()`
  dropped `exceptionDetails` (in `cdp.py` and the `record-demo.py` copy), so broken probes passed
  caller sentinel checks as None. Both now raise; pinned by `cdp.py --selftest`.
- **Demo recording leaked its side effects on failure.** The repaint-nudge timer and screencast tab
  released only on success; now a `finally` stops the screencast, sends `NUDGE_OFF`, and closes the
  tab on every path. The placeholder-ownership finding (`store.ts:1929`) was already fixed — the
  instance field is gone, verified by grep.
- **Small script findings batch.** `token()` read failures now raise with path + cause (was: empty
  string → downstream 401); empty `PLUGIN_DIRS` fails loudly (was: deploy-nothing exit 0);
  misleading `plugin_dirs` docstring corrected; dead `test_build_url()` deleted; `verify-pkg.py`
  anchored at `__file__` (runs from `/tmp`); `perf-probe.py` `--port` removed in favour of
  `cfg.build_url()`.
- **Second script batch.** Throughput probe indexes `probe[i % len]` in all three loops (was:
  IndexError on partial insert failure); mindmap-shot removes its injected `<style>` in a `finally`
  (+ blob-URL revocation); verify-live restores emptied CSS in try/finally and rejects unknown
  check names with exit 2; PNG export failures report via `onError` → `showMessage` (new
  `errExportPng` key); E2E download waits use `Promise.all`. Four more entries verified already
  fixed (menu focus, title escape, doc guard, tooltip rule) and struck with evidence.
- **Low-findings sweep.** Removed the `titleParagraphs` array smuggling (`as any` gone both ends;
  opts + `takeTitleParagraphs()` stay); `export.spec.ts` reads the `SPECIAL_TOP` fixture instead of
  retyped literals; dragdrop kernel-order assertion compares against the kernel's own order; deleted
  uncalled `escapeKramdown`; refuted the "no-op span step" with measured evidence (it unescapes text
  inside stashed spans).
- **Script hygiene batch.** Dropped the unused `label` param from the privacy checker; the E2E
  leftover report points at the instance cleaner; mindmap-shot URL verified already on env.
- **Test-quality batch.** Find-bar toggle restores focus; indent.test shadow copy removed;
  touch-longpress vacuous block deleted; mobile-swipe renders with real props; tree-ops Run line
  fixed; css-scope keyframe cases + guard.
- **Wait-hygiene batch.** perf-probe and verify-live open tabs on readiness expressions instead of
  fixed 120s/30s sleeps; mindmap-shot's `\u` label verified visible to the language gate (refuted);
  its `Session.ev` shares the raise-on-error contract.
- **Dead-end UI batch.** The @-mention button hides when its doc list is empty; the unused mirror
  title derivation is gone; the unreachable signal-chaining branch is removed; test-instance writes
  its PID only when the kernel is up and warns loudly on skipped digest verification.
- **Deploy visibility.** Real runs print the target list and count before copying; both stale
  tsconfig "e2e never typechecked" citations struck (dual gates verified in package.json).
- **Ledger sweep.** Catalogue double-escape finding refuted by whole-file scan (zero remaining);
  run-e2e key entry struck with verification.
- **Live-hygiene batch.** verify-live: icon check fails on zero targets, both style empty/restores
  in try/finally, theme state captured and restored (stylesheet + attribute + modeOS); keymap
  snapshot prefers built-in defaults; deleted the uninvoked verify-host-style duplicate; five more
  entries verified already fixed and struck.
- **Gate-port batch.** CSS scope gate ported to postcss (brace-in-string divergence demonstrated;
  same 305/305 on the real build); interactions fit case fails on empty measurement; stale-mapping
  entry verified already gone.
- **Hygiene sweep.** verify-android help names `.env` keys, screenshot example passes a directory,
  dead adb input methods deleted; privacy scan counts oversized artifacts; auto-select refuted with
  constructor evidence; docs-index suffix ranges expand and the over-advertised range fixed; TESTING
  chromium path corrected.

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

  ★★ **Corrected by measurement, because the first version of this note guessed.** It said `indexing` "is
  also what a freshly inserted block reports while the SQL index lags" —— an assumption, never tested. Asked
  the kernel instead: a block id that **never existed** answers
  `load block tree [<id>] failed: tree not found`, and a **read** of a deleted id answers `block not found`
  at every moment, not `indexing`. So `indexing` is not a generic "unknown id / index lag" state —— it is
  specific to an id that **existed moments ago and is gone**, which is much closer to what this criterion
  actually wants to detect.

  ★★ The window, measured: it is about **100 ms**. Polling the same deleted id at 50 ms intervals, the
  message changes between `t=0.001s` (`indexing`) and `t=0.104s` (`tree not found`), and stays `tree not
  found` afterwards.

  So the impact is small and precisely bounded: only a write landing within ~100 ms of the document
  disappearing is mis-reported. That is why this is **not** urgent, and also why it is worth keeping: the
  write-back is debounced at 250 ms, so an edit made in the same instant as an external deletion can land
  inside the window, and the user then sees a kernel message with no recovery button instead of "the document
  was deleted" with one.

  ★★★ **What the plugin's own calls actually produce**, measured by making each one after deleting the
  document —— this is the part that decides the fix, and the earlier drafts of this note got it wrong twice:

  | the plugin's call | the kernel answers | recognised now? | names the **document**? |
  |---|---|---|---|
  | `updateBlockDom(<child block id>)` —— the **main write path** | `load block tree [<child>] failed: indexing` | ❌ | ❌ (it names the child) |
  | `appendBlockDom(<docId>)` —— the create path | `parent block not found: <docId>` | ✅ | ✅ |
  | `insertBlock(md, '', <child>)` | `insertion target block not found` | ✅ | ❌ |

  So the gap **is** reachable from the main write path, and it is **not** fixed by adding `indexing` to the
  substring list: that message names the **child**, so the existing `docId` guard would reject it anyway.
  Adding the substring alone would be inert —— which is why the first plan for this ("add the fourth shape")
  was wrong.

  Two honest options, both needing a deliberate choice:
    1. **Keep it.** The window is ~100 ms and the outcome is a raw kernel message instead of a friendly one;
       no data is lost, and the edits stay in memory. Cheap, and consistent with the rule that a false
       negative beats a false positive.
    2. **Confirm by query.** On an unrecognised failure, ask the kernel whether `docId` still exists
       (`getBlockDOM` on a deleted document answers `block not found` at **every** moment, measured —— unlike
       the write path, which has the 100 ms transient). That turns the criterion from "does the message look
       like X" into "is the document still there", which is the question actually being asked.
  **Option 2 is now implemented** —— `SiYuanClient.blockExists` / `SiYuanStore.docExists` (a read, which has
  no window: measured `code: 0` while alive, `block not found` at t=0.001s and later) and
  `describeWriteError` asks it when the text does not settle the question. Unit-tested with the fetch seam
  (`src/siyuan/block-exists.test.ts`, 7 assertions) and shown red by mutating "any failure = gone" —— the
  `null` state that must not become `false`.

  ★★★ **But its UI trigger turned out not to be reachable by deleting a document from outside**, measured on
  a clean instance twice: with the plugin's **dock** open on a document and that document deleted, SiYuan
  **navigates to another document** and the panel follows it, so the next write goes to the new target and
  returns `code: 0` —— nothing fails, and no banner is due. Verified by watching the traffic: before the
  delete the writes name my document, after it they name a different one.

  So the query path is correct and cheap, but today it is a **fallback that the dock cannot reach**. It is
  kept because (a) it costs one read only on an already-failing write, and (b) the tab entry point
  (`addTab`/`openTab`, desktop only) binds a **fixed** docId, which is exactly the shape that can go stale.
  Anyone who reproduces the original symptom should check **which entry point** they were in first.

  ★ A second thing this cost, recorded so the next probe does not repeat it: a **tab-mode probe left two
  documents behind** on the isolated instance (`openTab` makes SiYuan create a temporary document). Later
  probes were then writing into that leftover, which made every "delete then write" test look successful for
  the wrong reason —— the panel was writing to a live document that was not the one under test. Cleaned up;
  a probe that opens a tab must delete the document it creates.

- **A second measured detail, recorded because it misled a test attempt:** deleting the document currently
  open in SiYuan makes SiYuan **navigate to another document**, and the panel correctly follows it — so the
  write-back then succeeds against the new target instead of failing. Reproducing "the target is gone" from an
  E2E case is therefore not as simple as deleting the open document; the criterion is better unit-tested (it
  is), and an E2E case needs the document to disappear **without** the editor switching away.

**Tooling gaps (continued):**

- ~~**The 9 uncalled store methods still need a pass.**~~ —— **answered**, with the evidence recorded below
  rather than as nine separate opinions. `python3 scripts/check-dead-methods.py --strict` still prints them
  (it is not a build failure by design), and the classification is now: **none is the `saveNodes` shape**.

  The test that matters is the one `saveNodes` failed: **does any user-visible surface promise the
  capability?** Checked for all nine —— `src/plugin/i18n/*.json`, `docs/FEATURES.md`, `docs/GETTING-STARTED*.md` ——
  and the answer is no for every one of them, so a dead wrapper cannot make a feature look implemented here.
  None of the nine is reachable from a test either (the only `setBlockAttrs` hits are a **fake client's own
  method** and an assertion that it is *not* called, which is not coverage of the wrapper).

  They fall into two kinds, and only the second needed reading:

  * **`api.ts` wrappers —— `moveDocs`, `getBlockAttrs`, `setBlockAttrs`, `listNotebooks`, `createNotebook`.**
    Each is a one-line pass-through to a real kernel endpoint (`/api/filetree/moveDocs`,
    `/api/attr/getBlockAttrs`, …), and each comment describes **what the endpoint does**, not what the plugin
    promises —— that is a client reference, not a capability claim. Kept: they are how a future caller reaches
    those endpoints, they cost one line each, and deleting them would mean re-deriving the endpoint shapes
    from the kernel source. The check that would change this is a promise appearing on a user-visible surface.
  * **`store.ts` operations —— `listDocs`, `loadNodes`, `searchNodes`, `listFolders`.** These are the
    product's own operations, so a stale comment here **is** the dangerous shape. Read individually:
    `loadNodes` was a one-line `(await loadDoc(id)).nodes` that its own comment called "the common path"
    while nothing took it —— **deleted**, along with the three methods the virtual kernel had accumulated
    speculatively (`shape`, `removeBlockForTest`, and the `rootOf` they were the only users of). `listDocs`,
    `searchNodes` and `listFolders` describe operations the plugin does not offer, and their comments say what
    they *would* do rather than claiming a shipped feature; they stay on the list, and `--strict` would fail
    the build the moment one of their comments started claiming a capability.

  ★ This entry's own line numbers had gone **stale** (519→555, 524→560, 591→627, 595→631, 467→480), which is
  the second time a pasted line list has rotted. The gate prints them fresh on every run, so the list above is
  the one thing not to trust —— run the tool.)

  ★ Two methods left this list without being deleted, and both were **false positives in the checker**:
  `moveNodes` (private, called only from `syncStructure` in the same file —— the declaring file was not
  being scanned) and `setHeadingTitle` (called as `store?.setHeadingTitle(...)`, and the pattern required a
  plain identifier before the dot, so optional chaining hid the call). This codebase uses `store?.`
  heavily, so the second gap was hiding real callers rather than hypothetical ones. Both are pinned: the
  scan includes the declaring file, and the pattern allows `?.`.

## A lesson about the audit queue (it is not busywork)

The queue had **27 `drifted` and 117 `cannot-judge`** entries, and the tempting reading is "a tool complaining
about line numbers". Reading two of them found a real defect that no gate could see: `e2e/testdoc.ts` returned
the kernel's envelope unchecked, so a **kernel refusal read as success** on three paths — `sql()`, both
`removeDocByID` helpers, and `lsNotebooks`. A spec could therefore **pass while the thing it measured never
happened**, and a failed delete looked like a clean teardown while the document stayed on the instance (the
same defect the leftover check exists to catch, seen from the other side). Fixed in one place, since all three
went through the same helper.

★ `drifted` means **the citation moved**, not that the finding is wrong — and the tool says so, in those words,
at the bottom of every run. The five line numbers in the entry above had rotted by up to 36 lines while the
defect was still exactly where it said. Treating "drifted" as noise would have thrown away a real finding; the
answer is to read the entry, not to trust or distrust its coordinates.

## Known gaps in our own tooling

Defects in how we check things, rather than in the product. Each one means a class of defect can reach a
release while every gate stays green.

- ~~`src/plugin/mindmap-reparent.test.ts` inspects source text~~ —— **done**: the file and fourteen
  others of the same shape were deleted, and the cycle rule it claimed to cover is now an E2E case
  (`e2e/mindmap.spec.ts`, "dropping a node into its own subtree is refused"), shown red with the guard
  disabled. A gate (`check-source-text-tests.py`) stops the shape returning.
- ~~`scripts/check-vacuous-tests.py` cannot see the "block appended below the summary / `process.exit`"
  shape~~ —— **done**: `scripts/check-check-order.py` decides it by **position in the AST** rather than by
  matching text, and it is a gate in `npm run check` (`check-order`, 0.25 s). It found the shape in a real file
  when demonstrated (appending a `check` below the report block was reported at its line number) and is clean on
  the tree. ★ Writing it took three attempts, each of which **reported clean on a file containing the defect**,
  and each was caught only by running it against a real mutated file: the report line was being matched in
  comment/string-stripped text (where "passed"/"failed" no longer exist), "is this `process.exit`
  unconditional?" was the wrong question (the idiom always wraps it in `if (fail)`, yet the run still ends
  there), and the brace walk tested `depth < base` where the closing brace returns *to* base. The tool's own
  header records all three.
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
