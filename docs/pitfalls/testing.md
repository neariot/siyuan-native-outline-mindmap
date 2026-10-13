# Pitfalls - Testing and criteria

<- [Master index](../PITFALLS.md) | Things we stepped on once and do not want to step on again; each entry reads "symptom -> cause -> practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the order inside this file;
the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 6.1 If an offline test can do it, do not open a browser

This is the core of this project's testing strategy; see `TESTING.md`.

Key points:
- SiYuan's own frontend tests use `node --import tsx --test` -- no browser, no jsdom
- This project copied that, and `npm test` dropped from 45s to ~5s
- Components assert the markup `renderToStaticMarkup` produces (SSR), which is stricter than
  `querySelector` + `getComputedStyle` in a browser, and can assert a whole structure
- Gesture / interaction logic uses a hand-written DOM stub (`src/plugin/test-dom-shim.ts`)
- Only four things need a real browser: whether CSS really takes effect, `ResizeObserver`,
  the end-to-end round trip with the kernel, and screenshots / screen recording

When you write a test you must verify that it can fail. After writing a new test, temporarily break the implementation, confirm the test goes red, then restore it.
(This project has fallen for exactly that: the CDP touch test "passed", when it was really a false positive.)

### 6.4 Echo comparison on empty nodes: both sides must use the same definition

**Symptom**: click an empty node in the outline and press Enter repeatedly; the top banner accumulates
"⚠ 1 content conflict -> ⚠ 2 -> ⚠ 3" even though **nothing changed externally**.

**Cause**: the same "empty" has a different shape in three places, and if either side is not normalised thoroughly they can never match:

| Where | Shape |
|---|---|
| Mind map node | `<span></span>` / `<span></span><p><br></p>` |
| What we write out | zero-width space `​` |
| What the kernel echoes back | `<div contenteditable="true">​​</div>` |

The diagnostic log printed by temporary instrumentation:

    {"incoming":"​​",   <- the kernel's echo
     "current":"",                <- the mind map side
     "isEcho":true,               <- it really is what we wrote ourselves
     "ownVals":[""]}              <- the values we registered

`isEcho` recognised it, but `"" !== "​​"`, so `isOwnValue` returns false ->
falls into the conflict decision -> one false report per Enter press.

**One more easily missed point**: every node corresponds to **two** blocks in SiYuan (listItem + paragraph block),
and the two have different `content` formats -- listItem is `' 甲'` (leading space) or `' '` (one space when empty),
while the paragraph block is `'甲'` or `''`. So normalisation must strip tags + drop zero-width spaces + collapse whitespace + trim.

**Fix**: `plainNodeText` in `mount.ts` and `htmlFragmentToText` in `sync.ts`
must use **the same set of rules**, changed on both sides together. Changing only one side is the same as not changing anything.

---

### 6.8 If you can assert it statically, do not accept it through a browser

**Symptom**: to verify a single tooltip bubble, CDP dispatched `mouseover` and then took a screenshot,
but the timing and coordinates never lined up; several rounds produced no stable result.

**Cause**: `tooltip` is a purely static JSX prop -- compiled it is just the two strings `aria-label` and
`title`. Verifying it with "run it + hover + screenshot" trades a deterministic fact
for an observation subject to render timing, animation delay and window coordinates.

**Practice**: verify on two layers, each with the tool that suits it.

| What to verify | With what |
| --- | --- |
| Is the prop written correctly | `node --test` reads the source / build output and asserts strings (`tooltip-build.test.ts`) |
| Are the logic branches right | a pure-function unit test (`tooltip.test.ts`) |
| Does it really render | a browser, but checking the DOM prop only, **not a screenshot** |

Leave the browser for one-off confirmations like "is this prop in the DOM at all"; do not use it as a regression tool.

**Why:** screenshot verification is slow (each run waits 25~45 seconds for a build) and brittle (timing / coordinates / zoom are three separate uncertainties),
and once it enters CI it is a long-term source of flakiness. Static assertions take milliseconds and are fully deterministic.

---

### 6.9f `window.confirm` **cancels by default** in a headless browser -- it fabricates a fake bug

Hit while writing the right-click menu cases. Deleting a node pops a confirmation dialog, and
headless Chromium's `window.confirm()` **returns false automatically**, so the deletion is (correctly) aborted.

What we saw: the menu item **exists, is visible and has a normal size**, and after the click **the menu did close**
(so the handler did run), yet the node count did not drop by one and the document in SiYuan did not change.
**It looks exactly like "delete is broken".**

My first probe took it for a bug and I almost went off to fix something that was not broken.
After adding `page.on('dialog', d => d.accept())` everything was normal.

**Lessons**:
1. ★ When testing an action that sits behind a confirmation dialog, **you must wire up the dialog first**;
   Playwright's default behaviour with no handler is to **cancel**, not to "do nothing".
2. ★ Conversely, "the handler ran" does not mean "the feature is not broken",
   and it does not mean "the feature is broken" either -- an unwired dialog may be sitting in between.
   Before concluding "some action had no effect", first confirm that **no other interaction gate** is in the way.
3. ★ It is worth testing **both directions**: after confirming it should be deleted, **after cancelling it must not be**.
   Test only the former and a defect like "delete without waiting for the confirmation at all" slips through.

### 6.9h Do not mistake a "block attribute" for body text in an assertion

Stepped on while writing the case above. SiYuan puts a listItem's block attributes **on the same line**:

    - {: id="20261008212051-…" updated="…"}((20261008212051-… '分支一'))

My filter only stripped the "the whole line is an attribute" case, so the assertion saw the `{: id=…}` prefix,
misread it as "there is still original text before the reference", and reported a **false failure** (the code was in fact right).

★ When you read kramdown to write an assertion, strip `{: …}` **inline**; filtering whole lines only is not enough.

### 6.9i The second "I thought it was a bug" case: the subdocument path

In the same probe, "the subdocument was not created" was also my misjudgement -- it was created, it is just that the position
looks "wrong" only relative to whether my expectation is right:

- the parent document is at the notebook root (`hpath = /父文档`) -> `lastIndexOf('/') === 0`
  -> `cut > 0` does not hold -> `dir = '/'` -> the subdocument lands at `/分支一`.
  **This is correct**: the parent is at the root, so the subdocument is naturally at the root too.
- the parent document is in a subdirectory (`hpath = /目录/父文档`) -> `dir = '/目录/'`
  -> the subdocument lands at `/目录/分支一`, a sibling of the parent. Confirmed by measurement ✅.

**Lesson**: before reporting "some feature had no effect", first confirm that your **expectation** is right.
A probe hardcoding an expectation does not mean the product has to satisfy it.

### 6.9j When asserting a tree structure, **a flat text list is blind**

**Symptom** (re-checked 2026-10-08): `dragdrop.spec.ts` has a control experiment for the "three drop zones",
asserting "dropping on the **exact middle** of a row changes nothing". It was green all along --
**but it was wrong**. The `child` zone had been working fine the whole time.

**Cause**: the criterion used `rowTexts()` = `allTextContents()`,
which returns a **flat array of text and cannot see indentation**.
The effect of a `child` drop, however, is "turn the source node into a **child** of the target" --
**it does not change the row order, only the level**. The flat list is identical before and after:

    before: ["甲","甲一","乙","丙"]   x: 甲=1161 甲一=1188 乙=1161 丙=1161
    after: ["甲","甲一","乙","丙"]    x: 甲=1161 甲一=1188 乙=1188 丙=1161
            ↑ completely identical, assertion passes        ↑ 乙 moved one level deeper; the feature clearly did take effect

SiYuan's kramdown also confirmed that "乙" had moved under "甲".

**Cost**: on that basis I wrote down "the `child` zone measures as no change" and **put it into comments and a table**,
recording a working feature as a defect, and making every sibling-reorder case avoid the default drop zone.

**Practice**:
1. Asserting a tree-structure change must **read the level along with the text** -- read the row's left edge x or the DOM depth,
   not just the text order. `dragdrop.spec.ts` now has `treeShape()` (`x|text`).
