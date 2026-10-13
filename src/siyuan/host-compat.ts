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
 * The kernel release that introduced `/api/block/updateTaskListItemMarker`.
 *
 * ★ Measured against the **official** release tags (`git show <tag>:kernel/api/router.go`), not the
 *   development checkout and not a fork: the route is absent in v3.6.2 / v3.6.3 and present from
 *   **v3.6.4**. It was written as `3.1.0` from the plugin's own comment, and that was wrong by five
 *   minor releases —— which matters because the value decides whether the native call is attempted
 *   at all: a kernel in 3.1.0–3.6.3 was told "you have the endpoint", so every to-do toggle spent a
 *   round trip on a 404 before taking the markdown path.
 *
 * ★★ The rule this encodes: a version constant is a **claim about upstream**, so it is measured
 *    against upstream's released tags. `scripts/check-version-floor.py` re-derives it from the tags
 *    on every run, so the number cannot drift back to a remembered value.
 */
export const TASK_MARKER_API_MIN_VERSION = '3.6.4';

/**
 * Numeric version comparison: -1 / 0 / 1, or `null` when either side is not a dotted number.
 *
 * ★ Not a string compare. `'3.9.0' >= '3.10.0'` is **true** lexicographically and false numerically,
 *   so a string comparison silently answers the wrong question the moment the threshold gains a
 *   two-digit component. `null` for anything unparseable is deliberate: an unknown version must fall
 *   through to "attempt the call", never to "the feature is absent".
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  if (pa.length === 0 || pb.length === 0) return null;
  const na = pa.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  const nb = pb.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  if (na.some(Number.isNaN) || nb.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Whether this kernel has the native task-marker endpoint.
 *
 * ★ An **unknown** version answers `true` (attempt the call, and the `catch` still degrades) rather
 *   than `false`: guessing "the feature is absent" would take the markdown path on every kernel we
 *   cannot identify, which is the expensive one. Only a version we can read *and* compare below the
 *   threshold answers `false`.
 */
export async function supportsTaskMarkerApi(client: SiYuanClient): Promise<boolean> {
  const v = await getKernelVersion(client);
  if (!v) return true;
  const cmp = compareVersions(v, TASK_MARKER_API_MIN_VERSION);
  return cmp === null ? true : cmp >= 0;
}

/**
 * Update a task list item's checked marker with automatic fallback.
 *
 * The native `/api/block/updateTaskListItemMarker` endpoint (SiYuan 3.1+) is tried first. A kernel
 * **known** to predate it goes straight to the markdown write, so the version detection is what
 * decides, not a failed request; any other failure still degrades through the same path.
 *
 * ★★ The markdown fallback must carry the node's **whole subtree**, not just its own line. Writing
 *    one line drops the node's children — measured on the isolated instance, on `- [ ] 父任务 / - 子节点`:
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
  if (await supportsTaskMarkerApi(client)) {
    try {
      await client.updateTaskListItemMarker(id, marker);
      return;
    } catch {
      // Fall through to the markdown write: a kernel that reports the capability can still refuse.
    }
  }
  // Markdown path: rewrite the marker on the subtree's **first line** and write the subtree back.
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
