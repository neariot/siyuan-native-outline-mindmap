// Unit tests for the Host Abstraction Layer (HAL) drivers: VirtualHostDriver and NativeHostDriver.

import { VirtualHostDriver } from './virtual-driver';
import { NativeHostDriver } from './native-driver';
import { diffTrees } from '../core/reconciler';
import type { OutlineNode } from '../model/types';
import type { SiYuanClient } from './api';
import type { SiYuanStore } from './store';
import type { IEventBus } from 'siyuan';

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

const mkNode = (id: string, text = id, children: OutlineNode[] = []): OutlineNode => ({
  id,
  modified: 0,
  text,
  children,
});

// ---- VirtualHostDriver ----
void (async () => {
  const vDriver = new VirtualHostDriver();

  // 1. Capabilities
  const caps = await vDriver.getCapabilities();
  check('vDriver: returns valid kernel version', caps.kernelVersion === '3.8.7');
  check('vDriver: hasTaskMarkerApi is true', caps.hasTaskMarkerApi === true);

  // 2. Load non-existent doc
  const emptyDoc = await vDriver.loadDocument('doc-none');
  check('vDriver: loading unknown doc returns empty array', emptyDoc.nodes.length === 0);

  // 3. Set and load doc
  const docId = 'doc-1';
  const initialNodes = [mkNode('a', 'alpha'), mkNode('b', 'beta')];
  vDriver.setDocument(docId, 'Test Doc', initialNodes);

  const loaded = await vDriver.loadDocument(docId);
  check('vDriver: loads stored document nodes', loaded.nodes.length === 2 && loaded.title === 'Test Doc');

  // 4. Apply reconciler patches
  const targetNodes = [mkNode('a', 'alpha-edited'), mkNode('c', 'gamma')];
  const patches = diffTrees(loaded.nodes, targetNodes);
  const syncRes = await vDriver.applyPatches(docId, patches);

  check('vDriver: applyPatches succeeds', syncRes.success === true);
  const reloaded = await vDriver.loadDocument(docId);
  check('vDriver: updated doc has edited text', reloaded.nodes[0]?.text === 'alpha-edited');
  check('vDriver: updated doc has inserted node', reloaded.nodes[1]?.id === 'c');

  // 5. Active doc observer
  let observed = '';
  const unsub = vDriver.observeActiveDocId((id) => {
    observed = id;
  });
  vDriver.setActiveDocId('doc-active');
  check('vDriver: active doc observer triggered', observed === 'doc-active');
  unsub();
  vDriver.setActiveDocId('doc-ignored');
  check('vDriver: active doc observer unsubscribed cleanly', observed === 'doc-active');

  // ---- NativeHostDriver ----
  const mockClient = {
    getKernelVersion: async () => '3.8.7',
  } as unknown as SiYuanClient;

  const mockStore = {
    loadDoc: async (id: string) => ({
      meta: { name: 'Native Doc' },
      nodes: [mkNode('n1')],
    }),
    loadBlockMap: async () => new Map<string, string>(),
    beginWrite: () => {},
    endWrite: () => {},
    beginPlaceholderScope: () => new Set<string>(),
    syncNumbering: async () => {},
    syncStructure: async () => {},
    syncDeletions: async () => {},
    saveNodesIncremental: async () => {},
  } as unknown as SiYuanStore;

  const busHandlers = new Map<string, (e?: unknown) => void>();
  const mockBus = {
    on: (evt: string, handler: (e?: unknown) => void) => {
      busHandlers.set(evt, handler);
    },
    off: (evt: string) => {
      busHandlers.delete(evt);
    },
  } as unknown as IEventBus;

  const nDriver = new NativeHostDriver({
    client: mockClient,
    store: mockStore,
    eventBus: mockBus,
  });

  const nCaps = await nDriver.getCapabilities();
  check('nDriver: reads kernel version from client', nCaps.kernelVersion === '3.8.7');
  check('nDriver: negotiates hasTaskMarkerApi', nCaps.hasTaskMarkerApi === true);

  // Native driver active doc event handling
  let nativeObserved = '';
  const nUnsub = nDriver.observeActiveDocId((id) => {
    nativeObserved = id;
  });

  const switchHandler = busHandlers.get('switch-protyle');
  check('nDriver: registers switch-protyle on eventBus', typeof switchHandler === 'function');

  // Trigger switch-protyle with event detail carrying rootID
  switchHandler?.({
    detail: {
      protyle: {
        block: {
          rootID: 'doc-native-event',
        },
      },
    },
  });

  check('nDriver: handles protyle event detail rootID directly without DOM', nativeObserved === 'doc-native-event');
  nUnsub();
  check('nDriver: unsubscribes event cleanly', !busHandlers.has('switch-protyle'));

  // Open block verification
  let vOpenCompleted = false;
  await vDriver.openBlock('blk-test');
  vOpenCompleted = true;
  check('vDriver: openBlock completes without throwing', vOpenCompleted === true);

  let openedBlockTarget = '';
  const mockPlugin = { app: { workspace: {} } };
  const nDriverWithOpenTab = new NativeHostDriver({
    client: mockClient,
    store: mockStore,
    plugin: mockPlugin,
    openTab: (options) => {
      openedBlockTarget = options.doc.id;
    },
  });
  await nDriverWithOpenTab.openBlock('blk-target-123', { zoomIn: true });
  check('nDriver: openBlock delegates to openTab with target id', openedBlockTarget === 'blk-target-123');

  // Exit report
  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  FAIL ' + f);
    throw new Error(`${fail} test(s) failed`);
  }
})();
