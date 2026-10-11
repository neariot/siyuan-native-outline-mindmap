# Test and verification strategy

## In one sentence

**If you can do it offline, do not open a browser.** Starting CDP and loading the SiYuan page costs tens of seconds,
while the vast majority of assertions are really plain string problems -- `tsc` + `node` gives a **stronger** conclusion almost immediately.

## Five layers of verification, from cheapest to most expensive

| Layer | What it does | Command | Needs SiYuan? |
|---|---|---|---|
| ① Types | compile-time errors | `npm run typecheck` | ❌ |
| ②③ Unit + render | pure functions, component SSR, gesture branches under a DOM stub | `npm test` | ❌ |
| ④ E2E interaction | clicks / drags / wheel / collapse / shortcuts / context menu / export / view switching in a real browser | `npm run test:e2e` | ✅ |
| ⑤ Live verification | whether CSS really applies, ResizeObserver, kernel round trips, screenshots and recordings | `npm run verify` | ✅ |
| ⑥ Mobile (Android + CDP) | the soft keyboard, the toolbar snapping to it, and the panel edge against a **real** keyboard | `npm run verify:android` | ✅ |

**Run ① first, then ②③, and run ④⑤ only when necessary.**

## ④ E2E (Playwright + headless Chromium)

### Why we do not start Electron

The SiYuan desktop app is an Electron shell, but **the real UI is served by the kernel over HTTP**
(`http://<kernel>/` → 302 → `/stage/build/desktop/`).
So just open that address with Playwright's Chromium:

- no Electron needed, and **no Xvfb either** (genuinely headless)
- does not depend on "the user already has some page open" -- every run gets a clean context
- measured cold start (launch Chromium → UI interactive) is about **11 seconds**

Use the system `/usr/bin/chromium` (`executablePath` in `playwright.config.ts`),
which saves a few hundred MB of browser downloads.

### Before you run

**Use a fully isolated test instance** (it never touches your own SiYuan workspace):

```bash
python3 scripts/test-instance.py ensure   # first time: download the official binary + deploy + create a notebook
python3 scripts/test-instance.py start    # start the kernel (port = SIYUAN_TEST_PORT from .env)
npm run test:e2e
```

When you are done, `python3 scripts/test-instance.py stop`.

`npm run test:e2e` goes through `scripts/run-e2e.py`: it reads the **isolated instance**'s address from `.env`
and **its own** token and injects them into playwright, so no manual `export` is needed;
if the instance is not running it errors out immediately and tells you how to start it.

> ★ This path did not always look like this: every spec used to contain
> `process.env.SIYUAN_URL || 'http://<some hardcoded target>'`, and that target was usually
> **the very instance you use every day** -- forget the `export` and it really creates and deletes documents there.
> Credentials were written as literals too. Those defaults have been **deleted entirely**
> (see AGENTS §5.1, `e2e/env.ts`).
> `SIYUAN_URL` / `SIYUAN_TOKEN`: missing either one now fails the run, and that is deliberate.

