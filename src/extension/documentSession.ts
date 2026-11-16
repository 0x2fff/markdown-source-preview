/**
 * Per-document parse and generation session, one per TextDocument.
 * Assigns stable block IDs, diffs changed blocks into patches, and
 * records update-path timings for diagnostics.
 */

import * as vscode from 'vscode';
import {
  parseDocument,
  sliceInitial,
  diffBlocks,
  wrapBlock,
  stabilizeBlockIds,
} from '../core/blockParser.js';
import type { BlockWindow } from '../core/blockParser.js';
import type {
  ParsedDocument,
  InitPayload,
  HostToWebview,
  BlockPatch,
  PatchHostTimings,
} from '../core/renderModel.js';

export interface SessionConfig {
  initialBlockLimit: number;
  initialSourceBytes: number;
}

export interface DocumentRenderOptions {
  resolveImage?: (src: string) => string | null;
}

export interface UpdateTimings {
  /** Total of getText + parse + buildBlocks + diff + serialize (ms). */
  hostPrepareMs: number;
  getTextMs: number;
  parseMs: number;
  buildBlocksMs: number;
  diffMs: number;
  serializeEstimateMs: number;
  postMessageMs: number;
  changedBlockCount: number;
  insertedBlockCount: number;
  deletedBlockCount: number;
  messageBytes: number;
  updateMode: 'windowed-fullparse' | 'full-reparse';
  fallbackReason: string | null;
  changeStartLine: number | null;
  changeEndLine: number | null;
  prevBlockCount: number;
  nextBlockCount: number;
}

export interface PreparedUpdate {
  message: Extract<HostToWebview, { type: 'patch' }>;
  timings?: UpdateTimings;
  document: ParsedDocument;
}

function countLines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function windowFromContentChanges(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): { window: BlockWindow | null; startLine: number | null; endLine: number | null } {
  if (!changes.length) return { window: null, startLine: null, endLine: null };

  let prevStart = Number.POSITIVE_INFINITY;
  let prevEnd = Number.NEGATIVE_INFINITY;
  let nextStart = Number.POSITIVE_INFINITY;
  let nextEnd = Number.NEGATIVE_INFINITY;

  for (const change of changes) {
    const oldStart = change.range.start.line;
    const oldEnd = change.range.end.line;
    const newStart = change.range.start.line;
    const newEnd = change.range.start.line + countLines(change.text);
    prevStart = Math.min(prevStart, oldStart);
    prevEnd = Math.max(prevEnd, oldEnd);
    nextStart = Math.min(nextStart, newStart);
    nextEnd = Math.max(nextEnd, newEnd);
  }

  return {
    window: {
      prevStartLine: prevStart,
      prevEndLine: prevEnd,
      nextStartLine: nextStart,
      nextEndLine: nextEnd,
    },
    startLine: prevStart,
    endLine: prevEnd,
  };
}

function patchesFromDiff(
  prev: ParsedDocument | null,
  next: ParsedDocument,
): { patches: BlockPatch[]; inserted: number; deleted: number } {
  if (!prev) {
    const patches = next.blocks.map(block => ({
      op: 'insert' as const,
      blockId: block.id,
      html: wrapBlock(block),
      renderState: block.renderState,
      contentHash: block.contentHash,
    }));
    return { patches, inserted: patches.length, deleted: 0 };
  }

  const diff = diffBlocks(prev.blocks, next.blocks);
  const patches: BlockPatch[] = [
    ...diff.updates.map(({ block }) => ({
      op: 'update' as const,
      blockId: block.id,
      html: wrapBlock(block),
      renderState: block.renderState,
      contentHash: block.contentHash,
    })),
    // Apply inserts in reverse canonical order: each insert anchors
    // before its successor, which must already exist in the DOM.
    ...[...diff.inserts].reverse().map(({ block, beforeId }) => ({
      op: 'insert' as const,
      blockId: block.id,
      html: wrapBlock(block),
      renderState: block.renderState,
      contentHash: block.contentHash,
      beforeId: beforeId ?? undefined,
    })),
    ...diff.deletes.map(({ blockId }) => ({
      op: 'delete' as const,
      blockId,
    })),
  ];
  return { patches, inserted: diff.inserts.length, deleted: diff.deletes.length };
}

export class DocumentSession {
  private _generation = 0;
  private _lastDoc: ParsedDocument | null = null;
  private _disposed = false;

  constructor(
    private readonly _document: vscode.TextDocument,
    private readonly _config: SessionConfig,
    private readonly _renderOptions: DocumentRenderOptions = {},
  ) {}

  get document(): vscode.TextDocument {
    return this._document;
  }

