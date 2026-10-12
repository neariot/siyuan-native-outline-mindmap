/**
 * A **virtual SiYuan kernel** —— the real endpoints, the real response shapes, an in-memory block tree.
 *
 * ## Why this exists
 *
 * Every behavioural check in this repository ran in one of two places, and both were the wrong one for most of
 * the defects actually found:
 *
 * | layer | needs | cost | what it could see |
 * |---|---|---|---|
 * | `npm run check` (26 gates) | nothing | **42 s** | source text, docs, artifacts —— **all static** |
 * | `npm test` (51 files) | nothing | seconds | `core/`, `model/`, parts of `siyuan/` |
 * | `npm run test:e2e` | a **running SiYuan** + Chromium | **16 min** | the real product |
 *
 * Measured, the split is the problem: `serializeTree` and `structureFingerprint` are **pure** —— they take an
 * `OutlineNode[]` and return a string, no React, no DOM, no kernel —— but they live as closures inside
 * `mount.ts`, which imports `siyuan`. So the only layer that could exercise the write-coalescing rule was the
 * 16-minute browser suite against a live kernel. That is why the reported `Tab` bug took three reports to
 * find, and why its root cause (a flat serialization that could not see nesting) survived two earlier
 * "fixes".
 *
 * The seam already existed and was simply not used: `SiYuanClient` takes `fetchImpl` (`src/siyuan/api.ts`),
 * so a kernel can be injected by implementing `fetch`.
 *
 * ## What it models, and why each detail is here
 *
 * Every shape below was **measured against a running kernel** rather than invented, because a fake that
 * disagrees with the real thing validates the wrong code —— which is a worse outcome than no fake at all
 * (the shape of `docs/pitfalls/`'s "a criterion that cannot distinguish failure from success").
 *
 *   * `createDocWithMd` → `data` is the **document id string**;
 *   * `query/sql` → an array of rows; ★ it **lags** a creation by ~2 s (measured: `t=0` empty, `t=2 s` present),
 *     which is why a caller must poll rather than read once;
 *   * `getBlockDOM` → `data` is `{ id, dom }`, and after a deletion answers `code: -1`, `block not found`;
 *   * `getBlockKramdown` → `data` is `{ id, kramdown }`, with `{: id="…" updated="…"}` attributes inline;
 *   * `updateBlock` / `insertBlock` / `appendBlock` / `prependBlock` → `data` is an **array of transactions**,
 *     each `{ timestamp, doOperations, undoOperations }`, and an operation is
 *     `{ action: 'insert' | 'update' | 'delete' | 'move', id, data, … }`;
 *   * the block tree a document really has is `d → l → i → (p, l…)` —— a list item's own paragraph is its
 *     **child**, and indentation adds an intermediate `l`;
 *   * writing to a **deleted** block answers `` `load block tree [<id>] failed: indexing` `` for ~100 ms and
 *     `` … failed: tree not found `` after that; a **read** of a deleted id answers `block not found` at every
 *     moment (no window).
 *
 * ## What it deliberately does NOT model
 *
 * Rendering (the plugin draws with React, and that layer genuinely needs a DOM), the WS transaction push, the
 * SQL index's SQL surface beyond what the plugin uses, and anything about notebooks beyond "one exists". It
 * says so rather than approximating: a fake that quietly answers something the real kernel would refuse is
 * exactly the wrong kind of helpful.
 */

import type { OutlineNode } from '../model/types';

/** One block in the tree, as the kernel holds it. */
export interface VBlock {
  id: string;
  type: 'd' | 'l' | 'i' | 'p';
  parentId: string;
  /** Document root this block belongs to ('' for a document itself). */
  rootId: string;
  /** Ordering within the parent —— the kernel's `sort` column. */
  sort: number;
  /** Text content: what `query/sql` reports as `content`. */
  content: string;
}

interface VDoc {
  id: string;
  notebook: string;
  title: string;
}

