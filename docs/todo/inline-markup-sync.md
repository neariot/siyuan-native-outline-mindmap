# Inline markup & toolbar sync

Plan and evidence for the class of defects where **what the outline shows and what
SiYuan holds disagree**. Every entry below was measured; the measurement is named so
it can be re-run, and none of it is a reading of the source alone.

Status: **D1–D20 fixed and verified**, D9 included, and table cells are editable.
D19 (§7) is the one defect here whose proof is **run counts, not `redproof.py`** — said so where
it belongs, because the tool runs the check once per side and this defect is a race.

---

## 1. The shape of the problem

There are three stages between a toolbar button and the document, and the plugin has
**two serializers that do not agree with each other**:

```
toolbar button ──▶ node.text (HTML fragment) ──▶ htmlToSiyuanDom ──▶ updateBlockDom(dataType:"dom")
                                     │
                                     └──▶ htmlToKramdown ──▶ updateBlock(dataType:"markdown")
                                                                └─▶ saveNodesIncremental's *change detector*
```

The write for node text is the **DOM** path (`store.ts` `saveNodesIncremental`), which
goes through `htmlToSiyuanDom`. `htmlToKramdown` is not dead code: it is the body of
every markdown write (task creation, list-item creation, subtree updates).

So a markup that only one of the two understands is either dropped on the way to the
kernel, or mis-detected on the way to the write. Most of what follows is one of those —
and the *detector* turned out to matter more than expected, because a correct serializer
changes nothing if the write never happens.

## 2. What the kernel actually accepts

Measured by writing one `<div data-type="NodeParagraph">…</div>` per row through
`/api/block/updateBlock` with `dataType:"dom"` and reading `getBlockKramdown` back.
Probes: `.tmp/audit-sync/probe_kernel.py`, `probe_kernel_tags.py`,
`probe_kernel_native.py`, `probe_roundtrip.py`; logs: `.logs/audit-*-probe*.log`.
Isolated test instance only.

| Written | Kernel kramdown | Verdict |
|---|---|---|
| `<span data-type="strong">X</span>` | `**X**` | ✅ |
| `<span data-type="em">X</span>` | `*X*` | ✅ |
| `<span data-type="s">X</span>` | `~~X~~` | ✅ |
| `<span data-type="u">X</span>` | `<u>X</u>` | ✅ |
| `<span data-type="code">X</span>` | `` `X` `` | ✅ |
| `<span data-type="strong em">X</span>` | `***X***` | ✅ |
| `<span data-type="code strong">X</span>` | ``**`X`**`` | ✅ |
| `<span data-type="strong" style="color:#dc2a2a;">X</span>` | `**X**{: style="…"}` | ✅ |
| `<span data-type="a" data-href="…">text</span>` | `[text](…)` | ✅ **a `<span>`, not an `<a>`** |
| `<span data-type="block-ref" data-id="…">T</span>` | `((id "T"))` | ✅ |
| `<span data-type="inline-math" data-subtype="math" data-content="E=mc^2">…</span>` | `$E=mc^2$` | ✅ |
| `<span data-type="img"><span><img src data-src alt></span></span>` | `![alt](assets/a.png)` | ✅ |
| `#proj text` (plain text) | `#proj text` | ✅ **a tag is plain text** |
| `<b>X</b>`, `<i>X</i>`, `<strike>X</strike>` | `<protyle-html>` | ❌ |
| `<a href="…">text</a>` | `<protyle-html>` | ❌ |
| `<img alt src>` | `<protyle-html>` | ❌ |
| `<font color="…">X</font>` | `<protyle-html>` | ❌ |
| `<table>` (inline **or** nested in the paragraph div) | `<protyle-html>` | ❌ a table must be its own block |
| `insertBlock` with a `NodeTable` **DOM** | — | ❌ answers `code: 0` and creates nothing |
| `insertBlock` with a **markdown** table | a real table block | ✅ the only way that works |
| `<span data-tag="p">#p</span>` | `<span data-type="text">#p</span>` | ❌ attribute dropped |
| `<span data-noderef="id">T</span>` | `<span data-type="text">T</span>` | ❌ **the reference is destroyed** |
| `<span data-formula="E=mc^2">…</span>` | `<span data-type="text">$E=mc^2$</span>` | ❌ |
| `<span style="font-weight: bold;">X</span>` | `<span data-type="text" style="font-weight: bold;">X</span>{: …}` | ⚠️ a **CSS style**, not `**X**` |
| `<span data-type="strike">X</span>` | `X` | ❌ silently dropped (wrong type name) |

