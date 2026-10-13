# Audit findings

One review of the whole repository —— one auditor and one adversarial verifier per area. **This is a work
queue, not documentation**: an entry leaves it by being fixed, or by being refuted in writing.

The verdict columns count the verifier's entries that name the same file as a finding in that area; a
verifier also records what it checked and found clean, which is not a verdict on anything here. It recorded
no per-entry verdict, so "refuted 2" does not say *which* two —— that gap is in the run, not in the entries.

**237 findings when this was written: 16 high, 79 medium, 142 low.** The queue has moved since —— the
table below is the original run's tally and is kept as the record of what that review produced, while the
**current** count is derived from the entries themselves so it cannot drift:

| | now |
|---|---|
| entries in this file | **193** (147 struck, 46 open) |
| severity | 125 low, 68 medium |
| by category | test-quality 52, docs 50, bug 34, dead-code 33, fallback 8, type-escape 7, language 5, ux 4 |

★ `python3 scripts/check-audit-findings.py` is the authority for whether an entry's citation still
resolves, and it **fails** on one that does not. It cannot tell whether a defect is fixed. Entries that
leave the queue are recorded, with the commit that resolved them, in `docs/TODO.md` —— the audit's own
contract says an entry leaves "by being fixed, or by being refuted in writing", and the refutations live
there rather than here.

| Area | Findings | Confirmed | Refuted | Uncertain |
|---|---|---|---|---|
| `config` | 8 | 6 | 2 | 0 |
| `core` | 13 | 13 | 1 | 4 |
| `docs-core` | 14 | 12 | 1 | 1 |
| `docs-ledger` | 12 | 11 | 2 | 2 |
| `e2e-helpers` | 14 | 12 | 7 | 0 |
| `e2e-specs-a` | 11 | 11 | 0 | 3 |
| `e2e-specs-b` | 20 | 20 | 1 | 2 |
| `i18n-consistency` | 10 | 10 | 0 | 0 |
| `mindmap` | 16 | 15 | 1 | 1 |
| `plugin-code` | 18 | 17 | 2 | 2 |
| `plugin-tests-a` | 14 | 14 | 0 | 0 |
| `plugin-tests-b` | 17 | 17 | 0 | 0 |
| `scripts-gates` | 16 | 16 | 0 | 3 |
| `scripts-infra` | 15 | 15 | 2 | 4 |
| `scripts-live` | 27 | 25 | 4 | 3 |
| `siyuan` | 12 | 10 | 0 | 1 |

By category: test-quality 72, docs 54, bug 42, dead-code 39, fallback 11, type-escape 7, language 5, ux 4, privacy 3.

**high** first, then medium, then low.

## What this file does not carry

The reports each also recorded their own coverage: the files they read, and **what they did not check**,
which is the part a reader should be most suspicious about. Those fields were in the JSON reports under
`.tmp/audit/`, and the reports were deleted once the *findings* were absorbed here —— so the coverage is
gone, and it is not recoverable from this file. Re-running an area brings it back; the area names in the
table above are the scopes it would run over.

Recorded rather than quietly omitted, because "the audit covered everything" is exactly the wrong
conclusion to draw from a complete-looking list of findings.

## Findings

### test-suite

- **medium · docs** `.github/workflows/ci.yml:75`  
  The manual E2E job cannot run as committed and its dispatch input contradicts the entry point: run-e2e.py takes the target from .env (cfg.siyuan_test / cfg.test_token() / cfg.chromium_path), and the job never creates a .env and never calls setup-python, while the input still claims SIYUAN_URL is what selects the instance.
- **medium · docs** `README.zh-CN.md:74`  
  The Chinese README still documents a build flag that no longer exists (TARGET=plugin) and a dev server port that is not configured anywhere — the dev server in fact binds :3000 — and this stale text is shipped to users, because the build copies both READMEs into the package.
- ~~**medium · type-escape** `tsconfig.json:15`~~ **stale — already fixed before this pass**
  `npm run typecheck` runs both `tsc --noEmit` (src) and `tsc --noEmit -p tsconfig.e2e.json`
  (e2e); the e2e config's header records the 42-error measurement. Verified in package.json.

### core

- ~~**medium · test-quality** `src/core/empty-span.test.ts:99`~~ **fixed**
  The "reverse check" that was supposed to prove the defect is real hand-built a `legacy` function and
  asserted that **it** leaked `<span></span>` —— a strawman that never touched `htmlToSiyuanDom`, so its
  assertion was true by construction and could not fail however the product changed. Replaced with checks on
  the shipped function: an empty span must strip to the **empty string** (so the caller's `|| '\u200b'`
  actually fires —— the defect was that `'<span></span>'` is truthy, so the fallback never took), no bare
  empty span may survive into the paragraph DOM, and a span holding text must survive the stripper.
  Shown red by disabling the strip in `core/map.ts`. The file already had two other checks that go red the
  same way, so this strawman was contributing nothing.
- ~~**medium · test-quality** `src/core/map.test.ts:854`~~ **fixed**
  A check passed a literal `true` as its condition, so it was counted in the suite total while asserting
  nothing. It recorded a real kernel measurement (consecutive indented lines with no blank line before them
  are merged into the first paragraph, so the content loses its paragraph boundary) but could never go red
  on it. ★ It is **not** replaced with an assertion, because the parser cannot see the difference ——
  measured, `kramdownToTree('- node\n  A\n  B\n')` and `kramdownToTree('- node\n\n  A\n  B\n')` both give
  `paragraphs: ["<span>A</span>", "<span>B</span>"]`; the merge is the kernel's. So the measurement is kept
  as a comment, and the claim that *is* testable at this layer (the writer emits the blank line) is already
  asserted just above. Real `check()` calls: 155 → 154.
- ★ **A literal `true`/`false` condition is worth searching for**, and a single-line regex is not enough to
  find it: the condition sits on its own line in each real case. Six exist; five are the **correct** pattern
  (a hard failure inside a `catch`, or a missing fixture that must fail loudly), and only this one was a
  defect. The distinction is whether the condition *can* vary —— `false` in a `catch` can, because the
  `catch` may not run.

### docs-core

- **medium · docs** `docs/ARCHITECTURE.md:211`  
  The 'Known boundaries' table still says the plugin name is a placeholder and the plugin cannot be installed; both were resolved.
- **medium · docs** `docs/FEATURES.md:46`  
  The 'Open the mind map' entry-point list is wrong twice: the slash menu inserts a mirror block instead of opening the map, and no document-tree context menu entry exists.
- **medium · docs** `docs/FEATURES.md:51`  
  'Expand into a sub-document ... + a backlink attribute' claims a private attribute that the implementation deliberately does not write.
- **medium · docs** `docs/TESTING.md:568`  
  The allowlist inventory contradicts both scripts/language-allowlist.txt and the same document twenty lines above it.
- **medium · docs** `docs/TESTING.md:603`  
  The backup instruction in the doc still says `cp file file.bak` in the project root, which the current AGENTS.md section 1 hard rule forbids.

### docs-ledger

- **medium · docs** `docs/GETTING-STARTED.md:42`  
  The command-palette key quoted in both language versions does not exist: SiYuan binds the command panel to ⌥⇧P, i.e. Alt+Shift+P on Windows/Linux, not Alt+Ctrl+P / ⌥⌘P.
- **medium · docs** `docs/RELEASE-0.1.4.md:40`  
  The release note promises that refreshing/switching no longer loses the map's zoom; zoom is in fact deliberately not persisted, which the project records as a design decision elsewhere.
