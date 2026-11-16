import { isEditableBlockKind } from './renderModel.js';

export interface SourceRange {
  startOffset: number;
  endOffset: number;
}

export interface RelocatableBlock {
  readonly id: string;
  readonly kind: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface LocatedBlock {
  block: RelocatableBlock;
  range: SourceRange;
  source: string;
}

/** UTF-16 offset of each line start. Includes text.length when the text ends with a newline. */
export function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++;
      offsets.push(index + 1);
    } else if (code === 10) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetAtLine(offsets: readonly number[], textLength: number, line: number): number {
  if (line <= 0) return 0;
  if (line >= offsets.length) return textLength;
  return offsets[line];
}

/** Offset range for a block given by sourceStart..sourceEnd (exclusive) line numbers. */
export function sourceRangeForLines(
  text: string,
  sourceStart: number,
  sourceEnd: number,
  offsets: readonly number[] = lineStartOffsets(text),
): SourceRange {
  const startOffset = offsetAtLine(offsets, text.length, sourceStart);
  const endOffset = offsetAtLine(offsets, text.length, sourceEnd);
  return { startOffset, endOffset: Math.max(startOffset, endOffset) };
}

export function detectLineEnding(source: string): '\r\n' | '\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function countEdgeLineEndings(text: string, atStart: boolean): number {
  const match = (atStart ? /^(?:\r\n|\n)+/ : /(?:\r\n|\n)+$/).exec(text)?.[0] ?? '';
  return match.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/**
 * Builds the text inserted at a block gap so the new Markdown stays a
 * separate block: newlines are normalized to the document style and
 * exactly one blank line is kept on each side. Returns '' for blank input.
 */
export function insertionForGap(
  markdown: string,
  source: string,
  offset: number,
  lineEnding: '\n' | '\r\n',
): string {
  const body = markdown
    .replace(/\r\n|\r|\n/g, lineEnding)
    .replace(/(?:\r\n|\n)+$/, '');
  if (!body.trim()) return '';

  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const beforeEndings = countEdgeLineEndings(before, false);
  const afterEndings = countEdgeLineEndings(after, true);

  const prefix = before.length === 0 ? '' : lineEnding.repeat(2 - Math.min(beforeEndings, 2));
  const suffix = after.length === 0 ? lineEnding : lineEnding.repeat(2 - Math.min(afterEndings, 2));
  return prefix + body + suffix;
}

/**
 * Converts textarea Markdown into a replacement string matching the
 * original block's line endings and trailing separator. The textarea
 * holds LF-normalized text.
 */
export function replacementForBlock(markdown: string, originalSource: string): string {
  const lineEnding = detectLineEnding(originalSource);
  const originalEnding = /(?:\r\n|\n|\r)+$/.exec(originalSource)?.[0] ?? '';
  let replacement = markdown.replace(/\r\n|\r|\n/g, lineEnding);
  if (originalEnding && !/(?:\r\n|\n|\r)$/.test(replacement)) {
    // Block ranges may include the following blank lines (e.g. lists).
    // Restore the original trailing separator run verbatim; appending a
    // single newline would collapse the blank line and merge blocks.
    replacement += originalEnding;
  }
  return replacement;
}

/**
 * Verifies that content outside the edited range is byte-identical.
 * The after-side suffix offset is adjusted for the replacement length.
 */
export function outsideRangeEqual(
  before: string,
  after: string,
  range: SourceRange,
  replacementLength: number,
): boolean {
  return before.slice(0, range.startOffset) === after.slice(0, range.startOffset)
    && before.slice(range.endOffset) === after.slice(range.startOffset + replacementLength);
}

/**
 * Re-locates a block after an external document change.
 *
 * - If the block ID still exists, its current source must match
 *   baseSourceHash; a mismatch means the block was externally modified
 *   (conflict) and null is returned.
 * - If the ID is gone, exactly one editable block with a matching
 *   baseSourceHash is required; ambiguity (e.g. duplicate paragraphs)
 *   returns null.
 */
export function findBlockSource(
  text: string,
  blocks: readonly RelocatableBlock[],
  blockId: string,
  baseSourceHash: string,
  hash: (source: string) => string,
): LocatedBlock | null {
  const offsets = lineStartOffsets(text);
  const byId = blocks.find(block => block.id === blockId);
  // A surviving ID must match by itself; otherwise exactly one editable
  // block with identical content may inherit it.
  const candidates = byId ? [byId] : blocks;
  let found: LocatedBlock | null = null;
  for (const block of candidates) {
    if (!isEditableBlockKind(block.kind)) continue;
    const range = sourceRangeForLines(text, block.sourceStart, block.sourceEnd, offsets);
    const source = text.slice(range.startOffset, range.endOffset);
    if (hash(source) !== baseSourceHash) continue;
    if (byId) return { block, range, source };
    if (found) return null;
    found = { block, range, source };
  }
  return found;
}