The accepted-attribute names are not guesses: they are what lute reads
(`parse/inline_html.go` `SetTextMarkNode` → `util.GetTextMarkAData` /
`GetTextMarkBlockRefData` / `GetTextMarkInlineMathData`) and what lute writes
(`render/protyle_renderer.go`).

## 3. Defects

Ordered by severity. Each states the measurement that proves it.

### D1 — `wrapSelection` deletes the selected text (data loss)

`Outliner.tsx` `wrapSelection(before, after)` calls
`insertHtml(r, el, \`${before}${after}\`)` — it never reads the selection, so the
selected text is **replaced** by an empty wrapper. The inline-code button is its only
caller.

Measured (E2E, `.logs/audit-toolbar-probe3.log`):

```
RESULT inline-code
  before      <span>ABC</span>
  afterClick  <code></code>
  kramdown    -                       ← the kernel holds nothing
  afterReload
```

### D2 — Text colour is corrupted on every document load (data corruption)

`kramdownToHtml`'s tag rule is `/(^|[\s(])#([^\s#]+)/g`. It runs on the **whole
string**, so it also matches a hex colour **inside a `style` attribute**:

```
in   <span data-type="text" style="color: #dc2a2a;">ABC</span>{: style="color: #dc2a2a;"}
out  <span data-type="text" style="color: <span data-tag="dc2a2a;">ABC</span>{:">#dc2a2a;">…
```

The mangled HTML is what the node holds; `htmlToKramdown` does not repair it, so the
**next save writes the garbage back into the user's document**. Colour is destroyed
permanently, with no error anywhere.

### D3 — Every markup-*removal* edit is silently dropped

`saveNodesIncremental` decides "this block needs no write" by comparing
`htmlToKramdown(node.text)` against `blocks.content`. Measured: **`blocks.content` is
plain text with all markup stripped** — it is `ABC` for every markup variant of
that text. So removing a mark leaves both sides equal and `updateBlockDom` is never
called.

Measured (E2E, same log):

```
RESULT bold-then-clear
  afterClick  ABC                                  ← the UI shows it cleared
  kramdown    <span data-type="text" style="font-weight: bold;">ABC</span>{: …}
  afterReload <span data-type="text" style="font-weight: bold;">ABC</span>
```

This is the reported "strikethrough is not synced", and it is the same for bold,
italic, underline and clear-format. The *addition* of a mark happens to be detected,
because `htmlToKramdown` keeps a style span verbatim and so differs from the plain
text — the detector is right by accident in one direction only.

### D4 — `<strike>` is dropped

Blink's `document.execCommand('strikeThrough')` produces `<strike>`, measured
(`.logs/audit-execcommand-probe.log`):

```
bold            "<b>X</b>"
italic          "<i>X</i>"
underline       "<u>X</u>"
strikeThrough   "<strike>X</strike>"      ← not <s>
```

`htmlToSiyuanDom`'s `SEMANTIC` list has `s` and `del` but not `strike`, so the tag
falls to the fallback strip and the mark disappears while the text stays.
`htmlToKramdown`'s `KNOWN_TAG` lacks it too, so there it survives as literal text.

### D5 — bold / italic / underline / strike are written as CSS, not as SiYuan marks

`Outliner.tsx` sets `document.execCommand('styleWithCSS', false, 'true')` on mount, so
Blink emits a styled span instead of a semantic tag. Measured in the live outline:

```
加粗    <span style="font-weight: bold;">ABC</span>
斜体    <span style="font-style: italic;">ABC</span>
删除线  <span style="text-decoration-line: line-through;">ABC</span>
下划线  <span style="text-decoration-line: underline;">ABC</span>
```

`htmlToSiyuanDom` rule 1 turns any `<span style>` into `<span data-type="text" style>`,
and the kernel keeps it as a CSS style (§2). The document therefore never gets
`**bold**`, `*italic*`, `<u>` or `~~strike~~`, and SiYuan's own inline-mark toolbar
does not recognise them. The same happens to anything pasted from a word processor.

### D6 — Links are written in a form the kernel rejects

