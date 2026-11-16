/**
 * Webview entry point. Applies init/patch messages to the DOM, reports
 * timing, streams remaining blocks through a low-priority queue, and
 * lazily highlights code and renders Mermaid near the viewport.
 */

import { BlockStore } from './blockStore.js';
import { RenderQueue } from './renderQueue.js';
import { HighlightQueue } from './highlightQueue.js';
import { MermaidQueue } from './mermaidQueue.js';
import { disposeInstrumentation, Instrumentation, isInstrumentationDisposed } from './instrumentation.js';
import { editMetrics } from './editMetrics.js';
import { isEditableBlockKind } from '../core/renderModel.js';
import {
  CodeEditorHighlight,
  isCodeHighlightKind,
  parseFenceLanguage,
} from './codeEditorHighlight.js';
import { attachDiagramView } from './diagramView.js';
import type {
  HostToWebview,
  WebviewToHost,
  WebviewCleanupSnapshot,
  InitPayload,
  PatchPayload,
  DiagnosticPayload,
  ScrollPayload,
} from '../core/renderModel.js';


const _bootMs = performance.now();
Instrumentation.emit('boot', _bootMs, { timeOrigin: performance.timeOrigin });


// acquireVsCodeApi() is available inside the webview
declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();
const lifecycleController = new AbortController();

function postToHost(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}


const root = document.getElementById('markdown-source-preview-root') as HTMLElement;

const blockStore = new BlockStore(root);
const renderQueue = new RenderQueue(blockStore);
const highlightQueue = new HighlightQueue();
const mermaidQueue = new MermaidQueue();


let _currentGeneration = -1;
let _programmaticScrollLine: number | undefined;
let _programmaticScrollTimer: number | undefined;
let _lastScrollSyncLine = -1;
let _sourceScrollToken: string | undefined;
const _receivedSourceScrollTokens = new Set<string>();
let _editMode: 'read' | 'edit' | 'readonly' = 'read';

interface ActiveBlockEditor {
  blockId: string;
  element: HTMLElement;
  originalHtml: string;
  textarea: HTMLTextAreaElement;
  initialSource: string;
  commit: () => void;
}

interface PendingSaveMetric {
  blockId: string;
  at: number;
  noOp: boolean;
}

let _activeBlockEditor: ActiveBlockEditor | undefined;
let _pendingBeginAt: number | undefined;
let _lastInputAt: number | undefined;
let _compositionStartedAt: number | undefined;
let _compositionEndedAt: number | undefined;
let _pendingSave: PendingSaveMetric | undefined;
let _pendingBlockSave: PendingSaveMetric | undefined;
let _pendingCancelAt: number | undefined;
let _pendingBeginBlockId: string | undefined;
// Click position as normalized coordinates inside the block; applied to
// caret and scroll when edit-started arrives.
let _pendingBeginPoint: { x: number; y: number } | undefined;
// For table blocks the rendered row/cell layout does not map linearly to
// source lines (the separator line has no rendered row), so the click is
// resolved to a source line + cell at click time instead.
interface TableBeginTarget {
  lineIndex: number;
  cellIndex: number;
  cellX: number;
  rowX: number;
}
let _pendingBeginTable: TableBeginTarget | undefined;
let _activeCodeHighlight: CodeEditorHighlight | undefined;

interface InsertAnchor {
  beforeBlockId?: string;
  afterBlockId?: string;
}

interface ActiveInsertEditor {
  element: HTMLElement;
  textarea: HTMLTextAreaElement;
  beforeBlockId?: string;
  afterBlockId?: string;
}

let _activeInsertEditor: ActiveInsertEditor | undefined;
let _insertMarker: HTMLElement | undefined;
let _insertMarkerAnchor: InsertAnchor | undefined;
let _emptyEditor: HTMLElement | undefined;

if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
  (window as Window & {
    __MARKDOWN_SOURCE_PREVIEW_EDIT_METRICS__?: {
      reset: () => void;
      snapshot: () => ReturnType<typeof editMetrics.snapshot>;
    };
  }).__MARKDOWN_SOURCE_PREVIEW_EDIT_METRICS__ = {
    reset: () => editMetrics.reset(),
    snapshot: () => editMetrics.snapshot(),
  };

  (window as Window & {
    __MARKDOWN_SOURCE_PREVIEW_RENDER_STATE__?: {
      pending: () => number;
      telemetry: () => typeof renderQueue.telemetry;
    };
  }).__MARKDOWN_SOURCE_PREVIEW_RENDER_STATE__ = {
    pending: () => renderQueue.pending,
    telemetry: () => renderQueue.telemetry,
  };
}

window.addEventListener('message', (event) => {
  const msg = event.data as HostToWebview;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'init':
      handleInit(msg.payload);
      break;
    case 'patch':
      handlePatch(msg.payload);
      break;
    case 'edit-mode':
      setEditMode(msg.payload.mode);
      break;
    case 'query-edit-draft':
      if (_activeBlockEditor?.blockId === msg.payload.blockId) {
        postToHost({
          type: 'edit-draft',
          payload: {
            blockId: msg.payload.blockId,
            markdown: _activeBlockEditor.textarea.value,
            requestId: msg.payload.requestId,
          },
        });
      }
      break;
    case 'edit-started':
      beginBlockEditor(msg.payload.blockId, msg.payload.source);
      break;
    case 'edit-finished':
      finishBlockEditor(msg.payload.blockId, msg.payload.outcome);
      break;
    case 'edit-error':
      showBlockEditError(msg.payload.blockId, msg.payload.message);
      break;
    case 'refresh-block':
      refreshBlock(msg.payload.blockId, msg.payload.html);
      break;
    case 'prepare-dispose': {
      const cleanup = disposeWebview();
      postToHost({
        type: 'dispose-prepared',
        payload: { requestId: msg.payload.requestId, cleanup },
      });
      break;
    }
    case 'scroll':
      if (msg.payload.origin !== 'source'
        || typeof msg.payload.token !== 'string'
        || msg.payload.token.length === 0
        || _receivedSourceScrollTokens.has(msg.payload.token)) break;
      _receivedSourceScrollTokens.add(msg.payload.token);
      if (_receivedSourceScrollTokens.size > 256) {
        const oldest = _receivedSourceScrollTokens.values().next().value;
        if (oldest !== undefined) _receivedSourceScrollTokens.delete(oldest);
      }
      scrollToLine(msg.payload);
      break;
    case 'diagnostic':
      handleDiagnostic(msg.payload);
      break;
  }
}, { signal: lifecycleController.signal });