  get latestParsed(): ParsedDocument | null {
    return this._lastDoc;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._lastDoc = null;
  }

/** Parses the document and returns the initial payload. */
  buildInitPayload(initialLine: number): InitPayload {
    if (this._disposed) throw new Error('Cannot initialize a disposed document session');
    const tTotal = performance.now();
    this._generation++;
    const gen = this._generation;

    const source = this._document.getText();

    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
console.log(`[MARKDOWN_SOURCE_PREVIEW_PERF] host parse-start gen=${gen} bytes=${source.length}`);
    }
    const raw = parseDocument(source, {
      uri: this._document.uri.toString(),
      generation: gen,
      ...this._renderOptions,
    });
    const blocks = stabilizeBlockIds(null, raw.blocks, null, gen);
    const doc: ParsedDocument = { ...raw, blocks };
    this._lastDoc = doc;
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
console.log(`[MARKDOWN_SOURCE_PREVIEW_PERF] host parse-end gen=${gen} parseMs=${doc.parseMs} blocks=${doc.blocks.length}`);
    }

    const slice = sliceInitial(doc, {
      blockLimit: this._config.initialBlockLimit,
      sourceByteLimit: this._config.initialSourceBytes,
    });

    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
      const totalMs = performance.now() - tTotal;
      console.log(
        `[MARKDOWN_SOURCE_PREVIEW_PERF] host slice gen=${gen} initial=${slice.initialBlocks.length} rest=${slice.restBlocks.length} renderMs=${slice.renderMs} totalMs=${totalMs.toFixed(1)}`,
      );
    }

    return {
      generation: gen,
      initialHtml: slice.initialHtml,
      initialBlockCount: slice.initialBlocks.length,
      totalBlockCount: doc.blocks.length,
      uri: this._document.uri.toString(),
      initialLine,
      parseMs: doc.parseMs,
      renderMs: slice.renderMs,
      hasMermaid: doc.blocks.some(block => block.kind === 'mermaid'),
    };
  }

/**
   * Builds a patch message for a change event. Always re-parses the full
   * document but stabilizes IDs and ships only changed blocks.
   */
  prepareUpdate(
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
  ): PreparedUpdate {
    if (this._disposed) throw new Error('Cannot update a disposed document session');
    const gen = ++this._generation;
    const prevDoc = this._lastDoc;
    const { window, startLine, endLine } = windowFromContentChanges(changes);

    const t0 = performance.now();
    const source = document.getText();
    const t1 = performance.now();

    const raw = parseDocument(source, {
      uri: document.uri.toString(),
      generation: gen,
      reuse: prevDoc?.blocks,
      ...this._renderOptions,
    });
    const blocks = stabilizeBlockIds(prevDoc?.blocks ?? null, raw.blocks, window, gen);
    const t2 = performance.now();
    const doc: ParsedDocument = { ...raw, blocks };
    this._lastDoc = doc;

    const { patches, inserted, deleted } = patchesFromDiff(prevDoc, doc);
    const t3 = performance.now();

    const message: Extract<HostToWebview, { type: 'patch' }> = {
      type: 'patch',
      payload: { generation: gen, patches },
    };

    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) {
      return { message, document: doc };
    }

    // hostPrepareMs spans from getText start to diff completion
    const hostPrepareMs = +(t3 - t0).toFixed(1);

    const hostTimings: PatchHostTimings = {
      prepareMs: hostPrepareMs,
      getTextMs: +(t1 - t0).toFixed(1),
      parseMs: raw.parseMs,
      buildBlocksMs: +((t2 - t1) - raw.parseMs).toFixed(1),
      diffMs: +(t3 - t2).toFixed(1),
      serializeEstimateMs: 0, // filled in below
      changedBlockCount: patches.length,
      insertedBlockCount: inserted,
      deletedBlockCount: deleted,
      messageBytes: 0, // filled in below
    };
    message.payload.hostTimings = hostTimings;

    const serialized = JSON.stringify(message);
    const messageBytes = Buffer.byteLength(serialized, 'utf8');
    const t4 = performance.now();

    hostTimings.serializeEstimateMs = +(t4 - t3).toFixed(1);
    hostTimings.messageBytes = messageBytes;

    const timings: UpdateTimings = {
      hostPrepareMs,
      getTextMs: +(t1 - t0).toFixed(1),
      parseMs: raw.parseMs,
      buildBlocksMs: +((t2 - t1) - raw.parseMs).toFixed(1),
      diffMs: +(t3 - t2).toFixed(1),
      serializeEstimateMs: +(t4 - t3).toFixed(1),
      postMessageMs: 0,
      changedBlockCount: patches.length,
      insertedBlockCount: inserted,
      deletedBlockCount: deleted,
      messageBytes,
      updateMode: window ? 'windowed-fullparse' : 'full-reparse',
      fallbackReason: window ? null : 'missing-content-changes',
      changeStartLine: startLine,
      changeEndLine: endLine,
      prevBlockCount: prevDoc?.blocks.length ?? 0,
      nextBlockCount: doc.blocks.length,
    };

    console.log(
      `[MARKDOWN_SOURCE_PREVIEW_PERF] host change-prepare gen=${gen} mode=${timings.updateMode}` +
      ` getTextMs=${timings.getTextMs} parseMs=${timings.parseMs}` +
      ` buildBlocksMs=${timings.buildBlocksMs} diffMs=${timings.diffMs}` +
      ` patches=${patches.length} insert=${inserted} delete=${deleted}` +
      ` bytes=${messageBytes} window=${startLine ?? '-'}..${endLine ?? '-'}`,
    );

    return { message, timings, document: doc };
  }

/**
   * Parses the current document without touching _lastDoc or the
   * generation counter, for lookups that must not race the normal
   * patch stream (e.g. re-locating a block after an external edit).
   */
  parseSnapshot(document: vscode.TextDocument): ParsedDocument {
    const raw = parseDocument(document.getText(), {
      uri: document.uri.toString(),
      generation: this._generation,
      reuse: this._lastDoc?.blocks,
      ...this._renderOptions,
    });
    const blocks = stabilizeBlockIds(
      this._lastDoc?.blocks ?? null,
      raw.blocks,
      null,
      this._generation,
    );
    return { ...raw, blocks };
  }

  setParsedDocument(document: ParsedDocument): void {
    this._lastDoc = document;
  }

  incrementGeneration(): number {
    return ++this._generation;
  }
}
