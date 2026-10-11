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

- **medium · test-quality** `src/core/empty-span.test.ts:101`  
  The "reverse check" that is supposed to prove the defect is real hand-builds a strawman that does not touch the code under test, so its assertion is true by construction and can never fail.
- **medium · test-quality** `src/core/map.test.ts:865`  
  A check passes a literal `true` as its condition, so it is counted in the suite total while asserting nothing — it can never go red, whichever way the code changes.

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
- **medium · test-quality** `docs/pitfalls/editor.md:437`  
  6.9bb's prescribed practice (assert the shortcut table's group and entry counts) is implemented nowhere, and the test the entry names compares two hardcoded copies of the same list, so it cannot see the drift the entry is about.

### e2e-helpers

- **medium · type-escape** `e2e/fixtures.ts:2`  
  No e2e file is typechecked at all, so real type errors sit in the helpers: tsconfig's include is `src` only, and compiling the eight helper files with the project's own strict settings yields two errors - `pngjs` has no declaration (the whole frameStats implementation is `any`) and e2e/mindmap.ts:104 reads `window.siyuan`, which does not exist on Window.
- **medium · test-quality** `e2e/mindmap.ts:222`  
  contentBox returns Infinity/-Infinity sentinels when it measured nothing (it even filters zero-width nodes out), and one caller compares those sentinels with >= and <=, so 'fit fits all the nodes' passes with zero measured nodes - a missing precondition reported as a pass instead of a failure (AGENTS section 7 forbids a helper that returns sentinels for a missing precondition).
- **medium · test-quality** `e2e/testdoc.ts:62`  
  The kernel's result code is dropped on three paths, so a kernel refusal becomes 'nothing found' or 'nothing to do': `sql()` returns `j?.data ?? []` whatever the code says, the removeDocByID calls ignore their response, and lsNotebooks' failure becomes an empty notebook list.

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
- **medium · bug** `src/plugin/i18n/zh_CN.json:127`  
  For the same key the two catalogues do not encode the same string: msgSummaryHint has a real newline in English and a literal backslash-n in Chinese, and en_US msgSummaryTopLevel carries a double-escaped \u2019 that renders as visible text.
- **medium · language** `src/plugin/outline/Outliner.tsx:3643`  
  Hardcoded user-visible UI text outside the catalogues: the toolbar's emoji button is the only button in its row whose tooltip is a literal, and no 'Emoji' key exists in either catalogue, so a zh_CN user gets an English tooltip and AGENTS.md section 2 ('UI text has exactly one home: the catalogues') is violated.

### mindmap

- **medium · bug** `src/mindmap/Mindmap.tsx:1905`  
  No context-menu close path gives focus back to .mm-canvas, so after any menu command (delete / focus this node / back to full map) the canvas keyboard — Tab, Enter, Delete, F2, Ctrl+Z — is dead until the user clicks a node again.
- **medium · fallback** `src/mindmap/Mindmap.tsx:654`  
  fit() substitutes the window size when the container measures 0 — the container→window stand-in this repository's own ledger calls its most repeated mistake (AGENTS 5.1 #2/#3: a path/size has exactly one legitimate source).
- **medium · bug** `src/mindmap/Mindmap.tsx:553`  
  The document title is interpolated raw into the root node's HTML, so a title containing < or > (plain text from blocks.content) is parsed as markup and the characters are lost in the root node and in the exported PNG.
- **medium · ux** `src/mindmap/Mindmap.tsx:273`  
  The per-document collapse state is keyed on the first node's id, so deleting or moving the first top-level node silently discards every collapsed branch of that document, and the abandoned keys are never cleaned up.

### plugin-code

- **medium · language** `src/plugin/i18n/zh_CN.json:127`  
  Three catalogue entries double the escape: the raw JSON contains a backslash-backslash-n (and one backslash-backslash-u2019), which decodes to a literal backslash plus letter instead of a line break / a curly apostrophe, so the user is shown '\n' and '\u2019' as text.
- **medium · bug** `src/plugin/mount.ts:2177`  
  The two mind-map write paths fire `void writeLatest()` with no echo-guard window and no .catch, so a failed write-back becomes an unhandled rejection whose message never reaches the error bar.