root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a[href]');
  if (!anchor || !root.contains(anchor)) return;
  const href = anchor.getAttribute('href');
  if (!href) return;

  event.preventDefault();
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  postToHost({ type: 'open-link', payload: { href } });
}, { signal: lifecycleController.signal });

root.addEventListener('click', event => {
  if (_editMode !== 'edit') return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('a, button, input, textarea')) return;
  // Do not enter edit mode when the user drag-selected text
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  // Let frontmatter <summary> clicks toggle the disclosure
  if (target.closest('summary')) return;
  const block = target.closest<HTMLElement>('[data-block-id][data-kind]');
  if (!block) return;
  const kind = block.dataset.kind ?? '';
  const editable = isEditableBlockKind(kind);
  if (!editable) return;
  const blockId = block.dataset.blockId!;
  const blockRect = block.getBoundingClientRect();
  _pendingBeginPoint = {
    x: blockRect.width > 0 ? (event.clientX - blockRect.left) / blockRect.width : 0,
    y: blockRect.height > 0 ? (event.clientY - blockRect.top) / blockRect.height : 0,
  };
  _pendingBeginTable = kind === 'table'
    ? describeTableClick(block, event)
    : undefined;
  if (_activeBlockEditor) {
    // Switching blocks: save the current draft, then open the new island after edit-finished.
    if (_activeBlockEditor.blockId === blockId) return;
    event.preventDefault();
    _pendingBeginBlockId = blockId;
    _activeBlockEditor.commit();
    return;
  }
  event.preventDefault();
  _pendingBeginAt = performance.now();
  postToHost({ type: 'begin-edit', payload: { blockId } });
}, { signal: lifecycleController.signal });

// Shows one shared insertion marker only while the pointer is over
// whitespace between blocks. Block content itself never shows it, so
// hovering headings or diagrams does not move any DOM.
root.addEventListener('pointermove', event => {
  if (_editMode !== 'edit' || _activeBlockEditor || _activeInsertEditor) {
    hideInsertMarker();
    return;
  }
  const target = event.target;
  if (!(target instanceof Element) || target.closest('[data-block-id]')) {
    hideInsertMarker();
    return;
  }
  updateInsertMarker(event.clientY);
}, { passive: true, signal: lifecycleController.signal });

root.addEventListener('pointerleave', event => {
  // Moving onto the insert marker must not hide it: the marker is a
  // body-level overlay, so pointerleave fires even though the pointer
  // is still inside the gap visually.
  const related = event.relatedTarget;
  if (related instanceof Element
    && related.closest('.markdown-source-preview-insert-point')) {
    return;
  }
  hideInsertMarker();
}, { signal: lifecycleController.signal });

// Any scroll moves content under a stationary pointer, so the marker
// must not stay anchored to a stale gap.
document.addEventListener('scroll', hideInsertMarker, {
  capture: true,
  passive: true,
  signal: lifecycleController.signal,
});

window.addEventListener('resize', hideInsertMarker, {
  signal: lifecycleController.signal,
});

// Notifies the host of right-clicks on Mermaid blocks so the
// webview/context menu command can identify its target.
// preventDefault is intentionally not called to keep the VS Code
// context menu.
root.addEventListener('contextmenu', event => {
  const target = event.target;
  const block = target instanceof Element
    ? target.closest<HTMLElement>('[data-kind="mermaid"]')
    : null;
  postToHost({
    type: 'mermaid-context',
    payload: { blockId: block?.dataset.blockId },
  });
}, { signal: lifecycleController.signal });

window.addEventListener('focusin', () => postToHost({ type: 'focus' }), {
  signal: lifecycleController.signal,
});