/**
 * Kernel messages, copied from measurements rather than written from memory.
 *
 * A test that matches on a message the kernel does not send would pass against the fake and fail against the
 * real thing, so these are the values observed on the running instance.
 */
export const VMSG = {
  blockNotFound: 'block not found',
  treeNotFound: (id: string) => `load block tree [${id}] failed: tree not found`,
  indexing: (id: string) => `load block tree [${id}] failed: indexing`,
  parentNotFound: (id: string) => `parent block not found: ${id}`,
  insertionTargetNotFound: 'insertion target block not found',
} as const;

interface Op {
  action: 'insert' | 'update' | 'delete' | 'move';
  id: string;
  data?: unknown;
  parentID?: string;
  previousID?: string;
}

export interface VTransaction {
  timestamp: number;
  doOperations: Op[];
  undoOperations: Op[];
}

/**
 * How long a **write** to a vanished block reports `indexing` before it says `tree not found`.
 *
 * ★ Measured on the running instance: the message changes between `t=0.001s` (`indexing`) and `t=0.104s`
 *   (`tree not found`). The fake reproduces the window so a caller written against it cannot depend on the
 *   friendly message arriving immediately —— which is the exact assumption that made the original
 *   `isTargetGoneError` miss a real case.
 */
const INDEXING_WINDOW_MS = 104;

export interface VirtualKernelOptions {
  /** Start the clock here, so a test can control the indexing window deterministically. */
  now?: () => number;
  /** Delay before a newly created document appears in `query/sql`. Default: the measured ~2 s. */
  sqlIndexDelayMs?: number;
  notebook?: string;
}

/**
 * The fake kernel. Construct one per test; it starts empty.
 *
 * `fetch` is the whole interface, because that is the seam `SiYuanClient` already reads (`fetchImpl`). Nothing
 * in the plugin needs to know it is talking to this.
 */
export class VirtualKernel {
  private blocks = new Map<string, VBlock>();
  private docs = new Map<string, VDoc>();
  /** When each removed block disappeared, so the ~100 ms `indexing` window can be measured from that moment. */
  private vanishedAt = new Map<string, number>();
  private seq = 0;
  private readonly startMs: number;
  private readonly now: () => number;
  private readonly sqlIndexDelayMs: number;
  readonly notebook: string;

  /** Every request, in order. A test asserts on what the plugin *did*, which is often the real question. */
  readonly log: Array<{ endpoint: string; body: unknown }> = [];

  constructor(opts: VirtualKernelOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.startMs = this.now();
    this.sqlIndexDelayMs = opts.sqlIndexDelayMs ?? 2000;
    this.notebook = opts.notebook ?? '20260101000000-virtual1';
  }

  // ---------------------------------------------------------------- ids & clock

