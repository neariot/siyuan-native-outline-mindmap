# TODO

The single front door for **what is left to do**. `docs/AUDIT-FINDINGS.md` is one of its inputs, not the
whole answer: that file carries the findings of one whole-repository review, while work also arrives from
reports, from measurements, and from features deliberately deferred.

Keep this file **short**. It is a list of what somebody should do next, not an archive: an item leaves by
being done, by being refuted in writing (with the reasoning, below), or by being moved into
`docs/AUDIT-FINDINGS.md` when it is really an audit finding.

## Now

Ordered by what a user would notice. These are verified against the code as it stands, not copied from a
report.

1. **A document title containing `<` or `>` loses those characters in the mind map.**
   `src/mindmap/Mindmap.tsx` interpolates the title straight into the root node's HTML, so plain text from
   `blocks.content` is parsed as markup. The characters vanish in the root node **and** in the exported PNG.
   (Audit: `medium · bug`, `Mindmap.tsx:553`.)
2. **The mind map's keyboard goes dead after a context-menu command.**
   Delete / focus-this-node / back-to-full-map all close the menu without returning focus to `.mm-canvas`,
   so Tab, Enter, Delete, F2 and Ctrl+Z do nothing until the user clicks a node again.
   (Audit: `medium · bug`, `mindmap/Mindmap.tsx` — the citation is now past the end of the file.)
3. **`scripts/record-demo.py`'s "a document id is required" guard is both case-sensitive and a substring
   test.** `if "none" in url` lets `--doc None` through to `?id=None` (the recording starts against a page
   with no document) *and* fires falsely for a real id containing the letters `none`. Two bugs in one line.
   (Audit: `medium · bug`, `record-demo.py:355`.)
4. **The shipped Chinese README tells users to run a flag that no longer exists.**
   `TARGET=plugin npm run build` is quoted at `README.zh-CN.md:74`, and `rsbuild.config.ts` says in a comment
   that there is no `TARGET` switch. Both READMEs are copied into `package.zip`, so the stale text reaches
   users. (Audit: `medium · docs`.)
5. **Two i18n entries render wrong in the UI they ship to.**
   `msgSummaryHint` has a real newline in English and a literal `\n` in Chinese; `en_US`'s
   `msgSummaryTopLevel` carries a double-escaped `\u2019` that renders as visible text.
   (Audit: `medium · bug`, `i18n/zh_CN.json:127`.)

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
- **Done: an E2E error message that blamed the plugin for a loaded machine.** Measured both ways on one
  commit (46.7s failing / 11.6s passing), and `run-e2e.py` now warns about the load before any case runs.

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
  test-quality). **Resolved:** deleted by `7e8c64b`, replaced by real focus cases in
  `src/plugin/mindmap-focus.test.ts`.
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
