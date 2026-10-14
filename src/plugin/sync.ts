import { unescapeHtml } from '../model/html-escape';
import type { OutlineNode } from '../model/types';

/**
 * Bidirectional sync: SiYuan → mind map.
 *
 * Design notes
 * --------
 * 1. **Listen only, never actively query**: subscribe to the plugin's `ws-main` event and handle only `transactions`
 *    messages. Unlike polling, these are real edit events pushed by the kernel, with the lowest latency.
 *
 * 2. **Loop prevention is the core difficulty**: the mind map writing back to SiYuan also produces transactions,
 *    and without interception they form a "write back → event → write back" infinite loop.
 *    Here two safeguards are used: the `applying` flag + a **block ID whitelist**:
 *    - during write-back `applying=true` is set, and events arriving then are dropped outright
 *    - recently written block IDs are recorded (with a time window), which still holds even if the flag fails due to async ordering
 *
 * 3. **Match by block ID, do not rely on rootID**: measured update transactions carry an empty `rootID`,
 *    so it cannot be used to filter documents; instead a "block ID → node ID" reverse lookup table hits the blocks we care about.
 */

/** Shape of one operation inside a transaction (only the fields used here are declared) */
interface IOperation {
  action: string;
  id?: string;
  data?: string;
}

interface ITransaction {
  doOperations?: IOperation[] | null;
}

/** Parse "updated block ID → new text" out of a kernel transaction message */
export function extractUpdates(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = parseTransactions(raw);
  for (const tx of list) {
    for (const op of tx?.doOperations ?? []) {
      // only update matters here; delete goes through extractDeletions
      if (op?.action !== 'update' || !op.id || !op.data) continue;
      const text = htmlFragmentToText(op.data);
      if (text !== null) out.set(op.id, text);
    }
  }
  return out;
}

/**
 * Parse the **deleted block IDs** out of a kernel transaction message.
 *
 * Background for adding this (measured):
 * The comment on `extractUpdates` used to say "delete is a structural change, left to a later iteration"——
 * but that "later iteration" never came. The consequence:
 * **when the user deletes a list item in SiYuan, that node does not disappear from the mind map**,
 * it hangs there, and clicking it writes that "ghost node" back to SiYuan.
 *
 * Measured (.tmp/t31/capture-del.py) capture of the real shape of a delete transaction:
 * ```json
 * {"action":"delete","data":null,"id":"<listItem block ID>","rootID":""}
 * ```
 * Two key points:
 * - `data` is **null** (not HTML) —— so the text cannot be taken the way update does
 * - `id` is the block ID of the **listItem**, exactly the node carrier to detach from the tree
 *
 * ★ By the way: `rootID` is an **empty string**, so it likewise cannot filter documents ——
 *   as with update, only the "block ID → node ID" reverse lookup table can hit it.
 */
export function extractDeletions(raw: unknown): Set<string> {
  const out = new Set<string>();
  const list = parseTransactions(raw);
  for (const tx of list) {
    for (const op of tx?.doOperations ?? []) {
      if (op?.action !== 'delete' || !op.id) continue;
      out.add(op.id);
    }
  }
  return out;
}

/**
 * Parse out every block ID in a kernel transaction message that may be a new content node.
 *
 * Excluded non-content operations:
 * - pure attribute changes (op.action === 'updateAttr' etc.)
 * - container blocks (NodeList / NodeDocument have no contenteditable body, and action !== 'insert')
 *
 * Only a real insert (new block), or an update carrying a contenteditable body, counts as touching a content node.
 */
export function extractTouchedIds(raw: unknown): Set<string> {
  const out = new Set<string>();
  const list = parseTransactions(raw);
  for (const tx of list) {
    for (const op of tx?.doOperations ?? []) {
      if (!op?.id) continue;
      if (op.action === 'insert') {
        out.add(op.id);
        continue;
      }
      if (op.action === 'update' && op.data) {
        if (htmlFragmentToText(op.data) !== null) {
          out.add(op.id);
        }
      }
    }
  }
  return out;
}