- **medium · dead-code** `src/plugin/mount.ts:2061`  
  The '@ reference document' panel is a dead end in the plugin: mount passes an empty document list, so its only list is always empty while the toolbar still offers the button.

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

- **medium · bug** `scripts/cdp.py:176`  
  send() discards the CDP `error` member and ev() discards `exceptionDetails`, so an invalid CDP call or a JS exception in the probe comes back as None -- indistinguishable from a value that really is null -- which makes caller sentinel checks pass on a broken probe.
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
- **medium · bug** `scripts/kernel-mutation-throughput.py:131`  
  `probe[i]` is indexed up to n-1 while `probe` may be shorter than n (failed inserts are filtered out), so a partial insert failure raises IndexError in the middle of the measurement.
- **medium · language** `scripts/mindmap-shot.py:168`  
  The Chinese UI label the script matches on is hidden from the language gate by double escaping (a JS \u escape inside a Python string), so audit-language.py cannot report or excuse it - its 'no CJK text is unaccounted for' claim does not hold for this file.
- **medium · bug** `scripts/mindmap-shot.py:62`  
  The export injects a copy of the whole page stylesheet into the live <svg> element and never removes it, so the user's open page accumulates one extra <style> per run.
- **medium · bug** `scripts/perf-probe.py:185`  
  The tab is opened with the deprecated fixed wait=120, which sleeps two minutes *after* the readiness condition has already been satisfied - pure waste on every run of a probe whose whole point is trustworthy timing.
- **medium · fallback** `scripts/perf-probe.py:182`  
  The script assembles the SiYuan build URL itself and exposes --port, so the probe can be pointed at another instance by hand although env.py is the one place that computes that URL.
- **medium · bug** `scripts/record-demo.py:355`  
  The 'a document id is required' guard is case-sensitive, so a missing --doc still builds '.../?id=None' and the recording starts against a page with no document instead of failing fast.
- **medium · bug** `scripts/record-demo.py:375`  
  The repaint nudge timer and the screencast tab are released only on the success path: any exception inside the story leaves a 12fps setInterval mutating the user's open SiYuan page (and the tab open) after the script dies.
- **medium · test-quality** `scripts/verify-live.py:389`  
  An unrecognised selector argument runs no check at all and still reports a green run ('0/0 passed ✅', exit 0) - a typo in `npm run verify -- <name>` silently verifies nothing.
- **medium · bug** `scripts/verify-live.py:307`  
  To take a baseline the plugin's <style> block is emptied and restored outside any try/finally, so an exception or a None from tab.ev between the two calls leaves the user's live SiYuan page with all plugin CSS removed.

### siyuan

- **medium · dead-code** `src/siyuan/store.ts:2130`  
  The post-move verification poll is unreachable — `ok = true` is set before the loop, so `if (ok) break` fires on iteration 0 and the `SELECT parent_id` confirmation never runs; every moveBlock is then counted as a successful move even though api.ts itself documents that a refused move returns `code:0` and does nothing.
- **medium · bug** `src/siyuan/store.ts:190`  
  `pruneDestroyedSiblings` declares an existing sibling block 'destroyed' after two SQL misses only 200 ms apart and never consults `freshlyInserted`, so a sibling inserted by the previous write-back whose row the kernel has not flushed yet loses its listItem mapping (its position is then never corrected) and, when that was the node's only mapping, is deleted from the block map and re-inserted as a duplicate.
- **medium · bug** `src/siyuan/store.ts:443`  
  The two branches of loadBlockMap disagree about preserving the previous mapping: the DOM branch keeps an old entry only when its value is in `freshlyInserted`, while the SQL branch keeps every entry the query did not return — so the node-id→block-id alignment that `refreshMapsAfterCreate` builds after createDoc is dropped by the very next loadBlockMap, and every node in a freshly created document then looks new to syncStructure.

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
- **low · dead-code** `src/core/layout.ts:101`  
  `escapeKramdown` is defined and never called anywhere (not even inside map.ts), and no gate notices because tsconfig has no noUnusedLocals.
- **low · dead-code** `src/core/map.ts:639`  
  The "inline styles" step in kramdownToHtml rebuilds the matched span character for character, so the whole statement is a no-op that reads as if it did something.
