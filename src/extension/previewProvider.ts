/**
 * CustomTextEditorProvider implementation. Owns webview creation,
 * initial HTML delivery, and incremental patch delivery on document
 * changes.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DocumentSession } from './documentSession.js';
import type { UpdateTimings } from './documentSession.js';
import { detectReadonly } from './readonlyState.js';
import { escAttr, slugifyHeading, wrapBlock } from '../core/blockParser.js';
import {
  detectLineEnding,
  findBlockSource,
  insertionForGap,
  outsideRangeEqual,
  replacementForBlock,
  sourceRangeForLines,
} from '../core/editRange.js';
import { isEditableBlockKind } from '../core/renderModel.js';
import {
  getMermaidGraphicalCommands,
  resolveMermaidGraphicalCommand,
  revealMermaidSource,
} from './mermaidGraphical.js';
import type {
  HostToWebview,
  WebviewToHost,
  BlockPatch,
  InitPayload,
  WebviewCleanupSnapshot,
} from '../core/renderModel.js';

/** Patch send record kept per generation. */
interface PendingPatch {
  /** Timestamp just before the postMessage call (performance.now()). */
  sentAt: number;
  timings: UpdateTimings;
  blockIds: string[];
  hostChangeReceivedEpochMs: number;
  debounceMs: number;
  hostPatchSentEpochMs: number;
}

interface ScrollSyncState {
  suppressSourceEchoUntil?: number;
  suppressionTimer?: ReturnType<typeof setTimeout>;
  eventTimer?: ReturnType<typeof setTimeout>;
  pendingSourceLine?: number;
  readonly receivedPreviewTokens: Set<string>;
}

interface PendingRequest {
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingResponse<T> extends PendingRequest {
  resolve: (value: T) => void;
}

interface PendingDisposeRequest extends PendingResponse<WebviewCleanupSnapshot> {
  session: DocumentSession;
}

interface ActiveBlockEdit {
  blockId: string;
  startOffset: number;
  endOffset: number;
  baseDocumentVersion: number;
  baseSourceHash: string;
  originalSource: string;
  editorSource: string;
  draft: string;
  committing: boolean;
  /** In-flight save shared by blur / Cmd+S / mode exit racing each other. */
  commitInFlight?: Promise<boolean>;
  /** Whether an external change was observed after edit start (re-verified on save). */
  externalChange: boolean;
}

interface PanelEditState {
  mode: 'read' | 'edit';
  readonly: boolean;
  activeEdit?: ActiveBlockEdit;
  /** Last right-clicked Mermaid block ID, used to launch the graphical editor. */
  contextMermaidBlockId?: string;
}

interface PendingDraftRequest extends PendingResponse<string> {
  panel: vscode.WebviewPanel;
  blockId: string;
}

export class PreviewProvider implements vscode.CustomTextEditorProvider {
  static readonly VIEW_TYPE = 'markdownSourcePreview.preview';
  private readonly _editModeStatus: vscode.StatusBarItem;
  private readonly _readonlyStatus: vscode.StatusBarItem;

  // webview panel → session
  private readonly _panels = new Map<vscode.WebviewPanel, DocumentSession>();
  private readonly _editStates = new Map<vscode.WebviewPanel, PanelEditState>();
  private readonly _sessions = new Map<string, Set<DocumentSession>>();
  // session → generation → send record (avoids parsing console.log)
  private readonly _pendingPatches = new Map<DocumentSession, Map<number, PendingPatch>>();
  private readonly _pendingDisposeRequests = new Map<string, PendingDisposeRequest>();
  private readonly _pendingDraftRequests = new Map<string, PendingDraftRequest>();
  private _activePanel: vscode.WebviewPanel | undefined;

