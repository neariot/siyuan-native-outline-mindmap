# Pitfalls · Debugging Methods and Tools

← [Master index](../PITFALLS.md) | Things we have stepped on once and do not want to step on again; each entry is "symptom → root cause → practice".

Entry numbers (such as `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by number,
so when splitting the file we keep the original numbers and do not renumber. The numbers do not indicate order within this file;
the `6.x` ones were moved here by topic from the original "Engineering and Testing" section.

### 6.5 Two pitfalls of CDP screen recording

**Symptom**: the recorded video has no content / only the first frame.

Pitfall 1: `Input.dispatchMouseEvent` is mandatory —— a synthesized `dispatchEvent`
does not enter React's synthetic event system, so clicking is as good as not clicking.

Pitfall 2: `Page.startScreencast` only emits frames if a repaint is actively produced.
But `requestAnimationFrame` cannot be used —— rAF will flood the send queue,
and the frame count drops to zero after the first burst. Use a ~12fps timer.

---

### 6.6 Verification must poll, not sleep for a fixed time

**Symptom**: same build, same case, a fixed `wait_for_timeout(16000)` failed 1~2 times out of 4;
after switching to polling, 4/4 passed.

**Root cause**: the kernel does **not** write to SQLite synchronously per transaction; it does a **periodic batch flush**.
Measured (`scripts/kernel-index-lag.py`):

- Insert 5 blocks in a row with ~20ms gaps; they become queryable **in the same millisecond** (span 0ms)
  ⇒ they land as a batch, not one by one;
- The flush interval is **irregular**; measured 773 / 1112 / 1368 / 1623 / 1888 / 2213 / 2782 ms,
  median about 1.7 s;
- Querying SQL immediately after an insert almost never finds anything; you have to wait for the next flush moment.

So whether "sleep a fixed N milliseconds" works depends on the **sampling phase**: landing at the start of a period is enough,
landing at the tail is not. This explains why the same fixed value works sometimes and fails other times ——
and why Δt looks **sawtoothed** when you look at a few measurements in isolation (the sum of two adjacent ones ≈ one period).

**Practice**: poll until the content reaches the expectation, and after a hit wait another 2 seconds to confirm there is no further change.

The criterion must be "has the expectation been reached", not "how long have we waited".

★ **The polling budget must exceed the worst flush interval**, otherwise it gives up before the block lands,
which shows up as "I changed it and nothing happened" with no error.

**Measured pitfall (2026-10-08)**: the two polling loops on the write-back path were
`12 × 120ms = 1440ms`, while the measured worst flush interval is **2782ms**
⇒ on about half of the phases it gives up early. The consequence is the same class of symptom as the original bug
described in the comment there ("the UI shows 7, SiYuan has 0 written to disk, and no error at all").

**Practice**: use the two constants from `store.ts` uniformly (`POLL_ROUNDS` /
`POLL_INTERVAL_MS`, currently 20 × 200ms = 4000ms),
leaving about a 1.4× margin over the measured worst value.

When changing these two constants, **both places must stay in sync**:
- `POLL_BUDGETS` in `scripts/kernel-index-lag.py` (it reports the ones that are too tight);
- `src/siyuan/poll-budget.test.ts` checks that the two sides agree.

**Incidentally**: the return value of `insertBlock` already carries the child paragraph block ID
(the HTML in `doOperations[0].data` has 3 `data-node-id`s, the last one being the child paragraph block),
so there is no need to wait for the SQL index.

---

### 6.9 `getComputedStyle` returns the "resolved property value", not the "rendered result"

**Symptom**: verifying whether text color in the mind map is faithful, the probe measured the `fill` of an SVG `<text>`,
read `rgb(32, 35, 43)` (the theme's dark gray), and therefore concluded "the color is lost".
**But in the screenshot that line of text is clearly red.**

**Root cause**: the color is actually on the **inner `<tspan>`**, while the `fill` on `<text>`
is overridden by the `tspan` and **does not participate in the final painting**. That outer value is only the "resolved property value",
unrelated to "the color the user sees".

Same class of pitfall:
- `dominant-baseline`: the browser centers by **font metrics** rather than glyph ink,
  so the computed style looks right while Chinese text actually sits too high (especially obvious in Safari);
- `<svg>`'s own `getBoundingClientRect()` may be `0×0`,
  even though the drawing is perfectly fine (it is painted inside a nested `<g>` with a transform) ——
  if you want to measure, measure the actual shape elements.

**Practice**: for any judgement about "does it look right", **always take a screenshot and look at the pixels**,
do not let DOM measurements replace your eyes. The DOM is good for answering "is the property written correctly",
and bad for answering "what does it look like when rendered".

**Why:** The answers to these two questions can be completely opposite, yet the probe will only ever give you a confident number.

---


### 6.12 Debugging UI issues by reading the DOM without a screenshot —— a dozen reads, all lying to myself

**Symptom**: the user reported "pressing Enter does nothing". I repeatedly read
`document.querySelectorAll('.node-row').length`, **the number was normal the whole time**,
so I suspected the keyboard events, the focus, the async timing one after another, and several rounds of changes did not help.

**Root cause**: one screenshot showed it immediately —— the panel **really did render the nodes**, but they hung under
a hidden tab, and were not displayed on screen at all. A DOM query cannot see this:
the element exists, has content, `querySelectorAll` counts it, but the whole ancestor chain is
`fn__none` / `0×0`.

**Practice**: for UI defects in the browser (layout, visibility, click target, misalignment),
**take a screenshot and look before deciding what to change**. Judging "did it take effect", "what does it look like", "did the click land"
all require visual confirmation; do not let DOM measurements replace your eyes.

**Why**: a DOM count **will always give you a number**, and that number may describe an area the user
cannot see. It does not raise an error; it just keeps you editing code against a problem that does not exist.

---

### 6.19 A kernel operation can fail, roll the document back, and still return `code:0`

**Symptom**: the user's report is only "nothing happens" —— the local state advanced
(it thinks the move succeeded), the document did not change, and no observable signal in the
plugin says otherwise. Every signal a caller normally uses is green:

| Signal | What it shows |
|---|---|
| return value | `code:0`, `msg` an empty string —— **byte-identical to a real success** |
| exception | none is thrown |
| console | clean, there is no stack to look at |
| UI | no message, no error, nothing visibly wrong |

**Measured (kernel 3.1.x, one document `# repro` holding the three list items `- 甲` / `- 乙` / `- 丙`)**: `moveBlock`
with `previousID` pointing at the **List block `l`** (a real block, wrong type) returns
`{"code":0,"msg":"","data":null}`, while the document content is **exactly what it was before**
(`['甲','乙','丙'] -> ['甲','乙','丙']`). The same call anchored on a listItem returns the same
`{"code":0,"msg":""}` and *does* move. Success and failure are indistinguishable from the return value.

**Root cause**: the transaction validator **does detect** the illegal structure and rolls back, and the
FAILURE side is written down —— but only to the **kernel log**, where the API return value does not follow
it:

```
E transaction.go:142: transaction failed and requires UI reload:
  invalid block structure: NodeDocument [...] cannot contain NodeListItem [...],
  operations [0:move id=... parent=... previous=... next=]
```

**Practice**:
- After any block operation like this, **read the document back** (`getBlockKramdown`) and compare with
  what it was before; treat "`code:0` but the document did not change" as an explicit `ok:false` with a
  readable reason. The contract test for this is
  `src/plugin/kernel-bugs.test.ts` ("\"code:0 but nothing changed\" must be treated as a failure").
- ★★ **The only clue is in the kernel log** (`transaction.go:142`) —— so when a write "did nothing",
  look there *before* re-reading the plugin code. It is a graded signal, not a guess:
  the return value / the exception / the console / the UI are all silent, and the log is the surface that is not.
- ★★★ Do **not** keep adding probes when local state and the store already disagree. The productive move is
  to **align the return value with the final store state** (read back after the operation, and let the
  caller reject a no-op) instead of instrumenting the same silent path a fifth time.

**Why the numbers live here and not in the test**: `kernel-bugs.test.ts` / `kernel-side-effects.test.ts`
keep the *shape* of the behaviour and nothing else (`code:0` + an empty `msg` for both outcomes, the
read-back contract, "every probe green while the store changed") —— a printed number inside a test cannot
go red, so it is not evidence. The measurements themselves are here and in
`.logs/kernel-bug-report.md` (defect 1).

---

### 6.20 The one error message three different causes share —— and the crash stack that names the real one

**Symptom**: an operation is rejected with
`` "`previousID` can not be the ID of a document" ``, so the whole debugging round goes into
hunting a document ID that was passed down. Measured, that same message is returned for **three**
different anchors, two of which have nothing to do with a document ID at all:

| `previousID` points at | Message returned |
|---|---|
| a document ID | `` "`previousID` can not be the ID of a document" `` |
| a **nonexistent** ID | **exactly the same** message |
| an ID that was **deleted** | **exactly the same** message |

**Root cause**: the message is a single canned string from the anchor validation in `moveBlock`; it does
not classify what the anchor actually *was*. Reading it as a diagnosis is what sends the investigation in
the wrong direction.

**Practice 1 (the message)**: **do not identify an anchor by a title or by the error text** —— look the
block up yourself (`id` / `type` / `parent_id`) before calling, and reject the call when the type is `d`
(document root) or `l` (List container).

**The other half of the same anchor: this one does not fail soft.** When the anchor is a **document root**,
the kernel does not write a polite message at all —— it crashes, and the stack is the only thing that
names the real cause:

```
kernel/model.(*Transaction).doInsert0   transaction.go:1799   <- the nil pointer is here
```

`insertedNode.Parent` is **nil** at `transaction.go:1799` (`operation.ParentID = insertedNode.Parent.ID`):
a document root has no parent context, so after the insert the new node's `Parent` is never set, and the
next line dereferences it. Measured **5/5 calls, 100% reproducible** —— this is a deterministic crash, not
a timing artefact.

**Practice 2 (the crash)**: read the **crash point's source line** before theorising about the API contract.
`doInsert0` + `transaction.go:1799` says "the parent relation of the inserted node could not be resolved",
which is a far more precise statement than anything the caller can see.
The anchor type rules themselves live in [`kernel-api.md`](../kernel-api.md) 7.1 (that document holds the
kernel behaviour; this entry holds the debugging detour).

**Why**: a rejected call and a crashed call share the same anchor, yet the first one hands you a message
that names a **different** cause and the second one hands you nothing but a stack. ★ `moveBlock` **has**
the guard and rejects a document-ID anchor cleanly (`code:-1` + that message), while `insertBlock`
**does not** —— the check exists next door and was not copied, which is itself the hint about where the
fault sits.

### 6.21 Probing the running instance: `Tab(url)` opens a NEW tab, so you measure a blank page

**Symptom**: a read-only probe asking whether the running SiYuan exposes `window.siyuan.ws.app` answered
`typeof window.siyuan === "undefined"`, and every candidate path came back missing. The conclusion "this
kernel version does not expose the application instance" was one step from being written down as a fact,
and it would have been wrong: the real page reports `window.siyuan.ws.app` as an object whose `plugins` is
an array.

**Cause**: `scripts/cdp.py`'s `Tab(url)` **opens a new tab and navigates it to `url`** —— it does not attach
to an existing page. Passing the CDP endpoint (`cfg.cdp_http`) therefore measured a fresh tab showing the
DevTools endpoint, where `window.siyuan` is undefined because SiYuan is not loaded there at all. The tab
list gives it away: the probe's own tab is titled `127.0.0.1:9333`, next to the real one
(`… stage/build/desktop/?id=…`).

**Practice**: to read the **running** page, connect to the existing target's `webSocketDebuggerUrl` from
`/json/list` and send `Runtime.evaluate` —— read-only, and nothing is left behind (`Tab`'s tab must be
closed by hand anyway; two probes left two tabs titled after the endpoint). Pick the target by its URL
(`/stage/build/`), never "the first tab", and never trust a negative global read without checking **which
page** it came from. The same trap applies to any "does the plugin expose X" question: an empty page
answers no to everything.

**Why it matters**: this is the false-signal family (see `TESTING.md`: false signals are more dangerous than
false failures). A blank page does not fail —— it answers every question about the product with a clean,
confident "no".

---