**Why isolation**: your own instance has sync enabled (`sync.enabled: true`),
while E2E **creates documents, deletes documents and modifies blocks** -- that is a real data risk.
The isolated instance has its own workspace (from `.env`'s `TEST_INSTANCE_DIR`, outside the repository) and token,
cannot see any of your notebooks, and has `sync.enabled` false.

> One measured side conclusion: **the size of the workspace barely affects test speed**.
> With the same 10-document load: 29.5 seconds on an empty instance, 29.6 seconds on a 6GB instance.
> The slowness comes from the serial wait of "create one document, wait for one index", not from a large workspace.
> Creating them in a batch and waiting only once is **3.0 seconds vs 27.6 seconds (9.3×)**.

**If you really must target your own instance** (faster, but it really creates and deletes your documents, so you must bypass the entry point explicitly):

```bash
npm run deploy                                    # deploy the plugin to the workspace first
SIYUAN_URL=<your instance URL> \
SIYUAN_TOKEN=<your token> \
CHROMIUM_PATH=<your chromium binary> npx playwright test   # ★ call playwright directly, bypassing run-e2e.py
```

★ All three variables are **required, with no default** (`e2e/env.ts`): the address decides which documents
  get created and deleted, and the binary decides which rendering engine the run measures. `npm run test:e2e`
  injects them from `.env`; a command that omits one stops at the missing key rather than guessing.

★ This is not "optional by default" -- `npm run test:e2e` only targets the isolated instance.
  To target another instance you must write the address on the command line yourself; no fallback will pick it for you.

### ★ Three rules you must remember

**1. The readiness gate must look at the picture, not just at the DOM.**

Right after `domcontentloaded`, `#toolbar` / `.dock` / `.protyle` all
"exist, `getComputedStyle` reports visible, `getBoundingClientRect()` has a size",
**yet a screenshot shows nothing but the splash frame**. So `waitForRendered` in `e2e/fixtures.ts`
really captures one frame to count colors and brightness:

| State | Color count | Average brightness |
|---|---|---|
| Splash | 9 | 31 |
| Ready | 132 | 249.5 |

The thresholds are "color count > 30, brightness > 100", with margin on both sides.
`smoke.spec.ts` has a case that **tests this gate specifically**.

**2. The shape of the test document must be able to trigger the feature under test.**

Using a ready-made document from the workspace once produced a **false bug report**: that document's tree was
`root → 1 child → 6 → 10`, so the synthetic root had only one child,
`calcSplitIndex` returned 1, and "Balanced" put every node on the right --
that is **correct behavior** (one node cannot be split in half), yet the assertion called it a defect.

So `e2e/testdoc.ts` builds its own document: "root + 4 branches × 2 children".

**3. Assert on geometry / pixels, not on DOM counts.**

Under equal-weight subtrees "Balanced" and "Alternating" have the **same left and right counts** (both 2/2),
and even the set of x coordinates can be identical -- only "which node is on which side" differs.
So structural assertions compare the **node identity → side** mapping.

### Performance: 25 cases went from 10.5 minutes to 2.3 minutes

The gap is almost entirely in three places, and none of them is an "optimization" -- they are **bug fixes**:

| Problem | Symptom | Practice |
|---|---|---|
| No warm-up | the first case pays the cold-start bill; measured a 1.2 minute timeout | load it once in `global-setup.ts` |
| Timeouts too short | inside the fixture several waits run in **sequence** (goto / layout / dock / tab / canvas) and add up to over 60s on a cold start, reporting "beforeEach timeout" | raise the per-case timeout to 120s |
| Isolation between cases | -- | a separate context per case |

Each case now stably takes **4~8 seconds**, and three consecutive rounds pass 25/25.

#### Tried and reverted: reusing the context at worker level

To save the cold load of every case we once hoisted the context to worker-level reuse. Most cases did drop from
10~60 seconds to 4~6 seconds, **but it introduced new flakiness**: `beforeEach` timeouts started appearing
(page snapshots showed SiYuan was in fact already loaded; `.om-dock` / `.om-mm-viewswitch` simply never appeared),
and a different case failed every time -- classic cross-case state leakage.

The cause is that SiYuan is a live application: a context-level reused localStorage makes it restore
the previous UI layout, and once the plugin panel sits in an "unmounted" layout, later cases wait forever.

**Isolation matters more than saving those few seconds.** Let the warm-up pay the cold-start bill.

#### What a case's startup actually costs (measured, `scripts/e2e-coldstart.py`)

"Avoid the cold start" has an obvious answer —— reuse the context —— and it is already answered above:
tried, and reverted for leakage. So the question becomes whether there is a *second* cold start nobody
named. `scripts/e2e-coldstart.py` drives one startup in the fixtures' own order and costs each phase; the
table below is its output, and the phases are the ones `openSiYuan` + `openDoc` really take.

| phase | cost | per case? |
|---|---|---|
| create the test document (kernel call) | 0.3s | yes |
| **wait for the SQL index (`waitUntilIndexed`)** | **2.0s** (1.2~2.8s) | yes |
| launch the browser | 0.3s | **once per worker** |
| `openSiYuan`: `goto "/"` | 1.2s | yes |
| `openSiYuan`: the other four waits + the screenshot gate | 1.4s | yes |
| `openDoc`: `goto "/?id=<doc>"` (**a second full page load**) | 0.3s | yes |
| the same `goto "/"` again, in the same browser | 0.3s | —— |

**About 6.6s of a case's 16.5s median is startup**, and the two entries that are actually large are the
SQL-index wait and the page load itself. Three corrections to what this document and the config comment
say:

1. **"Measured cold start (launch Chromium → UI interactive) is about 11 seconds" is not what a case
   pays.** The browser launches in **0.3s** (it is a system Chromium, already warm in the page cache) and
   `goto "/"` costs 1.2s before DOM-content-loaded and 2.6s to a fully drawn page. The 11 seconds was
   measured through the whole fixture chain, on a first-ever load, and attributing all of it to the
   browser is what makes the number look unavoidable.
2. **The expensive per-case item is the kernel's SQL index**, not the browser: `waitUntilIndexed` waits
   for a flush that the kernel performs on its own schedule (1~3s). It is not removable by warming up
   anything —— it is the kernel making progress, and shortening the budget would turn a slow machine into
   a false failure (which is why the budget is 45s).
3. **Reloading the page to open a document is what the design chose.** `openDoc` does a full `goto`, and
   its *entire* cost is 0.3s in the table above —— a soft in-app open would save less than the isolation
   it would risk, and none of the measured instability came from this step.

★ So the honest answer to "can the suite avoid a cold start every time" is: **the parts that are cold are
already warm, and what remains is either the kernel's index or a deliberately clean page.** The tool is
kept because the next person will ask the same question, and re-measuring it by hand is how the 11-second
number survived.

★ **And `openSiYuan`'s four readiness waits are not four waits.** Timed one after another they *sum* to
2.2s, which reads like a chain worth collapsing into a `Promise.all`. Measured from one origin, they
resolve together —— `siyuan.layout` at 1.81s, `#toolbar` at 1.84s, `.layout__center` and the plugin dock
at 2.26s —— so the wall-clock cost is 2.26s and the sum was an artifact of measuring them serially. Each
wait is also a genuine precondition (the DOM-exists-but-still-a-splash case is why the screenshot gate is
there at all), so concurrent waiting would save **nothing** and make a failure harder to attribute. A
"2.2s" that is really "2.26s total" is exactly the kind of number that invites a pointless refactor.

### After creating a document, wait for the index

After creating a document, `ensureTestDoc` / `createTempDoc` poll the `blocks` table
and hand it over only once the document is **really queryable**.

Without that wait the plugin reads an empty document title -- because the title comes from querying
`SELECT content FROM blocks WHERE id='<docId>' LIMIT 1`,
and a newly created document takes about 0.5~2s to enter the index. The symptom is "the title bar is empty about 1/3 of the time".

★ Lesson: **"intermittent" does not mean "random"**. Whenever something "sometimes passes and sometimes does not",
first look for a definite precondition that can simply be waited out.

### CI

`.github/workflows/ci.yml` has two jobs:

| job | When it runs | Contents |
|---|---|---|
| `check` | push / PR | types, offline unit tests, build, CSS scoping, package validation |
| `e2e` | **manual only** (`workflow_dispatch` + checkbox) | browser E2E |

E2E needs a machine running SiYuan (the GitHub-hosted runners do not have one),
so do **not** put it into every push: it would become a permanent red cross and in time nobody would look at CI.

### The drag drop target has **three regions** (measured, not guessed from the code)

`dropZoneAt` decides the drop target from the pointer's proportional position inside the row:

| Ratio | Drop target | Measured effect |
|---|---|---|
| < 0.25 | `above` | ✅ reordered as a sibling **above** that row |
| 0.25 ~ 0.75 | `child` | ⚠️ **no change** (neither the UI nor the kernel moves) |
| > 0.75 | `below` | reordered as a sibling **below** that row |

`locator.dragTo(targetRow)` **defaults to the center of the row** -- which is the `child` region,
so nothing happens. My first version was written that way, every assertion failed, and it looked like dragging was broken,
when in fact it was **dropping in the wrong place**. To reorder you must use `targetPosition` to put the pointer inside the top edge.

The fact that "the `child` region has no effect" is worth pinning down as well: it is the position users most easily drag to.

### To read document order, do not query SQL

We tried `SELECT content FROM blocks WHERE parent_id='<docId>' LIMIT 1` -- **it returns nothing**.
Measured: SiYuan's structure has four levels (`d` → `l` → `i` → `p`), and the `sort` column is **not sibling order**,
it is "node type priority" (paragraphs are all 10, list items are all 20); sorting by it does not give document order.

Use `getBlockKramdown` to read the document block -- it returns the whole document as **ordered** text, indentation is the hierarchy,
and it is exactly how the plugin reads documents itself, so verifying "write-back" with it is closest to reality.

### The test document must be rebuilt every time

`ensureTestDoc` must not be written as "reuse it if it exists": a probe script had typed into the shared document,
after which every case that depends on the document shape ran against a **document that had already been modified**,
so the failures looked all sorts of ways and the real cause was completely invisible.

Two reset approaches were also tried and got it wrong:
1. **write the same hpath with `createDocWithMd` to overwrite** -- SiYuan **creates another document with the same name**
   (measured 1 → 2 copies), after which `LIMIT 1` picks one at random and it looks like a flake.
2. **change the document block with `updateBlock`** -- it returns `code: 0` but the content is not really replaced.

What works is **delete and rebuild** (`removeDocByID` + `createDocWithMd`).
⚠️ The document id therefore **changes every time**, and the caller must use the returned value.

### Division of interaction in the outline view (probe first, then write the assertion)

In both the outline and the mind map "one click and the row count drops", but for **completely different reasons**, so it is easy to mix them up:

| Interaction | Real effect |
|---|---|
| Click the **bullet** | **zoom** into that node's subtree (12 rows → 3 rows) and a breadcrumb appears |
| Click the **sidebar arrow** | **collapse** (12 rows → 10 rows, with `.collapsed`), the breadcrumb does not move |
| **Alt+click the bullet** | collapse (the `title` says "Alt+click to collapse") |

The cases deliberately make the two the control group for each other: the bullet must not produce `.collapsed`, and the arrow must not produce a breadcrumb.

⚠️ Do not judge the editing state by "editable": the outline is **always editable** (all 12 `.node-text` nodes
are `contenteditable="true"` from the start), unlike the mind map where "the input box only appears on F2".
The reliable criterion is the behavior itself -- focus lands on `.node-text`, and the typed characters appear in **that one** node.

### Cases that write to a document use a **temporary document**

The keyboard (Tab / Enter / F2) and the context menu **really modify the document**.
Running them against the shared test document pollutes it once per run, and the next assertion breaks.
So these cases create an `E2E-临时-<timestamp>` document in `beforeEach`
and delete it in `afterEach` with `/api/filetree/removeDocByID` (the old `removeDoc` makes the kernel panic).

### Things it has already caught

On the day this E2E suite was built it caught two **problems in the tests themselves** (items 2 and 3 above),
plus one real usability problem: the settings bar overflows horizontally in a narrow panel
(container 237px / content 1131px), "Fit" and "Export image" fell outside the viewport,
so they could only be clicked after scrolling horizontally. The test does the honest thing (`revealInBar`) instead of
covering the problem up with `force: true`.

### Injection verification

A new E2E case likewise has to "break the implementation and confirm it goes red". Injection points verified so far:

| Injection | Expected to fail | Result |
|---|---|---|
| make `calcSplitIndex` return the full length | "Balanced" splits in half | ✅ went red |
| make parity put everything on the right | "Alternating" by parity | ✅ went red |
| do not embed the plugin styles in the export | the exported SVG carries `<style>` | ✅ went red |
| clone the root node without `om-mm-host` | the exported SVG root node class name | ✅ went red |
| drop the selection call from the node `onClick` | "clicking a node marks it as selected" | ✅ went red |
| stub out `onZoomChange` in `Mindmap` | "focusing a node shows only the subtree" | ✅ went red |
| remove the settings bar container query (fall back to nowrap) | "in a narrow sidebar the settings bar controls are all inside the viewport" | ✅ went red |
| stub out the bullet's `onClick` | "clicking the bullet zooms into the subtree" | ✅ went red |
| change the breadcrumb back button to an empty function | "the breadcrumb back button restores the whole tree" | ✅ went red |
| stub out the `moveDrop` call | "dragging a node really changes the order" | ✅ went red |
| make the drop target decision always "top of row" | "only a drop on the upper edge of a row reorders" | ✅ went red |
| set the readiness threshold to 0 | "the readiness gate distinguishes a splash frame from the real UI" | ✅ went red |
| make the settings bar wrap only at a 560px breakpoint | "the settings bar does not overflow at any container width" | ✅ went red (reported "with a 700px container… Export .mm falls outside the bar")|
| stub out the localStorage write | all 5 cases in `viewstate.spec.ts` | ✅ all went red |
| remove the menu clamping logic | "the context menu does not run outside the viewport" | ✅ went red (reported how many px each of the 12 nodes overflowed by)|
| remove the `window.confirm` gate | "cancelling the confirm dialog does not delete the node" | ✅ went red (reported `5 → 3`)|
| change references to "concatenate" when expanding | "expand as sub-document… the text is not duplicated" | ✅ went red (reported "measured 2 times (text: 分支一 分支一)")|
| make the `child` drop target have no effect | "a drop in the middle of a row makes a child…" | ✅ went red (reported "it should become a child (indented deeper than the target row)")|
| remove the "cannot drop into a descendant" guard | "an ancestor cannot be dragged into its own descendant" | ✅ went red (reported the garbled shape of the tree)|
| same as above | "dropping a node onto itself changes nothing" | ⚠️ **still green** -- it only covers the other guard (hence two cases are needed)|
| make fit ignore the height term (scale up 1.6×) | "'Fit' fits under every document shape" | ✅ went red (3 of the 4 shapes reported the exact overflow in px)|
| revert the collapse toggle to `@media` | "the collapse toggle follows the bar width" | ✅ went red (reported "it should be visible with a 237px bar and a 1280px window")|
| revert the narrow-screen layout block to `@media` | "the narrow-bar stacked layout follows the bar width" | ✅ went red (reported "measured 'row'")|
| revert the title area to `@media(768)` | "the narrow-bar title styling follows the bar width" | ✅ went red (reported "should be 24px, measured 32px")|
| revert the arrow to `@media(768)` | "sidebar arrow touch visibility follows the input device" | ✅ went red (reported "the arrow must be visible by default, measured 0")|
| revert the first-visit criterion to `window.innerWidth` | "the first-visit default open/closed state follows the bar width" | ✅ went red (reported "collapsed=false, bar height 239px")|
| -- (not an injection, a real regression) | 7 cases in `export.spec.ts` | ✅ all red after the default collapse changed → recovered after fixing `revealInBar` (see [pitfalls/testing.md](pitfalls/testing.md) 6.9r)|
| -- (not an injection, a real regression) | 4 cases in `mindmap.spec.ts` (the ones measuring bar width) | ✅ after the default collapse changed they reported "measured 0px" → recovered after switching to the dock width (see [pitfalls/testing.md](pitfalls/testing.md) 6.9s)|
| wrongly add `collapsed` to rows when `depth > 0` | "clicking the bullet zooms into the subtree and a breadcrumb appears" | ✅ went red (reported "precondition: there should be no collapse marker before zooming in")|
| same as above (**before** the fix) | the same case | ⚠️ **still green** -- the old assertion was `0 === 0`, zero defensive value (see [pitfalls/testing.md](pitfalls/testing.md) 6.9u)|
| re-`setAnchor` inside `onFocus` (reproducing the anchor stealing) | "★ Shift+click selects a range" | ✅ went red (reported "should have selected 甲..丁, 4 in total")|
| remove `setSelected([])` from the plain click | "★ a plain click clears the old selection" | ✅ went red (reported "a plain click should clear the selection")|
| the summary and link-line controls stay removed | "★ the summary and link-line controls are gone" | asserts neither control is offered and neither `.summary-bar` nor `.mm-link` renders |
| stub out the `setCollapsedIds` call | "clicking the collapse button really folds the child branch away" | ✅ went red |

⚠️ When deciding "did it go red after the injection", **first confirm that grep actually matched a case**.
My script initially only did `grep -q "N failed"`, while in fact the `--grep` argument, because of shell
word splitting, matched no case at all; Playwright printed `No tests found` and exited 0 --
so "it never ran" was misjudged as "it still passes after the injection". The script now explicitly checks for
`No tests found` and refuses to draw a conclusion from it.

⚠️ An injection **must replace the complete statement**. I once used a regex that replaced only the first line of a multi-line expression,
producing a syntax error like `const pluginCss = const pluginCss = '';`,
the build failed, the old package stayed deployed, and so I reached the **wrong conclusion** that "the test still passes after the injection".

### ① Type checking

```bash
npm run typecheck
```

Much faster than the tests; after a change run this first to rule out type errors.

### ②③ Unit + render tests (offline)

```bash
npm test                # everything
npm test richtext       # only files whose name contains richtext
```

`scripts/run-tests.py` discovers `src/**/*.test.ts(x)` automatically and hands them to `tsx` to run directly.

**It uses `tsx` + `node --test`** -- the same setup as SiYuan's own frontend tests
(the `test` script in `app/package.json` is exactly `node --import tsx --test "src/**/*.test.ts"`).
TS runs directly, which saves the detour of "compile to a temp directory with tsc, then run the output with node"
(that detour not only waits for the compilation, the output path also has to be guessed with `find`).

**Why not jest / vitest**: the tests are all pure functions plus string / structural assertions,
`node --test` already ships the runner / assertions / concurrency control, so one `tsx` devDependency is enough.

#### Render tests are the biggest win here

The `RichText` component runs through `renderToStaticMarkup`, and we assert the produced `<tspan>` markup directly:

```ts
const out = renderToStaticMarkup(
  React.createElement(RichText, { runs: htmlToRuns(html), fallbackFill: '#000' })
);
// → '<tspan fill="var(--b3-font-color8)">段落一</tspan>'
```

This is **stricter** than `querySelector` + `getComputedStyle` in a browser:
you get the complete output structure, not "what color some element happens to be".
And it finishes in 2 seconds, with no port conflicts, no races and no waiting for a page to load.

The precondition is that the component can be imported on its own. So `RichText` was deliberately pulled out of `Mindmap.tsx`
into `src/mindmap/RichText.tsx` -- buried inside a component of several thousand lines it could not be tested offline.

#### A DOM stub: gesture / interaction logic can be tested offline too

SSR-rendering a component needs `window` / `document`, and a **hand-written minimal stub** is enough:
`src/plugin/test-dom-shim.ts` (in the test, `import './test-dom-shim'` must come before the component import).

SiYuan's own `app/src/mobile/util/sidebarSwipe.test.ts` takes the same route
(hand-written stub + `node:vm`) instead of opening a browser.

Measured payoff: `src/plugin/mobile-swipe.test.ts` asserts that "the plugin panel carries
`data-prevent-swipe`", and 3 cases finish in **539ms**; the same conclusion could not be reached back then
after half a day of fiddling with CDP.

### ⑤ Live verification (only when necessary)

```bash
npm run verify              # everything
npm run verify -- css       # only the CSS-related checks
npm run verify -- --doc <docId>
```

**This is the one layer that deliberately runs against the user's own instance** (the `SIYUAN_*` and
`CDP_*` values in `.env`), because it checks the app the user actually has open: it drives that
instance's Chromium over CDP and builds `stage/build/desktop/?id=…` URLs for it. That is not a
fallback — the address is explicit configuration — and it must not be "fixed" into the test instance,
which has no real UI session to observe. The rule that tests never touch the user's instance applies to
the layers that create and delete documents: E2E (④) and the mobile layer (⑥) are pinned to the
isolated instance for exactly that reason.

