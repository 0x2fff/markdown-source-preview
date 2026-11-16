/**
 * Streams rest blocks into the DOM through a low-priority queue.
 * insert/update ops are queued; each flush() applies up to
 * CHUNK_SIZE ops synchronously and defers the rest to the next rAF,
 * keeping main-thread tasks short.
 */

import type { BlockStore } from './blockStore.js';

interface QueueItem {
  blockId: string;
  html: string;
  beforeId?: string | null;
  generation?: number;
  contentHash?: string;
  enqueuedAt?: number;
}

const MAX_OPS_PER_CHUNK = 150; // hard cap per rAF
const CHUNK_BUDGET_MS = 6; // stop applying ops once this much JS time elapsed

export class RenderQueue {
  private _queue: QueueItem[] = [];
  private _urgent: QueueItem[] = [];
  private _rafHandle: number | null = null;
  private _backgroundChunkCount = 0;
  private _backgroundChunkLastMs = 0;
  private _backgroundChunkMaxMs = 0;
  private _urgentStartWaitMs = 0;
  private _disposed = false;

  constructor(private readonly _store: BlockStore) {}

  enqueueInsert(
    blockId: string,
    html: string,
    beforeId?: string | null,
    generation?: number,
    contentHash?: string,
  ): void {
    if (this._disposed) return;
    this._queue.push({
      blockId,
      html,
      beforeId,
      generation,
      contentHash,
    });
  }

  enqueueUpdate(
    blockId: string,
    html: string,
    generation?: number,
    contentHash?: string,
  ): void {
    if (this._disposed) return;
    // If an insert is still queued, replace its HTML to preserve order
    for (const item of this._queue) {
      if (item.blockId === blockId) {
        item.html = html;
        if (generation !== undefined) item.generation = generation;
        if (contentHash) item.contentHash = contentHash;
        return;
      }
    }
    for (const item of this._urgent) {
      if (item.blockId === blockId) {
        item.html = html;
        if (generation !== undefined) item.generation = generation;
        if (contentHash) item.contentHash = contentHash;
        return;
      }
    }
    // Do not queue edits for already-rendered blocks behind initial rest inserts
    this._urgent.push({
      blockId,
      html,
      generation,
      contentHash,
      enqueuedAt: performance.now(),
    });
  }

  /** Drops pending insert/update ops ahead of a delete. */
  dequeue(blockId: string): void {
    this._queue = this._queue.filter(item => item.blockId !== blockId);
    this._urgent = this._urgent.filter(item => item.blockId !== blockId);
  }

  /**
   * Processes the queue: applies a small batch (CHUNK_SIZE) synchronously
   * and schedules the remainder for the next rAF.
   */
  flush(): void {
    if (this._disposed) return;
    if (this._queue.length === 0 && this._urgent.length === 0) return;
    this._processChunk();
  }

  private _processChunk(): void {
    const hadUrgent = this._urgent.length > 0;
    while (this._urgent.length > 0) {
      const item = this._urgent.shift()!;
      if (item.enqueuedAt !== undefined) {
        this._urgentStartWaitMs = +(performance.now() - item.enqueuedAt).toFixed(3);
      }
      this._store.upsert(item.blockId, item.html, item.beforeId, item.generation, item.contentHash);
    }

    // Do not overlap urgent synchronous edit applies with background DOM
    // inserts in the same task; resume the background queue on the next
    // rAF so the edited block paints first.
    const chunkStarted = performance.now();
    let processed = 0;
    while (!hadUrgent && this._queue.length > 0 && processed < MAX_OPS_PER_CHUNK) {
      const elapsed = performance.now() - chunkStarted;
      if (processed > 0 && elapsed >= CHUNK_BUDGET_MS) break;
      const item = this._queue.shift();
      if (!item) break;
      this._store.upsert(item.blockId, item.html, item.beforeId, item.generation, item.contentHash);
      processed++;
    }

    if (processed > 0) {
      this._backgroundChunkLastMs = +(performance.now() - chunkStarted).toFixed(3);
      this._backgroundChunkMaxMs = Math.max(this._backgroundChunkMaxMs, this._backgroundChunkLastMs);
      this._backgroundChunkCount++;
    }

    if (this._queue.length > 0) {
      if (this._rafHandle !== null) cancelAnimationFrame(this._rafHandle);
      this._rafHandle = requestAnimationFrame(() => {
        this._rafHandle = null;
        this._processChunk();
      });
    }
  }

  /** Clears the queue; called on generation change. */
  clear(): void {
    this._queue = [];
    this._urgent = [];
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
  }

  get pending(): number {
    return this._queue.length + this._urgent.length;
  }

  get cleanupState(): { disposed: boolean; pendingAnimationFrames: number; pendingBlocks: number } {
    return {
      disposed: this._disposed,
      pendingAnimationFrames: this._rafHandle === null ? 0 : 1,
      pendingBlocks: this.pending,
    };
  }

  get telemetry(): { queueLength: number; urgentLength: number; backgroundChunkCount: number; backgroundChunkLastMs: number; backgroundChunkMaxMs: number; urgentStartWaitMs: number } {
    return {
      queueLength: this._queue.length,
      urgentLength: this._urgent.length,
      backgroundChunkCount: this._backgroundChunkCount,
      backgroundChunkLastMs: this._backgroundChunkLastMs,
      backgroundChunkMaxMs: this._backgroundChunkMaxMs,
      urgentStartWaitMs: this._urgentStartWaitMs,
    };
  }
}
