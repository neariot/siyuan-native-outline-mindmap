// SiYuan kernel API adapter layer
//
// Handles only "talking to the SiYuan kernel"; contains no business logic (that lives in core/ and the store layer).
// Design notes (per the hard constraints in the repo AGENTS.md):
//   - every API is POST + JSON, with an Authorization: Token <token> header
//   - responses are uniformly {code, msg, data}; code===0 means success
//   - documents must be deleted with /api/filetree/removeDocByID (removeDoc panics)
//   - SQL is SELECT only, and must carry an explicit LIMIT
//   - always locate things by Block/Doc ID; never by title/hpath
//
// In the browser (inside the plugin) the token is injected by SiYuan; standalone use reads it from configuration.

import { t } from '../plugin/i18n';

export interface SiYuanResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

export interface SiYuanClientOptions {
  /** Kernel address; defaults to same-origin (inside the plugin that is location.origin) */
  baseUrl?: string;
  /** API token; may be left empty inside the plugin (SiYuan sends the Cookie / same-origin check) */
  token?: string;
  /** Custom fetch (makes test injection easy) */
  fetchImpl?: typeof fetch;
}

/** SiYuan default per-call row cap; going beyond it needs an explicit LIMIT (AGENTS.md requirement) */
export const DEFAULT_SQL_LIMIT = 64;

export class SiYuanError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'SiYuanError';
  }
}

/**
 * Decide whether an error means "the target document/block no longer exists".
 *
 * ★★★ Why this needs separate recognition (a measured **silent edit loss** bug):
 *
 *   Once the target document is deleted from outside (another client / the user by hand), the plugin does not know,
 *   the outline UI keeps rendering and keeps accepting input, but every write-back is rejected by the kernel:
 *   ```
 *   insertBlock → {"code":-1,"msg":"parent block not found: <docId>"}
 *   updateBlock → {"code":-1,"msg":"load block tree [<id>] failed: tree not found"}
 *   ```
 *   The error is indeed caught and displayed, but the text is only **"block not found"** ——
 *   it neither says the document was deleted nor offers any recovery, so the user just keeps typing and keeps losing.
 *
 *   Only once this class of error is recognised can the UI give a readable notice and enter the "save as" recovery flow.
 *
 * Note: the kernel has no stable error codes, so matching text is the only option; the match here is therefore loose,
 * and it is used **only on the write-back path** (the cost of a false positive is a more specific message, not lost data).
 */
export function isTargetGoneError(e: unknown, docId = ''): boolean {
  if (!(e instanceof SiYuanError)) return false;
  const m = e.message.toLowerCase();
  const shapeOk =
    m.includes('parent block not found') ||
    m.includes('tree not found') ||
    m.includes('block not found');
  if (!shapeOk) return false;
  if (!docId) return true;
  // ★★★ The document itself must be confirmed gone before this counts as "document deleted".
  //
  //   A measured false positive ("original document deletion" showing up again,
  //   pointing at `<anchor-id>`):
  //   that document was **alive and well** (25 blocks, getBlockKramdown returning normally),
  //   only some **child block ID was stale** (a transient state during concurrency/rebuild), and the kernel answered
  //   `block not found` —— the very same wording as the "document deleted" error.
  //
  //   So the UI popped up "target document has been deleted" and lit up the recovery entry, and the user thought the document was lost.
  //   The original comment above said "the cost of a false positive is a more specific message, not lost data" ——
  //   **that judgement was wrong**: it misleads the user into clicking "save as new document",
  //   which instead creates duplicate documents.
  //
  //   Fix: the error text must contain **this document's ID** before the document counts as gone.
  //   A stale child block reports the child block ID, which does not match docId → a normal error, no more false alarm.
  if (docId && !m.includes(docId.toLowerCase())) return false;
  return true;
}

