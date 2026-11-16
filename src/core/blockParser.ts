import type { RenderBlock, BlockKind, ParsedDocument } from './renderModel.js';

interface MarkdownToken {
  type: string;
  nesting: number;
  map: [number, number] | null;
  info?: string;
  content?: string;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

interface RenderEnvironment {
  resolveImage?: (src: string) => string | null;
}

type RendererRule = (
  tokens: MarkdownToken[],
  index: number,
  options: unknown,
  env: RenderEnvironment,
  renderer: MarkdownRenderer,
) => string;

interface MarkdownRenderer {
  rules: Record<string, RendererRule | undefined>;
  render(tokens: MarkdownToken[], options: unknown, env: RenderEnvironment): string;
  renderToken(tokens: MarkdownToken[], index: number, options: unknown): string;
}

interface MarkdownItLike {
  options: unknown;
  renderer: MarkdownRenderer;
  linkify: { set(options: { fuzzyLink: boolean }): void };
  parse(source: string, env: RenderEnvironment): MarkdownToken[];
  use(plugin: unknown, options: unknown): MarkdownItLike;
}

interface MarkdownItConstructor {
  new(options: unknown): MarkdownItLike;
}

// FNV-1a 32-bit hash

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

let _md: MarkdownItLike | null = null;

function getMd(): MarkdownItLike {
  if (_md) return _md;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MarkdownIt = require('markdown-it') as MarkdownItConstructor;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const taskLists = require('markdown-it-task-lists');
  _md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight: null, // highlighting is applied lazily in the webview
  }).use(taskLists, { enabled: false, label: true, labelAfter: true });
  // linkify-it v6 (markdown-it v15) disables fuzzy `www.` links by default;
  // restore the previous autolink behavior explicitly.
  _md.linkify.set({ fuzzyLink: true });

  const defaultImageRule = _md.renderer.rules.image
    ?? ((tokens: MarkdownToken[], index: number, options: unknown, _env: unknown, self: MarkdownRenderer) =>
      self.renderToken(tokens, index, options));
  _md.renderer.rules.image = (
    tokens: MarkdownToken[],
    index: number,
    options: unknown,
    env: { resolveImage?: (src: string) => string | null },
    self: MarkdownRenderer,
  ) => {
    const token = tokens[index];
    const src = token.attrGet('src');
    if (src && env.resolveImage) {
      const resolved = env.resolveImage(src);
      if (!resolved) return '';
      token.attrSet('src', resolved);
    }
    return defaultImageRule(tokens, index, options, env, self);
  };
  return _md;
}

export function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}


function inferKind(token: MarkdownToken): BlockKind {
  const type: string = token.type;
  if (type === 'heading_open') return 'heading';
  if (type === 'fence') {
    const info = (token.info ?? '').trim().toLowerCase().split(/\s+/)[0];
    if (info === 'mermaid') return 'mermaid';
    return 'fence';
  }
  if (type === 'table_open') return 'table';
  if (type === 'code_block') return 'code_block';
  if (type === 'bullet_list_open') return 'bullet_list';
  if (type === 'ordered_list_open') return 'ordered_list';
  if (type === 'blockquote_open') return 'blockquote';
  if (type === 'html_block') return 'html_block';
  if (type === 'hr') return 'hr';
  if (type === 'paragraph_open') return 'paragraph';
  return 'other';
}


const FRONTMATTER_OPEN = /^---[ \t]*\r?$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
// A `key: value` line; avoids treating documents that start with hrs as frontmatter.
const YAML_PAIR = /^[ \t]*[A-Za-z0-9_"'-][^:\n]*:/;

/**
 * Returns the line after the closing `---`/`...` line when the document
 * starts with YAML frontmatter, else 0. Requires at least one `key:` line
 * so documents starting with two hrs are not misdetected.
 */
function detectFrontmatterEnd(lines: string[]): number {
  if (lines.length < 2) return 0;
  if (!FRONTMATTER_OPEN.test(lines[0].replace(/^\uFEFF/, ''))) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (!FRONTMATTER_CLOSE.test(lines[i])) continue;
    const body = lines.slice(1, i);
    if (body.length > 0 && body.some(line => YAML_PAIR.test(line))) {
      return i + 1;
    }
    return 0;
  }
  return 0;
}

function escHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Collapsible frontmatter HTML, closed by default like other Markdown previews. */
function renderFrontmatterHtml(bodyLines: string[]): string {
  const body = escHtmlText(bodyLines.join('\n'));
  const pre = body ? `<pre class="markdown-source-preview-frontmatter__body">${body}</pre>` : '';
  return `<details class="markdown-source-preview-frontmatter"><summary>frontmatter</summary>${pre}</details>`;
}


export interface ParseOptions {
  uri: string;
  generation: number;
  resolveImage?: (src: string) => string | null;
  /** Previous-generation blocks used to reuse unchanged HTML. */
  reuse?: readonly RenderBlock[];
}

export function parseDocument(source: string, opts: ParseOptions): ParsedDocument {
  const tParse = Date.now();
  const md = getMd();

  const lines = source.split('\n');
  const lineCount = lines.length;

  // Mask leading frontmatter with blank lines before parsing.
  // Line counts are preserved so token.map line numbers still match the source.
  const frontmatterEnd = detectFrontmatterEnd(lines);
  let parseSource = source;
  if (frontmatterEnd > 0) {
    const masked = lines.slice();
    for (let i = 0; i < frontmatterEnd; i++) masked[i] = '';
    parseSource = masked.join('\n');
  }

  const tokens: MarkdownToken[] = md.parse(parseSource, {});
  const parseMs = Date.now() - tParse;
  const headingSlugs = new Map<string, number>();
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[tokenIndex + 1];
    const baseSlug = slugifyHeading(inline?.content ?? '');
    const occurrence = headingSlugs.get(baseSlug) ?? 0;
    headingSlugs.set(baseSlug, occurrence + 1);
    token.attrSet('id', occurrence === 0 ? baseSlug : `${baseSlug}-${occurrence}`);
  }

  const reuseHtml = new Map<string, string>();
  if (opts.reuse) {
    for (const block of opts.reuse) {
      const signature = `${block.kind}:${block.contentHash}`;
      if (!reuseHtml.has(signature)) reuseHtml.set(signature, block.html);
    }
  }

  const blocks: RenderBlock[] = [];
  let depth = 0;
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    if (depth === 0) {
      const kind = inferKind(t);

      // Self-closing tokens (fence, hr, html_block, ...)
      if (t.nesting === 0) {
        const blockTokens = [t];
        const srcStart = t.map ? t.map[0] : (blocks.length > 0 ? blocks[blocks.length - 1].sourceEnd : 0);
        const srcEnd = t.map ? t.map[1] : srcStart + 1;
        const sourceText = lines.slice(srcStart, srcEnd).join('\n');
        const contentHash = hashString(sourceText);
        const html = reuseHtml.get(`${kind}:${contentHash}`)
          ?? md.renderer.render(blockTokens, md.options, { resolveImage: opts.resolveImage });

        blocks.push({
          id: `tmp:${blocks.length}`,
          kind,
          sourceStart: srcStart,
          sourceEnd: srcEnd,
          contentHash,
          html,
          renderState: 'rendered',
          estimatedHeight: -1,
        });
        i++;
        continue;
      }

      // Open tokens (heading_open, table_open, ...)
      if (t.nesting === 1) {
        const groupTokens: MarkdownToken[] = [t];
        const srcStart = t.map ? t.map[0] : (blocks.length > 0 ? blocks[blocks.length - 1].sourceEnd : 0);
        depth = 1;
        i++;

        while (i < tokens.length && depth > 0) {
          const u = tokens[i];
          groupTokens.push(u);
          if (u.nesting === 1) depth++;
          else if (u.nesting === -1) depth--;
          i++;
        }

        // The opening token's map covers the whole block; the closing
        // token has map=null, so do not rely on the last token.
        const lastTok = groupTokens[groupTokens.length - 1];
        const srcEnd = t.map
          ? t.map[1]
          : (lastTok.map ? lastTok.map[1] : srcStart + groupTokens.length);
        const sourceText = lines.slice(srcStart, Math.min(srcEnd, lineCount)).join('\n');
        const contentHash = hashString(sourceText);
        const html = reuseHtml.get(`${kind}:${contentHash}`)
          ?? md.renderer.render(groupTokens, md.options, { resolveImage: opts.resolveImage });

        blocks.push({
          id: `tmp:${blocks.length}`,
          kind,
          sourceStart: srcStart,
          sourceEnd: srcEnd,
          contentHash,
          html,
          renderState: 'rendered',
          estimatedHeight: -1,
        });
        depth = 0;
        continue;
      }
    }

    // depth > 0 is already handled by the groupTokens collection loop above
    i++;
  }

  if (frontmatterEnd > 0) {
    const fmText = lines.slice(0, frontmatterEnd).join('\n');
    blocks.unshift({
      id: 'tmp:frontmatter',
      kind: 'frontmatter',
      sourceStart: 0,
      sourceEnd: frontmatterEnd,
      contentHash: hashString(fmText),
      html: renderFrontmatterHtml(lines.slice(1, frontmatterEnd - 1)),
      renderState: 'rendered',
      estimatedHeight: -1,
    });
  }

  return {
    uri: opts.uri,
    generation: opts.generation,
    blocks,
    lineCount,
    parseMs,
  };
}