The toolbar inserts `<a href="…">`; the reader produces the same. The kernel answers
`<protyle-html>` (§2). Accepted form is `<span data-type="a" data-href="…">`.

### D7 — Tag / mention / block-ref / formula lose their meaning

`htmlToSiyuanDom` has no rule for `data-tag`, `data-mention`, `data-noderef`,
`data-formula`; they are spans, so they survive the fallback, but the attribute is
dropped by the kernel and the text degrades to plain (§2). A block reference
(`((id 'text'))`) is destroyed outright. `htmlToKramdown` handles all four, so the two
serializers disagree.

### D8 — Images inside a node do not survive

`<img alt src>` — what both the toolbar and the reader produce — is rejected
(`<protyle-html>`). The kernel's inline image form has not yet been measured.

### D9 — Tables cannot sync at all

`insertTable` injects `<table><tbody>…<td>` into a node's inline text. A SiYuan table
is its own **block**, not inline content: both the inline form and a `NodeTable` div
nested in the paragraph div are rejected (§2). So the button visibly inserts something
that can never be stored. This needs a structural decision, not a regex.

### D10 — `clearFormat` ignores what it just did

It calls `execCommand('removeFormat')` and then discards the result, rebuilding from
the model value `n.text`. Its unwrap list is `b,i,s,u,code` — no `<strike>`, no
`<font>`.

### D11 — Collapsing pushes an undo point and a full write-back

`setCollapseAll` / `setCollapseByLevel` / `toggleCollapse` go through `mutate`, which
always sends `kind: 'struct'`. A view-only change therefore takes an undo slot and a
`flushWrite`. (The collapse itself works: measured 7 → 5 visible rows for level 2, and
it stays collapsed — `.logs/audit-collapse-probe2.log`.)

### D13 — bold + colour lost the colour on every reload

SiYuan exports "mark + style" as the mark's markdown followed by an IAL. Writing
`<span data-type="strong" style="color: #dc2a2a;">X</span>` comes back as
`**X**{: style="color: #dc2a2a;"}`, and the reader deleted the IAL as "a suffix that is
not part of the text" — throwing the colour with it. Same family as D2: the reader had
two ways to destroy a style and used the wrong one.

### D14 — the image had a third shape

The writer's carrier is `<img data-img="assets/a.png">`; the reader emitted
`<img alt src>`. Neither is what the kernel stores, so the two never met: an image was
not hydrated on load (`hydrateEditable` looks for `data-img`) and was rewritten into a
bare `<img src>` the kernel answers with `<protyle-html>`.

★ D14 fixed the **shapes** agreeing; a third of the same surface was still broken and is
recorded as **D20** in §9. Do not read this entry as "images are fine".

### D15 — the change detector believed a stale index

`saveNodesIncremental` reads what a block holds from the **SQL index**, which trails the
kernel by 1–3 s — the same window `writtenTask` already documents for the task flag.
Measured on the outline: bold a node and press "clear format" immediately afterwards.
The node becomes plain, the index still reports the *pre-bold* plain text, both sides
match, and nothing is written: the document keeps `**…**` while the outline shows it
cleared. The same two steps a second later work.

This is why the D3 fix alone did not make the clear-format case pass — a correct
serializer changes nothing if the write never happens. Fixed by remembering what this
session wrote and preferring it over an index that contradicts it **inside** the lag
window; past the window the index is the authority again, so an outside edit is still
seen.

### D16 — clear-format acted on the wrong node

It took its node from `activeId` rather than from the focused element, unlike every
other toolbar action. When `activeId` was not the node being edited, the button either
cleared a node out of view or did nothing, with no message.

### D12 — Toolbar coverage was zero

No E2E spec exercised bold, italic, strikethrough, underline, clear-format, inline
code, emoji, tag, mention, node-ref, collapse-all or select-all. That is why D1, D3,
D4, D5 and D7 were reachable by a released build.

`e2e/toolbar-sync.spec.ts` now drives **10** of them end to end, each asserting the
kernel's answer and what comes back after a reload: inline code, the four marks, mark
removal, clear-format, a tag, a block reference, and a colour. `e2e/table.spec.ts` adds
2 more for D9.

Still **not** driven by a case, and therefore still unverified as *behaviour*:

| Action | Why it is not simply covered by another case |
|---|---|
| emoji | inserts plain text at the caret — the same write path as typing, which the typing cases cover; no markup of its own |
| mention | SiYuan has no inline mark for one (measured: every `data-mention` becomes plain text), so this is the tag case with a different label |
| collapse-all / expand-all | view-only by design (`ChangeKind`); what was wrong was the write-back and the undo slot, and that is what `view` fixed |
| select-all, zoom, find, undo/redo | no document round trip of their own |
| highlight picker | the colour case covers the colour input; the highlight input is the same `fmt(..., 'hiliteColor')` path |

So the honest statement is: the **markup surface is covered**, the **view-only actions are
not**, and "no markup is lost" is additionally enforced by the unit-level round trips in
`src/core/inline-sync.test.ts` rather than by one case per button.

### The mind map's own bar — the same gap, found later

★ The same measurement was then run over the **mind map** bar, and it was worse: `cmdFit`,
`cmdExportImage`, `cmdExportMm`, `tipZoomIn`, `tipZoomOut`, `tipResetZoom`, `tipToggleTheme`,
`tipFitCanvas`, `cmdBackToFullMap`, `lblShape`, the theme swatches, `mm-para-overlay`,
`commitParagraphs`, `cancelParagraphs` and `startParagraphEdit` all had **zero** spec references.
`e2e/mindmap.spec.ts` covers the bar's *layout* (wrapping, the collapse toggle, the container
query) and never clicks a control to see what it does — and a button wired to nothing looks exactly
like one that works, until somebody presses it.

`e2e/mindmap-bar.spec.ts` now drives 8 of them, each asserting the **effect** rather than the
click: the canvas transform moves and reset really returns 100%; fit rescales and the map's bounds
end up inside the canvas; a swatch changes the node fill and marks itself active; the dock cycles
the palette; the shape selector re-lays the nodes out; both exports produce a file with the right
extension; a fold survives a reopen; and the paragraph overlay opens, shows the paragraph and
closes. Four were shown red with `scripts/redproof.py`, each hitting its own case.

Two traps the writing hit, both already documented here and both worth not rediscovering: the bar
starts **collapsed** (every click on a hidden control times out), and the collapse badge is
**covered by the node's own rect** (`click('.mm-badge')` is judged intercepted and retried for two
minutes — `clickBadgeOn`/`firstBadgeOwner` already existed for `e2e/export.spec.ts`).

★ One assertion was wrong and is recorded rather than quietly changed: the fold was first checked
for `fold="1"` in the block's kramdown. Folding is **not persisted** — `model/types.ts` says
`collapsed` is "view state, deliberately not saved" and the map keeps it in `localStorage` under
`om-mm-collapsed:<doc>`. The case now asserts the promise the code makes (remembered across a
reopen); demanding the document hold it would have been a request to write view state into the
user's file.

## 4. Fixed: an edit inside the debounce window is discarded by a re-read

**D17 — fixed.** The decision rule is now a named, offline-pinned function
(`ownWriteBarrier` in `sync.ts`), and `mount.ts` calls it.

### The mechanism

`handleOutlineChange` schedules a text edit through a **250 ms debounce**; nothing is enqueued
until the timer fires (`mount.ts`, `textDebounceTimerRef`). The kernel-transaction handler's
re-read waited before it reads:

```ts
const waitForOwnWrite = pendingWriteRef.current ?? Promise.resolve();
```

`pendingWriteRef` is only set once `writeLatest` has **enqueued a job**. A debounced edit has
enqueued nothing, so the wait was a no-op, the read returned the document's content, and
`nodesRef.current = tree` replaced the tree that held the edit. The timer then fired and wrote
the document's own text — so the keystroke was gone, with no error anywhere.

### Measured, before the fix

Typing one character into a node of a document that **contains a table**, in a browser, with
the outgoing requests logged:

```
t+500ms  outline=[]            ← the outline re-rendered empty
         writes=["block/updateBlock …NodeTable…", "block/updateBlock …NodeParagraph ABC丁"]
t+1500ms outline=ABC丁          kramdown=…ABC丁
```

So the write path itself was correct; the loss happened when a **re-read landed inside the
debounce window**, and the `shown=""` at t+500ms was that re-read arriving. A document containing
a table exposed it readily because loading or creating one produces extra transactions — the same
case passed and failed repeatedly on one build.

### The fix

The rule is "resolve only once the plugin's own pending work is on disk", and it has **two** forms
of pending work, not one:

```ts
export function ownWriteBarrier(state: OwnWriteBarrierState): Promise<void> {
  const flushed = state.debouncePending ? state.flushDebounced() : Promise.resolve();
  return flushed
    .catch(() => undefined)
    .then(() => state.pendingWrite ?? Promise.resolve())
    .catch(() => undefined);
}
```

Order matters: **flush first** (sending the debounced edit enqueues a write of its own, so
awaiting it means our text is on disk), **then** await a write that was already running. Both
failures are swallowed on purpose — a read of a document that refused the write is still the best
available state, and letting the rejection through would freeze the panel on a stale tree forever.

`src/plugin/own-write-barrier.test.ts` pins the rule offline: a quiet document is not written to,
**a debounced edit is flushed before the read**, a running write is awaited and not flushed on top
of, the flush precedes the read, and a failing flush does not block the read. Shown red with
`scripts/redproof.py` (`.logs/redproof-barrier.log`): removing the `debouncePending` branch turns
cases ② and ④ red.

### Why the unit and not an E2E

The defect is a **timing race**: reproducing it end to end needs a transaction to land inside a
250 ms window. An E2E case for it is therefore green or red depending on the machine — the shape
this repository treats as proving nothing (see `docs/pitfalls/`). The wrong decision rule has a
deterministic consequence, and that is what is pinned.

### A residual the barrier does not explain, and what it turned out to be

An integration case was built to provoke the same symptom — insert a **foreign** block through the
kernel while the page is mid-keystroke, which is what another client, a sync or a second window
does, and which arrives as an unmappable block id. Before the barrier it lost the keystroke in 1 of
4 runs; after it, 1 in 6.

★ **That case is not in the suite and was not kept.** A case that is red 1 run in 6 with no
attribution makes every future run of the suite untrustworthy, and at the time nothing explained
it; the attribution below arrived later, from different work. It is described here so the next
person can rebuild it from the recipe rather than guess, and so the measurement is not lost.

★ **The cell-editing work then attributed it, and disproved part of this section's first
reading.** The earlier version of this note said the debounced write-back "never begins". That was
an inference from probes that had run out of budget, and instrumentation later showed the opposite:

* the cell edit **did** reach `syncTableCells`, with a valid `blockId` and `known != md`;
* the `updateBlock` **did** go out, carrying the new markdown;
* the kernel answered **`{"code": 0}`** — accepted;
* and the document still held the old text, because a **later** `moveBlock` wrote the table's old
  cells back over it (§7).

So the cause was the ordering of two writes, not a write that never happened — and it is fixed.
The probe that finally worked is worth recording: a page-side probe cannot see the plugin (it runs
in a frame whose `window` the test cannot read), but **`console.warn` from the plugin** does reach
Playwright. Two earlier attempts used channels that could not answer and produced "no output",
which was mistaken for "the code did not run".

After the fix: `e2e/table.spec.ts` passed **14 of 14** runs, where the same case had been failing
about 1 run in 4.

### What was shipped alongside

* Table **cells are editable** (§7) now that the debounce race is fixed.
* `serializeTree` and `structureFingerprint` carry the table, so coalescing cannot drop a cell
  keystroke and a shape change is still treated as structure. Pinned in
  `src/plugin/sync-serialize.test.ts`, shown red with `scripts/redproof.py`.


## 5. Fix order and outcome

Test-first: every test was shown red — with `python3 scripts/redproof.py` for the
serializer and detector changes, and by running the new E2E cases against the unfixed
build for the two UI ones.

