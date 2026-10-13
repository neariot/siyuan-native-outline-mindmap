// ★★★ The virtual kernel's own acceptance test: the **real** `SiYuanClient` must work against it unchanged.
//
// This file exists to keep the fake honest. A fake that answers shapes the real kernel does not would validate
// the wrong code, so every response shape asserted here was **measured against a running instance** (see the
// measurements recorded in `virtual-kernel.ts`'s header). If this file and the real kernel ever disagree, this
// file is wrong and the fake must be corrected —— not the other way round.
//
// What it does NOT need: a running SiYuan, a browser, or a deploy. That is the whole point: the layer that
// decides whether to write can now be exercised in seconds instead of a 16-minute E2E run.

import { SiYuanClient } from './api';
import { parseDomToTree } from './dom-tree';
import { VirtualKernel, VMSG, vnode } from './virtual-kernel';

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

void (async () => {
  // ---------------------------------------------------------------- the client talks to it

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    // ★ The seam is `fetchImpl`, which already existed on the real client —— nothing in the product knows.
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });

    const docId = await client.createDoc(kernel.notebook, '/测试文档', '- 甲\n  - 乙\n');
    check('createDoc returns the document id', typeof docId === 'string' && docId.length > 0, `got ${docId}`);
    check('the kernel registered the document', kernel.doc(docId)?.title === '测试文档', JSON.stringify(kernel.doc(docId)));

    // The tree the kernel really builds: d → l → i → (p, l…)
    const types = kernel
      .rows()
      .filter((b) => b.id === docId || b.rootId === docId)
      .map((b) => b.type);
    check('the document contains a List', types.includes('l'), types.join(','));
    check('the document contains list items', types.filter((t) => t === 'i').length === 2, types.join(','));
    check(
      'each list item owns a paragraph child (measured: the paragraph is the item’s child, not a sibling)',
      kernel.childrenOf(kernel.rows().find((b) => b.type === 'i')!.id).some((c) => c.type === 'p'),
    );

    // getBlockKramdown is what a test asserts on —— the document, not the screen. ★ The client unwraps the
    // kernel's `{ id, kramdown }` envelope and hands back the string, so the *fake* supplies the envelope and
    // the assertion is on the unwrapped value. Getting this backwards is how a fake validates the wrong code.
    const kd = await client.getBlockKramdown(docId);
    check('getBlockKramdown hands back the kramdown string (the client unwraps { id, kramdown })', typeof kd === 'string');
    check('★ the kramdown reflects the nesting with two spaces', kd.includes('  - '), JSON.stringify(kd));

    // ★ The write path returns `null` from `updateBlockDom` —— the client discards the transaction array.
    //   What a test checks is therefore the **kernel state**, not a return value: asserting on the document is
    //   the whole point, because the UI is what lies (the reported `Tab` bug showed an indent SiYuan never got).
    const para = kernel.rows().find((b) => b.type === 'p')!;
    const ret = await client.updateBlockDom(para.id, '<div data-node-id="' + para.id + '">丙</div>');
    // ★ `updateBlockDom` is declared `Promise<null>` but that is a **type assertion, not a conversion** ——
    //   `post<T>` returns what the kernel sent. The kernel sends the transaction array, so that is what the
    //   caller really gets. Asserted here because a test written from the signature would be testing the
    //   declaration instead of the product.
    check(
      '★★ updateBlockDom declares Promise<null> but really resolves the transaction array (the declaration is an assertion)',
      Array.isArray(ret) && (ret as unknown as unknown[]).length === 1,
      `got ${JSON.stringify(ret)}`,
    );
    // ★ `dataType: 'dom'` hands the kernel a DOM fragment, and the kernel stores it as given —— so the value
    //   to assert on is the fragment, not the text inside it. A test that expected the extracted text was
    //   testing an assumption about the fake rather than the fake's contract.
    check(
      '★★ the update really changed the block (assert on the document, not the return)',
      kernel.rows().find((b) => b.id === para.id)?.content?.includes('丙') === true,
      JSON.stringify(kernel.rows().find((b) => b.id === para.id)?.content),
    );

    // ★ The transaction shape itself is asserted through the **raw** response, since the client hides it.
    //   Measured: `data` is an array of `{ timestamp, doOperations, undoOperations }`.
    const raw = await (client as unknown as { post: (e: string, b?: unknown) => Promise<unknown> }).post(
      '/api/block/updateBlock',
      { id: para.id, dataType: 'markdown', data: '丁' },
    );
    const tx = raw as Array<{ doOperations: unknown[]; undoOperations: unknown[] }>;
    check('★★ updateBlock answers an ARRAY of transactions (measured shape)', Array.isArray(tx) && tx.length === 1);
    check(
      '★★ a transaction carries doOperations and undoOperations (measured)',
      Array.isArray(tx[0].doOperations) && Array.isArray(tx[0].undoOperations),
      Object.keys(tx[0]).join(','),
    );
  }

  // ---------------------------------------------------------------- the measured traps

  {
    // ★ Trap 1: a write to a block that never existed says `tree not found`, NOT `indexing`.
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    let msg = '';
    try {
      await client.updateBlockDom('20260101000000-nope0000', '<div>x</div>');
    } catch (e) {
      msg = (e as Error).message;
    }
    check(
      '★ a write to a never-existed block answers `tree not found` (measured)',
      msg === VMSG.treeNotFound('20260101000000-nope0000'),
      `got ${JSON.stringify(msg)}`,
    );
  }

  {
    // ★ Trap 2: the ~100 ms window. Inside it the write says `indexing`; after it, `tree not found`.
    //   Reproduced because a caller that assumes the friendly message arrives immediately is exactly the bug
    //   the original `isTargetGoneError` had.
    let clock = 0;
    // ★ The clock the kernel reads must ADVANCE for the window to be testable: `elapsed()` is
    //   `now() - startMs`, so a frozen clock means every write is "inside the window" and the second half of
    //   this pair could never be reached. (The fake is driven by `now`, so the test owns the clock.)
    const kernel2 = new VirtualKernel({ now: () => clock, sqlIndexDelayMs: 0 });
    const c2 = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel2.fetchImpl });
    const d2 = kernel2.seedDoc('t', '- 甲\n');
    const i2 = kernel2.rows().find((b) => b.type === 'i')!;
    await c2.removeDoc(d2);
    clock = 10; // inside the measured ~100 ms window
    let inside = '';
    try {
      await c2.updateBlockDom(i2.id, '<div>x</div>');
    } catch (e) {
      inside = (e as Error).message;
    }
    check(
      '★★ a write inside the ~100 ms window says `indexing` (measured window)',
      inside === VMSG.indexing(i2.id),
      `got ${JSON.stringify(inside)}`,
    );

    // Same situation, after the window.
    const kernel3 = new VirtualKernel({ now: () => clock, sqlIndexDelayMs: 0 });
    const c3 = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel3.fetchImpl });
    const d3 = kernel3.seedDoc('t', '- 甲\n');
    const i3 = kernel3.rows().find((b) => b.type === 'i')!;
    await c3.removeDoc(d3);
    clock = 200; // past the measured ~100 ms window
    let after = '';
    try {
      await c3.updateBlockDom(i3.id, '<div>x</div>');
    } catch (e) {
      after = (e as Error).message;
    }
    check(
      '★★ the same write after the window says `tree not found` (measured window)',
      after === VMSG.treeNotFound(i3.id),
      `got ${JSON.stringify(after)}`,
    );

    // ★ And a **read** has no window at all (measured): `block not found` at every moment.
    const kernel4 = new VirtualKernel({ now: () => clock, sqlIndexDelayMs: 0 });
    const c4 = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel4.fetchImpl });
    const d4 = kernel4.seedDoc('t', '- 甲\n');
    await c4.removeDoc(d4);
    let readMsg = '';
    try {
      await c4.getBlockDOM(d4);
    } catch (e) {
      readMsg = (e as Error).message;
    }
    check(
      '★★ a READ of a deleted block has no window —— `block not found` immediately (measured)',
      readMsg === VMSG.blockNotFound,
      `got ${JSON.stringify(readMsg)}`,
    );
  }

  {
    // ★ Trap 3: the SQL index lags a creation (~2 s measured). A caller that reads once and gives up fails
    //   here exactly as it fails against a live kernel.
    let clock = 0;
    const kernel = new VirtualKernel({ now: () => clock });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');

    const early = await client.sql(`SELECT id FROM blocks WHERE root_id='${docId}' LIMIT 10`);
    check('★★ the SQL index does NOT see a brand-new document (the measured ~2 s lag)', early.length === 0, JSON.stringify(early));

    clock = 2500;
    const later = await client.sql(`SELECT id FROM blocks WHERE root_id='${docId}' LIMIT 10`);
    check('★★ after the lag the index sees it', later.length > 0, JSON.stringify(later));
  }

  {
    // ★ Trap 4: moving into an EMPTY list answers code 0 and does nothing, permanently (measured).
    //   This is why the plugin creates a placeholder item —— the workaround must be exercised, not assumed.
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');
    const item = kernel.rows().find((b) => b.type === 'i')!;
    const emptyList = kernel.rows().find((b) => b.type === 'l')!;
    // Empty the list as the kernel sees it.
    // ★ Empty the list first, so this really is the "move into an empty List" case the kernel answers
    //   `code: 0` to while doing nothing.
    // ★ The target must be a list that is genuinely EMPTY and separate from the node under test. A first
    //   attempt reused the item's own list, which contained the item, so the guard never fired and the case
    //   passed against the wrong situation.
    const emptyList2 = kernel.addEmptyListForTest(docId);
    const before = kernel.itemCount(emptyList2);
    let code = 'ok';
    try {
      await client.moveBlock(item.id, emptyList2);
    } catch (e) {
      code = (e as Error).message;
    }
    const stillThere = kernel.rows().find((b) => b.id === item.id)?.parentId;
    check(
      '★★ moving into an empty List answers code 0 (measured) and the item does NOT move',
      code === 'ok' && before === 0 && stillThere !== emptyList2,
      `code=${code} before=${before} parent=${stillThere} list=${emptyList2}`,
    );
  }

  // ---------------------------------------------------------------- an unimplemented endpoint is loud

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    let threw = '';
    try {
      // A real endpoint this fake does not model. It must NOT answer "success".
      await (client as unknown as { post: (e: string, b?: unknown) => Promise<unknown> }).post('/api/not/implemented');
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      '★ an endpoint the fake does not implement throws instead of pretending to succeed',
      threw.includes('does not implement'),
      `got ${JSON.stringify(threw)}`,
    );
  }

  // ---------------------------------------------------------------- DOM AST generation & parseDomToTree

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('测试文档', '- 节点一\n  - 节点二\n');
    const domRes = await client.getBlockDOM(docId);
    check('getBlockDOM returns id and dom HTML', typeof domRes.dom === 'string' && domRes.dom.length > 0);
    const treeState = parseDomToTree(domRes.dom, docId);
    check('parseDomToTree finds the topListId', Boolean(treeState.topListId));
    check('parseDomToTree tracks aliveIds for items and paragraphs', treeState.aliveIds.size >= 4);
    check('parseDomToTree resolves itemToParagraph', treeState.itemToParagraph.size === 2);
    check('parseDomToTree resolves itemToChildList for nested nodes', treeState.itemToChildList.size === 1);
  }

  // ---------------------------------------------------------------- task markers & subTypes

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('测试文档', '- [ ] 待办节点\n- [x] 节点二\n');
    const domRes = await client.getBlockDOM(docId);
    const treeState = parseDomToTree(domRes.dom, docId);
    const items = kernel.rows().filter((b) => b.type === 'i');
    check('todo item is marked unchecked (status 1)', treeState.itemTaskStatus.get(items[0].id) === 1);
    check('done item is marked checked (status 2)', treeState.itemTaskStatus.get(items[1].id) === 2);

    await client.updateTaskListItemMarker(items[0].id, 'X');
    const updatedDom = await client.getBlockDOM(docId);
    const updatedState = parseDomToTree(updatedDom.dom, docId);
    check('updateTaskListItemMarker flips task status to checked', updatedState.itemTaskStatus.get(items[0].id) === 2);
  }

  // ---------------------------------------------------------------- ordered lists & numbering

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('测试文档', '1. 节点一\n2. 节点二\n');
    const kids = await client.getChildBlocks(docId);
    const listKid = kids.find((k) => k.type === 'l');
    check('ordered list has subType o', listKid?.subType === 'o');
    const domRes = await client.getBlockDOM(docId);
    check('ordered list DOM carries data-subtype="o"', domRes.dom.includes('data-subtype="o"'));
  }

  // ---------------------------------------------------------------- rich SQL query engine

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('测试文档', '- 节点一\n  - 节点二\n');
    const rows = await client.sql<{ id: string; type: string; subtype: string; sort: number }>(
      `SELECT id, parent_id, root_id, type, subtype, content, markdown, ial, sort FROM blocks WHERE root_id = '${docId}' AND type IN ('l', 'i', 'p') ORDER BY sort ASC LIMIT 2000`,
    );
    check('SQL WHERE type IN (...) filters by multiple block types', rows.length >= 4);
    check('SQL projects subtype column without undefined', rows.every((r) => typeof r.subtype === 'string'));

    const items = kernel.rows().filter((b) => b.type === 'i');
    const idIn = await client.sql<{ id: string; subtype: string }>(
      `SELECT id, subtype FROM blocks WHERE id IN ('${items[0].id}', '${items[1].id}') LIMIT 2`,
    );
    check('SQL WHERE id IN (...) resolves exact block IDs', idIn.length === 2);

    const countRes = await client.sql<{ count: number }>(`SELECT count(1) as count FROM blocks WHERE root_id = '${docId}'`);
    check('SQL count(1) aggregation returns matching count', countRes.length === 1 && countRes[0].count >= 4);
  }

  // ---------------------------------------------------------------- insertBlockWithOpData

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('测试文档', '- 节点一\n');
    const ins = await client.insertBlockWithOpData('- 节点二', docId);
    check('insertBlockWithOpData returns listItemId from opData', Boolean(ins.listItemId));
    check('insertBlockWithOpData returns paragraphId from opData', Boolean(ins.paragraphId));
    check('insertBlockWithOpData returns opData with data-node-id', ins.opData.includes('data-node-id='));
  }

  // ---------------------------------------------------------------- report

  console.log(`virtual-kernel: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
  void vnode;
})();
