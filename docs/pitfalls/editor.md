# Pitfalls - Editor interaction

<- [Master index](../PITFALLS.md) | Things we stepped on once and do not want to step on again; each entry reads "symptom -> cause -> practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the order inside this file;
the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 2.1 Whatever steals the focus must give it back

**Symptom**: open a panel/overlay and typing does nothing after it closes. The subtler form is
"only the first time works" -- after pressing Enter to create a node, pressing Enter again without clicking back into it does nothing at all.

**Cause**: the keyboard handling hangs off a container (`.mm-canvas` / `.node-text`),
while the panel is a `<textarea>` / an input with `autoFocus`. After it closes the browser hands focus back to `BODY`,
and it does not return to the original container by itself.

The distinguishing feature (measured, do not guess one by one): every panel that breaks carries `autoFocus`:

| Panel | autoFocus | activeElement after close | Typing |
|---|---|---|---|
| Emoji / table | no | `DIV.node-text` | ✅ |
| @ reference / backlinks / find and replace | yes | `BODY` | ❌ |

**Practice**: a uniform "remember on open, give back on close":

```tsx
const panelReturnFocus = useRef<string | null>(null);
const openPanel  = (name) => { panelReturnFocus.current = activeNodeId || null; setPanel(name); };
const closePanel = () => {
  const back = panelReturnFocus.current;
  panelReturnFocus.current = null;
  setPanel(null);
  if (back) focusReq(back, 'end');
};
```

A pitfall inside the pitfall: `focusReq` only writes the target into a ref; the one that actually focuses is `useLayoutEffect`.
When a panel closes, `nodes` usually has not changed -> the effect does not re-run -> the focus does not come back.
Every piece of state that "makes focusReq take effect" must go into the dependency list; this project stepped on it twice
(first `panel` was missing, then `find.open` was missing after it was added).

-> the final dependency list is `[nodes, formatDrawerOpen, panel, find.open]`.
Dependencies should be checked one by one along the write paths, not added "whenever one comes to mind".

"Write it into a ref and you are done" is a trap. There are 5 write paths while the consumer honours only 2 dependencies,
so a miss is inevitable. By the same token, when changing any state, confirm that every entry point that called `setPanel(null)` was changed to
`closePanel()` (there were 8 bare calls at the time).

**Test**: `e2e/keyboard.spec.ts` —— "the keyboard still works after a context-menu command" and
"focus lands on the canvas after clicking a node". Both assert on `document.activeElement`, which is
the thing that was wrong. Two source-text files used to sit here (`panel-focus.test.ts`,
`mindmap-focus.test.ts`); they regex-matched `focusCanvas()` call sites in `Mindmap.tsx`, so the
second one pinned a **count** of close paths and went red when the count was made *more* correct by
giving six more menu actions the restore they needed.

---

### 2.2 If a single link in the chain "passes only the first argument", the optional one is silently lost

**Symptom**: indent/move up three times in a row (500ms apart), and one Ctrl+Z rolls all of it back; you cannot undo step by step.

**Cause**: the undo merge window keys on the node ID alone, so any change to the same node within 1.2 seconds is merged,
and "discrete operations" are treated exactly like "continuous typing".

The real pitfall is that the signature `onChange(tree, kind?: 'struct' | 'text')` already has `kind`,
but two links in the chain drop it -- `commit` calls `onChange(next)`,
and `mount.ts`'s `onChange: (next) => {...}` does not take the second argument either.

No error, no warning; the semantics quietly degrade.
When an optional argument is passed, check every link of the chain.

**Practice**: blank out the merge key for structural operations (`mergeRef.current = { key: isStruct ? '' : mergeKey, at: now }`),
so that only continuous typing enters the merge window.

