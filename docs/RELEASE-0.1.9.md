# 0.1.9

Release focused on mindmap layout alignment, cross-document state isolation, and synchronization integrity under high concurrency and echo cycles.

Storage format and configuration remain fully compatible with 0.1.8.

## Key fixes

### ★★ Mindmap child node layout centered vertically relative to parent
The mindmap subtree layout previously offset child nodes with a downward staircase descent even when branch children were parallel. The child node layout now centers children vertically relative to their parent node (`parentCy`), aligning with standard mindmap behavior and keeping branches level.

### ★★ Task status included in tree serialization (`serializeTree`)
Toggling a node's task status (`taskStatus`: none / todo / done) modifies the SiYuan block type or marker. Previously, `serializeTree` omitted `taskStatus`. When a user toggled a task status while another write was debounced or in flight, `serializeTree` matched `lastWrittenTreeRef`, causing the catch-up write to be dropped silently. `serializeTree` now includes `n.id:task=${n.taskStatus ?? 0}`.

### ★★ EchoGuard block ID registration fix across write operations
`withEchoGuard`'s block ID provider was previously given Node IDs (`blockToNodeRef.current.values()`) instead of SiYuan Block IDs (`blockToNodeRef.current.keys()`). Because `guard.isEcho(blockId)` checks incoming WebSocket block IDs, post-write echo protection was bypassed for `handleEdit`, `handleDropBlocks`, `handleDeleteNode`, `handlePasteBlocks`, and `handleAddNode`. The registrations now pass SiYuan block IDs (`[docId, ...blockToNodeRef.current.keys()]`).

### ★ Mindmap collapse state isolated per document without transition race
The mindmap's collapsed node state is keyed per document (`om-mm-collapsed:<docKey>`). Previously, switching documents in the same view instance retained the previous document's in-memory set and immediately overwrote the newly active document's localStorage record before reloading. Document transitions now track previous keys, reload clean states on switch, and prevent cross-document overwrites. Switching documents also resets the viewport to auto-fit the new tree.

### ★ Echo protection and transaction locking for subdocument extraction and doc notes
`store.nodeToSubDoc` and `store.syncDocParagraphs` previously ran outside `store.beginWrite()` and `withEchoGuard()`. Block deletions during subdocument extraction and paragraph mutations in document notes triggered external block transaction events, risking unwanted document reloads. Both operations are now wrapped with write transaction locks and echo protection.

### ★ Mindmap root topic interaction cleanup
The synthetic root topic (`__root__`) representing the document title now routes Enter to creating a first-level topic (child) rather than attempting an invalid root sibling. Delete/Backspace on the root topic is ignored, and text editing on the root node routes directly to document title renaming.

### ★ FreeMind export note line break escaping
FreeMind export (`exportFreemind`) previously joined multi-line note paragraphs with `<br>` and then escaped the entire block, turning `<br>` into literal `&lt;br&gt;`. Each line is now escaped individually before joining with `<br>`.
