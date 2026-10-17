# Inline markup & toolbar sync

Plan and evidence for the class of defects where **what the outline shows and what
SiYuan holds disagree**. Every entry below was measured; the measurement is named so
it can be re-run, and none of it is a reading of the source alone.

Status: **D1–D22 fixed and verified**, D9 included, and table cells are editable.
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
recorded as **D20** in §8. Do not read this entry as "images are fine".

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

* Table **cells are editable** (§6) now that the debounce race is fixed.
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
| **D21** | **a code block could not be deleted at all** | a code-block node (`OutlineNode.codeBlock`), read as its own block; created by the markdown route; deleted by a scan that includes `type='c'`; selectable by clicking its row | `code-block` (7 reader/writer cases) + redproof ×3 + `e2e/code-block.spec.ts` |
| **D23** | **a code block rendered but could not be edited** | editable `textarea` source box (`syncCode`, verbatim `value`); `codePreview` for map topics, export and confirm labels; code content in `serializeTree`, presence in `structureFingerprint`; `handleEdit` routes to `codeBlock.code` via `mapCode` | unit (label/runs/export + serialize) + redproof ×3 + `e2e/code-block.spec.ts` edit case |

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

## 9. D21 — a code block is a block: read it as one, or nothing can delete it

Three independent causes stacked into one symptom ("a code block can't be deleted at all"), and each
one alone was enough to keep it undeletable. All three were measured on the isolated instance.

### Cause 1 — the reader folded the fence into the title (no node, nothing to delete)

A document holding

    ```js
    const a = 1;
    ```

was read as **no node at all**: each line fell through to the generic reader branch, where a
flush-left line becomes an attached paragraph of the nearest node, so `` ```js `` became
`` <code></code>`js `` (the *inline*-code rule biting a fence) and the whole block landed in the
**document title's** paragraphs. The fix follows the table precedent (§D9) exactly: a SiYuan code
block is its own root-level block (`data-type="NodeCodeBlock"`, verified against the running
kernel, no listItem), so it is collected as a run before any other branch can claim its lines and
becomes a node carrying `codeBlock: { lang, code }`.

