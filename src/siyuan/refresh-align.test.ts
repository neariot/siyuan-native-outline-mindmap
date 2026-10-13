// ★★★ `refreshMapsAfterCreate` must align via the TOP list, not the first-flushed one.
//
// Measured live: after createDoc + appendBlockDom, the SQL index flushes the *child* list first.
// An unqualified `type='l' LIMIT 1` then returns the child list, so the walk aligns n1 to the
// child item, drops n2/n3, and every later write-back duplicates them. The query must pick the
// list whose parent is the document/heading (the same rule `moveNodes` uses for its topList).
//
// A **behavioural** test: a fake client whose index lists the child list first drives the **real**
// `refreshMapsAfterCreate`. All three nodes must align — and stay aligned through the next
// `loadBlockMap` (the freshlyInserted registration half of the same finding).

export {};

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

const DOC = '20260101000000-doc0001';
const HEAD = '20260101000000-h000001';
// Child list flushed FIRST in index order (the measured trap); top list second.
const CHILDL = '20260101000000-lchild1';
const TOPL = '20260101000000-ltop0001';
const N1I = '20260101000000-n1item01';
const N1P = '20260101000000-n1para01';
const N2I = '20260101000000-n2item01';
const N2P = '20260101000000-n2para01';
const N3I = '20260101000000-n3item01';
const N3P = '20260101000000-n3para01';

const N = (id: string, text: string, children: OutlineNode[] = []): OutlineNode =>
  ({ id, modified: 1, text, children }) as OutlineNode;

class FakeClient {
  calls: string[] = [];

  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    // DOM sees everything synchronously: top list under the heading, child list under n1's item.
    return {
      dom:
        `<div data-node-id="${DOC}" data-type="NodeDocument">` +
        `<div data-node-id="${HEAD}" data-type="NodeHeading">` +
        `<div data-node-id="${TOPL}" data-type="NodeList">` +
        `<div data-node-id="${N1I}" data-type="NodeListItem"><div data-node-id="${N1P}" data-type="NodeParagraph"><div contenteditable="true">甲</div></div>` +
        `<div data-node-id="${CHILDL}" data-type="NodeList">` +
        `<div data-node-id="${N2I}" data-type="NodeListItem"><div data-node-id="${N2P}" data-type="NodeParagraph"><div contenteditable="true">乙</div></div></div>` +
        `</div></div>` +
        `<div data-node-id="${N3I}" data-type="NodeListItem"><div data-node-id="${N3P}" data-type="NodeParagraph"><div contenteditable="true">丙</div></div></div>` +
        `</div></div></div>`,
    };
  }

  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    this.calls.push(`sql:${stmt.replace(/\s+/g, ' ').slice(0, 120)}`);
    // Index order: the CHILD list flushed first (the measured trap). Answer by parent filter:
    // the unqualified query returns the child list; the top-list query (parent in d/h) the top one.
    if (stmt.includes("type='l'") && stmt.includes('LIMIT 1')) {
      if (stmt.includes("type IN ('d','h')")) return [{ id: TOPL }] as unknown as T[];
      return [{ id: CHILDL }] as unknown as T[];
    }
    return [] as unknown as T[];
  }

  async getChildBlocks(id: string): Promise<Array<{ id: string; type: string }>> {
    if (id === TOPL) return [{ id: N1I, type: 'i' }, { id: N3I, type: 'i' }];
    if (id === N1I) {
      return [
        { id: N1P, type: 'p' },
        { id: CHILDL, type: 'l' },
      ];
    }
    if (id === CHILDL) return [{ id: N2I, type: 'i' }];
    if (id === N2I) return [{ id: N2P, type: 'p' }];
    if (id === N3I) return [{ id: N3P, type: 'p' }];
    return [];
  }
}

const mkStore = (c: FakeClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

async function main(): Promise<void> {
  console.log('=== refresh aligns via the top list even when the child list flushes first ===');
  {
    const c = new FakeClient();
    const store = mkStore(c);
    const tree = [N('n1', '<span>甲</span>', [N('n2', '<span>乙</span>')]), N('n3', '<span>丙</span>')];
    await (store as any).refreshMapsAfterCreate(DOC, tree);
    const items = (store as any).lastListItems as Map<string, string>;
    const paras = (store as any).lastBlockMap as Map<string, string>;
    check('★★ n1 aligns to the top-list item, not the child-list one', items.get('n1') === N1I, `got ${items.get('n1')}`);
    check('★★ the child node aligns under it', items.get('n2') === N2I, `got ${items.get('n2')}`);
    check('★★ the second top node aligns too', items.get('n3') === N3I, `got ${items.get('n3')}`);
    check('★ paragraphs align alongside', paras.get('n1') === N1P && paras.get('n2') === N2P && paras.get('n3') === N3P,
      `got ${paras.get('n1')},${paras.get('n2')},${paras.get('n3')}`);
    // Second half of the finding: the alignment must survive the next loadBlockMap
    // (freshlyInserted registration). The paragraph map is node-keyed, so it reads cleanly.
    const map = await store.loadBlockMap(DOC);
    check('★★ the alignment survives the next loadBlockMap (freshlyInserted retention)',
      map.get('n1') === N1P && map.get('n2') === N2P && map.get('n3') === N3P,
      `map n1=${map.get('n1')} n2=${map.get('n2')} n3=${map.get('n3')}`);
  }

  console.log(`\nrefresh-align: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
}

void main();