| # | Defect | Fix | Verified by |
|---|---|---|---|
| D2 | hex colour corrupted on every load | stash tags until the end of `kramdownToHtml`; run the `#tag` rule after the IAL, with the remaining tags masked | `inline-sync` + redproof + `toolbar-sync` colour case |
| D1 | the wrapper button deleted the selection | `wrapSelection` carries `range.cloneContents()` into the replacement | `toolbar-sync` case 1 (red on the unfixed build) |
| D3 | markup *removal* never written | compare in SiYuan inline DOM (`markdownToInlineDom`) instead of against `blocks.content` | `inline-sync` detector cases + redproof + `toolbar-sync` case 6 |
| D4 | `<strike>` dropped | `strike` added to the markdown writer's rules and to `htmlToSiyuanDom`'s `SEMANTIC` | `inline-sync` |
| D5 | marks written as CSS | `splitStyleMarks` maps `font-weight`/`font-style`/`text-decoration` onto `strong`/`em`/`u`/`s`, merging with `text` | `inline-sync` + redproof + `toolbar-sync` cases 2–5 |
| D6 | links stored as `<protyle-html>` | `<a href>` → `<span data-type="a" data-href>` | `inline-sync` + the kernel round trip |
| D7 | tag / mention / block-ref / formula lost | rules in `htmlToSiyuanDom` for the forms lute reads; a tag is plain text | `inline-sync` + the round trip |
| D8 | images stored as `<protyle-html>` | `<img>` → `<span data-type="img">…`; the reader now emits `data-img` instead of `src` | `inline-sync` + the round trip |
| D10 | clear-format operated on stale text and missed `<strike>` | it works from the live element and unwraps the full mark set | `toolbar-sync` case 7 |
| D11 | collapse took an undo slot and a write-back | `ChangeKind` gains `view`; `handleOutlineChange` returns early for it | typecheck + the existing collapse behaviour |
| D13 | bold + colour lost the colour on reload | the trailing IAL is folded into the element it belongs to, instead of being deleted | the round trip |
| D14 | the reader emitted a third image shape | `kramdownToHtml` emits `data-img`, the writer's own carrier | the round trip |
| D15 | the detector believed a **stale** index | `writtenText` remembers what this session wrote; the index only outranks it inside the measured 1–3 s window | `text-write-lag` + redproof |
| D16 | clear-format acted on `activeId`, not the focused node | it resolves the node from `document.activeElement` first, like every other toolbar action | `toolbar-sync` case 7 |
| **D9** | **tables** | a table node with `table` cells, written as a markdown table block | `table-markup` + redproof + `e2e/table.spec.ts` |

### D9 — tables: a node kind, because a table is a block

The facts, all measured:

- A table is not inline content. `<table>` inside a paragraph's inline DOM is stored as
  `<protyle-html>`; so is a `NodeTable` div nested in one.
- `insertBlock` with a `NodeTable` **DOM** answers `code: 0` and creates nothing — the
  worst failure shape there is, because the caller is told it worked.
- `insertBlock` with a **markdown** table does create a real table block, and the kernel
  hangs it off the **document** (`parent_id` = the doc id, block type `t`).
- The reader kept only list items and headings, so a table block's lines were not part of
  the node tree at all — `kramdownToTree` on a table's kramdown yielded **no node**.
- The old button injected a table into a node's text, where the write path stripped it to
  one `&nbsp;` per cell plus a zero-width space: the table was lost **and** the node was
  left holding invisible characters.

What shipped, and why each piece is where it is:

- `OutlineNode.table` (`{ header, rows }`) — a table is a node, not markup. `text` is unused;
  a node with no text carrier must not be given one, or a block gets written as text.
- `kramdownToTree` collects consecutive `|`-lines and judges them with `parseTableLines`.
  A run of one line, or one with no separator second, is **ordinary text** and is kept as
  such — otherwise a paragraph starting with a pipe would be deleted.
- The block id comes from the attribute line **after** the rows (measured: `colgroup="|"`
  marks it), which is the opposite of every other block. Reading it from the wrong side
  makes an existing table look new, and the next write inserts a second copy.
- `loadBlockMap` maps a table's own block to its node in all three tables, so
  `syncStructure` finds it and `syncDeletions` does not delete it as "in the document but
  not in the tree".
- `syncStructure` creates it with `insertBlock(markdown)` **anchored on the document** —
  anchoring after a list item asks for a sibling position inside a `NodeList`, which the
  kernel refuses. It owns the table's **existence** and nothing else.
- `syncTableCells` owns a table's **content**: one baseline per table
  (`lastTableMarkdown`, the markdown the block is known to hold) and a whole-body
  `updateBlock(markdown)` when it differs. A failure leaves the baseline alone, so the
  next pass retries instead of recording a refused write as saved.
- `saveNodesIncremental` **excludes** table nodes: they have no paragraph block, so the text
  path would look for one, call the node new, and insert a duplicate beside the table.
  The structural check counts only non-table mappings for the same reason — otherwise every
  pass over a document containing a table looked structural and a plain text edit was
  routed through the whole structural write for nothing.