- **medium · docs** `docs/SHORTCUTS.md:52`  
  The documented mindmap interactions do not exist: a single click does not jump back to the outline, and a double click does not focus a branch -- it starts inline editing.
- ~~**medium · test-quality** `docs/pitfalls/editor.md:450`~~ **fixed**
  The practice 6.9bb prescribes is now implemented: `src/plugin/shortcut-table.test.ts` asserts the table's
  group and entry counts (5 / 26, measured 2026-10-12, recorded as a dated measurement rather than a constant),
  that no group is empty, and that every entry is well-formed. `SHORTCUTS` is exported from `Outliner.tsx` so
  the shape can be read at all. Shown red by removing one entry. ★ Writing it caught two mistakes of my own,
  both recorded in the pitfall entry: a hand-count of the table was wrong by one, and an assertion that the
  labels are "real text" was testing the wrong layer (outside SiYuan `t()` returns the key).

### e2e-helpers

- ~~**medium · type-escape** `e2e/fixtures.ts:2`~~ **fixed**
  No `e2e/` file was typechecked: `tsconfig.json` includes `src` only, and Playwright transpiles with esbuild
  —— **types stripped, never checked**. Compiling the suite revealed **42** errors, not the two the finding
  estimated, and they were real: `window.siyuan` (undeclared host global), `res.data?.content` read off
  `unknown` in ten places (the kernel response shape), `NodeListOf<Element>` iterated as an array, a `Set`
  iterated without `downlevelIteration`, and `Page` imported from `./fixtures` which never exported it.
  `tsconfig.e2e.json` now typechecks the layer (`npm run typecheck` runs both programs, and
  `npm run typecheck:e2e` runs this one alone). Everything is fixed rather than suppressed: `field()` reads a
  kernel response without assuming its shape, `e2e/siyuan-global.d.ts` declares the host global, and
  `e2e/pngjs.d.ts` declares the surface of `pngjs` that is used —— **ambient**, because a `declare module`
  inside a module file is an augmentation and TypeScript refuses to augment an untyped package.
  ★ Two config details cost a cycle each and are recorded in the comments: `declare global` needs `export {}`
  to be a module, while `declare module` must be in a file that has neither.
- ~~**medium · test-quality** `e2e/mindmap.ts:359`~~ **fixed**
  `contentBox` returned `{ l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }` when it measured nothing,
  and the "fit fits all the nodes" case compares those with `>=` / `<=` —— **all four comparisons are
  satisfied by the sentinels** (`Infinity >= anything`, `-Infinity <= anything`), so it passed with an empty
  panel. Verified in isolation before touching anything: all four assertions pass with zero nodes measured.
  `contentBox` now **throws** when it measured 0 nodes, naming the precondition, the same rule `canvasBox`
  beside it already followed. A regression case asserts the throw *and* that its message names the reason
  (so it cannot be satisfied by an unrelated TypeError), shown red by removing the guard —— and the 28-case
  mind-map suite still passes, which is the evidence that the callers were really measuring nodes rather than
  sailing through on `Infinity`.
- ~~**medium · test-quality** `e2e/testdoc.ts:62`~~ **fixed**  
  The kernel's result code is dropped on three paths, so a kernel refusal becomes 'nothing found' or 'nothing to do': `sql()` returns `j?.data ?? []` whatever the code says, the removeDocByID calls ignore their response, and lsNotebooks' failure becomes an empty notebook list.

  **One change closes all three**, because all three go through the same helper: `api.call` now throws when the
  kernel answers a non-zero `code` (`kernel refused <path>: code=… msg=…`). `sql()` was calling its own
  `post`/`json` pair and so bypassed it —— it now calls `call` too, and the `?? []` that remains is only for
  the legitimate null/undefined case, with a comment saying so. Both `removeDocByID` sites already went through
  `call`, and `lsNotebooks` does as well, so a refusal there can no longer become "an empty notebook list".

  ★ This is §5.1 inside the test layer, and it mattered more than a product bug would: a dropped code let a
  spec **pass while the thing it measured never happened**. It also explains a failure mode this repository has
  paid for before —— a `removeDocByID` that ignored its response made a **failed delete look like a clean
  teardown**, and the leftover document then makes a later case pass for the wrong reason, which is why the
  suite reports leftovers at the end. Verified: `e2e/theme.spec.ts` (3 passed) and `e2e/outline.spec.ts`
  (26 passed, 3.4 m) with the stricter helper, and the leftover check reports clean on both.

### e2e-specs-a

- ~~**medium · test-quality** `e2e/mindmap.spec.ts:199`~~ **fixed**
  The fit case pans first (breaking mount auto-fit), so only a wired button restores containment;
  without the pan it passed for an unwired button.
- ~~**medium · test-quality** `e2e/mindmap.spec.ts:322`~~ **fixed by deletion**
  The scroll-reachability case tested removed behavior (`.mm-bar` now wraps): deleted, with the
  no-horizontal-scroll case carrying the coverage.
- ~~**medium · test-quality** `e2e/mindmap.spec.ts:481`~~ **stale — controls its own widths**
  The case sets the dock to 300px/900px itself and asserts the real widths (verified by read at
  508+ and 555+); no environmental precondition remains.
- ~~**medium · test-quality** `e2e/outline.spec.ts:680`~~ **fixed**
  The batch-indent case now asserts the x-shift plus document nesting, not just the row count —
  a no-op indent fails instead of passing.

### e2e-specs-b

- ~~**medium · test-quality** `e2e/ctxmenu.spec.ts:170`~~ **fixed**
  The case uses its own temp doc (no shared-doc pollution) and asserts three top-level items in
  the document markdown — a child insert fails instead of passing on count.
- ~~**medium · test-quality** `e2e/keyboard.spec.ts:106`~~ **fixed**
  Tab/Enter/menu-child cases now assert document nesting (child) / top-level count (sibling) on
  top of the node count — a child/sibling swap fails.
- ~~**medium · test-quality** `e2e/keyboard.spec.ts:197`~~ **fixed**
  The restore assertion is unconditional now: the menu item must exist (`toHaveCount(1)`), so an
  absent item fails instead of silently dropping half the claim.
- ~~**medium · test-quality** `e2e/mobile.spec.ts:231`~~ **fixed**
  The view switch must be visible (`toBeVisible`, no swallowed error) before the canvas assertion
  runs — an invisible switch fails instead of skipping silently.
- ~~**medium · test-quality** `e2e/smoke.spec.ts:79`~~ **fixed**
  The mount signal is the sidebar entry button (`[data-type*="native-outline-mindmap"]`), never
  `.om-dock` — exactly what `waitPluginReady`'s note forbids, now followed.
- ~~**medium · type-escape** `tsconfig.json:15`~~ **stale — already fixed before this pass**
  Same file, second citation of the same stale claim: e2e has its own tsconfig and gate
  (see above). No uncompiled scope remains.

### i18n-consistency

- ~~**medium · dead-code** `scripts/check-i18n-keys.py:125`~~ **stale — already fixed before this pass**
  The fallback requires the whole zh value (or the key itself) in consumer text; the
  measured-coincidence comment above it records the old shape. Verified by read.
- ~~**medium · bug** `src/plugin/i18n/zh_CN.json:127`~~ **refuted in writing**
  The summary feature (and its `msgSummaryHint` / `msgSummaryTopLevel` keys) was removed entirely
  in `9d06fda`; both catalogues hold identical key sets today and a same-class encoding scan finds
  no remaining literal-`\n` / double-escaped mismatches. Nothing to fix.