/** Parse a transaction message (string or object form) */
function parseTransactions(raw: unknown): ITransaction[] {
  let parsed: { transactions?: ITransaction[] } | ITransaction[] | null = null;
  try {
    parsed =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : (raw as { transactions?: ITransaction[] });
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : (parsed?.transactions ?? []);
}

/**
 * Extract plain text from SiYuan's transaction HTML fragment.
 *
 * The fragment looks like:
 * `<div data-node-id="..." data-type="NodeParagraph" class="p"><div contenteditable="true">body text</div><div class="protyle-attr">​</div></div>`
 * the body text is in the first contenteditable child div; `protyle-attr` is the block-attribute placeholder and must be excluded.
 */
export function htmlFragmentToText(html: string): string | null {
  const m = /<div[^>]*contenteditable="true"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!m) return null;
  return visibleText(m[1]);
}

/**
 * The text of an HTML fragment **as the user sees it**: tags dropped, entities decoded, whitespace
 * collapsed. The one authority for comparing our node text against the kernel's.
 *
 * ★ There used to be two of these, and they disagreed. `mount.ts` had its own `plainNodeText` that
 *   stripped tags and replaced `&nbsp;` but decoded no other entity, while this function decoded them
 *   all. A node whose text contains `&`, `<` or `>` therefore never matched its own echo —— the kernel
 *   sends it back as `&amp;`/`&lt;`/`&gt;` —— so a write-back in flight reported a conflict on a node
 *   nobody had touched. Two normalizations for one comparison can only be equal by luck; one function
 *   cannot disagree with itself.
 *
 * ★ Zero-width spaces must be removed: they are the **placeholder** we write when writing back an empty
 *   node, not user-visible content. Keeping them makes the two sides disagree —— the mind map strips
 *   them, the kernel keeps them —— so an empty node is forever judged as "has external changes".
 *   Measured: pressing Enter 3 times to create empty nodes makes the banner accumulate to
 *   "⚠ 3 conflicting change(s)", with the diagnostic log showing
 *   `incoming="\u200b\u200b"  current=""  ownVals=[""]`.
 */
