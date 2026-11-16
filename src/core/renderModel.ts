/**
 * Shared type definitions used by both the extension host and the
 * webview. No DOM or vscode API dependencies.
 */

// ---------- Block ----------

/** A rendered unit corresponding to a top-level markdown-it token boundary. */
export type BlockKind =
  | 'frontmatter'  // leading YAML frontmatter delimited by ---
  | 'heading'
  | 'paragraph'
  | 'fence'         // fenced code block
  | 'code_block'    // indented code block
  | 'table'         // GFM table
  | 'mermaid'       // ``` mermaid fence
  | 'bullet_list'   // bullet list including nested items
  | 'ordered_list'  // ordered list including nested items
  | 'blockquote'
  | 'html_block'
  | 'hr'
  | 'other';

/** Whether the block's Markdown source can be edited directly in a textarea. */
export function isEditableBlockKind(kind: string): boolean {
  return kind === 'frontmatter'
    || kind === 'heading'
    || kind === 'paragraph'
    || kind === 'bullet_list'
    || kind === 'ordered_list'
    || kind === 'blockquote'
    || kind === 'fence'
    || kind === 'code_block'
    || kind === 'table'
    || kind === 'mermaid'
    || kind === 'html_block'
    || kind === 'hr';
}

export type BlockRenderState =
  | 'pending'     // HTML not yet generated
  | 'plain'       // shown as plain text, awaiting decoration
  | 'rendered'    // HTML rendered, highlight/mermaid pending
  | 'decorated'   // highlight/mermaid applied
  | 'error';

export interface RenderBlock {
  /** Stable block ID within the session. */
  readonly id: string;
  readonly kind: BlockKind;
  /** Start line in the source (0-indexed). */
  readonly sourceStart: number;
  /** End line in the source (exclusive). */
  readonly sourceEnd: number;
  /** First 16 chars of the block source SHA-256, used for diffing. */
  readonly contentHash: string;
  /** Rendered HTML; empty while pending. */
  html: string;
  /** Current render state. */
  renderState: BlockRenderState;
  /** Estimated height in px for scroll hints; -1 when unknown. */
  estimatedHeight: number;
}

// ---------- Document ----------

export interface ParsedDocument {
  /** VS Code document URI string. */
  readonly uri: string;
  /** Document generation, incremented on each change. */
  readonly generation: number;
  /** All blocks in source order. */
  readonly blocks: readonly RenderBlock[];
  /** Total line count of the source. */
  readonly lineCount: number;
  /** Parse duration in ms. */
  readonly parseMs: number;
}

// ---------- Protocol messages ----------

/** Extension host → Webview messages. */
export type HostToWebview =
  | { type: 'init'; payload: InitPayload }
  | { type: 'patch'; payload: PatchPayload }
  | { type: 'scroll'; payload: ScrollPayload }
  | { type: 'edit-mode'; payload: { mode: 'read' | 'edit' | 'readonly' } }
  | { type: 'query-edit-draft'; payload: { requestId: string; blockId: string } }
  | { type: 'edit-started'; payload: { blockId: string; source: string } }
  | { type: 'edit-finished'; payload: { blockId: string; outcome: 'saved' | 'discarded' } }
  | { type: 'edit-error'; payload: { blockId: string; message: string } }
  | { type: 'refresh-block'; payload: { blockId: string; html: string } }
  | { type: 'prepare-dispose'; payload: { requestId: string } }
  | { type: 'diagnostic'; payload: DiagnosticPayload };

