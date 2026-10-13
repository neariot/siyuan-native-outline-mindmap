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
 * Tries the native `/api/block/updateTaskListItemMarker` endpoint first (available in SiYuan 3.1+).
 * If the endpoint returns an error or is unavailable on an older kernel, automatically degrades
 * to updating the block content via markdown.
 */
export async function updateTaskMarkerWithFallback(
  client: SiYuanClient,
  id: string,
  isDone: boolean,
  currentContent = '',
): Promise<void> {
  const marker = isDone ? 'X' : ' ';
  try {
    await client.updateTaskListItemMarker(id, marker);
  } catch (err) {
    // Fallback: update block content via markdown
    const taskPrefix = isDone ? '- [x] ' : '- [ ] ';
    const cleanContent = currentContent.replace(/^-\s*\[[ xX]\]\s*/, '');
    const markdown = `${taskPrefix}${cleanContent}`;
    await client.updateBlock(id, markdown);
  }
}
