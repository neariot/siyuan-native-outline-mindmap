# 0.2.0

Minor release. Fixes a class of **silent data loss in the outline's formatting and table sync**, makes
tables editable, repairs image rendering in attached paragraphs, and adds a host-abstraction layer with
version-invariant to-do handling.

Storage format and configuration remain fully compatible with 0.1.9 — no migration, nothing to reconfigure.

## Formatting no longer disappears

Every one of these was a real edit that the plugin acknowledged and never stored.

- **★ Strikethrough (and bold / italic / underline removal) never synced.** The change detector compared
  a node against the kernel's **plain text**, so adding a mark was written but *removing* one compared
  equal and was dropped. Both sides are now compared in SiYuan's own inline DOM.
- **★★ Inline code deleted the selected text.** Pressing the button handed the kernel the tags without
  the selection, so the node became an empty `<code></code>`.
- **★ Text colour was destroyed on every load.** A hex colour inside a style attribute was read as a
  `#tag`, and the mangled HTML was written back — unrepairable after one save. Bold+colour also lost the
  colour on reload.
- **★ Links, images, tags, mentions, block references and formulas** were stored in forms the kernel
  rejects or silently degrades — a block reference was destroyed outright.
- **★ "Clear formatting" cleared the wrong node**, or rebuilt from a copy taken before it ran.

## Tables

- **★★ A table is a real block, and its cells are editable.** The button used to inject `<table>` into a
  node's text, where the write path stripped it: the table was lost *and* the node was left holding one
  `&nbsp;` per cell. A SiYuan table is its own block (a `NodeList` cannot contain one), so it is now a
  node of its own, written as a markdown table block and hung off the document.
- **★★ A cell edit that had been accepted could be reverted.** Measured request order: `updateBlock` with
  the new cells, the kernel answering `{"code": 0}`, then a later structural pass writing the old cells
  back over it — the edit was gone after being acknowledged. `Tab` also now walks the cells and stops at
  the last one instead of escaping into the document body.
- **★ A keystroke could be discarded by a background re-read.** A text edit waits 250 ms before it is
  sent; a re-read triggered in that window replaced the tree that held the edit, and the timer then wrote
  the pre-edit text back. The write-back now waits for its own pending work, in both forms.

## Images

- **★★ An image in an attached paragraph never loaded.** `![…](assets/x.png)` returns from the kernel as
  `<img data-img="…">`, and `data-img` is *not* `src`, so nothing was ever fetched: a 28×17 empty box
  where the picture should be, while the same markup in a node's own text displayed correctly. Fixed in
  both paragraph renderers.

## To-dos, numbering, and documents

- **★ Native to-do toggle survives old kernels without losing children.** The marker fallback rewrote only
  the node's own line, and a marker-only markdown write **drops the node's children** — so on a kernel
  without the native endpoint, toggling a to-do deleted everything indented under it. The fallback now
  writes the whole subtree, and refuses to write at all rather than dropping children.
- **★ Kernel version is compared numerically, and drives the feature path.** Used as a string,
  `'3.9.0' >= '3.10.0'` is **true** — the comparison answers the wrong question as soon as a component
  gains two digits. The native task-marker endpoint's introductory version was also measured against
  SiYuan's official release tags and corrected to **3.6.4** (not 3.1.0): a kernel in 3.1.0–3.6.3 was
  being told it had the endpoint and spent a round trip on a 404 before every toggle.
- **★★ Numbered (ordered) list nodes work end to end.** They were **dropped** on write-back: every node was
  emitted as an unordered item, and neither fingerprint counted the `numbered` flag, so a numbering change
  was invisible and the catch-up write was skipped.
- **★ A fresh "save as new document" no longer loses its alignment.** The block-map read did not retain
  just-created blocks, and the top-list query returned the **child** list instead of the document's own
  (an unqualified `LIMIT 1`), misaligning the first node and losing the second and third.
- **★ Newly created siblings are exempt from the "destroyed by this insert" probe.** The SQL index flushes
  200 ms–2.8 s after an insert while the probe waited 200 ms, so a node this session had just created could
  be judged destroyed and re-inserted as a **duplicate**.

## Interface

- **Mentions button hides itself** instead of opening a panel with an empty document list.
- The mind map's bar is covered by tests for **what each control does** — fit, both exports, zoom and
  reset, the theme swatches, the shape selector, the dock, folding and the paragraph overlay.

## Under the hood

- **Host Abstraction Layer is partly live.** A Host Driver SPI carries host navigation (opening a block or
  document reference) with a version-negotiated native implementation and an offline in-memory one.
- **A virtual kernel** for offline testing: the kernel's block-tree shapes, its asynchronous SQL-index lag
  and its transaction responses are modelled so the sync and race cases run in milliseconds, with the
  mirror's field names checked against SiYuan's **own generated TypeScript contract**.
- **A gate for unreachable modules.** A shipped module only its own tests import is a green suite
  describing a feature nobody can use.
- **`scripts/redproof.py --repeat N`** for defects that are races: a single run per side cannot tell
  "fails half the time" from "the fix works", and this release found a defect where it reported *"stayed
  green"* and would have discarded the fix. A partial rate is now refused in both directions.
- The reconciler and the driver's *write* half are implemented and unit-tested but are **not** on the
  runtime write path; `docs/todo/hal-convergence.md` records the measurement that blocks that substitution.

## Verified

The offline suite (100 test files, ~1 300 assertions) and the full end-to-end suite
(**144 passed, 0 failed**) on an isolated SiYuan instance, with every fix in this release shown to
fail before it was fixed.

## Known limitation

The regression case for the reverted-cell-edit defect catches it only about 45% of the time. The fix
itself is solid (4 of 8 runs failed without it, 23 of 23 passed with it), but that case is a partial
guard rather than a proof, and it is recorded as such in `docs/todo/inline-markup-sync.md`.
