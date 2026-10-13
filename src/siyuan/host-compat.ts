// Host compatibility layer: isolates volatile SiYuan host runtime properties
// (window layout hierarchies, app instances, version-dependent API fallbacks).

import type { SiYuanClient } from './api';
import { getActiveDocId } from '../plugin/active-doc';

export { getActiveDocId };

/**
 * Resolved SiYuan App reference.
 * The App instance is passed directly to Plugin constructors by SiYuan's plugin runtime,
 * and also accessible via window.siyuan.ws.app on modern desktop clients.
 */
export function getHostApp(plugin?: unknown): unknown | undefined {
  const pluginApp = (plugin as { app?: unknown })?.app;
  if (pluginApp && typeof pluginApp === 'object') {
    return pluginApp;
  }
  const globalApp = (globalThis as unknown as { siyuan?: { ws?: { app?: unknown } } })
    ?.siyuan?.ws?.app;
  if (globalApp && typeof globalApp === 'object') {
    return globalApp;
  }
  return undefined;
}

let cachedKernelVersion: string | null = null;

/**
 * Query the SiYuan kernel version (e.g. "3.8.7").
 * Caches the result after the first successful lookup.
 * Probes the /api/system/version endpoint with fallback to window.siyuan configuration.
 */
export async function getKernelVersion(client: SiYuanClient): Promise<string> {
  if (cachedKernelVersion) {
    return cachedKernelVersion;
  }
  try {
    const v = await client.getKernelVersion();
    if (v) {
      cachedKernelVersion = v;
      return v;
    }
  } catch {
    // Handled below via global fallback
  }

  const globalVersion =
    (globalThis as unknown as { siyuan?: { config?: { system?: { kernelVersion?: string } } } })
      ?.siyuan?.config?.system?.kernelVersion ?? '';
  if (globalVersion) {
    cachedKernelVersion = globalVersion;
    return globalVersion;
  }
  return '';
}

/** Clear cached kernel version (for test harnesses). */
export function clearKernelVersionCache(): void {
  cachedKernelVersion = null;
}

/**
 * Update a task list item's checked marker with automatic fallback.
 *
 * Tries the native `/api/block/updateTaskListItemMarker` endpoint first (SiYuan 3.1+). If the
 * endpoint is unavailable on an older kernel, degrades to a markdown write of the same block.
 *
 * ★★ The fallback must carry the node's **whole subtree**, not just its own line. Writing one line
 *    drops the node's children — measured on the isolated instance, on `- [ ] 父任务 / - 子节点`:
 *
 *      updateTaskListItemMarker   children 1 → 1   (the primary call; safe)
 *      updateBlock(subtree)       children 1 → 1   (block ids preserved too)
 *      updateBlock(node line)     children 1 → 0   ← silent data loss
 *
 *    `store.ts` documents the same measurement for the sibling branch, which is why creation and
 *    clearing already pass `nodeSubtreeToKramdown(n)`. The fallback used to be the one write that
 *    did not, so on a kernel without the marker API a to-do toggle would delete its own children.
 */
export async function updateTaskMarkerWithFallback(
  client: SiYuanClient,
  id: string,
  isDone: boolean,
  subtreeKramdown = '',
): Promise<void> {
  const marker = isDone ? 'X' : ' ';
  try {
    await client.updateTaskListItemMarker(id, marker);
  } catch {
    // Fallback: rewrite the marker on the subtree's **first line** and write the subtree back.
    // ★ Lower-case `x` here, matching `nodeToLine`'s own emission (`[x] `) rather than the marker
    //   API's `X` —— one spelling for what the document holds, so a read-back cannot disagree.
    const lineMarker = isDone ? 'x' : ' ';
    const lines = subtreeKramdown.split('\n');
    if (lines.length && /^\s*-\s*\[[ xX]\]/.test(lines[0])) {
      lines[0] = lines[0].replace(/^(\s*-\s*)\[[ xX]\]/, `$1[${lineMarker}]`);
    } else {
      // No usable subtree (an unmapped or already-broken node): say so rather than writing a
      // line that would silently drop whatever is under it.
      throw new Error(
        `updateTaskMarkerWithFallback: cannot rewrite the marker for ${id} without its subtree — ` +
          'the caller must pass the node\'s kramdown, or children are lost',
      );
    }
    await client.updateBlock(id, lines.join('\n'));
  }
}