- ~~**medium · language** `src/plugin/outline/Outliner.tsx:3643`~~ **fixed**
  The toolbar's emoji button was the only one with a literal tooltip. Fixed: `tipEmoji` added to
  both catalogues and the button now uses `t('tipEmoji')`; `npm run i18n` is green and no other
  literal `title="…"` remains in either view.

### mindmap

- ~~**medium · bug** `src/mindmap/Mindmap.tsx:1905`~~ **already fixed before this pass**
  Every context-menu close path calls `focusCanvas()` (`bc783d7`); keyboard E2E pins
  `document.activeElement` after menu commands (`e2e/keyboard.spec.ts`).
- ~~**medium · fallback** `src/mindmap/Mindmap.tsx:654`~~ **stale — already fixed before this pass**
  Current `fit()` returns early on a zero container (no window fallback); the remaining
  `window` uses are viewport-relative menu clamping and the documented phone rule, and the dock-
  width migration is recorded with measurements in the file. Verified by read.
- ~~**medium · bug** `src/mindmap/Mindmap.tsx:553`~~ **already fixed before this pass**
  The root title is escaped (`escapeHtml` at `Mindmap.tsx:574`); E2E pins `E2E-角度<T>-测试`
  rendering exactly (`e2e/mindmap.spec.ts:1341`).
- ~~**medium · ux** `src/mindmap/Mindmap.tsx:273`~~ **stale — already fixed before this pass**
  Collapse state is keyed `om-mm-collapsed:<docKey>` with cross-document transition guards
  (`02f9214`); E2E pins "collapse state follows the document and does not leak into another one"
  (`e2e/viewstate.spec.ts:172`). Verified by read + suite.

### plugin-code

- ~~**medium · language** `src/plugin/i18n/zh_CN.json:127`~~ **refuted in writing**
  Same removed keys as the bug entry above (`msgSummaryHint`/`msgSummaryTopLevel`, gone in
  `9d06fda`): a whole-catalogue scan today finds zero remaining double-escapes in either file
  (verified by script). Nothing to fix.
- ~~**medium · bug** `src/plugin/mount.ts:2311`~~ **fixed**
  The mind-map write path fires `writeLatest()` with no echo-guard window and no `.catch`, so a failed write-back became an unhandled rejection whose message never reached the error bar. Every other write path surfaces failures through `setErr(describeWriteError(e))`; this call site is fired from a callback with no `await`, so the rejection had to be handled there. Now `.catch`es into the same path, which renders into `.om-mm-err`. ★ The entry said "two write paths" —— there is one such call site (`void ... | rg` over the file); the other must have been removed earlier, and the citation was re-pointed after an edit moved it.
- ~~**medium · dead-code** `src/plugin/mount.ts:2061`~~ **fixed**
  The @-mention button now hides when `docs` is empty (which mount always passes) instead of
  offering an empty search panel (verified: typecheck clean, no test references the button).

### plugin-tests-a

- ~~**medium · test-quality** `src/plugin/attr-triple.test.ts:39`~~ **fixed**
  The stub (`attrsToWrite` returning `{}` by construction) and its checks are deleted; the
  behavioral memo round-trip in ④ carries the coverage. A source grep would violate the
  check-source-text-tests gate, so no replacement stub was introduced.
- **medium · test-quality** `src/plugin/blockmap-namespace.test.ts:46`  
  MapModel re-implements SiYuanStore.loadBlockMap and the file mirrors only one of its two retention branches; the preferred getBlockDOM branch has different retention semantics, so the headline claims are not invariants of the shipped method.
- ~~**medium · test-quality** `src/plugin/empty-node-echo.test.ts:52`~~ **fixed**
  The pasted `plainNodeText` copy (already drifted from the product) is deleted; the test imports
  `visibleText` — the function `mount.ts`'s measure delegates to — so drift breaks the suite.
- ~~**medium · test-quality** `src/plugin/kernel-side-effects.test.ts:31`~~ **stale — rewritten to source assertions**
  The file asserts structural properties of `store.ts` via `fnBody` (verified by read); the
  mock-literal shape the entry names is gone.

### plugin-tests-b

- ~~**medium · test-quality** `src/plugin/map-coverage-guard.test.ts:20`~~ **stale — already fixed before this pass**
  The criterion is imported from `store.ts` (verified by read); the header records the copy-vs-import history.
- ~~**medium · test-quality** `src/plugin/minify-tdz.test.ts:58`~~ **stale — guarded**
  The skip prints a warning and the file carries a hand-built counterexample proving the check
  logic fires; the build gate runs post-build so the artifact exists. Verified by read.
- ~~**medium · test-quality** `src/plugin/paragraphs-ui.test.ts:52`~~ **fixed**
  The test replicas are deleted: `paraPlainText`/`paraDisplayLine`/`isParaEmpty` now live in
  `model/tree.ts` and all four product sites call them, so drift breaks the suite. The empty
  marker renders from the catalogue (both locales), asserted as "not a blank line".
- ~~**medium · test-quality** `src/plugin/ref-nav.test.ts:57`~~ **stale — tests real code**
  The assertions drive `kramdownToHtml` on real inputs (verified lines 50-60); no empty-literal
  regression shape present.
- ~~**medium · test-quality** `src/plugin/undo-merge-kind.test.ts:14`~~ **stale — already fixed before this pass**
  The criterion is imported from `core/undo-window.ts` with a source-assertion pin (verified by
  read); the MergeModel-copy history is in the header.

### scripts-gates

- ~~**medium · dead-code** `scripts/audit-language.py:521`~~ **stale — reachable**
  `_string_kind` returns `'i18n-fallback'` for catalogue text (line 532+); the branch fires.
  Verified by read.
- ~~**medium · test-quality** `scripts/audit-privacy.py:374`~~ **addressed — tests selection now**
  The case asserts the live pass *selects* every id-shaped literal for the instance to judge
  (verified by read at 462-495); the file-missing shape the entry names is gone.
- ~~**medium · test-quality** `scripts/check-docs-index.py:36`~~ **fixed**
  Dash-linked spans are rejoined before matching so LONG_RANGE fires; a SUFFIX_RANGE covers
  multi-letter suffixes. The fix exposed a real over-advertised range (`6.9aa`–`6.9cc` named 55
  entries, only 4 exist) — the index now lists them explicitly. Gate green: 88 checked, none dangling.
- ~~**medium · test-quality** `scripts/verify-css-scope.py:50`~~ **fixed by port**
  The gate is now `scripts/verify-css-scope.mjs`, parsing with postcss (the parser the build
  already uses) instead of a regex comment stripper + brace counter. Demonstrated: a `{` inside a
  CSS string invents a 4th selector under the old parser while postcss counts 3. Same verdicts on
  the real build (305/305 both); `build`, `verify-css`, and `check` all call the .mjs.

### scripts-infra

- ~~**medium · bug** `scripts/cdp.py:176`~~ **fixed**
  `send()` discarded the CDP `error` member and `ev()` discarded `exceptionDetails`. Fixed in
  both `scripts/cdp.py` and the `record-demo.py` copy: CDP errors raise `RuntimeError`, and the
  exception is carried on the result dict (the real CDP shape puts `exceptionDetails` top-level,
  which `ev` would otherwise strip before seeing it — caught by the selftest, not by reasoning).
  Pinned by `python3 scripts/cdp.py --selftest` (5 cases, fake websocket, no browser).