export interface SliceResult {
  /** Blocks included in the initial slice (indexes 0..N-1). */
  initialBlocks: RenderBlock[];
  /** Remaining blocks (indexes N..end). */
  restBlocks: RenderBlock[];
  /** Concatenated HTML of the initial slice. */
  initialHtml: string;
  /** HTML generation time for the initial slice (ms). */
  renderMs: number;
}

/**
 * Cuts the first viewport slice from a ParsedDocument. Stops at
 * `blockLimit` blocks or `htmlCharLimit` accumulated HTML characters,
 * whichever comes first.
 */
export function sliceInitial(
  doc: ParsedDocument,
  opts: { blockLimit: number; htmlCharLimit: number },
): SliceResult {
  const { blockLimit, htmlCharLimit } = opts;
  const tRender = Date.now();

  let htmlChars = 0;
  let cutIdx = 0;

  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    htmlChars += b.html.length;
    cutIdx = i + 1;
    if (cutIdx >= blockLimit || htmlChars >= htmlCharLimit) {
      break;
    }
  }

  // Always include at least one block
  if (cutIdx === 0 && doc.blocks.length > 0) cutIdx = 1;

  const initialBlocks = doc.blocks.slice(0, cutIdx) as RenderBlock[];
  const restBlocks = doc.blocks.slice(cutIdx) as RenderBlock[];
  const initialHtml = initialBlocks.map(b => wrapBlock(b)).join('\n');
  const renderMs = Date.now() - tRender;

  return { initialBlocks, restBlocks, initialHtml, renderMs };
}

/** Wraps a block in a div with data-block-id/data-line for webview diffing and scroll anchoring. */
export function wrapBlock(block: RenderBlock): string {
  return `<div data-block-id="${escAttr(block.id)}" data-line="${block.sourceStart}" data-kind="${block.kind}" data-state="${block.renderState}">${block.html}</div>`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}


export interface BlockWindow {
  prevStartLine: number;
  prevEndLine: number;
  nextStartLine: number;
  nextEndLine: number;
}

function blockSignature(block: RenderBlock): string {
  return `${block.kind}:${block.contentHash}`;
}

function stableBlockId(generation: number, index: number): string {
  return `g${generation}:b${index}`;
}

function insertedBlockId(generation: number, index: number): string {
  return `g${generation}:n${index}`;
}

function lineWindowToBlockRange(
  blocks: readonly RenderBlock[],
  startLine: number,
  endLine: number,
): [number, number] | null {
  if (!blocks.length) return null;
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.sourceEnd > startLine && block.sourceStart <= endLine) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    first = last = blocks.length - 1;
  }
  return [Math.max(0, first - 1), Math.min(blocks.length - 1, last + 1)];
}

function matchBySignatureOrdered(
  prev: readonly RenderBlock[],
  next: readonly RenderBlock[],
  usedPrev: boolean[],
  nextIds: Array<string | null>,
): void {
  const bySignature = new Map<string, { prevIndices: number[]; nextIndices: number[] }>();
  for (let i = 0; i < prev.length; i++) {
    const signature = blockSignature(prev[i]);
    const entry = bySignature.get(signature);
    if (entry) entry.prevIndices.push(i);
    else bySignature.set(signature, { prevIndices: [i], nextIndices: [] });
  }
  for (let j = 0; j < next.length; j++) {
    const signature = blockSignature(next[j]);
    const entry = bySignature.get(signature);
    if (entry) entry.nextIndices.push(j);
    else bySignature.set(signature, { prevIndices: [], nextIndices: [j] });
  }
  for (const { prevIndices, nextIndices } of bySignature.values()) {
    const pairCount = Math.min(prevIndices.length, nextIndices.length);
    for (let i = 0; i < pairCount; i++) {
      const prevIndex = prevIndices[i];
      const nextIndex = nextIndices[i];
      if (usedPrev[prevIndex] || nextIds[nextIndex]) continue;
      usedPrev[prevIndex] = true;
      nextIds[nextIndex] = prev[prevIndex].id;
    }
  }
}

