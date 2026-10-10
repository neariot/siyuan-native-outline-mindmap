# Architecture

> Updated: 2026-10-10 · Implementation: `src/` · Verification: the offline suites under
> `src/**/*.test.ts` plus the Playwright specs under `e2e/` — run them, do not count them here.

## 1. Positioning

Turning the mind map editing experience into a **SiYuan plugin**, with one core claim:

> **A node is a native SiYuan list block** — not JSON stuffed into some attribute.

Most mind map plugins serialize the whole map into a JSON string stored in a custom attribute. The price is that SiYuan's
**search, backlinks, outline, and block references** cannot see anything inside the mind map.

This plugin does the opposite:

```
Mind map node  ⇄  SiYuan list item (listItem) + paragraph
```

So search, bidirectional links, outline, Markdown export, and mobile viewing **all work automatically**.

## 2. Layering

```
┌─────────────────────────────────────────────────┐
│  UI         mount.ts Mind map tab / Outliner outline│
│           (React mounted into a SiYuan Custom Tab)  │
├─────────────────────────────────────────────────┤
│  Sync       sync.ts  SiYuan edit → view (ws-main)   │
│           tree-ops.ts tree operations               │
├─────────────────────────────────────────────────┤
│  Storage    store.ts doc I/O, writeback, conflicts  │
│           api.ts SiYuan kernel HTTP client          │
├─────────────────────────────────────────────────┤
│  Mapping ★  map.ts   SiYuan Kramdown → tree (read)  │
│           blockdom.ts node tree → SiYuan DOM (write)│
│           (both pure logic, zero dependencies)      │
├─────────────────────────────────────────────────┤
│  Model      types.ts OutlineNode                    │
│           layout.ts layout algorithm and themes     │
└─────────────────────────────────────────────────┘
```

### Key: the mapping layer is pure logic

`core/map.ts` **has no React, no network, no IO**. Every SiYuan format pitfall is locked inside this one file,
so it can be tested without SiYuan. This is the most important boundary in the whole design — it keeps the "format contract" and
the "business behavior" from polluting each other.

| File | Lines | Responsibility |
|---|---|---|
| `core/map.ts` | 892 | ★ Format mapping (pure logic, read) |
| `core/blockdom.ts` | 166 | Node tree → SiYuan DOM (write) |
| `core/layout.ts` | 754 | Layout algorithm and themes |
| `model/types.ts` | 107 | Data model |
| `model/tree.ts` | 130 | CRUD / collapse / statistics |
| `siyuan/api.ts` | 559 | HTTP client |
| `siyuan/store.ts` | 2167 | Storage / incremental writeback / conflicts |
| `plugin/mount.ts` | 1891 | React mounting and interaction orchestration |
| `plugin/index.ts` | 249 | Plugin entry (tab / Dock / slash menu) |
| `plugin/outline/Outliner.tsx` | 3915 | Outline editor |
| `mindmap/Mindmap.tsx` | 1655 | SVG mind map |
| `plugin/sync.ts` | 476 | Two-way sync and loop prevention |
| `plugin/tree-ops.ts` | 164 | Pure tree operations |

## 3. Data flow

### Read (SiYuan → mind map)

```
SiYuan document
  → api.getBlockKramdown()     fetch the kramdown text
  → map.kramdownToTree()       ★ parse into a node tree
  → OutlineNode[]              → render with React
```

### Write (mind map → SiYuan)

```
OutlineNode[]
  → map.treeToKramdown()         ★ produce kramdown
  → store.saveNodesIncremental()  write only the **changed blocks**
  → api.updateBlock() / updateBlockDom()
```

### Incremental strategy

**Never `updateBlock` the whole document** — that rebuilds every block ID, destroying references, bookmarks, and backlinks.

| Method | Responsibility |
|---|---|
| `saveNodesIncremental` | Compare text block by block, write only the differences |
| `syncStructure` | Add / remove nodes, adjust hierarchy |
| `syncDeletions` | Deletion (with a safety gate) |

## 4. Three hard design principles

### 4.1 Zero custom attributes

All data lives on SiYuan's **native carriers**:

| Data | Native carrier | After uninstalling the plugin |
|---|---|---|
| Node identity | The `listItem`'s own block ID | ✅ Preserved |
| Node note | **Multiple paragraphs** under the listItem | ✅ Shown directly below the node, can be several paragraphs |
| Todo | `- [ ]` / `- [x]` | ✅ |
| Heading | Native h1~h6 | ✅ |
| Mirror | Native embed `{{(( docId ))}}` | ✅ Rendered directly |
| Rich text | Native inline markers + inline styles | ✅ |

