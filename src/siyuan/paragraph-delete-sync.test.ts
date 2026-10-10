/**
 * Attachment-paragraph write-back — **deleting the last paragraph must really delete it in SiYuan** (fix).
 *
 * ──────────────────────────────────────────────────────────────────
 * Symptom
 * ──────────────────────────────────────────────────────────────────
 *
 * "Adding and deleting empty attachment paragraphs does not sync".
 *
 * ──────────────────────────────────────────────────────────────────
 * Root cause
 * ──────────────────────────────────────────────────────────────────
 *
 * The condition for calling `syncParagraphs` from `saveNodesIncremental` used to be:
 *
 *     if (liId && (n.paragraphs?.length ?? 0) > 0) { await this.syncParagraphs(...) }
 *
 * It treated "no attachment paragraphs" as "nothing to write". But `syncParagraphs` is **bidirectional** —
 * its step 3 is exactly "fewer targets → delete the surplus blocks from the tail".
 * So when the last paragraph is deleted it is not called at all, and **those paragraph blocks stay in SiYuan forever**
 * (across the whole project only `syncParagraphs` deletes paragraph blocks).
 *
 * Trigger paths (Outliner.tsx):
 *   · `togglePara`: when every paragraph is an empty paragraph, `delete n.paragraphs` (press 🔁 again to exit)
 *   · `closePara` : likewise converges when all are empty
 *   · `removePara`: `paraToStore([])` → `undefined`
 * All three end up with `paragraphs === undefined`.
 *
 * ──────────────────────────────────────────────────────────────────
 * Why it cannot simply become "call unconditionally"
 * ──────────────────────────────────────────────────────────────────
 *
 * That would add one `getChildBlocks` per **every** node on every write-back round. The measured median for that call is 1.35ms,
 * a 240-node document = 316ms/round, and write-back runs on every keystroke.
 *
 * ⇒ The condition became "**did the previous round have any**", carried by the `nodesWithParas` set:
 *   the seed comes from the tree `loadDoc` already parsed (zero extra queries), after that `syncParagraphs`
 *   maintains it on write, according to the target state.
 *
 * ──────────────────────────────────────────────────────────────────
 * How this test runs
 * ──────────────────────────────────────────────────────────────────
 *
 * A **behavioural** test, not a source assertion: a fake client drives the **real** `saveNodesIncremental`,
 * asserting whether it really sends that `deleteBlock` to SiYuan.
 *
 * ★ Registration must follow the **target state after the write** (`want`), never the **state read back**
 *   (`existing`): on the "insert" path, at read time SiYuan still has no paragraph at all,
 *   it only exists after the insert; registering from the current state misses it, and an add followed by a delete never syncs.
 *   A source-assertion version cannot find this; a behavioural test catches it at a glance.
 */

export {};

import { SiYuanStore } from '../siyuan/store';
import type { SiYuanClient } from '../siyuan/api';
import type { OutlineNode } from '../model/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const LI = '20260101000000-li00001';
const BODY = '20260101000000-p000001';

type Kid = { id: string; type: string; content?: string };