**Test**: `src/plugin/undo-merge-kind.test.ts, `src/plugin/undo-first-edit.test.ts`

---

### 2.3 Paired reverse keys: check branch completeness on both

**Symptom**: when the cursor is not at the end of the line, the Delete key empties the text but leaves an empty shell node behind.

**Practice**: `Backspace` and `Delete` are a pair of reverse operations; changing one means looking at the other at the same time.
At the time the `Backspace` branches were complete while `Delete` missed the non-end-of-line case.

★ The branch **order** is part of the fix, not an implementation detail, and one consequence of it is easy to
"correct" into the opposite: for an empty node the caret is always "at the end of the line" (the caret offset
and the plain length are both 0), so an empty node that has a following node takes the *join* branch and is not
deleted —— only an empty node with nothing after it is removed. Both are asserted.

**Test**: `src/plugin/delete-key.test.ts`, which drives `deleteKeyAction` (the extracted decision in
`src/core/delete-key.ts` —— it lives in `core/` because the handler around it needs the DOM and `siyuan`) over
every branch, and reads the handler's use of it through the parser: the decision, the `deleteNode` /
`mergeNext` handling, the focus hand-off, and that the native default is suppressed before either is carried
out (a branch that lets the key through is exactly how the shell node appeared).
The context-menu suite it used to cite covers a *different* mechanism —— deleting through the menu, not the
Delete key.

---

### 2.4 Touch devices do not fire HTML5 drag

**Symptom**: on mobile there is no way at all to drag a node.

**Cause**: the HTML5 `dragstart` family of events never fires on touch devices.

**Practice**: touch goes through a long-press gesture (`touchstart` + timer -> enter the dragging state),
but the drop-point logic reuses the same `moveDrop` -- the two input paths share one piece of business logic,
which avoids a behavioural fork.

Mouse and touch are two event paths; the business logic must converge in one place.

**Test**: `(no dedicated test, see `src/plugin/mindmap-anchor.test.ts`)`

---

### 2.5 A lost focus drags in symptoms that "look completely unrelated"

**Symptom**: press Enter three times to create nodes and they come out in reverse order.

**Cause**: the 2nd and 3rd Enter never fired because the focus was lost, `selectedId` stayed on the first node,
so the insertion point was naturally wrong. The insertion logic in `tree-ops.ts` itself is correct.

The location of the symptom != the location of the cause. I first went and checked the insertion point of `addSibling`,
and only digging on did I find it was a by-product of the focus problem.

**Practice**: first verify "did the operation happen at all", then look at "it happened but landed in the wrong place".

---

### 6.9b A literal `<` `>` is eaten by the tag-stripping regex (**user-visible lost characters**)

**Symptom** (measured 2026-10-08, hit while writing the export test case):

A node says "用 `<T>` 表示泛型" and the plugin panel shows "用 表示泛型" --
`<T>` is gone. `a<b>c` is worse: it turns straight into `ac`.

Yet **SiYuan's own editor displays it correctly** (compared against screenshots), so the user spots the missing character at a glance.

**Cause chain** (two places that are each correct combine into a bug):

1. `kramdownToHtml` (`core/map.ts`) **never escapes** when it emits literal text --
   `用 <T> 表示泛型` goes into the HTML string verbatim.
2. downstream, `.replace(/<[^>]+>/g, '')` in `htmlToText()` / `htmlToRuns()`
   treats it as a **tag and strips it** -- the content is lost.

**Fix**: escape literal `<` `>` `&` at the **entry** of `kramdownToHtml`
(escape `&` only when it does not start an entity), and let the downstream decode it back by the normal HTML rules.

★ Why you must choose the "entry" and not "a safety net at the exit":
At the exit it is already **impossible to tell** "a `<b>` we generated ourselves" from "a `<T>` the user wrote" --
the two look exactly the same. I tried shield/restore at the exit, and `<T>` was restored as if it were something we generated,
still lost. Only at the entry, before any tag has been produced, can the two be told apart.

★ The second, matching fix: `htmlToRuns` did not decode entities, so `&lt;` handed to React
**got escaped a second time** into `&amp;lt;`, and the screen showed a literal `&lt;`.
After stripping tags you must **decode back to the literal characters** before handing them to React.
The order cannot be reversed: strip tags first, then decode entities -- the other way round, `&lt;script&gt;`
would be decoded into a real tag and then stripped, and the content would be lost again.

★ Scope: this is not limited to export. The mindmap, the outline panel and the `.mm` export are wrong in **all three** places.
It was found by writing a "special-character escaping" case for the export -- the existing cases all used Chinese,
**containing no special characters at all**, so replacing the escape function with the identity still stayed green.

**Lesson**: when testing something like "escaping / encoding / serialisation", the input **must really contain**
those special characters, otherwise the case passes vacuously.

### 6.9d Switching views **unmounts** the other component, and its useState is gone

**Symptom** (2026-10-08): set the structure to "Balanced", switch the theme to "Green", collapse one branch,
click "Outline" and then back to "Mindmap" -- **everything is back to the default** (Right / Colorful / not collapsed). A refresh loses it too.

**Cause**: in `mount.ts` the view is a ternary expression:

```js
view === 'outline' ? <Outliner .../> : <Mindmap .../>
```

Switching views = **unmounting** the other component, and every `useState` inside it is destroyed.
Yet `structure` / `themeIdx` / `lineStyle` / `shape` / `collapsedIds` / zoom
**all live in `Mindmap.tsx`**.

★ Two pieces of state in the same data have different fates; that is not a design, it is an omission:
`selectedId` was **lifted up to `mount.ts`**, so it **does** survive a view switch;
the others were not lifted, so they are lost.

**Practice**: decide where to store by **lifetime**, do not apply one rule to everything.

| State | Where it is stored | Why |
|---|---|---|
| Display preferences (structure/line/style/shape) | `localStorage` (global) | Describes "how I want to look at it"; it has nothing to do with a document, so it should be remembered across documents and refreshes |
| Collapsed state | `localStorage` (**keyed per document**) | What is collapsed is "which branch of this document", and node IDs are unique to a document, so a global store would mix them up |
| Selected node | lifted to `mount.ts` | it belongs to the current document's **transient** selection |
| Zoom | **deliberately not stored** | auto-fitting to the current panel on open is more useful (see `userAdjustedView`) |

★ Also found along the way: 4 props such as `initialStructure` are **declared but `mount.ts` passes none of them**,
so whatever `localStorage` holds wins over them and only an empty store falls back to the prop.
The same pass found a callback that **nothing ever supplied**, `onSettingsChange` —— the component called it four
times, so it read as "the caller is told when a setting changes" while no caller could ever hear it.
It is gone rather than left to imply a persistence path that the `localStorage` effect above already owns.
A prop that is "declared but never passed" raises no error; it just shows up as "I changed it and nothing happened" --
when you add a field, grep for whether it is passed while you are there.

### 6.9g After "Expand as sub-document" the node text is duplicated

**Symptom** (2026-10-08): after expanding "分支一" the mind map node shows
**"分支一 分支一"**; the line in the SiYuan body reads `分支一 ((id '分支一'))`.

**Cause**: both places **concatenate** instead of **replacing**.

```js
// store.ts
const withRef = `${plain} ((${subId} '${safe}'))`;   // original text + reference
// mount.ts
text: `${n.text} <span data-noderef="${subId}">${label}</span>`
```

A reference **renders its own title**, while the original text is still the same string -- so the same word appears twice.

**Practice**: both places change to a bare reference (`((id 'title'))` / `<span data-noderef>`).
The semantics of expanding were always "the child nodes move to a new document and this node **becomes a reference to it**",
so keeping a copy of the plain text is pointless: the sub-document title is the same string.

★ While there, the "strip the trailing attribute line" preprocessing in the store was deleted:
since the original text is no longer concatenated, that `getBlockKramdown` round trip is not needed at all.
**After switching to replacement, the old preliminary step becomes dead code** -- do not just mark `plain` with `void` and leave it.

### 6.9o A resize effect that "does nothing"

**Symptom**: `Mindmap.tsx` has a resize listener attached, with a comment saying
"reset to the default when the breakpoint is crossed", yet changing the window width **does nothing at all**.

**Cause**: both branches of the function body only `return`; **`setBarOpen` is never called**:

```js
const onResize = () => {
  const narrow = window.innerWidth <= 560;
  if (narrow && !barOpen) return;
  if (!narrow && barOpen) return;
};                       // <- no setState at all
window.addEventListener('resize', onResize);
```

It is equivalent to "there is no such code at all", it just attaches a listener for nothing.

**Action**: **delete it**, rather than "make it really reset". Two reasons:
1. The criterion itself is wrong -- this is the **dock** width, not the window width (same as the entry above).
2. A forced reset **overrides the user's choice**: the user manually collapsed the toolbar in a narrow dock,
   and any window change bounces it back open, which is the more annoying behaviour.

★ Note that "deleting" also needs an argument. When you find dead code, do not reflexively "fix it back to life" --
  first ask **is what it originally wanted to do still needed now**.

### 6.9v `onFocus` steals the selection anchor -- Shift+click range selection **stops working entirely**

**Symptom** (2026-10-08): in the outline, Ctrl+click "甲" and then Shift+click "丁",
and **only 1 is selected** (丁), not the 4 from 甲..丁. Range selection might as well not exist.

**Cause**: the start point of the range selection, `anchor`, is written from **two places**:

| Where it is written | Nature |
|---|---|
| the Ctrl branch of `onRowClick` | **a deliberate action** ✅ |
| the node editor's `onFocus` | **a side effect** ❌ |

The browser's event order is `mousedown -> focusin -> click`:

    mousedown 丁 -> focusin 丁 (setAnchor(丁)) -> click 丁 (shift)

So `anchor` has already been changed to **the end point itself** before the click, `lo === hi`,
`flat.slice(3, 4)` => only 1 is selected.

**The investigation (the key is not to stop at "it looks right")**:
1. the logic read correctly three times over -- `lo`/`hi` and `Math.min/max` are all fine
2. added probes printing `lo`/`hi` and saw that **`clickedId` and `anchor` are exactly equal** => only then did it localise to anchor being overwritten
3. listened to the three capture events `mousedown`/`focusin`/`click` and confirmed **focusin comes before click**

**Practice**: **delete** `setAnchor` from `onFocus`. The focus is a side effect,
and the selection anchor must be decided by a deliberate action. All three places that read `anchor` use `anchor || id`,
so null is safe.

**Also fixed**: a plain click used to **not set** the anchor (only a Ctrl click did).
With the onFocus interference gone, "plain-click 甲 -> Shift+click 丁" would **select nothing at all**.
Since Shift+click is a natural interaction, a plain click should set the anchor as well.
=> `onRowClick` gains an else branch. **The order matters**: test Shift first (it needs the old anchor),
then Ctrl, and only last set the new anchor.

★ **A side effect must not write "selection state".** The criterion: if this value is broken, would the user say
  "but I did select it"? If yes -> only a user action may write it.
★ The same family as 6.9k / 6.9t / 6.9u: **code that "looks right" is not code that does the right thing**.
★ Another lesson: a fallback like `anchor || id` turns null into "working normally",
  so the bug **raises no error and crashes nothing**, it just silently selects a few fewer -- the hardest kind to find.

### 6.9w A plain click does not clear the selection -- the caret and "N selected" say two different things

**Symptom** (2026-10-08): after Ctrl-selecting "甲" and "乙", **plain-clicking "丁"**
(to edit it) -- 节点一/节点二 **are still highlighted** and the batch toolbar still says "2 selected",
while the caret is already inside 丁. Confirmed by screenshot (`.tmp/stale-after-click.png`).

The user sees **a set of self-contradictory states**: I want to edit 丁 while the UI says 节点一/节点二 are selected.

**Cause**: the plain-click branch of `onRowClick` only does `setAnchor(id)` and **does not clear `selected`**.
(this is the branch added along with the `anchor` fix in the previous round -- back then I only thought "let Shift have an anchor to use",
not "what is the semantics of this click".)

**Practice**: the semantics of a plain click are "**I want to edit this row**", not "I want to add to the selection",
so it should call `setSelected([])`.

**Think of operation semantics in pairs**:

| Operation | Semantics | What it should do |
|---|---|---|
| Ctrl+click | add / remove this item | change `selected`, set `anchor` |
| Shift+click | select a range | compute the range from the **old** `anchor` |
| Plain click | I want to edit this row | clear `selected`, set `anchor` |

★ **A half-filled branch is the most dangerous**: when I added the else branch in the previous round,
  the goal was only "let Shift have an anchor to use", so I wrote the minimal `setAnchor(id)` and stopped.
  The feature tests were all green (Shift really did work again), but the **semantics** were wrong.
  => before adding the branch, ask: **what is the semantics of this operation? Is doing only this one thing enough?**

★ A good thing was confirmed along the way: the keyboard `Shift+arrow key` range selection (the official path in `SHORTCUTS.md`)
  goes through the `anchor || id` branch and was **not affected**; the two paths share the same `selected`.
  A case was added to lock it down.

### 6.9x The hint does not state the "real reason" -- the user follows it and it still does not work

**Symptom** (2026-10-08): the top-level topics "甲" and "乙" are **siblings**; select them and click "Summary",
and what pops up is:

    💡 First select two or more sibling topics (hold Shift to multi-select, or use the select-all tool)…

The user **has already** selected 2 siblings. The hint tells the user to do something **they have already done** --
following it still does not work, so they just assume it is broken.

**The real reason** (written in a code comment, invisible to the user):
A summary is `summaryData`, stored on **the parent topic**. A top-level topic's parent is
**the document itself**, which cannot hold one => a top-level topic can never take a summary.

**Practice**: split it into two messages by situation. Two siblings already selected and still not satisfied => talk about the top level +
give a way out (indent under a parent topic first with `Tab`):

```js
const selSiblings = selTops.length >= 2;
alert(selSiblings ? t('msgSummaryTopLevel', …) : t('msgSummaryHint', …));
```

**Confirmed by measurement**: before the fix, case B popped "…First select two or more sibling topics"; after the fix it pops
"Top-level topics cannot take a summary…Workaround: indent them under a parent topic first (Tab)".
Case A (not enough selected) still shows the original hint -- **both directions are right**.

★ **"One hint covering several failure reasons" is the classic defect of hint text.**
  The criterion: **if the user does exactly what the hint says, will it still not work?** If yes -> the hint is lying.
  A hint must answer "why it does not work", not "how it is usually done".
★ Also found: this limitation is **written only in a code comment**, it is not in `docs/`.
  The user documentation should state clearly that "a summary needs a parent topic".
★ The same family as 6.9t/6.9u (an assertion/hint that also holds when "nothing was measured at all"),
  but this one is worse: it **actively misleads the user into a useless action**.

### 6.9y Add content to an empty document and the panel stays on "This document has no content yet"

**Symptom**: create an empty document -> open the panel -> it shows "This document has no content yet" ->
add content to the SiYuan body -> **the panel does not update**, that sentence stays there forever.

**Cause**: the incremental path of the reverse sync relies entirely on `blockToNodeRef` mapping "block ID" to "node".
When the document **was empty to begin with** this table is empty, so **any** external change fails to match and is silently dropped.
An empty tree has no "increment" to speak of; there must be a "re-read the whole document" fallback.

**Fix**: in the `ws-main` callback of `mount.ts`, re-read when the current tree is empty and a **non-echo** transaction arrives:

```ts
const hadNodes = (nodesRef.current ?? []).length > 0;
if (!hadNodes) {
  const touched = [...extractUpdates(detail.data).keys(), ...extractDeletions(detail.data)];
  if (touched.some((id) => !guardRef.current.isEcho(id))) {
    setNodes(null);
    void loadDocRef.current?.().then((tree) => { nodesRef.current = tree; setNodes(tree); });
    return;
  }
}
```

`loadDocRef` is necessary: the event-subscription effect depends on `[eventBus, docId]`,
so the closure captures the `loadDoc` from the moment of subscription; forwarding through a ref is the only way to get the current version.

**★ The detour I took here**: following the intuition that "a new block should send an insert transaction" I first wrote
`extractInserts`; tsc was clean, the deploy succeeded, and **it was completely useless**. Only after capturing the real traffic did I find
that typing the first character into an empty document sends:

```
action=update  type=NodeParagraph  id=<paragraph block ID>
```

All `update`, not a single `insert`. **Capture the real data first, then write the code.**

**★ The criterion must be a list item**: the outline only takes list items (document block -> list block -> list item -> paragraph block),
a bare paragraph does not enter the outline tree. Using a bare paragraph in a regression test gives a fake test that is **always green**.

---

### 6.9aa A gesture that moves the thing being hit-tested can never hit anything but itself

**Symptom** (measured in the mind map, nodes 甲 / 乙 / 丙): dragging a node only **panned the canvas** --
the node never changed parent, and SiYuan itself did not change at all. Dragging a node and dragging
empty space had the same effect, so from the user's side "move a node" simply did not exist
(the outline could do it, which made the two views inconsistent).

**Cause**: the drag had **two jobs in one gesture**. `pointerup` was hit-tested with
`document.elementFromPoint(clientX, clientY)`, but `pointermove` had already panned the canvas --
so by the time the pointer went up, the **source node had moved under the cursor**, and the hit test
could only ever return the source itself (`src === tgt`, so the reparent branch is rejected).

Measured at the pointer-up of "drag 丙 -> 甲", cursor `(1055, 562)` -- exactly the centre of 甲:

```
__root__  l=1146
甲        l=1294     <- panning pushed 甲 to the right
丙        l=1020     <- 丙 is now under the cursor
hit test -> 丙 (the source), not 甲 (the target)
```

**Practice**: separate the two jobs by where the gesture starts, and never hit-test after moving the world:

1. pressing on a **node** -> this gesture only does "drag to reparent"; panning is left to pressing on **empty space**;
2. hit-test by **iterating `.mm-node` and comparing rectangles** yourself -- inside SVG `elementFromPoint` returns
   child elements such as `text` / `rect`, and `closest('.mm-node')` is not reliable either;
3. hit-test with the **last position recorded in `pointermove`**, not with the `pointerup` coordinates
   (`setPointerCapture` redirects later events to the capturing element, so those coordinates land on the source node).

★ General rule: **if a gesture moves the object under test, the hit test must run before the move** --
  or the gesture must not do both "pan" and "drop" at once.

**After the fix** (same fixture): drag 丙 -> 甲 -> SiYuan reads `['甲', '  丙', '乙']`, matching the UI;
dragging on empty space still pans, `transform` measured `translate(325,343)` -> `(445,283)` ✅.
Dropping onto a node makes the node its child, **consistent with the outline's drop zone=child semantics**
(the same `onReparent` path as the outline's `moveDrop(zone='child')`). Cycle detection is part of the same
rule: a node dragged into its own descendant is refused, or the tree becomes a cycle.

**Tests**: `e2e/mindmap.spec.ts` drives the gesture and asserts on the result —— which position the
drop hit-tests with, that a drop onto another node nests it, and that a drop into the node's own
subtree is **refused with the document left exactly as it was** (the guard has to run before the
node is taken out, or a refused drop loses it). A unit file named `mindmap-reparent.test.ts` used to
hold this entry by reading `Mindmap.tsx` / `mount.ts` as **text** and regex-matching the handlers;
it could not go red when the drop misbehaved, only when the guard was reworded —— which is exactly
what happened when the two hand-written cycle guards were merged into one helper.

---

### 6.9bb A help text can be "correct" and still render nothing -- the entry count is not in any test

**Fact** (renumbered 2026-10-10): the shortcut panel is built from one `SHORTCUTS` table and renders
it group by group. The table had 24 entries when the case below was written; entries were added
later, and nothing went red. The current count is deliberately not repeated here -- a count written
into a document goes stale without failing anything, which is the very defect this entry is about.

**Cause**: `panel-escape-focus.test.ts` only asserts "every key in the help text is a key the code really
implements" (one list against one list). It never asks whether the panel **renders** those entries, and it
never compares the table's own group / entry counts against the documented ones. A count that drifts and a
panel that renders nothing are both invisible to that assertion.

**Practice**: when a panel's content comes from a table, assert the table's shape as well as its key names
(group count, entry count), and keep the measured numbers with their date -- the number in the case is a
**measurement, not a constant**.

**Tests**: this claim needs focus inside the panel container, so it is asserted with the focus cases:
`src/plugin/panel-focus.test.ts` checks that every one of the five panel containers carries `tabIndex` and
wires the key handler (a container that cannot take focus never receives Escape), that the handler closes the
panel, that opening moves focus **into** the container, and that both the panel and the find bar give focus
back on close. Its own file, `panel-escape-focus.test.ts`, held a `PanelSpec[]` table written inside the test.

---

### 6.9cc A SiYuan reference that the parser cannot read degrades into plain text -- silence, twice over

**Symptom** (measured on a node containing a native reference): in the outline a reference is **a line of
plain text** -- not even a clickable element -- and clicking it does nothing, with no error.

**Cause chain** (two independent silent failures on the same path):

1. the kernel's own kramdown writes references with **double quotes** --
   `见 ((<anchor-id> "目标文档"))` -- while the parser matched **single quotes only**
   (`'([^']*)'`), so **no reference coming from SiYuan ever matched**: no `<span data-noderef>` was
   produced, and the text stayed text;
