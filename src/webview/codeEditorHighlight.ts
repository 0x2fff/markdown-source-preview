/**
 * Syntax highlight layer for fence/code_block edit islands. The
 * textarea is never replaced: highlight.js output is overlaid on a
 * background <pre><code> while caret/selection/IME/undo stay native.
 *
 * - highlight.js/lib/common is lazy-imported, off the first-paint path
 * - re-renders are debounced per input
 * - falls back to plain text above 100,000 characters
 * - never uses highlightAuto (too costly on large inputs)
 */

type Hljs = {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
};

const MAX_LIVE_HIGHLIGHT_CHARS = 100_000;
const LARGE_SOURCE_THRESHOLD = 50_000;
const DEBOUNCE_MS = 50;
const LARGE_DEBOUNCE_MS = 100;

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  md: 'markdown',
};

export function isCodeHighlightKind(kind: string): boolean {
  return kind === 'fence' || kind === 'code_block';
}

export function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const key = language.trim().toLowerCase();
  if (!key) return undefined;
  return LANGUAGE_ALIASES[key] ?? key;
}

/** Extracts the language name from a fence info string. */
export function parseFenceLanguage(source: string): string | undefined {
  const match = source.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)/);
  if (!match) return undefined;
  const first = match[2].trim().split(/\s+/)[0];
  return normalizeLanguage(first);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _hljsPromise: Promise<Hljs> | null = null;
function loadHljs(): Promise<Hljs> {
  _hljsPromise ??= import('highlight.js/lib/common').then(
    (m: any) => m.default as Hljs,
  );
  return _hljsPromise;
}

/** Returns the index of the first closing fence line after the opener. */
function findClosingFence(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})\s*$/.test(lines[i])) return i;
  }
  return -1;
}

export class CodeEditorHighlight {
  private _timer: number | undefined;
  private _disposed = false;

  constructor(
    private readonly _code: HTMLElement,
    private readonly _pre: HTMLElement,
    private readonly _language: string | undefined,
  ) {}

  /** Debounced re-render per input. */
  schedule(source: string): void {
    if (this._disposed) return;
    if (this._timer !== undefined) window.clearTimeout(this._timer);
    const delay = source.length > LARGE_SOURCE_THRESHOLD
      ? LARGE_DEBOUNCE_MS
      : DEBOUNCE_MS;
    this._timer = window.setTimeout(() => {
      void this.update(source);
    }, delay);
  }

  dispose(): void {
    this._disposed = true;
    if (this._timer !== undefined) {
      window.clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  async update(source: string): Promise<void> {
    if (this._disposed || !this._code.isConnected) return;
    if (source.length > MAX_LIVE_HIGHLIGHT_CHARS) {
      this._code.textContent = source;
      this._pre.dataset.hlState = 'size-limited';
      return;
    }
    this._pre.dataset.hlState = 'pending';
    try {
      const html = await this._render(source);
      if (this._disposed || !this._code.isConnected) return;
      this._code.innerHTML = html;
      this._pre.dataset.hlState = 'done';
    } catch {
      if (!this._disposed && this._code.isConnected) {
        this._code.textContent = source;
        this._pre.dataset.hlState = 'done';
      }
    }
  }

  private async _render(source: string): Promise<string> {
    const lang = this._language;
    if (!lang) return escapeHtml(source);
    const hljs = await loadHljs();
    if (!hljs.getLanguage(lang)) return escapeHtml(source);

    const lines = source.split('\n');
    const isFence = lines.length >= 1
      && /^[ \t]*(`{3,}|~{3,})/.test(lines[0]);
    if (!isFence) {
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    }

    // Fence lines are excluded from highlighting to preserve line
    // alignment: escape the opener, highlight only the body, escape
    // from the closer onward.
    const closing = findClosingFence(lines);
    const bodyEnd = closing < 0 ? lines.length : closing;
    const body = lines.slice(1, bodyEnd).join('\n');
    const highlighted = hljs.highlight(body, {
      language: lang,
      ignoreIllegals: true,
    }).value;
    const head = `${escapeHtml(lines[0])}\n`;
    const tail = closing < 0
      ? ''
      : `\n${lines.slice(closing).map(escapeHtml).join('\n')}`;
    return head + highlighted + tail;
  }
}