★ Inside a fence **every** line is code: `|`, `#`, `-`, `{: …}` and blank lines alike. A sample
that looks like markup must come back byte for byte — pinned by the "never parsed as markup" case.
The fence is lengthened past the longest backtick run inside (`codeBlockToKramdown`), and the reader
closes only on a fence at least as long as the opening one (CommonMark's rule) — otherwise a sample
containing its own fence is cut off and the rest is lost. An unterminated fence still emits its
lines: the kernel can hold one, and silently discarding the user's code is worse than showing it.

### Cause 2 — the deletion scan never looked at code blocks

`syncDeletions` scanned `WHERE type='i'` (listItems). A code block is `type='c'` — a root-level
`NodeCodeBlock` with no listItem — so a removed code block was never a candidate: nothing was sent,
no error was raised, and the block stayed in the document forever while the panel looked deleted.
The scan is now `IN ('i','c')`. (A table, `type='t'`, is deliberately absent: written by
`syncStructure` and removed by its own path.)

### Cause 3 — a read-only row could never enter `selected`

Delete only acts on `selected`, and a plain row click **cleared** it ("I want to edit this line").
A code-block row has no editable element at all, so the keypress went nowhere and **no write was
ever sent** — measured: deleting produced zero block API calls. Clicking a code-block row now
selects it, which is also what reaches the bulk-delete bar. (Table rows are untouched: a click there
lands in an editable cell, and selecting the whole row would fight cell editing.)

Two companion corrections, same shape as the table ones: the `syncStructure` mapping gate and the
`moveNodes` plan both excluded only tables (`!n.table`), so a document holding a code block either
looked "incompletely mapped" or had its body reverted by `moveBlock` carrying a stale tree — the
D19 mechanism exactly. Both now read `!n.table && !n.codeBlock`.

### How it is pinned

* `src/core/code-block.test.ts` — 7 cases: its own node with the id from the attribute line, verbatim
  body, language tag, writer round trip (including a sample containing its own fence), unterminated
  fence, and a table+code+node document where neither run claims the other's lines.
* Three red proofs, each hitting its own assertion: the fence branch removed (all 7 unit cases red),
  the scan narrowed back to `'i'` (the deletion case red), the row-select disabled (the new
  `/selected/` assertion red) — every file restored byte-identical.
* `e2e/code-block.spec.ts` — 3 cases, each asserting the **kernel** after the step: renders verbatim
  as its own row (with `data-lang`), deletion removes the block (`type='c'` gone from the block list)
  while the neighbours survive, and the mind map shows it as a topic. (The case used to read "and
  indent refuses it" —— that was the false kernel claim, see below; indent now really works.)

### A code block is a node with a level (measured, then implemented)

The old comment in `indent.ts` refused an indent for a code block because "a `NodeList` cannot contain
a code block", extending a table's recorded finding. **Both claims were false** —— measured on the
isolated instance, 2026-10-16 (`docs/kernel-api.md` §7.17):

* `insertBlock` with `parentID` = a list item creates a `NodeCodeBlock` **inside** it; with
  `previousID` = that item's paragraph the fence lands after the item's text. A table behaves the same.
* `moveBlock` on a `NodeCodeBlock` answers `code: 0` and **moves nothing** (to the document it is
  refused outright). So a level change has to be written as **create at the new anchor, delete the
  old block** —— the only route the kernel honours.

What changed on that basis:

* **Reader** — a fence is placed by its **indentation**, like every other block, so one written
  inside a list item reads as that item's child instead of a top-level row. Its lines arrive carrying
  the block's own indent, which is stripped per line (CommonMark), or the indent would be re-saved on
  every pass.
* **DOM walk** — `rootCodeBlockIds` became `codeBlockIds`, collected at **any depth**: no list table can
  hold a code block (no listItem, no paragraph), so an unseen one is inserted a second time and the
  original deleted.
* **Writer** — a nested code block is anchored in its parent's list item, a top-level one at the
  document; and a block whose parent no longer matches the tree is deleted and re-created.
* **Indent / outdent** — the `codeBlock` half of the refusal is gone; the `table` half stays, and its
  comment now names the real cause (**our writer anchors tables at the document root**).

* `src/core/code-block.test.ts` — 10 cases now, including the two nesting ones: an indented fence is the
  list item's **child**, and a document-level fence is still a root (the counter-case, so "a fence is
  always a child" cannot pass).
* `src/plugin/outline/indent.test.ts` — 3 cases pinning the refusal that remains: a table does not
  indent, a node after a table does not indent under it, and a node after an ordinary sibling does
  (so the rule cannot decay into "refuse everything").
* `e2e/code-block-nested.spec.ts` — 2 cases: a document that already holds a nested fence opens with it
  as a child row and a save round trip leaves **one** fence; indenting a root-level code block nests it
  **in the kernel** and outdenting brings it back. Two red proofs, one per side: the reader's
  indentation rule reverted (the row stops being deeper) and the writer's nested anchor reverted (the
  document never nests) —— both with their own assertion red.

### A table is the same story, and the same two changes

Measured the same day, with the same two numbers: `insertBlock` with `parentID` = a list item creates a
`NodeTable` inside it (after the item's text, with `previousID` = that item's paragraph), and
`moveBlock` on a `NodeTable` answers `code: 0` and **moves nothing** —— so a table's level change is
create-then-delete as well. So `flushTable` nests by indentation, `rootTableIds` became `tableIds` at
any depth (a table has no list item and no paragraph, so no list table can hold it), the writer anchors
it by its place in the tree, and `indent.ts` no longer refuses anything at all.

* `src/core/table-markup.test.ts` — 5 new checks: an indented table is its item's **child**, its cells
  are intact, and a document-level table stays a root (the counter-case).
* `src/plugin/outline/indent.test.ts` — rewritten: a table indents like any node and keeps its cells, a
  code block does too, the **first sibling** still cannot indent whatever kind it is, and a nested table
  outdents back beside its parent.
* `e2e/table-nested.spec.ts` — 2 cases: a nested table loads as a child and a save leaves one table;
  indenting nests it **with its cells** and outdenting brings both back. A table has one hazard a code
  block does not: its cells are written by a **separate** pass keyed on the block id, and a re-create
  changes that id —— so "it is nested" and "it still has its data" are two claims, and only the second
  catches a lost edit.

### ★★ The level assertion that could not see a level

Both nesting cases first asserted the export with a regex, and **the table one passed against a build
where the table was never written into the kernel at all**:

```ts
expect(md).toMatch(/- 甲[\s\S]*\n\s+\| ?h1/);   // ★ wrong
```

`\s+` also matches the newline of a **blank line**, so a table at the document level, two lines below
甲, matches it. The red proof caught it ("the check stayed GREEN on a real mutation") —— which is the
only reason it was found. The replacement reads the level the way the document states it: how far the
block's own line is indented, and the nearest list item **less indented** than that; `null` means the
document level, and the counter-case asserts exactly that. The code-block case had the same blind spot
and was changed in the same pass.

**Open**: once, during a red-proof sequence, a code block **vanished** from the document after an
outdent (`fenceCount` 0). It has not reproduced since — 10 ordinary runs, plus a stress probe that
repeated the cycle 36 times in one document, all green — and a probe on every `deleteBlock` call only
ever showed the deletion pass removing the block that had already been deleted. So the path is unknown
and the loss is unexplained; the nesting work is not claimed to have fixed it.
* The level change is driven through the **toolbar** buttons, because inside a code box Tab inserts a
  tab character. That is why those buttons exist at all.

## 10. D22 — a duplicated `plan.push` scrambled every drag reorder

### Symptom

`e2e/outline.spec.ts:1095` failed in four consecutive runs: dragging the third row above the first
left the other two swapped, and a below-drop produced no movement at all. The dragged row landed —
but the siblings around it were scrambled, and in the below case nothing visibly happened.

### Cause

Two `plan.push` lines in `moveNodes`' `collect`, one directly after the other
(`src/siyuan/store.ts`). The D21 commit (`04244fe`) added the guarded push
(`if (!n.table && !n.codeBlock)`) **above** the older unguarded push (`if (!n.table)`) instead of
replacing it — `git blame` shows the two lines from two different commits. Every node was planned
twice, so the plan for [甲, 乙, 丙] was [甲, 甲, 乙, 乙, 丙, 丙].

That corrupts `prevNodeOf` for every index ≥ 2, by the arithmetic of the map itself. The plan for
the three rows (甲 / 乙 / 丙 in the fixture) becomes each id twice in order, so the predecessor map
answers the wrong node for every index past the first:

* above-drop of the third row (UI tree 丙 / 甲 / 乙): the doubled plan reads predecessors as
  third→front, first→third, second→**third** (should be first). `moveBlock` then yanks the second
  row directly after the third instead of after the first, producing 丙 / 乙 / 甲. Exactly the
  measured failure.
* below-drop of the third row (UI tree 甲 / 丙 / 乙): the doubled predecessor list answers the
  first row for the third row's predecessor slot. `moveBlock` puts the third row right after the
  first — which is where it already was. The move executes and visibly does nothing. Exactly the
  measured "no movement".

### Why load was not the cause

The first three failures ran at load 4.5–12.6 on a 4-core box, and the runner's own banner warns
that failures under load "may be the machine". That made load a live suspect, and it was wrong:
the fourth run failed identically, the fixed-code run passed the same case at normal load, and —
decisively — the corruption is derivable from the source by hand, with no timing involved. A load
explanation predicts random failures; this one failed the same two sub-cases with the same two
wrong orders. When the math predicts the exact wrong output, the math is the cause.

### How it is pinned

* The drag case (`outline.spec.ts:1095`) goes red with the duplicate re-added and green without it,
  at `--repeat 3`: 3/3 red mutated, 3/3 green clean, byte-identical restore, 3/3 green after.
  (A single-run proof would have been accepted here — the failure is deterministic, not a race —
  but `--repeat 3` costs one extra suite run and removes the question.)
* Full suite after the fix: **147 passed, 0 failed**.
* The stale comment that said "not a second one beside it" now describes the single rule and names
  the incident, so the next edit that adds a push knows there must be exactly one.

## 11. D23 — a code block rendered but could not be edited

### Symptom

Once D21 made the block a node, it rendered as a read-only `<pre><code>`: the source could
be seen but never corrected in place. And the mind map drew the node as an empty
(zero-width) topic — `label()`/`runsOf()` read only the empty text carrier — which reads
as a broken character. Reported as "renders but cannot be edited or deleted".

### Causes (four, independent)

1. **No edit path.** The box was deliberately not a `.node-text`, but nothing replaced
   `syncText` for it — so there was no way to write keystrokes into `codeBlock.code`.
2. **No display string.** `label()`, `runsOf()` and `exportFreemind` all read `n.text`,
   which is `''` for a code node: the topic, its measured width, and the `.mm` export all
   got the placeholder. (Tables have the same gap; they are out of this scope.)
3. **Blind coalescing.** `serializeTree` ignored `codeBlock`, so two states differing only
   in source compared equal and every keystroke after the first was dropped — the same
   pitfall as table cells (D19 mechanism, §7). `structureFingerprint` ignored its
   presence, so gaining a block never took the structural path.
4. **Wrong carrier in the map.** The mindmap overlay pre-filled the (empty) text and
   `handleEdit` wrote it back through `mapNodes` — the source stayed unchanged while a
   paragraph-looking edit visibly "did nothing".

### Fix

* The box is a `<textarea>` (`codeMap`, never `elMap`), written back by `syncCode` from
  `el.value` verbatim — a contenteditable `<code>` joins its line divs with no newline at
  all (`textContent` of `<code>a<div>b</div></code>` is `ab`), which would unwrap every
  multi-line sample on the first edit. Only the caret-holding box may write (the stale
  cell rule), reported as `'text'` (the cell rule: `'struct'` would rewrite every code
  block wholesale). Tab inserts `\t` at the caret instead of leaving the box.
* The box's React key is the node id **only**: keying it on the value remounted the box
  on every keystroke (measured: after one typed character focus fell to BODY, the rest of
  the typing went nowhere, and a Backspace then deleted the whole selected row instead of
  a character). Pinned by typing `XYZ` into the box in the E2E case and asserting both the
  value and that the caret is still in the box — shown red with `redproof.py` (key
  reverted to value-keyed, deployed) and green after the byte-identical restore.
* `codePreview(n)` (`lang: first line`, 60 chars) feeds `label()`, `runsOf()` and the
  export; the outline copy path serializes the full fence, and the delete/extract
  confirms name the preview instead of "(empty node)".
* `serializeTree` carries `codeBlock`; the fingerprint carries its presence (`c1`) but
  not its content (the keystroke-cost rule). `handleEdit` routes code targets through
  `mapCode`, which touches `code` and leaves `lang` alone; the map overlay pre-fills the
  source and commits it raw (no trailing-whitespace strip).
* While the caret is in the box, Delete/Backspace edits a character — the wrap handler
  skips `.om-node-code` the way it skips `.node-text`. Deleting the node means focus
  outside the box (row chrome, then Delete), which is what the E2E case does.

### How it is pinned

* Unit: a code label shows language + first line, runs are non-placeholder, the export
  carries the preview (`layout.test.ts`); a code edit is a `serializeTree` change, an
  unchanged block is not, gaining a block changes the fingerprint while editing content
  does not (`sync-serialize.test.ts`). Shown red with `scripts/redproof.py` (×3:
  `codePreview` neutered, serialize inverted, fingerprint presence dropped), each
  byte-identical restored and green after.
* E2E (`code-block.spec.ts`, new case): fill the box with a two-line source, the kernel
  holds it, a reload shows it back byte-for-byte (newline included), and a map topic
  contains the edited line. The old delete case now blurs the box before Delete — with
  the caret inside, Delete edits a character by design.

## 12. Fixed: a level change into an **empty / already-removed** child list is silently dropped

Same class of defect as D1-D21 (a write-back that reports success while the document keeps the old
state), found while fixing this and recorded here because nothing reports it.

**Measured chain** (isolated instance, 2026-10-17; probes in `docs/pitfalls/data.md`):

1. Outdent 乙 out of 甲. The kernel **removes** 甲's child list (verified: one NodeList in the
   document afterwards).