`scripts/verify-live.py` only covers the four things that **cannot be tested offline**:

1. **Whether CSS really applies** -- only a real CSS engine can decide who wins between the cascade / `@media` / `!important`.
   We stepped on this twice: a rule written inside `@media` was lost entirely on desktop, and an `!important` hid the whole SiYuan editor.
2. **Whether `ResizeObserver` really fires** -- does the mind map re-fit after the panel width is dragged?
3. **Whether colors really travel from SiYuan to the mind map** -- the original bug a user reported.
4. **Screenshots / screen recordings** -- see `npm run record`.

## ⑥ Mobile (Android + CDP)

`npm run verify:android` drives a real Android browser (a local Redroid container or a physical
device) through adb and CDP together, because the mobile layer is the one thing this project cannot
fake:

```bash
python3 scripts/verify-android.py                      # the full smoke case
python3 scripts/verify-android.py --scenario keyboard  # toolbar snapping, non-occlusion
python3 scripts/verify-android.py --scenario type      # soft-keyboard input and two-way sync
```

- **It needs** `adb`, a mobile browser package, and the `PYTHON` interpreter that has Playwright
  (`.env`; the system `python3` does not have it here). Ports, serial and package name come from
  `.env` like everything else.
- **It always measures the isolated test instance**, never the instance the user is working in, and it
  forwards SiYuan into Android with `adb reverse` rather than exposing it on the network.