/** Webview → Extension host messages. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'focus' }
  | { type: 'open-link'; payload: { href: string } }
  | { type: 'begin-edit'; payload: { blockId: string } }
  | { type: 'mermaid-context'; payload: { blockId?: string } }
  | { type: 'edit-draft'; payload: { blockId: string; markdown: string; requestId?: string } }
  | { type: 'commit-edit'; payload: { blockId: string; markdown: string } }
  | { type: 'cancel-edit'; payload: { blockId: string } }
  | {
      type: 'insert-markdown';
      payload: { beforeBlockId?: string; afterBlockId?: string; markdown: string };
    }
  | { type: 'scroll-sync'; payload: ScrollPayload }
  | { type: 'dispose-prepared'; payload: { requestId: string; cleanup: WebviewCleanupSnapshot } }
  | { type: 'webview-disposed-best-effort'; payload: { cleanup: WebviewCleanupSnapshot } }
  | { type: 'diagnostic'; payload: DiagnosticPayload }
  | { type: 'patch-applied'; payload: PatchAppliedPayload };

export interface PatchAppliedPayload {
  generation: number;
  blockIds: string[];
  appliedAt: number;
  /** Time from message receipt to renderQueue.flush() completion in the webview (ms). */
  domApplyMs: number;
  webviewReceivedEpochMs: number;
  domApplyStartedEpochMs: number;
  domApplyEndedEpochMs: number;
  ackSentEpochMs: number;
  webviewQueueWaitMs: number;
  queueLengthAtReceive: number;
  urgentQueueLengthAtReceive: number;
  urgentStartWaitMs: number;
  backgroundChunkLastMs: number;
  backgroundChunkMaxMs: number;
  backgroundChunkCount: number;
}

/** Initial payload containing the HTML of the first slice. */
export interface InitPayload {
  /** Generation number. */
  generation: number;
  /** Concatenated HTML of the initial slice blocks. */
  initialHtml: string;
  /** Number of blocks in initialHtml. */
  initialBlockCount: number;
  /** Total block count. */
  totalBlockCount: number;
  /** Document URI. */
  uri: string;
  /** Initial line to display. */
  initialLine: number;
  /** Parse duration in ms. */
  parseMs: number;
  /** HTML generation time for the initial slice (ms). */
  renderMs: number;
  /** Whether the document contains any Mermaid blocks (all slices). */
  hasMermaid: boolean;
}

/** Host-side prepare timings embedded directly in the payload. */
export interface PatchHostTimings {
  /** Total of getText + parse + diff + serialize (ms). */
  prepareMs: number;
  getTextMs: number;
  parseMs: number;
  buildBlocksMs: number;
  diffMs: number;
  serializeEstimateMs: number;
  changedBlockCount: number;
  insertedBlockCount: number;
  deletedBlockCount: number;
  /** Estimated byte size after JSON.stringify. */
  messageBytes: number;
}

/** Incremental update payload containing only changed blocks. */
export interface PatchPayload {
  generation: number;
  /** Block diffs to update, insert, or delete. */
  patches: BlockPatch[];
  /** Host prepare timings for diagnostics; omitted in normal runs. */
  hostTimings?: PatchHostTimings;
}

export interface BlockPatch {
  op: 'update' | 'insert' | 'delete';
  blockId: string;
  /** Present for insert/update only. */
  html?: string;
  renderState?: BlockRenderState;
  /** Block content hash for diff verification. */
  contentHash?: string;
  /** For insert: place immediately before this block ID. */
  beforeId?: string;
}

export interface ScrollPayload {
  line: number;
  origin: 'source' | 'preview';
  token: string;
}

export interface WebviewCleanupSnapshot {
  renderQueueDisposed: boolean;
  highlightQueueDisposed: boolean;
  mermaidQueueDisposed: boolean;
  highlightObserversDisconnected: boolean;
  mermaidObserversDisconnected: boolean;
  performanceObserverDisconnected: boolean;
  listenersRemoved: boolean;
  pendingAnimationFrames: number;
  pendingIdleCallbacks: number;
  pendingBlocks: number;
  pendingMermaidJobs: number;
  activeMermaidRenders: number;
}

/** Diagnostic timing event sent from the webview. */
export interface DiagnosticPayload {
  event: string;
  ms: number;
  extra?: Record<string, unknown>;
}
