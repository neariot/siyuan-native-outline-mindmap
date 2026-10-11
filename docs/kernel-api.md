# SiYuan kernel API

These are **behaviours of the kernel itself**, not design choices of this
plugin. But this plugin calls them heavily (`insertBlock` / `updateBlock` /
`previousID` appear hundreds of times under `src/`), and you will step on them
if you do not know them.

Why it is a separate document: it still holds in another SiYuan project — it
records how SiYuan works, not how this plugin is implemented. The pitfall
ledger (this plugin's symptom → cause → practice) is
[`PITFALLS.md`](PITFALLS.md).

---

## 7.1 Anchor rules for `insertBlock`

The insertion point is decided by `previousID` and `parentID`; pick wrong and
you get a completely different structure:

| Parameter | Value | Result |
|---|---|---|
| `previousID` | a paragraph block `p` | The new node becomes a **child** of that node (use this when adding a child) |
| `previousID` | a `listItem i` | The new node becomes its **sibling** (use this when adding a sibling) |
| `previousID` | a document ID | The kernel **panics** (nil pointer) |
| `parentID` | a `listItem` | The parent's text is pushed out into a standalone paragraph (wrong) |
| `parentID` | a document ID | The correct top-level append |

The return value is easy to misread too: it is a **transaction array**
`[{doOperations:[{action,id}]}]`, not `[{id}]`. That `id` is the **list
container `l`**, neither the listItem nor the paragraph. To get the real
listItem you have to query again:

```sql
SELECT id FROM blocks WHERE parent_id='<the returned id>' AND type='i' LIMIT 1
```

## 7.2 A whole-document `updateBlock` rebuilds every block ID

`updateBlock(documentID, wholeDocumentMarkdown)` **rebuilds all block IDs**,
destroying `((references))`, bookmarks, and backlinks. Write-back must be
**incremental, block by block**.

## 7.3 Poll after writing; the SQL index lags

After a block is written, the SQL index trails by 1–3 seconds, longer when the
kernel is busy. Asserting right after a fixed `sleep` reads a stale value,
which shows up as "sometimes it works, sometimes it does not".

The criterion must be "has the content reached the expected state", not "how
long did we wait". Allow 15 seconds of slack for deletions to converge in the
index.

## 7.4 Deletion needs a safety gate — missing a delete beats deleting wrongly

The deletion criterion must **not** be "SiYuan has it and the current node tree
does not". Pulling externally added blocks into the map through reverse sync
has latency; if the map writes back first, that new block looks deleted and is
**silently wiped**.

Measured (with the gate removed): expected 1 deletion, actual `removed=2`, user
data destroyed.

Practice: accumulate an `everSeen` set and delete only blocks that previously
appeared in the tree and have now disappeared. Never touch a block we have
never seen.

The accompanying test must verify that it **really fails once the gate is
removed**, otherwise it is a fake guard.

## 7.5 `getBlockKramdown` appends an attribute line

It returns the **whole block as kramdown, with a `{: id="..." }` attribute line
at the end**. To append something after the text (a document reference
`((id 'title'))`, say) you must strip that attribute line first, otherwise your
addition lands after it and becomes an invalid token — surfacing as "the
reference does not work".

## 7.6 A listItem's `content` aggregates descendant text

`SELECT ... WHERE content LIKE '%childNode%'` also matches the parent. Always
locate blocks by ID, never by fuzzy content matching.

## 7.7 Do not mix two kinds of ID in one map

Do not use "block ID" and "business node ID" as keys of the same table. As soon
as two values coincide they overwrite each other, making write-back and deletion
**hit the wrong target**, with extremely subtle symptoms. Reverse lookups for
block IDs use a separate table.

## 7.8 Kramdown parsing only recognises list lines

If parsing treats **non-list lines** as nodes, ordinary body paragraphs enter
the node tree carrying their own block IDs; on write-back "in my tree but not in
SiYuan's list" makes them look like missing nodes that get re-inserted — and the
body gains a duplicate list copy out of nowhere.

Only lines starting with `- ` count as nodes. That also matches the "node =
native list item" representation better.

## 7.9 A dragged block's MIME key carries data in the key itself

The `application/siyuan-gutter` key is assembled:

```
application/siyuan-gutter + type + ZWSP + subtype + ZWSP + blockID(comma separated) + ZWSP + workspace path
```

The value is JSON `{html, notebookID, rootID}`. Because data is mixed into the
key, you must iterate `dataTransfer.types` and prefix-match each one; you cannot
call `getData("application/siyuan-gutter")` directly. ZWSP = `\u200b`.

## 7.10 A few plugin-loading details

- `frontends` must include `browser-desktop` (`getFrontend()` returns it in a
  browser); omitting it gets you **silently filtered out** by the kernel.
- Plugin registration reads `data/storage/petal/petals.json` only; it does
  **not** scan `data/plugins/`.
- You must emit real CJS: the kernel loads it with
  `eval("(function anonymous(require,module,exports){...})")`.
- `eventBus` lives on `Plugin`, not on `Custom`. Inside `addTab`'s `init`
  callback `this` is the Custom, so capture the plugin instance in `onload`
  first and pass it down.
- Tab de-duplication: `custom.id` must equal the registered type, and `data` is
  compared with `objEquals`.
- The layout tree path is `window.siyuan.layout.centerLayout`.

## 7.11 Creating a sub-document requires looking up the notebook

When the plugin mounts, the store's `notebook` is often an empty string; before
creating a sub-document, look it up in place with
`SELECT box FROM blocks WHERE id='<docId>' LIMIT 1`.

Also, "expand into a sub-document" means **moving** the child nodes, not copying
them — copying would store the content in two places that never sync.

## 7.12 `moveBlock` broadcasts no transaction; it reloads the editor instead

There are **two paths** for telling the editor about a block API write, and
`moveBlock` is the only exception:

| API | How it syncs |
|---|---|
| `insertBlock` / `appendBlock` / `updateBlock` / `deleteBlock` and 15 more handlers | `broadcastTransactions(transactions)` → the editor **applies the delta** |
| **`moveBlock`** | **`model.ReloadProtyle(rootID)`** → the editor does a **full reload** |

(See `kernel/api/block_op.go`. Moving across documents reloads **two**
documents — source and target.)

⇒ Seeing "moving a block makes the editor spin and reload" is **not waste, it is
its only sync mechanism**. Do not try to skip it: without it the editor will
disagree with the actual structure.

### It is already de-duplicated, so a batch move does not reload N times

`ReloadProtyle` goes through
`task.AppendAsyncTaskWithDelay(task.ReloadProtyle, 200ms, ...)`, and
`ReloadProtyle` **is on the `uniqueActions` list in `kernel/task/queue.go`**.
De-duplication compares `(action, args)`, and `getCurrentTasks()` includes both
**currently running tasks and the pending queue** ⇒ reloads issued back to back
for **the same document** are merged. Indenting 20 nodes in one batch does
**not** reload 20 times.

### A failed move never reloads at all

Inside `moveBlock`, an error from `PerformTransactionSync` makes it **return
early**, so `ReloadProtyle` is never called.
⇒ "The move failed" cannot cause an editor reload; conversely, **seeing the
editor reload means that move succeeded**.
(This distinguishes where a fault came from: a full page reload with the logo
flashing is the `ReloadUI` path, while a spinning editor is this one.)

---

## 7.13 The theme attribute, and how to switch the theme for real

**Where it lives**: SiYuan writes `data-theme-mode` on **`<html>`**, with the
theme names beside it and **nothing on `<body>`**. Read out of the live DOM:

```html
<html data-theme-mode="light" data-light-theme="daylight" data-dark-theme="midnight">
```

The shipped bundle agrees: `data-theme-mode` appears 37 times, `data-theme=`
zero. So `[data-theme='dark']` matches nothing at all, and a rule written that
way is dead while every layer stays green.

**But the palette is not the attribute.** The colours come from CSS variables
the front end computes (`--b3-theme-background`, measured `#fff` in light and
`#1e1e1e` in dark). Setting the attribute by hand therefore changes the
attribute and nothing else: `html[data-theme-mode='dark']` starts matching
while the page stays light, which is precisely how a screenshot taken that way
manages to lie.

**Switching it for real**: `POST /api/setting/setAppearance` with the token,
carrying the **whole** appearance object (`window.siyuan.config.appearance`;
the same block sits in `<workspace>/conf/conf.json` under `appearance`).
`appearance.mode` is `0` light / `1` dark / `2` follow the system — and
**`appearance.modeOS` overrides it**: with "follow the system" on, the OS
preference wins, and headless Chromium reports light, so `mode: 1` alone was
measured to change nothing while the kernel still answered `code:0`.
Send `{modeOS: false, mode: 1}`, then **reload** the page.

The working implementation of all of the above is `e2e/themes.ts`
(`useTheme` / `restoreTheme`), and its cases are `e2e/theme.spec.ts` —— which
also asks the CSS engine whether every theme-conditional rule in the shipped
stylesheet **can match at all** (a rule that matches in neither theme, such as
one keyed off `data-theme`, is dead).

---

## 7.14 `openTab` needs the real application instance, and `action` is not what breaks it

Opening a document or a block from a plugin goes through the official
`openTab` from the `siyuan` module (`window.siyuan.ws.app.openTabById` does
not exist, and neither does `window.siyuan.model` / `layout.openTab`). The
`doc` branch takes `{app, doc:{id, zoomIn, action}, keepAlive}`.

A 2×2 controlled experiment decided which argument matters:

| `app` | `action` | page errors | result |
|---|---|---|---|
| real app | not passed | 0 | renders fine |
| real app | passed | 0 | renders fine |
| plugin instance | not passed | 1 | blank page |
| plugin instance | passed | 1 | blank page |

⇒ **`app` is the only independent variable.** The kernel's `class Ks`
constructor does `s.plugins.forEach(...)` with `s === app`, and a plugin
instance has no `plugins` field, so the call throws inside the kernel and the
tab is left blank. The error appears in the background console only —— the
user sees a click that did nothing.

⇒ The claim "`action` must be passed or the kernel crashes", which had been
inferred from reading the kernel bundle, does not match measurement. `action`
is still worth passing (`['cb-get-focus', 'cb-get-scroll']`, the combination
SiYuan itself uses) because it decides focus/scroll after opening.

★ **There is no sensible fallback for `app`.** Substituting the plugin
instance when `window.siyuan.ws.app` is unavailable produces exactly the
blank-page row above, so the precondition is checked and the user is told
(`errClientNotReady`) instead (`src/plugin/mount.ts`).

---