- **What it measures**, and must: the toolbar's rect, the outline viewport's lower edge, the caret row,
  and button interactivity while Android's own soft keyboard is up. The screenshot comes from
  `adb exec-out screencap`, so it contains the real keyboard.
- **What it must not do**: fake the keyboard by resizing the viewport. `Emulation.setDeviceMetricsOverride`
  plus touch emulation sets a 393×852 viewport, but SiYuan keeps laying out the desktop DOM — a measured
  panel came out `left=401, width=877`, entirely off-screen. Any claim about the panel, the drawer or
  the keyboard needs a real device or genuine mobile UI mode; see the pitfall ledger.

## Configuration: `.env`

Ports and paths are never hardcoded; they are read centrally by `scripts/env.py`:

```bash
cp .env.example .env      # edit as needed
npm run env               # print the effective configuration
```

Priority: **real environment variable > `.env`**. There are no built-in defaults -- a missing key errors out and names the key
(see AGENTS §5.1). To change the port temporarily you do not need to edit the file:

```bash
SIYUAN_PORT=<port> npm run verify
```

`.env` holds the API token and is **already ignored by `.gitignore`**; `.env.example` (no sensitive values) is the one to commit.

### Kernel-side probes

The performance dimension of kernel behavior (the SQLite index, index sync lag) is measured with
`scripts/kernel-index-lag.py`, no browser needed:

```bash
python3 scripts/kernel-index-lag.py --samples 14
```

It does two things:
1. concurrent sampling (one thread inserts, one thread polls) to measure the kernel's
   **periodic batch flush interval**;
2. comparing it with the polling budgets in `store.ts` -- **the exit code is 1 when a budget is too tight**.

★ Sampling must be **concurrent**. A sequential "insert everything, then poll" catches nothing --
the insert itself is slow, and by the time polling starts the flush is long done (measured, we stepped on it).

★ The "worst" in the criterion is **the maximum of a single flush interval**, not
"the total span from the first flush to the last" -- the latter grows with the sampling duration,
so using it as the criterion would call every run too tight.

For query-plan questions (such as whether a given SQL statement uses an index), ask the kernel directly with `EXPLAIN QUERY PLAN`
instead of speculating.

## Performance testing

Following the T1–T4 load profiles in `.logs/perf-test-design.md` (50 / 500 / 2000 / 10000 nodes).
The load generator lives in `src/perf/loadgen.ts`: exact node counts, mixed breadth and depth, Poisson-distributed text lengths.

| Dimension | Artifact | Conclusion |
|---|---|---|
| Cold start (parse / layout) | `src/perf/baseline.test.ts` | both linear, no O(n²) |
| Input latency (INP) | `scripts/perf-probe.py` | 11.9ms steady state (criterion 50ms) |
| Write-back coalescing | `src/plugin/writeback-coalescing.test.ts` | 30 keys → 7 write-backs |
| Batch move wait | `src/siyuan/move-nodes-latency.test.ts` | 20 nodes 7.4s → 1.4s |
| Undo stack memory | `src/plugin/undo-memory.test.ts` | T3, 50 snapshots, 29.5MB |
| everSeen shrinking | `src/siyuan/ever-seen-shrink.test.ts` | 9100→100, zero live blocks lost |
| Detached DOM | see the script below | 6 toggle rounds, no leak |