window.addEventListener('scroll', () => {
  const trace = __MARKDOWN_SOURCE_PREVIEW_LAB__
    ? (window as Window & { __MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL_TRACE__?: string[] })
      .__MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL_TRACE__
    : undefined;
  const now = performance.now();
  if (_sourceScrollToken) {
    if (_programmaticScrollTimer !== undefined) window.clearTimeout(_programmaticScrollTimer);
    _programmaticScrollTimer = window.setTimeout(() => {
      _sourceScrollToken = undefined;
      _programmaticScrollLine = undefined;
      _programmaticScrollTimer = undefined;
    }, 1000);
    trace?.push(`suppressed token=${_sourceScrollToken} now=${now}`);
    return;
  }
  const firstVisibleBlock = [...root.querySelectorAll<HTMLElement>('[data-line]')]
    .find(block => {
      const rect = block.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
  if (!firstVisibleBlock) {
    trace?.push('no-visible-block');
    return;
  }

  const line = Number(firstVisibleBlock.dataset.line);
  if (!Number.isInteger(line) || line === _programmaticScrollLine || line === _lastScrollSyncLine) {
    trace?.push(`ignored line=${line} programmatic=${_programmaticScrollLine} last=${_lastScrollSyncLine}`);
    return;
  }
  _lastScrollSyncLine = line;
  trace?.push(`sent line=${line}`);
  postToHost({
    type: 'scroll-sync',
    payload: { line, origin: 'preview', token: crypto.randomUUID() },
  });
}, { passive: true, signal: lifecycleController.signal });

window.addEventListener('wheel', () => {
  _sourceScrollToken = undefined;
 _programmaticScrollLine = undefined;
 if (_programmaticScrollTimer !== undefined) {
   window.clearTimeout(_programmaticScrollTimer);
   _programmaticScrollTimer = undefined;
 }
}, { passive: true, signal: lifecycleController.signal });

attachDiagramView(root, lifecycleController.signal);

postToHost({ type: 'ready' });

function setEditMode(mode: 'read' | 'edit' | 'readonly'): void {
  if (mode !== 'edit' && _activeInsertEditor) {
    // Auto-save on mode exit, matching block editor behavior.
    commitInsertEditor(true);
  }
  _editMode = mode;
  hideInsertMarker();
  root.dataset.editMode = String(mode === 'edit');
  // Toggling data-editable on every block makes style recalculation
  // expensive on ~1 MiB documents, so hover is driven by a body
  // attribute plus CSS instead.
  document.body.dataset.editMode = String(mode === 'edit');
  syncEmptyEditor();
}

let _measureCanvas: HTMLCanvasElement | undefined;

function measureTextWidth(text: string, el: HTMLElement): number {
  const cs = getComputedStyle(el);
  _measureCanvas ??= document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return ctx.measureText(text).width;
}

/**
 * Maps a click position (normalized block coordinates) to a textarea
 * caret position and scroll offset. Line/column are render approximations.
 */
function applyBeginPoint(
  textarea: HTMLTextAreaElement,
  source: string,
  point: { x: number; y: number },
): void {
  const lines = source.split('\n');
  const lineIndex = Math.min(
    lines.length - 1,
    Math.max(0, Math.floor(point.y * lines.length)),
  );
  let lineStart = 0;
  for (let i = 0; i < lineIndex; i++) lineStart += lines[i].length + 1;
  const line = lines[lineIndex] ?? '';
  // Approximate average glyph width from the first 400 chars of very long lines
  const sample = line.slice(0, 400);
  const sampleWidth = measureTextWidth(sample, textarea);
  const charWidth = sampleWidth > 0 ? sampleWidth / Math.max(1, sample.length) : 0;
  const column = charWidth > 0
    ? Math.round((point.x * textarea.clientWidth) / charWidth)
    : 0;
  const caret = lineStart + Math.min(Math.max(column, 0), line.length);
  textarea.setSelectionRange(caret, caret);

  const cs = getComputedStyle(textarea);
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 20;
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2);
}

/**
 * Resolves a click inside a rendered table to a source line and cell.
 * Rendered rows map to source lines as: thead row -> line 0 (header),
 * tbody row i -> line i + 2 (line 1 is the separator, which has no row).
 */
function describeTableClick(
  block: HTMLElement,
  event: MouseEvent,
): TableBeginTarget | undefined {
  const table = block.querySelector('table');
  if (!table) return undefined;
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return undefined;

  let row = event.target instanceof Element
    ? event.target.closest('tr')
    : null;
  if (!row || !table.contains(row)) {
    row = rows.find(r => {
      const rect = r.getBoundingClientRect();
      return event.clientY >= rect.top && event.clientY < rect.bottom;
    }) ?? null;
  }
  if (!row) return undefined;

  const rowIndex = rows.indexOf(row);
  const headerRows = table.querySelector('thead')?.querySelectorAll('tr').length ?? 0;
  const inHeader = rowIndex < headerRows;
  const lineIndex = inHeader ? 0 : rowIndex - headerRows + 2;

  const cell = event.target instanceof Element
    ? event.target.closest('td,th')
    : null;
  const validCell = cell && row.contains(cell) ? cell : null;
  const cellIndex = validCell
    ? Array.from(row.children).indexOf(validCell)
    : -1;

  const rowRect = row.getBoundingClientRect();
  const rowX = rowRect.width > 0
    ? Math.min(1, Math.max(0, (event.clientX - rowRect.left) / rowRect.width))
    : 0.5;

  let cellX = rowX;
  if (validCell) {
    const cellRect = validCell.getBoundingClientRect();
    // Exclude cell padding so the fraction maps onto the text area.
    const cs = getComputedStyle(validCell);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const innerWidth = cellRect.width - padLeft - padRight;
    if (innerWidth > 0) {
      cellX = Math.min(1, Math.max(0, (event.clientX - cellRect.left - padLeft) / innerWidth));
    } else if (cellRect.width > 0) {
      cellX = Math.min(1, Math.max(0, (event.clientX - cellRect.left) / cellRect.width));
    }
  }

  return { lineIndex, cellIndex, cellX, rowX };
}

/**
 * Content ranges (between unescaped `|` delimiters) of a table source line.
 * Handles the canonical `| a | b |` form; lines without a leading pipe
 * fall back to proportional placement.
 */
function tableLineCellRanges(line: string): { start: number; end: number }[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(i);
  }
  if (pipes.length < 2) return [];
  const leadingPipe = /^\s*\|/.test(line);
  if (!leadingPipe) return [];
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < pipes.length; i++) {
    ranges.push({ start: pipes[i] + 1, end: pipes[i + 1] });
  }
  return ranges;
}

/** Caret column inside a table source line for a clicked cell. */
function tableCellCaretColumn(
  line: string,
  cellIndex: number,
  cellX: number,
  rowX: number,
): number {
  const ranges = tableLineCellRanges(line);
  if (cellIndex >= 0 && cellIndex < ranges.length) {
    const { start, end } = ranges[cellIndex];
    // Trim surrounding padding spaces so the fraction maps to content.
    let s = start;
    let e = end;
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    if (e <= s) return s;
    return Math.min(e, s + Math.round(cellX * (e - s)));
  }
  return Math.min(line.length, Math.round(rowX * line.length));
}

/** Applies a table click target to caret position and scroll. */
function applyTableBeginPoint(
  textarea: HTMLTextAreaElement,
  source: string,
  target: TableBeginTarget,
): void {
  const lines = source.split('\n');
  const lineIndex = Math.min(lines.length - 1, Math.max(0, target.lineIndex));
  let lineStart = 0;
  for (let i = 0; i < lineIndex; i++) lineStart += lines[i].length + 1;
  const line = lines[lineIndex] ?? '';
  const caret = lineStart + tableCellCaretColumn(
    line, target.cellIndex, target.cellX, target.rowX,
  );
  textarea.setSelectionRange(caret, caret);

  const cs = getComputedStyle(textarea);
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 20;
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2);
}

