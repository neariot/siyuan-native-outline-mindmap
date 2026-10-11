# Feature list

> Updated: 2026-10-07

## Outline view

- Unlimited nesting / `Tab` to indent / `Enter` to split / `Backspace`·`Delete`
  to merge / `Alt+↑↓` to move
- **Single-node focus and breadcrumbs**: `Alt+→` to focus deeper, `Alt+←` to go
  back up, double-click the dot to focus; the breadcrumb at the top jumps
  straight to an ancestor
- Collapse via the dot (with `Alt` for the whole subtree) / drag to one of three
  drop zones / multi-select (`Ctrl`-click, `Shift`-range, `Ctrl+Shift+↑↓`) plus a
  bulk-action bar
- H1–H6 / three-state to-dos / **attached paragraphs** / colour and highlight /
  clear formatting
- Hyperlinks / images (paste, drag in, or pick; stored in SiYuan assets) /
  tables / formulas (KaTeX) / emoji / `#tags` / `@cross-document references` /
  bidirectional links
- Clipboard: structured copy, multi-line paste nests automatically, rich-text
  paste is reduced to plain text
- Find and replace (`Ctrl+F`, attached paragraphs included) / collapse or expand
  everything / select all nodes
- Length limits: 100 characters for a document title, 2000 for a single node or
  attached paragraph (truncated automatically past the limit)
- Keyboard shortcut cheat sheet (`Ctrl+/`)

## Mind map view

- **5 structures**: right (the default) / balanced / left / down / alternating,
  all switchable from the toolbar dropdown
- **3 edge styles**: smooth curve / rounded polyline / right-angle polyline
- **8 themes**: colourful / black & white / grey-blue / brown / green / orange /
  blue / dark (a theme only affects local display; it is never written into the
  document)
- **Focus a branch**: double-click a mind map node to focus that branch; the top
  shows the current branch and a "back to full map" control
- Zoom / pan (wheel, `Ctrl`+wheel, dragging) / double-click to focus,
  single-click to return to the outline
- PNG export / Freemind `.mm` export

## Two-way integration with SiYuan

| Feature | Entry point | Notes |
|---|---|---|
| Open the mind map | Command palette / document-tree context menu / dock / slash menu | Opens by document ID; reuses the tab for the same document |
| Inline node editing | Double-click / `F2` / context menu | `Enter` saves, `Esc` cancels |
| Add a child node | `Tab` / context menu | Inserted at a precise position, **existing block IDs preserved** |
| Add a sibling node | `Enter` / context menu | Same as above |
| Delete a node | `Delete` / `Backspace` / context menu | Removes the subtree too; a confirmation dialog reports the child count |
| **Expand into a sub-document** | Context menu | Creates a native sub-document + a `((id 'title'))` reference + a backlink attribute; child nodes are **moved** there |
| **Drag a block into the map** | Drag a block from the body onto the canvas | Dropping on a node makes it a child; dropping on empty space makes it top level |
| Live two-way sync | Automatic | SiYuan changes → the view changes; the view changes → SiYuan changes |
| Conflict handling | Automatic + a banner | Keeps the view's content and reports it; "trust SiYuan (reload)" resolves it in one click |

## Mobile

SiYuan disables `openTab` entirely on mobile (in the kernel's
`app/src/plugin/API.ts` it is `openTab = () => { /* TODO: Mobile */ }`), so **any
plugin that relies on a custom tab simply cannot open on mobile**. This plugin
carries its UI in a **dock + slash menu**, so it works on mobile.

## Safety mechanisms (all added after stepping on a real pitfall)

- **Incremental write-back**: never `updateBlock` the whole document — that
  **rebuilds every block ID** and destroys all `((references))`, bookmarks, and
  backlinks in it.
- **Delete safety gate**: only delete blocks that previously appeared in the
  tree and have now disappeared. Reverse sync lags, so "SiYuan has it and my
  tree does not, therefore delete" would **silently wipe** blocks someone else
  just added.
- **Echo prevention**: write-back is locked, plus a short-window fallback that
  compares both block ID **and** content, so our own writes are not mistaken for
  external changes and rewritten over and over.
- **Conflicts use a sync baseline**, not "the most recent written value" —
  otherwise a node loaded and never written back would be misjudged as a
  conflict.
- **Body paragraphs do not become nodes**: only list items count, otherwise
  write-back would copy body text into list items.

## Known trade-offs

- **A formula being edited shows as highlighted source** (`$..$`); KaTeX
  rendering appears only in mind map labels and exports — inlining KaTeX in the
  editing state would break the caret, so it is not done.
- **Very large documents (ten thousand nodes) are not virtualised**; multiple
  root maps stack vertically.
- **Removed, because they could not be preserved**: summaries, connector lines, the cloze mask and the
  due date all had a control, a renderer and no read path —— SiYuan has no native counterpart for any of
  them, and we never pollute a document with private attributes, so the value was gone the moment the
  document was reopened. Offering a control whose result vanishes is worse than not offering it, so they
  are gone from the model, the outline and the mind map (`MAPPING.md` 3.3, `ARCHITECTURE.md` 8). Node
  bodies are unaffected.
- **Fold state is deliberately not saved**: folding a branch is a way of looking at a document, not
  something the document says, so a reopened document starts unfolded. It is view state, not content ——
  `scripts/check-unsaved-fields.py` reports it as in-session rather than as a defect.
- Not implemented: collaboration / encryption / templates / presentation mode /
  MCP.
