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
| entries in this file | **206** (16 fixed or refuted, counted by `check-audit-findings.py`) |
| severity | 137 low, 69 medium |
| by category | test-quality 63, docs 51, dead-code 34, bug 34, fallback 8, type-escape 7, language 5, ux 4 |

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
- **medium · type-escape** `tsconfig.json:15`  
  `include: ["src"]` is the whole scope of the only type gate, so the two build config files at the repository root are never compiled either — including a property the config type does not have, verified by a controlled probe.

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

- **medium · test-quality** `e2e/mindmap.spec.ts:199`  
  Both fit cases (161 and 199) assert only 'the content is inside the canvas after clicking 适应', but the plugin auto-fits whenever the map mounts or its size changes, so the criterion holds whether or not the button is wired; the case also claims to pin the measured scale factor, which no assertion reads.
- **medium · test-quality** `e2e/mindmap.spec.ts:322`  
  'buttons in the settings bar are always reachable by scrolling' cannot fail for the defect it names: the bar no longer scrolls horizontally, and Playwright's toBeVisible is true for an element clipped inside an overflowing container — so the case now only asserts that three buttons exist, while its comment still describes the pre-fix product.
- **medium · test-quality** `e2e/mindmap.spec.ts:481`  
  Two of the three @container cases depend on the environment's current right-dock width being narrow; a dock that the user dragged wider turns them red at the precondition, which this same file documents as worthless.
- **medium · test-quality** `e2e/outline.spec.ts:680`  
  The batch-indent case's only assertion is that the row count did not change, so a no-op 缩进 passes — the criterion cannot see the level change the case is named for.

### e2e-specs-b

- **medium · test-quality** `e2e/ctxmenu.spec.ts:170`  
  The case named `"Add sibling node" inserts a node at the same level` asserts only the node count, so an implementation that inserted a CHILD (or a node anywhere else) passes — the level half of the claim has no assertion.
- **medium · test-quality** `e2e/keyboard.spec.ts:106`  
  Both mind-map insertion cases are named for the level they create ("Tab adds one child node", "context menu: adding child node really adds a node") but assert only `before.nodes + 1`, so a child/sibling swap stays green. Line 106 is the Tab case, line 162 the context-menu case.
- **medium · test-quality** `e2e/keyboard.spec.ts:197`  
  The only assertion for "returning to the full map restores it" — the regression test docs/pitfalls/wiring.md names for the unpassed-prop defect — sits inside `if (await back.count())`, so if the menu item is ever absent the case silently drops half of its claim and still passes.
- **medium · test-quality** `e2e/mobile.spec.ts:231`  
  The mind-map half of "both the mobile outline and mindmap containers set data-prevent-swipe" is wrapped in a visibility `if` with a swallowed error, so when the view switch is not visible the canvas assertion never runs and the case still passes.
- **medium · test-quality** `e2e/smoke.spec.ts:79`  
  The "plugin is mounted" smoke case asserts `.om-dock` — the exact signal this repository documents as invalid (it exists only while the panel is open AND the outline view is the mounted one) — and takes `.first()`, the selector form the same note forbids.
