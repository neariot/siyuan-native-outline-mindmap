# Pitfalls · Data and Write-back

← [Master index](../PITFALLS.md) | Things we have stepped on once and do not want to step on again; each entry is "symptom → root cause → practice".

Entry numbers (such as `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by number,
so when splitting the file we keep the original numbers and do not renumber. The numbers do not indicate order within this file;
the `6.x` ones were moved here by topic from the original "Engineering and Testing" section.

### 1.1 The namespaces of the two block IDs must never be mixed

**Symptom**: the UI is entirely normal and write-back raises no error, but that node in SiYuan is always empty.

**Root cause**: in SiYuan one list node corresponds to two block IDs with completely different purposes:

| Variable | What it stores | What it is used for |
|---|---|---|
| `lastBlockMap` | Child paragraph block `p` | `updateBlock` to change the text |
| `lastListItems` | `listItem i` | `previousID` / `moveBlock` structural anchor |

Put a `listItem` into `lastBlockMap` and call `updateBlock(markdown)`, and the kernel rules the structure invalid:

```
invalid block structure: NodeList [...] cannot contain NodeParagraph
```

**Practice**: the two tables each do their own job; when registering an ID, decide up front whether it is for changing text or for serving as an anchor.

This kind of pollution is temporarily masked by "replace everything" —— `loadBlockMap` used to rebuild the whole table every time,
and the correct paragraph blocks from SQL would wash the pollution away. As soon as a table is given "retain/merge" semantics, the pollution becomes permanent.
→ Before giving a table retain semantics, first confirm that all the values currently in it are clean.

**Test**: `src/plugin/blockmap-namespace.test.ts`

---

### 1.2 External changes received while a write-back is in flight must be recorded as conflicts

**Symptom**: change one node in the outline while changing the same paragraph block through the API → the UI and SiYuan each show their own value,
the external change vanishes silently, and the conflict banner is `None`.

**Root cause**: the `if (base === current) return false;` in `ConflictTracker.check()`,
with the baseline advanced when a write-back is initiated (it must be, otherwise intermediate states are lost and you get false conflicts), leaves a window:

```
t0 changed to "导图" (mind map) → baseline='导图' → write-back in flight
t1 the API changed it to "外部节点一" (changed externally) → base == current → judged "no local intent" → adopt the external value
t2 the in-flight write-back writes the block back to "导图" → the external change is overwritten, with no notice
```

**Practice**: `check(nodeId, current, incoming, writeInFlight = false)` ——
while a write-back is in flight, always return `true`. Reason: at this moment the value on the SiYuan side is bound to be overwritten by the in-flight write-back,
so the premise of "no local intent" simply does not hold.

**Verification points**: any change that "increases the sensitivity of conflict detection" must run both directions:
1. Quickly change 3 nodes yourself in the outline → there should be no conflict (otherwise the false-conflict bug comes back)
2. Change the outline + change the same block through the API → 1 conflict should be reported

Verifying only item 2 is not enough —— turning sensitivity all the way up can make item 2 pass while breaking item 1.

**Test**: `src/plugin/conflict-tracker.test.ts`

---

### 1.3 The write-merge fingerprint must include every field that affects the output

**Symptom** (it has happened twice in this project's history, same root cause with a different field):
- A note "has only the first character left"
- When "only the attached paragraph is changed, not the body text", the follow-up write is skipped silently

**Root cause**: the criterion for write-merge is "did the tree change", while the fingerprint only counted some of the fields:
early on `serializeTree` compared only `id:text`, without attributes; later, after switching to native attached paragraphs,
the same trap moved to `paragraphs`.

**Practice**: the fingerprint must cover every field that gets written out.
Now `serializeTree` in `mount.ts` carries `paras=JSON.stringify(...)`.

When adding a new field that gets written back, `serializeTree` must be updated in step.
Missing it raises no error; it only shows up as "I changed this field and nothing happened".

**Test**: `src/plugin/note-persist.test.ts`

---

### 1.4 When the target document is deleted externally, it must be recognized and recoverable

**Symptom**: after the document is deleted externally, the outline UI still displays as usual and still accepts input,
but every write-back is rejected by the kernel and the SiYuan side has not a single character —— the edits live only in memory and are eventually lost.

The kernel's own words (no stable error code, so the message can only be matched):

```
insertBlock → {"code":-1,"msg":"parent block not found: <docId>"}
updateBlock → {"code":-1,"msg":"load block tree [<id>] failed: tree not found"}
```

**Practice**: `isTargetGoneError(e)` recognizes the semantics → `describeWriteError(e)` produces readable wording →
the error bar renders a "Save as new document" button that writes the in-memory tree out as a new document.

Pitfall within a pitfall: `notebook` is an empty string.
When the store is constructed it is passed `notebook: ''` (see `src/plugin/mount.ts`). Harmless normally (write-back relies on known block IDs),
but save-as reports `invalid ID argument` —— the entry point pops up, yet clicking it errors out and the content is still lost.
And it cannot be looked up afterwards: the document row is already gone from the SQL index,
`SELECT box FROM blocks WHERE id='<已删文档>' LIMIT 1` (deleted document) returns nothing.
→ It must be remembered while the document still exists (`rememberNotebook()`), and save-as tries in order
`this.notebook → look up the box of nearDocId → lastNotebook`.

**Verification points**: "no error" alone is not enough; you must verify that the content really landed in the new document.
All four steps must pass before it counts as fixed: readable message → click save-as → content preserved → editing can continue after save-as.

---

### 1.5 Do not use the `blocks.sort` column to determine sibling order

**Symptom**: sorting nodes by the `sort` value queried back from SQL gives an order different from what you see in SiYuan.

**Root cause**: the `sort` column of SiYuan's `blocks` table is node type priority, not sibling order.

> I once misreported this as a kernel bug and withdrew it after verification. Recorded here to avoid repeating it.

**Practice**: to get the order, read `kramdown` / the block tree, not `sort`.

**Test**: `src/plugin/map-coverage-guard.test.ts` (covers the mapping surface)

---

### 1.6 An insert can destroy an already-existing sibling —— the anchor's meaning depends on the structure it sits in

**Symptom** (measured 2026-10-05, desktop instance, kernel 3.8.6, `lang: zh-CN`; clean document `- 甲` / `- 乙` / `- 丙`, Tab to create the child `子T`, then Enter on `子T` to add its sibling `同E`):
`子T` is **gone from SiYuan**, while the outline, the mind map and the mapping table all still show it:

```
before the fix:  SiYuan ['甲','  同E','乙','丙']    <- 子T destroyed by the insert
                 UI      甲 > {子T, 同E}            <- both nodes still there
```

Nothing on the write-back side was wrong: the anchor was right, the two nodes had **different** node IDs, `子T -> wsg1bo6` and `同E -> f4r9bbk` were different blocks, the text writes were right, and `syncDeletions` **never fired once**. A liveness probe on the mapping table then showed **7** mappings of which only **4** blocks were still in the database —— the two dead links (`子T`, `同E`) belong to this case.

**Root cause**: `previousID` is not a stable "insert after this block" —— its meaning depends on the structure the anchor currently sits in (kernel behaviour: `kernel-api.md` 7.1). When the child list does not exist yet, one anchor form builds it; when it already exists, the insert makes the kernel rebuild the list and the existing item is **replaced**. `insertBlock` still answers `code:0`, so there is no error to react to.

**Practice**: a mapping that points at a **dead block** is more dangerous than no mapping at all —— a missing mapping makes the node look new (a re-insert is idempotent), while a dead mapping makes every stage believe "we already have it" (`syncStructure` skips it, `updateBlock` writes nowhere, `syncDeletions` says nothing). Validate liveness on both sides:

1. when entering a write-back, `loadBlockMap`'s own result is the authority (zero extra queries): drop every mapping whose block is not in it;
2. right after an insert, re-check the blocks that existed **at the same level before** the insert (usually 0~2 of them) and drop the mapping of any that is gone, so that this same write-back re-inserts it.

After the fix: `['甲','  同E','  子T','乙','丙']` —— both children present, unchanged after another 18 s.

★ **Lesson**: "SiYuan and the UI disagree" points in **two opposite directions**. A **missing** node (this entry: the insert destroyed an existing sibling) and a **duplicated** node (1.9: the mapping key drifted) have different root causes and different fixes —— read the direction off the symptom before touching anything.

**Test**: `src/plugin/kernel-side-effects.test.ts`, `src/plugin/stale-mapping.test.ts`

---

### 1.7 A child node must be merged into the parent's existing child list —— one list, not one per insertion

**Symptom**: both views agree (`甲 > {子T, 同E}`), yet the block tree under `甲`'s listItem holds **two parallel child lists**, one item each:

```
i  甲
  l  <- child list A  -> i 子T
  l  <- child list B  -> i 同E     ★ two sibling lists
```

and the sibling order can then **never** be corrected (1.8). Measured before this fix —— i.e. after the data-loss fix of 1.6: SiYuan `['甲','  同E','  子T']` against the UI `[子T, 同E]`; both children present, the order disagreed.

**Root cause**: the insert was anchored on the **parent's paragraph block**, so every insertion let the kernel create a new child list. The child's mapped block ID is therefore a **List `l`**, while `moveNodes` resolves a node's parent through `actualParentOf`, which only collects `type='i'` blocks —— the List resolves to nothing and the node is skipped.

**Practice**: before inserting a child, look up the parent's existing child list and anchor on its **last listItem**, so the kernel merges into the same List:

```sql
SELECT id FROM blocks
 WHERE type='i'
   AND parent_id IN (SELECT id FROM blocks WHERE parent_id='<parent listItem>' AND type='l')
 ORDER BY id DESC LIMIT 1
```

Only when the parent has no child list yet fall back to the parent paragraph block (there the kernel creates the list).

Measured after the fix: child list count = **1** (confirmed by SQL), the resolved text is `['甲','  子T','  同E','乙','丙']` —— exactly the UI order —— and the three-level case `甲 > {子T > 孙X, 同E}` is still correct 18 s later.

**Test**: `src/plugin/single-child-list.test.ts`

---

### 1.8 A position correction needs a listItem mapping —— otherwise `moveNodes` skips the node and still reports `moved: 0`

★ Current accepted state: **no data loss, but the sibling order differs from the UI** (SiYuan `['甲','  同E','  子T']` vs the UI `[子T, 同E]`), and **nothing is reported**: `moveNodes` returns `moved: 0` as usual. That is "the order was not corrected", not "the order is right".

**Root cause**: the measured trade-off is that **no** anchor form gives "correct position" and "no data loss" at the same time:

| `insertBlock` anchor | data loss | position |
|---|---|---|
| `parentID = <List>` | no | right, but the kernel rejects it (`code:-1`) |
| `previousID = parent paragraph block` | **yes** | right |
| `previousID = parent listItem` | no | **wrong** |
| `previousID = sibling paragraph block` | **yes** | right |

So the strategy has to be: take the loss-free form, then let `moveNodes` correct the position. ★★ That second step **requires** the node's mapped block to be a real **listItem**: `actualParentOf` only contains `type='i'`, so a child whose mapped block is the List `l` (or the paragraph `p`) resolves to nothing -> an empty `wantListId` / `if (!actualParentBlock) continue` -> the node is **skipped** and nobody corrects it, while the function still returns `moved: 0`. Measured probe: the child `子T`'s `wantListId` and `blockId` were the **same List ID** (`aaxx5ak`, which is 甲's List) —— the namespace-mismatch family again (1.1, `kernel-api.md` 7.7).

**Practice**: treat "the order was not corrected" as a state of its own —— `moved: 0` means "nobody looked at this node", not "it is already in place". Keep every node's mapping on a real listItem (that is what 1.7's anchor rule buys), and when the real type of a mapped block is unknown, resolve it before deciding to skip.

**Test**: `src/plugin/kernel-side-effects.test.ts`, `src/plugin/stale-mapping.test.ts`

---

### 1.9 The mapping key must stay in one namespace on every write path —— otherwise an existing node is inserted a second time

**Symptom** (measured 2026-10-05, desktop instance, kernel 3.8.6; three-level fixture `甲 > 子T > 孙X` with the sibling `同E`): the same content appears **twice** in SiYuan, 17 seconds apart, each copy with its own paragraph block:

```
子T
  ├── 同E   (22:32:58)
  └── 同E   (22:33:15)   <- duplicate
```

**Root cause**: the two sides of the mapping table used different key spaces. The insert path registered the mapping under the **client-side node ID** (`makeSiyuanId()`), while `loadBlockMap` rebuilt it under the **block ID**; the insert sent `- ${text}` with no id, so the kernel assigned a fresh block ID. Measured proof that the two really differ:

```
node ID      = <node-id>
mapped block = <block-id>     <- one second apart: two different IDs
```

-> the next write-back finds no mapping for that node, judges it new and **inserts a second copy**. The symptom of a key mismatch is a duplicate block, not an error.

**Practice**: inline the node's own id into the inserted markdown so the kernel **adopts** it —— `- {: id="<node id>"}text`, with a non-conforming id falling back to the id-less form so the kernel never receives a bad one. Node ID then equals the listItem block ID, and in kramdown every listItem carries it as `{: id="…"}` —— which is also what lets a structural assertion compare ids without an SQL round trip.

Measured after the fix: only **1** `同E`, the nesting `子T > 孙X` correct, still stable after 18 s.

★ **Lesson**: the mapping table's key must stay in **one namespace across every write path**. "The read path uses the block ID, the write path uses the client ID" looks identical in normal operation and only diverges when the kernel assigns an id itself —— and the symptom is a duplicate, not an error.

**Test**: `src/plugin/node-id-block-id.test.ts`

---

### 1.10 Connector lines: no native carrier means no attribute is written —— and a reload is the only proof that a write-back landed

**Observation** (measured, desktop instance, kernel 3.8.6): while connector lines were still being written out, the round trip was: select 2 nodes (`Shift+↓` in the outline) -> "+ Link" -> label `分支一` -> written back. The outline then showed the 🔗 marker **2 times** (source and target), the mind map drew **1** dashed line with that label, and after a **full page reload** both the line and its attribute were still there (`custom-mubu-linklines` on the **source node's** listItem). After deleting the line: **0** dashed lines, the field dropped entirely, and it was still empty 8 seconds later.

**Current state**: the private attribute is gone, and so is the feature. SiYuan has no native carrier for "a connection between two nodes", so the field was **removed from the model and the UI** (`MAPPING.md` 3.3, `ARCHITECTURE.md` §8) rather than left as a control whose result could not outlive the session; documents that still hold the old attribute remain readable.

**Practice**: before adding an attribute, ask "is there a native carrier for this" (`PITFALLS.md` A1) —— a home-made attribute is invisible to search and backlinks and shows up only as an icon you have to open. When there is none, keep the value session-local and say so instead of inventing a carrier. ★★★ And verify every "it was written into SiYuan" claim by **reloading the page**: the in-memory tree survives no reload, so a UI-only check cannot tell the two apart —— the reload is the only evidence that a value is really in the document.

**Test**: `e2e/outline.spec.ts` (the absence check —— no link control is offered, no `.mm-link` renders)

---