function beginBlockEditor(blockId: string, source: string): void {
  if (_editMode !== 'edit' || _activeBlockEditor) {
    return;
  }
  const element = blockStore.get(blockId);
  if (!element || !isEditableBlockKind(element.dataset.kind ?? '')) {
    return;
  }

  const beginAt = _pendingBeginAt;
  _pendingBeginAt = undefined;
  // Fix the rendered height as the outer size. Long Markdown scrolls
  // inside the textarea so surrounding layout does not move while editing.
  const rect = element.getBoundingClientRect();
  // The split-pane Mermaid editor needs room for two panes; the minimum
  // depends on whether the block will lay out side-by-side or stacked.
  const lockedHeight = element.dataset.kind === 'mermaid'
    ? Math.max(Math.ceil(rect.height), rect.width <= 620 ? 260 : 220)
    : Math.ceil(rect.height);
  const beforeTop = rect.top;
  const originalHtml = element.innerHTML;
  element.replaceChildren();
  element.classList.add('markdown-source-preview-block--editing');
  element.style.height = `${lockedHeight}px`;
  element.style.minHeight = `${lockedHeight}px`;
  element.style.maxHeight = `${lockedHeight}px`;
  element.dataset.editLockedHeight = String(lockedHeight);

  const island = document.createElement('div');
  island.className = 'markdown-source-preview-block-editor';

  const textarea = document.createElement('textarea');
  textarea.className = 'markdown-source-preview-block-editor__input';
  textarea.setAttribute('aria-label', 'Markdown block source');
  textarea.spellcheck = false;
  textarea.value = source;

  const error = document.createElement('div');
  error.className = 'markdown-source-preview-block-editor__error';
  error.setAttribute('aria-live', 'polite');
  error.hidden = true;

  // For fence/code_block the textarea text is transparent and overlaid
  // on a background highlight.js layer; caret/IME/undo stay native.
  const blockKind = element.dataset.kind ?? '';
  let codeEditorWrap: HTMLElement | undefined;
  let codePre: HTMLElement | undefined;
  let mermaidPreview: { canvas: HTMLElement; status: HTMLElement } | undefined;
  if (isCodeHighlightKind(blockKind)) {
    codeEditorWrap = document.createElement('div');
    codeEditorWrap.className = 'markdown-source-preview-code-editor';
    codePre = document.createElement('pre');
    codePre.className = 'markdown-source-preview-code-editor__highlight';
    codePre.setAttribute('aria-hidden', 'true');
    const codeEl = document.createElement('code');
    codePre.append(codeEl);
    codeEditorWrap.append(codePre, textarea);
    island.append(codeEditorWrap, error);
    textarea.classList.add('markdown-source-preview-code-editor__input');
    _activeCodeHighlight = new CodeEditorHighlight(
      codeEl,
      codePre,
      blockKind === 'fence' ? parseFenceLanguage(source) : undefined,
    );
  } else if (blockKind === 'mermaid') {
    // Split editor: rendered preview beside the source textarea. The two
    // panes scroll independently; errors go to the status strip, never
    // overlaid on the SVG.
    island.classList.add('markdown-source-preview-mermaid-editor');
    const previewPane = document.createElement('div');
    previewPane.className = 'markdown-source-preview-mermaid-editor__preview';
    const canvas = document.createElement('div');
    canvas.className = 'markdown-source-preview-mermaid-editor__canvas';
    previewPane.append(canvas);

    const sourcePane = document.createElement('div');
    sourcePane.className = 'markdown-source-preview-mermaid-editor__source';
    textarea.classList.add('markdown-source-preview-mermaid-editor__input');
    sourcePane.append(textarea);

    const status = document.createElement('div');
    status.className = 'markdown-source-preview-mermaid-editor__status markdown-source-preview-block-editor__error';
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    island.append(previewPane, sourcePane, status);
    mermaidPreview = { canvas, status };
  } else {
    island.append(textarea, error);
  }
  element.append(island);

  const editor: ActiveBlockEditor = {
    blockId,
    element,
    originalHtml,
    textarea,
    initialSource: source,
    commit: () => {
      if (_activeBlockEditor !== editor || _pendingSave) return;
      _pendingSave = {
        blockId,
        at: performance.now(),
        noOp: textarea.value === source,
      };
      postToHost({
        type: 'commit-edit',
        payload: { blockId, markdown: textarea.value },
      });
    },
  };
  _activeBlockEditor = editor;
  if (mermaidPreview) {
    startMermaidDraftPreview(
      island, mermaidPreview.canvas, mermaidPreview.status, textarea, source,
    );
  }
  const updateDraft = () => postToHost({
    type: 'edit-draft',
    payload: { blockId, markdown: textarea.value },
  });
  const cancel = () => {
    _pendingCancelAt = performance.now();
    postToHost({ type: 'cancel-edit', payload: { blockId } });
  };

  textarea.addEventListener('input', event => {
    const inputEvent = event as InputEvent;
    if (!inputEvent.isComposing) {
      const now = performance.now();
      const from = _compositionEndedAt ?? _lastInputAt ?? now;
      const isIme = _compositionEndedAt !== undefined || _compositionStartedAt !== undefined;
      _compositionStartedAt = undefined;
      _compositionEndedAt = undefined;
      _lastInputAt = undefined;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          editMetrics.record(isIme ? 'imeCommitMs' : 'asciiInputMs', performance.now() - from);
        });
      });
    }
    updateDraft();
    _activeCodeHighlight?.schedule(textarea.value);
  }, { signal: lifecycleController.signal });
  if (codePre) {
    // Keep the background highlight layer scroll synced to the textarea
    textarea.addEventListener('scroll', () => {
      codePre!.scrollTop = textarea.scrollTop;
      codePre!.scrollLeft = textarea.scrollLeft;
    }, { signal: lifecycleController.signal });
  }
  textarea.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      editor.commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Tab'
      && (element.dataset.kind === 'bullet_list'
        || element.dataset.kind === 'ordered_list'
        || element.dataset.kind === 'mermaid')) {
      // For lists and Mermaid, Tab indents the item by two spaces and
      // Shift+Tab dedents one level without moving focus.
      event.preventDefault();
      handleListTab(textarea, event.shiftKey);
    } else if (event.key === 'Tab'
      && (element.dataset.kind === 'fence'
        || element.dataset.kind === 'code_block'
        || element.dataset.kind === 'table')) {
      // For code/table blocks Tab inserts indentation instead of
      // moving focus.
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText('    ', start, end, 'end');
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: '    ',
      }));
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
      _lastInputAt = performance.now();
    }
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('blur', () => {
    // Auto-save on blur; block-switch clicks keep a pending begin on the click side.
    if (_activeBlockEditor === editor) editor.commit();
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('compositionstart', () => {
    _compositionStartedAt = performance.now();
    _compositionEndedAt = undefined;
    if (codeEditorWrap) codeEditorWrap.dataset.composing = 'true';
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('compositionend', () => {
    _compositionEndedAt = performance.now();
    if (codeEditorWrap) delete codeEditorWrap.dataset.composing;
    _activeCodeHighlight?.schedule(textarea.value);
  }, { signal: lifecycleController.signal });
  textarea.focus();
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
  textarea.scrollLeft = 0;

  const beginPoint = _pendingBeginPoint;
  const beginTable = _pendingBeginTable;
  _pendingBeginPoint = undefined;
  _pendingBeginTable = undefined;
  if (beginTable) {
    applyTableBeginPoint(textarea, source, beginTable);
  } else if (beginPoint) {
    applyBeginPoint(textarea, source, beginPoint);
  }
  _activeCodeHighlight?.schedule(source);

  // Compensates 1-2 px border/padding drift to keep the document scroll
  // position stable (usually zero because heights match).
  const scrollDelta = element.getBoundingClientRect().top - beforeTop;
  if (scrollDelta !== 0) {
    window.scrollBy({ top: scrollDelta, behavior: 'auto' });
  }

  if (beginAt !== undefined) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        editMetrics.record('islandStartMs', performance.now() - beginAt);
      });
    });
  }
}