Measured count of `custom-*` write points = **0**.

### 4.2 Incremental writeback

See §3. The core point is **never rewriting the whole document**.

### 4.3 Deletion safety gate

Only blocks that **appeared in the tree before and are gone now** are deleted.

> Reverse sync is delayed. Judging by "SiYuan has it but the tree does not, so delete it" would **silently erase blocks someone just added**.
> Better to miss a deletion than to delete by mistake.

## 5. The two-path problem of rich text

SiYuan inline rich text has **two mutually incompatible** write paths:

| Path | Accepts | Does not accept |
|---|---|---|
| `dataType=markdown` | markdown syntax (`` ` `` `**` `~~` `==`) | **HTML tags, IAL** |
| `dataType=dom` | SiYuan `data-type` structure | **Raw HTML tags** |

Measured:

```
<span style="color:red">红</span>   via markdown → escaped into literal source, color lost
<b>粗</b>                           via dom      → collapses into &lt;protyle-html&gt;
```

⇒ **Before writing, the internal fragment must be turned into the shape that path accepts.**

### Strategy: markdown by default, DOM only when styles are present

```
hasRichStyle(html)?
  ├─ no  → updateBlock(kramdown)
  └─ yes → updateBlockDom(htmlToSiyuanDom(html))
```

The DOM path is more fragile (raw tags crash it), so keeping its scope minimal keeps the risk surface minimal too.

### Hidden constraint: style and semantics must merge into the same tag

| Form | Kernel kramdown | Result |
|---|---|---|
| `<span style><span strong>X` | `<span style>X</span>{:…}` | ❌ Bold lost |
| `<span strong><span style>X` | `**X**` | ❌ Color lost |
| `<span strong style="…">X` | `**X**{: style="…"}` | ✅ Both preserved |

`htmlToSiyuanDom()` rewrites both kinds of nesting into the merged form.

### Colors use CSS variables

SiYuan itself uses `var(--b3-font-colorN)` / `var(--b3-font-backgroundN)`,
which follow the theme's light and dark automatically. The parsing side **identifies by attribute name**, not by the form of the color value.

## 6. Sync and loop prevention

`sync.ts` subscribes to the plugin's `ws-main` event and handles only `transactions` messages —
these are real edit events pushed by the kernel, with the lowest latency; no polling.

**Core difficulty**: the mind map writing back to SiYuan also produces transactions, and without interception this forms a
"write back → event → write back again" infinite loop.

**Two safeguards**:

1. `EchoGuard`'s `applying` flag — events arriving during a writeback are dropped
2. A **block ID whitelist** (with a time window) — this catches it even when the flag fails due to async timing

> ⚠️ Measured: in update transactions `rootID` is an **empty string**, so it cannot be used to filter documents.
> Instead, use a "block ID → node ID" reverse lookup to hit the blocks we care about.

## 7. Test strategy

The offline suites under `src/**/*.test.ts` are mostly **regression tests** — each one
corresponding to a real pitfall that was hit; the Playwright specs under `e2e/` cover what
genuinely needs a browser. `npm test` and `npm run test:e2e` are the only source of truth for
how much that is -- a count written here goes stale without failing anything.

| Suite | Pitfall covered |
|---|---|
| `kernel-bugs.test.ts` | Working around defects in the kernel itself |
| `echo-guard` / `echo-own-value` | Loop prevention |
| `stale-mapping` / `blockmap-namespace` | Mapping-table namespace mismatch |
| `panel-focus` / `panel-escape-focus` | A panel stealing focus and not giving it back |
| `undo-merge-kind` / `undo-first-edit` | Undo merge window and first edit |
| `note-persist` | Node note silently lost |
| `target-gone` | Target document deleted externally |
| `conflict-tracker` | External changes while a writeback is in flight |

When adding behavior, **prefer writing a test that reproduces the original problem** rather than testing only the new feature.

## 8. Known boundaries

| Item | Status |
|---|---|
| Summary `summaryData` / link lines `linkLines` | SiYuan has no native counterpart, so **writing them out is abandoned**; old documents remain readable |
| Cloze `mask` | Only the original text is kept, not the cloze semantics |
| Images | Migrated to SiYuan assets |
| Plugin name | Still a placeholder, **cannot be installed** (name to be decided) |