2. That control experiment became **two assertions**:
   - drop on the middle of a row -> **the row order does not change** (exactly the symptom that fooled me at the time)
     **and the indentation must get deeper** (what child really does)
   - drop on the top edge of a row -> it moves to the front, **and the indentation does not change** (sibling reorder)
   Only now is the difference between the two drop zones really pinned down.

★ **Lesson**: an assertion that is "always green" may not be a defence but a **blind spot**.
  An assertion passing only says "the thing it checks holds"; it does not say "the behaviour under test is as described".
  When writing an assertion, ask: **can this function see the change I want to test?**

### 6.9k Two guards, only one tested -- delete the other and nobody shouts

**Background**: drag and drop has two safety guards.

```js
const tops = topLevelIds(ids.filter((i) => i !== targetId));  // ① blocks "dropping onto itself"
if (tops.length === 0) return;
const desc = new Set();  ...
if (desc.has(targetId)) return;                                // ② blocks "dropping into its own descendant"
```

**Finding** (2026-10-08): delete ② entirely and the case "dropping onto itself changes nothing"
**is still green** -- because it only reaches ① (`targetId` is already filtered out when dragging onto itself),
**and never touches ② at all**.

Yet ② is the only guard that blocks "ancestor -> descendant". With it deleted, drag "甲" onto "甲一":

    before: 1001|甲 / 1028|甲一 / 1001|乙 / 1028|乙一
    after:  1001|乙 / 1028|乙一 / 1001|甲 / 1028|甲一
           ↑ 甲 jumped to the top level together with its children -- there is now a cycle in the tree

**Practice**: add "an ancestor cannot be dropped into its own descendant", testing ② specifically.
**One case per guard**, so deleting either one makes a test shout.

★ **Lesson**: when a function has several early returns / guards,
  do not assume "I tested a nearby one = I covered the whole set".
  Ask: **does this case really reach the branch I care about?**
  The way to verify is simple -- **delete that guard and see whether the case goes red**.

### 6.9l The criterion of the "drop onto itself" case is blind too

Found while digging into the above. It used `rowTexts()` (flat text) to assert "completely unchanged",
but if "a node becomes its own child" really did slip through, what changes is the **level**,
and flat text **cannot see it at all** (the text is still that row, and the order did not change either).
Same root cause as 6.9j. Now switched to `treeShape()`.

(This one really is **unchanged** at the moment -- I confirmed it both ways with shape + kramdown.
The criterion was changed so that it shouts if it ever really breaks.)

### 6.9m "Fit" was tested on one document shape only = one direction covered

**Background**: fit scales by a single factor -- the smallest of the two axes:

```js
const k = Math.min(1, (cw - pad) / layout.w, (ch - pad) / layout.h);
```

**Both** directions can become the bottleneck:

| Document shape | What hits the limit first |
|---|---|
| Wide and shallow | **width** |
| Narrow and deep | **height** |
| Single node | neither hits it, which tests the `min(1, …)` ceiling |
| Multi-level, multi-branch | there is quantity in both directions |

The old case "Fit fits all the nodes" used only **one shape** of the shared test document
(4 branches x 2 child nodes), so it covered only one of the branches.

**Practice**: add "Fit fits every document shape",
running 4 shapes, failing on any overflow and reporting the full geometry.

★ This also **confirmed that the formula is not miscomputed** (worth recording):
  by hand `k = min(1, (237-24)/631, (650-24)/345) = 0.3376`,
  measured k = `0.3375594…` -- the first 5 decimal places agree.
  So the "287px left over top and bottom" observed earlier is **not a bug**:
  `layout` carries its own `padX=80 / padY=60` padding, and fitting to width in a narrow column
  naturally leaves a lot of vertical slack. "Does not overflow" is the design goal; "fills it up" is not.

**Injection check**: drop the `layout.h` term and scale it up 1.6x ->
3 of the 4 shapes go red, each reporting the exact overflow (wide and shallow 9 left/9 right,
narrow and deep 28 left/28 right, multi-level multi-branch 17 left/17 right).

### 6.9r Change a default and the test helper has to "expand" too

**Symptom** (2026-10-08): after the toolbar's first-visit default was made a function of the column width (see 6.9q),
**all 7 cases in `export.spec.ts` went red at once**:

    TimeoutError: locator.click: Timeout 10000ms exceeded.
    waiting for locator('.mm-bar button').filter({ hasText: 'Export image' })
      - locator resolved to <button class="btn">Export image</button>
      - element is not visible        <- the button **was found**, but it cannot be clicked

**Cause**: the right column the test uses is only 237px => the toolbar is now **collapsed by default**
(`.mm-bar--collapsed { display: none !important }`),
so the button is `attached` but has no size.

**This is not a product defect** -- collapsing by default in a narrow column is exactly the **intended** behaviour.
What is wrong is the test helper `revealInBar`: it only did "scroll horizontally to the button",
not "bring the button into a clickable state". And whether it is collapsed **is the same problem**.

**Practice**: in `revealInBar`, first determine whether the bar is collapsed, expand it if so, then scroll.

★ **Lesson**: when you change a "default value / initial state", think through
  **who depends on that default**. This time it was the **test helper**,
  and its failure message ("element is not visible") looks exactly as if the product broke --
  it is very easy to misjudge it as "my change broke export" and go and change the product instead.
  In fact the product is right, and **the helper is what needs fixing**.

  => How to decide: does the user **need** this behaviour?
    collapsed by default in a narrow column -> yes, needed (not collapsing would eat 1/3 of the panel).
    the helper cannot click the button -> the helper did not do its job.

### 6.9s When collapsed, `.mm-bar` is **0** wide -- using it as "the column width" gives a false failure

**Symptom** (2026-10-08): after first-visit default collapse (6.9q), several cases that **measure the column width**
reported inexplicable failures:

    Error: it should really have been widened (measured 0px)
    Expected: > 560      Received: 0

The right column had clearly been dragged to 900px, yet it said "not widened".

**Cause**: those cases use `.mm-bar`'s `getBoundingClientRect().width` as "the column width".
But **when the toolbar is collapsed** it is `display: none` => width **0**.
So "column width 900" became "column width 0" and the assertion failed the other way round.

**Practice**: always measure **column width** with `.layout__dockr` (the dock itself), never `.mm-bar`.
The `dock` does not become 0 just because the toolbar is collapsed.

★ A second pitfall from the same root: **when collapsed, every child control is 0 wide**.
  The width-scan case walks `bar.children` looking for overflow --
  in the collapsed state there is "nothing to measure", so it **passes vacuously**,
  looking green while verifying nothing at all.
  => every width must be preceded by `ensureBarOpen(page)`.

★ **Lesson**: an element "existing" does not mean it "has a size".
  Every `getBoundingClientRect()` inside a `display: none` subtree is 0,
  and 0 **silently** leads comparison-style assertions to a wrong conclusion --
  either a false failure (as here) or a vacuous pass (more dangerous, because there is no signal).

### 6.9t `toBeLessThan(560)` is satisfied by **0** -- the precondition assertion passes vacuously

**Symptom** (2026-10-08): a precondition assertion was added to the "narrow sidebar" case,
"the column must really be narrow", and then a **900px wide column was injected** to confirm it goes red --
the result was **still green**.

**Cause**: when the toolbar is collapsed `.mm-bar` is `display:none`,
so `getBoundingClientRect().width` is **0**. Yet

```js
expect(i.barWidth, 'the bar must be really narrow').toBeLessThan(400);   // 0 < 400 ✅ passes!
```

**0 satisfies any "less than N" assertion.** So the "precondition check" was a sham --
it did not catch the wrong injection, and it gave me the illusion of having "verified".

**Practice**: wherever you "take a float / pixel quantity and then assert it is below some threshold",
you must **first assert that something was measured**:

```js
expect(i.barWidth, 'the toolbar should have a width (0 means collapsed, nothing measured)').toBeGreaterThan(0);
expect(i.barWidth, 'the bar must be really narrow').toBeLessThan(400);
```