- **low · type-escape** `src/core/map.ts:738`  
  The title paragraphs are smuggled out of kramdownToTree as an undeclared array property read through `as any`, duplicating the module-global channel `takeTitleParagraphs()` — a reader of the types cannot see that the tree carries this field.

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
- **low · dead-code** `e2e/testdoc.ts:279`  
  SPECIAL_TOP is exported with a comment stating what the export must contain, but no test reads it; export.spec.ts asserts the same text as its own literal, so the fixture and its assertion can now drift apart.
- **low · bug** `e2e/themes.ts:172`  
  restoreTheme is documented as 'Put the instance back the way it was found' but neither of its two effects restores anything: `mode` defaults to the literal 'light' rather than the mode it found, and useTheme's forced `modeOS: false` (which it needs to make the switch real) is never written back, so a run permanently clears 'follow the system' on the shared instance.

### e2e-specs-a

- **low · fallback** `e2e/mindmap.spec.ts:61`  
  sidesByBranch identifies the root by 'the first node whose text does not start with a branch name' — not the criterion its own comment states — and the `?? info[0]` fallback hides a failed detection; it is correct today only because the layout happens to emit the root first.
- **low · bug** `e2e/mindmap.spec.ts:888`  
  The download promise is created before the click and left unawaited on the failure path, so a failed click becomes an unhandled rejection 30 s later on top of the real error (same shape in the PNG case).
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
- **low · dead-code** `e2e/dragdrop.spec.ts:213`  
  The same-level guard filters the measured texts by a hardcoded name list whose last two entries can never occur: TEMP_DOC_MD has only 甲/甲一/乙/乙一, so 丙 and 丁 are leftovers from a different fixture and the filter silently means "甲 or 乙".
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
- **low · language** `src/plugin/i18n/zh_CN.json:147`  
  Three keys whose English is the same word ('Untitled' twice, '(untitled)' once) carry two different Chinese words (无标题 vs 未命名), so a Chinese user sees two names for one state while the English catalogue cannot tell the keys apart.
- **low · language** `src/plugin/i18n/zh_CN.json:73`  
  lblEmptyNode is the short half of a short/long pair whose long half is exactly '(empty node)'/'(空节点)', but its Chinese value IS the long form (with full-width parentheses), so English shows '(empty)' and Chinese '（空节点）' in the same slot and the two zh entries differ only in parenthesis width.
- **low · ux** `src/plugin/outline/Outliner.tsx:4633`  
  A per-node context-menu entry that toggles ONE node's subtree is labelled with the global strings cmdExpandAll/cmdCollapseAll ('Expand all'/'Collapse all', zh 全部展开/全部折叠), while the per-node keys tipExpandNode/tipCollapseNode exist and are used for the same action elsewhere - so the label overstates the scope.
- **low · test-quality** `src/plugin/paragraphs-ui.test.ts:52`  
  The test that claims to lock down the attached-paragraph tooltip does not exercise the shipped renderer: it re-implements it and hardcodes catalogue text, and that copy has already drifted from the catalogue, so the check can stay green while the user-visible text is wrong.

### mindmap

- **low · docs** `docs/SHORTCUTS.md:52`  
  The user-facing shortcut doc promises two mind-map mouse behaviours the code does not implement: a single click jumping back to the outline and locating the node, and a double click focusing the branch.
- **low · type-escape** `src/mindmap/Mindmap.tsx:241`  
  Stored preferences are cast to `Record<string, never>` instead of being validated, so any JSON in localStorage flows into structure/themeIdx/lineStyle/shape as if it had the declared type.
- **low · dead-code** `src/mindmap/Mindmap.tsx:79`  
  The dark-mode probe also tests a `data-theme` attribute SiYuan never sets, in two places, and the MutationObserver watches for changes to it.
- **low · bug** `src/mindmap/Mindmap.tsx:1621`  
  The node's hover tooltip keeps zero-width-space-only paragraphs as blank lines, while the badge that lists the same paragraphs treats them as empty — the file's own "empty paragraph" rule is applied on one of the two paths.
- **low · bug** `src/mindmap/Mindmap.tsx:968`  
  A failed PNG export is silent: only img.onload is wired, so a decode failure (or a null toBlob, which is how an over-large canvas fails) produces no download and no message.
