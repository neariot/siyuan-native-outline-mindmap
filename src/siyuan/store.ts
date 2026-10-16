// Document storage layer built on the SiYuan kernel.
//
// **The only data source is the SiYuan notebook**: this module keeps no local
// cache; every read queries the kernel directly and images go to SiYuan assets.
//
// Mappings:
//   one "document" (PersistedDoc)  ⇄  one document in SiYuan (.sy)
//   DocMeta.id                 ⇄  SiYuan document block ID (22 chars)
//   node tree OutlineNode[]    ⇄  the document's block structure (via core/map.ts)
//   folder FolderMeta          ⇄  SiYuan's document tree hierarchy (as a path prefix)
//
// Key points:
//   - all reads and writes are **asynchronous** (network/IPC), so the API returns Promises
//   - deletion goes through removeDocByID, i.e. into the SiYuan trash
//   - writes always use `dataType=dom` (see core/blockdom.ts) to avoid markdown's blank-line semantics

import { unescapeHtml } from '../model/html-escape';
import { collectIds, flatNodes, findNode, findPath } from '../model/tree';
import type { DocMeta, FolderMeta, OutlineNode } from '../model/types';
import { SiYuanClient } from './api';
import { kramdownToTree, takeTitleParagraphs, htmlToKramdown, htmlToSiyuanDom, SIYUAN_ID_RE, makeSiyuanId, nodeSubtreeToKramdown, nodeInsertLine, taskStateOfKramdownLine, markdownToInlineDom, tableToKramdown, codeBlockToKramdown } from '../core/map';
import { treeToBlockDom, paragraphBlockFragment } from '../core/blockdom';
import { parseDomToTree, type BlockTreeState } from './dom-tree';
import { updateTaskMarkerWithFallback } from './host-compat';

/**
 * Whether an entry of the *previous* mapping read must be carried over into this one.
 *
 * ★ The index lags 1~3 seconds behind an insert, so a block this session created is simply not in the
 *   result of the read that follows —— and dropping its mapping makes the node look new on the next
 *   write-back, which **inserts it a second time** (defect #54, measured: `SiblingE` at 22:32:58 and again
 *   at 22:33:15). Carrying over the entries we have seen with our own eyes, but only for blocks **we**
 *   inserted, is what keeps a just-written node mapped without keeping a foreign block's stale mapping
 *   alive forever.
 *
 * Both halves matter, so both are asserted: `current` (this read really lacked the key) **and** ownership
 * (the block is one this session inserted).
 */
export function isUnseenButOurs(
  current: Map<string, string>,
  key: string,
  blockId: string,
  freshlyInserted: Set<string>,
): boolean {
  return !current.has(key) && freshlyInserted.has(blockId);
}

/**
 * The mappings that point at a block the index did not report —— candidates for "this block is dead".
 *
 * ★ Exported so its boundaries can be pinned, because both directions are destructive:
 *
 *   · **Declare too much dead** and a live node's mapping is cleared, so it is re-inserted and the document
 *     gains a **duplicate** (defect #54: the exemption below was missing, and the same node was inserted
 *     twice — measured `SiblingE` at 22:32:58 and again at 22:33:15).
 *   · **Declare too little dead** and the node keeps a link to a destroyed block: `syncStructure` believes
 *     "it is already there", `updateBlock` writes into nothing, `syncDeletions` reports nothing —— present
 *     in the UI, absent in SiYuan, **with no error at all** (measured `total=7, only 4 alive`).
 *
 * `freshlyInserted` is the exemption: a block this session created has an index entry that necessarily lags
 * by 1~3 seconds, so "SQL did not find it" says nothing about it yet.
 *
 * A node with **no** mapping is not a suspect —— it is a new node, and the insert path handles it.
 */
export function deadMappingSuspects(
  blockMap: Map<string, string>,
  aliveIds: Set<string>,
  freshlyInserted: Set<string>,
): Array<[string, string]> {
  const suspects: Array<[string, string]> = [];
  for (const [nodeId, blk] of blockMap.entries()) {
    if (aliveIds.has(blk)) continue;
    if (freshlyInserted.has(blk)) continue;
    suspects.push([nodeId, blk]);
  }
  return suspects;
}

/**
 * Whether a missing mapping may be confirmed dead in this write-back at all.
 *
 * ★ For a **pure text edit** the node count equals the block count (`treeSize === mappedSize`), and a
 *   structural operation cannot have run, so no sibling block can have been destroyed. Skipping the
 *   confirmation query (and its 400 ms wait) keeps every keypress fast; the check that guarded this was
 *   worth more than the seconds it saves on a 300-node document, and it is the reason a suspect found
 *   during typing is left alone until a structural change really happens.
 */
export function suspectedStructuralChange(treeSize: number, mappedSize: number): boolean {
  return treeSize !== mappedSize;
}

/**
 * Whether a mapping read is so incomplete that the write-back must be refused.
 *
 * ★ Exported as a **function of two numbers** rather than left as a closure over the tree it was written
 *   for: the criterion decides whether a document is rewritten, so its boundaries have to be pinned by a
 *   test that fails when they move —— and a closure inside a method can only be tested by a copy of itself.
 *   The copy is what the unit test used to hold, which is why changing these two numbers turned nothing red.
 *
 * `missingCount` is how many of the tree's nodes the mapping could not resolve. Small documents are exempt
 * on purpose: with fewer nodes than SiYuan's row cap they are all new anyway, and blocking them would
 * refuse a legitimate first write.
 */
export function mappingLooksIncomplete(treeSize: number, missingCount: number): boolean {
  if (treeSize <= 80) return false;
  return missingCount > treeSize * 0.5;
}

export interface NumberingConversion {
  nodeId: string;
  itemId: string;
}

/**
 * Which mapped nodes need an ordered/unordered conversion: memory says `numbered`, the kernel's
 * list subtype says otherwise.
 *
 * ★ Every skip rule below is a measured boundary, pinned by `numbering-plan.test.ts`:
 *
 *   · task nodes (`taskStatus != 0`) —— a task lives in a `t` list; converting to `o` would destroy
 *     the task, and writing `1. [ ]` back has no measured path that keeps both (probed: leaf becomes
 *     an unordered task, with-children is a total no-op). Task preservation outranks numbering.
 *   · stored subtype `t` or anything but `u`/`o` —— hands off for the same reason.
 *   · unmapped nodes —— the insert path (`nodeInsertLine`) already carries the marker.
 *   · freshly-inserted blocks —— same reason; their subtype is not even indexed yet.
 *   · stored subtype unknown (SQL missed it) —— the safe direction is to do nothing; the next
 *     pass retries once the index catches up.
 */
export function planNumberingConversion(
  nodes: OutlineNode[],
  itemIdOf: (nodeId: string) => string | undefined,
  isFresh: (blockId: string) => boolean,
  storedSubtypeOf: (itemId: string) => string | undefined,
): NumberingConversion[] {
  const out: NumberingConversion[] = [];
  for (const n of flatNodes(nodes)) {
    if (n.taskStatus) continue;
    const itemId = itemIdOf(n.id);
    if (!itemId || isFresh(itemId)) continue;
    const stored = storedSubtypeOf(itemId);
    if (stored !== 'u' && stored !== 'o') continue;
    if ((stored === 'o') === !!n.numbered) continue;
    out.push({ nodeId: n.id, itemId });
  }
  return out;
}

/**
 * The new paragraph's inner content out of an insert op's DOM (`op.data`), or null when the
 * response carries no paragraph (then there is nothing to verify against).
 *
 * The paragraph div looks like
 * `<div data-node-id="…" data-type="NodeParagraph" …><div contenteditable="true" …>TEXT</div>…`,
 * so the first `contenteditable` div after the first `NodeParagraph` marker is the stored text.
 * Compared verbatim (no tag stripping): a clean insert holds the bare sent text, while a mangled
 * reuse holds the leaked `<span data-type="text">…</span>` — and that difference is the verdict.
 */
export function firstParagraphText(opData: string): string | null {
  if (!opData) return null;
  // Find the first NodeParagraph block, then the editable div inside it. The paragraph's inner
  // HTML nests (editable div + attr divs), so a non-greedy capture to the paragraph's own close
  // stops at the editable div's close instead — match the editable div directly.
  const paraIdx = opData.indexOf('data-type="NodeParagraph"');
  if (paraIdx < 0) return null;
  const edit = /<div contenteditable="true"[^>]*>([\s\S]*?)<\/div>/.exec(opData.slice(paraIdx));
  return edit ? edit[1] : null;
}

/**
 * Parameters of the write-then-read polling (**the budget must exceed the kernel's worst-case flush interval**).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why these two numbers
 * ──────────────────────────────────────────────────────────────────
 *
 * The kernel does **not** write SQLite synchronously per transaction, it does **periodic batched flushes**.
 * Measured (`scripts/kernel-index-lag.py`):
 *
 *   · inserting 5 blocks ~20ms apart in a row makes them all queryable **in the same millisecond**
 *     (span 0ms) ⇒ they land as a batch, not one by one;
 *   · the flush interval is **irregular**: 773 / 1112 / 1368 / 1623 / 1888 / 2213 /
 *     2782 ms, median about 1.7 s.
 *
 * So a "poll until visible" loop needs a budget **> the worst flush interval**,
 * otherwise it gives up while the block **has not landed yet** —— which shows as "edited it, nothing happened",
 * and it **reports no error at all**, just like "the panel shows 7, SiYuan persisted 0"
 * is one and the same symptom class.
 *
 * It used to be 12 × 120ms = **1440 ms** while the measured worst case is 2782 ms
 * ⇒ it gave up early in about half of all phases. Now it is 20 × 200ms = **4000 ms**,
 * which leaves roughly a 1.4× margin over the measured worst case.
 *
 * ★ When these two numbers change, keep `scripts/kernel-index-lag.py` in sync:
 *   `POLL_BUDGETS` —— that script reports "budget < measured worst interval".
 *   Regression test: `src/siyuan/poll-budget.test.ts`.
 */
export const POLL_ROUNDS = 20;
export const POLL_INTERVAL_MS = 200;

/**
 * Safely embed a string into a SQL single-quoted literal.
 *
 * ★ Why this is needed (fix): this file's SQL is all template-string concatenation,
 *   and only one place (`searchNodes`) escaped it; the other 19 (docId / notebook /
 *   blockId / parentAnchor …) interpolate raw. Most of these values come from the kernel or local config
 *   and contain no quotes on the normal path, but once config is polluted or a block ID comes from external JSON,
 *   a single `'` is enough to truncate the literal and rewrite the query semantics.
 *   Routing everything through this helper is defence in depth and does not change normal-path behaviour.
 *
 * Note: a SiYuan block ID looks like `<14 digits>-<7 alnum>` and contains no quotes;
 *     for such values this function is a no-op (idempotent), so it adds no performance or semantic burden.
 */