### Assert the "ratio", not the absolute time

Absolute timings swing with the machine and the load; asserting on them only buys you a test that goes red and green by turns.
A ratio (when the node count doubles the time must not grow by more than a few times) is stable across machines -- on a fast machine numerator and denominator shrink together.

The `T3 all 6 layouts < 100ms` case in `baseline.test.ts` stepped on exactly this:
it passed at 50ms on an idle machine, and flagged red at 127.8ms as soon as there was CPU contention.
Machine-dependent budgets are now downgraded to **reported items**, keeping only one order-of-magnitude fallback (<1000ms).

### Before measuring, check how busy the machine is

`scripts/perf-probe.py` reads the load average first and refuses to produce numbers above "cores × 2"
(exit code 3); `--force` is needed to measure anyway.

The same piece of code measured **342ms / 10.9ms / 75ms / 6893ms** on this machine -- a 600× spread,
and all of it was load. I almost went and changed the rendering logic based on that 342ms.

### One input cannot be "measured N times and taken as the median"

The first input also triggers the page's first layout, editor initialization and the post-mount paint settling.
You must **discard the first two rounds** as warm-up, otherwise you consistently measure cold-start numbers (which look a lot like a bug, but are not).

Measured: SiYuan body text 292ms on round 1 → 0.7ms steady state; plugin panel 355ms → 11.9ms.
SiYuan's own editor is likewise 292ms on the first round ⇒ a page-level cold cost, not something the plugin owns alone.

### Measure memory with a separate process per profile

Measuring several profiles in a row inside one process gives 0.0MB from the second profile on --
the memory allocated in the previous round was GC'd into a free heap and is simply reused. You need one process per profile plus
`node --expose-gc`. See the end of `undo-memory.test.ts` for details.

### Fixed: the fixed wait in batch moves

`store.ts:moveNodes` used to `sleep(300)` and re-check for every node, accumulating per node --
indenting 20 nodes in a batch wasted 6 seconds. Measured on a real machine, the index after `moveBlock` returns is
**immediately visible** (median SQL round trip 2ms), so those 300ms were pure waste.

After switching to "poll until visible, then return": 20 nodes in total 7.4s → 1.4s.
Note that this is not trading reliability for speed -- a fixed wait can still miss the flush on a slow machine,
so polling is in fact more reliable.

### Known magnitudes, not optimized (an architectural change, not a defect)

| Item | Measured | Note |
|---|---|---|
| No viewport culling | under T3 all 2001 nodes are attached to the DOM | `Mindmap.tsx` renders everything via `boxes.map()` |
| Editing a leaf recomputes everything | T3, 41.6ms per run (criterion 50ms) | the `layout` useMemo depends on the whole tree |

Both are architectural changes (viewport culling / local dirty updates); T3 still meets the criterion, so we do not touch them on our own initiative.

## Command cheat sheet

