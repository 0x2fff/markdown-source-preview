/**
 * Mermaid is loaded when a diagram approaches the viewport, and rendering
 * starts once the diagram enters a render-ahead margin around the viewport.
 * Render jobs are serialized to avoid long main-thread tasks.
 */

import mermaidPackage from 'mermaid/package.json';
import { MERMAID_SECURITY_LEVEL, mermaidSvgCacheKey } from './mermaidSecurity.js';
import { MERMAID_MINDMAP_THEME_CSS, mermaidPalette } from './mermaidTheme.js';

const RENDER_AHEAD_PX = 1200;
const MAX_CONCURRENT = 2;
const PLACEHOLDER_MIN_HEIGHT = 120;
const MAX_CACHE_ENTRIES = 128;
const RENDER_IDLE_TIMEOUT_MS = 1000;
const MERMAID_VERSION = mermaidPackage.version;
// Separate schema so stale placeholder SVGs are not served from cache when icon packs change
const ICON_PACK_SCHEMA = 'icons-v1';

type MermaidApi = typeof import('mermaid').default;

let _iconPacksRegistered = false;

/**
 * Registers bundled icon packs once. Loader-based: JSON is fetched only
 * when a diagram actually references `logos:` etc. (lazy, offline-safe).
 */
function ensureBuiltInIconPacks(api: MermaidApi): void {
  if (_iconPacksRegistered) return;
  _iconPacksRegistered = true;
  api.registerIconPacks([
    {
      name: 'logos',
      loader: () => import('@iconify-json/logos').then(m => m.icons),
    },
  ]);
}

interface MermaidBlockRecord {
  id: number;
  observedMs: number;
  enqueuedMs: number | null;
  visibleAtEnqueue: boolean | null;
  renderStartedMs: number | null;
  renderedMs: number | null;
  deferredCount: number;
}

interface MermaidTelemetry {
  currentConcurrent: number;
  maxConcurrent: number;
  renderedCount: number;
  renderedOutsideViewportCount: number;
  offscreenDeferredCount: number;
  firstEnqueuedEpochMs: number | null;
  moduleReadyEpochMs: number | null;
  firstRenderStartedEpochMs: number | null;
  firstRenderCompletedEpochMs: number | null;
  cacheHitCount: number;
  errorCount: number;
  queueLength: number;
  blocks: MermaidBlockRecord[];
}

type MermaidWindow = Window & { __MARKDOWN_SOURCE_PREVIEW_MERMAID__?: MermaidTelemetry };

interface RenderJob {
  element: HTMLElement;
  source: string;
  record?: MermaidBlockRecord;
}

interface MermaidTheme {
  key: string;
  config: Record<string, unknown>;
}

const svgCache = new Map<string, string>();
let nextRenderId = 0;

export class MermaidQueue {
  private _root: HTMLElement | null = null;
  private _mermaidPromise: Promise<MermaidApi> | null = null;
  private _viewportObserver: IntersectionObserver | null = null;
  private _mutationObserver: MutationObserver | null = null;
  private _themeObserver: MutationObserver | null = null;
  private _visibleJobs: RenderJob[] = [];
  private _aheadJobs: RenderJob[] = [];
  private _queued = new WeakSet<HTMLElement>();
  private _pendingMargin = new Set<HTMLElement>();
  private _sweepFrame: number | undefined;
  private _onScrollOrResize = () => this._scheduleMarginSweep();
  private _blockRecords: MermaidBlockRecord[] = [];
  private _blockRecordByElement = new WeakMap<HTMLElement, MermaidBlockRecord>();
  private _nextBlockId = 0;
  private _renderedSources = new WeakMap<HTMLElement, string>();
  private _initializedThemeKey: string | undefined;
  private _activeRenders = 0;
  private _idleHandle: number | null = null;
  private _drainTimer: number | null = null;
  private _disposed = false;
  private _telemetry: MermaidTelemetry | undefined = __MARKDOWN_SOURCE_PREVIEW_LAB__
    ? {
      currentConcurrent: 0,
      maxConcurrent: 0,
      renderedCount: 0,
      renderedOutsideViewportCount: 0,
      offscreenDeferredCount: 0,
      firstEnqueuedEpochMs: null,
      moduleReadyEpochMs: null,
      firstRenderStartedEpochMs: null,
      firstRenderCompletedEpochMs: null,
      cacheHitCount: 0,
      errorCount: 0,
      queueLength: 0,
      blocks: this._blockRecords,
    }
    : undefined;