/**
 * Keeps old IDs outside the changed window via kind+contentHash matches.
 * Inside the window, signature matches win and the rest pair by order.
 * This prevents a sourceStart shift from changing every later block ID.
 */
export function stabilizeBlockIds(
  prev: readonly RenderBlock[] | null,
  next: readonly RenderBlock[],
  window: BlockWindow | null,
  generation: number,
): RenderBlock[] {
  if (!next.length) return [];
  if (!prev?.length) {
    return next.map((block, index) => ({ ...block, id: stableBlockId(generation, index) }));
  }

  const nextIds: Array<string | null> = new Array(next.length).fill(null);
  const usedPrev: boolean[] = new Array(prev.length).fill(false);

  const prevHot = window
    ? lineWindowToBlockRange(prev, window.prevStartLine, window.prevEndLine) ?? [0, prev.length - 1] as [number, number]
    : [0, prev.length - 1] as [number, number];
  const nextHot = window
    ? lineWindowToBlockRange(next, window.nextStartLine, window.nextEndLine) ?? [0, next.length - 1] as [number, number]
    : [0, next.length - 1] as [number, number];

  const prevHotFirst = prevHot[0];
  const prevHotLast = prevHot[1];
  const nextHotFirst = nextHot[0];
  const nextHotLast = nextHot[1];

  matchBySignatureOrdered(prev, next, usedPrev, nextIds);

  const remainingPrev: number[] = [];
  for (let i = prevHotFirst; i <= prevHotLast; i++) {
    if (!usedPrev[i]) remainingPrev.push(i);
  }
  const remainingNext: number[] = [];
  for (let j = nextHotFirst; j <= nextHotLast; j++) {
    if (!nextIds[j]) remainingNext.push(j);
  }
  const pairCount = Math.min(remainingPrev.length, remainingNext.length);
  for (let i = 0; i < pairCount; i++) {
    const prevIndex = remainingPrev[i];
    const nextIndex = remainingNext[i];
    usedPrev[prevIndex] = true;
    nextIds[nextIndex] = prev[prevIndex].id;
  }

  for (let j = 0; j < next.length; j++) {
    if (!nextIds[j]) nextIds[j] = insertedBlockId(generation, j);
  }

  return next.map((block, index) => {
    const id = nextIds[index]!;
    return id === block.id ? block : { ...block, id };
  });
}


export interface DiffResult {
  updates: Array<{ block: RenderBlock; prevHash: string }>;
  inserts: Array<{ block: RenderBlock; beforeId: string | null }>;
  deletes: Array<{ blockId: string }>;
}

export function diffBlocks(prev: readonly RenderBlock[], next: readonly RenderBlock[]): DiffResult {
  const prevMap = new Map(prev.map(b => [b.id, b]));
  const nextMap = new Map(next.map(b => [b.id, b]));

  const updates: DiffResult['updates'] = [];
  const inserts: DiffResult['inserts'] = [];
  const deletes: DiffResult['deletes'] = [];

  for (let index = 0; index < next.length; index++) {
    const b = next[index];
    const old = prevMap.get(b.id);
    if (!old) {
      // Anchor the insert before its canonical successor so restored or
      // reordered blocks keep their source position; null appends at the
      // end. Inserts are emitted in canonical order and applied in
      // reverse by the caller so the anchor already exists in the DOM.
      const beforeId = index + 1 < next.length ? next[index + 1].id : null;
      inserts.push({ block: b, beforeId });
    } else if (old.contentHash !== b.contentHash) {
      updates.push({ block: b, prevHash: old.contentHash });
    }
  }

  for (const b of prev) {
    if (!nextMap.has(b.id)) {
      deletes.push({ blockId: b.id });
    }
  }

  return { updates, inserts, deletes };
}