- ~~**medium · bug** `scripts/env.py:69`~~ **stale — already fixed before this pass**
  The parser strips matched quotes and treats `#` inside quotes as data (verified by read at
  lines 68-76); the docstring matches.
- **medium · dead-code** `scripts/env.py:160`  
  The entire SIYUAN_SRC feature is dead: no code reads siyuan_src, require_siyuan_src, SIYUAN_SRC_MARKERS or the SIYUAN_SRC default, yet .env.example documents the key and promises that checks needing the source 'skip and say why'.
- ~~**medium · dead-code** `scripts/verify-host-style.py:1`~~ **fixed**
  The uninvoked duplicate is deleted; UI-TC-02 lives only in `verify-live.py`'s
  `run_host_isolation` (gated by the verify flow).
- ~~**medium · test-quality** `scripts/verify-pkg.py:6`~~ **stale — compares byte-for-byte now**
  The check compares packaged entries against built `dist-plugin/index.js`/`index.css` byte for
  byte plus three-way version agreement (verified by read); a stale zip fails instead of passing.

### scripts-live

- **medium · bug** `scripts/kernel-index-lag.py:119`  
  Probe blocks are deleted only on the happy path: both early returns - and any raised exception - leave the index_lag_probe_i paragraphs inside the target document.
- ~~**medium · bug** `scripts/kernel-mutation-throughput.py:131`~~ **fixed**
  Serial and concurrent loops indexed `probe[i]` to `n-1` while failed inserts shrink the list —
  both now use `probe[i % len(probe)]`, matching the warm-up loop's existing guard.
- ~~**medium · language** `scripts/mindmap-shot.py:168`~~ **refuted in writing**
  The label is a JS `\u` escape inside a Python string, which audit-language.py decodes through
  `ast` (verified: the gate reports nothing for this file). No hiding, nothing to fix — beyond the
  `Session.ev` error contract fixed alongside `cdp.py` above.
- ~~**medium · bug** `scripts/mindmap-shot.py:62`~~ **fixed**
  The injected `<style>` is removed from the live svg in a `finally` (plus blob-URL revocation);
  verified by `node --check` on the extracted JS.
- ~~**medium · bug** `scripts/perf-probe.py:185`~~ **fixed**
  The deprecated fixed `wait=120` is gone; opening waits on the readiness expression. (The
  separate `time.sleep(8)` after open is untouched — out of scope for this entry.)