const MERMAID_DRAFT_DEBOUNCE_MS = 150;

/** Extracts the diagram source from the fenced block markdown in the editor. */
function mermaidDraftSource(markdown: string): string {
  const fenced = markdown.match(/^```[^\n]*\n([\s\S]*?)```/);
  return fenced ? fenced[1].replace(/\n+$/, '') : markdown;
}

/**
 * Live preview for the Mermaid split editor. Renders bypass the document
 * FIFO queue; a generation counter plus the canvas's connectedness discard
 * stale results, and the last successful SVG stays visible on errors.
 */
function startMermaidDraftPreview(
  island: HTMLElement,
  canvas: HTMLElement,
  status: HTMLElement,
  textarea: HTMLTextAreaElement,
  initialSource: string,
): void {
  let generation = 0;
  let timer: number | undefined;
  let composing = false;

  // The dock height must be a px value: percentages inside padding resolve
  // against width, not height. The island height is locked for the session.
  const dockHeight = Math.min(260, Math.max(120, Math.round(island.clientHeight * 0.4)));
  island.style.setProperty('--preview-dock-height', `${dockHeight}px`);

  const render = async (markdown: string): Promise<void> => {
    const gen = ++generation;
    try {
      const { svg } = await mermaidQueue.renderSource(mermaidDraftSource(markdown));
      if (gen !== generation || !canvas.isConnected) return;
      canvas.innerHTML = svg;
      status.textContent = '';
      status.hidden = true;
    } catch (error) {
      if (gen !== generation || !canvas.isConnected) return;
      // Keep the previous SVG; report the parse/render error in the strip.
      status.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`;
      status.hidden = false;
    }
  };
  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void render(textarea.value);
    }, MERMAID_DRAFT_DEBOUNCE_MS);
  };

  textarea.addEventListener('input', () => {
    if (!composing) schedule();
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('compositionstart', () => {
    composing = true;
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    schedule();
  }, { signal: lifecycleController.signal });

  void render(initialSource);
}

function finishBlockEditor(blockId: string, outcome: 'saved' | 'discarded'): void {
  const editor = _activeBlockEditor;
  if (!editor || editor.blockId !== blockId) return;
  _activeBlockEditor = undefined;
  _activeCodeHighlight?.dispose();
  _activeCodeHighlight = undefined;
  const pendingBegin = outcome === 'saved' ? _pendingBeginBlockId : undefined;
  _pendingBeginBlockId = undefined;
  const noOpSave = outcome === 'saved' && _pendingSave?.blockId === blockId && _pendingSave.noOp;
  if (editor.element.isConnected) {
    editor.element.innerHTML = editor.originalHtml;
  }
  // Keep the fixed outer height until the patch lands. blockStore.upsert
  // replaces outerHTML so the fixed height releases naturally on patch
  // arrival; a fallback timer covers no-op saves and lost patches.
  if (outcome === 'saved' && !noOpSave) {
    const locked = editor.element;
    window.setTimeout(() => releaseBlockEditHeight(locked), 1500);
  } else {
    releaseBlockEditHeight(editor.element);
  }

  if (outcome === 'saved' && _pendingSave?.blockId === blockId) {
    const pending = _pendingSave;
    _pendingSave = undefined;
    if (pending.noOp) {
      editMetrics.record('noOpSaveMs', performance.now() - pending.at);
    } else {
      _pendingBlockSave = pending;
    }
  } else if (outcome === 'discarded') {
    if (_pendingCancelAt !== undefined) {
      editMetrics.record('cancelMs', performance.now() - _pendingCancelAt);
    }
    _pendingCancelAt = undefined;
    _pendingSave = undefined;
    _pendingBlockSave = undefined;
  }

  if (pendingBegin !== undefined) {
    _pendingBeginAt = performance.now();
    postToHost({ type: 'begin-edit', payload: { blockId: pendingBegin } });
  }
}

function handleListTab(textarea: HTMLTextAreaElement, dedent: boolean): void {
  const start = textarea.selectionStart;
  const lineStart = textarea.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (dedent) {
    const removable = textarea.value.slice(lineStart).match(/^( {1,2}|\t)/)?.[0];
    if (!removable) return;
    textarea.setRangeText('', lineStart, lineStart + removable.length, 'preserve');
  } else {
    textarea.setRangeText('  ', lineStart, lineStart, 'preserve');
  }
  textarea.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
  }));
}

function releaseBlockEditHeight(element: HTMLElement): void {
  element.classList.remove('markdown-source-preview-block--editing');
  element.style.removeProperty('height');
  element.style.removeProperty('min-height');
  element.style.removeProperty('max-height');
  delete element.dataset.editLockedHeight;
}

function refreshBlock(blockId: string, html: string): void {
  const editor = _activeBlockEditor;
  if (editor?.blockId === blockId) {
    _activeBlockEditor = undefined;
    _activeCodeHighlight?.dispose();
    _activeCodeHighlight = undefined;
    if (editor.element.isConnected) {
      editor.element.innerHTML = editor.originalHtml;
    }
    releaseBlockEditHeight(editor.element);
  }
  blockStore.upsert(blockId, html);
  hideInsertMarker();
}

function showBlockEditError(blockId: string, message: string): void {
  const editor = _activeBlockEditor;
  if (!editor || editor.blockId !== blockId) return;
  // Allow the next Cmd/Ctrl+S after a rejected save.
  _pendingSave = undefined;
  // Drop the pending block switch tied to a failed save and keep editing.
  _pendingBeginBlockId = undefined;
  const error = editor.element.querySelector<HTMLElement>('.markdown-source-preview-block-editor__error');
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
}


function ensureInsertMarker(): HTMLElement {
  if (_insertMarker) return _insertMarker;
  const marker = document.createElement('div');
  marker.className = 'markdown-source-preview-insert-point';
  marker.hidden = true;
  // pointerdown opens the editor immediately: waiting for `click` races
  // with pointerleave/blur hiding the marker before the click dispatches.
  marker.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    // Resolve the anchor from the press position, not the last
    // pointermove snapshot: real pointer events can hide the marker
    // between the hover update and the press. The snapshot remains as
    // a fallback for presses on the marker's edge pixels.
    const anchor = gapAnchorAt(event.clientY)?.anchor ?? _insertMarkerAnchor;
    hideInsertMarker();
    if (anchor) openInsertEditor(anchor);
  }, { signal: lifecycleController.signal });
  // The marker lives on document.body as position:fixed so it never
  // enters root.children and keeps the block binary search clean.
  document.body.appendChild(marker);
  _insertMarker = marker;
  return marker;
}

function hideInsertMarker(): void {
  _insertMarkerAnchor = undefined;
  if (_insertMarker) _insertMarker.hidden = true;
}

/**
 * Locates the whitespace gap under clientY and returns the insertion
 * anchor plus the marker's top offset inside root's coordinate space.
 * Block positions come from offsetTop/offsetHeight so the lookup does
 * not depend on scroll position or require layout reads per block.
 */
function gapAnchorAt(clientY: number): { anchor: InsertAnchor; markerTop: number } | undefined {
  const rootRect = root.getBoundingClientRect();
  const y = clientY - rootRect.top + root.scrollTop;
  const children = root.children;
  // Binary search for the first child whose bottom edge is below y.
  // Children are in document order, so offsetTop ordering holds.
  let lo = 0;
  let hi = children.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const child = children[mid] as HTMLElement;
    if (child.offsetTop + child.offsetHeight <= y) lo = mid + 1;
    else hi = mid;
  }
  // Skip non-block children (insert island, empty editor) to find the
  // surrounding blocks.
  const isBlockChild = (el: Element): el is HTMLElement =>
    el instanceof HTMLElement && el.dataset.blockId !== undefined;
  let nextIndex = lo;
  while (nextIndex < children.length && !isBlockChild(children[nextIndex])) nextIndex++;
  let prevIndex = lo - 1;
  while (prevIndex >= 0 && !isBlockChild(children[prevIndex])) prevIndex--;
  const next = nextIndex < children.length ? children[nextIndex] as HTMLElement : undefined;
  const prev = prevIndex >= 0 ? children[prevIndex] as HTMLElement : undefined;
  if (!prev && !next) return undefined;
  // y inside a block means the pointer is over content, not a gap.
  if (next && y >= next.offsetTop) return undefined;

  const anchor: InsertAnchor = {};
  if (prev) anchor.afterBlockId = prev.dataset.blockId;
  if (next) anchor.beforeBlockId = next.dataset.blockId;

  let markerTop: number;
  if (prev && next) {
    markerTop = (prev.offsetTop + prev.offsetHeight + next.offsetTop) / 2;
  } else if (next) {
    markerTop = next.offsetTop;
  } else {
    markerTop = (prev as HTMLElement).offsetTop + (prev as HTMLElement).offsetHeight;
  }
  return { anchor, markerTop };
}

function updateInsertMarker(clientY: number): void {
  const found = gapAnchorAt(clientY);
  if (!found) {
    hideInsertMarker();
    return;
  }
  const marker = ensureInsertMarker();
  const rootRect = root.getBoundingClientRect();
  const top = Math.round(rootRect.top + found.markerTop - root.scrollTop) - 6;
  const unchanged = _insertMarkerAnchor?.afterBlockId === found.anchor.afterBlockId
    && _insertMarkerAnchor?.beforeBlockId === found.anchor.beforeBlockId
    && marker.style.top === `${top}px`;
  if (unchanged) return;
  _insertMarkerAnchor = found.anchor;
  marker.style.left = `${Math.round(rootRect.left)}px`;
  marker.style.width = `${Math.round(rootRect.width)}px`;
  marker.style.top = `${top}px`;
  marker.hidden = false;
}

function openInsertEditor(anchor: InsertAnchor): void {
  if (_activeInsertEditor || _activeBlockEditor) return;
  const element = document.createElement('div');
  element.className = 'markdown-source-preview-insert-editor';
  const textarea = document.createElement('textarea');
  textarea.className = 'markdown-source-preview-insert-editor__input';
  textarea.placeholder = 'Markdown…';
  element.appendChild(textarea);

  const before = anchor.beforeBlockId !== undefined
    ? blockStore.get(anchor.beforeBlockId)
    : undefined;
  const after = anchor.afterBlockId !== undefined
    ? blockStore.get(anchor.afterBlockId)
    : undefined;
  if (before) before.before(element);
  else if (after) after.after(element);
  else root.appendChild(element);

  _activeInsertEditor = {
    element,
    textarea,
    beforeBlockId: anchor.beforeBlockId,
    afterBlockId: anchor.afterBlockId,
  };
  syncEmptyEditor();

  textarea.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      commitInsertEditor(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      commitInsertEditor(false);
    }
  }, { signal: lifecycleController.signal });
  textarea.addEventListener('blur', () => commitInsertEditor(true), {
    signal: lifecycleController.signal,
  });

  textarea.focus();
}

function commitInsertEditor(save: boolean): void {
  const editor = _activeInsertEditor;
  if (!editor) return;
  _activeInsertEditor = undefined;
  const markdown = editor.textarea.value;
  editor.element.remove();
  syncEmptyEditor();
  if (!save || !markdown.trim()) return;
  postToHost({
    type: 'insert-markdown',
    payload: {
      beforeBlockId: editor.beforeBlockId,
      afterBlockId: editor.afterBlockId,
      markdown,
    },
  });
}

function syncEmptyEditor(): void {
  const show = _editMode === 'edit'
    && !_activeInsertEditor
    && !_activeBlockEditor
    && root.querySelector(':scope > [data-block-id]') === null;
  if (show && !_emptyEditor) {
    const element = document.createElement('div');
    element.className = 'markdown-source-preview-empty-editor';
    element.textContent = 'Click to start writing Markdown';
    element.addEventListener('click', () => openInsertEditor({}), {
      signal: lifecycleController.signal,
    });
    root.appendChild(element);
    _emptyEditor = element;
  } else if (!show && _emptyEditor) {
    _emptyEditor.remove();
    _emptyEditor = undefined;
  }
}

function handleInit(payload: InitPayload): void {
  _currentGeneration = payload.generation;
  // Kick off the Mermaid module import before anything else so it overlaps
  // initial layout, the rest-block stream, and highlighting.
  if (payload.hasMermaid) {
    mermaidQueue.preload();
  }
  if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
    (window as Window & { __MARKDOWN_SOURCE_PREVIEW_INIT__?: unknown }).__MARKDOWN_SOURCE_PREVIEW_INIT__ = {
      parseMs: payload.parseMs,
      renderMs: payload.renderMs,
      initialBlockCount: payload.initialBlockCount,
      totalBlockCount: payload.totalBlockCount,
    };
  }

  // Initial HTML may already be embedded in body or arrive via
  // postMessage; measure the initial-display milestone here
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const ms = performance.now() - _bootMs;
      Instrumentation.emit('first-paint-2raf', ms, {
        generation: payload.generation,
        initialBlocks: payload.initialBlockCount,
        totalBlocks: payload.totalBlockCount,
        parseMs: payload.parseMs,
        renderMs: payload.renderMs,
      });
      if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
        postToHost({ type: 'diagnostic', payload: { event: 'first-paint-2raf', ms } });
      }
    });
  });

  highlightQueue.attach(root);
  mermaidQueue.attach(root);
  syncEmptyEditor();
}


function handlePatch(payload: PatchPayload): void {
  const webviewReceivedEpochMs = performance.timeOrigin + performance.now();
  const receivedAt = performance.now();
  const queueAtReceive = renderQueue.telemetry;
  // Drop patches from older generations
  if (payload.generation < _currentGeneration) {
    console.warn(`[Markdown Source Preview] stale patch dropped gen=${payload.generation} current=${_currentGeneration}`);
    return;
  }
  _currentGeneration = payload.generation;

  const activeBlockId = _activeBlockEditor?.blockId;
  const activeDeleted = activeBlockId !== undefined
    && payload.patches.some(patch => patch.blockId === activeBlockId && patch.op === 'delete');
  if (activeDeleted) {
    // Close the island only when the block itself disappears. For other
    // external changes keep the draft; the host re-verifies version/hash
    // on save.
    _activeBlockEditor = undefined;
    _activeCodeHighlight?.dispose();
    _activeCodeHighlight = undefined;
    _pendingBeginBlockId = undefined;
  }

  const domApplyStarted = performance.now();
  const domApplyStartedEpochMs = performance.timeOrigin + domApplyStarted;
  let applied = 0;
  const changedBlockIds: string[] = [];

  for (const patch of payload.patches) {
    changedBlockIds.push(patch.blockId);
    if (!activeDeleted && patch.blockId === activeBlockId && patch.op !== 'delete') {
      // The editing block's DOM is owned by the textarea island; applying
      // the patch here would drop the draft, so only keep ack correlation.
      applied++;
      continue;
    }
    switch (patch.op) {
      case 'insert':
        renderQueue.enqueueInsert(patch.blockId, patch.html ?? '', patch.beforeId, payload.generation, patch.contentHash);
        applied++;
        break;
      case 'update':
        renderQueue.enqueueUpdate(patch.blockId, patch.html ?? '', payload.generation, patch.contentHash);
        applied++;
        break;
      case 'delete':
        renderQueue.dequeue(patch.blockId);
        blockStore.remove(patch.blockId);
        applied++;
        break;
    }
  }

  // flush applies only CHUNK_SIZE items to the DOM synchronously
  renderQueue.flush();

  if (_pendingBlockSave && changedBlockIds.length > 0) {
    // Block IDs can change after a re-parse, so treat the first patch
    // after a save as the saved block landing and record end-to-end
    // save time.
    editMetrics.record('blockSaveMs', performance.now() - _pendingBlockSave.at);
    _pendingBlockSave = undefined;
  }

  // domApplyMs: synchronous time from message receipt to flush
  // completion. Remaining rest blocks continue on later rAFs, but
  // changed blocks (including the sentinel) are always in the first
  // flush.
  const domApplyEnded = performance.now();
  const domApplyEndedEpochMs = performance.timeOrigin + domApplyEnded;
  const domApplyMs = +(domApplyEnded - domApplyStarted).toFixed(1);
  const webviewQueueWaitMs = +(domApplyStarted - receivedAt).toFixed(3);

  // Emit performance marks for patched blocks
  for (const blockId of changedBlockIds) {
    try {
      performance.mark(`markdown-source-preview:block-applied:${payload.generation}:${blockId}`);
    } catch {}
  }

  const appliedAt = domApplyEnded;
  if (applied > 0) {
    Instrumentation.emit('patch-applied', domApplyMs, { gen: payload.generation, patches: applied });

    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
      // Report back to the host including DOM apply time
      const ackSentEpochMs = performance.timeOrigin + performance.now();
      const queueAfterFlush = renderQueue.telemetry;
      const ackPayload = {
        generation: payload.generation,
        blockIds: changedBlockIds,
        appliedAt,
        domApplyMs,
        webviewReceivedEpochMs,
        domApplyStartedEpochMs,
        domApplyEndedEpochMs,
        ackSentEpochMs,
        webviewQueueWaitMs,
        queueLengthAtReceive: queueAtReceive.queueLength,
        urgentQueueLengthAtReceive: queueAtReceive.urgentLength,
        urgentStartWaitMs: renderQueue.telemetry.urgentStartWaitMs,
        backgroundChunkLastMs: queueAfterFlush.backgroundChunkLastMs,
        backgroundChunkMaxMs: queueAfterFlush.backgroundChunkMaxMs,
        backgroundChunkCount: queueAfterFlush.backgroundChunkCount,
      };
      postToHost({
        type: 'patch-applied',
        payload: ackPayload,
      });

      // Record on window so diagnostics can read it via frame.evaluate()
      (window as any).__MARKDOWN_SOURCE_PREVIEW_LAST_PATCH__ = {
        generation: payload.generation,
        blockIds: changedBlockIds,
        appliedAt,
        domApplyMs,
        webviewReceivedEpochMs,
        domApplyStartedEpochMs,
        domApplyEndedEpochMs,
        ackSentEpochMs,
        webviewQueueWaitMs,
        queueLengthAtReceive: queueAtReceive.queueLength,
        urgentQueueLengthAtReceive: queueAtReceive.urgentLength,
        urgentStartWaitMs: renderQueue.telemetry.urgentStartWaitMs,
        backgroundChunkLastMs: queueAfterFlush.backgroundChunkLastMs,
        backgroundChunkMaxMs: queueAfterFlush.backgroundChunkMaxMs,
        backgroundChunkCount: queueAfterFlush.backgroundChunkCount,
      };
    }
  }

  hideInsertMarker();
  syncEmptyEditor();
}

// Diagnostics message handler (ack record echoed back by the host)

function handleDiagnostic(payload: DiagnosticPayload): void {
  if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) return;
  if (payload.event === 'ack-record' && payload.extra) {
    // Write host-computed patchAckMs / hostPrepareMs to window;
    // diagnostics read this via frame.evaluate().
    const ack = {
      generation: payload.extra['generation'],
      hostPrepareMs: payload.extra['hostPrepareMs'],
      getTextMs: payload.extra['getTextMs'],
      parseMs: payload.extra['parseMs'],
      buildBlocksMs: payload.extra['buildBlocksMs'],
      diffMs: payload.extra['diffMs'],
      serializeEstimateMs: payload.extra['serializeEstimateMs'],
      patchAckMs: payload.extra['patchAckMs'],
      domApplyMs: payload.extra['domApplyMs'],
      changedBlockCount: payload.extra['changedBlockCount'],
      messageBytes: payload.extra['messageBytes'],
      blockIds: payload.extra['blockIds'],
      hostChangeReceivedEpochMs: payload.extra['hostChangeReceivedEpochMs'],
      debounceMs: payload.extra['debounceMs'],
      hostPatchSentEpochMs: payload.extra['hostPatchSentEpochMs'],
      hostAckReceivedEpochMs: payload.extra['hostAckReceivedEpochMs'],
      hostToWebviewReceiveMs: payload.extra['hostToWebviewReceiveMs'],
      webviewQueueWaitMs: payload.extra['webviewQueueWaitMs'],
      webviewToHostAckMs: payload.extra['webviewToHostAckMs'],
      backgroundChunkLastMs: payload.extra['backgroundChunkLastMs'],
      backgroundChunkMaxMs: payload.extra['backgroundChunkMaxMs'],
      backgroundChunkCount: payload.extra['backgroundChunkCount'],
      queueLengthAtReceive: payload.extra['queueLengthAtReceive'],
      urgentQueueLengthAtReceive: payload.extra['urgentQueueLengthAtReceive'],
      urgentStartWaitMs: payload.extra['urgentStartWaitMs'],
    };
    (window as any).__MARKDOWN_SOURCE_PREVIEW_ACKS__ ??= {};
    (window as any).__MARKDOWN_SOURCE_PREVIEW_ACKS__[String(ack.generation)] = ack;
    (window as any).__MARKDOWN_SOURCE_PREVIEW_LAST_ACK__ = ack;
    Instrumentation.emit('ack-record', payload.ms, payload.extra);
  }
}


function scrollToLine(payload: ScrollPayload): void {
  const { line } = payload;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-line]')];
  const el = blocks.reduce<HTMLElement | null>((nearest, block) => {
    const blockLine = Number(block.dataset.line);
    return blockLine <= line ? block : nearest;
  }, null) ?? blocks[0] ?? null;
  if (el) {
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
      (window as Window & { __MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL_TRACE__?: string[] })
        .__MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL_TRACE__?.push(`host-scroll line=${line} token=${payload.token}`);
    }
    if (_programmaticScrollTimer !== undefined) {
      window.clearTimeout(_programmaticScrollTimer);
    }
    _sourceScrollToken = payload.token;
    _programmaticScrollLine = Number(el.dataset.line);
    el.scrollIntoView({ block: 'start', behavior: 'auto' });
    _programmaticScrollTimer = window.setTimeout(() => {
      _sourceScrollToken = undefined;
      _programmaticScrollLine = undefined;
      _programmaticScrollTimer = undefined;
    }, 1000);
  }
}

// ---------- LongTask observer ----------

let longTaskObserver: PerformanceObserver | null = null;
if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && typeof PerformanceObserver !== 'undefined') {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      editMetrics.recordLongTask(entry.duration);
      if (entry.duration >= 1000) {
        Instrumentation.emit('long-task-1s', entry.startTime, { duration: entry.duration });
        postToHost({
          type: 'diagnostic',
          payload: { event: 'long-task-1s', ms: entry.startTime, extra: { duration: entry.duration } },
        });
      }
    }
  });
  try {
    observer.observe({ type: 'longtask', buffered: true });
    longTaskObserver = observer;
  } catch {
    observer.disconnect();
  }
}

let cleanupSnapshot: WebviewCleanupSnapshot | undefined;

function disposeWebview(): WebviewCleanupSnapshot {
  if (cleanupSnapshot) return cleanupSnapshot;
  lifecycleController.abort();
  renderQueue.dispose();
  highlightQueue.dispose();
  mermaidQueue.dispose();
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  disposeInstrumentation();
  if (_programmaticScrollTimer !== undefined) {
    window.clearTimeout(_programmaticScrollTimer);
    _programmaticScrollTimer = undefined;
  }
  const renderCleanup = renderQueue.cleanupState;
  const highlightCleanup = highlightQueue.cleanupState;
  const mermaidCleanup = mermaidQueue.cleanupState;
  cleanupSnapshot = {
    renderQueueDisposed: renderCleanup.disposed,
    highlightQueueDisposed: highlightCleanup.disposed,
    mermaidQueueDisposed: mermaidCleanup.disposed,
    highlightObserversDisconnected: highlightCleanup.observersDisconnected,
    mermaidObserversDisconnected: mermaidCleanup.observersDisconnected,
    performanceObserverDisconnected: longTaskObserver === null && isInstrumentationDisposed(),
    listenersRemoved: lifecycleController.signal.aborted,
    pendingAnimationFrames: renderCleanup.pendingAnimationFrames,
    pendingIdleCallbacks: highlightCleanup.pendingIdleCallbacks + mermaidCleanup.pendingIdleCallbacks,
    pendingBlocks: renderCleanup.pendingBlocks,
    pendingMermaidJobs: mermaidCleanup.pendingJobs,
    activeMermaidRenders: mermaidCleanup.activeRenders,
  };
  if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
    (window as Window & { __MARKDOWN_SOURCE_PREVIEW_CLEANUP__?: WebviewCleanupSnapshot }).__MARKDOWN_SOURCE_PREVIEW_CLEANUP__ =
      cleanupSnapshot;
  }
  return cleanupSnapshot;
}

window.addEventListener('pagehide', () => {
  const cleanup = disposeWebview();
  if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
    try {
      postToHost({ type: 'webview-disposed-best-effort', payload: { cleanup } });
    } catch {
      // The Webview transport may be gone during page teardown.
    }
  }
}, { once: true });