**Measured confirmation**: before the guard, a 900px wide column was still green; after it, red at once,
reporting "the toolbar should have a width (0 means collapsed, nothing measured)".

★ This class of defect is **far more dangerous** than a "false failure":
  a false failure shouts, **a vacuous pass does not** -- it quietly gives the illusion of "verified".
  Same family (already recorded in this file):
    · 6.9s when collapsed every child control is 0 wide -> the overflow scan "has nothing to measure" and stays green
    · 6.9k the guard was not covered -> the assertion covers one branch only and stays green
  What they share: **the assertion also holds in the state where nothing was tested at all**.

★ A self-check to run: read every `toBeLessThan` / `toBeGreaterThan` and
  ask "**would 0 (or an empty set) pass**". If yes -> a precondition guard is missing.

### 6.9u A control group written as `toBe(before.x)` -- always true when both sides are 0

**Symptom** (2026-10-08): `outline.spec.ts` has two "control group" assertions that
**stay green even with a real bug injected**.

**Cause**: they are written as "the same as before", and in this scenario before/after **is always 0**:

```js
expect(after.collapsed, 'zoom must not produce a collapsed marker').toBe(before.collapsed);
expect(collapsed.crumbs.length, 'collapsing must not produce breadcrumbs').toBe(before.crumbs.length);
```

Measured states:

| State | rows | collapsed | crumbs |
|---|---|---|---|
| Initial | 5 | **0** | **0** |
| After zoom | 3 | **0** | 2 |
| After collapse | 3 | 1 | **0** |

=> `after.collapsed === before.collapsed` is `0 === 0`,
and `collapsed.crumbs.length === before.crumbs.length` is `0 === 0` too.
**Always true, zero defensive value.**

**Measured confirmation**: injecting into `Outliner` "add `collapsed` to a row when `depth > 0`"
(i.e. marking rows collapsed after zoom by mistake), by the zoom step `collapsed` goes from 0 to 2 --
**the original assertion is still green**.

**Practice**: a control group must be written in **both directions**:

```js
expect(before.collapsed, 'precondition: no collapsed marker before zooming in').toBe(0);
expect(after.collapsed, `zoom **must not** produce a collapsed marker, measured ${after.collapsed}`).toBe(0);
```

After the change the same injection **goes red at once** (the precondition line hits first).

★ **A "control group" is the easiest place to pass vacuously** -- because it is naturally written as "the same as before",
  and "before" is often exactly 0 / the empty set. When writing a control group, ask one question:
  **if the feature under test were completely broken, would these two values still be equal?**
  If yes -> this control has no meaning.

★ Same family as 6.9t (`toBeLessThan(N)` satisfied by 0;
  here `toBe(x)` with both sides 0). What they share:
  **the assertion also holds in the state where nothing was tested at all.**

### 6.9z Three signals in tests that "look right but are false"

> None of these three is a product bug; they are **the test itself seeing wrong**. They are more dangerous than a false failure --
> a false failure shouts, a false signal just **quietly goes slow**.
>
> When screening a signal the question is not "does this property look like it", but
> **"does it really take different values in the two states I want to tell apart"**.

**① `.om-dock` cannot be the "plugin has loaded" signal**

Measured on the initial page with no panel open:

```
.om-dock            0      <- it renders only when **a panel is open and has content**
.om-mm-viewswitch   0
.om-mm-host         0
[data-type*=…]      1      <- the real entry button; present as soon as the plugin mounts
```

`.om-dock` is a toolbar **inside the Outliner panel**. Treat it as a load signal and
with the panel closed you wait a full 60 seconds for nothing -- and this check runs **before every case starts**.

**② `isVisible()` cannot be the "panel is open" signal**

With the panel **closed**, `.om-mm-viewswitch` is still `display:flex` and `isVisible()` is still true,
**the only difference is a width of 0**:

```
after nav    n=1  w=0     <- closed, but isVisible()=true
click #1     n=1  w=0
click #2     n=1  w=122   <- this is the open one
click #3     n=1  w=0     <- closed again (confirming it "toggles")
```

=> the criterion can only be **width > 0**, and it must tolerate "one click may still leave it closed".
Click with `force: true` (the Dock icon carries a tooltip, which intercepts a normal click).

Also, switching documents leaves the old panel's DOM behind, so always take `last()`, never `first()` --
`.first()` selects that old `display:none` node; measured
`112 × locator resolved to <div class="om-dock"> … hidden` until it times out.

**③ `locator.evaluate` cannot be used to check a transient state**

It **waits for the element to appear automatically** (until the locator times out). Yet the question "is the panel open"
has to be asked **before the panel is even mounted** -- so the question blocks for the whole timeout and drags the case down with it,
and the error is `Target page, context or browser has been closed`
(the case timed out first and the page was torn down), **which hides the real cause**.

=> to check a transient state, use `page.evaluate` to query the DOM directly: not found is 0, and it returns at once.

---

### 6.10 After creating a document, wait for the kernel **index**; do not read it at once

After SiYuan creates a document, the `blocks` table is not queryable immediately (measured at about 0.5~2s).

And the way the plugin reads a **document title** is exactly
`SELECT content FROM blocks WHERE id='<docId>' LIMIT 1` (`loadDoc` in `store.ts`) --
while the index is not ready this query returns empty, so the title is **permanently** an empty string (a reload does not heal it either,
because the plugin reads it only once, at mount).

**Observed behaviour**: about 1 time in 3, "the outline panel's title bar is empty".

The fix is on the test side: after creating the document, poll the `blocks` table and hand it over only once it is really queryable.

★ Lesson: **"occasional" does not mean "random"**. Whenever something "passes sometimes and not others",
first look for a definite precondition that can simply be waited out -- if you find one it is a deterministic bug,
and only if you do not is it time to suspect a flake.

★ The wrong move: do not add a fallback to the product code just because it is "occasional".
A real user does not create a document and start reading it within 200ms.

### 6.11 An assertion that races real timing can never be stable

The readiness-gate case used to be written as: **grab one frame immediately** after `goto` and assert "colour count < 60".
That is a race against real loading -- grab early and it is a pure splash screen (9 colours) -> pass;
grab a little later and the UI is half painted (possibly > 60 colours) -> fail. Measured: three runs in a row, one failure.

It was split into **two things that do not interfere with each other**:

1. **The threshold itself**: verify the decision function on a synthetic minimal page (no race against anything)
2. **The real ready state**: once the gate lets it through, confirm the statistic really crosses the threshold

★ A more hidden problem came with it: the decision threshold used to be **copied** into the case,
so changing the threshold in `fixtures.ts` left the case green -- meaning it was not verifying the gate at all.
An **injection check** caught it: change the threshold -> the case does not go red -> the assertion is not testing the thing under test.

Whenever "a constant from the code under test appears inside an assertion", be on guard for this.

### 6.13 A default value that "guesses a target" -- looks safer, is actually more dangerous

**Symptom**: tests, scripts and verification tools all "run", and you never have to configure anything.
Switch machines, forget to export a variable, or have **the instance they depend on not running at all**, and they still run to the end
and still report green. Until one day you find out they were never testing what you thought.

**Four ways to get it wrong** (all of them have happened in this repository; the values here are placeholders):

| Wrong way | What it looks like | Consequence of forgetting to configure |
|---|---|---|
| Address fallback | `process.env.URL \|\| 'http://<some hardcoded target>'` | Really creates and deletes documents against **somebody else's live instance** |
| Credential fallback | `process.env.TOKEN \|\| '<some literal>'` | **real credentials end up in the source and in git** |
| Downgrade chain | candidate list = `[<first choice>, <second choice>]`, use whichever answers | first choice not running -> **silently switches target, runs to the end and reports green** |
| Heuristic path search | walk up N levels from the current directory / try a few common locations | **change the working directory and it connects to another workspace** |

**Cause**: none of these defaults is a "safe fallback"; each is a **guess**
(guessing a target, a path, a credential). The problem with a guess is not that it "may be wrong",
but that **it stays silent when wrong** -- an error stops you; a wrong guess just hands you a conclusion that looks normal.

Two counter-intuitive points:

- **A downgrade chain is more dangerous than a single value.** A wrong single value fails immediately; a downgrade chain, when the main target is unavailable,
  **switches to another target and runs to the end**, and that target is often the production / user instance.
  "More robust" and "more dangerous" are the same thing here.
- **A tool that "runs by default" is itself a bad smell.** A verification tool that runs
  without any configuration very likely has a default target you do not know about.

**Practice**:

1. Config missing -> **fail and name the key**, do not fill in a default.
2. A target may have exactly one source (a config file or an explicit command-line argument): no probing, no downgrading, no `||`.
3. The right reaction to "the target is not running" is to **tell the user how to start it**, not to pick another target.
4. Credentials are read from the environment / a config file only; a literal in the source is a finding whatever it equals.
5. The self-check question: **would this empty value / this failure make the script connect to or write somewhere else?**
   If yes -> it is a guess; delete it.

See AGENTS §5.1.

### 6.x Before measuring performance, check whether the machine is busy

**Fact**: measuring "one input -> the sync flows back" in the T3 document (2000 nodes)
gave **342ms**, **10.9ms** and **75ms** three times in a row on the same day, and in the fourth round SiYuan's own body text
took **6893ms** for its own first input. A 600x spread.

The cause is not in the code but in the machine: this box has 4 cores yet permanently runs 3,600+ processes and 32,000+ threads,
with a load average of 30~150, and free memory often down to a little over a hundred MiB (`kswapd` had burned two hours of CPU
thrashing). Under that load the same piece of code has no comparability at all.

**Practice**:

1. **Look at the load average before deciding whether to measure at all**. `scripts/perf-probe.py` already does this:
   above "cores x 2" it refuses to produce numbers at all (exit code 3), and only `--force` forces a measurement.
   Better no number than a noise value that gets taken as a conclusion.
2. **An offline test asserts a "scaling ratio", not an absolute duration**. An absolute duration fluctuates by machine model, so asserting it gives you
   a test that goes red and green; a scaling ratio (double the nodes and the time should not grow by more than a few times) is stable across machines --
   a fast machine shrinks numerator and denominator together. `src/perf/baseline.test.ts` is written that way and
   still passes stably at load 148.
3. **You cannot just take "the median of N consecutive runs" for one input**. The first input also triggers
   the page's first layout, editor initialisation and the paint settling after the panel mounts; you must **discard the first two rounds** as warm-up.
   Copying "run it 5 times and take the median" reliably measures cold-start numbers and produces an illusion that looks very much like a bug.

**Why**: I almost changed the render logic on the strength of that 342ms. That would have broken good code
to "fix" a problem that does not exist at all -- worse than failing to measure performance.

**Corollary**: when you get a number that is "implausibly good" or "implausibly bad", first ask
"is this number trustworthy", and only then "how do I fix it".

---

### 6.15 Read once, miss, and file a bug: the kernel index is asynchronous so "not found" is not "does not exist"

**Symptom**: while probing what `insertBlock` returns, a script queried the **type** of each returned block id
(`SELECT type FROM blocks WHERE id=…`) immediately after the insert, and about **half** of the ids came back not found
(recorded as `?`). The obvious conclusion was "`insertBlock` does not return a fixed type -- sometimes a List,
sometimes a listItem, sometimes nothing".

**Cause**: the `blocks` index is **asynchronous**. Right after an insert, `SELECT … WHERE id=…` returns an **empty row set**,
because the block is not in the index yet, not because it does not exist. The script turned that "no answer" into a
data point and read the row set as a type.

**Measured (kernel 3.8.6)**: with polling (up to 12 s) every id resolves, and the type is **`i` (listItem)** each time.
The value the probe was hunting was never unstable -- **the probe read too early**:

```
immediately (0 wait), single shot : "?" for about half of the returned ids
with polling (max 12 s)           : "i", every id
```

★ And note how easily this manufactures a kernel bug report: the suspicion stood until the polling was added.
What the row set described was the **timing of the read**, not the behaviour of `insertBlock`.

**Practice**:
1. When a lookup comes back empty, record **unknown**, and do not let "unknown" be read as "does not exist" by the code below it.
   In an asynchronous index a single-shot probe is a false-negative generator (6.10, 6.11).
2. Poll until the answer appears or you time out -- never a fixed `sleep`, and never "query once and report".
3. The question to ask of a probe that answers "present / absent" is: **which of the two states does it actually distinguish --
   "absent" or "not yet visible"?** If it cannot tell them apart, it is not evidence yet.

**Why the numbers live here and not in the test**: they are a record of a **methodology correction**, not of product
behaviour. `kernel-bugs.test.ts` keeps only the shape (`query immediately when the index is not ready ⇒ nothing found`,
polling returns the right type on both branches); a printed observation cannot go red, so it is not evidence there.

### 6.16 Every case failing at once: the shared precondition is part of the subject

**Symptom** (the misjudgement that came with the above): every `insertBlock` case panicked -- the fixture was a clean
document (`- 甲` / `- 乙` / `- 丙`), the markdown passed in varied (`- `, an empty string, `- 甲`, `x`), and **at the
time all of them really did panic**. Conclusion drawn: "empty / minimal markdown crashes the kernel".

**Cause**: the markdown content had nothing to do with it. The probe kept passing a **document ID** as `previousID`, and
`previousID` = a document ID is out of range for `insertBlock` -> nil-pointer panic. **Every case failed because every
case shared that one wrong precondition**, not because the subject was broken.

**Measured**: once the anchor was corrected, the four markdown variants were all normal, and the anchor table was clean:

| `previousID` points at | Result |
|---|---|
| a document ID | panic |
| a listItem / a List / a paragraph / a heading | normal |

**Practice**: when **all** cases fail, suspect the **test script** before the subject -- look for the one condition
they share. And keep one case with a known-good precondition as a **positive control**: if it also fails, the
environment (not the subject) is what is broken.

★ **Lesson**: "all of them failed" is not "the subject is broken everywhere"; it is "one shared condition is wrong".
The working case above (a listItem anchor) is what proved the environment itself was fine. This collection does not
otherwise record the endpoint's anchor rules -- those are kernel behaviour and live in
[`kernel-api.md`](../kernel-api.md) 7.1; the debugging detour around the same anchor is
[`debug.md`](debug.md) 6.14.

### 6.17 What the kernel adopts is the id: node ID === block ID, and kramdown shows it inline