2. even when a `<span data-noderef>` is produced, clicking did nothing because `mount.ts` passed
   **neither** `onOpenNoderef` nor `onOpenMention` -- both were declared and optional-chained
   (`onOpenNoderef?.(...)`), which swallows the miss completely.

**Practice**: on the read side accept **both quote styles** (single quotes are still in older data), and on
the write side always emit the double-quoted form the kernel uses -- otherwise every round trip flips
`"` and `'` and the user watches the format change by itself inside SiYuan. And wire the callback:
a declared-but-never-passed optional callback raises nothing (6.9d), it just shows up as "clicking does nothing".

**Measured after the fix**: a clickable `data-noderef` element is rendered inside the outline node;
clicking it opens the target document tab, **reused when already open** (`keepAlive: true`) instead of
opening a second tab.

**Tests**: `src/plugin/ref-nav.test.ts`

---

### 6.9dd The plain left button cannot select across nodes -- each node is its own editing host

**Symptom**: in the outline, dragging the left button over several rows selects the text of the node the
drag started in and nothing else. "Select 甲, 乙 and 丙 with the mouse" needs Ctrl+click or Shift+click,
and a text range cannot be dragged across rows.

**Cause**: every row is a separate `contenteditable` host. A DOM `Range` ends at the host boundary, so
selecting text across two nodes is not a matter of handling the mouse better —— the browser will not
produce such a selection. The bullet is `draggable` and already owns the other left-button gesture on a
row, and dragging the text is text selection. The one strip of the row no gesture owned was the gutter:
the left padding of `.om-outline` (`.om-outline { padding: 0 32px }`), 32px of nothing left of the first
bullet.

**Practice**: the cross-node selection rectangle starts in the gutter, and the overlay is SiYuan's own
shape rather than a new one —— one `.om-marquee-layer` holding one `.om-marquee` rectangle,
`pointer-events: none`, mirroring `protyle-select__container` / `protyle-select`
(`app/src/protyle/ui/initUI.ts`, `app/src/assets/scss/protyle/_protyle.scss`, whose comment says the
rectangle must not intercept the mouse "to avoid `elementFromPoint` hitting itself"). Two details that
only bite on a scroll container: the layer is `position: fixed` (an absolutely positioned overlay scrolls
away with the text while the finger stays put), and the press that starts it is skipped when
`clientX` is already inside `.om-outline`'s content box, or it would steal the text selection.

**Tests**: `e2e/outline.spec.ts`

---