  preload(): void {
    void this._loadMermaid().catch(error => {
      console.error(`[Markdown Source Preview] Mermaid module preload failed: ${String(error)}`);
    });
  }

  attach(root: HTMLElement): void {
    this._detach();
    this._disposed = false;
    this._root = root;
    this._publishTelemetry();

    this._viewportObserver = new IntersectionObserver(
      entries => this._onViewport(entries),
      { rootMargin: '0px' },
    );

    this._mutationObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) this._observeSubtree(node);
        }
      }
      this._scheduleMarginSweep();
    });
    this._mutationObserver.observe(root, { childList: true, subtree: true });
    // capture:true on document catches scrolls of any inner container, not
    // just window scroll — jump-to-bottom must reach the sweep immediately.
    document.addEventListener('scroll', this._onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', this._onScrollOrResize, { passive: true });

    this._themeObserver = new MutationObserver(() => this._observeExisting(root));
    for (const element of [document.documentElement, document.body]) {
      this._themeObserver.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'data-vscode-theme-kind', 'style'],
      });
    }

    this._observeExisting(root);
  }

  dispose(): void {
    this._disposed = true;
    this._detach();
    this._mermaidPromise = null;
  }

  get cleanupState(): {
    disposed: boolean;
    observersDisconnected: boolean;
    pendingIdleCallbacks: number;
    pendingJobs: number;
    activeRenders: number;
  } {
    return {
      disposed: this._disposed,
      observersDisconnected: this._viewportObserver === null
        && this._mutationObserver === null
        && this._themeObserver === null,
      pendingIdleCallbacks: (this._idleHandle === null ? 0 : 1)
        + (this._drainTimer === null ? 0 : 1),
      pendingJobs: this._visibleJobs.length + this._aheadJobs.length,
      activeRenders: this._activeRenders,
    };
  }

  private _observeExisting(root: HTMLElement): void {
    const themeKey = this._theme().key;
    for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
      this._observeDiagram(code, undefined, themeKey);
    }
    for (const output of root.querySelectorAll<HTMLElement>('[data-mermaid="true"]')) {
      this._refreshOutput(output, themeKey);
    }
    // Theme attribute mutations do not trigger the childList observer, so
    // schedule a sweep explicitly: stale outputs that landed in
    // _pendingMargin during this pass get promoted on the next frame.
    this._scheduleMarginSweep();
  }

  private _observeSubtree(node: HTMLElement): void {
    const themeKey = this._theme().key;
    if (node.matches('pre > code.language-mermaid')) {
      this._observeDiagram(node, undefined, themeKey);
    } else if (node.matches('[data-mermaid="true"]')) {
      this._refreshOutput(node, themeKey);
    }
    for (const code of node.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
      this._observeDiagram(code, undefined, themeKey);
    }
    for (const output of node.querySelectorAll<HTMLElement>('[data-mermaid="true"]')) {
      this._refreshOutput(output, themeKey);
    }
  }

  private _refreshOutput(output: HTMLElement, themeKey: string): void {
    const source = this._renderedSources.get(output);
    if (source && output.dataset.mermaidThemeKey !== themeKey) {
      output.dataset.mermaidState = 'stale';
      this._observeDiagram(output, source, themeKey);
    }
  }

  private _observeDiagram(element: HTMLElement, knownSource?: string, themeKey = this._theme().key): void {
    if (!this._viewportObserver || !this._root?.contains(element)) return;
    const isOutput = element.dataset.mermaid === 'true';
    if (isOutput && element.dataset.mermaidThemeKey === themeKey) return;
    if (!isOutput && element.dataset.mermaidState && element.dataset.mermaidState !== 'pending') return;

    const source = knownSource ?? (isOutput ? this._renderedSources.get(element) : element.textContent) ?? '';
    if (!source.trim()) {
      element.dataset.mermaidState = 'skip';
      return;
    }
    this._renderedSources.set(element, source);
    this._blockRecord(element);

    const placeholder = isOutput ? element : element.parentElement;
    if (placeholder) {
      placeholder.dataset.mermaidState = isOutput ? 'stale' : 'pending';
      placeholder.style.minHeight = `${PLACEHOLDER_MIN_HEIGHT}px`;
    }
    // Already in the viewport (initial slice or a zoomed-out pane): enqueue
    // synchronously instead of waiting for the next IntersectionObserver
    // notification round-trip. IntersectionObserver rootMargin is clipped
    // by the webview scroll container in this environment, so the render-ahead
    // margin is checked here in JS; far elements stay on the observer.
    if (this._isInViewport(element)) {
      this._enqueue(element);
      return;
    }
    if (this._isWithinRenderMargin(element)) {
      this._enqueue(element);
      return;
    }
    this._pendingMargin.add(element);
    this._viewportObserver.observe(element);
  }

  private _enqueue(element: HTMLElement): void {
    if (this._queued.has(element)) return;
    const source = this._renderedSources.get(element)
      ?? (this._isOutput(element) ? '' : element.textContent ?? '');
    if (!source.trim()) return;

    const telemetry = this._telemetry;
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry && telemetry.firstEnqueuedEpochMs === null) {
      telemetry.firstEnqueuedEpochMs = Date.now();
    }
    const record = this._blockRecord(element);
    const visibleAtEnqueue = this._isInViewport(element);
    if (record) {
      if (record.enqueuedMs === null) record.enqueuedMs = Date.now();
      record.visibleAtEnqueue = visibleAtEnqueue;
    }
    this._pendingMargin.delete(element);
    this._queued.add(element);
    element.dataset.mermaidState = 'queued';
    const job = { element, source, record };
    if (visibleAtEnqueue) this._visibleJobs.push(job);
    else this._aheadJobs.push(job);
    this._publishTelemetry();
    this._scheduleDrain();
  }

  // An ahead job that scrolls into the true viewport jumps ahead of the
  // remaining ahead jobs so visible diagrams never wait behind them.
  private _promoteQueued(element: HTMLElement): void {
    const index = this._aheadJobs.findIndex(job => job.element === element);
    if (index < 0) return;
    const [job] = this._aheadJobs.splice(index, 1);
    this._visibleJobs.push(job);
  }

  private _blockRecord(element: HTMLElement): MermaidBlockRecord | undefined {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) return undefined;
    let record = this._blockRecordByElement.get(element);
    if (!record) {
      record = {
        id: ++this._nextBlockId,
        observedMs: Date.now(),
        enqueuedMs: null,
        visibleAtEnqueue: null,
        renderStartedMs: null,
        renderedMs: null,
        deferredCount: 0,
      };
      this._blockRecordByElement.set(element, record);
      this._blockRecords.push(record);
    }
    return record;
  }

  private _onViewport(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      if (!entry.isIntersecting) continue;
      this._viewportObserver?.unobserve(element);
      this._pendingMargin.delete(element);
      if (this._isInViewport(element)) {
        this._promoteQueued(element);
        this._scheduleDrain();
      }
      this._enqueue(element);
    }
  }

  private _scheduleDrain(): void {
    if (
      this._disposed
      || this._activeRenders >= MAX_CONCURRENT
      || (this._visibleJobs.length === 0 && this._aheadJobs.length === 0)
    ) return;
    if (this._visibleJobs.length > 0) {
      // Visible work drains on the next task — never behind an idle wait.
      if (this._drainTimer === null) {
        this._drainTimer = window.setTimeout(() => {
          this._drainTimer = null;
          void this._drainOne();
        }, 0);
      }
      return;
    }
    // Ahead-only drains keep the generous idle timeout so background renders
    // yield to scrolling.
    if (this._idleHandle !== null || this._drainTimer !== null) return;
    this._idleHandle = requestIdleCallback(() => {
      this._idleHandle = null;
      void this._drainOne();
    }, { timeout: RENDER_IDLE_TIMEOUT_MS });
  }

  private async _drainOne(): Promise<void> {
    if (this._disposed || this._activeRenders >= MAX_CONCURRENT
      || (this._visibleJobs.length === 0 && this._aheadJobs.length === 0)) return;
    const job = this._visibleJobs.shift() ?? this._aheadJobs.shift();
    if (!job) return;
    this._queued.delete(job.element);

    if (!this._root?.contains(job.element)) {
      this._advance();
      return;
    }
    if (!this._isWithinRenderMargin(job.element)) {
      this._deferUntilVisible(job.element);
      this._advance();
      return;
    }

    this._activeRenders++;
    const telemetry = this._telemetry;
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry) {
      telemetry.currentConcurrent = this._activeRenders;
      telemetry.maxConcurrent = Math.max(telemetry.maxConcurrent, this._activeRenders);
    }
    job.element.dataset.mermaidState = 'rendering';
    if (job.record && job.record.renderStartedMs === null) {
      job.record.renderStartedMs = Date.now();
    }
    this._publishTelemetry();
    // Fill the remaining concurrency slot so a second diagram can start
    // while this one renders.
    this._scheduleDrain();

    try {
      await this._render(job);
    } finally {
      this._activeRenders--;
      if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry) telemetry.currentConcurrent = this._activeRenders;
      this._advance();
    }
  }

  private _advance(): void {
    this._publishTelemetry();
    this._scheduleDrain();
  }

  private _deferUntilVisible(element: HTMLElement): void {
    element.dataset.mermaidState = this._isOutput(element) ? 'stale' : 'pending';
    if (__MARKDOWN_SOURCE_PREVIEW_LAB__) {
      const record = this._blockRecordByElement.get(element);
      if (record) record.deferredCount++;
    }
    this._pendingMargin.add(element);
    this._viewportObserver?.observe(element);
  }

  // IO rootMargin does not expand intersections inside the VS Code webview
  // (verified: even 10000px yields an empty intersectionRect), so the
  // render-ahead margin is swept in JS on scroll/resize/DOM mutations.
  private _scheduleMarginSweep(): void {
    if (this._sweepFrame !== undefined || this._disposed) return;
    this._sweepFrame = requestAnimationFrame(() => {
      this._sweepFrame = undefined;
      if (this._disposed || !this._root) return;
      for (const element of [...this._pendingMargin]) {
        if (!this._root.contains(element)) {
          this._pendingMargin.delete(element);
          continue;
        }
        if (this._isWithinRenderMargin(element)) {
          this._pendingMargin.delete(element);
          this._viewportObserver?.unobserve(element);
          this._enqueue(element);
        }
      }
      // Ahead jobs that scrolled into the true viewport jump the queue.
      // IntersectionObserver notifications are unreliable inside the VS Code
      // webview scroll container, so promotion is checked here in JS.
      for (const job of [...this._aheadJobs]) {
        if (this._root.contains(job.element) && this._isInViewport(job.element)) {
          this._promoteQueued(job.element);
        }
      }
      // Self-heal stale rendered outputs (e.g. left behind by a theme
      // change while outside the render margin): anything within the
      // margin is re-observed so it re-renders with the current theme.
      // _observeDiagram early-returns when the stored theme key already
      // matches, so current-theme outputs are untouched.
      for (const output of this._root.querySelectorAll<HTMLElement>('[data-mermaid="true"]')) {
        if (output.dataset.mermaidState === 'stale' && this._isWithinRenderMargin(output)) {
          this._observeDiagram(output, undefined);
        }
      }
      this._scheduleDrain();
    });
  }

  private _isOutput(element: HTMLElement): boolean {
    return element.dataset.mermaid === 'true';
  }

  private async _render(job: RenderJob): Promise<void> {
    const { element, source } = job;
    try {
      const mermaid = await this._loadMermaid();
      if (this._disposed) return;
      const telemetry = this._telemetry;
      if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry && telemetry.firstRenderStartedEpochMs === null) {
        telemetry.firstRenderStartedEpochMs = Date.now();
      }
      const theme = this._theme();
      const sourceHash = await sha256(source);
      if (this._disposed) return;
      const diagramType = mermaidDiagramType(source);
      const cacheKey = mermaidSvgCacheKey(
        `${ICON_PACK_SCHEMA}::${MERMAID_VERSION}`,
        MERMAID_SECURITY_LEVEL,
        theme.key,
        sourceHash,
      );
      const existingOutput = this._isOutput(element);

      let svgTemplate = this._getCachedSvg(cacheKey);
      if (svgTemplate) {
        if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry) telemetry.cacheHitCount++;
      } else {
        // Only a zero-width measurement (pane still laying out) is worth
        // waiting on; a valid width renders immediately.
        await waitForStableLayout(element);
        if (this._disposed || !this._root?.contains(element)) return;
        // The pane may have been scrolled or resized while waiting for
        // layout; never start an expensive render far outside the
        // render-ahead margin.
        if (!this._isWithinRenderMargin(element)) {
          this._deferUntilVisible(element);
          if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry) telemetry.offscreenDeferredCount++;
          this._publishTelemetry();
          return;
        }
        this._ensureInitialized(mermaid, theme);
        if (source.includes('logos:')) ensureBuiltInIconPacks(mermaid);
        const renderId = `markdown-source-preview-mermaid-${++nextRenderId}`;
        const result = await mermaid.render(renderId, source);
        if (this._disposed || !this._root?.contains(element)) return;
        svgTemplate = result.svg.replaceAll(renderId, '__MARKDOWN_SOURCE_PREVIEW_MERMAID_ID__');
        this._cacheSvg(cacheKey, svgTemplate);
      }

      if (this._disposed || !this._root?.contains(element)) return;
      const svg = svgTemplate.replaceAll(
        '__MARKDOWN_SOURCE_PREVIEW_MERMAID_ID__',
        `markdown-source-preview-mermaid-${++nextRenderId}`,
      );
      let output: HTMLElement;
      if (existingOutput) {
        output = element;
      } else {
        output = document.createElement('div');
        output.className = 'mermaid-output';
        output.dataset.mermaid = 'true';
        element.parentElement?.replaceWith(output);
        if (!output.isConnected) throw new Error('Mermaid source block was detached before render completed');
      }

      output.innerHTML = svg;
      output.dataset.mermaid = 'true';
      output.dataset.mermaidState = 'rendered';
      output.dataset.mermaidSourceHash = sourceHash;
      output.dataset.mermaidThemeKey = theme.key;
      output.dataset.mermaidCacheKey = cacheKey;
      output.dataset.diagramType = diagramType;
      output.style.minHeight = '';
      this._renderedSources.set(output, source);
      // SVG replacement changes block heights; re-sweep so diagrams that
      // moved into the viewport or render margin are promoted promptly.
      this._scheduleMarginSweep();
      if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry) {
        if (!this._isInViewport(output)) telemetry.renderedOutsideViewportCount++;
        if (telemetry.firstRenderCompletedEpochMs === null) {
          telemetry.firstRenderCompletedEpochMs = Date.now();
        }
        telemetry.renderedCount++;
      }
      if (job.record) job.record.renderedMs = Date.now();
    } catch (error) {
      if (this._disposed || !this._root?.contains(element)) return;
      if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && this._telemetry) this._telemetry.errorCount++;
      element.dataset.mermaidState = 'error';
      const placeholder = this._isOutput(element) ? element : element.parentElement;
      if (placeholder) {
        placeholder.dataset.mermaidState = 'error';
        const errorElement = document.createElement('div');
        errorElement.className = 'mermaid-error';
        errorElement.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`;
        placeholder.appendChild(errorElement);
      }
      console.error(`[Markdown Source Preview] Mermaid diagram render failed: ${String(error)}`);
    }
  }

  /**
   * Renders an arbitrary Mermaid source for the editing preview pane.
   * Bypasses the FIFO queue; callers must discard stale results themselves
   * (e.g. with a generation counter).
   */
  async renderSource(source: string): Promise<{ svg: string }> {
    const mermaid = await this._loadMermaid();
    if (this._disposed) throw new Error('Mermaid queue disposed');
    const theme = this._theme();
    this._ensureInitialized(mermaid, theme);
    if (source.includes('logos:')) ensureBuiltInIconPacks(mermaid);
    const renderId = `markdown-source-preview-mermaid-draft-${++nextRenderId}`;
    const result = await mermaid.render(renderId, source);
    return {
      svg: result.svg.replaceAll(
        renderId,
        `markdown-source-preview-mermaid-${++nextRenderId}`,
      ),
    };
  }

  private _getCachedSvg(key: string): string | undefined {
    const svg = svgCache.get(key);
    if (svg === undefined) return undefined;
    svgCache.delete(key);
    svgCache.set(key, svg);
    return svg;
  }

  private _cacheSvg(key: string, svg: string): void {
    svgCache.delete(key);
    svgCache.set(key, svg);
    if (svgCache.size > MAX_CACHE_ENTRIES) {
      const oldest = svgCache.keys().next().value;
      if (oldest !== undefined) svgCache.delete(oldest);
    }
  }

  private _ensureInitialized(api: MermaidApi, theme: MermaidTheme): void {
    if (this._initializedThemeKey === theme.key) return;
    api.initialize(theme.config);
    this._initializedThemeKey = theme.key;
  }

  private _loadMermaid(): Promise<MermaidApi> {
    if (!this._mermaidPromise) {
      this._mermaidPromise = import('mermaid').then((module) => {
        const telemetry = this._telemetry;
        if (__MARKDOWN_SOURCE_PREVIEW_LAB__ && telemetry && telemetry.moduleReadyEpochMs === null) {
          telemetry.moduleReadyEpochMs = Date.now();
        }
        return module.default;
      });
    }
    return this._mermaidPromise;
  }

  private _theme(): MermaidTheme {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const read = (name: string, fallback: string): string =>
      rootStyle.getPropertyValue(name).trim()
      || bodyStyle.getPropertyValue(name).trim()
      || fallback;

    const dark = document.body.classList.contains('vscode-dark');
    const palette = mermaidPalette(dark ? 'dark' : 'light');
    const background = read('--vscode-editor-background', palette.mainBkg);
    const foreground = read('--vscode-editor-foreground', palette.textColor);
    // panel-border is a decorative separator and often nearly invisible;
    // diagram strokes need the stronger contrast/group border instead.
    const border = read('--vscode-contrastBorder', '')
      || read('--vscode-editorGroup-border', palette.nodeBorder);
    const sidebar = read('--vscode-sideBar-background', palette.secondaryColor);

    // Surface roles follow the VS Code theme; categorical/note/git/gantt/pie
    // colors stay on the fixed GitHub-inspired palette.
    const themeVariables = {
      ...palette,
      background,
      // Node/box fills track mainBkg; pin it to the actor color so every
      // diagram's rectangles match sequenceDiagram actor boxes.
      mainBkg: palette.actorBkg,
      edgeLabelBackground: background,
      textColor: foreground,
      titleColor: foreground,
      // Edge/arrow strokes use the fixed palette: VS Code border variables
      // range from near-black to nearly invisible depending on the theme.
      lineColor: palette.lineColor,
      nodeBorder: border,
      clusterBorder: border,
      secondaryBorderColor: border,
      clusterBkg: sidebar,
      secondaryColor: sidebar,
    };
    const themeConfig = {
      startOnLoad: false,
      theme: 'base',
      darkMode: dark,
      themeVariables,
      themeCSS: MERMAID_MINDMAP_THEME_CSS,
      securityLevel: MERMAID_SECURITY_LEVEL,
      suppressErrorRendering: true,
    };
    return { key: JSON.stringify(themeVariables), config: themeConfig };
  }

  private _isInViewport(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  private _isWithinRenderMargin(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && rect.bottom > -RENDER_AHEAD_PX && rect.right > 0
      && rect.top < window.innerHeight + RENDER_AHEAD_PX
      && rect.left < window.innerWidth;
  }

  private _publishTelemetry(): void {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) return;
    const telemetry = this._telemetry;
    if (!telemetry) return;
    telemetry.queueLength = this._visibleJobs.length + this._aheadJobs.length;
    (window as MermaidWindow).__MARKDOWN_SOURCE_PREVIEW_MERMAID__ = { ...telemetry };
  }

  private _detach(): void {
    this._viewportObserver?.disconnect();
    this._mutationObserver?.disconnect();
    this._themeObserver?.disconnect();
    this._viewportObserver = null;
    this._mutationObserver = null;
    this._themeObserver = null;
    document.removeEventListener('scroll', this._onScrollOrResize, { capture: true });
    window.removeEventListener('resize', this._onScrollOrResize);
    this._pendingMargin.clear();
    if (this._sweepFrame !== undefined) {
      cancelAnimationFrame(this._sweepFrame);
      this._sweepFrame = undefined;
    }
    if (this._idleHandle !== null) {
      cancelIdleCallback(this._idleHandle);
      this._idleHandle = null;
    }
    if (this._drainTimer !== null) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    this._visibleJobs = [];
    this._aheadJobs = [];
    this._queued = new WeakSet<HTMLElement>();
    this._root = null;
  }
}

function mermaidDiagramType(source: string): string {
  const body = source.replace(/^---[\s\S]*?---\s*/, '');
  return body.trimStart().match(/^([A-Za-z][\w-]*)/)?.[1]?.toLowerCase() ?? 'unknown';
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForStableLayout(element: HTMLElement): Promise<void> {
  if (element.getBoundingClientRect().width > 0) return;
  await nextFrame();
  if (element.getBoundingClientRect().width > 0) return;
  await nextFrame();
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function requestIdleCallback(callback: IdleRequestCallback, options: IdleRequestOptions): number {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    Math.min(16, options.timeout ?? RENDER_IDLE_TIMEOUT_MS),
  );
}

function cancelIdleCallback(handle: number): void {
  if (typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
  } else {
    clearTimeout(handle);
  }
}
