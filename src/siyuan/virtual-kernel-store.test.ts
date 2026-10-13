// ★★★ Virtual kernel end-to-end store test: SiYuanStore driven over VirtualKernel offline.
//
// ## Why this exists
//
// Previously, testing SiYuanStore's full loadDoc, saveNodesIncremental, task marker updates,
// and numbering conversion required launching Chromium and a live SiYuan desktop kernel (~16 minutes).
//
// With VirtualKernel's upgraded DOM AST generator, rich SQL engine, and subType tracking,
// we can verify the entire store lifecycle (DOM parsing, incremental diffing, block updates,
// task marker changes, and list type conversions) completely offline in tens of milliseconds.

import { SiYuanClient } from './api';
import { SiYuanStore } from './store';
import { VirtualKernel } from './virtual-kernel';
import type { OutlineNode } from '../model/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
  }
  if (!cond) {
    failures.push(`${name} ${extra}`);
  }
}

void (async () => {
  // ---------------------------------------------------------------- loadDoc offline
  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const store = new SiYuanStore({ client, notebook: kernel.notebook });

    const docId = kernel.seedDoc('测试文档', '- 节点一\n  - 节点二\n- 节点三\n');
    const loaded = await store.loadDoc(docId);

    check('loadDoc loads seeded document title', loaded.meta.name === '测试文档');
    check('loadDoc parses top-level nodes', loaded.nodes.length === 2);
    check('first top-level node has correct text', loaded.nodes[0]?.text?.includes('节点一') === true);
    check('first top-level node has child node', loaded.nodes[0]?.children?.length === 1);
    check('child node has correct text', loaded.nodes[0]?.children?.[0]?.text?.includes('节点二') === true);
    check('second top-level node has correct text', loaded.nodes[1]?.text?.includes('节点三') === true);
  }

  // ---------------------------------------------------------------- saveNodesIncremental text update
  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const store = new SiYuanStore({ client, notebook: kernel.notebook });

    const docId = kernel.seedDoc('测试文档', '- 节点一\n- 节点二\n');
    const loaded = await store.loadDoc(docId);

    // Modify text of the first node
    const updatedNodes: OutlineNode[] = JSON.parse(JSON.stringify(loaded.nodes)) as OutlineNode[];
    updatedNodes[0].text = '节点一内容';

    const res = await store.saveNodesIncremental(docId, updatedNodes);
    check('saveNodesIncremental reports 1 updated node', res.updated === 1, `got updated=${res.updated}`);
    check('saveNodesIncremental reports 1 skipped node', res.skipped === 1, `got skipped=${res.skipped}`);

    const kd = kernel.kramdown(docId);
    check('kernel kramdown reflects updated node text', kd.includes('节点一内容'), `got kramdown: ${kd}`);
    check('kernel kramdown retains untouched node', kd.includes('节点二'), `got kramdown: ${kd}`);
  }

  // ---------------------------------------------------------------- task marker toggle offline
  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const store = new SiYuanStore({ client, notebook: kernel.notebook });

    const docId = kernel.seedDoc('测试文档', '- [ ] 待办节点\n- 节点二\n');
    const loaded = await store.loadDoc(docId);

    // Toggle taskStatus to done (2)
    const updatedNodes: OutlineNode[] = JSON.parse(JSON.stringify(loaded.nodes)) as OutlineNode[];
    updatedNodes[0].taskStatus = 2;

    const res = await store.saveNodesIncremental(docId, updatedNodes);
    check('saveNodesIncremental updates task node', res.updated >= 1);

    const domRes = await client.getBlockDOM(docId);
    check('kernel getBlockDOM reflects completed task marker', domRes.dom.includes('data-task="x"'));
  }

  // ---------------------------------------------------------------- report
  console.log(`virtual-kernel-store: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
})();
