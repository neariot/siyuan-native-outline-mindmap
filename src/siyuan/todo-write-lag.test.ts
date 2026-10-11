/**
 * To-do write-back — **the state the plugin itself wrote outranks a stale read** (fix).
 *
 * ──────────────────────────────────────────────────────────────────
 * Symptom
 * ──────────────────────────────────────────────────────────────────
 *
 * Clicking a to-do's checkbox in the mind map marked it done; the **second** click turned the box back to
 * empty on screen while the document still said `[X]`. No error, no console output, and no call at all.
 *
 * ──────────────────────────────────────────────────────────────────
 * Root cause
 * ──────────────────────────────────────────────────────────────────
 *
 * Whether to write is decided from a SQL read of the current state (`storedTask`, built from
 * `blocks.markdown`). That read lags the kernel by 1~3 s, so a click inside that window reads the state
 * from **before the plugin's own last write**: `stored=1` while the document already said `[X]`, so
 * `wants === stored` held and the branch that would have written it was skipped.
 *
 * ──────────────────────────────────────────────────────────────────
 * How this test runs
 * ──────────────────────────────────────────────────────────────────
 *
 * A behavioural test: a fake client whose `sql` answers with a **frozen** state —— standing in for the
 * lag —— drives the real `saveNodesIncremental`, and the assertions are on the calls that really reach
 * the kernel. The second write is the one that matters; the first passes under both rules.
 *
 * ★ The fake never advances on its own: that is the defect, not an oversight of the fake.
 */

import { SiYuanStore } from './store';
import type { SiYuanClient } from './api';
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

/** A task's own list item: `markdown` carries the marker, `content` never does (measured). */
class FakeClient {
  calls: string[] = [];
  /** What `blocks.markdown` answers —— deliberately frozen, to model the index lag. */
  markdown = '- [ ] 节点一';
  subtype = 't';
  marker = '';
  subtreeWrites = 0;

  async getBlockDOM(): Promise<{ dom: string }> {
    return { dom: '' };
  }

