# 0.1.8

38 commits since `v0.1.7`. The theme is **silent loss**: edits that the outline showed and SiYuan never
stored, with nothing raised, nothing logged, and no visual difference. Every case below was reproduced
against a running kernel before it was changed.

**Storage format and configuration are unchanged** —— documents written by 0.1.7 read back identically, and
no setting changes meaning. **One feature was removed** (heading level, see below); it could never store
anything, so nothing that was saved is affected.

## Key fixes

### ★★ Indenting with `Tab` sometimes did not reach SiYuan

Reported as "tab demote does not sync", then "it takes effect probabilistically". It is not probabilistic ——
it is a race with a window:

| What was pressed | What SiYuan ended up with |
|---|---|
| `Shift+Tab`, `Tab` back to back | the flat document —— **the indent was lost** |
| `Shift+Tab`, pause, `Tab` | the node nested correctly |

The plugin writes back on a coalescing delay, and decides "is there anything new to write?" by comparing a
**serialization of the tree**. That serialization emitted a flat `id:text` list with no nesting and no child
order, so these two trees produced *byte-identical* strings:

```
甲 | 乙 | 丙          (flat)
甲(乙) | 丙           (乙 indented)
```

The second write was therefore skipped as "nothing changed" —— while the outline already showed the new
indent. No error anywhere, in either view.

The serialization now encodes the tree's **shape** (parens around each node's children), which closes the
whole class rather than the one symptom: the same function had already been patched twice by adding a field
(the note, then paragraph text), and each patch left re-parenting and reordering invisible. A field cannot
catch a change that *moves* a node without altering it.

Verified both directions on the built plugin: removing the parens makes `Shift+Tab` then `Tab` back to back
fail while the same two keys with a pause pass —— the reported asymmetry, exactly —— and restoring them is
green 3/3.

### ★ A failed write-back produced no message at all

The map's write path fired its write without handling the rejection, so a failed write-back became an
unhandled rejection whose text reached nobody: the map showed the edit, SiYuan did not have it, and the error
bar stayed **empty**. Every other write path already surfaced its error; this call site did not.

### ★ Deleting a node could leave a placeholder behind

When a node with paragraphs was split or merged, the placeholder cleanup removed a fixed key rather than
every key that was actually deleted from, so a stale placeholder could survive in the document.

### Heading level: removed, because it could never store anything

The heading buttons and the heading-level shortcut were **dead controls**. SiYuan cannot hold a heading
inside a list item —— the kernel's own parser decides `isHeading = !isList && headingMatch` —— and this
plugin writes list items, so the heading never left memory. The persisted `heading` field was never read back
either.

It is deleted rather than left in place: a control that quietly does nothing is worse than no control, and
this one also wrote a field into the document that the reader ignored. **No saved content is affected** ——
the field was never persisted in the first place.

### The document-deleted case now asks instead of guessing from the text

When the target document is deleted externally, the kernel reports it with two *different* messages depending
on when the write lands —— `load block tree [<id>] failed: indexing` for roughly the first **100 ms**, then
`... failed: tree not found`. Only the second was recognised, so inside that window the user saw a raw kernel
message and **no recovery button**. The path now asks the kernel whether the document still exists (a read,
which has no such window) instead of relying on the message text alone. A failure that could not be
classified is left alone rather than assumed to be a deletion —— a false "your document was deleted" invites
someone to duplicate their work.

## Also in this release

- **`uploadAsset` now honours the client's own `fetch` seam**, so the upload path is testable without a live
  editor —— and is tested.
- **Two dead private methods were removed** and one dead cache deletion, after the measurements their
  comments cited were moved into `docs/`.
- **The first-run lock moved out of Playwright's own output directory**, and a second concurrent run is now
  refused instead of silently deleting the first run's evidence. Two suites cannot share `test-results/`.
- **A test helper that returned `Infinity` when it measured nothing was made to throw.** The "fit fits all
  the nodes" case asserted `content.l >= canvas.l - 2` and `content.r <= canvas.r + 2` —— **all of which the
  sentinels satisfy** —— so it would have passed with an empty panel. (`contentBox`, E2E only; no user-facing
  change.)
- **The E2E layer is typechecked now.** It never had been: Playwright transpiles with esbuild, which strips
  types without checking them. 42 real errors were sitting there, including a kernel response read through the
  wrong shape in ten places.

## Verification

- Full browser suite: **118/118**, and again **117/117** on the build after the last changes.
- `npm run check` —— every fast gate (typecheck for both programs, unit tests, docs index, language, i18n,
  privacy, CSS scope, and the literal-condition / dead-method / dead-CSS / vacuous-test / version gates).
- The reported `Tab` bug was re-verified after the fix by re-introducing the old serialization: the back-to-back
  case fails and the paused case passes, reproducing the report exactly —— so the reported asymmetry, not just
  the symptom, is covered by a case.
- Each release-note claim above was checked against the commit that made the change, and one section that did
  **not** correspond to any change was deleted before publishing.
- Every new check was shown to fail before it was trusted —— including two that were found to be **testing the
  wrong layer**, which is recorded in `docs/pitfalls/` rather than quietly fixed.