- Each cell is a leaf contenteditable `.om-node-cell` **inside** the `th`/`td`, addressed by
  `tableCellKey(node, row, col)`, and deliberately **not** a `.node-text` element: every
  helper that walks `.node-text` assumes a contenteditable paragraph.
- `indentNodes` leaves a table where it is, because a `NodeList` cannot contain one.

Cells are **editable** (see §6 and §7). The addressing, the "a write must not grow the table" rule
and the "no write when nothing changed" rule live in `outline/table-cells.ts`, pinned offline
with `table-cells.test.ts`; two mutations were shown red with `scripts/redproof.py`.

## 6. D18 — two writers for one table body made the regression case vacuous

The cell-edit E2E case stayed **green with `syncTableCells` disabled** (measured). Two
independent causes, and the second is the interesting one:

1. The first write-back after a document opens has a **null baseline**, so it takes the
   structural route, and the create branch wrote the whole table body on its way through.
   The case therefore had to be split: make an edit whose purpose is to establish the
   baselines, then assert on a **second** edit that only the writer under test can explain.
2. Even so, a document holding a table is judged **structural on every write-back**, so the
   structural route runs for every keystroke — and while that route also wrote the body, no
   case could distinguish the two writers at all.

The fix is ownership: `syncStructure` owns existence, `syncTableCells` owns content. The
red proof is now real — disabling the writer turns the second edit red and the file restores
byte-identical (`.logs/redproof-cells-owner.log`).

### A defect the diagnosis found in the render

The `ref` callback runs only when React re-renders **that** element, so a cell whose model
changed while it was untouched kept its old text. Measured, with the plugin's own console:

```
after editing cell 0:0 (a → a丙), clicking 0:1 and typing:
[om-dbg] syncCell …:0:0 value="a丙"   ← the FIRST cell firing, with its stale text
```

The keystroke in 0:1 never reached the model at all, and 0:0's text was written back a second
time. The model now wins on `focus` — the moment a cell becomes the one being typed in —
which is synchronous and therefore before any keystroke can be read.

## 7. D19 — a cell edit was written and then reverted by the next pass

★ This one was found only because a failing run was instrumented at every stage; the symptom
("the cell edit did not reach the document") was a lie three times over before it was.

### What was measured

With the outgoing requests logged, the failing order was exactly:

```
moveBlock              <- a structural pass
updateBlock "a丙"      <- syncTableCells, and the kernel answered {"code": 0}
moveBlock              <- the NEXT pass, writing the table's old cells back
```

So the edit **was** written, was **accepted**, and was then overwritten. `moveBlock` carries a
block's content from the tree the pass was given, and that pass's tree predated the edit.

### The fix, and why `redproof.py` cannot prove it

`moveNodes` must not move a table node. Nothing is lost by skipping it: a table is a root-level
block, a `NodeList` cannot contain one, and `indentNodes` already refuses to move it (the D9
notes).

★ **This defect is a race, so `scripts/redproof.py` could not express its proof.** The tool ran the
check **once per side** (green → mutate → red → restore), and a defect that fails about half the
time reported "stayed green" on a single run. It reported exactly that, twice, which would have
thrown the fix away. `--repeat N` was added for this (see `docs/TESTING.md`) and makes a partial
rate a failure in both directions; re-run with it:

| `e2e/table.spec.ts` | runs | result |
|---|---|---|
| clean tree | 5 | 0 red |
| `if (!n.table) plan.push(…)` (the fix) | 23 | 23 passed |
| `if (true) plan.push(…)` (the mutation) | 6 (+8 earlier) | 2 of 6 red; 4 of 8 failed → ~45% |

★★ **`redproof.py --repeat` REFUSES this proof, and that refusal is correct.** 3 of 5 is not 5 of
5: a green run under the mutation cannot be told apart from a fix that works, so **the case catches
this defect only about 45% of the time**. It is a partial detector, not a criterion, and saying so
is the point — the honest statement is "the fix removes the failure (23/23 vs 8/16) and the case is
a partial guard", not "the case proves the fix". `--repeat` exists precisely so this distinction is
visible instead of papered over by a single lucky run.

★ A step was then added to the case to raise that rate — after the cell edits, force a structural
pass and re-assert they survived — and it **did not help**: in every failing run the case is already
red one step *earlier*, at the second edit. Whether a reverting pass follows an edit at all is what
the timing decides, so no amount of asserting after the fact changes the rate. The step is kept
because it states the D19 invariant directly, not because it detects the defect; the counts are the
evidence, and they are what to re-measure if this regresses.

