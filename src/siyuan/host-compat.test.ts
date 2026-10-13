// Acceptance tests for host compatibility adapter (host-compat.ts).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getHostApp,
  getKernelVersion,
  clearKernelVersionCache,
  updateTaskMarkerWithFallback,
  supportsTaskMarkerApi,
  compareVersions,
  TASK_MARKER_API_MIN_VERSION,
} from './host-compat';
import type { SiYuanClient } from './api';

/**
 * ★ Every case below must start from a **known** cached version. `getKernelVersion` caches its first
 *   success in module scope, so without the reset the answer depends on whichever case ran first ——
 *   and the version is what now decides whether the marker API is attempted at all.
 */
const clientWithVersion = (version: string, overrides: Record<string, unknown> = {}): SiYuanClient =>
  ({ getKernelVersion: async () => version, ...overrides } as unknown as SiYuanClient);

test('getHostApp resolves official app instance from plugin before window global', () => {
  const pluginAppObj = { id: 'app-from-plugin' };
  const globalAppObj = { id: 'app-from-global' };

  // 1. Both present -> plugin wins
  const origSiyuan = (globalThis as unknown as { siyuan?: unknown }).siyuan;
  try {
    (globalThis as unknown as { siyuan: unknown }).siyuan = { ws: { app: globalAppObj } };
    const resolved = getHostApp({ app: pluginAppObj });
    assert.equal(resolved, pluginAppObj);

    // 2. Only global present -> global wins
    const resolvedGlobal = getHostApp({});
    assert.equal(resolvedGlobal, globalAppObj);

    // 3. Neither present -> undefined
    (globalThis as unknown as { siyuan: unknown }).siyuan = undefined;
    const resolvedNone = getHostApp(null);
    assert.equal(resolvedNone, undefined);
  } finally {
    (globalThis as unknown as { siyuan: unknown }).siyuan = origSiyuan;
  }
});

test('getKernelVersion reads from client and caches result', async () => {
  clearKernelVersionCache();
  let calls = 0;
  const mockClient = {
    getKernelVersion: async () => {
      calls++;
      return '3.8.7';
    },
  } as unknown as SiYuanClient;

  const v1 = await getKernelVersion(mockClient);
  assert.equal(v1, '3.8.7');
  assert.equal(calls, 1);

  // Second call should return cached version without calling client again
  const v2 = await getKernelVersion(mockClient);
  assert.equal(v2, '3.8.7');
  assert.equal(calls, 1);
});

test('getKernelVersion falls back to globalThis when client call fails', async () => {
  clearKernelVersionCache();
  const origSiyuan = (globalThis as unknown as { siyuan?: unknown }).siyuan;
  try {
    (globalThis as unknown as { siyuan: unknown }).siyuan = {
      config: { system: { kernelVersion: '3.8.6' } },
    };
    const failingClient = {
      getKernelVersion: async () => {
        throw new Error('endpoint failed');
      },
    } as unknown as SiYuanClient;

    const v = await getKernelVersion(failingClient);
    assert.equal(v, '3.8.6');
  } finally {
    (globalThis as unknown as { siyuan: unknown }).siyuan = origSiyuan;
    clearKernelVersionCache();
  }
});

test('updateTaskMarkerWithFallback uses primary updateTaskListItemMarker on success', async () => {
  clearKernelVersionCache();
  let markerCalled = false;
  let updateBlockCalled = false;

  const mockClient = clientWithVersion('3.8.7', {
    updateTaskListItemMarker: async (id: string, marker: string) => {
      markerCalled = true;
      assert.equal(id, 'block-task-1');
      assert.equal(marker, 'X');
      return null;
    },
    updateBlock: async () => {
      updateBlockCalled = true;
      return null;
    },
  });

  await updateTaskMarkerWithFallback(mockClient, 'block-task-1', true, '- [ ] Task text\n');
  assert.equal(markerCalled, true);
  assert.equal(updateBlockCalled, false);
  clearKernelVersionCache();
});

// ──────────────────────────────────────────────────────────────────
// Version negotiation: the detection decides, not a failed request.
console.log('\n★ version negotiation decides the task-marker path');

test('compareVersions is numeric, not lexicographic', () => {
  // The case a string compare gets wrong: '3.9.0' >= '3.10.0' is TRUE lexicographically.
  assert.equal(compareVersions('3.9.0', '3.10.0'), -1);
  assert.equal(compareVersions('3.10.0', '3.1.0'), 1);
  assert.equal(compareVersions('3.1.0', '3.1.0'), 0);
  assert.equal(compareVersions('3.1', '3.1.0'), 0, 'a missing component is zero');
  assert.equal(compareVersions('4.0.0', '3.1.0'), 1);
  assert.equal(compareVersions('v3.1.0', '3.1.0'), null, 'unparseable -> null, not a guess');
  assert.equal(compareVersions('', '3.1.0'), null);
});