- **low · dead-code** `src/mindmap/Mindmap.tsx:19`  
  The explicit re-export list is dead surface: nothing imports these names from this module, and `export * from '../core/layout'` on the line above already re-exports all of them.
- **low · test-quality** `src/mindmap/structure-order.test.ts:192`  
  The "five labels are pairwise distinct" check reads the test's own literal instead of the labels parsed out of the source and the catalogue, so it is always true and can never go red.

### plugin-code

- **low · docs** `docs/TESTING.md:568`  
  The documented size of the language allowlist no longer matches the file or the tool's own output.
- **low · dead-code** `src/plugin/index.ts:13`  
  The static `openTab` import is never used - openMindmapTab shadows it with a runtime `await import('siyuan')`, so the top-level import is dead (tsc has no noUnusedLocals).
- **low · fallback** `src/plugin/index.ts:212`  
  The mirror block's title is derived by splitting SiYuan's composed window title on ' - ', which silently truncates any document whose name contains that sequence.
- **low · docs** `src/plugin/index.ts:248`  
  The comment above the getActiveDocId re-export still describes a sample-data fallback that active-doc.ts deliberately removed, so it contradicts the module it documents.
- **low · ux** `src/plugin/outline/Outliner.tsx:918`  
  Closing the find bar through its own toggle (toolbar/dock button, Ctrl+F) skips the focus restore, so typing afterwards goes to BODY - the exact 'one-way focus migration' the code comments describe.
- **low · dead-code** `src/plugin/outline/indent.test.ts:63`  
  The module-level readBool helper is unused - the only call site resolves to a second, block-scoped copy declared inside the same block.
- **low · test-quality** `src/plugin/outline/touch-longpress.test.ts:275`  
  The 'the criterion itself is effective' block asserts properties of a literal object built three lines above it, so it passes whatever the implementation does.
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

- **low · test-quality** `src/plugin/mindmap-focus.test.ts:17`  
  Some files in scope are replica-only: they assert a model the test itself defines, with no assertion on the product, which is below the standard the repository applies to its own replicas.
- **low · type-escape** `src/plugin/mobile-swipe.test.ts:74`  
  The component is rendered through `as never` with props it does not accept and a required prop missing, and the third case's 'algorithm matches SiYuan' check is a locally built two-object walk that cannot fail.
- **low · test-quality** `src/plugin/node-id-block-id.test.ts:78`  
  The single-child-list regression is asserted against a literal that the test itself declares one line above, so it can never fail.
- **low · dead-code** `src/plugin/stale-mapping.test.ts:72`  
  Unused locals left behind by removed assertions (four instances in scope).
- **low · docs** `src/plugin/tree-ops.test.ts:8`  
  The file's 'Run:' instruction points at a stale compiled copy of the test instead of the sanctioned runner.
- **low · test-quality** `src/plugin/zoom-title-sync.test.ts:38`  
  See the entry below; this is the same file, and it is now the only one the vacuous-test tool still lists as
  unable to go red.

### scripts-gates

- **low · docs** `docs/TESTING.md:568`  
  The numbers describing scripts/audit-language.py no longer match the tool: the allowlist has 12 tokens and no path:line entries (not '391 tokens (186 fixture, 164 i18n, 41 kernel) plus 5 path:line'), a clean run is 199 tracked / 178 scanned / 21 skipped (not 196/175/21), and the run reports code 0 and 24 regex occurrences (not 'code, currently 6' and 25).
- **low · bug** `scripts/audit-language.py:385`  
  The python scanner reports only the FIRST CJK run of each string constant, so a second Chinese run in the same Python string is never reported (and an allowlist token naming it would be called stale), while the JS scanner reports every run - the summary's 'no CJK text is unaccounted for' therefore does not hold for .py files.
- **low · dead-code** `scripts/audit-privacy.py:171`  
  check_patterns(paths, label) never reads `label` - the body has no reference to it - yet all four call sites pass a scope name, which suggests the summary distinguishes scopes when it does not.