2. Indent 乙 straight back. 乙 becomes the **first** child, so there is no predecessor, and the only
   remaining move shape is `moveBlock(乙, parentID=<that list>, previousID='')`.
3. **The kernel answers `code: 0` and moves nothing.** Anchoring on 甲's paragraph instead fails the
   same way (`code: 0`), and `parentID` = 甲's listItem is rejected outright (`code: -1`,
   "`previousID` can not be the ID of a document").
4. So the panel showed 乙 one level down, the document kept it at the top level, and `moveNodes`
   returned `moved: 0` having reported nothing —— an **intermittent** divergence, because it depended
   on whether the pass's DOM snapshot was already fresh.

**Two things the first write-up of this got wrong:**

· the empty list is **not** left behind by the kernel —— outdenting the last child removes it, so
  "replacing it" is really "creating one where none exists".
· the id `ensureChildList` handed back came from the **lagging SQL index**, which still returned the
  removed list's id. That is why the first repair (delete the list, then `ensureChildList` again) did
  not work: it went straight back through SQL and got the same phantom. The repair had to seed the
  mapping with the **empty-string** marker (`''`), which is this store's own encoding of "looked up
  and really is absent" —— that skips both the cache hit and the SQL fallback and goes straight to the
  create path.

**The repair** (`src/siyuan/store.ts`): `resolveWantList` is now asked for a child list that can be a
move target (`needAnchorItem = !prevBlockId`). When the list it finds holds no item (read **live**
through `getBlockDOM`, because the index and the snapshot both lag), the mapping is seeded with the
absent marker so the create path runs, the node is moved **after** the placeholder that path mints,
and `cleanup` deletes the placeholder at the end of the call. The list is deleted only in the state
where the live read proved it holds **no** item, and only **after** the moves, so no node is lost.

**In place**: the "already the first child of the target container ⇒ nothing to do" shortcut now also
requires `parentOk`, so a stale sibling list cannot decide to skip a move that is genuinely needed.

**Pinned by** `e2e/toolbar-indent.spec.ts` (both cases green, three runs) and the red proof that made
it green: the same case timed out for 2.0 minutes before the fix and passes in under 10 seconds after.

**Rule it exposes**: `code: 0` is the answer for a move that did **not** happen, and it now has three
measured victims in this tree (a code block, a table, a list item). A write-back that returns success
must verify **where the block ended up**; a level change that is not found in the document afterwards is
not a write-back, however clean its return value.


## 13. Standing rules for the fix

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