- **medium · type-escape** `tsconfig.json:15`  
  No gate compiles e2e/**` : `npm run typecheck` (the only type gate in `npm run check` and in CI) is `tsc --noEmit` against a tsconfig whose include is `["src"]`, so the specs in this scope carry type errors that nothing ever reports.

### i18n-consistency

- **medium · dead-code** `scripts/check-i18n-keys.py:125`  
  The i18n gate reports 'ok (every entry is used)' while six catalogue entries are dead text: its referenced() fallback accepts ANY run of two or more CJK characters of an entry's zh value found anywhere in e2e/ or docs/, so unrelated prose - and a different key's value - rescues entries no code names.
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

- **medium · language** `src/plugin/i18n/zh_CN.json:127`  
  Three catalogue entries double the escape: the raw JSON contains a backslash-backslash-n (and one backslash-backslash-u2019), which decodes to a literal backslash plus letter instead of a line break / a curly apostrophe, so the user is shown '\n' and '\u2019' as text.
- ~~**medium · bug** `src/plugin/mount.ts:2311`~~ **fixed**
  The mind-map write path fires `writeLatest()` with no echo-guard window and no `.catch`, so a failed write-back became an unhandled rejection whose message never reached the error bar. Every other write path surfaces failures through `setErr(describeWriteError(e))`; this call site is fired from a callback with no `await`, so the rejection had to be handled there. Now `.catch`es into the same path, which renders into `.om-mm-err`. ★ The entry said "two write paths" —— there is one such call site (`void ... | rg` over the file); the other must have been removed earlier, and the citation was re-pointed after an edit moved it.
- ~~**medium · dead-code** `src/plugin/mount.ts:2061`~~ **fixed**
  The @-mention button now hides when `docs` is empty (which mount always passes) instead of
  offering an empty search panel (verified: typecheck clean, no test references the button).

### plugin-tests-a

- **medium · test-quality** `src/plugin/attr-triple.test.ts:39`  
  Six of the file's nine checks assert a stub written in this file that returns an empty object by construction, so the 'the attribute write table is always empty' invariant cannot fail; only the kramdown block tests real code.
- **medium · test-quality** `src/plugin/blockmap-namespace.test.ts:46`  
  MapModel re-implements SiYuanStore.loadBlockMap and the file mirrors only one of its two retention branches; the preferred getBlockDOM branch has different retention semantics, so the headline claims are not invariants of the shipped method.
- **medium · test-quality** `src/plugin/empty-node-echo.test.ts:52`  
  The invariant the file claims to guard is between two implementations, but the mind-map side is a copy pasted into the test, so drift in mount.ts's normaliser keeps the test green.
- **medium · test-quality** `src/plugin/kernel-side-effects.test.ts:31`  
  The file is a set of assertions about mock functions and object literals defined inside the same block, so no check can go red; one check even invents a hypothesis string and asserts it contains a substring of itself.

### plugin-tests-b

- **medium · test-quality** `src/plugin/map-coverage-guard.test.ts:20`  
  The test re-implements the guard instead of reading it, so a threshold change in store.ts leaves it green, contradicting the file's own claim that it pins that criterion.
- **medium · test-quality** `src/plugin/minify-tdz.test.ts:58`  
  When dist-plugin/index.js is absent the only real assertion is skipped and the file still exits 0, so the minifier-TDZ guard reports a pass having asserted nothing; neither `npm test` nor `npm run check` builds first, and dist-plugin/ is gitignored, so on a fresh checkout the guard is dead.
- **medium · test-quality** `src/plugin/paragraphs-ui.test.ts:52`  
  The replicated hover-tooltip text already disagrees with the i18n catalogue the product actually renders from, so section 3 asserts a string the plugin no longer produces.
- **medium · test-quality** `src/plugin/ref-nav.test.ts:57`  
  The regression test for defect #57 asserts the pre-fix state using an empty array literal, so it cannot fail and it documents a bug that is already fixed as if it were live.
- **medium · test-quality** `src/plugin/undo-merge-kind.test.ts:14`  
  The merge window is a copy of the product constant with no source assertion, so the boundary cases assert a window the product may no longer have.

### scripts-gates

- **medium · dead-code** `scripts/audit-language.py:521`  
  The i18n-fallback recognition is unreachable: _string_kind() only ever returns 'string' or 'assertion', so the branch that counts notes['i18n-fallback'] and the summary line that prints it can never fire - a leftover of the rule that was removed when the t(key, vars, fallback) arguments were deleted.
- **medium · test-quality** `scripts/audit-privacy.py:374`  
  The selftest case named 'the same id in product code is not excused' does not test the excusal boundary at all: it asserts that src/siyuan/store.ts contains no id-shaped literal, which is true both when the file is missing (read_lines returns []) and when the excusal rule is deleted - and the `product` result it computes is thrown away.
- **medium · test-quality** `scripts/check-docs-index.py:36`  
  Range expansion never fires: LONG_RANGE expects '1.1-1.10' inside ONE backtick span, but docs/PITFALLS.md writes ranges as `1.1`-`1.10` (the en dash between two spans), so expand() only ever sees the two endpoints and the middle of every advertised numeric range is never verified.
- **medium · test-quality** `scripts/verify-css-scope.py:50`  
  The release gate that forbids unscoped selectors parses CSS with a regex comment stripper plus a brace counter, so a '/*' or a '{' inside a CSS string can delete real rules from the input (an unscoped selector then passes) or invent a selector that is not one - the hand-rolled analysis AGENTS.md section 7 forbids, where postcss is already a devDependency.

### scripts-infra

- ~~**medium · bug** `scripts/cdp.py:176`~~ **fixed**
  `send()` discarded the CDP `error` member and `ev()` discarded `exceptionDetails`. Fixed in
  both `scripts/cdp.py` and the `record-demo.py` copy: CDP errors raise `RuntimeError`, and the
  exception is carried on the result dict (the real CDP shape puts `exceptionDetails` top-level,
  which `ev` would otherwise strip before seeing it — caught by the selftest, not by reasoning).
  Pinned by `python3 scripts/cdp.py --selftest` (5 cases, fake websocket, no browser).
- **medium · bug** `scripts/env.py:69`  
  A quoted value followed by an inline comment keeps its quote characters, so the configured path is silently wrong -- the exact silent-wrong-target failure AGENTS 5.1 forbids -- while the docstring claims quotes and comments are supported.
- **medium · dead-code** `scripts/env.py:160`  
  The entire SIYUAN_SRC feature is dead: no code reads siyuan_src, require_siyuan_src, SIYUAN_SRC_MARKERS or the SIYUAN_SRC default, yet .env.example documents the key and promises that checks needing the source 'skip and say why'.
- **medium · dead-code** `scripts/verify-host-style.py:1`  
  Nothing invokes this script and its body is a second implementation of the UI-TC-02 criterion that already exists in verify-live.py, so the two have drifted and no gate covers either copy.
- **medium · test-quality** `scripts/verify-pkg.py:6`  
  The package check compares only version strings and file names, so it blesses whatever package.zip happens to be lying there -- today it reports 'Checks passed, ready to release' for a zip that is not the current build.

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
- **low · docs** `scripts/env.py:27`  
  The module docstring documents a three-tier precedence with built-in defaults, but Config.get() only consults os.environ and the .env file — no defaults tier is reachable through it (DEFAULTS is merged into _values() instead), and the same 'there are no built-in defaults' promise is repeated in .env.example.

### core

- **low · docs** `docs/ARCHITECTURE.md:146`  
  The architecture doc still documents the markdown-by-default / DOM-when-styled decision tree; the code has routed everything through the DOM path for a while.
- **low · dead-code** `src/core/blockdom.ts:164`  
  `paragraphBlockDom` is exported for `insertParagraphAfter` but no shipped code calls it; the real call site builds the same paragraph DOM inline, five times over, in a slightly different shape.
- **low · test-quality** `src/core/empty-span.test.ts:57`  
  For the `<span>\u200b</span>` variant the "the || fallback really took effect" assertion is satisfied by the placeholder inside the un-stripped span, so it passes on the broken code the file exists to catch.
- **low · test-quality** `src/core/layout.test.ts:90`  
  Two different colour invariants share one accumulator, so the two checks can never disagree and each one can report the other's failure — a red run no longer says which invariant broke.
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
- **low · docs** `docs/TESTING.md:32`  
  The doc sends the reader to playwright.config.ts for the /usr/bin/chromium executablePath; the config has no such value, and the literal that does exist (e2e/global-setup.ts) is both the `process.env.X || '<literal>'` shape AGENTS 5.1(3) forbids and unreachable in any real run.
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
- **low · docs** `docs/pitfalls/testing.md:502`  
  An entry carries the id '6.x', which is not a stable id and is the one entry missing from the PITFALLS.md index.

### e2e-helpers

- **low · docs** `docs/TESTING.md:32`  
  The E2E section still tells the reader to 'Use the system `/usr/bin/chromium` (`executablePath` in `playwright.config.ts`)', which is both a stale description of the code and a machine absolute path in a developer doc (section 1).
- **low · dead-code** `e2e/fixtures.ts:76`  
  openSiYuan's `opts: { url?: string }` option plus its `opts.url ?? '/'` default is never exercised: the only caller passes no argument, so the third way to decide which URL is opened is untested surface sitting in a file whose header says the target must have exactly one source.
- **low · dead-code** `e2e/mindmap.ts:31`  
  `const view = page.locator('.om-mm-viewswitch');` is declared at the top of ensureDockOpen and never read again; the function asks the same question through page.evaluate (the point of the surrounding comment), so this line is a leftover locator.
- **low · dead-code** `e2e/mobile.ts:25`  
  MOBILE_VIEWPORT is exported, documented as the viewport the mobile suite uses, and never read - the suite's real viewport comes from `devices['iPhone 12']` in mobileContext, so the constant is a second, unread copy of that fact.
- **low · dead-code** `e2e/outline.ts:71`  
  Three exported helpers are called by nothing (typeInNode, pressKeyInNode, clickBullet), each carrying its own selector that can rot unnoticed - the same failure this file already documents for a fourth one.
- **low · test-quality** `e2e/outline.ts:40`  
  ensureOutlineReady's criterion counts every `.node-row` including the empty placeholder row, while its message claims a real node row - so the precondition passes when the outline rendered no content, the family of vacuous pass the ledger records as more dangerous than a false failure.
- ~~**low · dead-code** `e2e/testdoc.ts:279`~~ **fixed**
  `SPECIAL_TOP` is now imported by `export.spec.ts` (the bare-literal and round-trip assertions
  read the fixture), so export and assertion cannot drift apart.
- **low · bug** `e2e/themes.ts:172`  
  restoreTheme is documented as 'Put the instance back the way it was found' but neither of its two effects restores anything: `mode` defaults to the literal 'light' rather than the mode it found, and useTheme's forced `modeOS: false` (which it needs to make the switch real) is never written back, so a run permanently clears 'follow the system' on the shared instance.

### e2e-specs-a

- **low · fallback** `e2e/mindmap.spec.ts:61`  
  sidesByBranch identifies the root by 'the first node whose text does not start with a branch name' — not the criterion its own comment states — and the `?? info[0]` fallback hides a failed detection; it is correct today only because the layout happens to emit the root first.
- ~~**low · bug** `e2e/mindmap.spec.ts:888`~~ **fixed**
  Both download cases now `await Promise.all([waitForEvent, click])`, so a failed click rejects
  the wait with it instead of stranding an unhandled rejection 30s later.
- **low · test-quality** `e2e/outline.spec.ts:219`  
  The write-back probe queries the whole instance for a fixed marker, so any paragraph containing it anywhere satisfies the poll — including a temp document left behind by an earlier failed run — instead of the document under test.
- **low · test-quality** `e2e/outline.spec.ts:107`  
  firstParentBullet returns -1 for a missing precondition and this caller does not check it; a negative index selects the last row, so the case would silently zoom an unrelated (leaf) row and could still pass.
- **low · fallback** `e2e/outline.spec.ts:202`  
  `notebook || (await resolveTestNotebook(api))` is an unreachable fallback of exactly the `X || <fallback>` shape AGENTS §5.1.3 forbids; if it ever ran, the temp document would be created in a notebook resolved by a name heuristic instead of failing.
- **low · test-quality** `e2e/outline.spec.ts:184`  
  The typing case mutates the shared test document and removes its marker only on the success path, so a failing assertion leaves the fixture dirty — the exact hazard testdoc.ts exists to remove.

### e2e-specs-b

- **low · docs** `e2e/ctxmenu.spec.ts:16`  
  The file header states the menu has 7 items while the file's own case asserts exactly 8, so the header is stale (it also disagrees with the enumerated list in the same sentence).
- **low · test-quality** `e2e/dragdrop.spec.ts:177`  
  The "written back to SiYuan" criterion compares `topLevelTexts` with the UI list **filtered by DB membership**, so a node that disappeared from the kernel still compares equal — the assertion is one-directional and cannot see data loss.
- ~~**low · dead-code** `e2e/dragdrop.spec.ts:213`~~ **fixed**
  The kernel-order assertion compares against the kernel's own order instead of a hardcoded
  name list whose 丙/丁 entries this fixture never holds.
- **low · docs** `e2e/export.spec.ts:230`  
  The comment above the determinism case allows variation the assertion forbids: it says a little variation (timestamps and the like) is acceptable while the criterion is exact string equality.
- **low · type-escape** `e2e/interactions.spec.ts:1`  
  `type Page` is imported from `./fixtures`, which does not export it (TS2459); the import is erased at runtime, so nothing complains and the specs' helper signatures are typed by a symbol that does not exist.
- **low · test-quality** `e2e/interactions.spec.ts:146`  
  The fit case's bounds check passes vacuously when no node was measured: the accumulators stay at `Infinity`/`-Infinity`, which satisfy both comparisons (the 0-satisfies-toBeLessThan(N) family this repo records as more dangerous than a false failure).
- **low · fallback** `e2e/mobile.spec.ts:46`  
  (Fixed: all five call sites go through `resolveTestNotebook`, so the value is verified once, in one place.)
- **low · test-quality** `e2e/mobile.spec.ts:242`  
  The case `the mobile narrow-screen format toolbar toggles open and keeps its state` never tests the state being kept: the only assertion is that the toolbar is not collapsed immediately after opening it.
- **low · test-quality** `e2e/mobile.spec.ts:117`  
  The "toggle task status" criterion counts checkboxes over the whole document with one selector that cannot match anything and one that is unbounded, so the case cannot distinguish "the plugin's task box appeared" from "some checkbox exists somewhere".
- **low · bug** `e2e/mobile.spec.ts:40`  
  The temp-document cleanup swallows its own failure, so a document that could not be deleted is left in the notebook with nothing said — the opposite of the other suites, whose afterEach lets removeDoc throw.
- **low · dead-code** `e2e/mobile.spec.ts:5`  
  Three helpers are imported and never used; they are reached only through `openDocMobile` inside e2e/mobile.ts, so the spec carries dead imports.
- **low · test-quality** `e2e/theme.spec.ts:41`  
  The engine guard in `pluginThemeSelectors` reads only the TOP-LEVEL rules of the plugin sheet (`rules.map(r => r.selectorText)`), so a theme-conditional rule nested in `@media` / `@supports` / `@container` is invisible to a case whose comment claims to check every theme-conditional rule in the shipped stylesheet. Today all of them are top level, so the gap is latent.
- **low · test-quality** `e2e/viewstate.spec.ts:123`  
  The case `changing the structure and then the theme keeps both` never checks that the theme click changed anything — unlike case 1, which guards its change with `not.toBe('向右')` — so a swatch click that did nothing leaves the case green while its name claims the theme was kept.
- **low · docs** `e2e/viewstate.spec.ts:121`  
  Two descriptions in that case name the wrong control: the comment says "click the 4th (the first 3 are the default palette)" while `nth(4)` is the 5th of 8 swatches, and the assertion message calls the third dropdown "style" while index 2 is the theme select.

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
- **low · test-quality** `src/plugin/paragraphs-ui.test.ts:52`  
  The test that claims to lock down the attached-paragraph tooltip does not exercise the shipped renderer: it re-implements it and hardcodes catalogue text, and that copy has already drifted from the catalogue, so the check can stay green while the user-visible text is wrong.

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
- **low · test-quality** `src/mindmap/structure-order.test.ts:192`  
  The "five labels are pairwise distinct" check reads the test's own literal instead of the labels parsed out of the source and the catalogue, so it is always true and can never go red.

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
- **low · test-quality** `src/plugin/source-probe.ts:52`  
  The comment stripper is a hand-written character scanner where AGENTS section 7 requires the parser the build already uses; it mis-classifies a regex literal containing a quote and then fails to strip the following comment.

### plugin-tests-a

- **low · docs** `docs/pitfalls/editor.md:82`  
  The §2.3 entry 'Paired reverse keys (Backspace / Delete)' points its Test line at a file that has no key-handling coverage at all.
- **low · test-quality** `src/plugin/echo-own-value.test.ts:85`  
  A section titled 'After expiry it is no longer treated as an echo' contains no post-expiry assertion and never calls prune(), so the behaviour its heading names is untested.
- **low · test-quality** `src/plugin/hotkey-collision.test.ts:72`  
  A corrupt keymap snapshot is reported as a missing one, and the 'the check works' control asserts a value it derived from the same map (and is silently skipped when the fixture has no ⌥⌘ key).
- **low · docs** `src/plugin/kernel-side-effects.test.ts:4`  
  The authority for these tests is cited as a gitignored development diary, so the measured facts behind the assertions are unreadable to anyone else (the same citation is used across the plugin tests).

### plugin-tests-b

- ~~**low · type-escape** `src/plugin/mobile-swipe.test.ts:74`~~ **fixed**
  Both components render with real props (no `as never`), stale `summaryData`/`linkLines` dropped,
  missing `modified` added, and the cannot-fail hand-walk third case is deleted.
- **low · test-quality** `src/plugin/node-id-block-id.test.ts:78`  
  The single-child-list regression is asserted against a literal that the test itself declares one line above, so it can never fail.
- **low · dead-code** `src/plugin/stale-mapping.test.ts:72`  
  Unused locals left behind by removed assertions (four instances in scope).
- ~~**low · docs** `src/plugin/tree-ops.test.ts:8`~~ **fixed**
  The Run line points at the sanctioned runner (`python3 scripts/run-tests.py tree-ops`).
- **low · test-quality** `src/plugin/zoom-title-sync.test.ts:38`  
  See the entry below; this is the same file, and it is now the only one the vacuous-test tool still lists as
  unable to go red.

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
- **low · docs** `scripts/audit-privacy.py:156`  
  MAX_BYTES silently drops artifacts from the --live scan and nothing prints how many were dropped, so 'the rules found nothing' does not say how much of the local artifact tree was actually read - while the tracked-file scope does print its skipped count.
- ~~**low · dead-code** `scripts/check.py:155`~~ **stale — machinery is live**
  The `report_only` branch at line 366 reads per-gate config; no gate sets the key today, but that
  is configuration, not dead code — the branch runs the moment one does. Verified by read.
- ~~**low · docs** `scripts/redproof.py:253`~~ **stale — log is written**
  The log file is created at line 269 (`LOG_DIR.mkdir` + per-file path) before the printed path;
  the docstring matches. Verified by read.
- **low · dead-code** `scripts/run-e2e.py:66`  
  (Fixed: the key is read through `env.py` and the line is gone -- the entry point validates it and passes it explicitly.)
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
- **low · ux** `scripts/deploy.py:111`  
  A real deploy run never prints the target list or count, so the AGENTS section 7 check ('confirm the printed deploy: N target(s) list before the check runs') can only be satisfied through `--list` or `npm run env`, and a zero-target run prints nothing at all before returning 0.
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
- **low · test-quality** `scripts/verify-host-style.py:36`  
  The readiness condition is vacuous and the real precondition (the plugin's <style> block) is never awaited; the script instead burns a fixed 120 s wait plus an 8 s sleep, against cdp.py's own measurement that the page is ready in about a second.
- **low · docs** `scripts/verify-host-style.py:4`  
  The docstring says SiYuan attaches the plugin CSS to the host page with <link>, while the script removes and restores the text of a <style> element -- which is what the kernel actually does, so the comment misleads anyone who tries to keep the doc and the code consistent.
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
- **low · bug** `scripts/snapshot-keymap.py:56`  
  The snapshot records the instance's effective keymap (custom bindings first), taken from the user's own running instance, so a machine whose hotkeys are customized writes those personal bindings into the tracked fixture that the collision test treats as SiYuan's built-in table.
- ~~**low · fallback** `scripts/test-instance.py:233`~~ **fixed**
  A missing digest now logs a loud skip warning instead of silently trusting the transfer.
- ~~**low · bug** `scripts/test-instance.py:468`~~ **fixed**
  The PID file is written only after the new kernel answers, and readiness requires our process
  alive (not just the port answering); on failure the previous tracking is restored.
- **low · dead-code** `scripts/verify-android.py:126`  
  The device auto-select branch is unreachable: the serial has already been resolved from the required ANDROID_SERIAL, so 'if not self.serial' can never hold - and the docstring's claim that the script 'auto-detects adb and ports by default' is not what it does.
- **low · docs** `scripts/verify-android.py:652`  
  Two CLI help texts advertise defaults that no longer exist (com.brave.browser, 9222); the values actually come from .env keys, which the help should name.
- **low · docs** `scripts/verify-android.py:44`  
  The usage example passes a file path to the screenshot option, but -o/--output-dir is a directory and the file name is hardcoded, so the documented command writes .../shot.png/manual_shot.png.
- **low · dead-code** `scripts/verify-android.py:193`  
  AndroidBridge.input_key() and AndroidBridge.tap() have no caller anywhere in the repository, so the keycode table in their docstrings documents code nothing runs.
- **low · test-quality** `scripts/verify-live.py:90`  
  The icon check passes when the page contains no svg[fill="none"] at all, so it cannot distinguish 'the rule works' from 'there was nothing to check'.
- ~~**low · bug** `scripts/verify-live.py:410`~~ **fixed**
  The tab opens on a readiness expression instead of a fixed 30s sleep.
- **low · bug** `scripts/verify-live.py:289`  
  The theme attributes the check writes are restored only when the host theme really changed, so a run in which the stylesheet swap had no effect leaves data-theme-mode="dark" on the user's live page while the light stylesheet is loaded.

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