- **low · docs** `scripts/audit-privacy.py:156`  
  MAX_BYTES silently drops artifacts from the --live scan and nothing prints how many were dropped, so 'the rules found nothing' does not say how much of the local artifact tree was actually read - while the tracked-file scope does print its skipped count.
- **low · dead-code** `scripts/check.py:155`  
  The report-only gate machinery is dead: no gate in GATES sets the key, so the branch (and the 'report only:' tail it feeds) can never run.
- **low · docs** `scripts/redproof.py:253`  
  It prints `log: .logs/redproof-<file>.log` but never writes that file - `log` is used only by the print - while the docstring tells the operator the script writes its output there, so a background run read from the printed path shows an earlier run or nothing.
- **low · dead-code** `scripts/run-e2e.py:66`  
  (Fixed: the key is read through `env.py` and the line is gone -- the entry point validates it and passes it explicitly.)
- **low · docs** `scripts/run-e2e.py:62`  
  The CI E2E job passes the address and a credential as job inputs, but this entry point overwrites both from .env's isolated instance and CI never creates a .env, so the job cannot run as written and those two secrets are dead configuration.
- **low · bug** `scripts/run-tests.py:83`  
  The --watch branch silently drops --test-concurrency=1, which the comment two lines above says is needed because the tests share paths such as .tmp - so watch mode reintroduces exactly the concurrency the normal mode avoids.
- **low · dead-code** `scripts/script_log.py:124`  
  `if callable(owner)` can never be true, because previous[signum] is only ever assigned signal.SIG_DFL - the guard refuses to install the handler when another one exists - so the 'the previous handler still runs' path promised by the docstring is unreachable.
- **low · test-quality** `src/plugin/css-scope.test.ts:22`  
  The test header promises to lock down three easy-to-get-wrong points, but the third - keyframes selectors (from / to / 50%) must not be prefixed - has no case at all: 'keyframes' appears only in that comment.

### scripts-infra

- **low · bug** `scripts/cdp.py:78`  
  list_tabs() returns [] for every exception, so 'the CDP endpoint is unreachable' is indistinguishable from 'the browser has no tabs' and close_stale_tabs then reports that nothing needed cleaning.
- **low · ux** `scripts/deploy.py:111`  
  A real deploy run never prints the target list or count, so the AGENTS section 7 check ('confirm the printed deploy: N target(s) list before the check runs') can only be satisfied through `--list` or `npm run env`, and a zero-target run prints nothing at all before returning 0.
- **low · bug** `scripts/env.py:341`  
  token() turns every failure to read conf.json (permissions, malformed JSON, a truncated file) into an empty string, so callers report 'cannot get the API token' instead of the real error -- while the sibling test_token() raises for exactly the same failures.
- **low · bug** `scripts/env.py:318`  
  A PLUGIN_DIRS value that contains no usable entry (':', ' ', '::') passes _require() and yields an empty deploy-target list, so the deploy copies nothing and exits 0.
- **low · docs** `scripts/env.py:311`  
  The plugin_dirs docstring documents a fallback derivation for PLUGIN_DIRS that the code does not implement, so a reader concludes the key is optional while _require() makes it mandatory.
- **low · dead-code** `scripts/env.py:357`  
  test_build_url() is never called anywhere, so the helper that is supposed to keep callers from assembling the test-instance URL is unused while callers do assemble URLs themselves.