- ~~**medium · fallback** `scripts/perf-probe.py:182`~~ **fixed**
  The script assembled the build URL by hand with a `--port` override. Removed the flag; the URL
  now comes from `cfg.build_url()` like every other caller (verified: no remaining `--port`
  references outside an unrelated script's own flag).
- ~~**medium · bug** `scripts/record-demo.py:355`~~ **already fixed before this pass**
  The guard tests the value (`if not doc and not args.url`), not a URL substring — the file's own
  comment records both directions of the old mistake. Verified by read.
- ~~**medium · bug** `scripts/record-demo.py:375`~~ **fixed**
  The repaint nudge timer and the screencast tab are now released in a `finally` (stop screencast,
  `NUDGE_OFF`, close — each guarded), so an exception inside the story cleans up instead of leaving
  a 12fps setInterval mutating the user's page after the script dies. The exception still propagates
  (a failed story must not build a video).
- ~~**medium · test-quality** `scripts/verify-live.py:389`~~ **fixed**
  Unknown check names now exit 2 with the valid list instead of reporting `0/0 passed ✅`.
- ~~**medium · bug** `scripts/verify-live.py:307`~~ **fixed**
  The style empty/measure/restore now runs in try/finally, so a failure restores the user's CSS
  instead of leaving the page unstyled.

### siyuan

- ~~**medium · dead-code** `src/siyuan/store.ts:2130`~~ **stale — not present in current code**
  The code sets `ok = false` before the move and `ok = true` only after `moveBlock` succeeds
  (verified by read; so since the single-commit history). The described `ok = true`-before-loop
  shape does not exist.
- ~~**medium · bug** `src/siyuan/store.ts:190`~~ **fixed**
  `pruneDestroyedSiblings` declared an existing sibling block 'destroyed' after two SQL misses only
  200 ms apart and never consulted `freshlyInserted`. Fixed: fresh blocks are skipped before any probe
  SQL. Index flush lag measured at 200ms~2.8s on the isolated instance; pinned by
  `src/siyuan/prune-fresh.test.ts` (red-proofed — the assertion is on the probe SQL, since the
  retention would revive a cleared fresh mapping and hide the defect from a mapping assertion).
- ~~**medium · bug** `src/siyuan/store.ts:443`~~ **fixed**
  The two branches of loadBlockMap disagreed about preserving the previous mapping. Fixed in two
  places, both measured live on the isolated instance: (1) `refreshMapsAfterCreate` registers its
  blocks as freshly-inserted so the DOM branch retains (not drops) the alignment; (2) its top-list
  SQL now picks the list whose parent is the document/heading (the unqualified `LIMIT 1` returned
  the *child* list, aligning n1 to the child item and dropping n2/n3). Pinned by
  `src/siyuan/refresh-align.test.ts` (both halves red-proofed).

### config

- **low · docs** `.env.example:36`  
  The committed template carries narrative case history and dates, which AGENTS section 7 says belong in the commit message or docs/, and one of its cross-references is off by eight lines — the file grows on every incident instead of staying a key list.
- **low · docs** `README.md:58`  
  A feature bullet is attached to the end of the preceding paragraph with no blank line, so a user-facing feature item renders as part of the sentence above it (the rest of the README never does this, and the Chinese sibling has the same content as a proper bullet).
- ~~**low · docs** `scripts/env.py:27`~~ **stale — docstring matches code**
  The class docstring states two sources plus machine-independent DEFAULTS (verified lines 78-95);
  no third tier is promised.

### core

- **low · docs** `docs/ARCHITECTURE.md:146`  
  The architecture doc still documents the markdown-by-default / DOM-when-styled decision tree; the code has routed everything through the DOM path for a while.
- **low · dead-code** `src/core/blockdom.ts:164`  
  `paragraphBlockDom` is exported for `insertParagraphAfter` but no shipped code calls it; the real call site builds the same paragraph DOM inline, five times over, in a slightly different shape.
- ~~**low · test-quality** `src/core/empty-span.test.ts:57`~~ **fixed**
  The assertion now checks the stripped text equals exactly the fallback placeholder — the old
  form passed on the broken code via the placeholder inside the un-stripped span.
- ~~**low · test-quality** `src/core/layout.test.ts:90`~~ **fixed**
  Separate accumulators per invariant — a red run now names which invariant broke.
- ~~**low · dead-code** `src/core/layout.ts:101`~~ **fixed**
  `escapeKramdown` was private and uncalled anywhere (verified by grep). Deleted.
- ~~**low · dead-code** `src/core/map.ts:639`~~ **refuted in writing**
  The step is load-bearing, not a no-op: it stashes the span through the entity-escaping stages
  and step 7 unescapes only the *text inside* it (`<span style="…">a&amp;b</span>` → `<span
  style="…">a&b</span>`, verified live). A character-identical rebuild on clean input is the
  point — the structure must survive escaping unchanged.
- ~~**low · type-escape** `src/core/map.ts:738`~~ **fixed**
  The tree no longer smuggles `titleParagraphs` as an undeclared array property (`as any` gone
  on both ends): the writer half is `treeToKramdown(nodes, { titleParagraphs })` / `docParagraphs`
  opts, the reader half is the `takeTitleParagraphs()` channel. Verified: zero remaining
  `.titleParagraphs` accesses outside the option plumbing; typecheck + map suite green.

### docs-core

- **low · docs** `docs/ARCHITECTURE.md:53`  
  The 'Lines' column of the module table is stale for 12 of the 13 files it lists.
- **low · docs** `docs/DATA-FORMAT.md:72`  
  'No browser-local storage is used' is false as written: the shipped UI keeps its view state in localStorage.
- **low · docs** `docs/MAPPING.md:282`  
  The asset upload is documented against an endpoint that does not exist in the kernel.
- **low · docs** `docs/MAPPING.md:310`  
  The 'How it is verified' block promises a unit-test command and gives none.
- ~~**low · docs** `docs/TESTING.md:32`~~ **already fixed before this pass**
  The doc names `CHROMIUM_PATH` from `.env` (verified line 191); no `/usr/bin` path remains.
- **low · docs** `docs/TESTING.md:298`  
  The claim that SiYuan's own test script 'is exactly' this project's shape no longer matches app/package.json.
- **low · docs** `docs/TESTING.md:548`  
  The selftest case count is stale.
- **low · docs** `docs/TESTING.md:439`  
  A performance-table row points at a script that is not in the document or the repository.

### docs-ledger

- **low · docs** `docs/DISTRIBUTION-README.md:10`  
  The install path names a button that does not exist: SiYuan's bazaar button is labelled 'Install local package'.
- **low · docs** `docs/GETTING-STARTED.md:50`  
  The doc says the plugin registers three keymap entries and lists an unbound 'Open panel' command; the plugin registers two commands, and no 'Open panel' command exists.
- **low · docs** `docs/GETTING-STARTED.zh-CN.md:26`  
  The Chinese doc sends the reader to a settings section that is not called that in SiYuan's Chinese UI; the English sibling names it correctly.
- **low · docs** `docs/SHORTCUTS.md:57`  
  The documented undo-merge window is 1.5s; the implementation merges within 1.2s.
- **low · docs** `docs/pitfalls/style.md:63`  
  A count inside the document is wrong: it says 7 class names and lists 8.
- **low · docs** `docs/pitfalls/testing.md:591`  
  A cross-reference points at an entry that does not exist: debug.md has no 6.14.
- ~~**low · docs** `docs/pitfalls/testing.md:502`~~ **fixed**
  The `6.x` entry is now `6.14` (fits between 6.13 and 6.15) and the PITFALLS.md index lists it;
  docs-index gate green (89 checked, none dangling).

### e2e-helpers

- ~~**low · docs** `docs/TESTING.md:32`~~ **already fixed before this pass**
  Same `/usr/bin/chromium` staleness as above, fixed by the same doc edit (verified line 191).
- ~~**low · dead-code** `e2e/fixtures.ts:76`~~ **fixed**
  The unused `opts: { url?: string }` parameter and its `opts.url ?? '/'` default are deleted ——
  `openSiYuan(page)` now has exactly one way to decide which URL is opened.
- ~~**low · dead-code** `e2e/mindmap.ts:31`~~ **fixed**
  The never-read `const view = page.locator('.om-mm-viewswitch');` is deleted.
- ~~**low · dead-code** `e2e/mobile.ts:25`~~ **fixed**
  `MOBILE_VIEWPORT` is deleted; the doc comment now says the viewport comes from
  `devices['iPhone 12']`, which is the single source.
- ~~**low · dead-code** `e2e/outline.ts:71`~~ **fixed**
  `typeInNode`, `pressKeyInNode`, `clickBullet` and the `focusNodeRow` only they called are deleted
  (verified: no call site in `e2e/` or `src/`).
- ~~**low · test-quality** `e2e/outline.ts:40`~~ **fixed**
  `ensureOutlineReady` polls `.node-row:not(.node-row-empty)`, so an empty outline no longer
  satisfies the precondition; the message matches the criterion.
- ~~**low · dead-code** `e2e/testdoc.ts:279`~~ **fixed**
  `SPECIAL_TOP` is now imported by `export.spec.ts` (the bare-literal and round-trip assertions
  read the fixture), so export and assertion cannot drift apart.
- ~~**low · bug** `e2e/themes.ts:172`~~ **fixed**
  `restoreTheme` writes the **captured** appearance (including `modeOS`) back verbatim, so a run no
  longer permanently clears "follow the system" on the shared instance.

### e2e-specs-a

- ~~**low · fallback** `e2e/mindmap.spec.ts:61`~~ **fixed**
  The root is found by `data-node-id="__root__"` and a missing root **throws**; the
  "first node whose text is not a branch" rule and its `?? info[0]` fallback are gone.
- ~~**low · bug** `e2e/mindmap.spec.ts:888`~~ **fixed**
  Both download cases now `await Promise.all([waitForEvent, click])`, so a failed click rejects
  the wait with it instead of stranding an unhandled rejection 30s later.
- ~~**low · test-quality** `e2e/outline.spec.ts:219`~~ **fixed**
  The write-back probe is scoped to the temp document (`root_id`), not the whole instance.
- ~~**low · test-quality** `e2e/outline.spec.ts:107`~~ **fixed**
  `firstParentBullet` throws when no bullet has children, so the caller can no longer select
  `nth(-1)`; the redundant caller-side guard is removed.
- ~~**low · fallback** `e2e/outline.spec.ts:202`~~ **fixed**
  All 19 `notebook || (await resolveTestNotebook(api))` sites now pass `notebook` directly, and
  `createTempDocTitled` rejects an empty notebook (verified: 0 occurrences left).
- ~~**low · test-quality** `e2e/outline.spec.ts:184`~~ **fixed**
  Marker cleanup runs in `finally` — a failing assertion no longer leaves the shared fixture dirty.

### e2e-specs-b

- **low · docs** `e2e/ctxmenu.spec.ts:16`  
  The file header states the menu has 7 items while the file's own case asserts exactly 8, so the header is stale (it also disagrees with the enumerated list in the same sentence).
- ~~**low · test-quality** `e2e/dragdrop.spec.ts:177`~~ **fixed**
  The write-back criterion compares the full kernel list against `topLevelRowTexts` (derived from
  UI indentation, independent of the kernel), so kernel data loss fails instead of comparing equal.
- ~~**low · dead-code** `e2e/dragdrop.spec.ts:213`~~ **fixed**
  The kernel-order assertion compares against the kernel's own order instead of a hardcoded
  name list whose 丙/丁 entries this fixture never holds.
- **low · docs** `e2e/export.spec.ts:230`  
  The comment above the determinism case allows variation the assertion forbids: it says a little variation (timestamps and the like) is acceptable while the criterion is exact string equality.
- ~~**low · type-escape** `e2e/interactions.spec.ts:1`~~ **stale — already fixed before this pass**
  `fixtures.ts` re-exports `type { Page }` (verified lines 3/7); e2e typecheck is a gate.
- ~~**low · test-quality** `e2e/interactions.spec.ts:146`~~ **fixed**
  The fit case now asserts the measurement is non-empty before the bounds checks, so an empty
  panel fails instead of passing on `Infinity` sentinels.
- **low · fallback** `e2e/mobile.spec.ts:46`  
  (Fixed: all five call sites go through `resolveTestNotebook`, so the value is verified once, in one place.)
- ~~**low · test-quality** `e2e/mobile.spec.ts:242`~~ **fixed**
  The toolbar-open case now asserts the open state persists (re-query after a settle wait),
  not just immediate visibility.
- ~~**low · test-quality** `e2e/mobile.spec.ts:117`~~ **fixed**
  The task assertion targets the plugin's own `.taskbox`, not any checkbox on the page.
- ~~**low · bug** `e2e/mobile.spec.ts:40`~~ **fixed**
  Cleanup failures throw like every other suite — no more silent `.catch(() => {})`.
- ~~**low · dead-code** `e2e/mobile.spec.ts:5`~~ **fixed**
  The three unused imports (`mobileUrl`, `waitMobileReady`, `openPluginMobile`) are deleted.
- **low · test-quality** `e2e/theme.spec.ts:41`  
  The engine guard in `pluginThemeSelectors` reads only the TOP-LEVEL rules of the plugin sheet (`rules.map(r => r.selectorText)`), so a theme-conditional rule nested in `@media` / `@supports` / `@container` is invisible to a case whose comment claims to check every theme-conditional rule in the shipped stylesheet. Today all of them are top level, so the gap is latent.
- ~~**low · test-quality** `e2e/viewstate.spec.ts:123`~~ **fixed**
  The theme click is guarded by the active-swatch `.on` marker (before/after/round-trip) —
  a no-op click fails instead of riding through as "kept".
- ~~**low · docs** `e2e/viewstate.spec.ts:121`~~ **fixed**
  The comment names the 5th of 8 swatches (index 4) and the assertion message names the theme
  dropdown (index 2 is theme, verified against the label order).

### i18n-consistency

- **low · docs** `docs/TESTING.md:568`  
  The quoted size of the language allowlist contradicts the file and the same document's own figure eight paragraphs earlier.
- **low · docs** `docs/pitfalls/plugin.md:17`  
  The table says the i18n directory file name must be BCP47 hyphenated (zh-CN.json), but the repository ships and packages i18n/zh_CN.json with underscores, and the kernel accepts (indeed prefers) that name - so the documented rule contradicts the shipped artifact and AGENTS.md section 2.
- ~~**low · language** `src/plugin/i18n/zh_CN.json:147`~~ **fixed**
  Three keys sharing one English word carried two Chinese words; `phUntitled` unified to 未命名
  (same state as `phUntitledDoc`).
- **low · language** `src/plugin/i18n/zh_CN.json:73`  
  lblEmptyNode is the short half of a short/long pair whose long half is exactly '(empty node)'/'(空节点)', but its Chinese value IS the long form (with full-width parentheses), so English shows '(empty)' and Chinese '（空节点）' in the same slot and the two zh entries differ only in parenthesis width.
- ~~**low · ux** `src/plugin/outline/Outliner.tsx:4524`~~ **fixed**
  A per-node context-menu entry that toggles ONE node's subtree was labelled with the global strings
  cmdExpandAll/cmdCollapseAll ('Expand all'/'Collapse all'), while tipExpandNode/tipCollapseNode exist and
  were already used for the same action on the toolbar. Now uses the per-node keys; case in
  `e2e/ctxmenu.spec.ts` shown red against the old label.
  ★ Two things had to be measured before the fix could be trusted: the entry renders only for a node with
  children, and it belongs to the **outline's** menu —— `Mindmap.tsx` renders a menu with the same class
  names and no collapse entry, so a case written against the mind map found eight items on every node and
  would have proved nothing. The first attempt at the case did exactly that.
- ~~**low · test-quality** `src/plugin/paragraphs-ui.test.ts:52`~~ **duplicate of the medium entry above**
  Same file, same claim (replica drift); covered by the same fix. Struck to keep one record.

### mindmap

- **low · docs** `docs/SHORTCUTS.md:52`  
  The user-facing shortcut doc promises two mind-map mouse behaviours the code does not implement: a single click jumping back to the outline and locating the node, and a double click focusing the branch.
- **low · type-escape** `src/mindmap/Mindmap.tsx:241`  
  Stored preferences are cast to `Record<string, never>` instead of being validated, so any JSON in localStorage flows into structure/themeIdx/lineStyle/shape as if it had the declared type.
- ~~**low · dead-code** `src/mindmap/Mindmap.tsx:79`~~ **stale — already fixed before this pass**
  No `data-theme` reference remains (verified: only `data-theme-mode` at 55/63/68/71, matching
  what SiYuan actually sets — the theme E2E asserts exactly this).
- ~~**low · bug** `src/mindmap/Mindmap.tsx:1621`~~ **already fixed before this pass**
  All four empty-paragraph paths strip `\u200b` before comparing (878, 1587, 1636, 1764) —
  one rule on every path, verified by grep.
- ~~**low · bug** `src/mindmap/Mindmap.tsx:968`~~ **fixed**
  PNG export failures now report via an optional `onError` callback (null `toBlob` on over-large
  canvas, `img.onerror`, missing 2d context), wired to `showMessage` in `mount.ts`; new `errExportPng`
  key in both catalogues. A component-level toast would need new surface — the callback follows the
  file's own optional-callback pattern and the dead-props gate covers it.
- ~~**low · dead-code** `src/mindmap/Mindmap.tsx:19`~~ **fixed**
  The named re-export list duplicated `export *` with zero importers (verified: only the default
  import is used). Deleted.
- ~~**low · test-quality** `src/mindmap/structure-order.test.ts:192`~~ **fixed**
  The distinctness check reads the parsed `labels` (source + catalogue), not the test's own literal.

### plugin-code

- **low · docs** `docs/TESTING.md:568`  
  The documented size of the language allowlist no longer matches the file or the tool's own output.
- **low · dead-code** `src/plugin/index.ts:13`  
  The static `openTab` import is never used - openMindmapTab shadows it with a runtime `await import('siyuan')`, so the top-level import is dead (tsc has no noUnusedLocals).
- ~~**low · fallback** `src/plugin/index.ts:212`~~ **fixed**
  The `document.title.split(' - ')` derivation is removed: the callee ignores `title` (verified:
  `appendMirrorBlock` never reads `_opts.title`), so the truncation vector is gone, not papered over.
- ~~**low · docs** `src/plugin/index.ts:248`~~ **fixed**
  The stale comment (sample-data fallback, removed `ws.app` structure) is replaced with the true
  one-liner: implementation lives in `active-doc.ts`.
- ~~**low · ux** `src/plugin/outline/Outliner.tsx:918`~~ **fixed**
  Toggling the find bar shut now routes through `closeFind`, restoring focus like every other
  close path (verified: all three `openFind` call sites are toggles; typecheck + unit green).
- ~~**low · dead-code** `src/plugin/outline/indent.test.ts:63`~~ **fixed**
  The shadowing module-level copy is removed; the documented narrowing rationale now lives on the
  one remaining use site.
- ~~**low · test-quality** `src/plugin/outline/touch-longpress.test.ts:275`~~ **fixed**
  The vacuous 'criterion itself is effective' block (literals asserting themselves) is deleted; the
  real fnBody-against-source checks stay.
- ~~**low · test-quality** `src/plugin/source-probe.ts:52`~~ **stale — parser-based**
  The stripper uses the TypeScript compiler's own trivia ranges (verified by read); no hand scanner remains.

### plugin-tests-a

- **low · docs** `docs/pitfalls/editor.md:82`  
  The §2.3 entry 'Paired reverse keys (Backspace / Delete)' points its Test line at a file that has no key-handling coverage at all.
- ~~**low · test-quality** `src/plugin/echo-own-value.test.ts:85`~~ **fixed**
  Post-expiry assertions exercise the real `Date.now() > until` branch (white-box backdate) plus
  `prune()` drop/keep behavior — the heading's behavior is now tested.
- ~~**low · test-quality** `src/plugin/hotkey-collision.test.ts:72`~~ **fixed**
  Corrupt vs missing snapshots report distinctly, and the spot-check pins `⌥⌘M` (verified live
  as occupied) instead of skipping when no `⌥⌘` key is found.
- **low · docs** `src/plugin/kernel-side-effects.test.ts:4`  
  The authority for these tests is cited as a gitignored development diary, so the measured facts behind the assertions are unreadable to anyone else (the same citation is used across the plugin tests).

### plugin-tests-b

- ~~**low · type-escape** `src/plugin/mobile-swipe.test.ts:74`~~ **fixed**
  Both components render with real props (no `as never`), stale `summaryData`/`linkLines` dropped,
  missing `modified` added, and the cannot-fail hand-walk third case is deleted.
- ~~**low · test-quality** `src/plugin/node-id-block-id.test.ts:78`~~ **stale — asserts parsed state**
  Lines 70-90 assert counts and mappings out of the parsed DOM (verified by read); the cited
  literal shape is not present.
- ~~**low · dead-code** `src/plugin/stale-mapping.test.ts:72`~~ **stale — already fixed before this pass**
  Lines 68-76 hold live assertions on `deadMappingSuspects` (verified by read); no unused locals.
- ~~**low · docs** `src/plugin/tree-ops.test.ts:8`~~ **fixed**
  The Run line points at the sanctioned runner (`python3 scripts/run-tests.py tree-ops`).
- ~~**low · test-quality** `src/plugin/zoom-title-sync.test.ts:38`~~ **stale — tool lists nothing**
  The vacuous-test gate reports zero unreaching files (verified by run); the cited shape is gone.

### scripts-gates

- **low · docs** `docs/TESTING.md:568`  
  The numbers describing scripts/audit-language.py no longer match the tool: the allowlist has 12 tokens and no path:line entries (not '391 tokens (186 fixture, 164 i18n, 41 kernel) plus 5 path:line'), a clean run is 199 tracked / 178 scanned / 21 skipped (not 196/175/21), and the run reports code 0 and 24 regex occurrences (not 'code, currently 6' and 25).
- ~~**low · bug** `scripts/audit-language.py:385`~~ **fixed**
  The Python scanner reported only the first CJK run per constant while the JS scanner reports
  every run. Now maps each run through the source (with escape fallback); pinned by selftest case
  36, which discriminates old vs new logic. The fix surfaced 2 real second-runs, both resolved
  (ledger wording reworded, unverifiable kernel quote removed).
- ~~**low · dead-code** `scripts/audit-privacy.py:171`~~ **fixed**
  The unused `label` parameter is removed from `check_patterns` and all four call sites
  (verified: privacy selftest green).
- ~~**low · docs** `scripts/audit-privacy.py:156`~~ **fixed**
  Oversized artifacts are counted and printed (`N skipped as oversized — unread, not clean`)
  instead of silently dropped.
- ~~**low · dead-code** `scripts/check.py:155`~~ **stale — machinery is live**
  The `report_only` branch at line 366 reads per-gate config; no gate sets the key today, but that
  is configuration, not dead code — the branch runs the moment one does. Verified by read.
- ~~**low · docs** `scripts/redproof.py:253`~~ **stale — log is written**
  The log file is created at line 269 (`LOG_DIR.mkdir` + per-file path) before the printed path;
  the docstring matches. Verified by read.
- ~~**low · dead-code** `scripts/run-e2e.py:66`~~ **already fixed before this pass**
  (The key is read through `env.py` and the line is gone — the entry point validates it and passes
  it explicitly. Verified: lines 62-75 read token, browser, and notebook through `cfg` with
  fail-fast validation.)
- **low · docs** `scripts/run-e2e.py:62`  
  The CI E2E job passes the address and a credential as job inputs, but this entry point overwrites both from .env's isolated instance and CI never creates a .env, so the job cannot run as written and those two secrets are dead configuration.
- ~~**low · bug** `scripts/run-tests.py:83`~~ **fixed**
  Watch mode keeps `--test-concurrency=1` like normal mode.
- ~~**low · dead-code** `scripts/script_log.py:124`~~ **fixed**
  The unreachable `callable(owner)` chain and its table are removed; the comment now states why no
  chaining exists (verified: timings report still works).
- ~~**low · test-quality** `src/plugin/css-scope.test.ts:22`~~ **fixed**
  The promised keyframe cases exist now, and `scopeSelector` carries a keyframe-stop guard so a
  future postcss routing change cannot corrupt `@keyframes` (measured: current postcss never routes
  stops through `transform`; build output still fully scoped).

### scripts-infra

- **low · bug** `scripts/cdp.py:78`  
  list_tabs() returns [] for every exception, so 'the CDP endpoint is unreachable' is indistinguishable from 'the browser has no tabs' and close_stale_tabs then reports that nothing needed cleaning.
- ~~**low · ux** `scripts/deploy.py:111`~~ **fixed**
  Real runs now print the target list and count before copying (the `--list` branch already did;
  the finding was about actual deploys). Zero-target is unreachable — `plugin_dirs` raises on empty.
- ~~**low · bug** `scripts/env.py:341`~~ **fixed**
  `token()` turned every conf.json read failure into an empty string. Now raises `RuntimeError`
  naming the path and the real error, like the sibling `test_token()` (verified live: malformed
  JSON raises with path + cause; normal path still returns the token).
- ~~**low · bug** `scripts/env.py:318`~~ **fixed**
  A `PLUGIN_DIRS` with no usable entry (`:`, ` `, `::`) passed `_require()` and yielded an empty
  deploy-target list. Now raises naming the bad value (verified: `PLUGIN_DIRS=:` raises).
- ~~**low · docs** `scripts/env.py:311`~~ **fixed**
  The `plugin_dirs` docstring promised a derivation fallback the code never implemented. Docstring
  corrected to the actual contract (required key, fails loudly when empty).
- ~~**low · dead-code** `scripts/env.py:357`~~ **fixed**
  `test_build_url()` had zero callers (verified by grep across py/ts). Deleted; `build_url()`
  (4 callers) stays.
- ~~**low · test-quality** `scripts/verify-host-style.py:36`~~ **moot — script deleted**
  The file is gone (duplicate of `verify-live.py`'s UI-TC-02); nothing to fix in it.
- ~~**low · docs** `scripts/verify-host-style.py:4`~~ **moot — script deleted**
  Same deletion as above; the docstring is gone with the file.
- ~~**low · bug** `scripts/verify-pkg.py:22`~~ **fixed**
  Paths resolved from the cwd instead of `__file__`. All four anchored at `ROOT` (verified: runs
  green from `/tmp`).

### scripts-live

- ~~**low · dead-code** `scripts/clean-test-instance.py:1`~~ **fixed**
  The leftover report in `run-e2e.py` now points at the cleaner
  (`python3 scripts/clean-test-instance.py --delete`), so the remedy is discoverable where the
  problem surfaces.
- ~~**low · fallback** `scripts/mindmap-shot.py:33`~~ **stale — already fixed before this pass**
  The URL comes from `env.cfg.cdp_host/cdp_port` (verified by read); the finding predates the
  env.py consolidation.
- ~~**low · bug** `scripts/mindmap-shot.py:130`~~ **fixed**
  Rejected probe connections are collected and closed (winner + fallback paths).
- ~~**low · bug** `scripts/perf-probe.py:40`~~ **fixed**
  Imports resolve from `__file__`, not the cwd (verified: `--help` runs from `/tmp`).
- ~~**low · dead-code** `scripts/record-demo.py:47`~~ **fixed**
  The orphaned second docstring (contradicting the real timer mechanism) and its duplicated
  import block are removed; the surviving header documents the timer correctly.
- ~~**low · bug** `scripts/snapshot-keymap.py:56`~~ **fixed**
  The walk prefers `default` over `custom`, so personal bindings never enter the built-in fixture
  (collision test still green).
- ~~**low · fallback** `scripts/test-instance.py:233`~~ **fixed**
  A missing digest now logs a loud skip warning instead of silently trusting the transfer.
- ~~**low · bug** `scripts/test-instance.py:468`~~ **fixed**
  The PID file is written only after the new kernel answers, and readiness requires our process
  alive (not just the port answering); on failure the previous tracking is restored.
- ~~**low · dead-code** `scripts/verify-android.py:126`~~ **refuted in writing**
  The branch fires when `--serial ""` is passed explicitly (bypassing the required
  `ANDROID_SERIAL`): `serial or cfg.android_serial` is empty, so auto-select is the only path.
  Verified by read of the constructor chain.
- ~~**low · docs** `scripts/verify-android.py:652`~~ **fixed**
  Help texts name the `.env` keys (`ANDROID_SERIAL`, `ANDROID_BROWSER_PKG`, `ANDROID_CDP_PORT`)
  instead of the stale literal defaults.
- ~~**low · docs** `scripts/verify-android.py:44`~~ **fixed**
  The example passes a directory (matching `-o/--output-dir` + hardcoded `manual_shot.png`).
- ~~**low · dead-code** `scripts/verify-android.py:193`~~ **fixed**
  Uncalled `input_key()`/`tap()` (and their keycode tables) deleted; scenarios drive input via CDP.
- ~~**low · test-quality** `scripts/verify-live.py:90`~~ **fixed**
  The icon check now fails when zero `svg[fill="none"]` exist (`total == 0` is a failure, not a pass).
- ~~**low · bug** `scripts/verify-live.py:410`~~ **fixed**
  The tab opens on a readiness expression instead of a fixed 30s sleep.
- ~~**low · bug** `scripts/verify-live.py:289`~~ **fixed**
  Theme state is captured before the swap and restored (stylesheet, attribute, modeOS) in a
  `finally` on every path.

### siyuan

- ~~**low · test-quality** `src/siyuan/api.ts:249`~~ **fixed**
  `uploadAsset` performed its own request with the global `fetch` instead of `this.fetchImpl`, so the
  documented test-injection seam did not cover the image-migration path —— the one place that writes a file
  into the workspace was the one place a test could not substitute or break. Now uses `fetchImpl`, with
  `src/siyuan/upload-asset.test.ts` covering it: 13 assertions over the endpoint, the error path, and the
  multipart body (including that the path sits under `data/assets/` —— `assets/...` is accepted with
  `code: 0` but lands where SiYuan never looks). Shown red by restoring the global `fetch`.
- ~~**low · dead-code** `src/siyuan/api.ts:602`~~ **read and answered**  
  Six exported members of the kernel client have no caller anywhere in src/, scripts/, e2e/ or docs/: resolveTokenFromConfig, listNotebooks, createNotebook, moveDocs, getBlockAttrs, setBlockAttrs.
  Verified again as accurate (0 call sites each, checked with `.name(`), and then read individually rather
  than deleted as a batch. **None is the `saveNodes` shape**, whose test is "does a user-visible surface
  promise the capability?" —— checked across `src/plugin/i18n/*.json`, `docs/FEATURES.md` and both
  `GETTING-STARTED` files, and no for all six. Five of them (`listNotebooks`, `createNotebook`, `moveDocs`,
  `getBlockAttrs`, `setBlockAttrs`) are one-line pass-throughs to real kernel endpoints whose comments
  describe the **endpoint**, not a plugin promise —— a client reference, which is what a dead method cannot
  be mistaken for. They stay, and the reasoning is recorded in `docs/TODO.md`. `resolveTokenFromConfig` is a
  different case and is covered by its own note below, since it reads a file rather than calling an endpoint.
- ~~**low · bug** `src/siyuan/store.ts:1929`~~ **already fixed before this pass**
  `this.pendingPlaceholders` no longer exists: `beginPlaceholderScope()` returns a caller-owned set
  and both `syncStructure`/`moveNodes` require it (compile error if forgotten). Verified by grep —
  zero hits for the field, both call sites in `mount.ts` pass caller-owned sets.
- ~~**low · dead-code** `src/siyuan/store.ts:1513`~~ **fixed**
  `syncParagraphs` ended with `this.lastListItems.delete(`paras:${liId}`)`, and **nothing ever wrote a
  `paras:`-prefixed key** —— all seven `lastListItems.set` sites use a node ID (or `ownerNode`), and every
  read does too, so it deleted a key that could not exist while claiming to invalidate a paragraph cache
  "so the next round re-reads". The state that actually matters is `nodesWithParas` (a `Set<string>` keyed
  by node ID, updated a few lines above), which the next `loadBlockMap` reads. Comment corrected; the same
  shape as `saveNodes`, where a comment made dead code look load-bearing.
- ~~**low · bug** `src/siyuan/store.ts:2845`~~ **fixed**
  `listFolders` shadowed the module-level i18n function with `const t = Date.now();` —— the exact pitfall the
  project documents. Renamed to `stamp`. ★ Fixing it exposed **two more** of the same shape
  (`store.ts`'s `norm` helper, `Outliner.tsx`'s marquee rectangle), and there is no ESLint here, so
  `no-shadow` cannot be switched on: the rule is now a gate, `scripts/check-i18n-shadow.py`.
- ~~**low · dead-code** `src/siyuan/store.ts:2339`~~ **fixed**
  Several store methods had no call site at all. `resolveListItem` (61 lines) and `findAnchor` (25 lines) were
  `private` and called from nowhere, so they were deleted outright —— but **their doc comments were absorbed
  first**: `resolveListItem` recorded a measured silent-data-loss incident (after an insert the SQL index had
  not caught up, so a single query answered `self: null` ten times, the fallback found no child `listItem`,
  the resolver returned `''`, the node's "node ID → block ID" mapping was never registered, and the next
  write-back re-inserted the batch —— the UI showed 7 nodes and **0 landed in SiYuan**, with no error). It now
  lives in `docs/kernel-api.md` §7.3, next to the rule it justifies. The rest of the list is tracked by
  `scripts/check-dead-methods.py`, which is a **strict** gate.
- ~~**low · docs** `src/siyuan/store.ts:2742`~~ **fixed**
  `setHeadingTitle`'s doc comment justified the method with a state of `loadDoc` that no longer exists,
  presenting the `# heading` lookup as how `loadDoc` reads the title when that lookup is now only a fallback.
  Comment corrected. ★ The method itself is **live** —— `mount.ts` calls it on every zoom-title sync. It had
  been reported as dead code because the call is written `store?.setHeadingTitle(...)` and the checker's
  pattern did not allow optional chaining (fixed, with the gap recorded in `docs/TODO.md`).
