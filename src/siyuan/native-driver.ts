// Production Native Host Driver connecting to the live SiYuan kernel and plugin runtime.
//
// Implements IHostDriver, adapting pure TreePatches into canonical block operations
// through SiYuanStore, while abstracting kernel version capabilities and host events.

import type { IEventBus } from 'siyuan';
import type { TreePatch } from '../core/reconciler';
import { applyTreePatches } from '../core/reconciler';
import type { SiYuanClient } from './api';
import { getHostApp, getKernelVersion, compareVersions, TASK_MARKER_API_MIN_VERSION } from './host-compat';
import type { DocumentSnapshot, HostCapabilities, IHostDriver, SyncResult } from './host-driver';
import type { SiYuanStore } from './store';
import { getActiveDocId as resolveActiveDocId } from '../plugin/active-doc';

export type OpenTabFunction = (options: {
  app: unknown;
  doc: { id: string; action?: ('cb-get-focus' | 'cb-get-scroll' | 'cb-get-zoom')[] };
  keepAlive?: boolean;
}) => unknown;

export interface NativeHostDriverOptions {
  client: SiYuanClient;
  store: SiYuanStore;
  plugin?: unknown;
  eventBus?: IEventBus;
  openTab?: OpenTabFunction;
}

export class NativeHostDriver implements IHostDriver {
  private client: SiYuanClient;
  private store: SiYuanStore;
  private plugin?: unknown;
  private eventBus?: IEventBus;
  private openTabFn?: OpenTabFunction;

  constructor(options: NativeHostDriverOptions) {
    this.client = options.client;
    this.store = options.store;
    this.plugin = options.plugin;
    this.eventBus = options.eventBus;
    this.openTabFn = options.openTab;
  }

  async getCapabilities(): Promise<HostCapabilities> {
    const version = await getKernelVersion(this.client);
    // ★ The shared numeric comparison, not `version >= '3.1.0'`: a string compare answers the wrong
    //   question as soon as the threshold gains a two-digit component ('3.9.0' >= '3.10.0' is true
    //   lexicographically). An unreadable version answers `true` — attempt the call — never "absent".
    const cmp = version ? compareVersions(version, TASK_MARKER_API_MIN_VERSION) : null;
    return {
      kernelVersion: version,
      hasTaskMarkerApi: cmp === null ? true : cmp >= 0,
      supportsDomBlockUpdate: true,
    };
  }

  async loadDocument(docId: string): Promise<DocumentSnapshot> {
    const doc = await this.store.loadDoc(docId);
    const blockMap = await this.store.loadBlockMap(docId);
    return {
      docId,
      title: doc.meta.name,
      paragraphs: doc.meta.paragraphs ?? [],
      nodes: doc.nodes,
      blockMap,
    };
  }

  async applyPatches(docId: string, patches: TreePatch[]): Promise<SyncResult> {
    if (patches.length === 0) {
      return { success: true, appliedCount: 0 };
    }

    const currentDoc = await this.store.loadDoc(docId);
    const targetNodes = applyTreePatches(currentDoc.nodes, patches);

    this.store.beginWrite(docId);
    try {
      const phs = this.store.beginPlaceholderScope();
      await this.store.syncNumbering(docId, targetNodes);
      await this.store.syncStructure(docId, targetNodes, phs);
      await this.store.syncDeletions(docId, targetNodes);
      await this.store.saveNodesIncremental(docId, targetNodes);
      return { success: true, appliedCount: patches.length };
    } catch (err) {
      return {
        success: false,
        appliedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.store.endWrite();
    }
  }

  observeActiveDocId(callback: (docId: string) => void): () => void {
    const onSwitch = (event?: unknown): void => {
      // 1. Proactively inspect official protyle event detail rootID
      const customEvent = event as { detail?: { protyle?: { block?: { rootID?: string } } } } | undefined;
      const rootId = customEvent?.detail?.protyle?.block?.rootID;
      if (rootId) {
        callback(rootId);
        return;
      }

      // 2. Invariant fallback: frame-scheduled layout DOM inspection
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          const id = resolveActiveDocId();
          if (id) {
            callback(id);
          }
        });
      }
    };

    if (this.eventBus) {
      this.eventBus.on('switch-protyle', onSwitch);
      return () => {
        this.eventBus?.off('switch-protyle', onSwitch);
      };
    }

    return () => {};
  }

  async openBlock(blockId: string, options?: { zoomIn?: boolean }): Promise<void> {
    const appRef = getHostApp(this.plugin);
    if (!appRef) {
      return;
    }

    // ★ Named `openTab`, not a generic local: the call site is read by a static probe
    //   (`src/plugin/ref-nav.test.ts`), which asserts that every openTab call passes the real
    //   application instance. A local called `fn` made that guard unable to see this call at all.
    let openTab = this.openTabFn;
    if (!openTab) {
      try {
        const mod = await import('siyuan');
        openTab = mod.openTab;
      } catch {
        // Host runtime not available in offline context
      }
    }

    if (!openTab) {
      return;
    }

    const actions = options?.zoomIn
      ? ['cb-get-focus', 'cb-get-scroll', 'cb-get-zoom']
      : ['cb-get-focus', 'cb-get-scroll'];

    openTab({
      app: appRef,
      doc: {
        id: blockId,
        action: actions as ('cb-get-focus' | 'cb-get-scroll')[],
      },
      keepAlive: true,
    });
  }
}
