import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { diffBlocks, parseDocument, stabilizeBlockIds } from '../../src/core/blockParser.js';
import { isEditableBlockKind } from '../../src/core/renderModel.js';
import type { RenderBlock } from '../../src/core/renderModel.js';
import {
  applyRangeEdit,
  findBlockSource,
  lineCount,
  lineStartOffsets,
  outsideRangeEqual,
  insertionForGap,
  replacementForBlock,
  sourceRangeForLines,
} from '../../src/core/editRange.js';

function sha(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function parseBlocks(source: string): RenderBlock[] {
  const doc = parseDocument(source, { uri: 'test:/phase3a.md', generation: 1 });
  return stabilizeBlockIds(null, doc.blocks, null, 1);
}

function blockRange(source: string, block: RenderBlock) {
  const range = sourceRangeForLines(source, block.sourceStart, block.sourceEnd);
  const original = source.slice(range.startOffset, range.endOffset);
  return { range, original };
}

function editBlock(source: string, block: RenderBlock, markdown: string) {
  const { range, original } = blockRange(source, block);
  const replacement = replacementForBlock(markdown, original);
  return {
    range,
    original,
    replacement,
    after: applyRangeEdit(source, range, replacement),
  };
}

describe('Phase 3A source range helpers', () => {
  it('counts LF, CRLF, and CR line starts without losing offsets', () => {
    assert.deepEqual(lineStartOffsets('a\nb\n'), [0, 2, 4]);
    assert.equal(lineCount('a\nb\n'), 3);
    assert.deepEqual(lineStartOffsets('a\r\nb\r\n'), [0, 3, 6]);
    assert.equal(lineCount('a\r\nb\r\n'), 3);
    assert.deepEqual(lineStartOffsets('a\rb'), [0, 2]);
    assert.equal(lineCount('a\rb'), 2);
  });

  it('maps a block at EOF to the end of the document', () => {
    const source = 'before\n\nlast paragraph';
    assert.deepEqual(sourceRangeForLines(source, 2, 3), {
      startOffset: 8,
      endOffset: source.length,
    });
    assert.deepEqual(sourceRangeForLines('one\ntwo\n', 1, 99), {
      startOffset: 4,
      endOffset: 8,
    });
  });

  it('keeps LF no-op saves byte-identical', () => {
    const source = '# LF fixture\n\nParagraph body.\n';
    const paragraph = parseBlocks(source).find(block => block.kind === 'paragraph');
    assert.ok(paragraph);
    const { original } = blockRange(source, paragraph);
    const result = editBlock(source, paragraph, original);
    assert.equal(result.replacement, original);
    assert.equal(result.after, source);
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });

  it('restores CRLF line endings for edited blocks', () => {
    const source = '# CRLF fixture\r\n\r\nParagraph body.\r\n';
    const paragraph = parseBlocks(source).find(block => block.kind === 'paragraph');
    assert.ok(paragraph);
    const result = editBlock(source, paragraph, 'Paragraph body edited.');
    assert.match(result.original, /\r\n/);
    assert.equal(result.replacement, 'Paragraph body edited.\r\n');
    assert.equal(result.after, '# CRLF fixture\r\n\r\nParagraph body edited.\r\n');
    assert.equal(/[^\r]\n/.test(result.after), false, 'edited CRLF document contains a lone LF');
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });

  it('preserves a leading BOM and trailing newline state', () => {
    const bomSource = '\uFEFF# BOM fixture\n\nParagraph body.\n';
    const bomParagraph = parseBlocks(bomSource).find(block =>
      block.kind === 'paragraph' && block.html.includes('Paragraph body'));
    assert.ok(bomParagraph);
    const bomResult = editBlock(bomSource, bomParagraph, 'Paragraph body edited.');
    assert.equal(bomResult.after.startsWith('\uFEFF'), true);
    assert.equal(bomResult.after, '\uFEFF# BOM fixture\n\nParagraph body edited.\n');

    const noFinalNewline = '# No final newline\n\nParagraph body.';
    const noFinalParagraph = parseBlocks(noFinalNewline).find(block => block.kind === 'paragraph');
    assert.ok(noFinalParagraph);
    const noFinalResult = editBlock(noFinalNewline, noFinalParagraph, 'Paragraph body edited.');
    assert.equal(noFinalResult.after.endsWith('\n'), false);
    assert.equal(noFinalResult.after, '# No final newline\n\nParagraph body edited.');

    const withFinalNewline = '# With final newline\n\nParagraph body.\n';
    const withFinalParagraph = parseBlocks(withFinalNewline).find(block => block.kind === 'paragraph');
    assert.ok(withFinalParagraph);
    const withFinalResult = editBlock(withFinalNewline, withFinalParagraph, 'Paragraph body edited.');
    assert.equal(withFinalResult.after.endsWith('\n'), true);
  });

  it('keeps Japanese, emoji, and combining characters intact outside the edited range', () => {
    const source = '# Unicode\n\n日本語の段落 😀 e\u0301 です。\n\nSecond paragraph.\n';
    const first = parseBlocks(source).find(block =>
      block.kind === 'paragraph' && block.html.includes('日本語の段落'));
    assert.ok(first);
    const result = editBlock(source, first, '日本語の段落 😀 e\u0301 を編集しました。');
    assert.match(result.after, /日本語の段落 😀 e\u0301 を編集しました。/);
    assert.match(result.after, /\n\nSecond paragraph\.\n$/);
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });

  it('gives duplicate paragraphs distinct IDs and edits only the selected one', () => {
    const source = '# Duplicate\n\nSame paragraph.\n\nSame paragraph.\n';
    const blocks = parseBlocks(source);
    const paragraphs = blocks.filter(block => block.kind === 'paragraph');
    assert.equal(paragraphs.length, 2);
    assert.notEqual(paragraphs[0].id, paragraphs[1].id);

    const firstResult = editBlock(source, paragraphs[0], 'First paragraph edited.');
    assert.equal(firstResult.after, '# Duplicate\n\nFirst paragraph edited.\n\nSame paragraph.\n');
    const secondResult = editBlock(source, paragraphs[1], 'Second paragraph edited.');
    assert.equal(secondResult.after, '# Duplicate\n\nSame paragraph.\n\nSecond paragraph edited.\n');
  });

  it('handles consecutive headings without touching the next heading', () => {
    const source = '# First heading\n## Second heading\n\nParagraph.\n';
    const blocks = parseBlocks(source);
    const headings = blocks.filter(block => block.kind === 'heading');
    assert.equal(headings.length, 2);
    const result = editBlock(source, headings[0], '# First heading edited');
    assert.equal(result.after, '# First heading edited\n## Second heading\n\nParagraph.\n');
  });

  it('preserves blank lines around an empty paragraph boundary', () => {
    const source = 'Before paragraph.\n\nAfter paragraph.\n';
    const blocks = parseBlocks(source);
    const before = blocks.find(block => block.kind === 'paragraph' && block.html.includes('Before'));
    assert.ok(before);
    const result = editBlock(source, before, 'Before paragraph edited.');
    assert.equal(result.after, 'Before paragraph edited.\n\nAfter paragraph.\n');
  });

  it('relocates an unchanged block after an unrelated external change', () => {
    const original = '# Heading\n\nParagraph A.\n\nParagraph B.\n';
    const blocks = parseBlocks(original);
    const paragraphA = blocks.find(block => block.kind === 'paragraph' && block.html.includes('Paragraph A'));
    assert.ok(paragraphA);
    const { original: sourceA } = blockRange(original, paragraphA);

    const externallyChanged = `${original}\nExternal append.\n`;
    const nextBlocks = stabilizeBlockIds(blocks, parseDocument(externallyChanged, {
      uri: 'test:/phase3a.md',
      generation: 2,
    }).blocks, null, 2);
    const located = findBlockSource(
      externallyChanged,
      nextBlocks,
      paragraphA.id,
      sha(sourceA),
      sha,
    );
    assert.ok(located);
    const after = applyRangeEdit(
      externallyChanged,
      located.range,
      replacementForBlock('Paragraph A edited.', located.source),
    );
    assert.equal(after, '# Heading\n\nParagraph A edited.\n\nParagraph B.\n\nExternal append.\n');
  });

  it('reports a conflict when the edited block itself changed externally', () => {
    const original = '# Heading\n\nParagraph A.\n\nParagraph B.\n';
    const blocks = parseBlocks(original);
    const paragraphA = blocks.find(block => block.kind === 'paragraph' && block.html.includes('Paragraph A'));
    assert.ok(paragraphA);
    const { original: sourceA } = blockRange(original, paragraphA);

    const externallyChanged = original.replace('Paragraph A.', 'Paragraph A changed externally.');
    const nextBlocks = stabilizeBlockIds(blocks, parseDocument(externallyChanged, {
      uri: 'test:/phase3a.md',
      generation: 2,
    }).blocks, null, 2);
    const located = findBlockSource(
      externallyChanged,
      nextBlocks,
      paragraphA.id,
      sha(sourceA),
      sha,
    );
    assert.equal(located, null);
  });

  it('refuses to relocate when duplicate paragraphs make the hash ambiguous', () => {
    const original = '# Heading\n\nSame paragraph.\n\nSame paragraph.\n';
    const blocks = parseBlocks(original);
    const first = blocks.find(block => block.kind === 'paragraph');
    assert.ok(first);
    const { original: sourceFirst } = blockRange(original, first);
    const nextBlocks = blocks.map(block => ({ ...block, id: `new:${block.id}` }));
    const located = findBlockSource(original, nextBlocks, 'missing-id', sha(sourceFirst), sha);
    assert.equal(located, null);
  });

  it('detects changes outside the replacement range', () => {
    const before = 'aaa\nbbb\nccc\n';
    const after = 'aaa\nBBB\nccc\n';
    const range = { startOffset: 4, endOffset: 7 };
    assert.equal(outsideRangeEqual(before, after, range, 3), true);
    assert.equal(outsideRangeEqual(before, 'AAA\nBBB\nccc\n', range, 3), false);
    assert.equal(outsideRangeEqual(before, 'aaa\nBBB\nCCC\n', range, 3), false);
  });

  it('treats all source blocks as editable kinds only', () => {
    for (const kind of [
      'heading', 'paragraph', 'bullet_list', 'ordered_list', 'blockquote',
      'fence', 'code_block', 'table', 'mermaid', 'html_block', 'hr',
    ]) {
      assert.equal(isEditableBlockKind(kind), true, `${kind} should be editable`);
    }
    for (const kind of ['other', '']) {
      assert.equal(isEditableBlockKind(kind), false, `${kind} should not be editable`);
    }
  });

  it('covers the full fence, table, and indented code source ranges', () => {
    const source = 'Intro.\n\n'
      + '```rust\nfn main() {}\n```\n\n'
      + '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n'
      + '    indented code\n\n'
      + 'Tail.\n';
    const blocks = parseBlocks(source);
    const fence = blocks.find(block => block.kind === 'fence');
    const table = blocks.find(block => block.kind === 'table');
    const code = blocks.find(block => block.kind === 'code_block');
    assert.ok(fence && table && code, 'expected fence/table/code_block blocks');

    const { original: fenceSource } = blockRange(source, fence);
    assert.ok(fenceSource.startsWith('```rust\n'), `fence range start: ${JSON.stringify(fenceSource.slice(0, 20))}`);
    assert.ok(fenceSource.trimEnd().endsWith('```'), 'fence range must include the closing fence');

    const { original: tableSource } = blockRange(source, table);
    assert.ok(tableSource.includes('| A | B |'), 'table range missing header');
    assert.ok(tableSource.includes('| --- | --- |'), 'table range missing separator');
    assert.ok(tableSource.includes('| 1 | 2 |'), 'table range missing data row');

    const { original: codeSource } = blockRange(source, code);
    assert.ok(codeSource.includes('indented code'), 'code_block range missing content');

    const result = editBlock(source, fence, '```ts\nconst x = 1;\n```');
    assert.ok(result.after.includes('```ts\nconst x = 1;\n```\n'), 'fence edit not applied');
    assert.ok(result.after.includes('| 1 | 2 |'), 'table content lost after fence edit');
    assert.ok(result.after.endsWith('Tail.\n'), 'tail content lost after fence edit');
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });

  it('relocates an unchanged fence after an unrelated external change', () => {
    const original = '```rust\nfn main() {}\n```\n\nParagraph A.\n';
    const blocks = parseBlocks(original);
    const fence = blocks.find(block => block.kind === 'fence');
    assert.ok(fence);
    const { original: fenceSource } = blockRange(original, fence);

    const externallyChanged = `${original}\nExternal append.\n`;
    const nextBlocks = stabilizeBlockIds(blocks, parseDocument(externallyChanged, {
      uri: 'test:/phase3a.md',
      generation: 2,
    }).blocks, null, 2);
    const located = findBlockSource(
      externallyChanged,
      nextBlocks,
      fence.id,
      sha(fenceSource),
      sha,
    );
    assert.ok(located, 'fence should relocate after unrelated change');
    const after = applyRangeEdit(
      externallyChanged,
      located.range,
      replacementForBlock('```ts\nconst x = 1;\n```', located.source),
    );
    assert.ok(after.startsWith('```ts\nconst x = 1;\n```\n'), 'fence replacement failed');
    assert.ok(after.endsWith('External append.\n'), 'external append lost');
  });

  it('covers a whole nested list including task markers as one editable range', () => {
    const source = 'Intro.\n\n'
      + '- First item\n- Second item\n  - Nested item\n- Third item\n\n'
      + '1. Ordered one\n2. Ordered two\n   1. Nested ordered\n\n'
      + '- [x] Completed task\n- [ ] Pending task\n\n'
      + 'Tail.\n';
    const blocks = parseBlocks(source);
    const bullets = blocks.filter(block => block.kind === 'bullet_list');
    const ordered = blocks.filter(block => block.kind === 'ordered_list');
    assert.equal(bullets.length, 2, 'expected two bullet_list blocks (plain + task)');
    assert.equal(ordered.length, 1, 'expected one ordered_list block');

    const { original: bulletSource } = blockRange(source, bullets[0]);
    assert.ok(bulletSource.includes('  - Nested item'), 'bullet range missing nested item');
    assert.ok(bulletSource.includes('- Third item'), 'bullet range missing last item');
    assert.ok(!bulletSource.includes('Ordered one'), 'bullet range swallowed ordered list');

    const { original: orderedSource } = blockRange(source, ordered[0]);
    assert.ok(orderedSource.includes('   1. Nested ordered'), 'ordered range missing nested item');

    const { original: taskSource } = blockRange(source, bullets[1]);
    assert.ok(taskSource.includes('- [x] Completed task'), 'task range missing [x] marker');
    assert.ok(taskSource.includes('- [ ] Pending task'), 'task range missing [ ] marker');

    const result = editBlock(source, bullets[0], '- First item\n- Second item\n  - Nested item\n- Third item edited');
    assert.ok(result.after.includes('- Third item edited'), 'list edit not applied');
    // リスト range が含む末尾の空行は保存後も維持され、後続リストと結合しない
    assert.ok(result.after.includes('- Third item edited\n\n1. Ordered one'),
      'trailing blank line after list was not preserved');
    assert.ok(result.after.includes('- [x] Completed task'), 'task list lost after edit');
    assert.ok(result.after.endsWith('Tail.\n'), 'tail content lost after list edit');
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });
});

describe('frontmatter', () => {
  it('renders leading YAML frontmatter as a collapsed block', () => {
    const source = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Heading\n\nBody.\n';
    const blocks = parseBlocks(source);
    assert.equal(blocks[0].kind, 'frontmatter');
    assert.equal(blocks[0].sourceStart, 0);
    assert.equal(blocks[0].sourceEnd, 4);
    assert.ok(blocks[0].html.includes('<details'), 'missing <details>');
    assert.ok(blocks[0].html.includes('<summary>'), 'missing <summary>');
    assert.ok(blocks[0].html.includes('title: Test'), 'yaml body missing');
    assert.ok(blocks[0].html.includes('tags: [a, b]'), 'yaml body missing second key');
    // 後続ブロックの行番号はマスク後も元ソースと一致する
    const heading = blocks.find(b => b.kind === 'heading');
    assert.equal(heading?.sourceStart, 5);
    const paragraph = blocks.find(b => b.kind === 'paragraph');
    assert.equal(paragraph?.sourceStart, 7);
  });

  it('shows yaml body inside the collapsed region', () => {
    const source = '---\ntitle: Test\ndraft: true\n---\nBody.\n';
    const blocks = parseBlocks(source);
    const html = blocks[0].html;
    assert.ok(html.includes('title: Test'), 'title missing from body');
    assert.ok(html.includes('draft: true'), 'draft missing from body');
    // 区切りの --- は body に含めない
    const pre = html.slice(html.indexOf('__body'));
    assert.ok(!pre.includes('---'), 'fence leaked into frontmatter body');
  });

  it('accepts ... as closing delimiter and a leading BOM', () => {
    const source = '﻿---\ntitle: X\n...\nBody.\n';
    const blocks = parseBlocks(source);
    assert.equal(blocks[0].kind, 'frontmatter');
    assert.equal(blocks[0].sourceEnd, 3);
  });

  it('does not treat an unclosed --- as frontmatter', () => {
    const source = '---\ntext without close\nmore text\n';
    const blocks = parseBlocks(source);
    assert.ok(blocks.every(b => b.kind !== 'frontmatter'));
  });

  it('does not treat --- after content as frontmatter', () => {
    const source = 'Intro.\n\n---\ntitle: x\n---\n';
    const blocks = parseBlocks(source);
    assert.ok(blocks.every(b => b.kind !== 'frontmatter'));
  });

  it('rejects hr pairs whose body has no yaml key', () => {
    // 先頭 --- と後続 --- が hr の並びで、本文に key: が無い → frontmatter にしない
    const source = '---\nJust some text.\n---\n\nBody.\n';
    const blocks = parseBlocks(source);
    assert.ok(blocks.every(b => b.kind !== 'frontmatter'));
  });

  it('frontmatter block is editable as a whole source range', () => {
    const source = '---\ntitle: Old\n---\n\nBody.\n';
    const blocks = parseBlocks(source);
    const fm = blocks[0];
    assert.equal(isEditableBlockKind(fm.kind), true);
    const { original } = blockRange(source, fm);
    assert.ok(original.startsWith('---'), 'range missing opening fence');
    assert.ok(original.includes('title: Old'), 'range missing yaml');
    assert.ok(original.includes('---'), 'range missing closing fence');

    const result = editBlock(source, fm, '---\ntitle: New\n---');
    assert.ok(result.after.includes('title: New'), 'edit not applied');
    assert.ok(result.after.includes('Body.'), 'body lost after edit');
    assert.equal(outsideRangeEqual(source, result.after, result.range, result.replacement.length), true);
  });
});

describe('codeEditorHighlight helpers', () => {
  it('isCodeHighlightKind covers fence and code_block only', async () => {
    const { isCodeHighlightKind } = await import('../../src/webview/codeEditorHighlight.js');
    assert.equal(isCodeHighlightKind('fence'), true);
    assert.equal(isCodeHighlightKind('code_block'), true);
    assert.equal(isCodeHighlightKind('mermaid'), false);
    assert.equal(isCodeHighlightKind('paragraph'), false);
  });

  it('normalizeLanguage maps common aliases', async () => {
    const { normalizeLanguage } = await import('../../src/webview/codeEditorHighlight.js');
    assert.equal(normalizeLanguage('js'), 'javascript');
    assert.equal(normalizeLanguage('TS'), 'typescript');
    assert.equal(normalizeLanguage('rs'), 'rust');
    assert.equal(normalizeLanguage('Rust'), 'rust');
    assert.equal(normalizeLanguage('cpp'), 'cpp');
    assert.equal(normalizeLanguage(undefined), undefined);
    assert.equal(normalizeLanguage('  '), undefined);
  });

  it('parseFenceLanguage reads the info string', async () => {
    const { parseFenceLanguage } = await import('../../src/webview/codeEditorHighlight.js');
    assert.equal(parseFenceLanguage('```typescript\nconst a = 1;\n```\n'), 'typescript');
    assert.equal(parseFenceLanguage('~~~ rust extra\nfn main() {}\n~~~\n'), 'rust');
    assert.equal(parseFenceLanguage('```\nplain\n```\n'), undefined);
    assert.equal(parseFenceLanguage('    indented code\n'), undefined);
  });
});

describe('diffBlocks insert anchors', () => {
  function blk(id: string): RenderBlock {
    return {
      id,
      kind: 'paragraph',
      sourceStart: 0,
      sourceEnd: 1,
      contentHash: id,
      html: '',
      renderState: 'rendered',
      estimatedHeight: -1,
    };
  }

  it('anchors a restored block before its canonical successor', () => {
    const diff = diffBlocks([blk('a'), blk('c')], [blk('a'), blk('b'), blk('c')]);
    assert.equal(diff.inserts.length, 1);
    assert.equal(diff.inserts[0].block.id, 'b');
    assert.equal(diff.inserts[0].beforeId, 'c');
  });

  it('anchors a leading insert before the first block', () => {
    const diff = diffBlocks([blk('b')], [blk('a'), blk('b')]);
    assert.equal(diff.inserts[0].beforeId, 'b');
  });

  it('uses a null anchor for a trailing insert', () => {
    const diff = diffBlocks([blk('a')], [blk('a'), blk('b')]);
    assert.equal(diff.inserts[0].beforeId, null);
  });
});

describe('insertionForGap', () => {
  it('returns empty for blank markdown', () => {
    assert.equal(insertionForGap('', 'a\n', 2, '\n'), '');
    assert.equal(insertionForGap('  \n\n', 'a\n', 2, '\n'), '');
  });

  it('separates a new block between two blocks with one blank line', () => {
    const source = '# H\n\npara\n\ntail';
    const offset = source.indexOf('tail');
    const insertion = insertionForGap('middle', source, offset, '\n');
    const after = source.slice(0, offset) + insertion + source.slice(offset);
    assert.equal(after, '# H\n\npara\n\nmiddle\n\ntail');
  });

  it('adds the missing blank line when the gap has none', () => {
    const source = 'one\ntwo';
    const offset = source.indexOf('two');
    const insertion = insertionForGap('mid', source, offset, '\n');
    const after = source.slice(0, offset) + insertion + source.slice(offset);
    assert.equal(after, 'one\n\nmid\n\ntwo');
  });

  it('inserts at document start without leading blank lines', () => {
    const source = '# H\n\nbody';
    const insertion = insertionForGap('# New', source, 0, '\n');
    const after = insertion + source;
    assert.equal(after, '# New\n\n# H\n\nbody');
  });

  it('appends at document end with a trailing newline', () => {
    const source = '# H\n\nbody';
    const insertion = insertionForGap('tail para', source, source.length, '\n');
    const after = source + insertion;
    assert.equal(after, '# H\n\nbody\n\ntail para\n');
  });

  it('handles an empty document', () => {
    const insertion = insertionForGap('first', '', 0, '\n');
    assert.equal(insertion, 'first\n');
  });

  it('preserves CRLF documents', () => {
    const source = '# H\r\n\r\nbody';
    const insertion = insertionForGap('mid', source, source.length, '\r\n');
    const after = source + insertion;
    assert.equal(after, '# H\r\n\r\nbody\r\n\r\nmid\r\n');
  });

  it('normalizes mixed input newlines to the document style', () => {
    const source = 'a\r\nb';
    const insertion = insertionForGap('x\ny', source, 4, '\r\n');
    assert.ok(insertion.includes('\r\n'));
    assert.ok(!insertion.replace(/\r\n/g, '').includes('\n'));
  });

  it('keeps multi-block markdown intact', () => {
    const source = 'one\n\ntwo';
    const offset = source.indexOf('two');
    const insertion = insertionForGap('a\n\nb', source, offset, '\n');
    const after = source.slice(0, offset) + insertion + source.slice(offset);
    assert.equal(after, 'one\n\na\n\nb\n\ntwo');
  });
});