- **low · test-quality** `scripts/verify-host-style.py:36`  
  The readiness condition is vacuous and the real precondition (the plugin's <style> block) is never awaited; the script instead burns a fixed 120 s wait plus an 8 s sleep, against cdp.py's own measurement that the page is ready in about a second.
- **low · docs** `scripts/verify-host-style.py:4`  
  The docstring says SiYuan attaches the plugin CSS to the host page with <link>, while the script removes and restores the text of a <style> element -- which is what the kernel actually does, so the comment misleads anyone who tries to keep the doc and the code consistent.
- **low · bug** `scripts/verify-pkg.py:22`  
  The script resolves package.json, package.zip and src/plugin/plugin.json relative to the current working directory, unlike every sibling script which derives ROOT from __file__, so running it from another directory dies with a bare FileNotFoundError.

### scripts-live

- **low · dead-code** `scripts/clean-test-instance.py:1`  
  The leftover-document cleaner is reachable from nothing: there is no npm script, no reference in docs/TESTING.md's command cheat sheet and no call from any other script, so the problem it exists to solve is only discoverable by reading the file.
- **low · fallback** `scripts/mindmap-shot.py:33`  
  The CDP base URL is assembled by hand although env.py already derives it (cfg.cdp_http, which the sibling script uses).
- **low · bug** `scripts/mindmap-shot.py:130`  
  Every probed tab that is rejected leaves its websocket connection open (only the winner or the first fallback is kept and closed), so repeated runs accumulate connections against the same CDP endpoint.
- **low · bug** `scripts/perf-probe.py:40`  
  sys.path.insert(0, 'scripts') makes the import depend on the working directory, so the script cannot be started from anywhere but the repository root (it dies with ModuleNotFoundError before running).
- **low · dead-code** `scripts/record-demo.py:47`  
  An orphaned second module-level string (a leftover docstring) plus its duplicated import block are dead code, and the text contradicts the implementation: it says the repaint nudge runs through requestAnimationFrame while NUDGE_ON uses a setInterval precisely because rAF floods the screencast queue.
- **low · bug** `scripts/snapshot-keymap.py:56`  
  The snapshot records the instance's effective keymap (custom bindings first), taken from the user's own running instance, so a machine whose hotkeys are customized writes those personal bindings into the tracked fixture that the collision test treats as SiYuan's built-in table.
- **low · fallback** `scripts/test-instance.py:233`  
  The sha256 verification is silently skipped whenever the release carries no digest field, so the docstring's promise that 'the transfer does not have to be trusted' degrades to trusting it without saying so.
- **low · bug** `scripts/test-instance.py:468`  
  The PID file is overwritten before the new kernel is known to be up, so a start that fails against an already-running (hung) kernel loses the tracking of the process that is still alive - `stop` then reports 'not running' while the kernel keeps running.
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
- **low · bug** `scripts/verify-live.py:410`  
  The tab is opened with the deprecated fixed wait=30 instead of a readiness expression, so every live run pays a fixed 30-second sleep that cdp.py documents as the wrong tool for exactly this.
- **low · bug** `scripts/verify-live.py:289`  
  The theme attributes the check writes are restored only when the host theme really changed, so a run in which the stylesheet swap had no effect leaves data-theme-mode="dark" on the user's live page while the light stylesheet is loaded.

### siyuan

- **low · test-quality** `src/siyuan/api.ts:245`  
  `uploadAsset` performs its own request with the global `fetch` instead of `this.fetchImpl`, so the documented test-injection seam ('Custom fetch (makes test injection easy)') does not cover the image-migration path and an injected fake cannot observe or fail it.
- **low · dead-code** `src/siyuan/api.ts:602`  
  Six exported members of the kernel client have no caller anywhere in src/, scripts/, e2e/ or docs/: resolveTokenFromConfig, listNotebooks, createNotebook, moveDocs, getBlockAttrs, setBlockAttrs.
- **low · bug** `src/siyuan/store.ts:1929`  
  `resolveWantList` registers cleanup placeholders on the instance field `this.pendingPlaceholders` while the cleanup at the end of moveNodes deletes only the set the caller passed, so the documented 'one call owns the set' contract is not implemented and a caller that passes any other Set leaves `- placeholder` list items in the user's document forever.
- **low · dead-code** `src/siyuan/store.ts:1380`  
  `syncParagraphs` ends with a delete of a cache key that nothing ever writes, and its comment describes a cache that no longer exists.
- **low · bug** `src/siyuan/store.ts:2814`  
  `listFolders` shadows the module-level i18n function with `const t = Date.now();` — the exact pitfall the project documents, and the exact thing this same file forbids elsewhere.
- **low · dead-code** `src/siyuan/store.ts:2339`  
  Several store methods have no call site at all, and two of them (resolveListItem, findAnchor) are stale duplicates of anchor logic that now lives inline in syncStructure, with comments that state measurements no longer true.
- **low · docs** `src/siyuan/store.ts:2742`  
  `setHeadingTitle`'s doc comment justifies the method with a state of loadDoc that no longer exists: it presents the `# heading` lookup as how loadDoc reads the title, quoting the code that is now only a fallback.