  /** A kernel-shaped id: `yyyyMMddHHmmss-xxxxxxx`. */
  private nextId(): string {
    const d = new Date(this.startMs);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(
      d.getUTCMinutes(),
    )}${p(d.getUTCSeconds())}`;
    return `${stamp}-virtual${p(++this.seq, 4)}`;
  }

  private elapsed(): number {
    return this.now() - this.startMs;
  }

  // ---------------------------------------------------------------- inspection (for tests)

  doc(id: string): VDoc | undefined {
    return this.docs.get(id);
  }

  /** The whole tree flattened, ordered by `sort` —— the shape `query/sql` returns. */
  rows(): VBlock[] {
    return [...this.blocks.values()].sort((a, b) => a.sort - b.sort);
  }

  /** Children of a block, in order. */
  childrenOf(id: string): VBlock[] {
    return this.rows().filter((b) => b.parentId === id);
  }

  /**
   * The document's content as **kramdown**, built from the tree —— `- ` per list item and two spaces per level,
   * which is what the kernel's own `getBlockKramdown` emits.
   *
   * A test asserts on this rather than on the UI, because the UI is what lies: the reported `Tab` bug showed
   * the indent on screen while the document stayed flat.
   */
  kramdown(docId: string): string {
    const lines: string[] = [];
    const walk = (parentId: string, depth: number): void => {
      for (const b of this.childrenOf(parentId)) {
        if (b.type === 'i') {
          const para = this.childrenOf(b.id).find((c) => c.type === 'p');
          lines.push(`${'  '.repeat(depth)}- ${para?.content ?? ''}`.trimEnd());
          walk(b.id, depth + 1);
        } else if (b.type === 'l') {
          walk(b.id, depth);
        }
      }
    };
    walk(docId, 0);
    if (lines.length === 0) return '';
    return lines.join('\n') + '\n';
  }

  /** Flat `[id, type, parentId]` triples —— a compact assertion target for structure. */
  shape(docId: string): string[] {
    return this.rows()
      .filter((b) => b.id === docId || this.rootOf(b.id) === docId)
      .map((b) => `${b.type}:${b.parentId === docId ? '<doc>' : b.parentId}:${b.content}`);
  }

  /**
   * Delete a block, for **test setup** —— so a case can reach a state (an empty List) that the plugin's own
   * calls would take many steps to reach.
   *
   * ★ Named `…ForTest` on purpose: this is not the kernel's `deleteBlock` (which the plugin calls and which
   *   answers a transaction). A test that needs the plugin to *observe* a deletion must use the real endpoint
   *   through the client, or it is testing this method instead of the product.
   */
  /**
   * Add a **new, empty** List under `parentId`, for test setup.
   *
   * ★ Needed because "move into an empty List" requires a target list that is genuinely empty and *separate*
   *   from the node under test —— a first attempt used the item's own list, which of course contained the item,
   *   so the guard never fired and the case passed against the wrong situation.
   */
  addEmptyListForTest(parentId: string): string {
    const id = this.nextId();
    this.blocks.set(id, {
      id,
      type: 'l',
      parentId,
      rootId: this.blocks.get(parentId)?.type === 'd' ? parentId : this.blocks.get(parentId)?.rootId ?? '',
      sort: this.childrenOf(parentId).length,
      content: '',
    });
    return id;
  }

  /** A list's item count —— the condition the kernel's empty-List behaviour depends on. */
  itemCount(listId: string): number {
    return this.childrenOf(listId).filter((c) => c.type === 'i').length;
  }

  removeBlockForTest(id: string): void {
    for (const b of this.rows()) {
      if (b.id === id || b.parentId === id) {
        this.blocks.delete(b.id);
        this.vanishedAt.set(b.id, this.now());
      }
    }
  }

  private rootOf(id: string): string {
    let cur = this.blocks.get(id);
    while (cur && cur.type !== 'd') {
      if (!cur.parentId) return cur.id;
      cur = this.blocks.get(cur.parentId);
    }
    return cur?.id ?? '';
  }

  // ---------------------------------------------------------------- the kernel's own writes

  /** Create a document from markdown. Returns its id, like the real endpoint. */
  seedDoc(title: string, markdown: string, opts: { notebook?: string } = {}): string {
    const docId = this.nextId();
    this.docs.set(docId, { id: docId, notebook: opts.notebook ?? this.notebook, title });
    this.blocks.set(docId, {
      id: docId,
      type: 'd',
      parentId: '',
      rootId: '',
      sort: 0,
      content: title,
    });
    // The kernel wraps every list in a List block, and each item's paragraph is the item's child.
    let listId: string | null = null;
    let parentItem: string | null = null;
    const stack: Array<{ depth: number; itemId: string }> = [];
    for (const raw of markdown.split('\n')) {
      if (!raw.trim()) continue;
      const indent = raw.length - raw.trimStart().length;
      const depth = Math.floor(indent / 2);
      const text = raw.trim().replace(/^-\s*/, '');
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      parentItem = stack.length ? stack[stack.length - 1].itemId : null;

      // The List that holds this level's items.
      const ownerId = parentItem ?? docId;
      let ownerChildren = this.childrenOf(ownerId);
      let list = ownerChildren.find((c) => c.type === 'l' && this.childrenOf(c.id).length > 0);
      if (!list || (parentItem && list.rootId !== docId)) {
        listId = this.nextId();
        this.blocks.set(listId, {
          id: listId,
          type: 'l',
          parentId: ownerId,
          rootId: docId,
          sort: ownerChildren.length,
          content: '',
        } as VBlock);
      } else {
        listId = list.id;
      }

      const itemId = this.nextId();
      const listKids = this.childrenOf(listId as string);
      this.blocks.set(itemId, {
        id: itemId,
        type: 'i',
        parentId: listId as string,
        rootId: docId,
        sort: listKids.length,
        content: text,
      });
      const paraId = this.nextId();
      this.blocks.set(paraId, {
        id: paraId,
        type: 'p',
        parentId: itemId,
        rootId: docId,
        sort: 0,
        content: text,
      });
      stack.push({ depth, itemId });
    }
    return docId;
  }

  // ---------------------------------------------------------------- fetch

  /** The `fetchImpl` to hand to `SiYuanClient`. */
  get fetchImpl(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const endpoint = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      this.log.push({ endpoint, body });
      const reply = this.handle(endpoint, body);
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  private ok<T>(data: T) {
    return { code: 0, msg: '', data };
  }

  private err(msg: string) {
    return { code: -1, msg, data: null };
  }

  /** Dispatch. Each branch mirrors the real endpoint's shape, measured. */
  private handle(endpoint: string, body: Record<string, unknown>): unknown {
    switch (endpoint) {
      case '/api/filetree/createDocWithMd': {
        const path = String(body.path ?? '/untitled');
        const title = path.split('/').filter(Boolean).pop() ?? 'untitled';
        return this.ok(this.seedDoc(title, String(body.markdown ?? ''), { notebook: String(body.notebook ?? this.notebook) }));
      }
      case '/api/filetree/removeDocByID': {
        const id = String(body.id ?? '');
        if (!this.docs.has(id)) return this.err(VMSG.blockNotFound);
        for (const b of this.rows()) {
          if (b.id === id || b.rootId === id) {
            this.blocks.delete(b.id);
            this.vanishedAt.set(b.id, this.now());
          }
        }
        this.docs.delete(id);
        return this.ok(null);
      }
      case '/api/query/sql': {
        const stmt = String(body.stmt ?? '');
        // ★ The index lag is real and measured (~2 s). Reproducing it is the point: a caller that reads once
        //   and gives up must fail here exactly as it fails against a live kernel.
        if (this.elapsed() < this.sqlIndexDelayMs) return this.ok([]);
        return this.ok(this.runSql(stmt));
      }
      case '/api/block/getBlockDOM':
      case '/api/block/getBlockKramdown': {
        const id = String(body.id ?? '');
        const b = this.blocks.get(id);
        if (!b) return this.err(VMSG.blockNotFound);
        return this.ok(
          endpoint.endsWith('DOM') ? { id, dom: `<div data-node-id="${id}"></div>` } : { id, kramdown: this.kramdownOf(id) },
        );
      }
      case '/api/block/getChildBlocks': {
        const id = String(body.id ?? '');
        if (!this.blocks.has(id)) return this.err(VMSG.blockNotFound);
        return this.ok(
          this.childrenOf(id).map((c) => ({ id: c.id, type: c.type, subType: '', content: c.content, markdown: c.content })),
        );
      }
      case '/api/block/updateBlock': {
        const id = String(body.id ?? '');
        const b = this.blocks.get(id);
        if (!b) return this.err(this.writeErrorFor(id));
        b.content = String(body.data ?? '');
        return this.ok([this.tx([{ action: 'update', id }])]);
      }
      case '/api/block/insertBlock':
      case '/api/block/prependBlock':
      case '/api/block/appendBlock': {
        const anchor = String(body.previousID ?? body.parentID ?? body.id ?? '');
        if (!this.blocks.has(anchor)) {
          return this.err(
            endpoint.endsWith('insertBlock') ? VMSG.insertionTargetNotFound : VMSG.parentNotFound(anchor),
          );
        }
        const md = String(body.data ?? '');
        const depth = 1;
        const text = md.trim().replace(/^-\s*/, '').split('\n')[0];
        const parentItem = endpoint.endsWith('insertBlock') ? this.blocks.get(anchor)!.parentId : anchor;
        const listId = this.ensureList(parentItem);
        const itemId = this.nextId();
        this.blocks.set(itemId, {
          id: itemId,
          type: 'i',
          parentId: listId,
          rootId: this.blocks.get(anchor)?.rootId ?? '',
          sort: this.childrenOf(listId).length,
          content: text,
        });
        void depth;
        const paraId = this.nextId();
        this.blocks.set(paraId, {
          id: paraId,
          type: 'p',
          parentId: itemId,
          rootId: this.blocks.get(anchor)?.rootId ?? '',
          sort: 0,
          content: text,
        });
        return this.ok([this.tx([{ action: 'insert', id: itemId, data: md }])]);
      }
      case '/api/block/deleteBlock': {
        const id = String(body.id ?? '');
        if (!this.blocks.has(id)) return this.err(VMSG.blockNotFound);
        for (const b of this.rows()) {
          if (b.id === id || b.parentId === id) {
            this.blocks.delete(b.id);
            this.vanishedAt.set(b.id, this.now());
          }
        }
        return this.ok([this.tx([{ action: 'delete', id }])]);
      }
      case '/api/block/moveBlock': {
        const id = String(body.id ?? '');
        const parentID = String(body.parentID ?? '');
        if (!this.blocks.has(id)) return this.err(VMSG.blockNotFound);
        // ★ Measured on the real kernel: moving into an **empty** List answers `code: 0` and does nothing,
        //   permanently. Reproduced so the plugin's placeholder workaround is exercised rather than assumed.
        if (!this.childrenOf(parentID).length) return this.ok([this.tx([])]);
        if (!this.blocks.has(parentID)) return this.err(VMSG.parentNotFound(parentID));
        this.blocks.get(id)!.parentId = parentID;
        return this.ok([this.tx([{ action: 'move', id, parentID }])]);
      }
      case '/api/block/updateTaskListItemMarker': {
        const id = String(body.id ?? '');
        if (!this.blocks.has(id)) return this.err(VMSG.blockNotFound);
        return this.ok([this.tx([{ action: 'update', id }])]);
      }
      case '/api/attr/getBlockAttrs':
        return this.ok({});
      case '/api/attr/setBlockAttrs':
        return this.ok(null);
      case '/api/notebook/lsNotebooks':
        return this.ok({ notebooks: [{ id: this.notebook, name: 'Virtual Notebook', closed: false }] });
      case '/api/filetree/moveDocs':
      case '/api/filetree/renameDocByID':
      case '/api/notebook/createNotebook':
      case '/api/file/putFile':
        return this.ok(null);
      default:
        // ★ Not a silent success: an endpoint this fake does not implement is a gap in the fake, and a caller
        //   must not be told "fine" (AGENTS §5.1 — no guessing, no silent fallback).
        throw new Error(
          `VirtualKernel does not implement ${endpoint}. Add it here rather than letting a test pass against a ` +
            'response the real kernel would not give.',
        );
    }
  }

  /**
   * What a **write** to a missing block answers.
   *
   * ★ Inside the measured ~100 ms window the kernel still says `indexing`; after it, `tree not found`. Both are
   *   reproduced because the distinction is the entire subject of one of this repository's open gaps.
   */
  private writeErrorFor(id: string): string {
    // ★ The window opens when the block **disappears**, not when the kernel was constructed. Measuring from
    //   construction made a never-existed id inside the first 104 ms answer `indexing`, which the real kernel
    //   does not do (measured: a never-existed id answers `tree not found` immediately). The fake had this
    //   wrong and its own acceptance test caught it —— which is the point of having one.
    const goneAt = this.vanishedAt.get(id);
    if (goneAt === undefined) return VMSG.treeNotFound(id);
    return this.now() - goneAt < INDEXING_WINDOW_MS ? VMSG.indexing(id) : VMSG.treeNotFound(id);
  }

  private tx(ops: Op[]): VTransaction {
    return { timestamp: 0, doOperations: ops, undoOperations: [] };
  }

  private ensureList(parentId: string): string {
    const existing = this.childrenOf(parentId).find((c) => c.type === 'l');
    if (existing) return existing.id;
    const id = this.nextId();
    const rootId = this.blocks.get(parentId)?.type === 'd' ? parentId : this.blocks.get(parentId)?.rootId ?? '';
    this.blocks.set(id, {
      id,
      type: 'l',
      parentId,
      rootId,
      sort: this.childrenOf(parentId).length,
      content: '',
    });
    return id;
  }

  private kramdownOf(id: string): string {
    const b = this.blocks.get(id);
    if (!b) return '';
    if (b.type === 'd') return this.kramdown(id);
    if (b.type === 'p' || b.type === 'i') return b.content;
    return this.childrenOf(id)
      .map((c) => c.content)
      .join('\n');
  }

  /** The slice of SQL the plugin uses: `SELECT … FROM blocks WHERE … LIMIT n`. */
  private runSql(stmt: string): unknown[] {
    const m = /SELECT\s+(.*?)\s+FROM\s+blocks\s+WHERE\s+(.*?)(?:\s+ORDER\s+BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$/is.exec(
      stmt,
    );
    if (!m) return [];
    const [, cols, where, orderBy, limit] = m;
    const conds = where.split(/\s+AND\s+/i).map((c) => c.trim());
    let rows = this.rows().filter((b) =>
      conds.every((c) => {
        const eq = /^(?:(\w+)\.)?(\w+)\s*=\s*'([^']*)'$/i.exec(c);
        if (eq) {
          const key = eq[2].toLowerCase();
          const val = eq[3];
          if (key === 'box') return this.rootBox(b) === val;
          if (key === 'root_id') return b.rootId === val || b.id === val;
          if (key === 'parent_id') return b.parentId === val;
          if (key === 'id') return b.id === val;
          if (key === 'type') return b.type === val;
          return false;
        }
        const isNull = /(\w+)\s+IS\s+NULL/i.exec(c);
        if (isNull) return !(b as unknown as Record<string, unknown>)[isNull[1].toLowerCase()];
        return true;
      }),
    );
    if (orderBy) {
      const key = orderBy.trim().split(/\s+/)[0].toLowerCase();
      rows = rows.sort((a, b) => ((a as never)[key] > (b as never)[key] ? 1 : -1));
    }
    const n = limit ? parseInt(limit, 10) : rows.length;
    return rows.slice(0, n).map((b) => {
      const out: Record<string, unknown> = {};
      for (const raw of cols.split(',')) {
        const key = raw.trim().replace(/^.*\./, '');
        out[key] = key === 'box' ? this.rootBox(b) : (b as unknown as Record<string, unknown>)[key];
      }
      return out;
    });
  }

  private rootBox(b: VBlock): string {
    const docId = b.type === 'd' ? b.id : b.rootId;
    return this.docs.get(docId)?.notebook ?? '';
  }
}

/** A ready-made client talking to a fresh virtual kernel. */
export function virtualKernel(opts: VirtualKernelOptions = {}): { kernel: VirtualKernel } {
  return { kernel: new VirtualKernel(opts) };
}

/** Helper: build an `OutlineNode` tree literal for tests. */
export const vnode = (id: string, text = id, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 0, text, children }) as OutlineNode;