```bash
npm run typecheck    # ① types
npm test             # ②③ offline tests
npm run verify       # ④ live verification (needs SiYuan + CDP)
python3 scripts/verify-live.py host   # ④ only the host-style-agnostic check (UI-TC-02)
npm run deploy       # build + deploy into SiYuan
npm run record       # record a demo video
npm run package      # build the release package + validate it
npm run env          # print the environment configuration
npm run check        # all the fast gates at once, with a verdict and a cost per gate
npm run timings      # what each script actually costs, from .logs/script-usage.log
npm run redproof -- --file <f> --from <text> --to <text> --run "<check>"
                     # show that a check can go red, then put the tree back
```

## The process layer

Three rules used to be enforced by hand, and each had already failed at least once. They are tools
now, and each tool has a demonstrated failure path.

| Tool | Rule it enforces | Its own failure path |
|---|---|---|
| `scripts/redproof.py` | "a new test must be shown to fail" | stays red-proof-able: a mutation that lands nowhere is refused *before* a test run, and a check that stays green is reported as a failed red proof |
| `scripts/script_log.py` | "a test whose duration is not known runs in the background" | records `ok` / `failed exit N` / `error` / `interrupted signal N`; a `SIGKILL` leaves nothing, which the docstring states |
| `scripts/check.py` | the fast gates, in one command | exits non-zero for any gate that ran and failed; a skip prints why, and a report-only gate says so |
| `scripts/check-docs-index.py` | every entry the pitfall index advertises exists | exits 1 and names each dangling reference |

Two habits these bought, both worth keeping: **measure the primitive before designing a test on it**
(a live theme switch is ~0.4s, re-opening the document ~10s — a 4-sample matrix that reloads each time
is a minute of nothing), and **verify the mutation is the one the check reads** before spending a run
on it (three hand-made red proofs in a row stayed green for reasons unrelated to the check).

### The language audit is a gate, and it decides by category (measured 2026-10-11)

`python3 scripts/audit-language.py` inspects 196 tracked files (175 scanned, 21 skipped **each with a
printed reason**) and reports **0 findings** in well under a second. The interesting part is *how* it
decides.

Four categories are **rules**, not lists, because they are decidable from the repository:

| Rule | What it excuses | Why it is decidable |
|---|---|---|
| `manifest` | strings in `src/plugin/plugin.json` | the manifest's values *are* the product's declaration |
| `product-text` | **prose** (comment, doc line, assertion message) quoting a catalogue or manifest string | the text must occur inside a real product string |
| `test-fixture` | a Chinese **string literal inside a test file** | the content under test is Chinese; a fixture is data, not prose |
| `test-fixture-quote` | prose quoting text that appears in a test file's literal | a doc explaining what the tests do is quoting fixture content |

