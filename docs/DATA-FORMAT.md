# Data format

> Updated: 2026-10-07

## The only data source: SiYuan native blocks

This plugin has **no file format of its own**. The node tree is persisted in
exactly one shape: blocks inside a SiYuan document.

```
Document (d)
└── NodeList (l)
    ├── NodeListItem (i)          <- one node
    │   ├── NodeParagraph (p)     <- node body
    │   ├── NodeParagraph (p)     <- attached paragraphs (0..N of them)
    │   └── NodeList (l)          <- children (optional)
    └── ...
```

A node's block type follows from its meaning, and all of them are native
SiYuan types:

| Node meaning | Native SiYuan representation |
|---|---|
| Plain node | `NodeListItem` + `NodeParagraph` |
| To-do | `NodeListItem` `data-subtype="t"` + `data-task` |
| Heading 1–6 | `NodeHeading` `h1`–`h6` |
| Attached paragraph | An extra `NodeParagraph` (a sibling of the same kind) |

There are **no `custom-*` attributes at all**. A node's identity is the block ID
of the listItem itself.

## Inline HTML conventions

Both node bodies and attached paragraphs are **HTML fragments** (not token
arrays) — the editor edits them directly through `contenteditable`, and
`core/blockdom.ts` converts them into SiYuan DOM on write-back.

| Element | HTML |
|---|---|
| Plain text | `<span>text</span>` |
| Bold / italic / strikethrough / code / underline | `<b> <i> <s> <code> <u>` |
| Text colour / highlight | `<span style="color:#..">` / `<span style="background:#..">` |
| Formula | `<span data-formula="E=mc^2">$E=mc^2$</span>` (rendered by KaTeX) |
| Hyperlink | `<a href="..">..</a>` |
| Tag | `<span data-tag="name">#name</span>` |
| @ document reference | `<span data-mention="docId">@name</span>` |
| Bidirectional link | `<span data-noderef="blockId">label</span>` |
| Image | `<img src="assets/xxx.png" alt=".." />` (stored in SiYuan assets) |
| Table | `<table><tbody><tr><td>..</td></tr></tbody></table>` |

## Write path: always the native `dom` interface

The kernel's `dataType` **accepts only `markdown` or `dom`**. This plugin always
uses **`dom`**:

| Scenario | Kernel API |
|---|---|
| Create a document | `createDoc` (title shell) + `appendBlock` with `dataType=dom` |
| Add a paragraph | `insertBlock` (with a `previousID` anchor) |
| Update content | `updateBlock` with `dataType=dom` |

**Why not `markdown`**: the markdown path goes through the Lute parser, where
paragraph boundaries are decided by **blank lines**
(`lute/parse/paragraph.go:22`). The DOM path builds the block tree directly
(`kernel/model/transaction.go:1704` → `lute/protyle.go:348`), so one
`NodeParagraph` is one paragraph and **there is no blank-line semantics**.
See [MAPPING.md](MAPPING.md).

## Images

Uploaded to SiYuan's `assets/`, synced along with the document.

**Document content is never kept in browser-local storage** —— neither a `localStorage` document store nor
an `indexedDB` image blob. ★ The **UI's own view state** is a different matter and *is* kept in
`localStorage` (structure / theme / line style / node shape under `om-mm-prefs`, the collapsed set under
`om-mm-collapsed:<docId>`, the settings-bar open flag under `om-mm-bar-open`) —— it is a display
preference, not data, and losing it costs a click. An earlier version of this section said "no
browser-local storage is used" without that distinction, which was false as written.