  constructor(private readonly _ctx: vscode.ExtensionContext) {
    this._editModeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._editModeStatus.command = 'markdownSourcePreview.toggleEditMode';
    // Read-only uses a separate item without a command: clearing a single
    // item's command still leaves it clickable.
    this._readonlyStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._readonlyStatus.text = '$(lock)';
    this._readonlyStatus.tooltip = 'Markdown: 編集不可 — このMarkdown文書は編集できません';
    this._readonlyStatus.accessibilityInformation = {
      label: 'Markdown: 編集不可',
    };
    this._editModeStatus.name = 'Markdown Source Preview Editing Mode';
    this._readonlyStatus.name = 'Markdown Source Preview: Read-only';
    this._ctx.subscriptions.push(
      this._editModeStatus,
      this._readonlyStatus,
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this._activePanel = undefined;
          this._updateEditModeStatus();
          return;
        }
        setTimeout(() => {
          this._activePanel = [...this._panels.keys()].find(panel => panel.active && panel.visible);
          this._updateEditModeStatus();
        }, 0);
      }),
    );
  }

  async toggleEditMode(): Promise<void> {
    const startedAt = performance.now();
    const panel = this._activePanel;
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_TOGGLE] panel=${Boolean(panel)} state=${Boolean(panel && this._editStates.get(panel))}`);
    if (!panel) return;
    const state = this._editStates.get(panel);
    if (!state) return;
    if (state.mode === 'read') {
      // Do not cache the read-only check; re-verify on every edit start.
      const session = this._panels.get(panel);
      if (state.readonly || (session && await this._isDocumentReadonly(session.document))) {
        state.readonly = true;
        this._postEditMode(panel, state);
        this._updateEditModeStatus();
        void vscode.window.showInformationMessage('このMarkdown文書は編集できません。');
        return;
      }
      state.mode = 'edit';
      this._postEditMode(panel, state);
      this._updateEditModeStatus();
      this._logEditMode('edit', performance.now() - startedAt);
      return;
    }
    const exited = await this._exitEditMode(panel, state);
    if (exited) this._logEditMode('read', performance.now() - startedAt);
  }

  /**
   * "Open in Mermaid Graphical Editor" command. Saves any active edit
   * island first, reveals the fence in a text editor, and auto-launches
   * only when the external extension exposes exactly one command.
   */
  async openMermaidGraphicalEditor(): Promise<void> {
    const panel = this._activePanel;
    const state = panel && this._editStates.get(panel);
    const session = panel && this._panels.get(panel);
    if (!panel || !state || !session) return;

    // Save an unsaved island before opening the GUI; do not open the
    // external GUI when the save fails.
    const activeEdit = state.activeEdit;
    if (activeEdit && !activeEdit.committing) {
      const saved = await this._commitBlockEdit(
        activeEdit.blockId,
        activeEdit.draft,
        panel,
        session,
      );
      if (!saved) return;
    }

    const blockId = state.contextMermaidBlockId;
    const block = blockId ? session.findBlock(blockId) : null;
    if (!block || block.kind !== 'mermaid') {
      void vscode.window.showInformationMessage(
        '先に Mermaid 図を右クリックしてください。',
      );
      return;
    }

    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_MERMAID_GUI] ${JSON.stringify({
      blockId: block.id,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      commands: getMermaidGraphicalCommands(),
    })}`);

    await revealMermaidSource(session.document, block);

    const command = await resolveMermaidGraphicalCommand();
    if (command) {
      await vscode.commands.executeCommand(command);
    }
  }

  async enterEditMode(): Promise<void> {
    const state = this._activePanel && this._editStates.get(this._activePanel);
    if (!state || state.readonly || state.mode === 'edit') return;
    await this.toggleEditMode();
  }

  async exitEditMode(): Promise<void> {
    const startedAt = performance.now();
    const panel = this._activePanel;
    const state = panel && this._editStates.get(panel);
    if (!panel || !state || state.mode === 'read') return;
    const exited = await this._exitEditMode(panel, state);
    if (exited) this._logEditMode('read', performance.now() - startedAt);
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const config = this._getConfig();

    const resourceRoots = this._resourceRoots(document);
    const session = new DocumentSession(document, config, {
      resolveImage: src => this._resolveImage(src, document, webviewPanel.webview, resourceRoots),
    });
    const documentUri = document.uri.toString();
    const readonly = await this._isDocumentReadonly(document);
    const editState: PanelEditState = {
      // New previews start in edit mode; read-only documents stay in read mode.
      mode: readonly ? 'read' : 'edit',
      readonly,
    };
    this._editStates.set(webviewPanel, editState);
    const documentSessions = this._sessions.get(documentUri) ?? new Set<DocumentSession>();
    documentSessions.add(session);
    this._sessions.set(documentUri, documentSessions);
    this._panels.set(webviewPanel, session);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SESSION_CREATED] ${JSON.stringify({
      uri: documentUri,
      activeSessions: documentSessions.size,
    })}`);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._ctx.extensionUri, 'dist'),
        vscode.Uri.joinPath(this._ctx.extensionUri, 'media'),
        ...resourceRoots,
      ],
    };

    const initPayload = session.buildInitPayload(0);
    webviewPanel.webview.html = this._buildWebviewHtml(webviewPanel.webview, initPayload.initialHtml);

    const scrollSyncState: ScrollSyncState = { receivedPreviewTokens: new Set() };

    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) =>
        this._onWebviewMessage(msg, webviewPanel, session!, initPayload, scrollSyncState),
    );
    const focusDisposable = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active && webviewPanel.visible) {
        this._activePanel = webviewPanel;
        this._updateEditModeStatus();
      } else if (this._activePanel === webviewPanel) {
        this._activePanel = [...this._panels.keys()].find(panel => panel !== webviewPanel && panel.active && panel.visible);
        this._updateEditModeStatus();
      }
    });
    const scrollDisposable = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      if (event.textEditor.document.uri.toString() !== document.uri.toString()
        || !webviewPanel.visible
        || !event.visibleRanges.length) return;

      const visibleRange = event.visibleRanges[0];
      if (scrollSyncState.suppressSourceEchoUntil !== undefined) {
        if (Date.now() < scrollSyncState.suppressSourceEchoUntil) return;
        scrollSyncState.suppressSourceEchoUntil = undefined;
      }

      scrollSyncState.pendingSourceLine = visibleRange.start.line;
      if (scrollSyncState.eventTimer) return;
      scrollSyncState.eventTimer = setTimeout(() => {
        scrollSyncState.eventTimer = undefined;
        const line = scrollSyncState.pendingSourceLine;
        if (line === undefined || !webviewPanel.visible) return;
        const token = crypto.randomUUID();
        this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL] source token=${token} line=${line}`);
        webviewPanel.webview.postMessage({
          type: 'scroll',
          payload: { line, origin: 'source', token },
        } satisfies HostToWebview);
      }, 32);
    });

    // Watch document changes (debounce follows the configured value)
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingDocument: vscode.TextDocument | null = null;
    let pendingChanges: vscode.TextDocumentContentChangeEvent[] = [];
    let hostChangeReceivedEpochMs: number | undefined;
    let changeEventReceivedAt = 0;
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (!webviewPanel.visible) return;
      const activeEdit = editState.activeEdit;
      if (activeEdit && !activeEdit.committing) {
        activeEdit.externalChange = true;
        const affectsActiveBlock = e.contentChanges.some(change =>
          change.rangeOffset < activeEdit.endOffset
          && change.rangeOffset + change.rangeLength > activeEdit.startOffset);
        if (affectsActiveBlock) {
          this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_EXTERNAL] blockId=${activeEdit.blockId} affectsTarget=true`);
          void webviewPanel.webview.postMessage({
            type: 'edit-error',
            payload: {
              blockId: activeEdit.blockId,
              message: 'このブロックは編集中に外部で変更されました。保存時に確認します。',
            },
          } satisfies HostToWebview);
        }
      }
      if (hostChangeReceivedEpochMs === undefined) {
        hostChangeReceivedEpochMs = Date.now();
        changeEventReceivedAt = performance.now();
      }
      pendingDocument = e.document;
      pendingChanges.push(...e.contentChanges);

      const debounceDelay = config.debounceMs;
      if (updateTimer) clearTimeout(updateTimer);

      const triggerUpdate = () => {
        updateTimer = undefined;
        const doc = pendingDocument;
        const changes = pendingChanges;
        const changeEpoch = hostChangeReceivedEpochMs ?? Date.now();
        const debounceMs = +(performance.now() - changeEventReceivedAt).toFixed(3);
        pendingDocument = null;
        pendingChanges = [];
        hostChangeReceivedEpochMs = undefined;
        if (!doc) return;
        this._handleDocumentChange(doc, webviewPanel, session!, changes, changeEpoch, debounceMs).catch((error) => {
          console.error(`[Markdown Source Preview] host update failed: ${String(error)}`);
        });
      };

      if (debounceDelay <= 0) {
        // apply immediately
        triggerUpdate();
      } else {
        updateTimer = setTimeout(triggerUpdate, debounceDelay);
      }
    });
    const panelDisposables = vscode.Disposable.from(messageDisposable, focusDisposable, scrollDisposable, changeDisposable);
    let disposeListener: vscode.Disposable;
    disposeListener = webviewPanel.onDidDispose(() => {
      if (updateTimer) clearTimeout(updateTimer);
      pendingDocument = null;
      pendingChanges.length = 0;
      hostChangeReceivedEpochMs = undefined;
      if (scrollSyncState.eventTimer) clearTimeout(scrollSyncState.eventTimer);
      if (scrollSyncState.suppressionTimer) clearTimeout(scrollSyncState.suppressionTimer);
      scrollSyncState.pendingSourceLine = undefined;
      scrollSyncState.suppressSourceEchoUntil = undefined;
      scrollSyncState.receivedPreviewTokens.clear();
      panelDisposables.dispose();
      this._panels.delete(webviewPanel);
      this._editStates.delete(webviewPanel);
      if (this._activePanel === webviewPanel) {
        this._activePanel = undefined;
        this._updateEditModeStatus();
      }
      session.dispose();
      const currentSessions = this._sessions.get(documentUri);
      currentSessions?.delete(session);
      if (currentSessions?.size === 0) this._sessions.delete(documentUri);
      this._deletePendingPatches(session);
      const pendingAcks = this._pendingPatchCount(session);
      this._rejectPending(
        this._pendingDisposeRequests,
        request => request.session === session,
        'Preview panel was disposed before cleanup preparation completed',
      );
      this._rejectPending(
        this._pendingDraftRequests,
        request => request.panel === webviewPanel,
        'Preview panel was disposed before the edit draft was received',
      );
      this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_HOST_DISPOSED] ${JSON.stringify({
        uri: documentUri,
        pendingAcks,
        sessionRemoved: !currentSessions?.has(session),
        activeSessions: currentSessions?.size ?? 0,
      })}`);
      disposeListener.dispose();
    });
    this._ctx.subscriptions.push(panelDisposables, disposeListener);
  }

  async prepareDisposeForDiagnostics(): Promise<void> {
    const panel = [...this._panels.keys()].find(candidate => candidate.visible);
    if (!panel) throw new Error('No visible Markdown Source Preview panel to prepare for disposal');
    const session = this._panels.get(panel);
    if (!session) throw new Error('Visible Preview panel has no active document session');

    await this._postRequest<WebviewCleanupSnapshot, PendingDisposeRequest>(
      panel,
      this._pendingDisposeRequests,
      (_requestId, resolve, reject, timer) => ({ session, resolve, reject, timer }),
      requestId => ({ type: 'prepare-dispose', payload: { requestId } }),
      5_000,
      'Timed out waiting for Webview dispose-prepared response',
      'Could not send prepare-dispose request to the Webview',
    );
  }


  private _onWebviewMessage(
    msg: WebviewToHost,
    panel: vscode.WebviewPanel,
    session: DocumentSession,
    initPayload: InitPayload,
    scrollSyncState: ScrollSyncState,
  ): void {
    switch (msg.type) {
      case 'ready': {
        this._logDiagnostics('[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_READY]');
        // The webview startup handshake guarantees the init listener is ready.
        panel.webview.postMessage({ type: 'init', payload: initPayload } satisfies HostToWebview);
        const editState = this._editStates.get(panel);
        if (editState) this._postEditMode(panel, editState);
        if (panel.active && panel.visible) {
          this._activePanel = panel;
          this._updateEditModeStatus();
        }
        this._sendRestBlocks(panel, session);
        break;
      }
      case 'focus': {
        if (panel.active && panel.visible) {
          this._activePanel = panel;
          this._updateEditModeStatus();
        }
        break;
      }
      case 'begin-edit': {
        this._beginBlockEdit(msg.payload.blockId, panel, session);
        break;
      }
      case 'mermaid-context': {
        const state = this._editStates.get(panel);
        if (state) state.contextMermaidBlockId = msg.payload.blockId;
        break;
      }
      case 'edit-draft': {
        const edit = this._editStates.get(panel)?.activeEdit;
        if (edit?.blockId === msg.payload.blockId) {
          edit.draft = msg.payload.markdown;
          this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_DRAFT] blockId=${edit.blockId} requestId=${msg.payload.requestId ?? 'input'} length=${msg.payload.markdown.length}`);
          if (msg.payload.requestId) {
            const pending = this._pendingDraftRequests.get(msg.payload.requestId);
            if (pending?.panel === panel && pending.blockId === edit.blockId) {
              clearTimeout(pending.timer);
              this._pendingDraftRequests.delete(msg.payload.requestId);
              pending.resolve(msg.payload.markdown);
            }
          }
        }
        break;
      }
      case 'commit-edit': {
        this._commitBlockEdit(msg.payload.blockId, msg.payload.markdown, panel, session).catch(error => {
          const message = `Markdown block could not be saved: ${String(error)}`;
          console.error(`[Markdown Source Preview] ${message}`);
          void vscode.window.showErrorMessage(message);
        });
        break;
      }
      case 'insert-markdown': {
        this._insertMarkdown(msg.payload, panel, session).catch(error => {
          const message = `Markdown block could not be inserted: ${String(error)}`;
          console.error(`[Markdown Source Preview] ${message}`);
          void vscode.window.showErrorMessage(message);
        });
        break;
      }
      case 'cancel-edit': {
        const state = this._editStates.get(panel);
        if (state?.activeEdit?.blockId === msg.payload.blockId) {
          this._finishBlockEdit(panel, state, 'discarded');
        }
        break;
      }
      case 'diagnostic': {
        if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) break;
        const { event, ms, extra } = msg.payload;
        console.log(`[MARKDOWN_SOURCE_PREVIEW_PERF] webview event=${event} ms=${ms.toFixed(1)}`, extra ?? '');
        break;
      }
      case 'open-link': {
        const href = msg.payload?.href;
        if (typeof href !== 'string') {
          console.warn('[Markdown Source Preview] Ignored malformed open-link message');
          break;
        }
        this._openLink(href, session.document).catch(error => {
          const message = `Unable to open Markdown link: ${String(error)}`;
          console.error(`[Markdown Source Preview] ${message}`);
          void vscode.window.showErrorMessage(message);
        });
        break;
      }
      case 'scroll-sync': {
        const { line, origin, token } = msg.payload;
        if (origin !== 'preview' || typeof token !== 'string' || token.length === 0 || token.length > 128) {
          break;
        }
        if (scrollSyncState.receivedPreviewTokens.has(token)) {
          this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL] duplicate token=${token}`);
          break;
        }
        scrollSyncState.receivedPreviewTokens.add(token);
        if (scrollSyncState.receivedPreviewTokens.size > 256) {
          const oldest = scrollSyncState.receivedPreviewTokens.values().next().value;
          if (oldest !== undefined) scrollSyncState.receivedPreviewTokens.delete(oldest);
        }
        const editor = vscode.window.visibleTextEditors.find(
          candidate => candidate.document.uri.toString() === session.document.uri.toString(),
        );
        if (!editor || !Number.isInteger(line) || line < 0) break;

        const targetLine = Math.min(line, session.document.lineCount - 1);
        this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_SCROLL] accepted token=${token} line=${targetLine}`);
        scrollSyncState.suppressSourceEchoUntil = Date.now() + 500;
        clearTimeout(scrollSyncState.suppressionTimer);
        scrollSyncState.suppressionTimer = setTimeout(() => {
          scrollSyncState.suppressSourceEchoUntil = undefined;
          scrollSyncState.suppressionTimer = undefined;
        }, 500);
        const position = new vscode.Position(targetLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.AtTop,
        );
        break;
      }
      case 'dispose-prepared': {
        const { requestId, cleanup } = msg.payload;
        const pending = this._pendingDisposeRequests.get(requestId);
        if (!pending || pending.session !== session) break;
        clearTimeout(pending.timer);
        this._pendingDisposeRequests.delete(requestId);
        this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_PREPARED] ${JSON.stringify({
          requestId,
          uri: session.document.uri.toString(),
          cleanup,
        })}`);
        pending.resolve(cleanup);
        break;
      }
      case 'webview-disposed-best-effort': {
        this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_POST_CLOSE_ACK] ${JSON.stringify({
          uri: session.document.uri.toString(),
          cleanup: msg.payload.cleanup,
        })}`);
        break;
      }
      case 'patch-applied': {
        if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) break;
        const gen = msg.payload.generation;
        const sessionPatches = this._pendingPatches.get(session);
        const pending = sessionPatches?.get(gen);
        if (!sessionPatches || !pending) {
          console.warn(`[MARKDOWN_SOURCE_PREVIEW_PERF] patch-applied without pending patch gen=${gen}`);
          // Ignore orphan acks from older generations
          break;
        }

        const acknowledgedIds = [...msg.payload.blockIds].sort();
        const expectedIds = [...pending.blockIds].sort();
        if (acknowledgedIds.length !== expectedIds.length
          || acknowledgedIds.some((id, index) => id !== expectedIds[index])) {
          console.error(`[MARKDOWN_SOURCE_PREVIEW_PERF] patch-ack correlation mismatch gen=${gen} expected=${expectedIds.join(',')} actual=${acknowledgedIds.join(',')}`);
          sessionPatches.delete(gen);
          break;
        }
        sessionPatches.delete(gen);

        const diagnostics = msg.payload.diagnostics;
        if (!diagnostics) break;
        const patchAckMs = +(performance.now() - pending.sentAt).toFixed(1);
        const hostAckReceivedEpochMs = Date.now();
        const domApplyMs = +diagnostics.domApplyMs.toFixed(1);
        const hostToWebviewReceiveMs = diagnostics.webviewReceivedEpochMs - pending.hostPatchSentEpochMs;
        const webviewToHostAckMs = hostAckReceivedEpochMs - diagnostics.ackSentEpochMs;

        console.log(
          `[MARKDOWN_SOURCE_PREVIEW_PERF] patch-ack gen=${gen}` +
          ` hostPrepareMs=${pending.timings.hostPrepareMs}` +
          ` patchAckMs=${patchAckMs}` +
          ` domApplyMs=${domApplyMs}` +
          ` blocks=${msg.payload.blockIds.length}` +
          ` bytes=${pending.timings.messageBytes}`,
        );

        // Expose the ack on a window global so diagnostics can read it
        // via frame.evaluate(() => window.__MARKDOWN_SOURCE_PREVIEW_LAST_ACK__).
        panel.webview.postMessage({
          type: 'diagnostic',
          payload: {
            event: 'ack-record',
            ms: patchAckMs,
            extra: {
              ...pending.timings,
              ...diagnostics,
              generation: gen,
              patchAckMs,
              domApplyMs,
              blockIds: pending.blockIds,
              hostChangeReceivedEpochMs: pending.hostChangeReceivedEpochMs,
              debounceMs: pending.debounceMs,
              hostPatchSentEpochMs: pending.hostPatchSentEpochMs,
              hostAckReceivedEpochMs,
              hostToWebviewReceiveMs,
              webviewToHostAckMs,
            },
          },
        } satisfies HostToWebview);
        break;
      }
    }
  }

  private _resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder?.uri.scheme === 'file') return [folder.uri];
    if (document.uri.scheme === 'file') {
      return [vscode.Uri.file(path.dirname(document.uri.fsPath))];
    }
    return [];
  }

  private _resolveImage(
    src: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    roots: readonly vscode.Uri[],
  ): string | null {
    try {
      const target = new URL(src, document.uri.toString());
      if (target.protocol === 'https:') return target.href;
      if (target.protocol !== 'file:') return null;

      const targetUri = vscode.Uri.parse(target.href, true);
      if (!this._isWithinRoots(targetUri, roots)) return null;
      return webview.asWebviewUri(targetUri).toString();
    } catch (error) {
      console.warn(`[Markdown Source Preview] Rejected image URL ${JSON.stringify(src)}: ${String(error)}`);
      return null;
    }
  }

  private _isWithinRoots(target: vscode.Uri, roots: readonly vscode.Uri[]): boolean {
    if (target.scheme !== 'file') return false;
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(target.fsPath);
    } catch {
      return false;
    }

    return roots.some(root => {
      if (root.scheme !== 'file') return false;
      try {
        const relative = path.relative(fs.realpathSync(root.fsPath), realTarget);
        return relative === '' || (
          relative !== '..'
          && !relative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relative)
        );
      } catch {
        return false;
      }
    });
  }

  private async _openLink(href: string, document: vscode.TextDocument): Promise<void> {
    let target: URL;
    try {
      target = new URL(href, document.uri.toString());
    } catch (error) {
      console.warn(`[Markdown Source Preview] Rejected malformed link ${JSON.stringify(href)}: ${String(error)}`);
      return;
    }

    if (target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === 'mailto:') {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(target.href, true));
      if (!opened) throw new Error(`VS Code could not open ${target.protocol} link`);
      return;
    }
    if (target.protocol !== 'file:') {
      console.warn(`[Markdown Source Preview] Rejected link scheme: ${target.protocol}`);
      return;
    }

    const targetUri = vscode.Uri.parse(target.href, true);
    const roots = this._resourceRoots(document);
    if (!this._isWithinRoots(targetUri, roots)) {
      console.warn(`[Markdown Source Preview] Rejected workspace-external file link: ${targetUri.toString()}`);
      return;
    }

    const realPath = fs.realpathSync(targetUri.fsPath);
    const openedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(realPath));
    const editor = await vscode.window.showTextDocument(openedDocument, vscode.ViewColumn.Beside);
    let fragment: string;
    try {
      fragment = decodeURIComponent(target.hash.slice(1));
    } catch (error) {
      console.warn(`[Markdown Source Preview] Rejected malformed heading fragment: ${String(error)}`);
      return;
    }
    if (!fragment) return;

    const headingOccurrences = new Map<string, number>();
    const lines = openedDocument.getText().split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
      const match = lines[line].match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!match) continue;
      const heading = match[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
        .replace(/`([^`]*)`/g, '$1');
      const base = slugifyHeading(heading);
      const occurrence = headingOccurrences.get(base) ?? 0;
      headingOccurrences.set(base, occurrence + 1);
      const slug = occurrence === 0 ? base : `${base}-${occurrence}`;
      if (slug !== fragment) continue;
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      return;
    }
  }

  private async _exitEditMode(panel: vscode.WebviewPanel, state: PanelEditState): Promise<boolean> {
    const activeEdit = state.activeEdit;
    if (activeEdit) {
      try {
        activeEdit.draft = await this._requestEditDraft(panel, activeEdit);
      } catch (error) {
        const message = `Unable to read the active Markdown draft: ${String(error)}`;
        console.error(`[Markdown Source Preview] ${message}`);
        void vscode.window.showErrorMessage(message);
        return false;
      }
    }

    if (activeEdit) {
      const dirty = activeEdit.draft !== activeEdit.editorSource;
      this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_EXIT] blockId=${activeEdit.blockId} dirty=${dirty}`);
      if (dirty) {
        // Edit → read auto-saves without a confirmation dialog. Keep edit
        // mode only on failure; _commitBlockEdit shows the warning. A blur
        // save that already finished counts as a normal exit.
        const session = this._panels.get(panel);
        if (!session) return false;
        let saved = false;
        try {
          saved = await this._commitBlockEdit(activeEdit.blockId, activeEdit.draft, panel, session);
        } catch (error) {
          const message = `Markdown block could not be saved: ${String(error)}`;
          console.error(`[Markdown Source Preview] ${message}`);
          void vscode.window.showErrorMessage(message);
          return false;
        }
        if (!saved && state.activeEdit) return false;
      } else {
        this._finishBlockEdit(panel, state, 'discarded');
      }
    }

    state.mode = 'read';
    this._postEditMode(panel, state);
    this._updateEditModeStatus();
    return true;
  }

  private _beginBlockEdit(blockId: string, panel: vscode.WebviewPanel, session: DocumentSession): void {
    const state = this._editStates.get(panel);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_BEGIN_REQ] blockId=${blockId} mode=${state?.mode} readonly=${state?.readonly} active=${Boolean(state?.activeEdit)}`);
    if (!state || state.readonly || state.mode !== 'edit' || state.activeEdit) return;
    const block = session.findBlock(blockId);
    if (!block || !isEditableBlockKind(block.kind)) {
      this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_BEGIN_REJECT] blockId=${blockId} found=${Boolean(block)} kind=${block?.kind}`);
      panel.webview.postMessage({
        type: 'edit-error',
        payload: { blockId, message: 'このブロックは編集できません。' },
      } satisfies HostToWebview);
      return;
    }

    const document = session.document;
    const documentText = document.getText();
    const range = sourceRangeForLines(documentText, block.sourceStart, block.sourceEnd);
    const source = documentText.slice(range.startOffset, range.endOffset);
    state.activeEdit = {
      blockId,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      baseDocumentVersion: document.version,
      baseSourceHash: this._hashSource(source),
      originalSource: source,
      editorSource: source.replace(/\r\n|\r/g, '\n'),
      draft: source.replace(/\r\n|\r/g, '\n'),
      committing: false,
      externalChange: false,
    };
    const activeEdit = state.activeEdit;
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_BEGIN] ${JSON.stringify({
      blockId,
      version: document.version,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      sourceHash: activeEdit.baseSourceHash,
      originalBytes: Buffer.byteLength(source, 'utf8'),
    })}`);
    panel.webview.postMessage({
      type: 'edit-started',
      payload: { blockId, source: activeEdit.editorSource },
    } satisfies HostToWebview);
  }

  private _commitBlockEdit(
    blockId: string,
    markdown: string,
    panel: vscode.WebviewPanel,
    session: DocumentSession,
  ): Promise<boolean> {
    const state = this._editStates.get(panel);
    const activeEdit = state?.activeEdit;
    if (!state || !activeEdit || activeEdit.blockId !== blockId) return Promise.resolve(false);
    // A blur save racing mode exit or Cmd+S shares the same save result.
    if (activeEdit.commitInFlight) return activeEdit.commitInFlight;
    const run = this._applyBlockEdit(state, activeEdit, blockId, markdown, panel, session);
    activeEdit.commitInFlight = run;
    void run.finally(() => {
      if (state.activeEdit === activeEdit) activeEdit.commitInFlight = undefined;
    });
    return run;
  }

  private async _applyBlockEdit(
    state: PanelEditState,
    activeEdit: ActiveBlockEdit,
    blockId: string,
    markdown: string,
    panel: vscode.WebviewPanel,
    session: DocumentSession,
  ): Promise<boolean> {
    const commitStartedAt = performance.now();
    activeEdit.draft = markdown;

    const document = session.document;
    let range = { startOffset: activeEdit.startOffset, endOffset: activeEdit.endOffset };
    let currentSource = document.getText().slice(range.startOffset, range.endOffset);

    if (document.version !== activeEdit.baseDocumentVersion) {
      // Re-locate the block after external changes, including edits made
      // while the preview was hidden; uses a snapshot parse that does not
      // advance the session.
      const parsed = session.parseSnapshot(document);
      const located = findBlockSource(
        document.getText(),
        parsed.blocks,
        activeEdit.blockId,
        activeEdit.baseSourceHash,
        source => this._hashSource(source),
      );
      if (!located) {
        await this._showEditConflict(panel, state, session);
        return false;
      }
      range = located.range;
      currentSource = located.source;
    }

    if (this._hashSource(currentSource) !== activeEdit.baseSourceHash) {
      await this._showEditConflict(panel, state, session);
      return false;
    }

    if (markdown === activeEdit.editorSource) {
      this._finishBlockEdit(panel, state, 'saved');
      this._logEditSave({
        activeEdit,
        range,
        replacement: activeEdit.originalSource,
        applyEditMs: 0,
        commitMs: performance.now() - commitStartedAt,
        documentVersion: document.version,
        outsideEqual: true,
        beforeBytes: Buffer.byteLength(activeEdit.originalSource, 'utf8'),
        afterBytes: Buffer.byteLength(activeEdit.originalSource, 'utf8'),
        noOp: true,
      });
      return true;
    }

    if (state.readonly || await this._isDocumentReadonly(document)) {
      state.readonly = true;
      state.mode = 'read';
      this._finishBlockEdit(panel, state, 'discarded');
      this._postEditMode(panel, state);
      this._updateEditModeStatus();
      void vscode.window.showErrorMessage('このMarkdown文書は読み取り専用のため保存できません。');
      return false;
    }

    const beforeText = document.getText();
    const replacement = replacementForBlock(markdown, activeEdit.originalSource);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(range.startOffset), document.positionAt(range.endOffset)),
      replacement,
    );
    activeEdit.committing = true;
    const applyStartedAt = performance.now();
    let applied: boolean;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } catch (error) {
      activeEdit.committing = false;
      throw error;
    }
    const applyEditMs = performance.now() - applyStartedAt;
    if (!applied) {
      activeEdit.committing = false;
      // Even when WorkspaceEdit is rejected, re-check whether the document became read-only.
      if (!state.readonly && await this._isDocumentReadonly(document)) {
        state.readonly = true;
        state.mode = 'read';
        this._finishBlockEdit(panel, state, 'discarded');
        this._postEditMode(panel, state);
        this._updateEditModeStatus();
      }
      panel.webview.postMessage({
        type: 'edit-error',
        payload: { blockId, message: 'Markdownの変更を適用できませんでした。' },
      } satisfies HostToWebview);
      void vscode.window.showErrorMessage('Markdownの変更を適用できませんでした。');
      return false;
    }

    const afterText = document.getText();
    this._finishBlockEdit(panel, state, 'saved');
    this._logEditSave({
      activeEdit,
      range,
      replacement,
      applyEditMs,
      commitMs: performance.now() - commitStartedAt,
      documentVersion: document.version,
      outsideEqual: outsideRangeEqual(beforeText, afterText, range, replacement.length),
      beforeBytes: Buffer.byteLength(beforeText, 'utf8'),
      afterBytes: Buffer.byteLength(afterText, 'utf8'),
      noOp: false,
    });
    return true;
  }

  /**
   * Inserts new Markdown at a block boundary or the document end.
   * Anchor IDs are resolved against a fresh snapshot parse so stale
   * IDs left by external edits are rejected instead of misplacing text.
   */
  private async _insertMarkdown(
    payload: { beforeBlockId?: string; afterBlockId?: string; markdown: string },
    panel: vscode.WebviewPanel,
    session: DocumentSession,
  ): Promise<void> {
    const state = this._editStates.get(panel);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_INSERT_REQ] ${JSON.stringify({
      mode: state?.mode, readonly: state?.readonly,
      beforeBlockId: payload.beforeBlockId, afterBlockId: payload.afterBlockId,
      markdownLength: payload.markdown.length,
    })}`);
    if (!state || state.readonly || state.mode !== 'edit') return;
    if (!payload.markdown.trim()) return;

    const document = session.document;
    const parsed = session.parseSnapshot(document);
    const text = document.getText();

    const before = payload.beforeBlockId !== undefined
      ? parsed.blocks.find(block => block.id === payload.beforeBlockId)
      : undefined;
    const after = payload.afterBlockId !== undefined
      ? parsed.blocks.find(block => block.id === payload.afterBlockId)
      : undefined;
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_INSERT_ANCHOR] ${JSON.stringify({
      beforeBlockId: payload.beforeBlockId ?? null,
      afterBlockId: payload.afterBlockId ?? null,
      resolvedBefore: Boolean(before), resolvedAfter: Boolean(after),
      ids: parsed.blocks.slice(0, 8).map(block => block.id),
    })}`);
    if ((payload.beforeBlockId !== undefined && !before)
      || (payload.afterBlockId !== undefined && !after)) {
      void vscode.window.showWarningMessage(
        '挿入位置が外部変更で古くなったため、ブロックを挿入しませんでした。',
      );
      return;
    }
    // A gap anchor carries both neighbors; they must still be adjacent
    // in the fresh parse or an external edit moved the gap.
    if (before && after
      && parsed.blocks.indexOf(before) !== parsed.blocks.indexOf(after) + 1) {
      void vscode.window.showWarningMessage(
        '挿入位置が外部変更で古くなったため、ブロックを挿入しませんでした。',
      );
      return;
    }
    let offset: number;
    if (before) {
      offset = sourceRangeForLines(text, before.sourceStart, before.sourceEnd).startOffset;
    } else if (after) {
      offset = sourceRangeForLines(text, after.sourceStart, after.sourceEnd).endOffset;
    } else {
      offset = text.length;
    }

    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_INSERT] ${JSON.stringify({
      beforeBlockId: payload.beforeBlockId ?? null,
      afterBlockId: payload.afterBlockId ?? null,
      resolvedBefore: Boolean(before), resolvedAfter: Boolean(after),
      offset, blockCount: parsed.blocks.length,
    })}`);

    const insertion = insertionForGap(payload.markdown, text, offset, detectLineEnding(text));
    if (!insertion) return;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(offset), insertion);
    const applied = await vscode.workspace.applyEdit(edit);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_INSERT_APPLIED] applied=${applied}`);
  }

  private async _showEditConflict(
    panel: vscode.WebviewPanel,
    state: PanelEditState,
    session: DocumentSession,
  ): Promise<void> {
    const activeEdit = state.activeEdit;
    if (!activeEdit) return;
    const blockId = activeEdit.blockId;
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_CONFLICT] blockId=${blockId}`);
    void panel.webview.postMessage({
      type: 'edit-error',
      payload: { blockId, message: 'このブロックは編集中に外部で変更されました。' },
    } satisfies HostToWebview);
    const choice = await vscode.window.showWarningMessage(
      'このブロックは編集中に外部で変更されました。',
      '外部変更を表示',
      '編集を続ける',
    );
    if (choice !== '外部変更を表示') return;
    this._finishBlockEdit(panel, state, 'discarded');
    this._refreshBlock(panel, session, blockId);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_CONFLICT_KEEP_SOURCE] blockId=${blockId}`);
  }

  private _refreshBlock(
    panel: vscode.WebviewPanel,
    session: DocumentSession,
    blockId: string,
  ): void {
    const block = session.findBlock(blockId);
    if (!block) return;
    void panel.webview.postMessage({
      type: 'refresh-block',
      payload: { blockId, html: wrapBlock(block) },
    } satisfies HostToWebview);
  }

  private _logEditSave(entry: {
    activeEdit: ActiveBlockEdit;
    range: { startOffset: number; endOffset: number };
    replacement: string;
    applyEditMs: number;
    commitMs: number;
    documentVersion: number;
    outsideEqual: boolean;
    beforeBytes: number;
    afterBytes: number;
    noOp: boolean;
  }): void {
    const { activeEdit } = entry;
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_SAVE] ${JSON.stringify({
      blockId: activeEdit.blockId,
      baseVersion: activeEdit.baseDocumentVersion,
      documentVersion: entry.documentVersion,
      startOffset: entry.range.startOffset,
      endOffset: entry.range.endOffset,
      baseSourceHash: activeEdit.baseSourceHash,
      originalBytes: Buffer.byteLength(activeEdit.originalSource, 'utf8'),
      replacementBytes: Buffer.byteLength(entry.replacement, 'utf8'),
      beforeBytes: entry.beforeBytes,
      afterBytes: entry.afterBytes,
      applyEditMs: +entry.applyEditMs.toFixed(3),
      commitMs: +entry.commitMs.toFixed(3),
      outsideRangeEqual: entry.outsideEqual,
      noOp: entry.noOp,
    })}`);
  }

  private _logEditMode(mode: 'read' | 'edit', ms: number): void {
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_MODE] ${JSON.stringify({
      mode,
      ms: +ms.toFixed(3),
    })}`);
  }

  private _finishBlockEdit(
    panel: vscode.WebviewPanel,
    state: PanelEditState,
    outcome: 'saved' | 'discarded',
  ): void {
    const activeEdit = state.activeEdit;
    if (!activeEdit) return;
    state.activeEdit = undefined;
    panel.webview.postMessage({
      type: 'edit-finished',
      payload: { blockId: activeEdit.blockId, outcome },
    } satisfies HostToWebview);
  }

  private _requestEditDraft(panel: vscode.WebviewPanel, edit: ActiveBlockEdit): Promise<string> {
    return this._postRequest<string, PendingDraftRequest>(
      panel,
      this._pendingDraftRequests,
      (_requestId, resolve, reject, timer) => ({ panel, blockId: edit.blockId, resolve, reject, timer }),
      requestId => ({
        type: 'query-edit-draft',
        payload: { requestId, blockId: edit.blockId },
      }),
      10_000,
      'Timed out waiting for the active Markdown draft',
      'Could not request the active Markdown draft',
      '[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_EDIT_DRAFT_QUERY]',
    );
  }

  private _postEditMode(panel: vscode.WebviewPanel, state: PanelEditState): void {
    panel.webview.postMessage({
      type: 'edit-mode',
      payload: { mode: state.readonly ? 'readonly' : state.mode },
    } satisfies HostToWebview);
  }

  private _updateEditModeStatus(): void {
    const panel = this._activePanel;
    const state = panel && this._editStates.get(panel);
    if (!panel || !state || !panel.active || !panel.visible) {
      this._editModeStatus.hide();
      this._readonlyStatus.hide();
      return;
    }

    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_MODE] ${JSON.stringify({
      mode: state.readonly ? 'readonly' : state.mode,
      readonly: state.readonly,
      visible: panel.visible,
    })}`);

    if (state.readonly) {
      this._editModeStatus.hide();
      this._readonlyStatus.show();
      return;
    }

    this._readonlyStatus.hide();
    this._editModeStatus.show();
    const modeLabel = state.mode === 'edit' ? 'Markdown: 編集' : 'Markdown: 読み取り';
    if (state.mode === 'edit') {
      this._editModeStatus.text = '$(edit)';
      this._editModeStatus.tooltip = `${modeLabel} — クリックで読み取りモードへ切り替えます`;
    } else {
      this._editModeStatus.text = '$(eye)';
      this._editModeStatus.tooltip = `${modeLabel} — クリックで編集モードへ切り替えます`;
    }
    this._editModeStatus.accessibilityInformation = {
      label: modeLabel,
      role: 'button',
    };
    this._editModeStatus.command = 'markdownSourcePreview.toggleEditMode';
  }

  private async _isDocumentReadonly(document: vscode.TextDocument): Promise<boolean> {
    const result = await detectReadonly(document.uri);
    this._logDiagnostics(`[MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_READONLY] ${JSON.stringify({
      uri: document.uri.toString(),
      scheme: document.uri.scheme,
      readonly: result.readonly,
      reason: result.reason,
      mode: result.mode,
    })}`);
    return result.readonly;
  }

  private _hashSource(source: string): string {
    return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  }

  private _sendRestBlocks(panel: vscode.WebviewPanel, session: DocumentSession): void {
    const doc = session.latestParsed;
    const restBlocks = session.restBlocks;
    if (!doc || !restBlocks.length) return;

    const patches: BlockPatch[] = restBlocks.map(b => ({
      op: 'insert' as const,
      blockId: b.id,
      html: wrapBlock(b),
      contentHash: b.contentHash,
    }));

    const patchMsg: HostToWebview = {
      type: 'patch',
      payload: {
        generation: doc.generation,
        patches,
      },
    };
    panel.webview.postMessage(patchMsg);
  }


  private async _handleDocumentChange(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    session: DocumentSession,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    hostChangeReceivedEpochMs: number,
    debounceMs: number,
  ): Promise<void> {
    if (session.disposed) return;
    const prepared = session.prepareUpdate(document, changes);
    const gen = prepared.message.payload.generation;
    const pendingPatches = this._pendingPatches.get(session);

    // Drop stale pending patches when advancing generations so no patch is left waiting for an ack.
    if (pendingPatches) {
      for (const pendingGeneration of pendingPatches.keys()) {
        if (pendingGeneration < gen) pendingPatches.delete(pendingGeneration);
      }
    }

    const timings = prepared.timings;
    let sentAt = 0;
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && timings) {
      // Register right before postMessage; setting it earlier avoids missing very fast acks.
      const hostPatchSentEpochMs = Date.now();
      sentAt = performance.now();
      let patches = pendingPatches;
      if (!patches) {
        patches = new Map();
        this._pendingPatches.set(session, patches);
      }
      patches.set(gen, {
        sentAt,
        timings,
        blockIds: prepared.message.payload.patches.map(patch => patch.blockId),
        hostChangeReceivedEpochMs,
        debounceMs,
        hostPatchSentEpochMs,
      });
    }

    await panel.webview.postMessage(prepared.message);

    if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && timings) {
      timings.postMessageMs = +(performance.now() - sentAt).toFixed(1);
      console.log(
        `[MARKDOWN_SOURCE_PREVIEW_PERF] update-profile gen=${gen}` +
        ` hostPrepareMs=${timings.hostPrepareMs} getTextMs=${timings.getTextMs} parseMs=${timings.parseMs}` +
        ` buildBlocksMs=${timings.buildBlocksMs} diffMs=${timings.diffMs}` +
        ` serializeMs=${timings.serializeEstimateMs} postMessageMs=${timings.postMessageMs}` +
        ` changed=${timings.changedBlockCount} insert=${timings.insertedBlockCount} delete=${timings.deletedBlockCount}` +
        ` bytes=${timings.messageBytes} mode=${timings.updateMode}` +
        ` window=${timings.changeStartLine ?? '-'}..${timings.changeEndLine ?? '-'}` +
        (timings.fallbackReason ? ` fallback=${timings.fallbackReason}` : ''),
      );
    }
  }

  private _logDiagnostics(message: string): void {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__ || process.env.MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS !== '1') return;
    console.log(message);
    const logPath = process.env.MARKDOWN_SOURCE_PREVIEW_DIAGNOSTICS_LOG;
    if (logPath) fs.appendFileSync(logPath, `${message}\n`, 'utf8');
  }

  private _settlePendingRequest<T extends PendingRequest>(
    requests: Map<string, T>,
    requestId: string,
    error: unknown,
  ): void {
    const pending = requests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    requests.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private _rejectPending<T extends PendingRequest>(
    requests: Map<string, T>,
    matches: (request: T) => boolean,
    message: string,
  ): void {
    for (const [requestId, request] of requests) {
      if (matches(request)) this._settlePendingRequest(requests, requestId, new Error(message));
    }
  }

  private _postRequest<T, P extends PendingResponse<T>>(
    panel: vscode.WebviewPanel,
    requests: Map<string, P>,
    createEntry: (
      requestId: string,
      resolve: (value: T) => void,
      reject: (error: Error) => void,
      timer: ReturnType<typeof setTimeout>,
    ) => P,
    message: (requestId: string) => HostToWebview,
    timeoutMs: number,
    timeoutMessage: string,
    postFailureMessage: string,
    logLabel?: string,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      requests.set(requestId, createEntry(requestId, resolve, reject, timer));
      panel.webview.postMessage(message(requestId)).then(
        posted => {
          if (logLabel) {
            this._logDiagnostics(`${logLabel} requestId=${requestId} posted=${posted}`);
          }
          if (!posted) this._settlePendingRequest(requests, requestId, new Error(postFailureMessage));
        },
        error => this._settlePendingRequest(requests, requestId, error),
      );
    });
  }

  private _pendingPatchCount(session: DocumentSession): number {
    return this._pendingPatches.get(session)?.size ?? 0;
  }

  private _deletePendingPatches(session: DocumentSession): void {
    this._pendingPatches.delete(session);
  }


  private _buildWebviewHtml(webview: vscode.Webview, initialHtml: string): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._ctx.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._ctx.extensionUri, 'media', 'preview.css'),
    );

    // CSP: script-src allows only the nonce and webview.js
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escAttr(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escAttr(styleUri.toString())}">
  <title>Markdown Source Preview</title>
</head>
<body>
  <!-- MARKDOWN_SOURCE_PREVIEW_PERF marker: initial HTML injected by extension host -->
  <div id="markdown-source-preview-root" class="markdown-body">
${initialHtml}
  </div>
  <script type="module" nonce="${nonce}" src="${escAttr(scriptUri.toString())}"></script>
</body>
</html>`;
  }


  private _getConfig() {
    const cfg = vscode.workspace.getConfiguration('markdownSourcePreview');
    return {
      initialBlockLimit: cfg.get<number>('initialBlockLimit', 40),
      initialHtmlCharLimit: cfg.get<number>('initialHtmlCharLimit', 98304),
      debounceMs: cfg.get<number>('debounceMs', 16),
    };
  }
}