export function visibleText(html: string): string {
  // The entity decoding is shared (`core/html-escape`); the `<br>` and whitespace handling below is
  // specific to turning HTML into a single-line visible string, so it stays here.
  return unescapeHtml(
    html
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loop prevention: record the write-back window; events synced during it are ignored */
export class EchoGuard {
  /**
   * **Count** of write-backs in progress (not a boolean).
   *
   * ★ It must be a counter: write-back windows **overlap** —— the user edits twice in a row in the outline,
   * or clicks twice in the mind map, and two `await` write-backs are in flight at once.
   * With a boolean, whichever finishes first sets the flag back to false,
   * so the one **still writing back** is judged by `isEcho` as "not an echo" ——
   * the block we just wrote is treated as an external change, which can raise a false conflict or let stale data overwrite the tree.
   * Measured (.tmp/t31/guard.test.ts): after A finishes, while B is still writing back,
   * `isEcho(blockB)` returns `false` (it should be `true`).
   */
  private applyingCount = 0;
  /** Block IDs written by us recently → expiry timestamp */
  private recent = new Map<string, number>();
  /**
   * The **text values we last wrote out** (block ID → set of values we wrote).
   *
   * ★★★ Why the "value" must be recorded and not just the "block ID" (a measured false-conflict bug):
   *
   *   with incremental typing, every write-back we make produces an **intermediate-state** echo. Measured
   *   (typing "Fast1" quickly in the mind map):
   *   ```
   *   write-back 1 → 'F'      when the echo arrives, the mind map's current is already 'Fast1'
   *   write-back 2 → 'Fast'   likewise != current
   *   write-back 3 → 'Fast1'  this time == current
   *   ```
   *   The caller's original skip condition was `isEcho(blockId) && current === incoming`:
   *   the first two **do not skip** because "the content differs from the current value", so they fall into conflict detection,
   *   are recorded as "external change vs local intent" → **every keystroke raises one false conflict**.
   *   Measured: changing 3 nodes in a row → the banner shows "⚠ 3 conflicting change(s)",
   *   while in fact there were **no external changes at all**.
   *
   *   The correct criterion is not "does the content equal the current value" but
   *   **"is this value one we just wrote out"**:
   *   - a value we wrote (even an outdated version already superseded) → echo, skip
   *   - not a value we wrote → a real external change, go into conflict detection
   *
   *   This preserves the ability that "a change another client made first during write-back must not be swallowed",
   *   without mistaking our own intermediate state for a conflict.
   */
  private recentValues = new Map<string, Set<string>>();
  constructor(private readonly windowMs = 1500) {}

  /** Mark "about to write back"; kernel transactions produced during it should be ignored */
  beginApply(): void {
    this.applyingCount++;
  }

  /** Whether a write-back is not finished yet (in flight) */
  isApplying(): boolean {
    return this.applyingCount > 0;
  }

  /**
   * Record "the blocks we are writing out right now and their values".
   *
   * ★ It must be called **at the moment the write-back happens** (not after it finishes):
   *   with incremental typing `nodesRef` advances faster than the write-back, so reading the tree afterwards only yields the latest value
   *   **every intermediate state is missed** —— and those missed intermediate states are exactly the values that raise false conflicts later.
   *   Measured: typing "Fast1" quickly records only the final value; 'F'/'Fast' are missed,
   *   when their echoes arrive `cur` is already 'Fast1' → judged as an external change → false conflict.
   */
  noteWrittenValues(values: Map<string, string>): void {
    const vuntil = Date.now() + this.valueWindowMs;
    for (const [id, v] of values) {
      let set = this.recentValues.get(id);
      if (!set) {
        set = new Set<string>();
        this.recentValues.set(id, set);
      }
      set.add(v);
      this.valueExpiry.set(id, vuntil);
    }
  }

  /**
   * Write-back finished; record the blocks written this time **and their values**, to withstand late-arriving events.
   *
   * @param blockIds block IDs involved this time
   * @param values   optional: the **values actually written** this time (block ID → plain text).
   *                 when passed, the echo of such a value is recognized correctly even if the value was superseded by a later edit.
   */
  endApply(blockIds: Iterable<string>, values?: Map<string, string>): void {
    // decrement only when our own slice finishes; a surplus endApply must not make the count negative
    if (this.applyingCount > 0) this.applyingCount--;
    const until = Date.now() + this.windowMs;
    for (const id of blockIds) this.recent.set(id, until);
    if (values) {
      const vuntil = Date.now() + this.valueWindowMs;
      for (const [id, v] of values) {
        let set = this.recentValues.get(id);
        if (!set) {
          set = new Set<string>();
          this.recentValues.set(id, set);
          this.valueExpiry.set(id, vuntil);
        } else {
          this.valueExpiry.set(id, vuntil);
        }
        set.add(v);
      }
    }
  }

  /**
   * Write-back **failed**; give the guard window back without claiming anything was written.
   *
   * ★ Every `beginApply()` must be balanced, and a failure used to skip the balance entirely: the write
   *   path called `beginApply()` and then `await writeLatest()`, so a rejected write jumped straight to
   *   `catch` and the counter never came back down. `applyingCount` stayed above zero for the rest of the
   *   session, `isApplying()` stayed true, and every later event was judged "our own echo" —— external
   *   edits stopped arriving and local ones were reported as conflicts. One failed write disabled reverse
   *   sync until a reload, silently.
   *
   *   Nothing is recorded here on purpose: a partial write may have landed, but this call cannot know
   *   which part, and claiming blocks or values we did not finish writing would swallow a genuine echo.
   */
  abortApply(): void {
    if (this.applyingCount > 0) this.applyingCount--;
  }

  /**
   * Whether the value is one **we just wrote out ourselves** (an echo) rather than an external change.
   *
   * Difference from `isEcho`: `isEcho` only answers "this block was written by us recently",
   * this method further confirms "this **value** is one of the versions we wrote" ——
   * used to tell "our own intermediate-state echo" apart from "an external client really changed it".
   */
  isOwnValue(blockId: string, value: string): boolean {
    const set = this.recentValues.get(blockId);
    if (!set) return false;
    const until = this.valueExpiry.get(blockId);
    if (until === undefined || Date.now() > until) {
      this.recentValues.delete(blockId);
      this.valueExpiry.delete(blockId);
      return false;
    }
    return set.has(value);
  }
  /** Expiry time of value records (slightly longer than the block window, to cover echoes arriving only after write-back finishes) */
  private valueExpiry = new Map<string, number>();
  private readonly valueWindowMs = 8000;

  /** Whether this block's event should be ignored (it is our own echo) */
  isEcho(blockId: string): boolean {
    if (this.applyingCount > 0) return true;
    const until = this.recent.get(blockId);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.recent.delete(blockId);
      return false;
    }
    return true;
  }

  /** Drop expired entries so the Map does not grow without bound */
  prune(): void {
    const now = Date.now();
    for (const [id, until] of this.recent) if (now > until) this.recent.delete(id);
    for (const [id, until] of this.valueExpiry) {
      if (now > until) {
        this.valueExpiry.delete(id);
        this.recentValues.delete(id);
      }
    }
  }
}

/**
 * Conflict detection: decide whether an "external change" collides with a "local uncommitted edit".
 *
 * Scenario:
 *   1. the user double-clicks a node in the mind map, changes it to A, the UI shows A at once, and the write-back request is in flight;
 *   2. meanwhile the SiYuan side (another window / sync / another client) changes the same block to B;
 *   3. B's transaction arrives first; applying it directly flashes the UI to B, and A's write-back overwrites it right after ——
 *      what the user sees is "my edit was swallowed for no reason".
 *
 * Criterion: the node is currently outside the "just written by us" window yet differs from the external value ——
 * meaning both sides hold different content; that is a real conflict and the user must see it.
 *
 * Note the division of labour with EchoGuard:
 *   - EchoGuard answers "is this event an echo of my own write-back" (loop prevention)
 *   - ConflictTracker answers "does this event clash with my local intent" (silent-loss prevention)
 */
export interface Conflict {
  /** Node that hit the conflict */
  nodeId: string;
  /** Conflicting block */
  blockId: string;
  /** Our side's (mind map) current value */
  mine: string;
  /** The other side's (SiYuan) current value */
  theirs: string;
  /** Detection time */
  at: number;
}

export class ConflictTracker {
  /**
   * "Confirmed synced" values: the node's current content matches SiYuan, and we know about that match.
   *
   * Written at three moments:
   *   1. when a document is loaded from SiYuan (every node matches SiYuan)
   *   2. after our own write-back succeeds
   *   3. after an external change was accepted
   */
  private synced = new Map<string, string>();
  private conflicts = new Map<string, Conflict>();

  /**
   * Record "this node matches SiYuan right now".
   *
   * After loading a document this must be called **for every node** —— otherwise the first external change is misjudged as a conflict
   * (because "there is a local value but no sync baseline to look up").
   */
  noteSynced(nodeId: string, text: string): void {
    this.synced.set(nodeId, text);
    // matching content means converged, so the conflict clears by itself
    const c = this.conflicts.get(nodeId);
    if (c && (c.mine === text || c.theirs === text)) this.conflicts.delete(nodeId);
  }

  /** Register baselines in bulk after a whole document is loaded */
  noteAllSynced(nodes: Iterable<{ id: string; text?: string; children?: unknown[] }>): void {
    const walk = (list: Iterable<{ id: string; text?: string; children?: unknown[] }>): void => {
      for (const n of list) {
        this.synced.set(n.id, (n.text ?? '').replace(/<[^>]+>/g, '').trim());
        if (n.children && Array.isArray(n.children) && n.children.length > 0) {
          walk(n.children as Iterable<{ id: string; text?: string; children?: unknown[] }>);
        }
      }
    };
    walk(nodes);
  }

  /**
   * Check whether one external change constitutes a conflict.
   *
   * Criterion: **whether the local value has drifted from the sync baseline**.
   *   - local value == baseline → no uncommitted local intent, accept the external change
   *   - local value != baseline → there are independent local edits colliding with the external change → conflict
   *
   * ★★★ `writeInFlight` (a measured **external change silently swallowed** bug):
   *
   *   the baseline advances **when the write-back is started** (not when it finishes), otherwise intermediate states are lost
   *   and ordinary typing raises false conflicts (see §74/§79). But that leaves a gap:
   *
   *   ```
   *   t0  outline changed to "mindmap" → baseline advances to "mindmap" → write-back departs (in flight)
   *   t1  the API changes the same block to "external edit"
   *       → on arrival here base='mindmap', current='mindmap'
   *       → base === current → returns false (judged "no local intent")
   *       → the external value is accepted and the UI briefly shows "external edit"
   *   t2  the write-back from t0, **still in flight**, writes the block back to "mindmap"
   *       → the external change is overwritten, with **no warning at all**
   *   ```
   *
   *   Measured: `{'cur':'mindmap','inc':'external edit','echo':True,'own':False}`
   *   —— we **did correctly identify** it as an external change (own=False),
   *   yet because the baseline advanced too early it was judged "no conflict" and then covered by our own in-flight write-back.
   *
   *   Fix: an external change received while a write-back is in flight is **always recorded as a conflict**.
   *   Reason: at that moment the SiYuan-side value will still be overwritten by our in-flight write-back,
   *   and the user must know that "both sides changed" rather than let the change vanish silently.
   *
   * @param nodeId         node ID
   * @param current        value currently displayed by the mind map (plain text)
   * @param incoming       new value from SiYuan (plain text)
   * @param writeInFlight  whether we have a write-back not finished (`EchoGuard.isApplying` is true)
   * @returns true means it constitutes a conflict (the caller should keep the local value and warn the user)
   */
  check(
    nodeId: string,
    current: string,
    incoming: string,
    writeInFlight = false,
  ): boolean {
    // both sides equal: converged
    if (current === incoming) {
      this.synced.set(nodeId, current);
      this.conflicts.delete(nodeId);
      return false;
    }
    const base = this.synced.get(nodeId);
    // the external value equals the baseline exactly → SiYuan did not change it; this is only a new local edit or a late echo of the same value, so it is not an external conflict
    if (base !== undefined && base === incoming) {
      return false;
    }
    // ★ a **different** external value received while a write-back is in flight → it will certainly be overwritten by our write-back, so warn
    if (writeInFlight) return true;
    // local value still equals the baseline → no new local intent, accept the external change
    if (base === current) {
      this.conflicts.delete(nodeId);
      return false;
    }
    // local value has drifted from the baseline (uncommitted edits) and SiYuan changed it too → conflict with the external change
    return true;
  }

  /** Record a conflict (for the UI to display) */
  record(c: Conflict): void {
    this.conflicts.set(c.nodeId, c);
  }

  /** All currently unresolved conflicts */
  list(): Conflict[] {
    return [...this.conflicts.values()];
  }

  /** Clear the node's conflict after the user chooses "Use SiYuan's version" */
  resolve(nodeId: string): void {
    this.conflicts.delete(nodeId);
  }

  /** Update the baseline after an external change was accepted */
  acceptExternal(nodeId: string, text: string): void {
    this.synced.set(nodeId, text);
  }

  /**
   * Forget some nodes (they were deleted).
   *
   * ★ Why this method has to exist (measured):
   * every existing path that clears a conflict (check convergence / noteSynced / resolve)
   * **all require "another event about that node to arrive"**.
   * but once a node is deleted it never produces any event again ——
   * so its conflict entry **lingers forever**, the UI's "⚠ N conflicting change(s)" never returns to zero,
   * and the user clicks through and cannot find that node (it is no longer in the tree).
   *
   * Likewise the `synced` baseline must be cleared: entries only grow, so long use grows without bound.
   * (No cross-talk —— node IDs are timestamp + random, so reuse is extremely unlikely —— but there is no reason to keep them.)
   */
  forget(nodeIds: Iterable<string>): void {
    for (const id of nodeIds) {
      this.conflicts.delete(id);
      this.synced.delete(id);
    }
  }

  /** Clear everything (when switching documents / unloading) */
  clear(): void {
    this.conflicts.clear();
    this.synced.clear();
  }
}

/**
 * Parse the data SiYuan carries when "dragging a block".
 *
 * SiYuan's drag format (see kernel frontend `protyle/gutter/index.ts`):
 *
 *   MIME key = `application/siyuan-gutter` + type + ZWSP + subtype + ZWSP +
 *             blockID(comma-separated) + ZWSP + workspace path
 *   value   = JSON `{html, notebookID, rootID}`
 *
 * Note the MIME key **has data mixed into it**, so `dataTransfer.types` must be iterated and matched by prefix,
 * not `getData("application/siyuan-gutter")`.
 */
export interface DroppedBlocks {
  /** IDs of the dragged blocks */
  ids: string[];
  /** Block type (NodeParagraph / NodeList / ...) */
  type: string;
  /** The drag data's JSON value */
  payload: { html?: string; notebookID?: string; rootID?: string } | null;
}

/** Drag MIME prefix */
export const SIYUAN_GUTTER_PREFIX = 'application/siyuan-gutter';
const ZWSP = '\u200b';

/** Take SiYuan's dragged-block data out of a dataTransfer; return null when it is not a SiYuan drag */
export function parseSiyuanDrop(dt: DataTransfer | null): DroppedBlocks | null {
  if (!dt) return null;
  for (const t of Array.from(dt.types)) {
    if (!t.startsWith(SIYUAN_GUTTER_PREFIX)) continue;
    // key looks like: application/siyuan-gutterNodeParagraph\u200bNodeParagraph\u200bid1,id2\u200b/ws
    const rest = t.slice(SIYUAN_GUTTER_PREFIX.length);
    const parts = rest.split(ZWSP);
    const type = parts[0] ?? '';
    const ids = (parts[2] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    let payload: DroppedBlocks['payload'] = null;
    try {
      const raw = dt.getData(t);
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    return { ids, type, payload };
  }
  return null;
}

/**
 * Run one write-back inside the echo window, and **balance the guard whatever happens**.
 *
 * ★ The balance is the point of this function. The write path used to call `beginApply()`, then
 *   `await writeLatest()`, then `endApply(...)`, so a rejected write jumped to `catch` and the count
 *   never came back down: `isApplying()` stayed true for the rest of the session and every later event
 *   was treated as our own echo —— external edits stopped being applied and local ones were reported as
 *   conflicts. One failed write disabled reverse sync until a reload, with no message.
 *
 *   A `try/finally` at the call site would work too, and it is what the next person would have to
 *   remember at every call site (AGENTS.md section 8: prefer a tool over a remembered procedure). Here
 *   the invariant lives with the counter it protects, so it can be tested: feed `run` a rejection and
 *   check `isApplying()` is false again.
 *
 * `writtenIds`/`writtenValues` are read **after** the write finishes, because what we wrote is only
 * known then —— the same ordering the call sites used by hand.
 *
 * On failure nothing is recorded: a partial write may have landed, but this call cannot know which part,
 * and claiming blocks or values we did not finish writing would swallow a real echo.
 */
export async function withEchoGuard<T>(
  guard: EchoGuard,
  writtenIds: () => Iterable<string>,
  writtenValues: () => Map<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  guard.beginApply();
  try {
    const result = await run();
    guard.endApply(writtenIds(), writtenValues());
    return result;
  } catch (error) {
    guard.abortApply();
    throw error;
  }
}

/**
 * Serialize the node tree into a comparable string, **including its shape**, so that "did the tree change
 * again?" cannot mistake a re-parented tree for an unchanged one.
 *
 * ★★★ The `(` / `)` markers are the whole point, and they were missing for a long time.
 *
 *   This function is the evidence behind the write-coalescing decision:
 *   ```
 *   if (serializeTree(nodesRef.current) !== lastWrittenTreeRef.current) {
 *     await writeLatestRef.current();   // one catch-up write-back
 *   }
 *   ```
 *   It used to emit only `id:text` per node, in traversal order, with **no nesting and no child order**.
 *   So `甲 | 乙 | 丙` (flat) and `甲(乙) | 丙` (乙 indented) produced **byte-identical** strings, and the
 *   catch-up write was skipped while the UI showed the new indent.
 *
 *   Measured (Shift+Tab then Tab in quick succession —— the reported "tab demote does not sync"):
 *   ```
 *   [A] onChange kind=struct shape= 98uu | t7vl | uxa6        ← Shift+Tab produced no tree change
 *   [C] write callback read shape= 98uu | t7vl | uxa6         ← so W1 wrote the flat tree
 *   [mv] → SKIP (already in place)  ×3                        ← W1 correctly had nothing to move
 *   [A] onChange kind=struct shape= 98uu | ␣t7vl | uxa6       ← Tab indented 乙
 *   [B] catch-up: nodesRef shape= 98uu | ␣t7vl | uxa6         ← the indent IS in nodesRef
 *   → no second write callback, no second moveNodes pass      ← the check said "unchanged"
 *   ```
 *   SiYuan kept the flat document and no error was raised anywhere.
 *
 *   ★ This is the **third** appearance of the same pitfall in this one function, and the first two were
 *     "fixed" the wrong way —— by adding fields (the note, then `paragraphs`) rather than by encoding the
 *     tree's shape. Adding fields cannot catch a change that moves a node without altering it, so the
 *     bug replayed on the next field that mattered. The markers close the class: any re-parenting or
 *     reordering now changes the string.
 */
export function serializeTree(tree: OutlineNode[]): string {
  const parts: string[] = [];
  function walk(l: OutlineNode[]): void {
    for (const n of l) {
      // `(` opens this node's children and `)` closes them, so depth and sibling order are both encoded.
      parts.push(`(${n.id}:${n.text ?? ''}`);
      // ★★★ Fields **beyond the body text** must be included as well (the measured **truncated-note** bug).
      //
      //   This serialization is used to tell whether the tree changed again after the previous write-back:
      //   ```
      //   if (serializeTree(nodesRef.current) !== lastWrittenTreeRef.current) {
      //     await writeLatestRef.current();   // one catch-up write-back
      //   }
      //   ```
      //   It used to take only `id:text` —— so when **only the note changed, not the body**,
      //   the two serializations were **exactly identical** and the catch-up write was skipped.
      //
      //   Measured (typing the note "NoteContentABC" character by character on "A"):
      //   ```
      //   note in UI:  ['NoteContentABC']
      //   written:  only 'N'                   ← only the first character
      //   ```
      //   Because the first character triggered a write-back and the write-backs for the later characters
      //   were all dropped by the coalescing logic as "tree unchanged" —— the same as §77, where "only 'R' of 'ReplaceOK' was stored"
      //   it is **the second appearance of the same pitfall**: the premise of write coalescing must be genuinely asserted.
      //
      //   ★ : now that the note is carried by `paragraphs` (native attached paragraphs),
      //     this must switch to `paragraphs` as well —— otherwise the same truncation bug
      //     **replays unchanged** on attached paragraphs.
      parts.push(`${n.id}:paras=${JSON.stringify(n.paragraphs ?? [])}`);
      parts.push(`${n.id}:task=${n.taskStatus ?? 0}`);
      // ★ Numbering is block markup, not text: `- x` is an unordered List (`l/u`) while `1. x` is an
      //   ordered one (`l/o`), measured. A pure "number this node" edit changes no field above, so
      //   without this line it compares equal and the catch-up write is skipped —— the fourth appearance
      //   of the "added a field instead of the shape" pitfall in this one function (note, paragraphs,
      //   taskStatus, now numbered).
      parts.push(`${n.id}:num=${n.numbered ? 1 : 0}`);
      // ★★★ A table's cells are **content**, and they reach the document through a different
      //   path than a paragraph (there is no paragraph block to write them into).
      //
      //   That is exactly what makes this line load-bearing: without it the two tables above
      //   serialize **identically**, the first keystroke starts a write-back, every later one
      //   compares equal and is dropped by the coalescing, and the document keeps only the first
      //   character. This is the "added a field instead of the shape" pitfall again, and
      //   `sync-serialize.test.ts` pins it.
      if (n.table) parts.push(`${n.id}:table=${JSON.stringify(n.table)}`);
      if (n.children?.length) walk(n.children);
      parts.push(')');
    }
  }
  walk(tree);
  return parts.join('\u0001');
}

/**
 * A fingerprint of **structure only**: node set + parent-child relations + order.
 *
 * ★★★ Why it is needed (the fix; measured root cause of **typing lag**):
 *
 *   `writeLatest` ran the full three-step structure reconciliation every time:
 *     syncStructure (including moveNodes, one DB lookup per node) → syncDeletions → saveNodesIncremental
 *   but **typing changes text only, not a single byte of structure** —— so those two steps ran for nothing.
 *
 *   Measured (240-node document, typing 1 character):
 *   ```
 *   189 API calls, 180 of them the same
 *     SELECT id FROM blocks WHERE parent_id=? AND type='l'
 *   the write to disk took ≈3 seconds; a 4-node document needed only 11 calls / 291 ms
 *   ```
 *   Call stack: `syncStructure → moveNodes → resolveWantList → ensureChildList`.
 *
 *   The criterion must contain structure fields only —— **`text` must not be counted in**, or a text edit would
 *   pass for a structure change and the optimization would be void. Conversely, omitting any structure field lets
 *   real structure changes be skipped (which is the dangerous direction), so every field is listed here:
 *   node id (add/remove), child order (move/reorder), and the fields that change block shape:
 *   attached paragraphs and summaries/connectors (each of them corresponds to its own block).
 */
export function structureFingerprint(tree: OutlineNode[]): string {
  const parts: string[] = [];
  function walk(l: OutlineNode[]): void {
    for (const n of l) {
      // Child order is expressed with ids: order changed → fingerprint changes
      const kids = (n.children ?? []).map((c) => c.id).join(',');
      // Attached paragraphs each produce their own block, so they are structure.
      // Numbering too: `- x` vs `1. x` is an unordered vs ordered List (`l/u` vs `l/o`, measured),
      // so a numbered toggle must take the full structure path rather than the text-only one.
      // ★ A table's **shape** is structure: its width and row count decide how many cells the
      //   block has. Cell *content* deliberately stays out of this fingerprint —— putting it here
      //   would put every keystroke in a cell back on the whole structural path, which is the
      //   cost this function exists to avoid (measured: 189 API calls per typed character).
      const shape = n.table ? `t${n.table.header.length}x${n.table.rows.length}` : '';
      parts.push(
        `${n.id}[${kids}]p${(n.paragraphs ?? []).length}n${n.numbered ? 1 : 0}${shape}`,
      );
      if (n.children?.length) walk(n.children);
    }
  }
  walk(tree);
  return parts.join('\u0001');
}

/**
 * Everything a re-read has to get past before it may read the document.
 */
export interface OwnWriteBarrierState {
  /** The write-back that is already **enqueued and running** (`pendingWriteRef`), if any. */
  pendingWrite: Promise<void> | null;
  /** Whether a debounced text edit is scheduled —— and has therefore enqueued **nothing** yet. */
  debouncePending: boolean;
  /** Send that debounced edit now. */
  flushDebounced: () => Promise<void>;
}

/**
 * ★★★ Resolve only once the plugin's own pending work is on disk.
 *
 * A re-read triggered by a kernel transaction replaces the whole node tree. If it reads before
 * this plugin's own write has landed, it faithfully returns the **pre-write** document and
 * overwrites a correct local tree —— and nothing catches it, because by then the local edit
 * looks finished.
 *
 * Waiting for `pendingWriteRef` alone is not enough, and that was the defect:
 *
 *   • `handleOutlineChange` schedules a text edit through a **250 ms debounce** and enqueues
 *     nothing until the timer fires, so during that window `pendingWriteRef` is `null` and the
 *     wait is a no-op. The read returned the document's content, replaced the tree that held the
 *     edit, and the timer then wrote the document's own text back: **the keystroke was lost, with
 *     no error anywhere.**
 *
 *   • Measured in a browser with the outgoing requests logged (typing into a document that
 *     contains a table, so load-time transactions land a re-read inside the window):
 *     `t+500ms outline=[]` — the re-read arriving — while the document was already correct.
 *
 * So the barrier covers both forms of pending work, in the order that matters: **flush first**
 * (sending the debounced edit enqueues a write of its own and awaiting it means our own text is
 * on disk), **then** await a write that was already running.
 *
 * A failing flush is swallowed on purpose: a read of a document that did not accept the write is
 * still the best available state, and letting the rejection through would freeze the panel on a
 * stale tree forever.
 */
export function ownWriteBarrier(state: OwnWriteBarrierState): Promise<void> {
  const flushed = state.debouncePending ? state.flushDebounced() : Promise.resolve();
  return flushed
    .catch(() => undefined)
    .then(() => state.pendingWrite ?? Promise.resolve())
    .catch(() => undefined);
}