class FakeClient {
  calls: string[] = [];
  /** listItem → its child blocks, in document order */
  children = new Map<string, Kid[]>();
  kramdown = '';
  private seq = 0;

  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: '' };
  }

  async getBlockKramdown(_id: string): Promise<string> {
    return this.kramdown;
  }

  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    if (stmt.includes("b.type = 'i'")) {
      return [{ id: LI, ial: '', child: BODY, childList: '' }] as unknown as T[];
    }
    if (stmt.includes('SELECT id, content FROM blocks')) {
      return [{ id: LI, content: '甲' }] as unknown as T[];
    }
    if (stmt.includes('SELECT id FROM blocks')) {
      return [{ id: LI }] as unknown as T[];
    }
    return [];
  }

  async getChildBlocks(id: string): Promise<Kid[]> {
    this.calls.push(`getChildBlocks:${id}`);
    return (this.children.get(id) ?? []).map((c) => ({ ...c }));
  }

  async insertParagraphAfter(prev: string, _dom: string): Promise<string> {
    this.calls.push(`insertParagraphAfter:${prev}`);
    const id = `newp${++this.seq}`;
    const kids = this.children.get(LI) ?? [];
    const at = kids.findIndex((k) => k.id === prev);
    kids.splice(at < 0 ? kids.length : at + 1, 0, { id, type: 'p', content: '\u200b' });
    this.children.set(LI, kids);
    return id;
  }

  async updateBlockDom(id: string, _dom: string): Promise<null> {
    this.calls.push(`updateBlockDom:${id}`);
    return null;
  }

  async deleteBlock(id: string): Promise<null> {
    this.calls.push(`deleteBlock:${id}`);
    this.children.set(LI, (this.children.get(LI) ?? []).filter((k) => k.id !== id));
    return null;
  }

  async updateTaskListItemMarker(): Promise<null> {
    return null;
  }

  attachIds(): string[] {
    return (this.children.get(LI) ?? []).filter((k) => k.id !== BODY).map((k) => k.id);
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

const node = (paragraphs?: string[]): OutlineNode => ({
  id: LI,
  modified: 1,
  text: '<span>甲</span>',
  children: [],
  paragraphs,
});

// ★ Wrap it in async: this project's tests compile to CJS, which has no top-level await.
async function main(): Promise<void> {
// ──────────────────────────────────────────────────────────────────
console.log('Scenario 1: add an empty attachment paragraph → delete it again (both directions of togglePara)');

{
  const c = new FakeClient();
  c.children.set(LI, [{ id: BODY, type: 'p', content: '甲' }]);
  const store = mkStore(c);

  // First write-back: the node has one empty attachment paragraph
  await store.saveNodesIncremental('doc1', [node([''])]);
  check(
    '★ adding an empty attachment paragraph → really inserts a paragraph block into SiYuan',
    c.calls.some((x) => x.startsWith('insertParagraphAfter:')),
    c.calls.join(' | '),
  );
  const attach = c.attachIds()[0] ?? '';
  check('an attachment paragraph block was really created', !!attach, JSON.stringify(c.children.get(LI)));

  // Second write-back: the paragraph is emptied (paragraphs → undefined)
  c.calls.length = 0;
  await store.saveNodesIncremental('doc1', [node(undefined)]);
  check(
    '★★★ deleting the empty attachment paragraph → the block in SiYuan must really be deleted',
    c.calls.includes(`deleteBlock:${attach}`),
    `actual calls: ${c.calls.join(' | ') || '(nothing was called)'}`,
  );
  check('after the deletion only the first paragraph is left under listItem', c.attachIds().length === 0, JSON.stringify(c.children.get(LI)));
}

// ──────────────────────────────────────────────────────────────────
console.log('Scenario 2: load a document that "already has attachment paragraphs" → clear them right away');

{
  const c = new FakeClient();
  c.children.set(LI, [
    { id: BODY, type: 'p', content: '甲' },
    { id: 'oldp', type: 'p', content: '\u200b' },
  ]);
  // The shape the real kernel getBlockKramdown returns (an empty attachment paragraph = a line that carries only the attribute line)
  c.kramdown =
    `- {: id="${LI}" updated="20260101000000"}甲\n` +
    `  {: id="${BODY}" updated="20260101000000"}\n\n` +
    `  {: id="oldp" updated="20260101000000"}\n` +
    `{: id="20260101000000-l0000002" updated="20260101000000"}\n\n` +
    `{: id="doc1" updated="20260101000000" type="doc" title="T"}`;

  const store = mkStore(c);
  const loaded = await store.loadDoc('doc1');
  check(
    '★ the empty attachment paragraph was parsed on load',
    JSON.stringify(loaded.nodes[0]?.paragraphs) === JSON.stringify(['']),
    JSON.stringify(loaded.nodes[0]?.paragraphs),
  );

  // The user clears it directly (without going through the "add" step) — relying on the seed loadDoc planted
  c.calls.length = 0;
  await store.saveNodesIncremental('doc1', [node(undefined)]);
  check(
    '★★★ first clear after load → must really delete too (the seed comes from loadDoc)',
    c.calls.includes('deleteBlock:oldp'),
    `actual calls: ${c.calls.join(' | ') || '(nothing was called)'}`,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('Scenario 3: a node that never had attachment paragraphs — must not spend an extra query');

{
  const c = new FakeClient();
  c.children.set(LI, [{ id: BODY, type: 'p', content: '甲' }]);
  const store = mkStore(c);
  c.calls.length = 0;
  await store.saveNodesIncremental('doc1', [node(undefined)]);
  check(
    '★ never had attachment paragraphs → getChildBlocks is not called (this is the performance criterion; do not degrade it into an unconditional call)',
    !c.calls.some((x) => x.startsWith('getChildBlocks:')),
    c.calls.join(' | '),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
}

void main();