  async getBlockKramdown(): Promise<string> {
    return this.markdown;
  }

  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    if (stmt.includes('SELECT id, content, markdown')) {
      return [{ id: LI, content: ' 节点一', markdown: this.markdown }] as unknown as T[];
    }
    if (stmt.includes("b.type = 'i'")) {
      return [{ id: LI, ial: '', child: BODY, childList: '' }] as unknown as T[];
    }
    if (stmt.includes('SELECT id, content FROM blocks')) {
      return [{ id: LI, content: ' 节点一' }] as unknown as T[];
    }
    if (stmt.includes('SELECT id FROM blocks')) {
      return [{ id: LI }] as unknown as T[];
    }
    return [];
  }

  async getChildBlocks(): Promise<never[]> {
    return [];
  }

  async updateBlockDom(): Promise<null> {
    this.calls.push('updateBlockDom');
    return null;
  }

  async updateTaskListItemMarker(id: string, marker: string): Promise<null> {
    this.calls.push(`updateTaskListItemMarker:${marker}`);
    this.marker = marker;
    // ★ The document really changes while `markdown` does not: that is the lag, and it is what makes the
    //   second write drop out unless the plugin remembers what it wrote. `markdown` moves only when a
    //   scenario moves it, which is how the index catching up is modelled.
    return null;
  }

  async updateBlock(id: string, data: string): Promise<null> {
    this.calls.push(`updateBlock:${data.slice(0, 6)}`);
    this.subtreeWrites++;
    return null;
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

const task = (status: number): OutlineNode => ({
  id: LI,
  modified: 1,
  text: '<span>节点一</span>',
  children: [],
  taskStatus: status,
});

async function main(): Promise<void> {
  console.log('Scenario 1: todo → done → todo while the read is still lagging behind');

  {
    const c = new FakeClient();
    const store = mkStore(c);

    // First write-back: mark it done. The read still says "not done", so there is nothing to outrank.
    await store.saveNodesIncremental('doc1', [task(2)]);
    check(
      '★ marking a to-do done writes a marker',
      c.calls.some((x) => x.startsWith('updateTaskListItemMarker:')),
      `calls=${JSON.stringify(c.calls)}`,
    );

    const before = c.calls.length;
    // Second write-back: back to not-done, on a read that has not caught up yet. Before the fix the value
    // read (`1`, from a still-frozen `markdown`) matched what was wanted, so no call was made at all.
    await store.saveNodesIncremental('doc1', [task(1)]);
    const wrote = c.calls.slice(before);

    check(
      '★ the second click writes again although the read still reports the old state',
      wrote.some((x) => x.includes(': ')),
      `calls=${JSON.stringify(wrote)}`,
    );
    check(
      '★ it clears the marker through the marker API, not by rewriting the subtree',
      wrote.some((x) => x === 'updateTaskListItemMarker: '),
      `calls=${JSON.stringify(wrote)}`,
    );
    check(
      // ★ Task creation reached the kernel through the **marker API**, not the markdown subtree write.
      //
      //   The fake answers `markdown: '- [ ] 节点一'` (already a task), so `wants && stored` holds and there
      //   is nothing to create; a scenario where the creation branch fires is Scenario 3. What matters here
      //   is that a checked-state change stays off the markdown path —— a markdown reparse per click drops
      //   the styling of a styled to-do, because markdown carries no HTML.
      '★ a checked-state change uses the marker API and does not re-write the subtree as markdown',
      c.calls.some((x) => x.startsWith('updateTaskListItemMarker')) && c.subtreeWrites === 0,
      `calls=${JSON.stringify(c.calls)} subtreeWrites=${c.subtreeWrites}`,
    );
  }

  console.log('Scenario 2: the read catches up → the document is the authority again');

  {
    const c = new FakeClient();
    const store = mkStore(c);

    await store.saveNodesIncremental('doc1', [task(2)]);
    // The index catches up: the document itself now says done.
    c.markdown = '- [X] 节点一';
    await store.saveNodesIncremental('doc1', [task(2)]);
    const afterCatchUp = c.calls.length;
    check(
      'no write when the document already holds the state the node has',
      c.calls.slice(0, afterCatchUp).filter((x) => x.startsWith('updateTaskListItemMarker')).length === 1,
      `calls=${JSON.stringify(c.calls)}`,
    );

    // ★ The note is retired by that read agreeing with it, and its absence is what decides the next write:
    // the value consulted is no longer "whatever we last wrote" but the read.
    //
    //   Against a read that now says done, no further marker call is made. If the note had survived, the
    //   value consulted would still be the remembered one and this is where a second call would appear ——
    //   which is exactly how "our memory of a state outlives the document" would show up.
    const settled = c.calls.length;
    await store.saveNodesIncremental('doc1', [task(2)]);
    check(
      '★ the note retires once the read agrees: no further write for an unchanged state',
      c.calls.slice(settled).every((x) => !x.startsWith('updateTaskListItemMarker')),
      `calls=${JSON.stringify(c.calls.slice(settled))}`,
    );
    check(
      'the marker was written exactly once, so nothing re-wrote it from memory',
      c.calls.filter((x) => x === 'updateTaskListItemMarker:X').length === 1,
      `calls=${JSON.stringify(c.calls)}`,
    );
  }

  console.log('Scenario 3: creating and clearing a task stay markdown-only');

  {
    const c = new FakeClient();
    const store = mkStore(c);
    c.markdown = '- 节点一'; // not a task at all

    await store.saveNodesIncremental('doc1', [task(1)]);
    check(
      'creating a task goes through the markdown write (the only call that can create one)',
      c.calls.some((x) => x.startsWith('updateBlock:')),
      `calls=${JSON.stringify(c.calls)}`,
    );

    c.markdown = '- [ ] 节点一';
    const before = c.calls.length;
    await store.saveNodesIncremental('doc1', [task(0)]);
    check(
      'clearing a task is markdown-only as well',
      c.calls.slice(before).some((x) => x.startsWith('updateBlock:')),
      `calls=${JSON.stringify(c.calls.slice(before))}`,
    );
  }

  console.log(`\ntodo-write: ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  }
}

void main();
