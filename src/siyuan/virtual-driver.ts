// In-memory Virtual Host Driver for offline simulation and isolated testing.
//
// Implements IHostDriver without network I/O, allowing instant deterministic testing
// of tree synchronization, reconciler patch application, and host event tracking.

import type { OutlineNode } from '../model/types';
import { applyTreePatches, type TreePatch } from '../core/reconciler';
import { cloneNodes, collectIds } from '../model/tree';
import type { IHostDriver, HostCapabilities, DocumentSnapshot, SyncResult } from './host-driver';

export class VirtualHostDriver implements IHostDriver {
  private docs = new Map<string, DocumentSnapshot>();
  private activeDocId: string | null = null;
  private activeDocListeners = new Set<(docId: string) => void>();
  private capabilities: HostCapabilities = {
    kernelVersion: '3.8.7',
    hasTaskMarkerApi: true,
    supportsDomBlockUpdate: true,
  };

  constructor(initialDocs?: Record<string, { title: string; nodes: OutlineNode[] }>) {
    if (initialDocs) {
      for (const [id, data] of Object.entries(initialDocs)) {
        this.setDocument(id, data.title, data.nodes);
      }
    }
  }

  setDocument(docId: string, title: string, nodes: OutlineNode[], paragraphs: string[] = []): void {
    const blockMap = new Map<string, string>();
    const nodeIds = collectIds(nodes);
    for (const nid of nodeIds) {
      blockMap.set(nid, `blk_${nid}`);
    }
    this.docs.set(docId, {
      docId,
      title,
      paragraphs: [...paragraphs],
      nodes: cloneNodes(nodes),
      blockMap,
    });
  }

  setActiveDocId(docId: string): void {
    this.activeDocId = docId;
    for (const listener of this.activeDocListeners) {
      listener(docId);
    }
  }

  async getCapabilities(): Promise<HostCapabilities> {
    return { ...this.capabilities };
  }

  async loadDocument(docId: string): Promise<DocumentSnapshot> {
    const doc = this.docs.get(docId);
    if (!doc) {
      const emptyDoc: DocumentSnapshot = {
        docId,
        title: 'Untitled',
        paragraphs: [],
        nodes: [],
        blockMap: new Map(),
      };
      this.docs.set(docId, emptyDoc);
      return {
        ...emptyDoc,
        nodes: [],
        paragraphs: [],
        blockMap: new Map(),
      };
    }
    return {
      docId: doc.docId,
      title: doc.title,
      paragraphs: [...doc.paragraphs],
      nodes: cloneNodes(doc.nodes),
      blockMap: new Map(doc.blockMap),
    };
  }

  async applyPatches(docId: string, patches: TreePatch[]): Promise<SyncResult> {
    const doc = this.docs.get(docId);
    if (!doc) {
      return { success: false, appliedCount: 0, error: `Document ${docId} not found` };
    }

    const nextNodes = applyTreePatches(doc.nodes, patches);
    doc.nodes = nextNodes;

    // Maintain blockMap for new/removed nodes
    const aliveIds = collectIds(nextNodes);
    for (const nid of aliveIds) {
      if (!doc.blockMap.has(nid)) {
        doc.blockMap.set(nid, `blk_${nid}`);
      }
    }
    for (const nid of doc.blockMap.keys()) {
      if (!aliveIds.has(nid)) {
        doc.blockMap.delete(nid);
      }
    }

    return { success: true, appliedCount: patches.length };
  }

  observeActiveDocId(callback: (docId: string) => void): () => void {
    this.activeDocListeners.add(callback);
    if (this.activeDocId) {
      callback(this.activeDocId);
    }
    return () => {
      this.activeDocListeners.delete(callback);
    };
  }

  async openBlock(_blockId: string, _options?: { zoomIn?: boolean }): Promise<void> {
    // In-memory simulation: no-op
  }
}