**Symptom** (measured, defect #54): the same node content landed in SiYuan **twice**, each copy with its own paragraph block.
The counted duplicates (same node 同E) were **2**, and they were inserted 17 seconds apart, so the second one was not
a race in flight -- it was a re-insertion:

```
子T
  ├── 同E   (22:32:58)
  └── 同E   (22:33:15)   <- duplicate
```

**Cause**: the map key had **two namespaces**. The insert wrote `- ${text}` and let the kernel assign a block ID,
while `syncStructure` registered the mapping under the **client-side node id** (`makeSiyuanId()`) and `loadBlockMap`
rebuilt it under the **block ID**. Measured proof that the two really differ -- the prefixes are one second apart,
i.e. two distinct IDs for one node:

```
node ID      = <node-id>
mapped block = <block-id>
```

⇒ the next write-back finds no mapping for the node ⇒ judges it new ⇒ **inserts a second copy**:
the document held **2** 同E entries, each with its own paragraph block.

**Fix**: inline the node's **own id** into the inserted markdown, so the kernel **adopts** that id
(`{: id="…"}` is SiYuan's native inline-attribute syntax; a non-conforming id falls back to the id-less form so
the kernel never receives a bad one). The keys then agree, and no duplicate appears.

**Confirmed in kramdown** (the same fact, seen from the read side): every `listItem` carries the
`{: id="…"}` inline attribute, and the reader strips that prefix and keeps the id only when it matches
`SIYUAN_ID_RE`. That is what makes "node.id === block ID" readable straight out of the document text --
it is the direct evidence for "the kernel adopted the id", and it is how a structural assertion can compare ids
without a second SQL round trip.

★ Distinct from 6.9h: 6.9h is about the attribute sitting **inline** so a naive filter mistakes it for body text
(false failure); this one is about the attribute being **the id carrier**. Both must strip it; only one of them
expects it to be there.

**Practice**: a mapping key must stay in **one namespace on every write path**. Before this fix the read path used
the block ID and the write path used the client id -- the two look identical in normal operation and only diverge
whenever the kernel assigns an id itself, and the symptom is a **duplicate block, not an error**.

### 6.18 "Stable for 18 seconds": when an effect rebuilds blocks, a check that is too early only sees the transient

**Symptom** (measured, defect #53): 甲 already had the child 子T; adding the sibling 同E **overwrote 子T's block** in
SiYuan -- what is left there is one block whose content is the new 同E -- while the UI still showed both children
(the two node ids differ, so the in-memory tree was right and only the write-back was wrong). An immediate structural
check could say "child list rebuilt, children present"; the state did not hold.

**Cause**: the insert **destroys and rebuilds blocks** inside the kernel. An immediate read describes the state
**at that instant**, and the rebuild is not finished (or the stale mapping has not been pruned yet). The check then
freezes the transient state and calls it the result.

**Measured**: after the fix, the rebuilt state was read again **18 seconds later** and was unchanged --
`['甲','  子T','  同E','乙','丙']` with the child list count = 1 (the count is per listItem, measured under 甲 in that
document). That wait is what separates "the new state is durable" from "the new state is just the first frame after a rebuild".

**Practice**:
1. Where an operation is known to rebuild blocks (any insert that triggers a structural rebuild, `updateBlock` on a
   whole document, undo/redo replay), a single read is not a verification. Re-read after a settling interval and
   compare -- a state that does not survive the interval did not land.
2. Keep that second read even when both values are as expected: what it guards is **drift**, and drift is exactly
   the failure mode of a "probably fine now" state.
3. This is a *measured* duration, not a timeout to sleep on: the read itself still polls to a stable value
   (6.10 / 6.11); the 18 seconds only say how long the settled state was held before being trusted.

★ **Lesson**: an assertion run at the wrong moment does not verify the subject, it verifies the moment.
Ask of every check that follows a mutation: **is it reading the result, or a frame of the operation?**

---

### 6.22 A red proof handed the user a deliberately broken build

**Symptom**: a mutation test passed -- the check went red on a verified mutation, the source file was
restored, everything looked clean. What also happened, silently, is that a plugin with one deliberately
dead dark-mode rule was live in the workspace the user was working in for the ~15s between the mutated
deploy and the restoring one.

**Cause**: the red proof ran `npm run deploy`, and that command deploys to **every** path in
`PLUGIN_DIRS` -- which includes the user's workspace, not just the isolated test instance. The two
instances each hold a copy of the plugin (that is deliberate, so neither side runs stale code), so
"deploy" is never "deploy to the test instance". `--target` does not help: it only *adds* a target.

**Practice**: a check that needs the build output (E2E, `verify`) must narrow the deploy explicitly and
show the narrowed list before the check runs:

```bash
PLUGIN_DIRS=<test-instance plugin dir> npm run deploy
```

`python3 scripts/redproof.py --deploy` does this, prints the single target it is about to use, and
deploys **again** after restoring the source (otherwise the mutated build stays in the instance). It is
the only sanctioned way to run a mutating check: the rule "a red proof is by definition a broken build,
so it must not touch the workspace the user is in" now has a tool instead of a memory.

★ **Lesson**: `code:0` on the deploy and a green final verdict say nothing about *where* the mutation
landed. Read the target list, not just the exit code.

### 6.25 A test filter that is not understood runs everything, silently

**Symptom.** `python3 scripts/run-e2e.py mindmap` was meant to run one suite. It ran the whole suite —— 98
tests in 12 files, 19.5 minutes —— and the three failures it reported belonged to `ctxmenu`, `outline`
and `viewstate`. They were read as failures of the suite that was asked for.

**Cause.** The runner appended the filter as a bare word (`npx playwright test mindmap`) and the word
was ignored. Nothing said so: the run was green-ish, took a long time, and named real tests. The
duration was the only clue, and a duration is easy to explain away ("E2E is slow").

**Practice.** In tooling, an argument that is not understood must be an error —— this is section 5.1
inside the test layer, the same shape as an environment variable that silently falls back:

* **Resolve the filter to what will run, and print it.** The runner matches the substring against
  `e2e/*.spec.ts`, prints `specs: e2e/mindmap.spec.ts`, and passes those paths to playwright. The output
  is now evidence of what was selected rather than a hope.
* **Refuse when nothing matches**, listing the available specs. "Ran everything because it did not
  understand the argument" wastes half an hour and, worse, attributes other suites' failures to the one
  that was asked for.
* **A filter change is verified with `--list`**, which needs no browser: `run-e2e.py mindmap -- --list`
  prints `Total: 23 tests in 1 file` before versus 98 after the fix. Cheap checks settle questions that
  a 20-minute run only obscures.

---

## A transient toast swallows every click in the dock

**Symptom.** A click on the plugin entry or on a toolbar button retries until the test times out, and the
failure looks like the product is broken:

```
locator resolved to <button class="">导图</button>
- attempting click action
  2 × waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - <div data-type="textMenu" class="b3-snackbar__content …">block not found: [<id>]</div>
      from <div id="message" class="b3-snackbars b3-snackbars--show">…</div> subtree intercepts pointer events
- retrying click action
```

It reads as a flake: the same case passes on a rerun, and the cases that failed were the *first* ones in
the file. In a run of seven cases, two or three failed and the rest passed, twice in a row —— which is
exactly the shape of a race, and is why it was first mistaken for the plugin not being loaded yet.

**Cause.** SiYuan's snackbar is anchored over the dock and takes pointer events while it is shown, so
every click inside the dock lands on the toast instead of the control. The toast is *correct*: the
message said the kernel could not find a block id the page had asked for (its wording is Chinese; we do
not match on that string anywhere, so this doc paraphrases it). A page still
showing a document that is then deleted makes the kernel raise `block not found`, and the toast outlives
the test that caused it.

**Practice.**
* **Dismiss transient overlays before clicking, as a precondition** —— `dismissSnackbars` in
  `e2e/mindmap.ts`, called from every helper that clicks in the dock. This is not "is the panel open":
  a toast says nothing about the panel, and the panel is usually fine.
* **Do not remove a document from under the page that is showing it.** Navigate away first (the export
  case's `finally` now reopens the main document before `removeDoc`), otherwise the next test inherits
  the toast.
* **A screenshot ends this argument in one step.** The toast, the resolved button, and the *closed*
  panel were all visible in the kept failure screenshot (`test-results/*/test-failed-1.png`), while the
  error text only said "click timed out". Reading the DOM would have shown a button that was present,
  visible, enabled and stable —— a clickable thing that no click could reach.

### A helper that clicks to make something open, when it is already opening

**Symptom.** Every E2E case spent about **10.4 seconds** in `ensureDockOpen`, and every one of them
reported `clicks=2`. Measured on three consecutive fresh contexts: 10.40s / 10.35s / 10.35s.

**Cause.** SiYuan records "is this dock open" in the icon's own `dock__item--active` class, which is
applied **at once** after a page load, while the panel's content mounts a moment later. So right after
`openDoc`'s readiness checks the state is:

| signal | value | reading |
|---|---|---|
| icon `dock__item--active` | **YES** | the dock *is* open; SiYuan is still mounting it |
| `.om-mm-viewswitch` | `n=0` | nothing rendered yet |
| the same page, 2.5s later, **with no click** | `n=1, width=420` | it opens on its own |

The helper's `isOpen()` looks only at the panel's width, so it saw `n=0`, answered "closed", and
**clicked** —— and a click *toggles*, so it closed the dock SiYuan was in the middle of opening. The poll
then spent its entire 10s budget waiting for a panel that could not appear, clicked a second time
(reopening it), and the case continued. The work was real; the 10 seconds were spent undoing it.

**Practice.** When a control toggles, the question is never "is it rendered?" but **"what state does the
application think it is in?"** —— ask the element that carries the persisted state (`dock__item--active`)
and then *wait for* the rendering, rather than acting on a signal that cannot distinguish "not yet" from
"no". After the fix the same three cases open in **0.3~1.0s with no click at all**.

★ The distinction that makes this a pitfall and not a typo: `isOpen`'s criterion was *measured*, and the
measurement recorded in its comment is correct —— `.om-mm-viewswitch` really is `n=1, w=0` when closed and
`n=1, w=122` when open **after a click**. What the measurement never covered was the state *before any
click*, where the panel is absent entirely rather than present-and-collapsed. A criterion can be right
about every case it was measured on and still wrong about the one it is asked first.

### A check whose criterion is "the result mentions the thing" cannot fail

**Symptom**: `scripts/verify-live.py` had a check named "content width follows the panel", written for a
real regression (a hardcoded `max-width: 860px`, after which the content stopped growing when the panel
was dragged wider). Its whole criterion was:

```python
check("content width follows the panel", r and "host" in r, r or "no result")
```

The page returned `{"host": …, "content": …}`, so `"host" in r` is true **whatever the two widths are**.
The check could not fail for the defect it names, and it read as coverage.

**Practice**: the criterion is the **comparison** (`content >= host - tolerance`, the tolerance being a
border's worth, not a cap), and a missing or unusable measurement is a failure rather than a pass ——
`panel_width_verdict` returns `(ok, detail)` and a page that answered "no element" is not "close enough".

★ The criterion was then made checkable without the desktop it needs: it is a function, and
`python3 scripts/verify-live.py --selftest` feeds it eight recorded measurements, three of which are the
cases the old criterion passed (a content capped at 860 while the panel grew, a reply with no content
measurement, and a page that found no elements). That selftest is a gate in `npm run check`, so the
criterion cannot quietly go back to being satisfied by the shape of the answer.

**Tests**: `scripts/verify-live.py --selftest` (8 cases; making the criterion always-true turns it red).

---

### A regression test aimed at the wrong entry point stays green

**Symptom**: `sameStyle` in `src/core/richtext.ts` tested the `formula` flag on the first run only
(`!a.formula`), so `mergeRuns([{text:'文本'}, {text:'$x^2$', formula:true}])` merged the formula into the
plain run and left the flag behind. A regression test was written for it —— asserting through `htmlToRuns`
that `文本<span data-formula="x^2">$x^2$</span>` yields two runs and keeps the flag —— and it passed **both
with and without the fix**. The red proof said so; without one, the case would have shipped as coverage.

**Cause**: `htmlToRuns` pushes a formula run **directly** (`runs.push({…, formula: true})`); it never goes
through the merge inside `pushText`. So the function under test was not on the path the assertion
travelled: the input produced two runs for a reason that has nothing to do with `sameStyle`.

**Practice**: aim the case at the entry point that really calls the criterion, and prove it by breaking the
implementing line (`scripts/redproof.py`) rather than by reading the assertion. Here the merge path is
`runsOf` in `src/core/layout.ts` (the mind map's own display path, which calls `mergeRuns`), so the case
lives in `layout.test.ts`, with a unit-level companion in `richtext.test.ts` that calls `mergeRuns` itself.
★ A case that passes before the fix is not "already correct" —— it is either insensitive or aimed at the
wrong layer, and the only way to tell is to break the line and watch.

**Tests**: `src/core/layout.test.ts` (the product path), `src/core/richtext.test.ts` (the merge itself).

---

### A body search that anchors on a line inside the body silently returns the wrong scope

**Symptom**: a check asking about a line inside a React effect got a **28-character** body ——
`{ alive = false; }`, the effect's cleanup closure —— and every assertion written against it would have been
made about code the check never meant to look at, while the output looked perfectly reasonable.

**Cause**: `fnBody(src, header)` takes the nearest function **starting at or after** the anchor. That is exactly
right when the anchor *is* the declaration (`fnBody(src, 'const pushUndo = React.useCallback(')`), and wrong
when the anchor is a statement inside a body: the answer is then the next nested function, which is often a
cleanup closure or an unrelated callback further down.

**Practice**: anchor on the header and use `fnBody`; anchor anywhere inside the body and use
`enclosingBody` (the innermost function that **contains** the anchor). They are deliberately two functions ——
making `fnBody` "find the enclosing function" would break every existing call site, since a header anchor is
also contained in the surrounding component. ★ The general lesson is older than this incident: a structural
probe that returns *something plausible* is more dangerous than one that returns nothing, so a body search
must be sanity-checked once (print its length) before a check is built on it.

**Tests**: `src/plugin/source-probe.ts` (`fnBody`, `enclosingBody`, `assignmentsTo`, `callArgs`,
`jsxElementsWithAttr`, `jsxElementsWithAttrContaining`).

---

### A text assertion is only as honest as its comment stripping

**Symptom**: a check that reads source text passes because the string it looks for is in a **comment**, while
the output claims the assertion was made about code. This is the silent-green direction: an assertion that
finds prose where it wanted code cannot fail.

**Cause**: `stripComments` was built on a TypeScript **scanner** run by this repository, with the scanner's
`Standard` variant. On any file containing JSX, JSX text desynchronises the scanner (an apostrophe or a
backtick inside a text node is enough), and from that point on a comment is swallowed into whatever token
spans it. Measured on `outline/Outliner.tsx`: an 11,058-character handler body came back with **41** comment
markers still in it, and a comment at offset 95,952 was inside a 277-character `FirstTemplateToken`. The
`JSX` variant did not fix it either —— the desynchronisation is not only about JSX text.

**Practice**: strip the comments the **parser** attached, not the ones a scanner of our own finds. The
compiler already knows where they are, and it is variant-independent: the trivia between a node's children,
before a closing brace, and at the head and tail of the file. Two details cost a round each ——
`getLeadingCommentRanges` returns own-line comments only (a comment on the same line as code is a *trailing*
comment, so both must be collected), and it must be asked from a position **inside trivia**
(`child.getFullStart()`, never `child.getStart()`, which is a token and returns nothing at all).

**Tests**: `src/plugin/source-probe.test.ts` (the shapes: own-line, same-line, first line of a block, before a
closing brace, a string holding slashes, JSX text), and `npm run check` as the blast radius —— after the fix
no existing check went red, which is the evidence that none of them had been matching prose.

---

## A probe that drives the gesture wrongly reports the product as broken

**Symptom**: "the outline's drag-to-reorder is broken —— dropping a row above another does nothing." Believed,
written into `docs/MAPPING.md`, and about to be reported as a bug. The gesture works in all three zones.

**Cause**: two independent mistakes in the **probe**, neither in the product.

1. The press landed on the row's **text**, but the only `draggable` element is the **bullet**
   (`.om-bullet`). No drag ever starts, so the drop does nothing — and a gesture that does nothing is
   indistinguishable, from outside, from a gesture that is broken.
2. The summary compared the document's lines **joined with a separator** (`.join(' > ')`), which flattens
   indentation. A successful `child` drop (`甲` / `  - 丙`) and a `below` drop (`甲` / `丙` / `乙`) then
   print identically, so a working nesting looked like a plain reorder.

**Practice**:
- Press the element that actually carries `draggable`, and say so in the helper: `dragRowOnto` presses the
  bullet, deliberately. A helper is where this knowledge belongs — a caller re-deriving the gesture is how
  the same wrong probe gets written twice.
- Never assert on a **flattened** rendering of a tree. Assert on the indented markdown, or on the row's own
  geometry; indentation *is* the data in an outline.
- `e2e/outline.spec.ts` now covers all three zones end-to-end. It was written *because* the zones had only a
  rule-level unit test and no case at all —— which is what let "it works" and "it is broken" both be
  believeable without evidence.
- Shown red before keeping: disabling `moveDrop`'s `child` branch fails the case on **that zone only**, with
  the other two still green.

★ The same shape as the mind map's descent bug and the dock helper: the criterion was wrong, the product was
fine. When a measurement says "broken", suspect the measurement first — this repository has now paid for that
lesson five times.

## A drag case that drags the wrong row tests nothing about the rule

**Symptom**: a new case for "moving a row carries its subtree" passed **with the subtree-dropping mutation in
place**. It looked like coverage and had no defensive value.

**Cause**: the case built a multi-selection (a parent 甲 and its child 乙) and then dragged a **third** row,
丁. A drag replaces the selection with the row under the cursor, so `moveDrop` received `tops=[丁]` — a
single childless row. The subtree was never touched, so nothing about subtrees could fail.

The instrumented handler said so on the first run: `OLMOVEDROP zone=above tops=[丁] moving=[[丁, 0]]`, where
the `0` is the child count of the row actually being moved.

**Practice**:
- **Log what the handler receives** when a red proof will not go red. `tops` / `moving` names the row and its
  child count, which turns "the test is useless" from a guess into a reading. This is the `--show-targets`
  lesson again: ask the thing that decides.
- A drag case must drag **the row the rule is about**. Say which row the case picks and why, in a comment, so
  the next person does not "simplify" it back to a row that proves nothing.
- **A case that cannot go red is not coverage.** Both this file and `docs/TESTING.md` already say it; the
  only way it gets caught is by running the mutation, every time, before keeping the case.

## A work queue whose citations rot is a queue nobody can act on

**Symptom**: `docs/AUDIT-FINDINGS.md` had been sitting as the repository's only work queue for days. Nothing
had noticed that **five** of its entries cited a place that no longer existed: two test files deleted by the
commits that fixed them, and three files shrunk past the cited line (one by 61 lines).

**Cause**: an entry leaves the queue "by being fixed, or by being refuted in writing", and **neither half
had a check**. The fixed half left a commit behind but the entry stayed; the refuted half left nothing at
all, because the reasoned refutations happened in a run whose reports were deleted. So every entry —— live,
fixed, or stale —— rendered identically, and the file's own header still advertised a tally from the day it
was written.

**Practice**:
- **A queue needs a staleness check, not just a format.** `scripts/check-audit-findings.py` resolves every
  citation and fails on the two states with no judgement in them: the file is gone, or the line is past the
  end. Those have exactly two meanings (fixed, or moved) and both are actionable.
- **Do not let a tool decide whether a defect is fixed.** A substring search cannot tell a fixed defect from
  an edited line, and a gate that guessed would train people to silence it. The tool reports `drifted` and
  `cannot-judge` and says plainly that those need a person —— the second is the list of entries to open
  first, because the finding names no symbol to search for.
- **A tool that drops input and reports success is worse than one that fails.** The first version parsed 205
  entries out of a file holding 206 and said nothing: one entry carried trailing prose after its citation,
  which the strict pattern rejected. Counting the entries the *loose* pattern sees and refusing to run on a
  mismatch is what caught it —— the same "fail loudly rather than pass vacuously" rule as everywhere else.
- **Re-derive totals instead of transcribing them.** The header's per-area table is the record of what that
  review produced and is kept; the current count is computed from the entries, so it cannot drift again.
- The first version of *this tool* searched for any word of seven characters or more, so the README finding
  ("The Chinese README still documents …") searched for `Chinese` and `documents` —— prose no source file
  contains —— and reported **60** entries `drifted` on a criterion that meant nothing. Only
  **identifier-shaped** tokens (underscores, SCREAMING_CASE, camelCase) are useful signal; when a finding
  names none, the honest answer is `cannot-judge`.

## A test that reads product source can only fail on a rewording

**Symptom**: a refactor that merged two hand-written cycle guards into one shared helper — behaviour
identical, every E2E case green — turned `src/plugin/mindmap-reparent.test.ts` **red**, because it
regex-matched the old guard's *name* in `mount.ts`. The suite reported a regression that did not exist, and
the obvious "fix" was to update the pattern.

**Cause**: fifteen test files read a product `.ts`/`.tsx` file as text and asserted on its contents, with
**no import of the product at all**. Nothing in them could execute product logic, so the only thing they
could ever detect was that the source had been reworded. They read like coverage — file names, `check()`
calls, dozens of assertions each — and 15 × ~200 lines is a lot of green that means nothing.

**Practice**:
- `scripts/check-source-text-tests.py` is the gate. Its criterion is a **pair**, not either half:
  the file reads product source **and** imports nothing it could execute. Either alone has legitimate
  cases that this repository actually contains —— reading the built bundle (`dist-plugin/index.js`) is real
  output, and `source-probe.test.ts` tests the probe that reads source.
- **Replace, do not just delete, when the rule is worth keeping.** The cycle refusal became an E2E case
  that drags a node into its own subtree and asserts the document is left **exactly** as it was; shown red
  by disabling the guard. That is a check that fails when the product breaks.
- **Deleting tests has consequences; follow them.** Removing the files broke four gates at once, each
  correctly: two docs cited a deleted test, twelve ledger entries named one, and two fixture-vocabulary
  words were left with no user. A deletion that leaves those red is not finished.

## Consolidating duplicated code exposes what the copies disagreed about

**Symptom**: none at first. Five copies of an HTML escape/decode pair, three files, all producing identical
output on ordinary text.

**Cause**: two of the five decoded `&amp;` **before** the entities it can create, and three decoded it
**last**. On ordinary text the orders agree. On text that *contains* an entity name they do not: a user who
types `&nbsp;` stores `&amp;nbsp;`, and the wrong order turns those six characters into one space. Nothing
had written down which order was right, so the divergence had no owner.

**Practice**:
- **A duplicate is a place where two answers to one question are stored, and only one can be checkable.**
  The reason to consolidate is not tidiness —— it is that the disagreement is invisible until an input
  distinguishes the copies, and by then it has been shipping.
- **Write down the part that is not obvious, at the point where it matters.** The correct order is now a
  comment in the shared function *and* a case that fails with the wrong order (`want="&nbsp;" got=" "`).
  "Decode `&amp;` last" is the kind of fact that is obvious to whoever wrote it and invisible to whoever
  edits it next.
- **Measure equivalence before consolidating, then trust the measurement rather than the resemblance.** The
  five flatten copies were compared on a chain, a wide tree, an empty list, a missing `children` key and a
  five-deep tree; identical on all five, so merging needed no judgement. The escape copies *looked* just as
  alike and were not.
- **★ A "mechanical" refactor is where semantic slips hide.** This round's consolidation silently dropped a
  trailing `.trim()` (turning a `<br>`-only kernel echo into `" "` instead of `""` —— a spurious conflict on
  every empty node) and added a `snapshot()` clone the original never did. Read the diff line by line after
  the tests pass, not only before.

## A load average above ~3 makes the E2E suite lie about the plugin

**Symptom**: four cases in one full run failed at **46.7–48.4s** while every other case passed in ~5s. The
error said *"the plugin may have failed to load — check the browser console for an onload error"*. Re-run in
isolation: still failed, same 46.7s. That looked like a real regression in the build.

**Cause**: nothing was wrong with the build. Measured on the same commit:

| machine | case | result |
|---|---|---|
| load average 5.3 | `cancelling the confirm dialog does not delete the node` | ✘ 46.7s |
| load average 1.6 | the same case, same build | ✓ 11.6s |

A probe on the "failing" build printed `[native-outline-mindmap] plugin loaded`, and the panel's
`.om-mm-viewswitch` measured 420px wide **before any click** —— it was never closed. The uniform ~47s
ceiling is the tell: real failures vary, a fixed timeout is flat.

**Practice**:
- **Check `uptime` before believing an E2E failure.** Above ~3, the suite's fixed timeouts stop measuring
  the product. The 46–48s cluster and the ~5s passes in one run is the signature.
- **"Failed in isolation" is not proof of a regression** when the machine is loaded —— the isolation run pays
  the same contention.
- **★ The message is part of the defect.** This one named the plugin for a machine problem and sent the
  reader to the browser console, where there was nothing to find. It now lists the three things to check in
  order: host loaded (the plugin's own console line), machine loaded (`uptime`), onload error last.
- A red proof or a verification run that must be trustworthy should be re-run once the load is back down,
  and the load written into the report either way.

## A pinned count of call sites goes red for a fix

**Symptom**: `src/plugin/mindmap-focus.test.ts` failed with *"the restore is not called from anywhere
unexpected (4 close paths)"* after six context-menu actions were given the `focusCanvas()` restore they
needed. No behaviour regressed —— the keyboard had been dead after every one of those items.

**Cause**: the check was `callSites(src, /^focusCanvas$/).length === 4`. It reads like a guard against an
unexpected new caller, but a count cannot tell **"an unexpected caller appeared"** from **"more callers are
now correct"** —— and the second is what a fix looks like. It also never asked whether focus actually
returned, which is the only question that matters.

**Practice**:
- **Assert the behaviour, not the count of places that implement it.** `e2e/keyboard.spec.ts` drives the real
  context menu, asserts on `document.activeElement`, and then presses Tab to prove the keyboard *works* ——
  focus being set and the keyboard working are different claims, and only the second is what the user has.
- **A count is acceptable when it is a precondition, and must say so.** `echo-guard.test.ts` uses
  `callSites(...).length >= 2` under the check *"this is the precondition of the check above: if nothing
  called the helper, an empty list of hand-rolled windows would mean nothing"* —— that is honest, and `>= 2`
  cannot be broken by adding a correct caller. `ref-nav.test.ts`'s `=== 1` is a real invariant (one
  `openTab` call site in the application). The deleted one was neither: it was an exact count of *correct*
  call sites, which is a number that only grows.
- **When a source-text test fails on your fix, that is information about the test.** Ask which of the two it
  is before touching the product: if the fix added something correct, delete the count and replace it with a
  case that drives the behaviour.

## A serialization that ignores shape says "unchanged" about a re-parented tree

**Symptom**: `Shift+Tab` then `Tab` pressed back to back left SiYuan unchanged while the outline showed the
indent. With a pause between the keys it worked —— reported as "it works probabilistically". No error, and the
screen was right, so nothing looked broken until the document was re-read.

**Cause**: `serializeTree` is the evidence for the write-coalescing decision *"did the tree change again after
the previous write-back?"*. It emitted a flat `id:text` sequence for every node, with **no nesting and no
child order**, so:

```
甲 | 乙 | 丙        (flat)
甲(乙) | 丙         (乙 indented)
```

produced **byte-identical** strings. The catch-up write was skipped. Traced on the running build:

```
[A] onChange kind=struct shape= 98uu | t7vl | uxa6        ← Shift+Tab changed no tree
[C] write callback read shape= 98uu | t7vl | uxa6         ← so W1 wrote the flat tree
[mv] → SKIP (already in place)  ×3                        ← W1 correctly had nothing to move
[A] onChange kind=struct shape= 98uu | ␣t7vl | uxa6       ← Tab indented 乙
[B] catch-up: nodesRef shape= 98uu | ␣t7vl | uxa6         ← the indent IS in nodesRef
→ no second write callback, no second moveNodes pass      ← the check said "unchanged"
```

**Practice**:
- **A "did it change?" fingerprint must encode every way the thing can change.** This was the *third*
  appearance of the same pitfall in one function, and the first two were fixed the wrong way —— by adding
  fields (the note, then `paragraphs`) rather than by encoding the tree's **shape**. Adding a field cannot
  catch a change that moves a node without altering it, so the bug replayed on the next field that mattered.
  Parentheses around each node's children close the class.
- **Keep the coalescing win.** The fix must not make every write look like a change: a genuinely identical
  tree still compares equal, which is what the existing cases confirm.
- **A race with a window is not "probabilistic".** Two variants of the same gesture differ only by *when* the
  second key arrives; writing both as cases converts the report into a deterministic failure, and the pair
  also documents the workaround users had found for themselves.
- **Assert on the document, not the screen, when the screen is what lies.** The outline was correct
  throughout; only `exportMdContent` showed the truth.

---

## A band that under-reports its extent makes the drawing wrong, and the obvious assertions still pass

**Symptom** (reported): "the mind map's child nodes seem to drift downward for no reason", and "by rights
they should be level".

**What it was.** Three parents each holding exactly one child drew as a staircase —— 345 / 374 / 403 / 432,
one step per node —— so **parent B was drawn level with parent A's child**. `subtreeH` reports the vertical
band a subtree reserves, and the layout stacks those bands to place siblings.
(Single children are now horizontally parallel with their parents (`child.y === parent.y`) by standard mindmap design, with `subtreeH` reserving `Math.max(h + V_GAP, children)`).

**The practice, and the reason this entry exists:** the first two regression tests written for it **passed
with the defect restored**, so they would have shipped a fix nobody could keep honest.

| assertion | why it passed on the bug |
|---|---|
| scan every box pair for overlap | a parent and the previous sibling's child are in **different x columns** —— they never overlap |
| "are the siblings evenly spaced?" | the staircase is **perfectly** evenly spaced (48, 48) |
| "no two nodes share a y" | the **root** is centred over its whole band and legitimately shares a y with a descendant |

So:

- **Check the assertion against the defect, not against the fix.** Each of the three was written from "this
  sounds like it should hold" and only the third attempt was tested with the bug put back. Running it once
  green proves nothing about what it can see.
- **A property the defect also satisfies is not a criterion.** Even spacing, non-overlap and "all y values
  distinct except the root" are all *true of the buggy layout*. The property that separates them is
  **order**: reading down the page must give parent → child → next parent → its child.
- **Locate the defect in one number before choosing the assertion.** Here the whole bug is "parent B and
  parent A's child share a y"; the failure message now names that (`p2 is not below the node before it`)
  rather than describing geometry in general.
- **A layout bug raises nothing and only looks wrong**, which is why `src/core/layout.test.ts`'s own
  docstring asks for these invariants at the pure-function level. It is also why the earlier three-child
  case could not see this one: with siblings that have **no** children, centring already separates them and
  the *forcing* path never runs. **A branch is only covered by a case that reaches it.**

### 6.9t A race case that passes for a different reason than the race

**Symptom.** A new data-race case stayed **green with the race restored** —— twice in a row, and the second
time after an explicit attempt to make it specific.

**Cause, first time.** The case asserted a conflict on a tracker that a **previous case in the same block had
already used**:

```
tracker.check('n1', '甲', '甲', true)       // current === incoming -> synced.set(n1, '甲'), returns false
tracker.check('n1', '乙', '丙', true)       // base is now 甲, and the fallback ...
```

With the in-flight rule removed, the second call still answered `true` —— by falling through to
`base !== current` instead. The assertion could not tell the rule under test from the fallback that replaced it.

**Cause, second time (the interesting one).** After giving each case its own tracker, the case used a state where
the fallback **also** answers "conflict": baseline `甲`, current `乙` (already drifted). Removing the
in-flight rule still returned `true`.

**What actually isolates this rule.** Only `baseline == current`:

| state | fallback branch | answer |
|---|---|---|
| baseline == current (`甲`/`甲`), no write in flight | "local value still equals the baseline → accept" | **no conflict** |
| baseline == current (`甲`/`甲`), write in flight | the in-flight rule | **conflict** |

So the case must hold `base == current` and differ only in `writeInFlight`. It is now pinned as a **pair** —— the
same state with the flag off must answer *no conflict* —— because otherwise "conflict for any differing incoming
value" satisfies it and the pair is what makes it specific.

**Practice.**

- **Put the defect back and run it, every time.** Both versions were plausible, read correctly, and were green.
  Neither survived the mutation, and nothing except the mutation would have said so.
- **A case inherits the state its predecessors left.** Give each assertion its own fixture when the code under
  test keeps state —— sharing one tracker is what made the first version vacuous.
- **Pin the negative next to the positive.** "This state is a conflict" is only evidence when "the same state
  with the one difference removed is not" is asserted beside it; otherwise a rule that always says *conflict*
  passes both.
- **`AGENTS.md` §7 already says this** ("before believing a red-proof, check the mutation is the one the
  criterion reads"). The trap is that here it was *my own* mutation and my own criterion, and the criterion was
  the thing that was blind —— which is why the red proof is not a formality to run after the test looks right.