★ **And a purpose-built case did not help.** A new case was written for this defect — edit a cell,
then make a structural change, assert the edit is still there — and it passed **6 of 6** runs
**with the mutation in place**. It defended nothing, so it was deleted rather than kept as
reassurance. Only the counts in the table above discriminate.

### Two changes made while chasing this, and what each is worth

* **`writeLatest(treeToWrite)`** — the write-back now writes the tree its caller handed it instead
  of reading `nodesRef.current`, which a re-render can replace between the edit and the timer.
  Measured with the change disabled: **8 of 8 passed**, so it is **not** what this case defends.
  It is kept, and is defensible on its own terms (a caller knows the tree its change produced;
  `nodesRef.current` is a view that may have moved on), but it is **not** claimed as this fix and
  no criterion depends on it. `redproof.py` reported "stayed green" for it too — correctly.
* **`moveNodes` skipping tables** — the fix, with the measurement above.

### What was ruled out on the way, each by measurement

* *"the cell never reached the model"* — an instrumented `syncCell` showed it did, with the right
  key and the cell focused.
* *"`syncTableCells` skipped the write"* — it did not: `known != md`, `blockId` was valid, and the
  `updateBlock` went out.
* *"the kernel refused it"* — `{"code": 0}`.
* *"the debounce lost the edit"* — the capture fix above was added for that hypothesis, and the
  measurement then showed it was not the cause of this failure.

The lesson is the one this repository keeps re-learning: the symptom's location is not the cause's
location. Three "fixes" were written and two were discarded because the evidence did not support
them.

## 8. D20 — an image in an attached paragraph never loaded

D14 made the reader and the writer agree on `<img data-img="assets/a.png">`, and that is the plugin's
carrier for an asset path — **it is not `src`**, so the browser only loads the picture if something
copies it across. `hydrateEditable` does exactly that, and every `.node-text` ref callback calls it.

The `.node-para` ref callbacks did not. So an image in an **attached paragraph** rendered as an empty
box, while the same markup in a node's own text displayed correctly — which is precisely what made it
invisible: the two look identical in source, and only one of them had the call.

Measured on the isolated instance, before the fix:

```
{"src": null, "dataImg": "assets/E2E-probe-image.png", "natural": "0x0", "rect": "28x17"}
```

After it:

```
{"src": "assets/E2E-probe-image.png", "natural": "2x2"}
```

Both paragraph renderers were missing the call — the node's and the document title's.

### Why the criterion is `naturalWidth`, not "the `<img>` is there"

Presence was **already true** while the user saw an empty box: the element, its `data-img` and its
`alt` were all in the DOM. `naturalWidth > 0` is the one property that distinguishes "the browser
fetched and decoded this" from "there is an element of that name", and no amount of markup satisfies
it. `src` is asserted beside it, because a future rewrite could set `src` to a path that 404s and
leave `naturalWidth` at 0 — the pair is what pins the defect.

`e2e/image-render.spec.ts` covers it in both views (the outline paragraph box and the mind map's
paragraph overlay), plus the other half: the reference **survives a write-back**, is not turned into
`<protyle-html>`, and its path is not emptied. Shown red with `scripts/redproof.py` by removing that
one call.

★ This is the second time an image defect hid behind "the markup is present". The lesson is recorded
where it recurs: for a rendered resource, the criterion is whether it **loaded**, not whether the tag
was emitted.

## 9. Standing rules for the fix

- Every claim about the kernel is re-measurable with the probes named in §2; if a
  kernel form cannot be confirmed, it is **not** written.
- Read and write must agree: a markup the reader produces must be one the writer can
  store, and a round trip through the kernel must be a fixed point. D2 and D3 both
  came from the two sides disagreeing, and `probe_roundtrip.py` now writes each fixture
  **twice** so a pipeline that drifts on reopen cannot pass.
- The change detector must not become permanently "dirty" for formatted nodes. Three
  properties are pinned in `inline-sync.test.ts`: a real edit is seen, an unchanged
  reload is not, and a **removed** mark is seen.
- Nothing here is fixed by a test that asserts on the outline's own HTML: the criterion
  is what the **kernel** holds after the write, plus what comes back after a reload.