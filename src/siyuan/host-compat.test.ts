// Acceptance tests for host compatibility adapter (host-compat.ts).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getHostApp,
  getKernelVersion,
  clearKernelVersionCache,
  updateTaskMarkerWithFallback,
} from './host-compat';
import type { SiYuanClient } from './api';

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
  let markerCalled = false;
  let updateBlockCalled = false;

  const mockClient = {
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
  } as unknown as SiYuanClient;

  await updateTaskMarkerWithFallback(mockClient, 'block-task-1', true, '- [ ] Task text\n');
  assert.equal(markerCalled, true);
  assert.equal(updateBlockCalled, false);
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