test('supportsTaskMarkerApi reads the version, and an unknown one answers "attempt it"', async () => {
  clearKernelVersionCache();
  assert.equal(await supportsTaskMarkerApi(clientWithVersion('3.8.7')), true);
  clearKernelVersionCache();
  assert.equal(
    await supportsTaskMarkerApi(clientWithVersion(TASK_MARKER_API_MIN_VERSION)),
    true,
    'the threshold itself counts as supported (>=, not >)',
  );
  clearKernelVersionCache();
  assert.equal(await supportsTaskMarkerApi(clientWithVersion('3.0.9')), false, 'older than the threshold');
  clearKernelVersionCache();
  // ★ The dangerous direction: an unreadable version must NOT be read as "the feature is absent",
  //   or every unidentified kernel takes the expensive markdown path.
  assert.equal(await supportsTaskMarkerApi(clientWithVersion('')), true);
  clearKernelVersionCache();
  assert.equal(await supportsTaskMarkerApi(clientWithVersion('v3.8.7')), true, 'unparseable -> attempt it');
  clearKernelVersionCache();
});

test('★ a kernel known to predate the marker API goes straight to markdown (no failed request)', async () => {
  clearKernelVersionCache();
  let markerCalled = false;
  let written = '';
  const mockClient = clientWithVersion('3.0.9', {
    updateTaskListItemMarker: async () => {
      markerCalled = true;
      throw new Error('404 page not found');
    },
    updateBlock: async (_id: string, data: string) => {
      written = data;
      return null;
    },
  });

  await updateTaskMarkerWithFallback(mockClient, 'block-old', true, '- [ ] 旧内核任务\n');
  assert.equal(markerCalled, false, 'the version said the endpoint is absent, so it must not be called');
  assert.equal(written, '- [x] 旧内核任务\n');
  clearKernelVersionCache();
});

test('updateTaskMarkerWithFallback degrades to markdown updateBlock when primary marker call fails', async () => {
  let markerCalled = false;
  let updateBlockCalledWith: { id: string; data: string } | null = null;

  const mockClient = {
    updateTaskListItemMarker: async () => {
      markerCalled = true;
      throw new Error('404 not found');
    },
    updateBlock: async (id: string, data: string) => {
      updateBlockCalledWith = { id, data };
      return null;
    },
  } as unknown as SiYuanClient;

  await updateTaskMarkerWithFallback(mockClient, 'block-task-2', false, '- [x] Clean task content\n');
  assert.equal(markerCalled, true);
  assert.ok(updateBlockCalledWith);
  const call = updateBlockCalledWith as { id: string; data: string };
  assert.equal(call.id, 'block-task-2');
  assert.equal(call.data, '- [ ] Clean task content\n');
});

test('★ the fallback carries the subtree, so toggling a to-do cannot drop its children', async () => {
  // Measured on the isolated instance: a node-line-only write takes `- [ ] 父任务 / - 子节点`
  // from 1 child to 0, while the subtree write keeps it (and its block ids).
  let written = '';
  const mockClient = {
    updateTaskListItemMarker: async () => {
      throw new Error('404 not found (an old kernel has no marker API)');
    },
    updateBlock: async (_id: string, data: string) => {
      written = data;
      return null;
    },
  } as unknown as SiYuanClient;

  const subtree = '- [ ] 父任务\n  - 子节点\n';
  await updateTaskMarkerWithFallback(mockClient, 'block-task-3', true, subtree);
  assert.equal(written, '- [x] 父任务\n  - 子节点\n',
    'the child line must survive the fallback, not just the node\'s own line');

  // The other direction, so the marker rewrite is not one-way.
  written = '';
  await updateTaskMarkerWithFallback(mockClient, 'block-task-3', false, '- [x] 父任务\n  - 子节点\n');
  assert.equal(written, '- [ ] 父任务\n  - 子节点\n');
});

test('★ the fallback refuses rather than writing a line that would drop children', async () => {
  const mockClient = {
    updateTaskListItemMarker: async () => {
      throw new Error('404 not found');
    },
    updateBlock: async () => {
      throw new Error('updateBlock must not be reached without a subtree');
    },
  } as unknown as SiYuanClient;

  await assert.rejects(
    () => updateTaskMarkerWithFallback(mockClient, 'block-task-4', true, ''),
    /cannot rewrite the marker .* without its subtree/,
  );
});