export class SiYuanClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SiYuanClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.token = opts.token ?? '';
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** Unified POST call; throws SiYuanError on failure, returns data on success */
  async post<T>(endpoint: string, body: unknown = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Token ${this.token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new SiYuanError(`HTTP ${res.status}`, res.status, endpoint);
    }
    const json = (await res.json()) as SiYuanResponse<T>;
    if (json.code !== 0) {
      throw new SiYuanError(json.msg || `code=${json.code}`, json.code, endpoint);
    }
    return json.data;
  }

  // ---------------------------------------------------------------- document

  /** Create a document, returns the document ID. path looks like `/parent/child` (SiYuan creates the parent folder automatically) */
  createDoc(notebook: string, path: string, markdown: string): Promise<string> {
    return this.post<string>('/api/filetree/createDocWithMd', { notebook, path, markdown });
  }

  /** Delete a document (must use the ByID variant; removeDoc panics) */
  removeDoc(id: string): Promise<null> {
    return this.post<null>('/api/filetree/removeDocByID', { id });
  }

  /** Move a document (together with its child documents) */
  moveDocs(fromPaths: string[], toNotebook: string, toPath: string): Promise<null> {
    return this.post<null>('/api/filetree/moveDocs', { fromPaths, toNotebook, toPath });
  }

  /**
   * Rename a document (official API).
   *
   * ⚠️ Do not rename with `setBlockAttrs(id, {title})` —— measured to trigger SiYuan's document
   * rename logic and leave "untitled document" residue behind. This endpoint must be used.
   */
  renameDoc(id: string, title: string): Promise<null> {
    return this.post<null>('/api/filetree/renameDocByID', { id, title });
  }

  // ---------------------------------------------------------------- block

  /** Read a block's Kramdown (including child blocks) */
  async getBlockKramdown(id: string): Promise<string> {
    const d = await this.post<{ kramdown: string }>('/api/block/getBlockKramdown', { id });
    return d.kramdown;
  }

  /** Read a block's native DOM (including child blocks); returns a complete HTML DOM fragment */
  async getBlockDOM(id: string): Promise<{ dom: string; id: string }> {
    return this.post<{ dom: string; id: string }>('/api/block/getBlockDOM', { id });
  }

  /** Replace a block's content wholesale with Kramdown */
  updateBlock(id: string, data: string): Promise<null> {
    return this.post<null>('/api/block/updateBlock', { id, dataType: 'markdown', data });
  }

  /**
   * Replace a block's content wholesale with **SiYuan native DOM**.
   *
   * ★★★ Why this method has to exist (against measurements):
   *
   * The kernel has **two mutually independent** write paths for inline rich text, each accepting only its own format:
   *
   * | Path            | Accepts           | Does not accept            |
   * |-----------------|-------------------|----------------------------|
   * | `dataType=markdown` | markdown syntax (`` ` `` `**` `==`) | HTML tags, IAL |
   * | `dataType=dom`      | SiYuan `data-type` structure | **bare HTML tags**        |
   *
   * Measured evidence (the same `<span style="color:…">X</span>`, where X is a CJK glyph):
   * ```
   * markdown path → &lt;span style=…&gt;CJK char  ← escaped into literal source, colour lost
   * dom path      → <span data-type="text" …>CJK char   ← renders correctly
   * ```
   * Conversely, a bare `<b>bold</b>` on the dom path collapses into `&lt;protyle-html&gt;`,
   * so it must first go through `htmlToSiyuanDom()` into `<span data-type="strong">`.
   *
   * The convention is therefore: **whenever inline styling (colour/background/font size) must be preserved, this method is mandatory,
   * and `data` must go through `htmlToSiyuanDom()` first.**
   *
   * @param id   target block ID (writing text needs a **paragraph block**, not a listItem)
   * @param dom  SiYuan native DOM fragment, e.g. `<div data-type="NodeParagraph">…</div>`
   */
  updateBlockDom(id: string, dom: string): Promise<null> {
    return this.post<null>('/api/block/updateBlock', { id, dataType: 'dom', data: dom });
  }

  /**
   * Update a task list item's checked marker (native SiYuan API: /api/block/updateTaskListItemMarker).
   *
   * @param id     block ID of the task list item (NodeListItem)
   * @param marker marker character: 'X' means done, ' ' means not done
   */
  updateTaskListItemMarker(id: string, marker: string): Promise<null> {
    return this.post<null>('/api/block/updateTaskListItemMarker', { id, marker });
  }

  /**
   * Append a block with **SiYuan native DOM** (the append variant of `updateBlockDom`, same semantics).
   *
   * The only difference from `appendBlock` is the default `dataType`; here it is pinned to `dom`,
   * so a caller who forgets to pass it cannot get inline styles escaped.
   */
  appendBlockDom(parentID: string, dom: string): Promise<string> {
    return this.appendBlock(parentID, dom, 'dom');
  }

  /**
   * Upload a binary file into the workspace (usually landing in `data/assets/`); returns a relative path
   * usable as `![](assets/xxx.png)`.
   *
   * ⚠️ This is **multipart/form-data** and cannot go through `post()` (which sends JSON).
   * Parameter names follow the kernel contract: `path` / `file` / `isDir`.
   */
  async uploadAsset(file: Blob, filename: string): Promise<string> {
    const safeName = filename.replace(/[\\/:*?"<>|]/g, '_') || 'image.png';
    // Named date/time-random to avoid overwriting same names (matching SiYuan's own naming style)
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
      `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 9);
    const ext = (safeName.match(/\.[A-Za-z0-9]+$/) ?? ['.png'])[0];
    // ⚠️ The path is **relative to the workspace**, and the asset directory prefix is `data/assets/`, not `assets/`.
    // Writing `assets/...` raises no error (the kernel returns code:0), but the file lands in
    // `<workspace>/assets/` —— a place SiYuan **does not recognise at all**, showing up as "upload succeeded but the image does not display".
    const assetPath = `data/assets/om-${stamp}-${rand}${ext}`;

    const fd = new FormData();
    fd.append('path', assetPath);
    fd.append('isDir', 'false');
    fd.append('file', file, safeName);

    const res = await fetch(`${this.baseUrl}/api/file/putFile`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.token}` },
      body: fd,
    });
    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code !== 0) {
      throw new SiYuanError(`Uploading asset failed: ${json.msg ?? json.code}`, json.code, '/api/file/putFile');
    }
    // SiYuan references assets as `assets/xxx.png` (without the data/ prefix)
    return assetPath.replace(/^data\//, '');
  }

  /** Convert a data: URL into a Blob (used only by image migration) */
  static dataUrlToBlob(dataUrl: string): { blob: Blob; name: string } | null {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl);
    if (!m) return null;
    const mime = m[1];
    const isB64 = !!m[2];
    try {
      const bin = isB64 ? atob(m[3]) : decodeURIComponent(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      return { blob: new Blob([bytes], { type: mime }), name: `image.${ext}` };
    } catch {
      return null;
    }
  }

  /** Append a block to the end of a document/container; returns the new block ID */
  async appendBlock(parentID: string, data: string, dataType = 'markdown'): Promise<string> {
    const res = await this.post<Array<{ doOperations?: Array<{ action?: string; id?: string }> }>>(
      '/api/block/appendBlock',
      { dataType, data, parentID },
    );
    for (const tx of res ?? []) {
      for (const op of tx.doOperations ?? []) {
        if (op.action === 'insert' && op.id) return op.id;
      }
    }
    return '';
  }

  /**
   * Insert a block (positioned by parentID + previousID).
   *
   * ⚠️ Measured key point: when inserting a "child node",
   * - passing a **listItem** as `parentID` squeezes the parent node's text out into a separate paragraph, **breaking the structure**;
   * - the correct way is to pass the parent's **paragraph block** (or the previous child's **listItem**) as `previousID`,
   *   and to **not pass parentID**.
   *
   * See `insertChildNode` in store.ts for details.
   */
  async insertBlock(
    data: string,
    parentID: string,
    previousID = '',
  ): Promise<string> {
    return (await this.insertBlockEx(data, parentID, previousID)).listItemId;
  }

  /**
   * Insert a block and return **two** block IDs.
   *
   * ★★★ Why the distinction matters (a measured **text will not go in** bug):
   *   In SiYuan a list node corresponds to **two** block IDs with completely different purposes:
   *   - `listItemId`(i): the structural anchor, used for `previousID`
   *   - `paragraphId`(p): the text carrier, which `updateBlock` **must** use
   *
   *   If `listItemId` is used as the text target for `updateBlock(markdown)`,
   *   the kernel rejects it as an illegal structure (or the text is lost because markdown `- x` becomes a bare paragraph):
   *   ```
   *   invalid block structure: NodeList [...] cannot contain NodeParagraph [...]
   *   ```
   *   Measured symptom: the UI shows "node added", while in SiYuan that node is **always empty**.
   *
   *   The paragraph block ID can be parsed straight out of the insert transaction's `data` ——
   *   the `data` returned in measurements holds 3 `data-node-id` values, **the last one being the child paragraph**,
   *   matching the child block a later SQL query returns. So no extra query or index wait is needed.
   */
  async insertBlockEx(
    data: string,
    parentID: string,
    previousID = '',
  ): Promise<{ listItemId: string; paragraphId: string }> {
    const body: Record<string, unknown> = {
      dataType: 'markdown',
      data,
    };
    // An empty string is treated by the kernel as an illegal parameter, so it is only included when it has a value
    if (parentID) body.parentID = parentID;
    if (previousID) body.previousID = previousID;
    // ⚠️ What comes back is a **transaction array** (`[{doOperations:[{action,id,...}]}]`),
    // not `[{id}]`. Taking `[0].id` directly yields undefined —— a measured trap.
    const endpoint = parentID && !previousID ? '/api/block/appendBlock' : '/api/block/insertBlock';
    const res = await this.post<
      Array<{
        doOperations?: Array<{ id?: string; action?: string; data?: string }>;
      }>
    >(endpoint, body);
    const op = res?.[0]?.doOperations?.find((o) => o.action === 'insert');
    const rawId = op?.id ?? '';
    // Parse all node-ids out of the inserted content
    const ids = [...String(op?.data ?? '').matchAll(/data-node-id="([0-9]{14}-[0-9a-z]{7})"/g)]
      .map((m) => m[1]);

    // ★★★ The **returned type varies by scenario**, so it must be confirmed with a query (measured).
    //
    //   | Scenario        | `op.id` actually is |
    //   |----------------|-----------------|
    //   | Creating a list | **List `l`**     |
    //   | Appending to an existing list | listItem `i`     |
    //
    //   whereas the id sequence in `op.data` is `[List, listItem, …, paragraph]`,
    //   so the heuristic "last id = paragraph" **happens** to work;
    //   but "op.id = listItem" **does not hold when creating a list**.
    //
    //   The consequences of getting it wrong (defect #53, measured):
    //     a List ID ends up stored in `lastListItems` →
    //       · moveNodes queries the `parent_id` table with it (which only holds listItems) → not found → skipped
    //       · syncDeletions cannot recognise the block → data is wrongly deleted/lost
    //
    //   ⇒ one SQL query establishes the real type of both IDs, and they are slotted by type.
    //     When the query finds nothing (the index has not caught up), it falls back to the parsed `op.data` ——
    //     that heuristic is right in both scenarios.
    const parsedParagraph = ids.length ? ids[ids.length - 1] : '';
    let listItemId = rawId;
    let paragraphId = parsedParagraph;

    if (rawId || parsedParagraph) {
      const probe = [rawId, parsedParagraph].filter((v, i, a) => v && a.indexOf(v) === i);
      try {
        const rows = await this.sql<{ id: string; type: string }>(
          `SELECT id, type FROM blocks WHERE id IN (${probe.map((v) => `'${v}'`).join(',')})`,
          probe.length,
        );
        const typeOf = new Map((rows ?? []).map((r) => [r.id, r.type]));
        // Paragraph block: prefer the one with type='p'
        const asP = probe.find((v) => typeOf.get(v) === 'p');
        // listItem: prefer the one with type='i'; otherwise use the first listItem inside the List
        let asI = probe.find((v) => typeOf.get(v) === 'i') ?? '';
        if (!asI && typeOf.get(rawId) === 'l') {
          const inner = await this.sql<{ id: string }>(
            `SELECT id FROM blocks WHERE parent_id='${rawId}' AND type='i' LIMIT 1`,
            1,
          );
          asI = inner?.[0]?.id ?? '';
        }
        if (asP) paragraphId = asP;
        if (asI) listItemId = asI;
      } catch {
        // A failed query does not affect the main flow: fall back to the heuristic result
      }
    }
    if (!paragraphId) paragraphId = listItemId;
    if (!listItemId) listItemId = paragraphId;
    return { listItemId, paragraphId };
  }

  /** Delete a block (with its subtree). SiYuan has no separate "delete block" semantics, so the transaction endpoint is used. */
  deleteBlock(id: string): Promise<null> {
    return this.post<null>('/api/block/deleteBlock', { id });
  }

  /**
   * Insert a paragraph block **after** `previousID`; returns the new block's ID.
   *
   * Why not reuse insertBlockEx: that one returns the semantic "listItem / paragraph"
   * result and needs another query to disambiguate. In the "insert an attached paragraph into a listItem" scenario,
   * however, we **only need to know the new paragraph block's ID** (to use it as the anchor for the next paragraph) ——
   * taking it straight from the transaction response saves one SQL round trip.
   *
   * ★ Why `appendBlock(parentID=listItem)` cannot be used:
   *   in measurements it appends the paragraph to the **very end** of the listItem (after the sub-list)
   *   ```
   *   appendBlock →  ['p:root node', 'l: child node', 'p:appended paragraph']   ← wrong position
   *   insertBlock →  ['p:root node', 'p:inserted paragraph', 'l: child node']   ← correct
   *   ```
   *   An attached paragraph must sit **after the first paragraph and before the sub-list**.
   *
   * ★ With multiple inserts the anchor must **advance each time**: inserting two paragraphs with the same previousID gives
   *   reversed order (measured: insert A then B, and B ends up before A).
   */
  async insertParagraphAfter(previousID: string, dom: string): Promise<string> {
    const res = await this.post<
      Array<{ doOperations?: Array<{ id?: string; action?: string; data?: string }> }>
    >('/api/block/insertBlock', {
      dataType: 'dom',
      data: dom,
      previousID,
    });
    const op = res?.[0]?.doOperations?.find((o) => o.action === 'insert');
    // Trust op.id first (with a single paragraph it is the new block ID);
    // if unavailable, take the first data-node-id from op.data
    const fromData = [...String(op?.data ?? '').matchAll(/data-node-id="([0-9]{14}-[0-9a-z]{7})"/g)]
      .map((m) => m[1]);
    return op?.id || fromData[0] || '';
  }

  /**
   * Prepend a paragraph block at the head of a parent block (e.g. the document root) in DOM mode.
   */
  async prependParagraph(parentID: string, dom: string): Promise<string> {
    const res = await this.post<
      Array<{ doOperations?: Array<{ id?: string; action?: string; data?: string }> }>
    >('/api/block/prependBlock', {
      dataType: 'dom',
      data: dom,
      parentID,
    });
    const op = res?.[0]?.doOperations?.find((o) => o.action === 'insert');
    const fromData = [...String(op?.data ?? '').matchAll(/data-node-id="([0-9]{14}-[0-9a-z]{7})"/g)]
      .map((m) => m[1]);
    return op?.id || fromData[0] || '';
  }

  /**
   * Get a block's list of **direct child blocks**.
   *
   * ★ This is the authoritative source for "block order" —— the measured `sort` column of SQL
   * is not unique for **same-type** blocks (several paragraph blocks can share a sort),
   * and the order from `ORDER BY sort` does not match the real document order,
   * so it cannot be used to order attached paragraphs.
   *
   * The returned order is the document order; elements look like `{ id, type, subType, content }`.
   */
  async getChildBlocks(id: string): Promise<Array<{ id: string; type: string; subType?: string; content?: string }>> {
    const r = await this.post<Array<{ id: string; type: string; subType?: string; content?: string }>>(
      '/api/block/getChildBlocks',
      { id },
    );
    return r ?? [];
  }

  /**
   * Move a block to a new position (new parent / new sibling order).
   *
   * ⚠️⚠️ Three measured traps, **all of them silent failures** (returns `code:0` but nothing happens):
   *
   * 1. **`parentID` must be a container block, and a list item cannot directly contain a list item.**
   *    The kernel `block_op.go` validates:
   *      - `CheckListItemNesting(parentID, id)` → an `i` cannot be the direct parent of an `i`
   *      - `CheckContainerParent(parentID)`      → the parent must be a container type
   *    So indenting node A under node B must go through **two levels**:
   *      ① first make sure B (a listItem) has a **List(`l`)** container under it;
   *      ② then `moveBlock(A, parentID=<that l>)`.
   *
   * 2. **A freshly created List cannot be used as `parentID` right away.**
   *    The kernel's in-memory block tree `treenode.GetBlockTree` has not registered it yet, so internally it reports
   *    `transaction.go:746: get node [<new l>] in tree [<doc>] failed`,
   *    while **the endpoint still returns `code:0`** and the block does not move at all.
   *    → the caller must first poll until the List is recognised by move operations, and only then move it.
   *
   * 3. `previousID` **cannot be a document ID** (the kernel validates this explicitly), otherwise `code:-1`.
   *
   * @param id         block ID to move
   * @param parentID   target **container** block ID (for a list item, first obtain its child List)
   * @param previousID optional; the previous sibling block at the target position
   */
  moveBlock(id: string, parentID: string, previousID = ''): Promise<null> {
    const body: Record<string, unknown> = { id };
    if (parentID) body.parentID = parentID;
    if (previousID) body.previousID = previousID;
    return this.post<null>('/api/block/moveBlock', body);
  }

  // ---------------------------------------------------------------- attributes

  /** Read block attributes (including custom-* attributes) */
  getBlockAttrs(id: string): Promise<Record<string, string>> {
    return this.post<Record<string, string>>('/api/attr/getBlockAttrs', { id });
  }

  /** Write block attributes; passing null as the value removes the attribute */
  setBlockAttrs(id: string, attrs: Record<string, string | null>): Promise<null> {
    return this.post<null>('/api/attr/setBlockAttrs', { id, attrs });
  }

  // ---------------------------------------------------------------- query

  /**
   * Read-only SQL query. A LIMIT is force-appended (hard AGENTS.md requirement).
   * Only SELECT is allowed; a defensive check is done here.
   *
   * ★★★ Deciding "is there already a LIMIT" must look at the **end**, not search the whole text for `\blimit\b`
   *   (a measured severe bug).
   *
   *   The original implementation was `/\blimit\b/i.test(s)`: any occurrence of limit **anywhere** in the statement counted.
   *   But statements with sub-queries are very common:
   *   ```sql
   *   SELECT b.id, (SELECT c.id FROM blocks c
   *                  WHERE c.parent_id=b.id ORDER BY c.sort LIMIT 1) AS child
   *   FROM blocks b WHERE b.root_id='...' ORDER BY b.sort
   *   ```
   *   The `LIMIT 1` here belongs to the **sub-query**; the outer statement has no LIMIT at all —— yet it was judged to "already have" one,
   *   so no outer LIMIT was appended. SiYuan **returns only 64 rows by default** for a query without a LIMIT,
   *   so `loadBlockMap` got only **64** nodes on a document with 150 nodes:
   *   ```
   *   {'tree': 150, 'map': 64, 'miss': 86}
   *   ```
   *   those 86 nodes with no mapping were judged "new" → **inserted all over again** →
   *   one character edit triggered 86 `insertBlock` calls and the document **grew from 150 lines to 236** (measured).
   *
   *   Fix: match LIMIT only at the **end** (allowing a trailing semicolon).
   */
  sql<T = Record<string, unknown>>(stmt: string, limit = DEFAULT_SQL_LIMIT): Promise<T[]> {
    const s = stmt.trim();
    if (!/^select\b/i.test(s)) {
      throw new SiYuanError(t('errSqlSelectOnly'), -1, '/api/query/sql');
    }
    // Look only at the end: `... LIMIT 100` or `... LIMIT 100;`
    const hasTrailingLimit = /\blimit\s+\d+\s*;?\s*$/i.test(s);
    const withLimit = hasTrailingLimit ? s : `${s.replace(/;+\s*$/, '')} LIMIT ${limit}`;
    return this.post<T[]>('/api/query/sql', { stmt: withLimit });
  }

  /**
   * SQL query with retries.
   *
   * Background (measured): after a document is created, SiYuan's SQL full-text index lags by about 1-3 seconds,
   * so querying by root_id immediately returns an empty array. In the plugin, relying on "create then query" hits this trap,
   * hence the polling version.
   */
  async sqlWhenReady<T = Record<string, unknown>>(
    stmt: string,
    opts: { limit?: number; expect?: (rows: T[]) => boolean; timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<T[]> {
    const { limit = DEFAULT_SQL_LIMIT, expect = (r: T[]) => r.length > 0, timeoutMs = 8000, intervalMs = 300 } = opts;
    const deadline = Date.now() + timeoutMs;
    let last: T[] = [];
    // Query at least once, even when timeoutMs is 0
    for (;;) {
      last = await this.sql<T>(stmt, limit);
      if (expect(last)) return last;
      if (Date.now() >= deadline) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ---------------------------------------------------------------- notebook

  listNotebooks(): Promise<{ notebooks: Array<{ id: string; name: string; closed: boolean }> }> {
    return this.post('/api/notebook/lsNotebooks', {});
  }

  createNotebook(name: string): Promise<{ notebook: { id: string; name: string } }> {
    return this.post('/api/notebook/createNotebook', { name });
  }
}

/**
 * Read the token from SiYuan's configuration.
 *
 * Used only in Node/test environments. This function is not used inside the browser (the plugin) —— there the token is injected by SiYuan,
 * or same-origin cookies are used directly. eval('require') keeps the bundler from pulling fs into the browser bundle.
 */
export function resolveTokenFromConfig(confPath: string): string {
  const req = (0, eval)('typeof require === "function" ? require : null') as
    | ((m: string) => unknown)
    | null;
  if (!req) return '';
  const fs = req('fs') as { readFileSync: (p: string, enc: string) => string };
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8')) as { api?: { token?: string } };
  return conf?.api?.token ?? '';
}