Everything else is an **entry**, and there are 12 of them, each with its reason on the line. They exist
because they quote a value observed **from a running kernel** (`目录`, `简体中文`, a notebook's `hpath`),
which no static rule can decide. An entry that stops covering anything is an error (`ALLOWLIST-STALE`),
which is how 596 obsolete entries were found and deleted: the list went from 608 lines to 12.

★ **A rule that is too wide is worse than a list**, because it hides violations silently. The tempting
over-reach was excusing a Chinese *literal* in shipped code when it equals a catalogue value — that is
hardcoding UI text, the thing i18n exists to prevent, so it stays a finding and the fix is `t('<key>')`.
`--selftest` pins each category's width (7 cases), and a red proof shows the over-reach failing.

Removing the fallback arguments made a second rule unnecessary: the auditor used to compare
`t(key, vars, fallback)` against the catalogue to bless a fallback that matched it. With no fallback
arguments in the codebase that rule could not fire, and a rule that cannot fail is not a check, so it is
gone — and what replaced it is stricter: a Chinese literal in code is reported whatever its shape.

★ **What a clean run does and does not mean.** Allowlist tokens excuse their text in *any* file and any
*kind*, deliberately: the CJK they cover is catalogue or fixture content quoted by an English comment, an
assertion message or a doc line. The tool therefore prints what it excused, by kind (measured
2026-10-10: `comment 479, string 1426, assertion 30, doc-prose 116, code 6`). Read that line: a pass means
"no CJK text is unaccounted for", **not** "every comment is English". `path:line` entries are the only
mechanism restricted to one line, and they are the wrong tool for prose (they break when the file is
edited above them).

What the tool still cannot see, printed on every run: files with no parser (`.yml`, `.env.example`,
`.gitignore`, `LICENSE`), binary/media files, the i18n catalogues and `*.zh-CN.md` (allowed by policy),
and CJK outside every comment or string token (`code`, currently 6 occurrences) or inside a regex
literal (25, kernel/UI strings matched verbatim).

The remaining allowlist is 391 tokens (186 `fixture:`, 164 `i18n:`, 41 `kernel:`) plus 5 `path:line`
entries, and it self-cleans: an entry that no longer covers anything is reported as `ALLOWLIST-STALE`
and fails the run, which is how the 186 obsolete ones were found and removed.

## A test that models the product defends nothing

**The shape**: a test file writes its own version of the rule it claims to protect —— an `UndoStack` class, a
`hitTest()`, a `FocusModel`, an `OutlinerProps` interface plus a `renderOutliner(withZoomProps: boolean)` that
decides the wiring from its own boolean —— and then asserts on that. Every assertion passes, the file reads
like a specification, and **no change to the plugin can turn it red**. It is worse than no test: the coverage
it advertises is the reason nobody looks again. Seventeen files were in this state.

**What to do instead**, in rough order of preference:

1. **Drive the real thing.** `write-depth-nesting.test.ts` drives `SiYuanStore.beginWrite` / `endWrite` /
   `loadBlockMap` over a counting fake client, so "the second read was served from the cache" is an SQL call
   that did *not* happen. `zoom-title-sync.test.ts` drives `renameDoc` / `setHeadingTitle` over a recording
   client and reads the props off the two `React.createElement` call sites.
2. **Extract the decision so it can be driven directly.** The rule has to be pure for that: `joinsUndoWindow`
   (the undo merge window), `deleteKeyAction` (the Delete key's branch order) —— both moved into `src/core/`
   precisely because the code around them needs the DOM and `siyuan`, which a unit test cannot import. The
   extraction is not a test-only refactor: it is what makes the rule expressible.
3. **Read the shipped code structurally**, through `src/plugin/source-probe.ts` (parser-based: bodies, call
   sites, JSX attributes, assignments). Weaker than driving the code, and only honest when the claim is about
   structure —— "every panel container carries `tabIndex`", "the handler suppresses the native default before
   it acts", "the rename path writes the heading block too".
4. **A measurement, written down as a measurement.** When neither of the above fits (the kernel's own
   behaviour, a caret position in a real browser), it belongs in `docs/kernel-api.md` or the pitfall entry as a
   dated measurement, **not** as a local model pretending to be a test.

**The gate**: `scripts/check-vacuous-tests.py` fails the build when a document cites a test that does not
exist, and when a cited test imports nothing and reads nothing. It is deliberately a lower bound —— it can see
that a file reaches nothing, not that its assertions are weak —— so it is a floor, not a substitute for the
list above. It stands at **0 files reaching nothing**, and the check runs strictly: a new one fails the build.

## The artifact is part of what gets verified

A version number is not a build. Measured: a version bump and a source fix both landed **after**
`package.zip` had been produced, so the zip carried the new number and none of the fix —— and every
external label agreed with every other one. Nothing in the artifact said "old build"; the only way to
find out was to open it.

So the package is compared against the build beside it: `scripts/verify-pkg.py` (the `package-fresh`
gate, and the last step of `npm run package`) requires `package.zip`'s `index.js` and `index.css` to be
**byte-identical** to `dist-plugin/`'s, and prints the packaged `index.js`'s hash so it can be quoted
when the release is verified. It goes red the moment the build moves and the zip does not.

★ Rebuilding the package after a source change is therefore not a step somebody has to remember:
**forgetting is the failure the gate is for.** `npm run check` runs it in 0.06s when both exist, and
skips it with a stated reason when there is no package to compare (nothing to release yet).

## Pitfalls we stepped on

### CDP-related

- **Tab leakage**: every `Tab()` opens a new tab; forget to close it and they pile up until
  around 12 tabs the websocket starts timing out in `readinto` -- which shows up as "the script works sometimes".
  Use `close_stale_tabs()` to clean up before opening a new page.
- **`/json/new` must use PUT**; GET returns 405.
- **Synthetic events do not work with React**: `dispatchEvent` never enters React's synthetic event system,
  so the click does nothing and reports no error. You must dispatch real mouse events with `Input.dispatchMouseEvent`.
- **To decide "the element is covered" you cannot sample a single point**: sampling the center with `elementFromPoint`
  lies -- if the coverer is a **sibling node** rather than an ancestor it may happen to miss that one point.
  Measured, we stepped on it: a single point concluded "body is on top: true", while the screenshot showed the body completely covered by the drawer;
  after switching to 3 points, all 3 hit the covering layer. **Multiple points are the minimum; looking at pixels is the final word.**
- **Mobile viewport emulation changes the viewport only; it does not switch SiYuan into mobile UI mode**:
  `Emulation.setDeviceMetricsOverride` (`width`/`height`/`deviceScaleFactor`/`mobile`)
  + `Emulation.setTouchEmulationEnabled` can set the viewport to 393×852,
  but the DOM tree SiYuan loaded **for the desktop still lays out as desktop** -- the measured panel rect was
  `left=401, width=877` in a viewport only 393px wide, so **the whole panel sat outside the right edge of the screen**.
  The only things you can verify are "layout-independent" properties (such as the body's computedStyle);
  any mobile case that involves the panel's own visibility, size, the drawer or the soft keyboard
  **always needs a real device or genuine mobile UI mode**.
  Do not call it a pass because "the emulation produced green numbers" -- those numbers may describe
  an area the user cannot see.
- **Screencast needs repaints to be forced**, otherwise you get only 4 frames in 2 seconds;
  and you **must not** drive it with `requestAnimationFrame` (it floods the send queue so the second half receives no frames).
  See the comment at the top of `scripts/record-demo.py`.

### Build / test related

- **`tsc --outDir` preserves the source directory structure**, so the output path cannot be assembled by hand; you have to `find` it.
- **Back up before changing code**: `cp file file.bak`, and system configuration backups go in `.tmp/`.
- **`.tmp/` is gitignored** -- do not park useful tools there, they get lost. Anything reusable goes in `scripts/`.
