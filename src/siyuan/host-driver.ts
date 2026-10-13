// Host Abstraction Layer (HAL) SPI.
//
// Decouples application state and UI logic from host platform details.
// Provides a pluggable, version-resilient bridge for loading documents,
// applying tree patches, observing active documents, and interacting with host blocks.

import type { OutlineNode } from '../model/types';
import type { TreePatch } from '../core/reconciler';

export interface HostCapabilities {
  kernelVersion: string;
  hasTaskMarkerApi: boolean;
  supportsDomBlockUpdate: boolean;
}

export interface DocumentSnapshot {
  docId: string;
  title: string;
  paragraphs: string[];
  nodes: OutlineNode[];
  blockMap: Map<string, string>; // nodeId -> blockId
}

export interface SyncResult {
  success: boolean;
  appliedCount: number;
  error?: string;
}

export interface IHostDriver {
  getCapabilities(): Promise<HostCapabilities>;
  loadDocument(docId: string): Promise<DocumentSnapshot>;
  applyPatches(docId: string, patches: TreePatch[]): Promise<SyncResult>;
  observeActiveDocId(callback: (docId: string) => void): () => void;
  openBlock(blockId: string, options?: { zoomIn?: boolean }): Promise<void>;
}