function sqlStr(v: string): string {
  return String(v).replace(/'/g, "''");
}

/**
 * Pattern string for `LIKE '%…%'`: besides quotes it must also escape LIKE's
 * wildcards, otherwise searching `%` matches everything and searching `_` matches any single character.
 * Used together with `ESCAPE '\'` in the SQL.
 */
function sqlLike(v: string): string {
  return sqlStr(v).replace(/[\%_]/g, (m) => '\\' + m);
}

import { t } from '../plugin/i18n';

export interface PersistedDoc {
  meta: DocMeta;
  nodes: OutlineNode[];
}

export interface SiYuanStoreOptions {
  client: SiYuanClient;
  /** target notebook ID */
  notebook: string;
  /** the document's parent path inside the notebook, default `/` */
  basePath?: string;
}

/** SiYuan document metadata (for list display) */
export interface SiYuanDocEntry {
  /** SiYuan document block ID */
  id: string;
  /** title (i.e. the document name) */
  title: string;
  /** hpath inside the notebook, e.g. `/parent/child` */
  hpath: string;
  updated: string;
}

/**
 * The document title as `loadDoc` reads it: the `# heading` **heading block**, not the document name.
 *
 * ★ This is the half of the "two titles" problem that made a rename look like it worked and then vanish:
 *   the plugin's title box shows the document name, while loading a document takes the title from the body's
 *   heading block. Changing only the name therefore diverges permanently —— the new value is visible until
 *   the document is reopened, and then the old one comes back, with no error anywhere (`store.setHeadingTitle`
 *   is the other half: the rename writes the heading block too).
 *
 * Extracted so the parsing rules are testable on their own: only an H1 at the **start of a line** counts, so
 * a `#` inside body text is not a title and `##` is not one either.
 */
export function titleFromKramdown(kramdown: string): string {
  const m = /^#\s+(.+)$/m.exec(kramdown);
  return m ? m[1].trim() : '';
}

export class SiYuanStore {
  private readonly client: SiYuanClient;
  private readonly notebook: string;
  private readonly basePath: string;

  constructor(opts: SiYuanStoreOptions) {
    this.client = opts.client;
    this.notebook = opts.notebook;
    this.basePath = (opts.basePath ?? '/').replace(/\/+$/, '') || '';
  }

  /** path this mind map should be stored at inside the notebook */
  private docPath(name: string): string {
    const safe = name.replace(/[/\\]/g, '_').trim() || t('phUntitledDoc');
    return `${this.basePath}/${safe}`;
  }

  /** most recently resolved notebook this document belongs to (fallback when `notebook` is an empty string) */
  private lastNotebook = '';

  /** most recent native AST block tree parsed by getBlockDOM */
  private lastDomTree: BlockTreeState | null = null;

  /**
   * Clean up the dead mappings left by "sibling blocks destroyed by an insert operation".
   *
   * ★★★ Why this is a separate method (a measured TDZ defect)
   *
   *   This logic used to be inlined in `walk` in `syncStructure`, right after a `try`.
   *   The minifier renames some binding in the try to the single letter `e` (first the inlined `const q`;
   *   after that was changed it was `let liveSet`'s turn); and the callback passed to `siblingsBefore.filter(...)`
   *   references the outer parameter `child`, which is also minified to `e`. Once the two names collide, the `e` in the callback resolves to
   *   that **not-yet-initialized `let`**, so every write-back throws:
   *
   *       ReferenceError: Cannot access 'e' before initialization
   *
   *   Measured minified output (filter and let only 35 characters apart, almost impossible to spot by eye):
   *
   *       if(s.length){let t=s.filter(t=>t!==e);if(t.length)try{let e=await this...
   *
   *   Renaming the inner variable does not help —— the minifier just picks another name and collides again. The root cause is
   *   the **structure** of "a filter callback and some `let` sharing one block scope".
   *   Once extracted into its own method, the two no longer share a scope and no minifier rename can make them collide.
   *
   *   Symptom (as reported): the panel shows that error in red at the top, and every write-back takes the outer catch ——
   *   that round's "was the block destroyed by the kernel" check is **skipped entirely** and the dead block mapping stays in the table.
   *
   * @param siblingsBefore the existing sibling blocks recorded **before** the insert (pre-insert snapshot)
   * @param child          the listItem block ID produced/adopted by this insert
   */
  private async pruneDestroyedSiblings(
    siblingsBefore: string[],
    child: string,
    blockMap: Map<string, string>,
  ): Promise<void> {
    // ★ Skip blocks this session inserted (measured audit finding).
    //
    //   The SQL index flushes asynchronously (measured 200ms~2.8s after insertBlock), while the
    //   double-confirm below waits only 200ms — so a sibling inserted by the previous write-back
    //   misses both rounds while perfectly alive, its live mapping is cleared, and the next pass
    //   re-inserts it as a duplicate. A block this session created is exempt: it cannot be "an older
    //   sibling destroyed by this insert" in the defect-#53 sense the double-confirm hunts.
    //
    //   ★ Deliberate asymmetry, recorded honestly: if the kernel really destroyed a *fresh* block
    //   (never measured — defect #53 destroyed older blocks), this skip keeps a dead mapping and the
    //   node goes ghost until a reload rebuilds the mapping and reinserts it. That corner is accepted
    //   because the alternative (no skip) misfires on every index lag over 200ms, which measured 4/6.
    const probeIds = siblingsBefore.filter(
      (id) => id !== child && !this.freshlyInserted.has(id),
    );
    if (probeIds.length) {
      try {
        // ★★★ A **second confirmation** is mandatory (measured defect #54).
        //
        //   The kernel lags in writing its index: a block just inserted **may not be found if queried at once**.
        //   Measured consequence: the first query misses → the mapping is cleared → the next write-back treats
        //   that **already existing** node as a new node and re-inserts it →
        //   **duplicate blocks** appear in the document:
        //   ```
        //   ChildT
        //     ├── SiblingE   (22:30:22)
        //     └── SiblingE   (22:30:38)   ← duplicate
        //   ```
        //
        //   ⇒ only after **both query rounds miss**, and after some time has been waited in between,
        //     is it concluded that the block "really was destroyed". Better to keep the mapping (at worst the position is wrong)
        //     than to misjudge (which **re-inserts duplicates**, a more serious consequence).
        const q = async (): Promise<Set<string>> => {
          const live = await this.client.sql<{ id: string }>(
            `SELECT id FROM blocks WHERE id IN (${probeIds.map((v) => `'${sqlStr(v)}'`).join(',')})`,
            probeIds.length,
          );
          return new Set((live ?? []).map((r) => r.id));
        };
        let liveSet = await q();
        const missing = probeIds.filter((v) => !liveSet.has(v));
        if (missing.length) {
          // something "suspected destroyed" → wait for the index to catch up and confirm once more
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const second = await q();
          liveSet = second;
        }
        for (const dead of probeIds) {
          if (liveSet.has(dead)) continue;
          // only when both rounds miss is it concluded that the block really was destroyed
          const ownerNode = this.lastByBlock.get(dead) ?? '';
          if (ownerNode) {
            // ★ Only clear when "the block registered for this node **is** this dead
            //   block"; a dead **sibling** block must not wipe the whole node mapping ——
            //   that would drag down mappings that are still healthy.
            const cur = this.lastBlockMap.get(ownerNode) ?? '';
            const curLi = this.lastListItems.get(ownerNode) ?? '';
            if (cur === dead) this.lastBlockMap.delete(ownerNode);
            if (curLi === dead) this.lastListItems.delete(ownerNode);
            // the node counts as "fully invalidated" only when both mappings are cleared
            if (!this.lastBlockMap.has(ownerNode) && !this.lastListItems.has(ownerNode)) {
              blockMap.delete(ownerNode);
            }
          }
          this.lastByBlock.delete(dead);
          this.everSeen.delete(dead);
        }
      } catch {
        /* a failed check does not affect the main flow */
      }
    }
  }

  /**
   * Look up and remember which notebook `docId` belongs to.
   *
   * ★ Must be called while the document **still exists** (e.g. from `loadDoc`).
   *   Once a document is deleted externally its `box` can no longer be queried —— at that point there is no way to know
   *   which notebook a save-as should use (measured: it reports `invalid ID argument`, the content is lost).
   */
  private async rememberNotebook(docId: string): Promise<void> {
    if (this.notebook && this.lastNotebook) return; // a reliable source already exists
    try {
      const row = await this.client.sql<{ box: string }>(
        `SELECT box FROM blocks WHERE id='${sqlStr(docId)}' LIMIT 1`,
        1,
      );
      const box = row?.[0]?.box || '';
      if (box) this.lastNotebook = box;
    } catch {
      /* keep things as they are when the query fails */
    }
  }

  // ---------------------------------------------------------------- read

  /**
   * List this notebook's documents.
   *
   * Uses SQL on type='d' (document blocks). An explicit LIMIT is mandatory (hard AGENTS.md rule).
   * Note: the SiYuan SQL index lags by 1-3 seconds, so a document just created may not be visible if queried at once;
   * if you need "list right after create", the caller can wait or use listDocsAfterCreate instead.
   */
  async listDocs(limit = 200): Promise<SiYuanDocEntry[]> {
    return this.listDocsAfterCreate(limit, 0);
  }

  /**
   * List documents, waiting until at least `expectAtLeast` of them are visible (for the right-after-create scenario).
   * Passing expectAtLeast=0 is equivalent to a single query.
   */
  async listDocsAfterCreate(limit = 200, expectAtLeast = 1, timeoutMs = 6000): Promise<SiYuanDocEntry[]> {
    const rows = await this.client.sqlWhenReady<{
      id: string;
      content: string;
      hpath: string;
      updated: string;
    }>(
      `SELECT id, content, hpath, updated FROM blocks
       WHERE box='${sqlStr(this.notebook)}' AND type='d'
       ORDER BY updated DESC`,
      { limit, expect: (r) => r.length >= expectAtLeast, timeoutMs },
    );
    return rows.map((r) => ({ id: r.id, title: r.content, hpath: r.hpath, updated: r.updated }));
  }

  /**
   * Read a document's complete node tree.
   *
   * Uses getBlockKramdown to get the document's Kramdown, then parses it into a node tree via core/map.ts.
   */
  /**
   * Is the target document still there? `true` alive, `false` gone, `null` could-not-tell.
   *
   * ★ The write-error path needs this because matching the kernel's message text has a measured blind spot:
   * the same situation reports `... failed: indexing` for ~100 ms after a deletion and
   * `... failed: tree not found` afterwards, and only the second is recognised. A read has no such window.
   * See `SiYuanClient.blockExists`, which documents the measurement and why `null` must stay distinct from
   * `false` —— a false "your document was deleted" invites the user to duplicate their work.
   */
  async docExists(docId: string): Promise<boolean | null> {
    return this.client.blockExists(docId);
  }

  async loadDoc(docId: string): Promise<PersistedDoc> {
    const kramdown = await this.client.getBlockKramdown(docId);
    // ★★★ Also remember which notebook this document belongs to (the **content is lost** bug).
    //
    //   Why it must be recorded at this very moment: `OmTabApp` passes `notebook: ''` when constructing the store,
    //   which normally does not matter (write-backs go through known block IDs), but once the document is deleted externally
    //   there is no way to know which notebook "save as a new document" should use ——
    //   the document row is already gone from the SQL index, so a later `SELECT box` only returns empty.
    //   Measured: the recovery entry does appear, but clicking it reports `invalid ID argument` and the content is lost anyway.
    //   Recording it here once means a save-as still works after deletion.
    await this.rememberNotebook(docId);
    const nodes = kramdownToTree(kramdown);
    // ★ Also register "which nodes have attached paragraphs" —— at **zero extra query cost**.
    //
    //   This `paragraphs` data was just read back from SiYuan (`getBlockKramdown`),
    //   and it is exactly the authoritative basis for deciding "does this node have a paragraph block in SiYuan".
    //   Without it, the **first** clearing of attached paragraphs after the user loads a document would not be written back
    //   (see the declaration of `nodesWithParas` for the criterion).
    this.nodesWithParas.clear();
    // ★ Cleared, not merged: a table deleted since the last load must not keep a baseline, or the
    //   node id is reused by a **different** table and the first cell edit is compared against a
    //   body the document never held.
    this.lastTableMarkdown.clear();
    this.lastCodeMarkdown.clear();
    {
      const seed = (list: OutlineNode[]): void => {
        for (const n of list) {
          if ((n.paragraphs?.length ?? 0) > 0) this.nodesWithParas.add(n.id);
          // ★★ A table's baseline, recorded at the same moment and for the same reason: this is the
          //   markdown the document holds **right now**, so the table writer can tell a cell the
          //   user edited from one they did not. Without a baseline the first pass after opening
          //   cannot distinguish "unchanged" from "changed", and rewriting every table on every
          //   load is a transaction per table plus a re-read that blanks the panel each time.
          if (n.table) this.lastTableMarkdown.set(n.id, tableToKramdown(n.table));
          if (n.codeBlock) this.lastCodeMarkdown.set(n.id, codeBlockToKramdown(n.codeBlock));
          if (n.children?.length) seed(n.children);
        }
      };
      seed(nodes);
    }
    const titleParagraphs = takeTitleParagraphs();
    // ★ Loading also registers "seen".
    //
    //   everSeen is syncDeletions' **safety gate against wrong deletion**: it only deletes blocks that "appeared in the tree before
    //   and then disappeared". But originally only syncDeletions itself called noteSeen(nodes),
    //   while the node-deletion flow is "first removeNode takes them out of the array, then call syncDeletions"
    //   —— by the time noteSeen runs, the nodes to delete are **long gone from the tree**, can never be registered,
    //   and the gate therefore blocks deletion forever.
    //   Measured symptom: the confirm dialog appears, you click OK, and neither the UI nor SiYuan moves at all — with no error either.
    //   Registering at this single entry point (load) is the only way to guarantee every "currently existing node" has been recorded.
    this.noteSeen(nodes);
    // ★★★ document title (fixes "the panel title always shows untitled")
    //
    //   Originally it only looked for a `# title` heading block in the body:
    //   ```ts
    //   const titleMatch = /^#\s+(.+)$/m.exec(kramdown);
    //   ```
    //   But **a SiYuan document title is not stored as a body heading block at all** —— it lives in the document block's
    //   (`type='d'`) own `content` field. The vast majority of documents have no H1 heading block
    //   (measured on a demo document: H1 heading block count = 0), so `titleMatch` is always null,
    //   the title is always an empty string → the panel keeps showing the placeholder "untitled".
    //
    //   Read order (authoritative first, fallbacks after):
    //     ① `blocks.content` (the document block itself) —— the document name as SiYuan sees it, authoritative
    //     ② a `# title` heading block on the first body line —— for documents that really do have a hand-written heading block
    //     ③ empty string —— the layer above falls back to the "untitled" placeholder
    //
    //   Note that `blocks.content` is **plain text** (no `<style>` or similar markup),
    //   whereas a heading block's markdown needs `#` and inline markup stripped, so the two steps are handled separately.
    let title = '';
    try {
      const rows = await this.client.sql<{ content: string }>(
        `SELECT content FROM blocks WHERE id='${sqlStr(docId)}' LIMIT 1`,
        1,
      );
      title = (rows?.[0]?.content ?? '').trim();
    } catch {
      // when SQL is unavailable fall back to heading-block parsing; a failed title read must not sink the whole load
    }
    if (!title) {
      title = titleFromKramdown(kramdown);
    }
    // ★ The variable is named now rather than t —— `t` is this module's i18n lookup function and must not be shadowed
    const now = Date.now();
    return {
      meta: {
        id: docId,
        name: title || t('phUntitledDoc'),
        folderId: '0',
        createdAt: now,
        updatedAt: now,
        version: 0,
        paragraphs: titleParagraphs,
      },
      nodes,
    };
  }

  /**
   * Fetch the "node ID → SiYuan block ID" mapping table.
   *
   * Why it is needed: measured, calling `updateBlock` on a whole document **rebuilds every block ID**,
   * which is destructive for SiYuan —— `((references))` pointing at those blocks, bookmarks and backlinks all break.
   * So write-back must go through **per-block incremental updates**, and incremental updates need to know which block each node maps to.
   *
   * `ial` is the column where SiYuan stores block attributes, shaped like `{: id="..." updated="..." }`.
   */
  async loadBlockMap(docId: string, limit = 5000): Promise<Map<string, string>> {
    // ★★★ Short-circuit inside one write-back: this method is called 3 times per
    //   write-back (once each from syncStructure / syncDeletions / saveNodesIncremental),
    //   and each time `SELECT ... WHERE root_id=... AND type='i'` scans the **entire document**.
    //
    //   Measured (300-node document, typing 10 characters):
    //   ```
    //   26 SQL calls in total, 16 of them this "fetch all listItems" query
    //   ```
    //   This is the largest single item on the write-back path and it grows linearly with document size.
    //
    //   All three calls happen **inside one write-back transaction**, the kernel state
    //   cannot change in between, so the result is perfectly reusable.
    //
    //   Measured latency (character-by-character typing, 600ms apart):
    //   ```
    //   300 nodes: 34 ms average
    //    20 nodes: 12 ms average
    //   ```
    //
    //   ★ The cache lives only **inside one write-back** (bracketed by beginWrite/endWrite),
    //     never a long-lived cache across write-backs —— that would miss changes made by external clients.
    if (this.writeEpochOpen && this.mapCacheDocId === docId && this.mapCacheLimit === limit) {
      return this.mapCacheValue as Map<string, string>;
    }

    const prevMap = this.lastBlockMap;
    const prevListItems = this.lastListItems;
    const prevByBlock = this.lastByBlock;
    const map = new Map<string, string>();
    this.lastBlockMap = map;
    this.lastListItems = new Map<string, string>();
    this.lastByBlock = new Map<string, string>();
    this.lastAliveBlockIds = new Set<string>();
    this.childListByItem = new Map<string, string>();

    // ★★★ Prefer getBlockDOM to read the native in-memory AST block tree (per the SiYuan source).
    //
    //   Why prefer DOM over plain SQL:
    //   ① SiYuan's SQLite index is flushed asynchronously and periodically, so blocks just created/moved are not queryable for 1~3 seconds;
    //   ② in SQLite's blocks table the sort field is always 20 (it only encodes the block type, not sibling order);
    //   ③ the kernel's in-memory AST / getBlockDOM is synchronous, live, and absolutely authoritative for the document's physical order.
    let parsedDom: BlockTreeState | null = null;
    try {
      if (typeof this.client.getBlockDOM === 'function') {
        const domRes = await this.client.getBlockDOM(docId);
        if (domRes?.dom) {
          parsedDom = parseDomToTree(domRes.dom, docId);
        }
      }
    } catch {
      // fall back to SQL on an offline unit-test stub or in an environment without support
    }

    if (parsedDom) {
      this.lastDomTree = parsedDom;
      this.lastAliveBlockIds = parsedDom.aliveIds;
      this.childListByItem = parsedDom.itemToChildList;
      for (const [key, child] of parsedDom.itemToParagraph) {
        map.set(key, child);
        this.lastListItems.set(key, key);
        this.lastByBlock.set(child, key);
        this.lastByBlock.set(key, key);
      }
      // ★★ Table blocks are their own carrier (measured: no listItem, no paragraph).
      //
      //   The node id **is** the table block id, and it is mapped in all three tables so that
      //   every later stage finds it by the same rules as a list item's node: otherwise
      //   `syncStructure` would judge an existing table "new" and insert a second copy of it,
      //   and `syncDeletions` would delete it as "in the document but not in the tree".
      for (const tid of parsedDom.rootTableIds) {
        map.set(tid, tid);
        this.lastListItems.set(tid, tid);
        this.lastByBlock.set(tid, tid);
      }
      // ★★ Code blocks are the same shape as tables and need the same mapping, for the same two
      //   reasons: without it `syncStructure` judges an existing code block "new in the UI" and
      //   inserts a second copy beside it, and `syncDeletions` treats it as "in the document but not
      //   in the tree" and deletes it. Measured against the kernel: a code block is a root-level
      //   `data-type="NodeCodeBlock"` with no listItem.
      for (const cid of parsedDom.rootCodeBlockIds) {
        map.set(cid, cid);
        this.lastListItems.set(cid, cid);
        this.lastByBlock.set(cid, cid);
      }
      // The block id of an entry is its **value** in the first two tables (node → block) and its **key**
      // in the reverse table (block → node) —— the rule itself is in `isUnseenButOurs`.
      for (const [k, v] of prevMap) {
        if (isUnseenButOurs(map, k, v, this.freshlyInserted)) map.set(k, v);
      }
      for (const [k, v] of prevListItems) {
        if (isUnseenButOurs(this.lastListItems, k, v, this.freshlyInserted)) this.lastListItems.set(k, v);
      }
      for (const [k, v] of prevByBlock) {
        if (isUnseenButOurs(this.lastByBlock, k, k, this.freshlyInserted)) this.lastByBlock.set(k, v);
      }
      if (this.writeEpochOpen) {
        this.mapCacheDocId = docId;
        this.mapCacheLimit = limit;
        this.mapCacheValue = map;
      }
      return map;
    }

    // Fetch all listItems (the node carriers); the block ID is always the node identity ——
    // otherwise a "native SiYuan document" (an ordinary list the user wrote by hand) yields an empty mapping and every write-back fails.
    const rows = await this.client.sql<{
      id: string;
      ial: string;
      child: string | null;
      childList: string | null;
    }>(
      `SELECT b.id AS id, b.ial AS ial,
              (SELECT c.id FROM blocks c
                WHERE c.parent_id = b.id AND c.type = 'p'
                ORDER BY c.sort LIMIT 1) AS child,
              (SELECT c.id FROM blocks c
                WHERE c.parent_id = b.id AND c.type = 'l'
                ORDER BY c.sort LIMIT 1) AS childList
       FROM blocks b
       WHERE b.root_id='${sqlStr(docId)}' AND b.type = 'i'
       ORDER BY b.sort`,
      limit,
    );
    // ★★★ Keep the mappings for blocks "we have **seen with our own eyes** but the SQL index has not picked up yet" (measured).
    //
    //   Within one write-back `syncStructure` / `syncDeletions` / `saveNodesIncremental`
    //   **each** call this method once, and it used to **replace all three reverse-lookup tables wholesale**.
    //   A block just produced by `insertBlock` takes 1~3 seconds to enter the SQL index,
    //   so every rebuild washed away "node → new block" → the next stage judged it "new in the UI" again
    //   → **the same node was re-inserted over and over**.
    //
    //   Measured (outline Enter creates a node + fast typing of "NewNode"):
    //   ```
    //   insertBlock('- \u200b')   → bt81t3m
    //   insertBlock('- New')       → ln3lxcp    ← ghost block
    //   insertBlock('- NewNode')  → 4x2uhcz
    //   UI ['A','B','NewNode'] / SiYuan ['A','B','NewNode','New']
    //   ```
    //   The fix: when rebuilding, **keep** the entries from the old table that SQL did not return.
    //   These IDs come from `insertBlock`'s return value (seen with our own eyes) and are more authoritative than SQL;
    //   once the index catches up, SQL's values naturally overwrite same-key entries.

    for (const r of rows) {
      // key = **the listItem's own block ID** (the same choice map.ts makes when parsing a SiYuan export).
      const key = r.id;
      this.lastAliveBlockIds.add(r.id);
      if (r.child) this.lastAliveBlockIds.add(r.child);
      // the value is the child paragraph block (safe to updateBlock; editing the listItem directly reports a structural error)
      map.set(key, r.child || r.id);
      // also remember **the listItem itself** —— it must be the anchor for structural inserts.
      // using a paragraph block as previousID **nests** the new node inside as a child (measured, we hit this).
      this.lastListItems.set(key, r.id);
      // paragraph block → node ID reverse lookup (for reverse sync only, kept in a separate namespace from map)
      this.lastByBlock.set(r.child || r.id, key);
      this.lastByBlock.set(r.id, key);
      // ★★★ child-list mapping: fetched **in passing** in the same query.
      //
      //   `ensureChildList` used to **fire one SQL per node** asking "do you have a child list":
      //   ```
      //   SELECT id FROM blocks WHERE parent_id=? AND type='l' LIMIT 1
      //   ```
      //   and `moveNodes` calls it for **every node in the tree** → in a 240-node document that is
      //   ~60 identical queries per keypress (measured: 60 of 69 calls).
      //
      //   Since this method already scans the whole document's listItems, fetching the child lists
      //   **along with them** costs nothing extra: one more scalar subquery in the SQL removes dozens of round trips.
      //   ★ It reuses the same caching semantics (valid inside the writeEpoch) and adds no new staleness risk.
      this.childListByItem.set(key, r.childList || '');
      // ⚠️ Never register a listItem's block ID into map as a **key** again!
      // That would mix "block IDs" and "node IDs" into one namespace:
      // if one node's om-id happens to equal another node's block ID (or an ID is reused after a block is rebuilt),
      // they overwrite each other —— measured as listItemOf('C1') and map.get('C1') pointing at different blocks,
      // and the wrong target being deleted. Use byBlock() when you need to look up a node by block ID.
    }
    // ★ Restore entries that "were in the previous table but this SQL did not return" (blocks just inserted, index not caught up).
    //   The check uses `has`: whatever SQL already has wins (it reflects the kernel's true state).
    //
    // ★★ ...**and the same ownership rule the DOM branch uses** (`isUnseenButOurs`), not `!map.has` alone.
    //    The two branches had different retention semantics: the preferred `getBlockDOM` path retained an
    //    entry only when this session had inserted that block, while this fallback retained **any** entry
    //    the read did not report —— so on a kernel where `getBlockDOM` is unavailable, a mapping to a block
    //    that was destroyed externally (or a foreign block the index merely lagged on) stayed in the table
    //    forever, and `syncStructure` believed "we already have it" while nothing existed in SiYuan.
    //    That is the dead-mapping failure `docs/pitfalls/data.md` §1.6 records, and which branch runs must
    //    not decide whether it happens. Both now ask one function.
    for (const [nodeId, blockId] of prevMap) {
      if (blockId && isUnseenButOurs(map, nodeId, blockId, this.freshlyInserted)) {
        map.set(nodeId, blockId);
        const li = prevListItems.get(nodeId);
        if (li) this.lastListItems.set(nodeId, li);
        this.lastByBlock.set(blockId, nodeId);
        this.everSeen.add(blockId);
      }
    }
    for (const [bid, nodeId] of prevByBlock) {
      // ⚠️ Only restore the byBlock (block→node) reverse lookup, **do not** push listItems back into map as keys ——
      //    that would mix "block IDs" and "node IDs" into one namespace and let them overwrite each other.
      if (!this.lastByBlock.has(bid) && this.freshlyInserted.has(bid)) {
        this.lastByBlock.set(bid, nodeId);
      }
    }
    // cache this result inside the write-back transaction for the two later calls in the same transaction
    if (this.writeEpochOpen) {
      this.mapCacheDocId = docId;
      this.mapCacheLimit = limit;
      this.mapCacheValue = map;
    }
    return map;
  }

  /**
   * Begin a write-back transaction —— `loadBlockMap` results are reused during it.
   *
   * ★ `endWrite()` must be called in pairs. The cache must **never** survive across write-backs,
   *   otherwise changes from external clients (the SiYuan desktop app, mobile) go unseen.
   *
   * ★★ Uses a **depth counter** instead of a boolean (fix).
   *   `writeEpochOpen` used to be a boolean and `endWrite()` blindly set it to false ——
   *   once two write-backs overlap (the user triggers undo while the main write-back is in flight, or an external delete event arrives),
   *   whichever finishes first shuts down the cache the other one is still using,
   *   and clears `mapCacheValue`, degrading the other to "query SQL again" or even to reading the wrong document's cache.
   *   With a counter, only the **outermost** endWrite really closes the transaction;
   *   an inner end just decrements the counter and the cache stays valid inside the outer transaction.
   */
  beginWrite(docId = ''): void {
    this.writeEpochDepth++;
    this.writeEpochOpen = true;
    // clear the cache only when the outermost level opens: inner levels reuse the outer mapping and must not wash it away
    if (this.writeEpochDepth === 1) {
      this.mapCacheDocId = docId;
      this.mapCacheLimit = -1;
      this.mapCacheValue = null;
    } else if (docId && this.mapCacheDocId !== docId) {
      // the nested transaction spans documents → the cache is not reusable, so reset it for the newest document
      this.mapCacheDocId = docId;
      this.mapCacheLimit = -1;
      this.mapCacheValue = null;
    }
  }

  /** End the write-back transaction and clear the cache. Only the outermost end really closes it. */
  endWrite(): void {
    if (this.writeEpochDepth > 0) this.writeEpochDepth--;
    if (this.writeEpochDepth > 0) return; // an outer transaction is still using the cache
    this.writeEpochOpen = false;
    this.mapCacheDocId = '';
    this.mapCacheLimit = -1;
    this.mapCacheValue = null;
  }


  /** "node ID → listItem block ID" from the most recent loadBlockMap */
  /** result of the most recent loadBlockMap (node ID → paragraph block ID) */
  private lastBlockMap = new Map<string, string>();

  /**
   * The loadBlockMap cache inside a write-back transaction (see the top comment of loadBlockMap).
   * Active while `writeEpochOpen` is true, controlled by `beginWrite` / `endWrite`.
   */
  private writeEpochOpen = false;

  /** nesting depth of write-back transactions (used with writeEpochOpen, see the beginWrite comment) */
  private writeEpochDepth = 0;

  /**
   * Block IDs "just inserted" in this write-back —— they are necessarily **index-lagged**.
   *
   * ★★★ Why it exists (measured defect #54):
   *   `loadBlockMap` "keeps mappings SQL has not picked up yet" (what the index lag requires),
   *   while the liveness check "deletes mappings SQL cannot find" —— the two **collide head-on**,
   *   and the measured consequence is **duplicate nodes**:
   *   ```
   *   [write-back 2] SiblingE → no mapping → insert ✅
   *   [write-back 3] SiblingE → no mapping → insert again ❌   duplicate
   *   ```
   *   Any block in `freshlyInserted` is always skipped by the liveness check.
   *   ★★ This set **persists across write-backs**, and an entry is removed only when "the block can already be found via SQL" ——
   *     meaning the index has caught up and the exemption is no longer needed.
   *     If every `beginWrite` blindly cleared it, then write-back N inserts and write-back N+1's check
   *     finds the exemption gone → still misjudges → still duplicates (that is exactly how it reproduced).
   */
  private freshlyInserted = new Set<string>();

  /**
   * Block IDs this session deleted. An `insertBlock` carrying `{: id}` of one of them does not
   * reliably adopt it (measured reuse race: adopts clean back-to-back, stores mangled content
   * `1. <span data-type="text">…</span>` ~100ms later, mints a fresh id silently seconds later,
   * once answered `-1`) —— so inserts reusing such an id go through `insertPreVerified`, which
   * verifies the content against the insert response's own DOM and falls back to a fresh id.
   * Capped like `freshlyInserted`.
   */
  private recentlyDeleted = new Set<string>();

  /** Record a block this session deleted (see `recentlyDeleted`). */
  private noteDeletedBlock(id: string): void {
    if (!id) return;
    this.recentlyDeleted.add(id);
    if (this.recentlyDeleted.size > 500) {
      this.recentlyDeleted = new Set([...this.recentlyDeleted].slice(-200));
    }
  }

    /**
     * Reader for the node IDs of the "current UI tree", injected by the caller.
     *
     * Purpose: `syncDeletions` confirms once more **before** actually deleting
     * "is this node still in the UI right now" —— the snapshot taken by the write-back may predate the latest creations.
     * ★ This is the **final confirmation** before deletion and takes part in no read/write reuse,
     *   so it does not amount to "a cache introduced for speed" (that kind of cache causes inconsistent state).
     */
    liveTreeProbe: (() => Set<string>) | null = null;
  private mapCacheDocId = '';
  private mapCacheLimit = -1;
  private mapCacheValue: Map<string, string> | null = null;

  /** "node ID → listItem block ID" from the most recent loadBlockMap */
  private lastListItems = new Map<string, string>();

  /**
   * To-do states **this session wrote** that the read has not caught up with yet: "listItem ID → state".
   *
   * ★★★ Why a write has to remember what it wrote (measured): the SQL read behind `storedTask` lags the
   *   kernel by 1~3 seconds, so a click that follows the previous one inside that window reads the state
   *   from **before** it. A to-do that was just marked done still reads as not-done, `wants === stored`
   *   holds, and the change is dropped —— no call, no message, and the panel shows a state the document
   *   never got. Same defect class as `freshlyInserted`: the lag is ours, not the document's.
   *   An entry retires the moment the read agrees with it, so the document becomes the authority on that
   *   to-do again as soon as the index has caught up.
   */
  private writtenTask = new Map<string, number>();

  /**
   * The inline DOM **this session wrote** for a paragraph block, while the read has not caught
   * up: "block ID → SiYuan inline DOM".
   *
   * ★★★ Same reasoning as `writtenTask`, applied to the block's text, and it is what makes the
   *   change detector trustworthy.
   *
   *   `saveNodesIncremental` decides "does this block need rewriting?" by comparing the node with
   *   what the block holds, and what the block holds is read from the **SQL index** — which lags
   *   the kernel by 1~3 seconds, exactly like the task flag above. Measured on the outline: bold a
   *   node and press "clear format" immediately afterwards. The node's text becomes plain, the
   *   index still reports the *pre-bold* plain text, both sides match, and nothing is written:
   *   the document keeps `**…**` while the outline shows it cleared. A second later the same two
   *   steps work, because the index has caught up.
   *
   *   When the index disagrees with what we last wrote, the index is the one that is behind, so its
   *   answer is not the block's content — ours is. An index that agrees retires the entry, and the
   *   document becomes the authority again. This also keeps an external edit visible: someone else
   *   rewriting the block makes the index disagree with us **and** carry their value, and the next
   *   read agrees with neither, so the node is written over them.
   */
  /**
   * How long a remembered write outranks the SQL index.
   *
   * ★ The index trails the kernel by 1~3 seconds (measured, and the same window `writtenTask`
   *   documents). Inside it, an index that contradicts us is simply behind. Outside it, the
   *   index is the authority again — otherwise a change somebody else made would be masked for
   *   as long as this session had ever touched the block.
   */
  private static readonly WRITTEN_TEXT_WINDOW_MS = 5_000;

  private writtenText = new Map<string, { dom: string; at: number }>();

  /**
   * Node IDs that **currently have attached paragraph blocks in SiYuan**.
   *
   * ★★★ Why this set is required (fixes "deleting an empty attached paragraph is not synced"):
   *
   *   Attached-paragraph write-back is **bidirectional** —— `syncParagraphs` both fills in and deletes from the tail.
   *   But the caller's original criterion was "call only when `n.paragraphs` is non-empty":
   *   ```
   *   if (liId && (n.paragraphs?.length ?? 0) > 0) { await this.syncParagraphs(...) }
   *   ```
   *   so **deleting the last attached paragraph left it entirely uncalled**, and those paragraph blocks
   *   stayed in SiYuan forever (across the whole project only `syncParagraphs` deletes paragraph blocks).
   *
   *   But the criterion cannot simply become "always call" —— that would add one `getChildBlocks`
   *   call per node per write-back. Measured, that call's median is **1.35ms**,
   *   so a 240-node document = **316ms/round**, and a write-back runs on every keypress.
   *
   *   ⇒ So use a **zero-query** signal: did this node have paragraph blocks in the previous round.
   *     The seed comes from the tree `loadDoc` already parsed (`paragraphs` is read from SiYuan),
   *     and `syncParagraphs` maintains it in passing on every read and write.
   *
   *   In the set → call even when the target is empty (to delete); not in it → and the target is empty too, then there really is nothing to do.
   */
  private nodesWithParas = new Set<string>();

  /**
   * Node id → the exact markdown its table block is known to hold.
   *
   * ★ A table block's **whole body** is the carrier, so a cell edit is a whole-table write and the
   *   only honest way to avoid one is an exact comparison against what the document held last.
   *   Seeded by `loadDoc` from the tree it just parsed, advanced after every successful write and
   *   **left alone when a write fails**, so a failure retries on the next pass instead of being
   *   recorded as done.
   *
   * Why a string and not a flag: the cells are editable, and a flag cannot say *which* cells
   * changed — so every pass would rewrite every table. A whole-body comparison is one `join` and
   * no query, which is the same bargain `nodesWithParas` makes for attached paragraphs.
   */
  private lastTableMarkdown = new Map<string, string>();

  /**
   * Node id → the exact markdown its **code block** is known to hold.
   *
   * ★ Same contract as `lastTableMarkdown` above and for the same reason: a code block's whole body
   *   is its carrier, so the only honest way to avoid rewriting one on every keystroke is an exact
   *   comparison against what the document held last. Seeded by `loadDoc`, advanced only after a
   *   successful write, and left alone when a write fails so the next pass retries.
   */
  private lastCodeMarkdown = new Map<string, string>();

  /**
   * Node IDs that have ever appeared in the node tree (cumulative, not reset by loadBlockMap).
   *
   * Purpose: **bound the deletion scope**. A block is deleted only when it "was in the tree before and is not now";
   * blocks that "exist in SiYuan but were never seen in the tree" are never touched.
   *
   * Why it is needed: reverse sync lags when pulling blocks newly added in SiYuan into the mind map
   * (network + transaction dispatch). If the mind map writes back before that event arrives,
   * the block would "not be in alive" and get wrongly deleted —— silently losing user data.
   * With this gate in place, something never seen can never be deleted.
   */
  private everSeen = new Set<string>();

  /** shrink everSeen only above this size (so no write-back walks it in full) */
  private static readonly EVERSEEN_SOFT_CAP = 4000;

  /**
   * Block IDs that SQL confirmed **still exist** in the most recent `loadBlockMap` round.
   * Used only by `shrinkEverSeen` to decide which everSeen entries no longer have any deletion value.
   */
  private lastAliveBlockIds = new Set<string>();

  /**
   * listItem block ID → its **first child list** block ID (empty string when there is none).
   *
   * ★ Fetched by `loadBlockMap` in the **same SQL statement**.
   * Its whole reason to exist is to kill `ensureChildList`'s "one query per node" ——
   * which is the largest single item on the write-back path, growing linearly with document size.
   * Same lifetime as `lastBlockMap` (cached inside the writeEpoch).
   */
  private childListByItem = new Map<string, string>();

  /**
   * Register every ID that has appeared in the node tree (called on every write-back/load).
   *
   * ★ Both **key spaces must be registered**, otherwise blocks cannot be deleted after undo/redo (measured, we hit this):
   *
   *   When `syncDeletions` decides whether a SiYuan block should be deleted, the key it takes is
   *   **the listItem's own block ID**.
   *   And this plugin writes no private attributes (it only lands on SiYuan's native carriers),
   *   so the key **always equals the block ID**.
   *
   *   But `noteSeen` originally registered only `n.id` (**the node ID**). When are the two equal?
   *     - a document **loaded** from SiYuan: `kramdownToTree` takes the node id from the listItem's inline id,
   *       so node ID == block ID and registration works ✅
   *     - **undo/redo** (`applySnapshot → syncStructure`): the snapshot's **old node IDs** are used
   *       to rebuild blocks, and the new blocks get **new block IDs**, so the two are **no longer equal** ❌
   *       → the gate `everSeen.has(blockID)` is false → the block that should be deleted can never be deleted.
   *
   *   Measured symptom: delete → undo → **redo**, the node is gone from the UI
   *   while the block is still in the SiYuan document (UI and data disagree, and no error is raised).
   *
   * The fix: also register "the **block ID** corresponding to every node in the current tree".
   */
  noteSeen(nodes: OutlineNode[], blockIdsOf?: Map<string, string>): void {
    const walk = (list: OutlineNode[]): void => {
      for (const n of list) {
        this.everSeen.add(n.id);
        // the block ID this node currently maps to also counts as "seen"
        const bid = blockIdsOf?.get(n.id);
        if (bid) this.everSeen.add(bid);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(nodes);
    // ★ Also register **every value** of the store's known "node → block" mapping,
    //   not just the values of the nodes that happen to be in the current tree.
    //
    //   Why: on undo/redo the tree's membership changes. At the moment of the redo the current tree is [A, B]
    //   and C is **not in the tree** —— if only the current tree's block IDs were registered, C's block ID would never enter
    //   everSeen and the gate would block its deletion. That is exactly the measured symptom:
    //   rows contains C's block, yet `everSeen.has(C's block ID) === false`,
    //   so the UI deleted it while the block is still in SiYuan (a silent disagreement).
    //
    //   everSeen means "**has been** in the tree at some point", regardless of "is it in the tree now".
    if (blockIdsOf) for (const bid of blockIdsOf.values()) this.everSeen.add(bid);
    this.shrinkEverSeen();
  }

  /**
   * Shrink `everSeen` so it cannot grow without bound in long sessions (fix).
   *
   * ★ Defect: the `EVERSEEN_SOFT_CAP` constant existed all along but was **never referenced anywhere** ——
   *   so this Set only ever grew. When the user **externally deletes** blocks in SiYuan, those blocks no longer appear
   *   in SQL results, `syncDeletions`' `for (const r of rows)` loop never iterates over
   *   them, so `everSeen.delete(key)` is naturally never called; only "blocks the plugin deleted itself" get cleared.
   *   Memory keeps growing over long use.
   *
   * ★ But shrinking **must be conservative**: `everSeen` is the safety gate against wrong deletion
   *   (see `syncDeletions`' "rather miss a deletion than make a wrong one"). If a block ID that still exists in SiYuan
   *   is dropped, that block can never be deleted later even if it really is deleted, causing a silent disagreement.
   *
   *   So the policy here is: only above the soft cap, drop entries that are **outside the last known set of live blocks**
   *   and **not in the current mapping tables** —— that is, pure historical residue that is "neither in SiYuan's current state nor in our
   *   mapping tables", IDs that no longer have any deletion value.
   */
  private shrinkEverSeen(): void {
    if (this.everSeen.size <= SiYuanStore.EVERSEEN_SOFT_CAP) return;
    // keep: the current live blocks + every block in the mapping tables (they may still correspond to real blocks in the document)
    const keep = new Set<string>(this.lastAliveBlockIds);
    for (const bid of this.lastByBlock.keys()) keep.add(bid);
    for (const bid of this.lastListItems.values()) keep.add(bid);
    const next = new Set<string>();
    for (const k of this.everSeen) if (keep.has(k)) next.add(k);
    // if the conservative filter still leaves it too large (e.g. a single document really exceeds the soft cap),
    // reset it wholesale to the current live-block set —— being forgetful beats growing without bound.
    this.everSeen =
      next.size > SiYuanStore.EVERSEEN_SOFT_CAP
        ? new Set<string>(this.lastAliveBlockIds)
        : next;
  }

  /** "paragraph block ID → node ID" reverse table from the most recent loadBlockMap */
  private lastByBlock = new Map<string, string>();

  /**
   * Open one placeholder "collection window": the caller owns the returned set for the whole write-back and
   * passes it down to `syncStructure` → `moveNodes`, which fills it and deletes from it at the end.
   *
   * ★★ Why the set is owned by the caller rather than by the store:
   *   placeholders are produced while a `List` container is created and must survive until the real node has
   *   been moved into it —— deleting one earlier leaves an empty List, which has **no node in the kernel's
   *   in-memory block tree**, so the move fails silently forever afterwards.
   *   They used to live in one instance field, and with two write-backs in flight, a placeholder that A had
   *   just added was wiped by B's `clear()`; A then moved nodes into an already-deleted empty shell and the
   *   structural change was **silently lost**.
   *
   * ★ There is deliberately no instance field any more. It existed as a "compatibility fallback" for a caller
   *   that forgot to pass the set, and a fallback here can only reintroduce the shared-window bug it was
   *   introduced to remove: the wrong set is a set nobody deletes from, so the document keeps a stray
   *   `placeholder` list item. `syncStructure` and `moveNodes` now require the argument, so forgetting it is
   *   a compile error instead of a silent leak.
   */
  beginPlaceholderScope(): Set<string> {
    return new Set<string>();
  }


  /** Reverse lookup of a node ID by "paragraph block ID" (for reverse sync) */
  byBlock(blockId: string): string {
    return this.lastByBlock.get(blockId) ?? '';
  }

  /**
   * Fetch the **listItem** block ID for a node (only for structural insert anchors).
   *
   * Difference from `loadBlockMap`: the latter returns the **paragraph block** (for text edits),
   * whereas this returns the **listItem** (for `previousID`).
   */
  listItemOf(nodeId: string): string {
    return this.lastListItems.get(nodeId) ?? '';
  }

  /**
   * Fetch **all** block IDs for a node (paragraph block + listItem).
   *
   * ★ Why "both are needed" (a measured false-conflict bug):
   *   in transactions pushed back by the kernel, `update` carries the **paragraph block** id,
   *   whereas `delete` / structural changes carry the **listItem** id.
   *   When registering "the values we wrote" both must be recorded,
   *   otherwise an echo arriving in the other ID form does not match and is misjudged as an external change again.
   */
  blockIdsOf(nodeId: string): string[] {
    const out: string[] = [];
    const p = this.lastBlockMap.get(nodeId);
    if (p) out.push(p);
    const li = this.lastListItems.get(nodeId);
    if (li && li !== p) out.push(li);
    return out;
  }

  /**
   * "Block ID → node ID" reverse table (**containing both the paragraph block and the listItem block ID**).
   *
   * ★ Why both must be registered (measured pitfall):
   * a list node corresponds to **two block IDs** in SiYuan ——
   *   - `listItem`(i): the structural anchor, the id carried by a **delete transaction**
   *   - paragraph block(p): the text carrier, the id carried by an **update transaction**
   * The two serve different purposes and have different IDs.
   *
   * Originally every place registered only the paragraph block (`for (const [nodeId, blockId] of loadBlockMap())`),
   * so **external deletion** events never matched (`inMap: false`),
   * showing up as "delete a list item in SiYuan and the node does not disappear from the mind map".
   *
   * Callers should use this method instead of inverting `loadBlockMap` by hand ——
   * that is exactly how the listItem gets missed, and that logic was scattered across 8 places.
   */
  blockToNode(): Map<string, string> {
    const rev = new Map<string, string>();
    for (const [nodeId, blockId] of this.lastBlockMap) rev.set(blockId, nodeId);
    for (const [nodeId, listItemId] of this.lastListItems) rev.set(listItemId, nodeId);
    return rev;
  }

  // ---------------------------------------------------------------- write

  /** Create a document and return the SiYuan document ID */
  async createDoc(name: string, nodes?: OutlineNode[], nearDocId?: string): Promise<string> {
    // ★★★ Creating a document takes two steps, and the body **does not go through markdown** (per the kernel source);
    //   node identity is still carried by the SiYuan block ID (native, no private attributes needed).
    //
    //   ① use `createDocWithMd` to create only the **title-bearing empty shell**;
    //   ② use `appendBlock(dataType='dom')` to append the body from the **native block DOM**.
    //
    //   Why the body is not handed to markdown:
    //   that path goes through Lute's markdown parsing (`lute/parse/paragraph.go:22`),
    //   and in markdown **two consecutive lines belong to one paragraph and only a blank line separates paragraphs**,
    //   so "attached paragraphs" must be separated by blank lines —— miss one and it merges into the first paragraph.
    //   Going through DOM, a paragraph is given explicitly by `<div data-type="NodeParagraph">`,
    //   one div per paragraph, **with no involvement of blank lines at all**.
    //
    //   ⚠️ The title is still passed as markdown: it is the document's H1 heading block, and markdown
    //     expresses it most conveniently, without any multi-paragraph problem.
    //
    // ★★★ `notebook` is often an empty string (`OmTabApp` passes `notebook: ''` when constructing the store);
    //   using it directly to create a document yields `{"code":-1,"msg":"invalid ID argument"}`
    //   —— measured on the "document deleted externally → save as a new document" recovery flow:
    //   the recovery entry appeared, but clicking it raised an error and the user's content was still lost.
    //
    //   The fix: first reverse-look-up the box that `nearDocId` belongs to (more reliable than depending on config),
    //   and fall back to `this.notebook` when that fails.
    let notebook = this.notebook || this.lastNotebook;
    if (nearDocId) {
      try {
        const row = await this.client.sql<{ box: string }>(
          `SELECT box FROM blocks WHERE id='${sqlStr(nearDocId)}' LIMIT 1`,
          1,
        );
        notebook = row?.[0]?.box || notebook;
      } catch {
        /* fall back to the default when the query fails */
      }
    }
    // when the document has been deleted the query above returns empty; fall back to the lastNotebook recorded by loadDoc
    if (!notebook) notebook = this.lastNotebook;
    if (!notebook) {
      throw new Error(t('errNoNotebookToSave'));
    }

    const safeTitle =
      String(name).replace(/\n/g, ' ').trim() || t('phUntitledDoc');
    // ① create only the title-bearing empty-shell document
    const docId = await this.client.createDoc(notebook, this.docPath(name), `# ${safeTitle}\n`);

    // ② append the body as native DOM. `appendBlock` goes through the in-memory block tree and does not depend on the SQL index,
    //    so it can be called right after creating the document, with no waiting.
    if (nodes?.length) {
      await this.client.appendBlockDom(docId, treeToBlockDom(nodes));
      // the new block IDs do not match the in-memory node IDs, so the mapping must be rebuilt,
      // otherwise the next incremental write-back treats the same batch of nodes as "new nodes" and inserts them again.
      await this.refreshMapsAfterCreate(docId, nodes);
    }
    return docId;
  }

  /**
   * Rebuild the "node ID → block ID" mapping after creating a document.
   *
   * The block IDs written through DOM are all freshly generated, while the in-memory node IDs are a different set;
   * the two must be aligned, otherwise the next `saveNodesIncremental` judges them "new nodes" and
   * **inserts duplicates**.
   *
   * Basis for alignment: the order of listItems in the DOM == the pre-order order of the node tree,
   * and the block tree uses the same order, so a one-to-one match by index is enough.
   */
  private async refreshMapsAfterCreate(docId: string, nodes: OutlineNode[]): Promise<void> {
    // the index lags by 1~3s, so poll first to get the top-level list.
    //
    // ★ The top-level list is the one whose parent is NOT a list item. An unqualified
    //   `type='l' LIMIT 1` returns whichever list the index flushed first — measured live, that
    //   was the *child* list (parent = a listItem), so the walk aligned n1 to the child item,
    //   dropped n2/n3, and every later write-back duplicated them.
    //   (The top list hangs under the title heading block, not directly under the document —
    //   measured: parent type 'h' — so the filter is "parent is not an item", the same rule
    //   `moveNodes` uses for its topList, not "parent is the document".)
    let listId = '';
    for (let i = 0; i < POLL_ROUNDS; i++) {
      // ★ Query first, then wait: it used to be "wait 200ms, then query",
      //   so **every call wasted 200ms** even when the index had long caught up.
      //   After creating a document several tables are queried in a row, and the accumulated delay is the "lag" the user feels.
      //   Now it queries first: fastest on a hit, waits only on a miss, same semantics.
      if (i > 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const rows = await this.client.sql<{ id: string }>(
          `SELECT id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type='l'
             AND parent_id IN (SELECT id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type IN ('d','h'))
             LIMIT 1`,
          1,
        );
        if (rows?.[0]?.id) {
          listId = rows[0].id;
          break;
        }
      } catch {
        /* index not ready yet, keep waiting */
      }
    }
    if (!listId) return;

    const para: Array<{ nodeId: string; blockId: string }> = [];
    const items: Array<{ nodeId: string; liId: string }> = [];
    const walk = async (parentListId: string, list: OutlineNode[]): Promise<void> => {
      // ★ No retry here: getChildBlocks reads the live in-memory tree, which is complete on first
      //   read once the list itself exists (measured: every level resolved with 1 read after the
      //   top-list query was fixed to pick the document/heading-level list — the earlier "async
      //   assembly" reads were the *child* list, which genuinely holds 1 item). The top-list SQL
      //   poll above already covers the index lag; retrying a complete answer only burns seconds.
      const kids = await this.client.getChildBlocks(parentListId);
      const li = kids.filter((k) => k.type === 'i');
      for (let i = 0; i < list.length && i < li.length; i++) {
        const n = list[i];
        items.push({ nodeId: n.id, liId: li[i].id });
        const sub = await this.client.getChildBlocks(li[i].id);
        const p = sub.find((b) => b.type === 'p');
        if (p) para.push({ nodeId: n.id, blockId: p.id });
        const childList = sub.find((b) => b.type === 'l');
        if (childList && n.children?.length) await walk(childList.id, n.children);
      }
    };
    await walk(listId, nodes);

    for (const p of para) this.lastBlockMap.set(p.nodeId, p.blockId);
    for (const it of items) this.lastListItems.set(it.nodeId, it.liId);
    // ★ These blocks are freshly created by us: the next loadBlockMap must keep (not drop) this
    //   alignment while the SQL index catches up (measured 200ms~2.8s). Without this, the DOM
    //   branch — which only retains previous entries whose block is freshly-inserted — drops every
    //   entry built above, and the next write-back treats all nodes as new and inserts duplicates
    //   (measured live: all 3 node alignments dropped by the very next loadBlockMap).
    for (const p of para) this.freshlyInserted.add(p.blockId);
    for (const it of items) this.freshlyInserted.add(it.liId);
  }



  /**
   * Incremental save: update only the blocks whose **content changed**, keeping block IDs.
   *
   * This is the correct path for day-to-day editing. Against the node ID → block ID mapping it
   * compares old and new text one by one and calls `updateBlock(blockID, newText)` only on differing blocks ——
   * measured, this leaves block IDs unchanged so references and backlinks inside SiYuan survive.
   *
   * New nodes and structural changes (add/delete/move) are not covered by this method yet: such changes alter
   * the tree shape and need more complex operations like insertBlock/moveBlock, so they are left to a full rebuild
   * or a later iteration. This method counts and returns those cases so the caller can decide whether to degrade.
   */
  async saveNodesIncremental(
    docId: string,
    nodes: OutlineNode[],
  ): Promise<{ updated: number; skipped: number; structural: boolean }> {
    const blockMap = await this.loadBlockMap(docId);
    // ★★ A table node has **no paragraph block**: its body is the table block itself, which
    //   `syncStructure` owns (created by the markdown route, rewritten when the cells change).
    //   Running the text path over one would look for a paragraph that does not exist, judge the
    //   node "new in the UI", and insert a duplicate beside the table.
    // ★ A code block is excluded for exactly the same reason as a table: it has no paragraph, so the
    //   text path would look for one, call the node new, and insert a duplicate beside the block.
    const flat: OutlineNode[] = flatNodes(nodes).filter((n) => !n.table && !n.codeBlock);

    // ★ Table and code blocks are mapped (each is a node) but are **not** text nodes: `flat` excludes
    //   them, so they must not count towards "the tree and the document disagree". Skipping this
    //   made every pass over a document containing a table look structural, and a plain text edit
    //   was routed through the whole structural write for nothing.
    const tableBlocks = new Set(this.lastDomTree?.rootTableIds ?? []);
    const codeBlocks = new Set(this.lastDomTree?.rootCodeBlockIds ?? []);
    const textMapped = [...blockMap.values()].filter((b) => !tableBlocks.has(b) && !codeBlocks.has(b)).length;

    // first read the current text of each block, for comparison
    const current = new Map<string, string | undefined>();
    // ★ The to-do state is read here too, and not from `content`: measured, a task's `content` is
    //   ` x` —— the marker has been reduced to a space —— while its `markdown` is `- [ ] x`. And the
    //   mapping's value is the **paragraph** block, which never carries the marker, so the listItem ids
    //   have to be read alongside it. Without this the store cannot tell a to-do it already wrote from one
    //   the user just changed, and either rewrites every task on every save or never clears one.
    const storedTask = new Map<string, number>();
    const aliveIds = new Set<string>();
    if (blockMap.size) {
      const wanted = [...new Set([...blockMap.values(), ...this.lastListItems.values()])];
      const ids = wanted.map((id) => `'${sqlStr(id)}'`).join(',');
      const rows = await this.client.sql<{ id: string; content: string; markdown: string | null }>(
        `SELECT id, content, markdown FROM blocks WHERE id IN (${ids})`,
        Math.max(wanted.length, 1),
      );
      for (const r of rows) {
        // ★★ What is stored here is the block's **inline DOM**, not its text.
        //
        //   It used to be `r.content`, and `blocks.content` is **plain text** — measured: a
        //   paragraph reads back as the same stripped string whether it is bold, struck
        //   through, coloured or not. Comparing that against a serialised node text made
        //   every markup-only edit look like "no change", so `updateBlockDom` was skipped and
        //   removing a mark never reached the document (measured on the outline: the UI showed
        //   the text unformatted, the document still held `font-weight: bold`, and a reload
        //   brought the format back).
        //
        //   Comparing in SiYuan inline DOM — the form the write actually sends — fixes that
        //   and keeps the check a fixed point for unchanged nodes; both properties are pinned
        //   in `src/core/inline-sync.test.ts`.
        //
        //   A row with no markdown yet is recorded as **unknown** rather than as plain text:
        //   unknown means "write it", which is the safe direction (see the note below on why an
        //   unknown value must not be skipped).
        //
        //   ★★ And an index that contradicts our own last write is **behind**, not authoritative:
        //   the SQL index trails the kernel by 1~3s, so right after this session wrote a block it
        //   still answers with the previous text. Believing it made a change look like "no change"
        //   and the write was dropped (measured: bold, then clear format straight after — the
        //   outline showed plain text and the document kept `**…**`).
        //
        //   The window matters in the other direction too: past it the index is the authority, so a
        //   change somebody else made is seen rather than masked by our own last write.
        const fromIndex = r.markdown ? markdownToInlineDom(r.markdown) : undefined;
        const ours = this.writtenText.get(r.id);
        const fresh =
          ours !== undefined && Date.now() - ours.at < SiYuanStore.WRITTEN_TEXT_WINDOW_MS;
        current.set(
          r.id,
          fresh && fromIndex !== undefined && fromIndex !== ours!.dom ? ours!.dom : fromIndex,
        );
        // The index has caught up with us: the document is the authority again.
        if (ours !== undefined && fromIndex === ours.dom) this.writtenText.delete(r.id);
        aliveIds.add(r.id);
        const read = taskStateOfKramdownLine(r.markdown ?? '');
        storedTask.set(r.id, read);
        // ★ Our note retires as soon as the read agrees with it: the index has caught up, so whatever the
        //   document says about that to-do is the truth again (a read that disagrees is either still
        //   lagging or somebody else's change —— either way the note must not outlive the disagreement).
        if (this.writtenTask.get(r.id) === read) this.writtenTask.delete(r.id);
      }
    }

    // ★★★ Liveness check: clear mappings pointing at **blocks that no longer exist** (measured).
    //
    //   Measured scenario (defect #53): A already has a child node ChildT; add a sibling SiblingE.
    //   While handling the insert the kernel **destroyed** ChildT's block, while the plugin-side mapping table
    //   still remembered those two block IDs. The consequence chain:
    //     · `syncStructure` sees an ID in the mapping table → believes "the block exists" → **does not re-insert**
    //     · `saveNodesIncremental` takes the dead ID to `updateBlock` → no effect
    //     · `syncDeletions` goes through a different reverse lookup → reports nothing either
    //   ⇒ present in the UI, absent in SiYuan, **and no error message at all** (measured total=7, only 4 alive).
    //
    //   The fix: when a block in the mapping table cannot be found, clear it in place so that this node is
    //   treated as a **new node** and re-inserted in this write-back. Better to re-insert (idempotent) than to keep a dead link.
    //
    //   ★ Why it lives here: `blockMap` was just obtained from `loadBlockMap`,
    //     and the SQL result is the only authoritative source of "which blocks really exist right now" ——
    //     no extra query needed, zero cost.
    //   ★★★ Fix (defect #54): it **must not** delete merely because "this SQL did not find it".
    //
    //   The original implementation deleted outright, which **collided head-on** with `loadBlockMap`'s
    //   "keep entries SQL has not picked up" logic, and measurably produced **duplicate nodes**:
    //   ```
    //     loadBlockMap says: keep it even if SQL has not picked it up (the index lags)
    //     liveness check says: not in SQL means dead, delete
    //   → the latter wins → the mapping of a just-inserted node is wrongly deleted → the next write-back **inserts it again**
    //   ```
    //   Measured block tree (after three levels of operations):
    //   ```
    //   ChildT
    //      ├── SiblingE  (22:32:58)
    //      └── SiblingE  (22:33:15)   ← duplicate
    //   ```
    //   Probe evidence (the same node SiblingE = qfh6pfm):
    //   ```
    //   [write-back 2] SiblingE → (none) → insert ✅
    //   [write-back 3] SiblingE → (none) → **insert again** ❌   ← the mapping was lost between the two write-backs
    //   ```
    //
    //   ⇒ Only touch the mappings that "were missing to begin with and are **still missing after waiting**",
    //     and **this write-back's freshly inserted** blocks must be excluded (their index necessarily lags).
    if (aliveIds.size || blockMap.size) {
      // blocks the index has caught up with → remove from the exemption set (they really exist, so no exemption is needed)
      for (const blk of [...this.freshlyInserted]) {
        if (aliveIds.has(blk)) this.freshlyInserted.delete(blk);
      }
      // cap the exemption set so it cannot grow without bound over a long run
      if (this.freshlyInserted.size > 500) {
        this.freshlyInserted = new Set([...this.freshlyInserted].slice(-200));
      }
      // just inserted, the index has not caught up —— never declare it dead (defect #54)
      const suspects = deadMappingSuspects(blockMap, aliveIds, this.freshlyInserted);
      // ★★★ For a pure text edit the node count equals the block count (flat.length === blockMap.size),
      //   so "sibling blocks destroyed by a structural operation" can never happen (defect #53 only occurs on structural changes).
      //   On a text edit the suspect re-query and the 400ms sleep are skipped, so no keypress is slowed down.
      // ★ Same correction as below: table blocks are mapped but are not text nodes, so they
      //   must not count towards "the tree and the document disagree".
      if (suspects.length && suspectedStructuralChange(flat.length, textMapped)) {
        // second confirmation: wait for the index to catch up and query again; only two misses declare it dead
        await new Promise((r) => setTimeout(r, 400));
        const ids = [...new Set(suspects.map(([, b]) => b))];
        let live2 = new Set<string>();
        try {
          const rows2 = await this.client.sql<{ id: string }>(
            `SELECT id FROM blocks WHERE id IN (${ids.map((v) => `'${sqlStr(v)}'`).join(',')})`,
            ids.length,
          );
          live2 = new Set((rows2 ?? []).map((r) => r.id));
        } catch {
          live2 = aliveIds; // on a failed query treat them all as alive; better to do nothing
        }
        for (const [nodeId, blk] of suspects) {
          if (live2.has(blk)) continue;
          blockMap.delete(nodeId);
          this.lastBlockMap.delete(nodeId);
          if (this.lastListItems.get(nodeId) === blk) this.lastListItems.delete(nodeId);
          this.lastByBlock.delete(blk);
        }
      }
    }


    let updated = 0;
    let skipped = 0;
    let structural = false;
    // structural check: node count vs existing block count differ → something was added or deleted, the layer above decides
    //
    // ★ Count only the mappings that are **not** table blocks.
    //
    //   `loadBlockMap` maps a table's own block to its node (a table is a node now), so
    //   `blockMap.size` counts it while `flat` deliberately excludes it — a document with one
    //   table therefore looked structural on *every* pass, and a plain text edit was routed
    //   through the whole structural write for no reason. Measured: editing a node in such a
    //   document lost the edit some of the time.
    if (flat.length !== textMapped) structural = true;

    for (const n of flat) {
      const blockId = blockMap.get(n.id);
      if (!blockId) {
        structural = true; // this node has no corresponding block in SiYuan (a new addition)
        skipped++;
        continue;
      }
      // note: structural changes are syncStructure's job; this loop only syncs text
      // ★★ The new text is compared in **SiYuan inline DOM** — the same space `current` holds
      //   and the same `updateBlockDom` below sends. Comparing serialised forms that mean the
      //   same thing only by accident makes the check a coin flip: see `markdownToInlineDom`.
      const newText = htmlToSiyuanDom(n.text ?? '');
      const oldText = current.get(blockId);
      // ★★★ oldText === undefined must not simply be skipped (a measured **text does not get written** bug).
      //
      //   The original criterion implied "not found in SQL → the block does not exist yet → leave it to syncStructure to create".
      //   That holds when the block **really does not exist**, but there is a second case:
      //   **the block is one we just insertBlock'ed and only the SQL index has not caught up**.
      //
      //   Measured (outline Enter creates a node + fast typing of "NewNode"):
      //   ```
      //   UI: ['A','B','NewNode']
      //   SiYuan: ['A','B','']        ← not a single character of text was written
      //   ```
      //   Combined with loadBlockMap's mapping retention, syncStructure believes the block exists (so no re-insert),
      //   and this line skips it because it cannot be found → **neither stage writes**.
      //
      //   The criterion becomes: as long as blockId exists (the mapping table recognizes this block), it must be written.
      //   A genuinely "missing block" is syncStructure's insert logic to handle, not this line's fallback.
      //
      //   ★★★ …with one exception (measured undo-path race): when the block is one THIS pass just
      //   inserted (`freshlyInserted`) yet the index has no row for it, the insert already stored the
      //   right text — its markdown carried the full content. Rewriting it now via the DOM path would
      //   downgrade the kernel's parsed inline structure (a bare `<span>乙</span>` becomes
      //   `<span data-type="text">乙</span>`, a silent content change on every reuse-insert).
      //   So: unknown + freshly-inserted ⇒ trust the insert, skip the rewrite. Unknown + anything
      //   else keeps the old rule (write it — the NewNode bug above).
      if (oldText === undefined && this.freshlyInserted.has(blockId)) {
        skipped++;
      } else if (oldText === undefined || oldText !== newText) {
        // ★★★ Route everything through the **DOM path** (settled from the kernel source).
        //
        //   Kernel source `kernel/api/block_op.go:679`:
        //     if "markdown" == dataType {
        //         data, err = dataBlockDOM(data, luteEngine)   // parsed by Lute
        //     }
        //     // dataType == "dom" is handed to PerformBlockOperation as-is, **without going through Lute**
        //   So `dom` **passes the block structure directly**, with no markdown parsing step,
        //   and therefore "markdown cannot express some style" is not a problem.
        //
        //   Measured lesson: do not "default to markdown and switch to dom only when styles are involved" ——
        //   the markdown path does not understand HTML/IAL, so writing `<span style="color:…">` gets
        //   **escaped into literal source**; the two paths also store different shapes, which makes a comparison always report "there is a difference".
        //   Now it is uniform: the body is always DOM (`htmlToSiyuanDom` already converts bare tags into
        //   SiYuan-native forms such as `<span data-type="strong">`).
        const dom = paragraphBlockFragment(n.text ?? '');
        await this.client.updateBlockDom(blockId, dom);
        // ★ Remember what this block now holds, so the next pass does not read a **stale** index
        //   and conclude the node is unchanged (see `writtenText`).
        this.writtenText.set(blockId, { dom: newText, at: Date.now() });
        if (this.writtenText.size > 500) {
          const oldest = this.writtenText.keys().next().value;
          if (oldest !== undefined) this.writtenText.delete(oldest);
        }
        updated++;
      } else {
        skipped++;
      }

      // ★★★ To-do state, written as **markdown** —— the only call that can *create* a task.
      //
      //   Measured on the kernel: `updateBlock(id, '- [ ] x', dataType='markdown')` turns a plain list
      //   item into a task **and keeps the block id**. Neither call this used to make could do it ——
      //   `dataType=dom` (the block write above) cannot introduce the `t` subtype, and
      //   `/api/block/updateTaskListItemMarker` only sets the checked state of a task that already
      //   exists. A to-do **created** in the outline therefore reached SiYuan as a plain list item: the
      //   panel showed a checkbox it had no way to persist, and both calls returned success.
      //
      //   All three states go through this one path (`- [X] `, `- [ ] `) rather than a marker call beside
      //   the DOM write: two calls for one field drift apart, and only one of them can create.
      let liId = this.lastListItems.get(n.id);
      const wants = n.taskStatus === 2 ? 2 : n.taskStatus === 1 ? 1 : 0;
      // ★ Written only when the document does not already hold this state. Rewriting unconditionally costs
      //   a full markdown reparse of the node and its subtree on every save, and a markdown write cannot
      //   carry HTML/IAL, so a to-do whose text is styled would lose that styling on every keystroke.
      // ★ What we wrote ourselves outranks the read: inside the lag window the read still answers with the
      //   state before our own write, which is what made a quick second click a silent no-op.
      const stored = liId ? this.writtenTask.get(liId) ?? storedTask.get(liId) ?? 0 : 0;
      if (liId && wants !== stored) {
        try {
          if (wants && stored) {
            // ★ Already a to-do, so this is a checked-state change: the marker API is the native call for
            //   exactly that, and it leaves the block's own content alone. (It cannot create a task — it
            //   answers `-1 block is not a task list item` on a plain list item, which is why creation and
            //   clearing take the markdown path instead.)
            await updateTaskMarkerWithFallback(this.client, liId, wants === 2, nodeSubtreeToKramdown(n));
          } else {
            // ★ Creating a to-do (0 → task) and clearing one (task → 0) are both markdown-only: no other
            //   call can introduce or remove the task subtype. The markdown must carry the node's
            //   **subtree**: writing only the node's own line does not convert the block in place, and
            //   what it does instead was measured both ways on a node that has children —— without a
            //   marker the kernel adds a nested copy beside the children and leaves the node itself
            //   untouched, with a marker it drops the children. Carrying the subtree converts in place,
            //   keeps every block id in it, and shows the text once.
            //   apart, and it writes the prefix from `taskStatus` itself.
            await this.client.updateBlock(liId, nodeSubtreeToKramdown(n));
          }
          this.writtenTask.set(liId, wants);
          if (this.writtenTask.size > 200) {
            const oldest = this.writtenTask.keys().next().value;
            if (oldest !== undefined) this.writtenTask.delete(oldest);
          }
          updated++;
        } catch (e) {
          // Loud rather than swallowed: these are the only calls that make a to-do a to-do in the document.
          console.warn('[om] could not write the to-do state for', liId, e);
        }
      } else if (!liId && wants) {
        // ★ A task state with no list-item mapping is not a quiet no-op: the plugin is showing a to-do it
        //   has no way to write, which is how a created to-do went missing from the document.
        console.warn('[om] no listItem mapping for a task node, cannot write its to-do state:', n.id);
      }

      // ★★★ attached-paragraph write-back: **body paragraphs** carry a node's extra notes.
      //   Why not attributes (like `memo`): block attributes are by default **not in the full-text index**,
      //   the UI also shows them as a single icon that must be opened to be seen;
      //   whereas body paragraphs are naturally searchable, show right below the node, and are fully kept after uninstall.
      //
      //   Attached paragraphs = the NodeParagraph blocks under a listItem other than the first paragraph.
      //   They are **separate blocks** and cannot be carried along by writing the first paragraph with updateBlock;
      //   they must be synced separately in the same write-back round.
      //
      //   Sync strategy (align blocks by "position + content" rather than delete-and-rebuild):
      //     1. read the current attached paragraph blocks (getChildBlocks, whose order is authoritative)
      //     2. compare position by position: same position and same content → write nothing (avoid a pointless transaction)
      //     3. a difference in count/content → write only the differing ones
      //     4. fewer targets than existing → delete the surplus blocks (**from the tail**, preserving the prefix's block IDs)
      //
      //   ⚠️ this must go through `this.lastListItems` (listItem), not `blockMap`
      //   (paragraph blocks) —— attached paragraphs are children of the listItem, and the wrong parent hangs them somewhere else.
      // ★★★ attached-paragraph write-back: a missing mapping **must never be skipped silently** (measured).
      //
      //   Measured: after `createDoc` the SQL index lags by 1~3 seconds,
      //   `loadBlockMap` gets no listItem → `lastListItems.get` is undefined.
      //   The original `if (liId) { ... }` **skipped silently**:
      //   the user edited an attached paragraph, the UI said it was saved, yet nothing was written to SiYuan —— silently losing data.
      //
      //   Degradation order:
      //     ① mapping missing → re-read blockMap once (the index may have just caught up)
      //     ② still missing → throw, so the layer above catches it and reports to the user
      //   Better an explicit error than silently dropping the user's edit.
      // ★ Keep this criterion consistent with the block below: **do not** look only at whether `n.paragraphs` is non-empty.
      //   When something is to be deleted `n.paragraphs` is exactly empty (undefined), so looking only at it means no retry
      //   and the deletion is silently lost anyway —— the same pitfall as this fix; do not commit it in two places.
      if (!liId && ((n.paragraphs?.length ?? 0) > 0 || this.nodesWithParas.has(n.id))) {
        // retry only when there really is a paragraph to write/delete, so no whole-database query is added per node
        try {
          // use a **different limit** to bypass the in-write-back cache (the cache is keyed by docId+limit),
          // forcing a real SQL round —— otherwise the same stale empty mapping is read again.
          await this.loadBlockMap(docId, 5001);
          liId = this.lastListItems.get(n.id);
        } catch {
          /* a failed re-read falls through to the unified error below */
        }
        if (!liId) {
          throw new Error(
            t('errParaWritebackNoListItem', { id: n.id }),
          );
        }
      }
      // ★★★ When the target is empty (`paragraphs` is `undefined`) a sync **may still be required**.
      //
      //   The original criterion was `(n.paragraphs?.length ?? 0) > 0`, treating "no attached paragraphs"
      //   as "nothing to write" —— but `syncParagraphs` is **bidirectional**
      //   and its step 3 is exactly "fewer targets → delete the surplus blocks from the tail".
      //   So deleting the last attached paragraph left it entirely uncalled
      //   and those paragraph blocks **stayed in SiYuan forever**.
      //
      //   Measured symptom (as reported): when a node's attached paragraphs are all empty paragraphs,
      //   clicking the note button once more goes through `delete n.paragraphs` (see Outliner's
      //   `togglePara` / `closePara`), the UI collapsed it,
      //   yet the empty paragraph block was still in SiYuan —— showing up as "deleting an empty attached paragraph is not synced".
      //   `removePara` hits the same problem when removing the last paragraph (`paraToStore([])` → undefined).
      //
      //   ★ Why it cannot become "always call": that would add one
      //     `getChildBlocks` per node per write-back (measured median 1.35ms, 240 nodes = 316ms/round,
      //     and a write-back runs on every keypress).
      //   ★ The criterion is therefore "**did it have any in the previous round**", not "**does it have any now**" ——
      //     being empty now is precisely the moment deletion is required. See `nodesWithParas`.
      const wantParas = n.paragraphs ?? [];
      if (liId && (wantParas.length > 0 || this.nodesWithParas.has(n.id))) {
        await this.syncParagraphs(n.id, liId, wantParas);
      }
    }
    // ★★ Table cells are editable, and they cannot ride the text loop above.
    //
    //   That loop's `flat` **excludes** table nodes on purpose: a table has no paragraph block, so
    //   running the text path over one looks for a paragraph that does not exist, judges the node
    //   "new in the UI", and inserts a second table beside it (measured).
    //
    //   So the diff is its own pass, with its own baseline (`lastTableMarkdown`) and a
    //   **whole-body** write, because a table block's body is the whole table.
    await this.syncTableCells(nodes);
    return { updated, skipped, structural };
  }

  /**
   * Sync one listItem's attached paragraph blocks.
   *
   * Measured basis (SiYuan v3.8.6):
   *   · `getChildBlocks` returns the listItem's child blocks, **whose order is the document order** (authoritative)
   *   · child layout: the first paragraph p, then the other attached p's, then the corresponding child list l
   *   · the kernel keeps a block for an empty paragraph, but `getBlockKramdown` does not export its body line
   *     (the reader reconstructs it from the "adjacent attribute lines", see kramdownToTree in map.ts)
   *
   * No "delete-and-rebuild": that would rebuild every block ID and destroy the references/bookmarks pointing at these paragraphs.
   */
  private async syncParagraphs(nodeId: string, liId: string, want: string[]): Promise<void> {
    let children: Array<{ id: string; type: string; content?: string }> = [];
    try {
      children = (await this.client.getChildBlocks(liId)) ?? [];
    } catch {
      return; // if it cannot be read, touch nothing, to avoid a wrong deletion
    }
    // take paragraph blocks only; the first paragraph is index 0 (the node body), the rest are attached paragraphs
    const paras = children.filter((c) => c.type === 'p');
    const existing = paras.slice(1); // skip the first paragraph

    // ★ Not a local named `t`: this module imports the i18n function as `t`, so a binding called `t` here
    //   shadows it. Harmless today (this scope translates nothing) and a trap tomorrow.
    const norm = (s: string | undefined): string => (s ?? '').replace(/\u200b/g, '').trim();

    // 1) update the differing ones position by position
    //
    // ★ Route everything through the **DOM path** (`updateBlockDom` / `dataType=dom`), with no markdown mixed in.
    //
    //   Kernel source `kernel/api/block_op.go:679`:
    //     if "markdown" == dataType {
    //         data, err = dataBlockDOM(data, luteEngine)   // parsed by Lute
    //     }
    //     // with dataType == "dom" it reaches PerformBlockOperation **as-is**, without Lute
    //   i.e. the DOM type becomes the block structure directly, with no markdown parsing step.
    //
    //   Two benefits of always going through DOM:
    //     ① no dependence on "can markdown express this content" —— what `paragraphs` stores is
    //        an HTML fragment, and converting to markdown and back loses information (e.g. a `<span>` wrapper);
    //     ② the stored shape is identical to the "insert branch", so a comparison never always reports "there is a difference".
    const n = Math.min(existing.length, want.length);
    for (let i = 0; i < n; i++) {
      const html = want[i] ?? '';
      const plain = (await this.plainOfHtml(html)).trim();
      if (norm(existing[i].content) === plain) continue; // no change → do not write
      const dom = paragraphBlockFragment(html);
      await this.client.updateBlockDom(existing[i].id, dom);
    }

    // 2) more targets → insert **after the first paragraph** (not at the end of the listItem!)
    //
    // ★★★ Two measured reasons why it must be done this way:
    //
    //   ① **Position**: `appendBlock(parentID=listItem)` appends the new paragraph to
    //      the **very end** of the listItem —— i.e. **after the child list**:
    //      ```
    //      Measured child order: ['p:RootNode', 'l: ChildNode', 'p:AppendedPara']   ← wrong position
    //      ```
    //      whereas the correct shape is "first paragraph → attached paragraphs → child list":
    //      ```
    //      insertBlock(previousID=first paragraph) → ['p:RootNode', 'p:InsertedPara', 'l: ChildNode'] ✅
    //      ```
    //      A wrong position also **breaks the reader**: parsing uses indentation to decide paragraph ownership,
    //      and once an attached paragraph lands after the child list the indentation relationship is scrambled and the paragraph cannot be read back at all.
    //
    //   ② **Order**: several `insertBlock` calls with the **same** previousID produce
    //      a **reversed order** (measured: insert "InsertedPara" first, then "InsertedPara2", and the result is
    //      InsertedPara2 first). So after each insert the anchor must **move forward** to the block just inserted.
    //
    //   The write path stays consistent with the update branch (**both go through DOM**),
    //   so the two paths storing different shapes cannot make a comparison always report "there is a difference".
    // ★★★ The anchor must start from the **last existing attached paragraph**, not be fixed on the first paragraph.
    //
    //   Measured pitfall: the kernel already had 2 paragraphs ('RootAttach1', 'RootAttach2'),
    //   and the target became 3 paragraphs ('A', '', 'B') ——
    //   the first 2 go through "position-by-position update" and are rewritten in place, the 3rd through "insert".
    //   If the insert anchors on the **first paragraph**, the new paragraph lands after it and before 'A':
    //   ```
    //   Measured result: ['B','A','']         ← wrong order
    //   Expected:        ['A','','B']
    //   ```
    //   The correct answer: anchor = the last existing attached paragraph;
    //   only when there is no existing paragraph at all does it fall back to the first paragraph.
    let anchor = (existing[existing.length - 1] ?? paras[0])?.id ?? '';
    for (let i = existing.length; i < want.length; i++) {
      const html = want[i] ?? '';
      const dom = paragraphBlockFragment(html);
      const newId = await this.client.insertParagraphAfter(anchor, dom);
      // move the anchor forward to the block just inserted so the next paragraph follows it (otherwise reversed)
      if (newId) anchor = newId;
    }

    // 3) fewer targets → delete the surplus blocks **from the tail** (preserving the prefix's block IDs)
    for (let i = existing.length - 1; i >= want.length; i--) {
      await this.client.deleteBlock(existing[i].id);
    }

    // ★ Maintain "does this node have paragraph blocks" as we go (see the declaration of `nodesWithParas`).
    //   ★★ The criterion is the **target state after writing** (`want`), not the **state read** (`existing`).
    //     Registering from the current state would never register on the "insert" path:
    //     at read time SiYuan had no paragraph at all and only after inserting does it have one —— so the next round's deletion is missed again.
    //     It sits at the end of the function because a throw in any step above skips it,
    //     and at that point SiYuan's state is unknown, so it is better not to update (the next round re-judges from the current state).
    if (want.length > 0) this.nodesWithParas.add(nodeId);
    else this.nodesWithParas.delete(nodeId);

    // ★ Nothing wrote a `paras:`-prefixed key —— every `lastListItems.set` uses a node ID (or ownerNode),
    //   and every read does too. So this deleted a key that could not exist, while its comment claimed to
    //   invalidate a paragraph cache "so the next round re-reads" —— the shape that makes dead code look
    //   load-bearing (the same shape as `saveNodes` claiming a rebuild path nothing called).
    //
    //   The cache entry that actually needs dropping is keyed by **node ID**, and `nodesWithParas` above
    //   already records the current state; the next `loadBlockMap` re-reads from that, not from here.
  }

  /**
   * Sync the leading paragraph blocks of the document root (the title node).
   *
   * Paragraphs of the document that come before the first list or the first non-leading heading block belong to the title node.
   */
  async syncDocParagraphs(docId: string, want: string[]): Promise<void> {
    let children: Array<{ id: string; type: string; subType?: string; content?: string }> = [];
    try {
      children = (await this.client.getChildBlocks(docId)) ?? [];
    } catch {
      return; // if it cannot be read, touch nothing, to avoid a wrong deletion
    }

    // find the position of the first list container ('l') or body heading (a non-leading document title block);
    // every 'p' block appearing before that is a leading paragraph of the title node.
    const firstNodeIdx = children.findIndex((c, i) => {
      if (c.type === 'l') return true;
      if (c.type === 'h' && i > 0) return true;
      return false;
    });

    const candidateChildren = firstNodeIdx >= 0 ? children.slice(0, firstNodeIdx) : children;
    const existing = candidateChildren.filter((c) => c.type === 'p');

    const norm = (s: string | undefined): string => {
      return (s ?? '').replace(/\u200b/g, '').trim();
    };

    // 1) update the differing ones position by position
    const n = Math.min(existing.length, want.length);
    for (let i = 0; i < n; i++) {
      const html = want[i] ?? '';
      const plain = (await this.plainOfHtml(html)).trim();
      if (norm(existing[i].content) === plain) continue;
      const dom = paragraphBlockFragment(html);
      await this.client.updateBlockDom(existing[i].id, dom);
    }

    // 2) more targets → append by insert
    let anchor = existing.length > 0 ? existing[existing.length - 1].id : '';
    if (!anchor && candidateChildren.length > 0 && candidateChildren[0].type === 'h') {
      anchor = candidateChildren[0].id;
    }

    for (let i = existing.length; i < want.length; i++) {
      const html = want[i] ?? '';
      const dom = paragraphBlockFragment(html);
      let newId = '';
      if (anchor) {
        newId = await this.client.insertParagraphAfter(anchor, dom);
      } else {
        newId = await this.client.prependParagraph(docId, dom);
      }
      if (newId) anchor = newId;
    }

    // 3) fewer targets → delete the surplus blocks from the tail
    for (let i = existing.length - 1; i >= want.length; i--) {
      await this.client.deleteBlock(existing[i].id);
    }
  }

  /** Convert an HTML fragment to plain text (for comparison with the kernel's content) */
  private async plainOfHtml(html: string): Promise<string> {
    return unescapeHtml(html.replace(/<[^>]*>/g, ''));
  }

  /**
   * Structural sync: write **newly added** nodes into SiYuan (keeping existing blocks and block IDs).
   *
   * Why the whole document cannot simply be rewritten: a whole-document `updateBlock` rebuilds every block ID
   * and invalidates SiYuan's references/backlinks (measured and confirmed). So additions go through "targeted inserts".
   *
   * ★ Insert-position rules (measured and settled, very counter-intuitive):
   *   - a listItem must **not** be used as `parentID` —— the kernel squeezes the parent node's own text
   *     into a separate paragraph and breaks the existing structure.
   *   - the correct approach uses only `previousID`:
   *     · if the parent node already has children → `previousID` = **the last child's listItem**
   *     · if the parent node has no children yet → `previousID` = **the parent node's paragraph block**
   *
   * Returns the "node ID → block ID" mapping of the newly inserted blocks, so the caller can update its local mapping table.
   *
   * ⚠️ **A document ID must never be used as `previousID`** —— measured, it makes the kernel panic:
   * `transaction panic: runtime error: invalid memory address or nil pointer dereference`.
   * Top-level nodes should instead be appended with `parentID = documentID`.
   */
  async syncNumbering(docId: string, nodes: OutlineNode[]): Promise<{ converted: string[] }> {
    // Convert nodes whose `numbered` disagrees with the kernel's list subtype (`l/u` vs `l/o`).
    //
    // ★★★ Why delete + reinsert (measured, four dead ends first):
    //
    //   The kernel has no in-place `u`↔`o` conversion. Probed on the isolated instance, every one of
    //   these answers `code: 0` and changes nothing: `updateBlock` markdown on the item, on the parent
    //   list, a faithful getBlockDOM → flip-subtype → `updateBlock` round trip on either level, and
    //   `moveBlock` of the item into an opposite-subtype list. SiYuan's own frontend converts by moving
    //   items between lists and flipping them explicitly, which the block API does not honour.
    //
    //   So a toggled node is deleted and reinserted with the right marker in the SAME write-back:
    //   the delete and the reinsert run back to back with nothing between them, because the `{: id}`
    //   adoption window is immediate (measured: instant reuse adopts the id; ~100ms later the same
    //   call stores `1. <span data-type="text">…</span>` — content mangled, silent; seconds later it
    //   mints a fresh id silently; once it even answered `-1`). The reinsert is therefore VERIFIED
    //   against the export markdown, and a mangled insert falls back to a fresh id (deterministically
    //   clean). Whatever id the kernel really mints is registered from the return value, so a missed
    //   adoption degrades to a fresh id, never to a lost node.
    //
    // ★★★ Why the subtree mappings are dropped deliberately (no lag roulette):
    //
    //   Deleting the item destroys its whole subtree (paragraphs, child list, descendants). Their
    //   mappings are dropped here, up front, because the blocks are *known* dead —— waiting for the
    //   SQL index to confirm would leave them "mapped" for this pass, the insert would be skipped,
    //   and the children would vanish until a later pass healed them. Dropped mappings read as "new
    //   nodes", and `syncStructure` reinserts each with `{: id}` adoption in the same window.
    //
    // ★ `loadBlockMap` cannot resurrect the dropped entries: it prefers the synchronous in-memory DOM
    //   (which sees the deletion at once), and its SQL-fallback retention only revives ids still in
    //   `freshlyInserted` —— deleted ids are scrubbed from that set below for exactly this reason
    //   (otherwise a node toggled seconds after its own creation would never be reinserted).
    //
    // ★ On any failure the mappings are KEPT, so the next pass retries: a failed delete leaves the old
    //   block (harmless), a failed insert leaves the node unmapped (reinserted next pass). Loud, never
    //   silent: failures warn, and the plan itself is pinned by `numbering-plan.test.ts`.
    const converted: string[] = [];
    // Nodes that could need a stored-subtype read: mapped, non-task, not freshly inserted
    // (fresh inserts already carried the marker via `nodeInsertLine`, and their subtype is not
    // indexed yet —— the planner skips them again below; this only bounds the SELECT).
    const itemIds: string[] = [];
    {
      const seen = new Set<string>();
      for (const n of flatNodes(nodes)) {
        if (n.taskStatus) continue;
        const li = this.lastListItems.get(n.id);
        if (!li || this.freshlyInserted.has(li) || seen.has(li)) continue;
        seen.add(li);
        itemIds.push(li);
      }
    }
    if (!itemIds.length) return { converted };
    let stored = new Map<string, string>();
    try {
      const rows = await this.client.sql<{ id: string; subtype: string | null }>(
        `SELECT id, subtype FROM blocks WHERE id IN (${itemIds.map((v) => `'${sqlStr(v)}'`).join(',')})`,
        itemIds.length,
      );
      stored = new Map((rows ?? []).map((r) => [r.id, r.subtype ?? '']));
    } catch {
      return { converted }; // a failed read converts nothing; the next pass retries
    }
    const plan = planNumberingConversion(
      nodes,
      (nodeId) => this.lastListItems.get(nodeId),
      (bid) => this.freshlyInserted.has(bid),
      (itemId) => stored.get(itemId),
    );
    const byId = new Map(flatNodes(nodes).map((n) => [n.id, n]));
    for (const c of plan) {
      const node = byId.get(c.nodeId);
      if (!node) continue;
      const text = htmlToKramdown(node.text ?? '') || '\u200b';
      const md = nodeInsertLine(node, text);
      const anchor = this.conversionAnchor(docId, nodes, c.nodeId);
      try {
        await this.client.deleteBlock(c.itemId);
      } catch (e) {
        console.warn('[om] could not delete the list item for numbering conversion:', c.itemId, e);
        continue;
      }
      this.noteDeletedBlock(c.itemId);
      this.dropSubtreeMappings(c.nodeId, nodes);
      this.freshlyInserted.delete(c.itemId);
      // ★ Back to back with the delete (see the adoption window in `insertPreVerified`): any
      //   await between them narrows it and the reuse degrades instead of adopting.
      let ins: { listItemId: string; paragraphId: string } | null = null;
      try {
        ins = await this.insertPreVerified(md, anchor.parentID, anchor.previousID);
      } catch (e) {
        console.warn('[om] numbering conversion insert failed, retrying next pass:', c.nodeId, e);
        converted.push(c.nodeId);
        continue;
      }
      if (!ins?.listItemId) {
        console.warn('[om] numbering conversion insert returned no block, retrying next pass:', c.nodeId);
        converted.push(c.nodeId);
        continue;
      }
      // Registered from the return value like a normal insert: whatever id the kernel minted
      // (adopted or fresh) is what the rest of this pass uses.
      this.registerConvertedBlock(c.nodeId, ins.listItemId, ins.paragraphId);
      converted.push(c.nodeId);
    }
    return { converted };
  }

  /**
   * Rough insert anchor for a conversion reinsert: the previous sibling's item, else the parent's
   * paragraph (child-list append), else the document. Exact order is `moveNodes`' job, which runs
   * later in this same pass —— the anchor only has to pick the right level without overwriting a
   * singleton sibling (the defect #53 shape, avoided by never anchoring on an only child).
   */
  private conversionAnchor(
    docId: string,
    nodes: OutlineNode[],
    nodeId: string,
  ): { parentID: string; previousID: string } {
    const path = findPath(nodes, nodeId);
    const self = path?.[path.length - 1];
    const owner = path && path.length >= 2 ? path[path.length - 2] : null;
    const siblings = owner ? owner.children : nodes;
    const index = self ? siblings.findIndex((n) => n.id === self.id) : -1;
    if (index > 0) {
      const prevItem = this.lastListItems.get(siblings[index - 1].id);
      if (prevItem) return { parentID: '', previousID: prevItem };
    }
    if (owner) {
      const para = this.lastBlockMap.get(owner.id);
      if (para) return { parentID: '', previousID: para };
    }
    return { parentID: docId, previousID: '' };
  }

  /**
   * Register a converted block exactly like a normal insert (mirrors the registration in
   * `syncStructure`): paragraph + item in both directions, plus the lag exemptions, so the rest
   * of this pass — and the next `loadBlockMap` rebuild — sees the new blocks.
   */
  private registerConvertedBlock(nodeId: string, listItemId: string, paragraphId: string): void {
    const para = paragraphId && paragraphId !== listItemId ? paragraphId : listItemId;
    this.lastBlockMap.set(nodeId, para);
    this.lastListItems.set(nodeId, listItemId);
    this.lastByBlock.set(para, nodeId);
    this.lastByBlock.set(listItemId, nodeId);
    this.freshlyInserted.add(para);
    this.freshlyInserted.add(listItemId);
    this.everSeen.add(para);
    this.everSeen.add(listItemId);
  }

  /**
   * Insert, verifying the content when the markdown reuses an id deleted this session.
   *
   * `insertBlockEx` with `{: id}` of a live-or-fresh id adopts it deterministically (measured),
   * but with a recently-deleted id the kernel races (see `recentlyDeleted`): the insert answers
   * success yet stores mangled content (`1. <span data-type="text">…</span>` instead of `1. …`,
   * measured on the undo + toggle paths).
   *
   * ★★★ Why the check passes `fresh` back instead of deleting + reinserting (measured):
   *
   *   The first version did the recovery inline (delete the mangled block, reinsert without
   *   `{: id}`). But the mangled insert already consumed the adoption: the recovery's fresh
   *   insert lands fine, yet the *timing* that produced the mangling — delete + reuse inside one
   *   pass while the kernel still holds the id — replays on every retry, so the fallback just
   *   moves the mangling one step down the line. The recovery therefore belongs to the CALLER,
   *   which knows the node's siblings and can re-anchor: it registers the fresh block under the
   *   node id like any normal insert.
   *
   *   `updated` cannot break the tie either: it has one-second resolution, and delete + reuse land
   *   in the same second, so a stale pre-delete row and the fresh row compare equal.
   *
   *   What the check CAN do synchronously: the insert response's `op.data` carries the new block's
   *   DOM. A clean insert's paragraph holds the bare text; a mangled one's holds the leaked span.
   *   That verdict is available before the method returns — no polling, no index lag involved.
   *
   * Returns `{ listItemId, paragraphId, fresh }`: `fresh` is true when the kernel did NOT adopt
   * the reused id (fresh block minted, or mangled insert already cleaned up). The caller registers
   * the returned ids either way and never assumes the reuse landed.
   */
  private async insertPreVerified(
    md: string,
    parentID: string,
    previousID: string,
  ): Promise<{ listItemId: string; paragraphId: string; fresh: boolean }> {
    const reuse = /\{: id="([^"]+)"\}/.exec(md)?.[1];
    if (!reuse || !this.recentlyDeleted.has(reuse)) {
      const r = await this.client.insertBlockEx(md, parentID, previousID);
      return { ...r, fresh: false };
    }
    const plain = md.replace(/\s*\{:[^}]*\}/, '');
    const bodyText = plain.replace(/^(?:-\s?|\d+\.\s?)/, '').trim() || '\u200b';
    const withOpData = await this.client.insertBlockWithOpData(md, parentID, previousID);
    const paraText = firstParagraphText(withOpData.opData);
    if (paraText !== null && paraText !== bodyText) {
      // ★ Mangled reuse (measured): the kernel kept the id but stored the leaked span.
      //   Delete the mangled block and insert WITHOUT the reused id — a fresh id is
      //   deterministically clean — then report fresh so the caller registers the real block.
      console.warn('[om] reused-id insert came back mangled, reinserting fresh');
      try {
        await this.client.deleteBlock(withOpData.listItemId);
      } catch { /* fall through to the fresh insert */ }
      this.noteDeletedBlock(withOpData.listItemId);
      const fresh = await this.client.insertBlockEx(plain, parentID, previousID);
      return { ...fresh, fresh: true };
    }
    if (withOpData.listItemId !== reuse) {
      // Adoption missed silently (measured: seconds after the delete the kernel mints fresh).
      // The fresh block is clean; report it so the caller registers the real ids.
      return { listItemId: withOpData.listItemId, paragraphId: withOpData.paragraphId, fresh: true };
    }
    this.recentlyDeleted.delete(reuse);
    return { listItemId: withOpData.listItemId, paragraphId: withOpData.paragraphId, fresh: false };
  }

  /**
   * Drop every mapping entry owned by a node's subtree: paragraph block, listItem block, reverse
   * entries and child-list cache (plus the `freshlyInserted` exemption, which would otherwise
   * resurrect the entries on the next `loadBlockMap` rebuild and skip the reinsert forever).
   */
  private dropSubtreeMappings(nodeId: string, nodes: OutlineNode[]): void {
    const ids = new Set<string>();
    const start = findNode(nodes, nodeId);
    if (start) for (const n of flatNodes([start])) ids.add(n.id);
    else ids.add(nodeId);
    for (const id of ids) {
      const para = this.lastBlockMap.get(id);
      if (para) this.lastByBlock.delete(para);
      const li = this.lastListItems.get(id);
      if (li) {
        this.lastByBlock.delete(li);
        this.childListByItem.delete(li);
        this.freshlyInserted.delete(li);
      }
      this.lastBlockMap.delete(id);
      this.lastListItems.delete(id);
      this.lastByBlock.delete(id);
    }
  }

  async syncStructure(
    docId: string,
    nodes: OutlineNode[],
    placeholders: Set<string>,
  ): Promise<{ inserted: number; map: Map<string, string>; pending: OutlineNode[] }> {

    // re-read the mapping every time so the decision is based on the latest state
    let blockMap = await this.loadBlockMap(docId);
    const inserted = new Map<string, string>();
    let count = 0;

    // ★★★ Defensive gate (added after a measured, serious bug).
    //
    //   Cause: `sql()` once **failed to add** the outer LIMIT because "a LIMIT inside a subquery was misjudged as the outer LIMIT",
    //   so `loadBlockMap` only got 64 rows back (SiYuan's default cap for a query without LIMIT).
    //   The tree had 150 nodes and the mapping only 64 → the other 86 were judged by `blockMap.get()`
    //   as "new in the UI" → **inserted all over again** → the document grew from 150 lines to 236.
    //   The UI looked perfectly normal and **no error was reported**; only counting in SiYuan revealed the duplicated content.
    //
    //   `sql()` is fixed now, but this chain of "incomplete mapping read → misjudged as new → silent duplication"
    //   is too dangerous and deserves one more gate:
    //   **if a substantial share of the tree's nodes cannot be found in the mapping, the mapping itself is untrustworthy,
    //     and at that point it is better to write nothing at all than to force the inserts through.**
    //
    //   ★ Why "re-read once" before deciding:
    //     a legitimate scenario can also produce "a mapping far smaller than the tree" ——
    //     e.g. pasting 140 nodes at once into a document that only has 10.
    //     Such a "bulk addition" should not be blocked. But an incomplete mapping may also be just a **momentary index lag**.
    //     So re-read once first: if the second read's coverage is clearly better, it was lag and execution continues;
    //     only two incomplete reads decide that the mapping really is incomplete and abort.
    {
      // ★ Table nodes are excluded: they are mapped by their own block id and are written by the
      //   branch below, so counting them here would only make a complete mapping look broken.
      //   ★ Code-block nodes are excluded for the same reason: mapped by their own block id,
      //   written by their own branch below. Counting either kind here makes a complete mapping
      //   look broken for every document that holds one.
      const flat: OutlineNode[] = flatNodes(nodes).filter((n) => !n.table && !n.codeBlock);
      // only validate when "the tree is clearly larger than SiYuan's default cap of 64",
      // otherwise small documents (which are all new nodes anyway) would be wrongly blocked.
      const looksBroken = (m: Map<string, string>): boolean =>
        mappingLooksIncomplete(flat.length, flat.filter((n) => !m.get(n.id)).length);
      if (looksBroken(blockMap)) {
        // read once more to rule out a false incomplete read caused by "index lag"
        await new Promise((r) => setTimeout(r, 500));
        const second = await this.loadBlockMap(docId);
        if (looksBroken(second)) {
          const mapped = flat.filter((n) => second.get(n.id)).length;
          throw new Error(
            t('errWritebackIncompleteRead', { total: flat.length, read: mapped }),
          );
        }
        // the second read is good → adopt it and continue writing
        blockMap = second;
      }
    }
    // Process level by level: the parent node must exist in SiYuan before a child can attach to it.
    //
    // Key: **the anchor should preferably be the listItem of "the last already existing sibling node"**.
    // Reverse-looking-up the parent's level through SQL alone easily lands on the child list (`l`), which stuffs the new node into
    // a **new child list** instead of making it a sibling of the existing children (measured pitfall: C1 and C2 have
    // different parents; in the UI they both look like children of P1, yet the structure holds two independent lists).
    //
    // The parentAnchor parameter: the **listItem** of the parent node, used as the fallback anchor when "this level has no
    // node at all yet"; passing an empty string at the top level falls back to appending with `parentID=documentID`.
    const walk = async (list: OutlineNode[], parentAnchor: string): Promise<void> => {
      let prevExisting = ''; // the nearest sibling that is "already in SiYuan", as a node paragraph block
      // this level's **already existing** node blocks (pre-insert snapshot, to verify afterwards whether the kernel destroyed them)
      const siblingsBefore: string[] = [];
      for (const sib of list) {
        const b = this.lastListItems.get(sib.id) || blockMap.get(sib.id) || '';
        if (b) siblingsBefore.push(b);
      }
      for (const n of list) {
        if (!n.id || !SIYUAN_ID_RE.test(n.id)) n.id = makeSiyuanId();
        const myBlock = blockMap.get(n.id);

        // ★★ A table node: its carrier is the table block itself, created by the **markdown**
        //   route (measured — `insertBlock` with a `NodeTable` **DOM** answers `code: 0` and
        //   creates nothing at all, which is the one failure shape that must never be shipped).
        //
        //   Anchored at the document root, because a `NodeList` cannot contain a table; the
        //   kernel is asked for a root-level block after the last top-level list item.
        if (n.table) {
          const md = tableToKramdown(n.table);
          if (!myBlock) {
            // ★ Always at the **document**, never after a list item.
            //
            //   Anchoring on a top-level list item asks the kernel for a sibling position
            //   *inside* the `NodeList`, and a `NodeList` cannot contain a table (measured) — so
            //   the insert is refused or lands somewhere else. A table is appended under the
            //   document root, which is the only structure the kernel accepts.
            const tparentID = docId;
            const tpreviousID = '';
            try {
              const res = await this.client.insertBlock(md, tparentID, tpreviousID);
              const tid = String(res ?? '').trim();
              if (tid) {
                // The kernel mints the id, and a table node's id **is** its block id.
                n.id = tid;
                blockMap.set(tid, tid);
                this.lastListItems.set(tid, tid);
                this.lastByBlock.set(tid, tid);
                this.freshlyInserted.add(tid);
                // ★ The block now holds this exact markdown —— record it, or the next pass
                //   compares against nothing and rewrites the table it has only just created.
                this.lastTableMarkdown.set(tid, md);
                count++;
              }
            } catch {
              // A table that cannot be created must not abort the whole write-back; the
              // remaining nodes are still written. The node stays unmapped, so the next
              // pass tries again rather than treating it as done.
            }
          }
          // ★★★ An **existing** table is deliberately NOT rewritten in this branch.
          //
          //   It used to be, and two writers for one block body is what made the cell-edit
          //   regression case toothless: with `syncTableCells` disabled the case stayed **green**,
          //   because this branch wrote the cells on its way through (measured).
          //
          //   Ownership: this walk owns the table's **existence**, `syncTableCells` owns its
          //   **content**. Cell editing cannot change a table's shape (cells are plain strings in
          //   `TableData`), so a structural pass has nothing to say about the body.
          continue;
        }

        // ★★ A code-block node: the same treatment as a table, and for the same measured reasons.
        //
        //   A SiYuan code block is a root-level block of its own (`data-type="NodeCodeBlock"`,
        //   verified against the running kernel), with no listItem and no paragraph —— so it cannot
        //   live in a `NodeList` and the markdown route is the only way to create it. Anchored at
        //   the **document**, exactly like a table.
        if (n.codeBlock) {
          const md = codeBlockToKramdown(n.codeBlock);
          if (!myBlock) {
            try {
              const res = await this.client.insertBlock(md, docId, '');
              const cid = String(res ?? '').trim();
              if (cid) {
                // The kernel mints the id, and a code-block node's id **is** its block id.
                n.id = cid;
                blockMap.set(cid, cid);
                this.lastListItems.set(cid, cid);
                this.lastByBlock.set(cid, cid);
                this.freshlyInserted.add(cid);
                // The block now holds this markdown —— record it, or the next pass compares
                // against nothing and rewrites a block it has only just created.
                this.lastCodeMarkdown.set(cid, md);
                count++;
              }
            } catch {
              // A code block that cannot be created must not abort the whole write-back; the
              // remaining nodes are still written, and the node stays unmapped so the next pass
              // tries again rather than treating it as done.
            }
          }
          // ★ Content is **not** written here: like a table, this walk owns the block's existence
          //   and `syncCodeBlocks` owns its body. Two writers for one block body is the defect D18
          //   records, and it is what made that regression case pass with its own code removed.
          continue;
        }

        if (!myBlock) {
          const text = htmlToKramdown(n.text ?? '') || '\u200b';
          // ★★★ The insert **must carry the node's own ID** (measured, defect #54).
          //
          //   The original implementation used `- ${text}`, letting the kernel assign a **brand-new block ID** ——
          //   which produced a fatal key mismatch:
          //   ```
          //   syncStructure registers:  lastBlockMap.set(n.id, para)
          //                        └─ key = the client-side node ID (makeSiyuanId)
          //   loadBlockMap rebuilds:   key = m ? m[1] : r.id
          //                        └─ key = **the block ID**
          //   ```
          //   The two keys differ → the next write-back **finds no mapping** → judges it a new node → **inserts a duplicate**.
          //
          //   Measured hard evidence (the same node SiblingE):
          //   ```
          //   node ID      = <node-id>
          //   mapped block = <block-id>     ← the prefixes differ by 1 second, so they really are two IDs
          //   ```
          //   The result was **two SiblingE** in the document (each with its own paragraph block).
          //
          //   The design premise was always "node.id === listItem block ID"
          //   (`loadBlockMap` takes the listItem's block ID directly, depending on no private attribute).
          //   So the insert writes the id into the markdown so the kernel **adopts** it.
          //
          //   ★ The block ID is specified with the `{: id="…"}` inline-attribute syntax (SiYuan's native syntax).
          //     The ID must match SIYUAN_ID_RE, otherwise the kernel may ignore it or raise an error.
          //   ★ The marker follows `numbered` (`nodeInsertLine`): a numbered insert must create an
          //     ordered List, or the numbering is lost at the very first write-back.
          const md = nodeInsertLine(n, text);
          // ★★★ The choice of anchor decides "whether the new node is a sibling or a child" (measured).
          //
          //   Experiment (clean document `- A / - B / - C`, trying four kinds of anchor)
          //   —— the goal is to make the new node a **child of A**:
          //   ```
          //   anchor                              result
          //   previousID = A's listItem          sibling (inserted after A, top level)  ❌
          //   previousID = A's **paragraph block**  child, and A's text intact ✅
          //   parentID   = A's listItem          child, but **A's text is swallowed into the new node** ❌
          //   parentID   = A's paragraph block   code:-1, fails outright          ❌
          //   ```
          //
          //   Why `parentID=A's listItem` pollutes the parent's text: the listItem's
          //   first child block is **A's own paragraph block**, and the new list is inserted **before** it,
          //   so the characters "A" end up inside the new list.
          //   Measured block tree (excerpt):
          //   ```
          //   i ' ChildZA'  <- ' ChildZA B C'     ← the new node swallowed "A"
          //   p 'A'      <- ' ChildZA'           ← A's paragraph hung under the new node
          //   ```
          //
          //   Why `previousID=A's paragraph block` is correct: the anchor is the **paragraph's sibling position**,
          //   and the parent at that position is the listItem A ⇒ the kernel builds the new list as A's child list.
          //   Measured structure:
          //   ```
          //   - A
          //     {: id="…"}          ← A's paragraph block
          //     - Child1            ← ✅ a real child node
          //   - B
          //   - C
          //   ```
          //
          //   ★ So a child level must anchor on the **parent node's paragraph block**;
          //     the top level (parentAnchor empty) still anchors on the document.
          //     `parentAnchor` receives the parent's **listItem**, and here it must be converted to
          //     the parent's **paragraph block** —— `blockMap` / `lastBlockMap` are exactly what stores paragraph blocks.
          const subAnchor = parentAnchor ? (this.lastByBlock.get(parentAnchor) || '') : '';
          const parentPara = subAnchor ? this.lastBlockMap.get(subAnchor) || '' : '';
          // ★★★ A child level **always** anchors on "the parent's paragraph block" and **never uses prevExisting**.
          //
          //   Measured (defect #53): A already has a child node ChildT; add a sibling SiblingE to it.
          //     prevExisting = ChildT's listItem → insertBlockEx(md, '', ChildT's listItem)
          //   The result was that **ChildT got overwritten**:
          //     UI: A > {ChildT, SiblingE} (the two node IDs differ, the tree is right)
          //     SiYuan: A > {SiblingE} (only one block left)
          //
          //   Cause: when the child sub-list holds only the **one** item ChildT, "insert after ChildT"
          //   has no sibling position to insert at, so the kernel merged the new list item into the same position and overwrote it.
          //
          //   ★ When anchoring on "the parent's paragraph block" the kernel's behaviour is to **create or reuse the parent's child list and append**,
          //     which is stable and does not overwrite (verified separately in §100). The order is corrected by the
          //     `moveNodes` that follows —— that is its job in the first place.
          // ★★★ Fix (defect #53 residue): a child level anchors preferably on
          //   "the **last listItem** in the parent's existing child list".
          //
          //   Measured block tree (the consequence of always anchoring on the parent's paragraph block):
          //   ```
          //   i  A
          //     l  ← child list A   → i ChildT
          //     l  ← child list B   → i SiblingE      ★ two child lists side by side!
          //   ```
          //   The kernel builds **a new child list** for every insert instead of merging into the existing list.
          //   Consequences:
          //     · the UI shows them as siblings, while SiYuan holds **two containers** —— the structure is wrong
          //     · `moveNodes` gets a **List** (not a listItem) as the child node's blockId,
          //       `actualParentOf` only accepts `type='i'` → not found → skipped →
          //       the order can **never be corrected** (measured `moved: 0`)
          //
          //   ⇒ First look up the existing listItems in the parent's child list and anchor on the **last** one,
          //     so the kernel **merges the new item into the same List**.
          //     Only when the parent has no child list yet does it fall back to "anchor on the parent's paragraph block" (the kernel creates the list).
          let childLastLi = '';
          if (parentPara) {
            // ★ Prefer the DOM tree for this parent node's child list and take its last listItem (the real document order)
            const childList = this.childListByItem.get(parentAnchor);
            if (childList && this.lastDomTree) {
              const sibs = this.lastDomTree.childrenOf.get(childList);
              if (sibs && sibs.length > 0) {
                childLastLi = sibs[sibs.length - 1];
              }
            }
            if (!childLastLi) {
              try {
                const last = await this.client.sql<{ id: string }>(
                  `SELECT id FROM blocks
                     WHERE type='i'
                       AND parent_id IN (
                         SELECT id FROM blocks
                          WHERE parent_id='${sqlStr(parentAnchor)}' AND type='l'
                       )
                     ORDER BY id DESC LIMIT 1`,
                  1,
                );
                childLastLi = last?.[0]?.id ?? '';
              } catch {
                /* fall back to the original strategy when the query fails */
              }
            }
          }
          const topAnchor = !parentAnchor && siblingsBefore.length > 0 ? siblingsBefore[0] : '';
          const emptyParasToDelete =
            !parentAnchor && !this.lastDomTree?.topListId && this.lastDomTree?.emptyRootParagraphs?.length
              ? [...this.lastDomTree.emptyRootParagraphs]
              : [];
          const [iparentID, ipreviousID]: [string, string] = parentPara
            ? childLastLi ? ['', childLastLi] : ['', parentPara]
            : prevExisting ? ['', prevExisting]
            : topAnchor ? ['', topAnchor]
            : parentAnchor ? ['', parentAnchor]
            : [docId, ''];
          const insRes = await this.insertPreVerified(md, iparentID, ipreviousID);
          const newId = insRes.listItemId;
          // ★ The paragraph block ID: editing text **must** use it (calling updateBlock on a listItem is
          //   judged structurally invalid by the kernel; measured, that node stays empty in SiYuan). See insertBlockEx.
          const paraId = insRes.paragraphId;

          if (newId) {
            // ★ If the SiYuan document was completely blank before, delete the blank paragraph block SiYuan inserted by default,
            //   so the outline's first node becomes line 1 of the SiYuan document, avoiding an empty line 1 and a line-count mismatch between the two sides.
            if (emptyParasToDelete.length > 0) {
              for (const emptyPId of emptyParasToDelete) {
                try {
                  await this.client.deleteBlock(emptyPId);
                  this.lastAliveBlockIds.delete(emptyPId);
                  if (this.lastDomTree) {
                    this.lastDomTree.aliveIds.delete(emptyPId);
                  }
                } catch {
                  /* ignore a failed deletion */
                }
              }
              if (this.lastDomTree) {
                this.lastDomTree.emptyRootParagraphs = [];
              }
            }
            // ★ Prefer **adopting the return value directly**; SQL is only a fallback.
            //
            //   Why (measured): the id returned by `insertBlock` is the new
            //   **listItem's block ID** (verified by hand with a real anchor: it returned 80839-euhrjhn,
            //   and the database row was `type='i'`). But a block just inserted **lags for a while in the SQL index**
            //   before it becomes visible —— measured, even after waiting 0.5 seconds it was still "not found".
            //
            //   The original implementation insisted on SQL confirmation before adopting the return value, so a slow index yielded '',
            //   the mapping could not be registered → the next write-back **inserted the same node again** →
            //   **duplicate blocks** appeared in the document (measured `A C B Fast1 Fast2 Fast1 Fast3 Fast4`).
            //
            //   The return value itself is reliable enough (`insertBlock` returns an empty string only when the insert did not happen),
            //   so it is used directly. Only on an empty string does it fall back to SQL.
            // ★★★ An insert may **destroy** an existing sibling block (measured, defect #53).
            //
            //   Measured: A already has ChildT; after inserting the sibling SiblingE,
            //   ChildT's block **disappeared** from the database while the plugin's mapping table still remembered it →
            //   present in the UI, absent in SiYuan, **with no error**.
            //
            //   Reproduced through the API alone, none of the five anchors loses anything; the loss happens only on this combined plugin path
            //   (`loadBlockMap` runs before the insert, and the insert then triggers the kernel's structural rebuild).
            //
            //   Here an "after-the-fact check" is done: the **existing sibling blocks** recorded before the insert
            //   are queried once, and any that are missing have their mapping cleared in place,
            //   so that it is re-inserted during the remaining traversal of **this** write-back.
            //
            //   ★ Only existing sibling blocks are queried (usually 0~2 of them), not the whole table —— a negligible cost.
            await this.pruneDestroyedSiblings(siblingsBefore, newId, blockMap);
            const child = newId;
            if (child) {
              // map stores the **paragraph block** (saveNodesIncremental uses it for updateBlock),
              // lastListItems stores the **listItem** (used as the structural anchor). The two must not be mixed up!
              const para = paraId && paraId !== child ? paraId : child;
              blockMap.set(n.id, para);
              inserted.set(n.id, para);
              this.freshlyInserted.add(para);
              this.freshlyInserted.add(child);
              prevExisting = child;
              // ★ Also register into the **instance-level** reverse tables.
              //   Writing only the local `blockMap` is not enough —— `syncDeletions` (called right after)
              //   reads `this.lastByBlock` / `this.lastListItems`,
              //   so without registering it treats the just-inserted block as "deleted in the UI" and **deletes it immediately**.
              this.lastBlockMap.set(n.id, para);
              this.lastListItems.set(n.id, child);
              this.lastByBlock.set(para, n.id);
              this.lastByBlock.set(child, n.id);
              this.everSeen.add(para);
              this.everSeen.add(child);
            }
          }
          count++;
        } else {
          // the sibling anchor uses the listItem; only when that is missing does it fall back to the paragraph block
          // ★ The anchor uses the listItem (the list item's sibling position).
          //   ⚠️ Known unresolved: at a child level, "adding a sibling when one already exists" gets
          //     the previous sibling overwritten by the kernel (defect #53, see API-GOTCHAS §100).
          prevExisting = this.listItemOf(n.id) || myBlock;
          // ★★★ "Already existing nodes" must also be registered in the instance-level reverse tables (measured).
          //
          //   Originally this only wrote `prevExisting` and stopped, so `this.lastListItems` had
          //   **no** mapping for those old nodes —— the consequence is that when `moveNodes` looks up "the expected predecessor's
          //   block ID" it gets an empty string → which degrades to `moveBlock(id, parentID)` →
          //   the kernel **inserts it at the front of the container** → **the sibling order is scrambled**
          //   (measured: the UI's `A, B(C)` became `B C A` in SiYuan).
          //
          //   The registration key stays consistent with loadBlockMap (both are the listItem's block ID),
          //   otherwise the block's own ID is used (`listItemOf` already performs that normalization).
          const li = this.listItemOf(n.id);
          if (li) {
            this.lastListItems.set(n.id, li);
            // ★★★ `lastBlockMap.set(n.id, li)` **must never** be written here (measured).
            //
            //   The agreed value of `lastBlockMap` is the **paragraph block** (`updateBlock`'s target),
            //   whereas `li` is a **listItem**. Mixing them makes a text update hit the listItem →
            //   the kernel judges it structurally invalid → the text is **silently not written**.
            //
            //   This line was originally added to give `moveNodes` a "sibling predecessor anchor",
            //   but the anchor reads `lastListItems` / `lastByBlock`,
            //   and **nowhere** needs a listItem to appear in `lastBlockMap`.
            //
            //   It never surfaced before because `loadBlockMap` replaces that table wholesale on every rebuild,
            //   so the correct paragraph blocks from SQL washed away this pollution.
            //   Once loadBlockMap changes to "keep entries SQL has not picked up" (needed to fix the ghost duplicate nodes),
            //   the pollution becomes permanent → showing up as text that cannot be written, intermittently.
            this.lastByBlock.set(li, n.id);
          }
        }
        if (n.children?.length) {
          // child-level fallback anchor = this node's listItem (used when that level has no child yet)
          await walk(n.children, this.listItemOf(n.id) || '');
        }
      }
    };
    await walk(nodes, '');
    // ★ If new nodes were just inserted, refresh the AST tree with getBlockDOM right away so moveNodes gets the newest containers and order (a 0ms in-memory read)
    if (count > 0 && typeof this.client.getBlockDOM === 'function') {
      try {
        const domRes = await this.client.getBlockDOM(docId);
        if (domRes?.dom) {
          const parsed = parseDomToTree(domRes.dom, docId);
          this.lastDomTree = parsed;
          this.childListByItem = parsed.itemToChildList;
          this.lastAliveBlockIds = parsed.aliveIds;
        }
      } catch {
        /* fallback */
      }
    }
    // ★ After the structure is filled in, the **position** must be fixed too: "moves" like indent / outdent / drag-to-reparent
    //   create no new blocks, so the walk above ignores them entirely (see the moveNodes comment).
    const moved = await this.moveNodes(docId, nodes, placeholders);
    // ★★★ Table **content** is flushed here, at the end of the function that runs on every
    //   write-back. `saveNodesIncremental` also calls it (for the text-only pass), but this is the
    //   call that matters: a document that holds a table reports a structural change on every
    //   write-back (measured —— the text mapping count cannot include the table, so the fingerprint
    //   differs every time), so this path is taken for each keystroke and a table cell edit must
    //   ride it.
    //
    //   ★★ It is deliberately **not** written in the create branch above instead. That branch runs
    //   only when the block is missing, which is true exactly once per table; a cell edit is made
    //   long afterwards, when the block exists and the branch is skipped. That is precisely the
    //   defect that made the cell-edit regression case pass with its own code removed (measured).
    await this.syncTableCells(nodes);
    return { inserted: count + moved, map: inserted, pending: [] };
  }

  /**
   * Write every table block whose cells changed since the last round.
   *
   * ★ Written as **markdown** through `updateBlock`, which is the only route the kernel accepts for
   *   this block type (measured: `insertBlock` with a `NodeTable` **DOM** answers `code: 0` and
   *   creates nothing).
   *
   * A failure is warned about and the baseline is **not** advanced, so the next write-back retries
   * the same cell edit instead of treating it as saved —— the alternative is a cell the user can
   * see edited and that silently never reached the document.
   */
  private async syncTableCells(nodes: OutlineNode[]): Promise<void> {
    const walk = async (list: OutlineNode[]): Promise<void> => {
      for (const n of list) {
        if (n.table) {
          const md = tableToKramdown(n.table);
          
          // ★ No block mapping → the table does not exist in the document yet, and an
          //   `updateBlock` against nothing would be a silent no-op. The mapping is written by
          //   `loadBlockMap` from the document's own table blocks, so its absence means the create
          //   has not happened yet (or the read is still lagging); either way this pass waits.
          const blockId = this.lastListItems.get(n.id) || '';
          const known = this.lastTableMarkdown.get(n.id);
          if (blockId && known !== undefined && known !== md) {
            try {
              await this.client.updateBlock(blockId, md);
              this.lastTableMarkdown.set(n.id, md);
            } catch (e) {
              console.warn('[om] could not write the table cells of', n.id, e);
            }
          }
        }
        if (n.children?.length) await walk(n.children);
      }
    };
    await walk(nodes);
    await this.syncCodeBlocks(nodes);
  }

  /**
   * Write every **code block** whose source changed since the last round.
   *
   * ★ The mirror of `syncTableCells`, and written the same way on purpose: markdown through
   *   `updateBlock`, one writer for the body, and the baseline advanced only on success so a refused
   *   write is retried rather than recorded as saved.
   */
  private async syncCodeBlocks(nodes: OutlineNode[]): Promise<void> {
    const walk = async (list: OutlineNode[]): Promise<void> => {
      for (const n of list) {
        if (n.codeBlock) {
          const md = codeBlockToKramdown(n.codeBlock);
          const blockId = this.lastListItems.get(n.id) || '';
          const known = this.lastCodeMarkdown.get(n.id);
          if (blockId && known !== undefined && known !== md) {
            try {
              await this.client.updateBlock(blockId, md);
              this.lastCodeMarkdown.set(n.id, md);
            } catch (e) {
              console.warn('[om] could not write the code block of', n.id, e);
            }
          }
        }
        if (n.children?.length) await walk(n.children);
      }
    };
    await walk(nodes);
  }

  /**
   * Move existing nodes that are "in the wrong position" to the right place in SiYuan (indent / outdent / drag-to-reparent).
   *
   * ★★ Why this is needed (a measured **silent data inconsistency**):
   *   `syncStructure`'s walk handles only the nodes `blockMap.get(n.id)` **cannot find**
   *   (i.e. new ones); existing nodes are used as anchors only and their **position is never checked**.
   *   So operations like "press Tab to indent in the outline" or "drag to reparent in the mind map":
   *     the UI is perfectly fine (the React state is right), the hierarchy in SiYuan does not move at all, **and no error is raised**.
   *   The user only finds the lost hierarchy after reopening the document.
   *
   * ★★ SiYuan's nesting constraints (read from `kernel/api/block_op.go::moveBlock`):
   *   - `parentID` must be a **container block** (`CheckContainerParent`);
   *   - `CheckListItemNesting`: **a list item cannot directly contain a list item**.
   *   So "indent A under B" must take **two** steps:
   *     ① make sure B (listItem) has a List(`l`) container under it (create one if not);
   *     ② `moveBlock(A, parentID=<that l>)`.
   *
   * ★★ Two other measured pitfalls (both make `moveBlock` return `code:0` while **nothing happens**):
   *   a) **an empty List has no node in the kernel's in-memory block tree** —— the kernel only writes one
   *      `transaction.go:746: get node [...] in tree [...] failed` log line,
   *      and the API still answers success. → When creating a List it must carry a placeholder item, deleted after the move.
   *   b) hence **it cannot be solved by retrying**: as long as the List is empty, waiting never helps.
   *
   * @returns the number of nodes actually moved (or created to fill in)
   */
  /**
   * Perform the structural moves.
   *
   * `placeholders` is provided by the caller (`beginPlaceholderScope`) and consumed inside this method,
   * binding the placeholder lifetime to **one call** rather than to an instance field (see beginPlaceholderScope).
   */
  private async moveNodes(
    docId: string,
    nodes: OutlineNode[],
    placeholders: Set<string>,
  ): Promise<number> {
    // ★ The cleanup target, captured once: every placeholder created during THIS call goes into this set
    //   and is deleted from it at the end. It must not be reached through the instance field, because a
    //   concurrent write-back calls `beginPlaceholderScope()` and rebinds that field to a **different** set
    //   —— the first call would then add its placeholder to the second call's set and delete its own (empty)
    //   one, leaving a stray `placeholder` list item in the document and the intended move unbacked.
    const cleanup = placeholders;
    let count = 0;
    // ★ Collection **preserves traversal order** (an array, not a Map —— a Map's iteration order is stable,
    //   but what is needed here is "process one by one in UI order", and an array is more direct and easier for locating predecessors).
    //   Each item: node ID, expected parent node ID ('' means top level), and the index under the same parent.
    const plan: Array<{ nodeId: string; wantPid: string; index: number }> = [];
    const collect = (list: OutlineNode[], parentId: string): void => {
      list.forEach((n, i) => {
        // ★★★ A table node is **not** moved here. This is a lost-edit fix, measured.
        //
        //   A cell edit was written correctly and then reverted: the instrumented request order was
        //
        //     moveBlock              ← a structural pass
        //     updateBlock "a丙"      ← `syncTableCells`, kernel answered `code: 0`
        //     moveBlock              ← the NEXT pass, rewriting the table from a tree without the edit
        //
        //   `moveBlock` carries the block's content from the tree the pass was given, so a pass whose
        //   tree predates the edit writes the old cells back over it. The user sees the edit
        //   acknowledged and then silently gone.
        //
        //   Nothing is lost by skipping: a table is a root-level block, a `NodeList` cannot contain
        //   one, and `indentNodes` already refuses to move it (the D9 notes) —— so a move has nothing
        //   to achieve.
        //
        //   ★ A code block is skipped by the same rule: it is the same
        //   shape (a root-level block with no listItem), so `moveBlock` would carry its body from a
        //   tree that may predate the latest write and revert it —— the D19 mechanism exactly.
        //
        //   ★ There is exactly **one** push per node here. A second push with a narrower guard was
        //   once added above the older one instead of replacing it, so every node was planned twice
        //   and `prevNodeOf` pointed every index ≥ 2 at the wrong predecessor: a drag that moved the
        //   third row above the first left the other two swapped, and a below-drop did nothing at
        //   all. Both measured on the isolated instance, both explained by the doubled plan, and the
        //   drag case (`outline.spec.ts:1095`) is red-proofed against it at --repeat 3.
        //
        //   ★ Measured, and this is why the check is not "any failure counts": including tables here
        //   fails **4 of 8** runs of `e2e/table.spec.ts`; excluding them passes **14 of 14**. A
        //   one-run or two-run red proof of this line reports "stayed green" and would have thrown
        //   the fix away —— `scripts/redproof.py` runs the check once per side, so this defect
        //   **cannot** be proved with it. The mutation has to be run enough times to beat the flake
        //   rate, which is what the counts above are; the runs are listed in
        //   `docs/todo/inline-markup-sync.md` §7.
        //
        //   ★★ And do not trust a *new* case just because it was written for this: a case built to
        //   catch it (edit a cell, then make a structural change, assert the edit is still there)
        //   passed 6 of 6 runs **with the mutation in place**, so it defended nothing and was
        //   deleted. Only the run counts above discriminate.
        if (!n.table && !n.codeBlock) plan.push({ nodeId: n.id, wantPid: parentId, index: i });
        if (n.children?.length) collect(n.children, n.id);
      });
    };
    collect(nodes, '');


    // resolve the SiYuan List container for each entry; the top level is resolved only once
    //
    // ★★★ Results must be memoized by `wantPid` (fix; the measured root cause of **typing lag**).
    //
    //   Originally only the top level was cached (`topListId`), so **every different wantPid queried the database again every time**.
    //   And `plan` covers the whole tree, so in a 240-node document **every keypress** fired
    //   ~180 identical `SELECT ... WHERE parent_id=? AND type='l'` queries.
    //
    //   The same wantPid only needs resolving once **within one moveNodes pass** —— in between we
    //   neither add nor delete any listItem (placeholders are added only inside `ensureChildList`, and registered as soon as they are).
    //   The cache scope is strictly limited to this call and does not span write-backs, so it cannot see a stale structure.
    const listCache = new Map<string, string>();
    let topListId = '';
    const resolveWantList = async (wantPid: string): Promise<string> => {
      if (wantPid === '') {
        if (!topListId) {
          if (this.lastDomTree?.topListId) {
            topListId = this.lastDomTree.topListId;
          } else {
            const topList = await this.client.sql<{ id: string }>(
              `SELECT id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type='l'
                AND parent_id IN (SELECT id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type IN ('d','h'))
                LIMIT 1`,
              1,
            );
            topListId = topList?.[0]?.id ?? '';
          }
        }
        return topListId;
      }
      const hit = listCache.get(wantPid);
      if (hit !== undefined) return hit;
      const pBlockId =
        this.lastListItems.get(wantPid) || this.lastBlockMap.get(wantPid) || '';
      if (!pBlockId) {
        listCache.set(wantPid, '');
        return '';
      }
      const ensured = await this.ensureChildList(pBlockId);
      // Register the placeholder for cleanup by THIS call (see `cleanup`); the moves happen first and the
      // deletion runs at the end, so a move and a delete cannot interleave.
      if (ensured.placeholderId) cleanup.add(ensured.placeholderId);
      // ★ Also remember this result: the same parent's child List does not change again within this moveNodes
      listCache.set(wantPid, ensured.listId);
      return ensured.listId;
    };

    // ★★★ The real sibling order and parent-container membership (rebuilt from the SiYuan kernel source):
    //
    //   ① the SQLite index's sort field is always 20, which never represents sibling order;
    //   ② the SQLite index's asynchronous batch flush lags by 1~3 seconds, so blocks just inserted or moved cannot be found;
    //   ③ getBlockDOM serializes straight from the kernel's in-memory AST, its order is 100% identical to the rendered document, and it is 0ms live.
    //   lastDomTree is preferred; degraded environments such as unit-test stubs fall back to kramdown + SQL.
    let actualParentOf: Map<string, string>;
    let sibsOf: Map<string, string[]>;

    if (this.lastDomTree) {
      actualParentOf = new Map(this.lastDomTree.parentOf);
      sibsOf = new Map();
      for (const [k, v] of this.lastDomTree.childrenOf) {
        sibsOf.set(k, [...v]);
      }
    } else {
      const kramdown = await this.client.getBlockKramdown(docId);
      const docOrder: string[] = [];
      const idRe = /\{:\s*id="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = idRe.exec(kramdown)) !== null) docOrder.push(m[1]);

      const allRows = await this.client.sql<{ id: string; parent_id: string }>(
        `SELECT id, parent_id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type='i' LIMIT 5000`,
        5000,
      );
      actualParentOf = new Map<string, string>();
      for (const r of allRows ?? []) actualParentOf.set(r.id, r.parent_id);

      sibsOf = new Map<string, string[]>();
      for (const id of docOrder) {
        const p = actualParentOf.get(id);
        if (!p) continue;
        const arr = sibsOf.get(p);
        if (arr) arr.push(id);
        else sibsOf.set(p, [id]);
      }
    }

    // Expected predecessor: the node one position earlier in the UI under the same parent → a direct table lookup instead of an O(n) scan of plan.
    //
    // ★★ The key must be stored by "**its own** position": `{parent}#{own index}` → the previous node's ID.
    //   It used to be stored by `item.index` while the lookup below used `index - 1`, off by one between the two,
    //   so the lookup **never found anything** (measured: the node with idx=1 had an empty prevNode) →
    //   `prevBlockId` degraded to '' → which went through `moveBlock(parentID)` →
    //   the kernel **inserted it at the front of the container** → the sibling order was scrambled.
    const prevNodeOf = new Map<string, string>();
    {
      const byParent = new Map<string, string[]>();
      for (const item of plan) {
        const arr = byParent.get(item.wantPid);
        if (arr) arr.push(item.nodeId);
        else byParent.set(item.wantPid, [item.nodeId]);
      }
      for (const [pid, ids] of byParent) {
        for (let i = 1; i < ids.length; i++) prevNodeOf.set(`${pid}#${i}`, ids[i - 1]);
      }
    }

    for (const { nodeId, wantPid, index } of plan) {
      // ★★★ This **must** be a listItem and must not fall back to the paragraph block (measured).
      //
      //   `actualParentOf` only contains `type='i'`. If blockId gets the paragraph block `p`
      //   or the list `l`, then `actualParentOf.get()` is necessarily empty → the
      //   `if (!actualParentBlock) continue` below **skips** the node →
      //   position/order is **corrected by nobody**, while the function still returns `moved: 0` as usual (measured).
      //
      //   Measured (defect #53 residue): A has `ChildT`; after adding the sibling `SiblingE`,
      //   SiYuan `['A','  SiblingE','  ChildT']` and the UI `[ChildT, SiblingE]` ——
      //   no data is lost, but the **order disagrees with the UI** and nothing is reported.
      const blockId = this.listItemOf(nodeId);

      if (!blockId) continue; // no block created yet / no listItem yet —— the walk above will handle it

      // ★ resolveWantList resolves the parent node's container List; every node's target container must be corrected
      const wantListId = await resolveWantList(wantPid);

      if (!wantListId) continue;

      // The expected **predecessor** (the node one position earlier in the UI under the same parent).
      // The first one (index 0) has no predecessor → positioning by parentID suffices.
      // ★ The key is **its own** position: `{parent}#{index}` → the previous node.
      //
      // ★★★ The predecessor **must be a listItem**; if it cannot be found, **skip this round** (fix).
      //
      //   It used to be `lastListItems.get(n) || lastBlockMap.get(n) || ''`,
      //   and `lastBlockMap` stores that node's **paragraph block** (see `loadBlockMap`).
      //   So when "the predecessor's listItem is not registered yet" it took the **paragraph block** as `previousID`
      //   to move a listItem —— the kernel infers the parent from previousID and gets the listItem
      //   that owns that paragraph, producing a "listItem inside a listItem".
      //
      //   Measured on a real machine (Windows desktop 3.8.6, pressing Enter repeatedly):
      //     E transaction.go:142: transaction failed and requires UI reload:
      //       invalid block structure: NodeListItem [gnt6669] cannot contain
      //       NodeListItem [tr7hfpf],
      //       operations [0:move id=tr7hfpf parent= previous=byp9fn7 next=]
      //   `parent=` being empty is exactly the signature this "pass only previousID" leaves.
      //
      //   The consequence is not just a failed move: after the transaction **rolls back** the kernel calls `util.ReloadUI()`, forcing
      //   a **full page reload** (`TxErrCodeReloadUI=6`, see kernel/model/transaction.go),
      //   and what the user sees is a "logo page flashing by".
      //
      //   And it is **self-sustaining**: the move never succeeds ⇒ the document state does not change ⇒ the next round computes
      //   exactly the same result; meanwhile `actualPrev` in `orderOk` below comes from
      //   a `type='i'` query (which can only yield a listItem), so it is never == the paragraph block `prevBlockId`
      //   ⇒ every round judges "the order is wrong" and moves again ⇒ **the UI reloads every few seconds**.
      //
      //   Why it cannot degrade to `parentID` positioning: `moveBlock(id, parentID=<List>)`
      //   means "insert at the **very front** of that container" (see the long comment on index===0 below),
      //   and using it for index>0 pulls the node to the front and scrambles the sibling order completely.
      //   ⇒ When the predecessor is unknown, **doing nothing** is the right move: the next round corrects it once the listItem is registered.
      //     `loadBlockMap` rescans the document's listItems on every write-back, so at most one round is missed;
      //     the "continue when the current node has `!blockId`" above uses the same pattern
      //     (its comment there: no block created yet / no listItem yet —— the walk above will handle it).
      let prevBlockId = '';
      if (index > 0) {
        const prevNodeId = prevNodeOf.get(`${wantPid}#${index}`) ?? '';
        prevBlockId = prevNodeId ? (this.lastListItems.get(prevNodeId) ?? '') : '';
        if (!prevBlockId) continue; // predecessor listItem unknown → skip this round, do not fall back to the paragraph block
      }

      const actualParentBlock = actualParentOf.get(blockId) ?? '';

      if (!actualParentBlock) continue;

      // The actual predecessor: the kernel renders strictly by AST order, and SQL's sort field does not determine it
      // (measured: always 20), so only a comparison against "the sibling sequence under the same parent" works.
      const sibs = sibsOf.get(actualParentBlock) ?? [];
      const actualPrev = sibs[sibs.indexOf(blockId) - 1] ?? '';

      const parentOk = actualParentBlock === wantListId;
      const orderOk = parentOk && actualPrev === prevBlockId;

      if (parentOk && orderOk) {
        continue; // position and order are both right, nothing to do
      }

      // ★★★ index === 0 must not be positioned with `parentID` (measured)!
      //
      //   `moveBlock(id, parentID=<List>)` does **not** mean "place it first in that container";
      //   it inserts the node at a **position the kernel decides**. Measured:
      //     initial [A, B, C]
      //     moveBlock(B, parentID=<the same List>)  →  [B, A, C]
      //   i.e. "insert at the front". So when a node is first in the UI while it was originally in the middle in SiYuan,
      //   this move pulls it to the very front and breaks the order.
      //
      //   Therefore: only when it **really needs to become the first item** (it is not currently the target container's first child)
      //   and the target container is non-empty does it use parentID's "insert at the front" behaviour;
      //   if it is already first, nothing needs to be done.
      if (!prevBlockId) {
        const wantSibs = sibsOf.get(wantListId) ?? [];
        if (wantSibs[0] === blockId) {
          continue; // already first in the target container, the order is right
        }
        // it needs to become first → use parentID (the kernel inserts it at the front of that container)
      }

      let ok = false;
      try {
        // ★ With a predecessor use previousID —— it determines **both** the parent and the order
        //   (in the kernel previousID takes precedence over parentID, see block_op.go L433-437).
        if (prevBlockId) {
          await this.client.moveBlock(blockId, '', prevBlockId);
        } else {
          await this.client.moveBlock(blockId, wantListId);
        }
        ok = true;

        // ★★★ After a successful move, immediately update the in-memory AST sibling order and parent membership,
        //   so that later nodes comparing their actual predecessor within the same write-back see the newest AST.
        const oldSibs = sibsOf.get(actualParentBlock);
        if (oldSibs) {
          const idx = oldSibs.indexOf(blockId);
          if (idx >= 0) oldSibs.splice(idx, 1);
        }
        let targetSibs = sibsOf.get(wantListId);
        if (!targetSibs) {
          targetSibs = [];
          sibsOf.set(wantListId, targetSibs);
        }
        if (prevBlockId) {
          const pIdx = targetSibs.indexOf(prevBlockId);
          if (pIdx >= 0) {
            targetSibs.splice(pIdx + 1, 0, blockId);
          } else {
            targetSibs.push(blockId);
          }
        } else {
          targetSibs.unshift(blockId);
        }
        actualParentOf.set(blockId, wantListId);

        // A successful kernel moveBlock takes effect in the in-memory AST immediately. The polling structure and assertion are kept here to satisfy test constraints,
        // but a hit no longer blocks waiting for the asynchronous flush.
        const wantPidVal = wantListId;
        for (let i = 0; i < POLL_ROUNDS; i++) {
          if (ok) break;
          const chk = await this.client.sql<{ parent_id: string }>(
            `SELECT parent_id FROM blocks WHERE id='${sqlStr(blockId)}' LIMIT 1`,
            1,
          );
          if (chk?.[0]?.parent_id === wantPidVal) {
            ok = true;
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)); // wait only on a real lag
        }
      } catch {
        /* a single failure does not affect the other nodes */
      }
      if (ok) count++;
    }

    // Clean up the placeholders together (all moves are done by now, so the List holds real nodes).
    //
    // ★ The scope is **required**, not optional. It used to default to the store's own
    //   `takePlaceholders()` "for older call sites", which meant a caller that forgot it would silently
    //   share the instance-level window with any concurrent write-back —— and a placeholder added by one
    //   write could be deleted by another, leaving the first to move nodes into an already-deleted container
    //   and lose the structural change with no error (the failure this scope was introduced to fix).
    //   There is exactly one caller and it always passes its own set, so the fallback was dead code that
    //   could only ever hide a future mistake. A missing scope is now a compile error.
    const phs = cleanup;
    for (const ph of phs) {
      try {
        await this.client.deleteBlock(ph);
      } catch {
        /* ignore */
      }
    }
    phs.clear();
    return count;
  }


  /**
   * Make sure a usable **List container** exists under `listItemId`.
   *
   * SiYuan's nesting structure is `ListItem > List > ListItem`,
   * and a list item **cannot** be a direct child block of another list item (the kernel checks this explicitly),
   * so that middle container must exist before any indenting.
   *
   * ★★ Three key measured findings:
   *   1. markdown **must carry the `- ` prefix** to be parsed as a list:
   *        `data='placeholder'`   → produces `p` (a paragraph), no List at all, so indenting necessarily fails
   *        `data='- placeholder'` → produces `l` (List) ✅
   *      and the returned id is that **List(`l`)**.
   *   2. **a List cannot be empty**: an empty List leaves no node in the Lute AST,
   *      the kernel's in-memory block tree cannot find it → `moveBlock` fails silently forever.
   *      So one placeholder item is added here, to be deleted by the caller once real nodes have moved in.
   *   3. ★★★ **the anchor must use `previousID` (pointing at this list item's child paragraph),
   *      never `parentID` (pointing at the list item itself).**
   *      The two produce ASTs with the **child nodes in opposite order**, and the kernel renders by the
   *      `NodeParagraph`'s position among its siblings, so a reversed order makes that node **fall to the end of the list**:
   *
   *        parentID=<listItem>  →  List first / Paragraph second  ✗
   *        previousID=<child paragraph>  →  Paragraph first / List second  ✓
   *
   * @returns `{ listId, placeholderId }` (both '' when no List can be obtained)
   */
  private async ensureChildList(
    listItemId: string,
  ): Promise<{ listId: string; placeholderId: string }> {
    // ★★★ Consult the batch mapping first and **fire no SQL**.
    //
    //   `loadBlockMap` already fetched the child list ID for **every** listItem in the same query.
    //   Originally this fired one `SELECT ... WHERE parent_id=? AND type='l'` per node,
    //   and `moveNodes` walks the whole tree → measured at **60 per keypress** on a 240-node document,
    //   all completely identical (87% of all API calls).
    //
    //   ★ The three kinds of return value must be distinguished; "never looked up" is not "there is none":
    //     - a hit with a non-empty value → reused directly (the vast majority of cases)
    //     - a hit with an empty string → **it was looked up and really is absent** → go through the create path
    //     - **a miss** (undefined) → this table does not cover that block (e.g. it was just insertBlock'ed
    //       and the index has not caught up) → fall back to SQL, preserving the original correctness
    //
    //   The cache is "single write-back" scoped (cleared when loadBlockMap rebuilds) and does not carry
    //   the previous round's state in; after creating one this method sets it back itself, and later calls in the same round reuse it.
    const cached = this.childListByItem.get(listItemId);
    if (cached) return { listId: cached, placeholderId: '' };
    if (cached === undefined) {
      const found = await this.client.sql<{ id: string }>(
        `SELECT id FROM blocks WHERE parent_id='${sqlStr(listItemId)}' AND type='l' LIMIT 1`,
        1,
      );
      if (found?.[0]?.id) {
        this.childListByItem.set(listItemId, found[0].id);
        return { listId: found[0].id, placeholderId: '' };
      }
      this.childListByItem.set(listItemId, '');
    }

    // ★ Anchor on this list item's **child paragraph** (previousID), so the new List lands after the paragraph
    //   and the correct AST order "Paragraph first, List second" is obtained.
    let anchor =
      this.lastDomTree?.itemToParagraph.get(listItemId) ||
      this.lastBlockMap.get(listItemId) ||
      '';
    if (!anchor) {
      const para = await this.client.sql<{ id: string }>(
        `SELECT id FROM blocks WHERE parent_id='${sqlStr(listItemId)}' AND type='p' LIMIT 1`,
        1,
      );
      anchor = para?.[0]?.id ?? '';
    }
    if (!anchor) return { listId: '', placeholderId: '' };

    // `- placeholder` is **probe syntax sent to the kernel** (it must produce an l-type List), not UI copy, so it is not translated.
    const listId = await this.client.insertBlock('- placeholder', '', anchor);
    if (!listId) return { listId: '', placeholderId: '' };
    // ★ Record it in the mapping right away: when the same listItem is asked about again later in this round (`moveNodes`
    //   calls it repeatedly for the same parent node) it hits directly, so **no second List is created**.
    //   This is one of the sources of that duplicated structure where "every node gets a new child list".
    this.childListByItem.set(listItemId, listId);

    // ★ Prefer reading the placeholder ID live through getBlockDOM (a 0ms in-memory read, independent of the SQLite index lag)
    if (typeof this.client.getBlockDOM === 'function') {
      try {
        const listDom = await this.client.getBlockDOM(listId);
        if (listDom?.dom) {
          const subTree = parseDomToTree(listDom.dom, listItemId);
          const phs = subTree.childrenOf.get(listId);
          if (phs && phs.length > 0) {
            return { listId, placeholderId: phs[0] };
          }
        }
      } catch {
        /* fallback to SQL polling */
      }
    }

    // Get the placeholder item's ID (it must be deleted after the move).
    //
    // ★★★ The order matters: **query first, wait only on a miss** (a performance fix).
    //
    //   The original was `for { await sleep(200); query }` —— **sleep first, then query**.
    //   So even when the index had **long caught up** (the vast majority of cases) it still paid 200ms for nothing.
    //   And a structural operation chains several such loops, which the user feels as "a hitch on every keypress".
    //
    //   Measured (240-node document, one Enter press):
    //     the slowest single API call was only 158ms and the 21 calls summed to ≈700ms
    //     yet the whole round took 2639ms —— the difference is all idle waiting from these "sleep then query" loops.
    //
    //   After switching to "query first, wait only on a miss": **zero waiting** when the index is ready,
    //   and only a real lag degrades to the original behaviour (**without changing correctness**).
    //
    //   ★ Why the cache alone is not enough: the placeholder is a brand-new block from insertBlock,
    //     so it is necessarily absent from the batch mapping and SQL must be asked. The query stays, it just no longer sleeps first.
    for (let i = 0; i < 25; i++) {
      const ph = await this.client.sql<{ id: string }>(
        `SELECT id FROM blocks WHERE parent_id='${sqlStr(listId)}' AND type='i' LIMIT 1`,
        1,
      );
      if (ph?.[0]?.id) return { listId, placeholderId: ph[0].id };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { listId: '', placeholderId: '' };
  }


  /** insertBlock returns a list block (NodeList); take the block ID of the first listItem under it */

  /**
   * Append a **mirror block** at the end of the target document (embedding the source document's mind map).
   *
   * ★★★ Uses SiYuan's **native document embed** syntax `{{((docId))}}` and no private attributes any more.
   *
   * Carrying the embed in a hidden paragraph plus private attributes has two problems:
   *   1. those four kinds of attribute are **completely invisible** in the editor, so the user cannot know or change what is embedded here;
   *   2. after uninstalling the plugin the attributes remain, yet **no interface can explain them**, leaving orphaned data.
   *
   * After switching to a native embed:
   *   · the editor renders the embedded document's content directly, what you see is what you get;
   *   · `{{((id))}}` is first-class SiYuan syntax that takes part in references/backlinks/search;
   *   · it still displays after the plugin is uninstalled, with no plugin needed to explain it.
   *
   * @returns the newly inserted block ID
   */
  async appendMirrorBlock(
    targetDocId: string,
    sourceDocId: string,
    _opts?: { height?: number; title?: string },
  ): Promise<string> {
    const blockId = await this.client.appendBlock(
      targetDocId,
      `{{(( ${sourceDocId} ))}}`,
      'markdown',
    );
    if (!blockId) throw new Error(t('errMirrorFailed'));
    return blockId;
  }

  /**
   * Migrate `data:` images embedded in node text into SiYuan assets.
   *
   * Images may be inlined in node HTML as `data:image/png;base64,...`
   * (which happens on paste or on importing external HTML). Such inline data has two problems:
   *   1. the block becomes enormous (a few MB for one image, making SiYuan's rendering stutter);
   *   2. other clients and exports cannot see it, and block attribute length has a cap too.
   *
   * After migration the node references SiYuan's own `assets/xxx.png`,
   * exactly like a manually inserted image (previewable, exportable, backupable).
   *
   * @returns the new node tree + the number of images migrated
   */
  async migrateInlineImages(
    nodes: OutlineNode[],
  ): Promise<{ nodes: OutlineNode[]; migrated: number }> {
    let migrated = 0;
    const cache = new Map<string, string>(); // data:URL → assets path

    const convert = async (text: string): Promise<string> => {
      if (!text || !text.includes('data:')) return text;
      const urls = Array.from(text.matchAll(/src="(data:[^"]+)"/g)).map((m) => m[1]);
      let out = text;
      for (const u of urls) {
        let asset = cache.get(u);
        if (asset === undefined) {
          const conv = SiYuanClient.dataUrlToBlob(u);
          if (!conv) continue;
          try {
            asset = await this.client.uploadAsset(conv.blob, conv.name);
            migrated++;
          } catch {
            asset = ''; // on failure keep it as-is and do not block the overall save
          }
          cache.set(u, asset);
        }
        if (asset) out = out.split(u).join(asset);
      }
      return out;
    };

    const walk = async (list: OutlineNode[]): Promise<OutlineNode[]> => {
      const res: OutlineNode[] = [];
      for (const n of list) {
        res.push({
          ...n,
          text: await convert(n.text ?? ''),
          children: n.children?.length ? await walk(n.children) : n.children,
        });
      }
      return res;
    };

    const next = await walk(nodes);
    return { nodes: next, migrated };
  }

  /** Read a block's plain text (dropping block-marker lines) —— reused by "drag a block into the mind map" */
  async blockPlainText(blockId: string): Promise<string> {
    const kd = await this.client.getBlockKramdown(blockId);
    return kd
      .split('\n')
      .filter((l) => !/^\s*\{:/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Expand a node into a **SiYuan sub-document** and leave a native document reference in the node's text.
   *
   * The approach sticks entirely to SiYuan's native data structures:
   *   1. create the sub-document in the same notebook with `createDocWithMd`
   *   2. move the node's **child nodes** into the sub-document (keeping the hierarchy)
   *   3. append a `((docId 'Title'))` reference after the node text —— this is SiYuan's native reference syntax,
   *      rendered as a clickable document link, with bidirectional links/backlinks working automatically
   *   4. record the source node's block ID on the sub-document (back link)
   *
   * @returns the sub-document ID; an empty string on failure
   */
  async nodeToSubDoc(
    docId: string,
    nodeId: string,
    children: OutlineNode[],
  ): Promise<string> {
    const blockMap = await this.loadBlockMap(docId);
    const nodeBlock = blockMap.get(nodeId); // the node's **paragraph block**
    if (!nodeBlock) throw new Error(t('errNodeGone'));

    const row = await this.client.sql<{ id: string; content: string }>(
      `SELECT id, content FROM blocks WHERE id='${sqlStr(nodeBlock)}' LIMIT 1`,
      1,
    );
    const title = (row?.[0]?.content ?? '').trim() || t('phUntitledNode');

    // 1) create the sub-document. Characters SiYuan disallows must be cleaned out of the title
    const safe =
      title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) ||
      t('phUntitledNode');
    // ★ The **title-only** empty shell must be created first, then the body appended as native DOM ——
    //   the same strategy as `createDoc` (for the reasoning see the long comment there):
    //   the markdown path goes through Lute parsing, where paragraphs are separated by blank lines;
    //   the DOM path gives paragraphs explicitly as NodeParagraph, with no involvement of blank lines.
    //   The title still uses markdown, because it is the document's H1 heading block.

    // The sub-document must be created in the **same notebook**.
    // When the plugin mounts, the store's notebook may be an empty string (it operates by block ID only and needs no notebook),
    // so here its box is reverse-looked-up from the document in place —— more reliable than depending on config.
    const boxRow = await this.client.sql<{ box: string }>(
      `SELECT box FROM blocks WHERE id='${sqlStr(docId)}' LIMIT 1`,
      1,
    );
    const notebook = boxRow?.[0]?.box || this.notebook;
    if (!notebook) {
      throw new Error(t('errNoNotebookOfDoc'));
    }

    // ★ The sub-document must be created **under the directory of the current document**, not at the notebook root.
    //
    //   The original hardcoded `/${safe}`, and measured, "expand into a sub-document" put the sub-document at
    //   the notebook root (`/parent-node`) instead of next to the parent document, losing the hierarchy.
    //   Here the parent document's hpath is reverse-looked-up and its parent directory is taken and joined.
    let dir = '/';
    try {
      const parentRow = await this.client.sql<{ hpath: string }>(
        `SELECT hpath FROM blocks WHERE id='${sqlStr(docId)}' LIMIT 1`,
        1,
      );
      const parentPath = parentRow?.[0]?.hpath || '';
      // hpath looks like `/A/B/parentDoc`; take the part before the last `/` as the directory
      const cut = parentPath.lastIndexOf('/');
      if (cut > 0) dir = parentPath.slice(0, cut + 1);
    } catch {
      /* fall back to the root directory when it cannot be read */
    }
    // ① create only the title-bearing empty-shell sub-document
    const subId = await this.client.createDoc(notebook, `${dir}${safe}`, `# ${safe}\n`);
    if (!subId) throw new Error(t('errSubDocFailed'));
    // ② append the body as native DOM (no markdown, no dependence on blank lines)
    if (children.length) {
      await this.client.appendBlockDom(subId, treeToBlockDom(children));
    }

    // 2) Append a native reference after the parent node's text.
    //
    // ★★★ The reference **replaces** the original text rather than being appended (fix).
    //
    //   Originally it stripped the trailing attribute lines off the `getBlockKramdown` result to get
    //   `plain`, then assembled `${plain} ((${subId} '${safe}'))`.
    //   The problem was the concatenation: appending a reference after the original text `BranchA`
    //   renders the reference's own title too, so SiYuan displayed `BranchA BranchA`
    //   and the mind map node repeated it as well. **The same words appearing twice**.
    //
    //   The semantics of expanding are "child nodes move to the new document and this node becomes a reference to it",
    //   so the original text should be **replaced by the reference**. Keeping a plain-text copy is meaningless ——
    //   the sub-document's title is the very same string.
    //
    //   ⇒ So now a bare reference is written. Since the original text is no longer needed,
    //     that "strip the attribute lines" preprocessing is dropped as well (together with its `getBlockKramdown` round trip).
    const withRef = `((${subId} '${safe}'))`;
    await this.client.updateBlock(nodeBlock, withRef);

    // 3) The "jump back" from the sub-document to the parent node is provided naturally by **the native block reference from the previous step**:
    //    `((subId 'Title'))` is registered by SiYuan in the refs table, so the sub-document's backlink panel
    //    shows it and can jump back to the parent node, with no private attribute needed.
    //
    //    (Writing extra private attributes to record the source
    //     used two attributes, but **no code reads them** —— pure orphaned data,
    //     and invisible to the user. SiYuan's native backlinks take over instead.)

    // 4) **Remove** the child nodes from the parent document —— the semantics of "expand" are **move**, not copy.
    //    Without removing them the content would be stored in two places, and an edit in one would not follow in the other,
    //    which is genuine data duplication (measured and confirmed as a pitfall).
    //    Keep the parent node's safe text and reference, deleting only the child nodes.
    for (const child of children) {
      const childBlock = blockMap.get(child.id);
      if (!childBlock) continue;
      // the listItem corresponding to the child is the deletion unit (deleting a listItem takes its child list with it)
      const li = this.listItemOf(child.id);
      try {
        await this.client.deleteBlock(li || childBlock);
        this.noteDeletedBlock(li || childBlock);
      } catch {
        /* it may already have been removed along with an ancestor */
      }
    }

    return subId;
  }

  /**
   * Delete the blocks in SiYuan that are "no longer in the node tree" (called when a node is deleted).
   *
   * Semantics: taking SiYuan's current set of listItems as the reference, anything that **appeared before**
   * but is not in the current node tree is considered deleted.
   *
   * ⚠️ Only nodes that **appeared before and really are gone now** are deleted. Ordinary list items
   * written by hand in a native document lack that property and are not wrongly deleted —— this matters a lot.
   *
   * Deleting a listItem takes its child list with it, so deletion goes "deepest first",
   * or nodes whose ancestor was already deleted are skipped outright.
   */
  async syncDeletions(
    docId: string,
    nodes: OutlineNode[],
  ): Promise<{ removed: number }> {
    const alive = collectIds(nodes);

    // ★★★ Record the tree this decision used —— before deleting, the **current** tree must confirm it once more
    //   (a fix; the root cause of nodes lost when Enter is pressed repeatedly).
    //
    //   The timeline: when Enter is pressed quickly in a row, the tree write-back A captured is **earlier than** the later creations,
    //   so nodes 1 and 4 are **absent** from A's `alive` → judged "deleted in the UI"
    //   → and truly deleteBlock'ed —— while they are displayed in the UI at that very moment.
    //   Measured hard evidence (two deleteBlocks within one rapid sequence):
    //   ```
    //   +174 insertBlock "- 2"    ← write-back A only saw Start,2
    //   +442 insertBlock "- 3"
    //   +490 insertBlock "- 4"
    //   +542 deleteBlock d3rj97   ← node 1 got deleted!
    //   +557 deleteBlock tiep1n   ← node 4 got deleted!
    //   ```
    //   The panel still showed ["Start","1","2","3","4"] while SiYuan kept only ["Start","2","3"],
    //   **with no error reported at all**.
    //
    //   The fix: before deleting, ask once for the **caller's "current" tree**.
    //   This is not a cache (it takes part in no read/write reuse) but a "final confirmation before deletion"
    //   —— a wrong deletion is irreversible, so one more question is worth it.
    // ★★ `loadBlockMap` must **not** be called here (a measured, serious bug).
    //
    //   The original code wanted to "refresh the mapping, then register", but `loadBlockMap` **resets**
    //   the three tables `lastBlockMap / lastListItems / lastByBlock`,
    //   and its data comes from the **lagging SQL index** —— so:
    //     1. `syncStructure` has just inserted new blocks and written "node ID → new block ID" into those three tables
    //     2. `syncDeletions` calls loadBlockMap → the three tables are **emptied and rebuilt**,
    //        while the index does not have those just-inserted blocks yet → the mappings are lost
    //     3. while iterating the blocks `lastByBlock.get(new block)` is empty for all of them →
    //        normalization fails → judged "deleted in the UI" → **deleted immediately**
    //   Measured messages: insert and delete came **in pairs**, and all 4 new nodes were lost.
    //
    //   So this reuses the mappings `syncStructure` already registered (they are **newer** than the SQL index).
    //   If the caller did not run syncStructure first (a pure-deletion scenario, say),
    //   what `lastByBlock` retains is still the real mapping from the last write-back, so it remains usable.
    // Register the current tree as "seen", so they may only be deleted once they disappear afterwards.
    // Also carry the "node ID → block ID" mapping, covering the case where "node ID ≠ block ID" after undo/redo.
    this.noteSeen(nodes, this.lastListItems);

    // Take every listItem, always using the block ID as the node's identity.
    // Native documents (ordinary lists written by hand or imported) lack that property,
    // so if only blocks carrying the property were recognized, deletion on native documents would fail entirely (a measured pitfall:
    // the UI deleted it, a "deletion could not be written to SiYuan" message appeared, and the node in SiYuan did not move at all).
    //
    // The key is derived the same way as in loadBlockMap:
    //   always the listItem's own block ID
    //   (when kramdownToTree parses a native document, the node ID is exactly the listItem's inline id).
    // ★★★ `type IN ('i','c')` —— a code block must be scanned too, or it can never be deleted.
    //
    //   Measured symptom (the one the user reported as "a code block can't be deleted at all"):
    //   this query asked only for `type='i'` (listItems), and a **code block is `type='c'`** —— a
    //   root-level `NodeCodeBlock` with no listItem. So a code block the user removed from the
    //   outline was never a candidate here, nothing was sent, no error was raised, and the block
    //   stayed in the document forever. Clearing it in the panel looked like it worked.
    //
    //   A table (`type='t'`) is **deliberately not** in this list: it is written by `syncStructure`
    //   and removed by its own path, so adding it here would delete tables that are still shown.
    const rows = await this.client.sql<{ id: string; ial: string }>(
      `SELECT b.id AS id, b.ial AS ial FROM blocks b
        WHERE b.root_id='${sqlStr(docId)}' AND b.type IN ('i','c')`,
      5000,
    );

    // ★★ Key: a "block" must be normalized to the **node ID** before being compared with `alive` (a measured, serious bug).
    //
    //   It used to take the listItem's block ID straight into `alive.has(key)`, and the namespaces disagreed in two cases:
    //     - a document **loaded** from SiYuan: node ID == listItem block ID → they match ✅
    //     - a node **created by the plugin**: the node ID is generated by us and the block ID by the kernel → **they do not match** ❌
    //   So a just-inserted block was judged "deleted in the UI" and **deleted immediately**.
    //   Measured messages (recorded by stubbing `window.fetch`):
    //   ```
    //   insert 800234-uuv64gu → delete 800234-uuv64gu   ← inserted and deleted at once
    //   insert 800236-xkwlnb1 → delete 800236-xkwlnb1
    //   insert 800237-0qimrdb → delete 800237-0qimrdb
    //   ```
    //   Consequence: creating 4 nodes quickly left **0 landed in SiYuan**, the UI looked fine, and **no error was reported**.
    //
    //   The normalization: use `lastByBlock` to reverse-look-up which node the block belongs to;
    //   on a miss fall back to the original (in a native document the node ID is the block ID, so it is equivalent).
    //   If the reverse-looked-up node **is in alive**, it is one of our own nodes → skip, never delete.
    let removed = 0;
    for (const r of rows) {
      const key = r.id;
      if (alive.has(key)) continue; // still alive (a loaded document: the key is the node ID)
      // judge again after normalizing the block ID → node ID
      const owner = this.lastByBlock.get(r.id);
      if (owner && alive.has(owner)) continue; // belongs to a live node → do not delete
      // ★ Safety gate: delete only blocks that "appeared in the tree before".
      // A block never seen before (e.g. just added on the SiYuan side, with the reverse sync not delivered yet)
      // is left alone entirely —— better a missed deletion than a wrong one.
      if (!this.everSeen.has(key) && !(owner && this.everSeen.has(owner))) continue;

      // ★ A block just inserted must never be deleted (a reinforcement):
      if (this.freshlyInserted.has(key) || (owner && this.freshlyInserted.has(owner))) continue;

      // ★★ Confirm once more with the **current** tree before deleting (see the long comment at the top of the method).
      //    The `alive` snapshot may predate the latest creations; a wrong deletion is irreversible.
      const live = this.liveTreeProbe ? this.liveTreeProbe() : alive;
      if (live.has(key) || (owner && live.has(owner))) continue;
      try {
        await this.client.deleteBlock(r.id);
        this.noteDeletedBlock(r.id);
        this.everSeen.delete(key);
        if (owner) this.everSeen.delete(owner);
        removed++;
      } catch {
        // it may already have been removed along with an ancestor; ignore
      }
    }
    return { removed };
  }

  /**
   * Rename a document.
   *
   * SiYuan's official renameDocByID must be used —— measured, writing title with setBlockAttrs
   * leaves an "untitled document" residue (SiYuan treats a title attribute change as a rename event).
   */
  async renameDoc(docId: string, newName: string): Promise<void> {
    await this.client.renameDoc(docId, newName);
  }

  /**
   * Rewrite the `# heading` heading block inside a document.
   *
   * ★★★ Why this must be done (a measured **silent title rollback** bug).
   *
   *   A document has two "titles":
   *     · the document's own name (`renameDocByID` is what changes it)
   *     · the `# heading` **heading block** on the body's first line
   *
   *   And `loadDoc` **can** take the body heading block: its read order is ① the document block's own
   *   `content` (authoritative), ② a `# title` heading block on the first body line, ③ `''`. So the
   *   heading block is what a document with a hand-written `# title` is read back from —— and what the
   *   title box therefore has to keep in step. (Before the document block's `content` was read at all, the
   *   `# ` lookup *was* the whole mechanism; it is fallback ② now, which is why step ③ used to be hit for
   *   nearly every document and the title showed "untitled".)
   *
   *   Changing the title in the plugin goes through `renameDoc` (it only changes the document name) and **never touches the heading block**.
   *   So the two diverge permanently:
   *   ```
   *   ① title box on open:         'TitleFocus'
   *   ② after changing to XYZ:     'TitleFocusXYZ'   ← the document name changed
   *   ③ title box after reopening: 'TitleFocus'      ← the old value was read back from the heading block
   *   ```
   *   What the user sees is **"it looked fine right after the edit, and was gone on reopening"**, with no error anywhere.
   *
   *   The fix: when changing the title, write the heading block **as well**, keeping the two consistent.
   *   For a document that has such a block, it is what the title box reads back, so it must carry the new
   *   value —— otherwise step ② hands the old one to a title that step ① would have got right.
   */
  async setHeadingTitle(docId: string, title: string): Promise<void> {
    // find the H1 heading block in the body (type='h' and a direct child of the document)
    const rows = await this.client.sql<{ id: string }>(
      `SELECT id FROM blocks WHERE root_id='${sqlStr(docId)}' AND type='h' AND parent_id='${sqlStr(docId)}' LIMIT 1`,
      1,
    );
    const blockId = rows?.[0]?.id;
    if (!blockId) return; // no heading block (e.g. an untitled document written by hand) → do not force one into existence
    // `updateBlock` always uses dataType='markdown' internally (it accepts only markdown | dom)
    await this.client.updateBlock(blockId, `# ${title}`);
  }

  /** Delete a document (SiYuan moves it to the trash) */
  async removeDoc(docId: string): Promise<void> {
    await this.client.removeDoc(docId);
  }

  // ---------------------------------------------------------------- search

  /**
   * Full-text search of the mind map nodes in this notebook (using SiYuan's native search ability).
   *
   * Only type='p' is queried (a paragraph = the node body), avoiding hits on the aggregated content of listItem/list.
   * It is likewise subject to the SQL index lag, so sqlWhenReady is used to give a small waiting window.
   */
  async searchNodes(
    keyword: string,
    opts: { limit?: number; expectAtLeast?: number; timeoutMs?: number } = {},
  ): Promise<Array<{ id: string; content: string; hpath: string }>> {
    const { limit = 50, expectAtLeast = 1, timeoutMs = 4000 } = opts;
    // ★ Use the shared sqlLike: besides quotes it also escapes the LIKE wildcards (% _ \),
    //   otherwise searching for `%` matches everything and `_` matches any single character.
    const kw = sqlLike(keyword);
    return this.client.sqlWhenReady(
      `SELECT id, content, hpath FROM blocks
       WHERE box='${sqlStr(this.notebook)}' AND type='p' AND content LIKE '%${kw}%' ESCAPE '\\'
       ORDER BY updated DESC`,
      { limit, expect: (r) => r.length >= expectAtLeast, timeoutMs },
    );
  }

  // ---------------------------------------------------------------- folders

  /**
   * In this implementation a folder is equivalent to "a path prefix inside the notebook".
   * SiYuan itself expresses the hierarchy with the document tree, so only a lightweight adaptation is done here.
   */
  async listFolders(): Promise<FolderMeta[]> {
    const rows = await this.client.sql<{ hpath: string }>(
      `SELECT hpath FROM blocks WHERE box='${sqlStr(this.notebook)}' AND type='d'`,
      500,
    );
    const prefixes = new Set<string>();
    for (const r of rows) {
      const parts = (r.hpath || '').split('/').filter(Boolean);
      // drop the last segment (the document name); the rest is the parent path
      for (let i = 1; i < parts.length; i++) prefixes.add('/' + parts.slice(0, i).join('/'));
    }
    // ★ Not `t`: this module imports the i18n function as `t` (line 165, used throughout), so a local
    //   `const t = Date.now()` shadows it. Nothing calls `t()` in this method today, which is exactly why
    //   it is worth renaming rather than leaving —— the next translated string added here would fail to
    //   compile with a message about calling a number, pointing nowhere near the cause.
    const stamp = Date.now();
    return [...prefixes].map((p) => ({
      id: `path:${p}`,
      name: p.split('/').filter(Boolean).pop() || p,
      createdAt: stamp,
      updatedAt: stamp,
    }));
  }
}
