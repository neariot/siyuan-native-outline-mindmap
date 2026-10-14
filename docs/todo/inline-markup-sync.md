# Inline markup & toolbar sync

Plan and evidence for the class of defects where **what the outline shows and what
SiYuan holds disagree**. Every entry below was measured; the measurement is named so
it can be re-run, and none of it is a reading of the source alone.

Status: **all of D1–D16 fixed and verified** (unit + E2E + red proofs), D9 included.

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
D4 and D5 were reachable by a released build.

Now covered by `e2e/toolbar-sync.spec.ts` (8 cases, each asserting the kernel's answer
and what comes back after a reload). Still **not** covered, and still to do: emoji, tag,
mention, node-ref, collapse-all, select-all, undo/redo from the toolbar. The unit-level
serializer cases in `src/core/inline-sync.test.ts` do cover tag / block-reference /
formula round trips, but nothing drives those buttons.

## 4. Fix order and outcome

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
  kernel refuses — and rewrites it with `updateBlock(markdown)` when the cells change.
- `saveNodesIncremental` **excludes** table nodes: they have no paragraph block, so the text
  path would look for one, call the node new, and insert a duplicate beside the table.
  The structural check counts only non-table mappings for the same reason — otherwise every
  pass over a document containing a table looked structural and a plain text edit was
  routed through the whole structural write for nothing.
- The row renders read-only, and is deliberately **not** a `.node-text` element: every
  helper that walks `.node-text` assumes a contenteditable paragraph.
- `indentNodes` leaves a table where it is, because a `NodeList` cannot contain one.

Cells are **not editable in the outline yet**: what is fixed is that a table is created, is
stored as a real block, loads back, survives edits to its neighbours, and can be deleted.
Editing cells in place is the obvious next step and needs its own round-trip tests.

## 5. Standing rules for the fix

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