import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDocument } from '../../src/core/blockParser.js';
import { HighlightQueue } from '../../src/webview/highlightQueue.js';
import { RenderQueue } from '../../src/webview/renderQueue.js';
import type { BlockStore } from '../../src/webview/blockStore.js';
import {
  MERMAID_SECURITY_LEVEL,
  mermaidSvgCacheKey,
} from '../../src/webview/mermaidSecurity.js';

const commonMarkExamples = (require('commonmark-spec') as {
  tests: Array<{ markdown: string; html: string; section: string; number: number }>;
}).tests;
const intentionalDifferences = new Map<number, string>([
  ...Array.from({ length: 44 }, (_, index) => [148 + index, 'htmlBlocks'] as const),
  ...Array.from({ length: 19 }, (_, index) => [594 + index, 'autolinkOrLinkifyPolicy'] as const),
  ...Array.from({ length: 20 }, (_, index) => [613 + index, 'rawHtmlPolicy'] as const),
  ...[
    14, 21, 31, 91, 110, 195, 201, 308, 309, 343, 344,
    475, 476, 477, 489, 491, 494, 524, 536, 580, 642, 643,
  ].map(number => [number, 'rawHtmlPolicy'] as const),
]);

function render(source: string): string {
  return parseDocument(source, { uri: 'test:/document.md', generation: 1 })
    .blocks.map(block => block.html)
    .join('\n');
}

function normalizeHtml(html: string): string {
  return html
    .replace(/(<h[1-6]) id="[^"]*"/g, '$1')
    .replace(/<(hr|br)>/g, '<$1 />')
    .replace(/<img ([^>]+)>/g, (tag, attributes: string) =>
      attributes.endsWith('/') ? tag : `<img ${attributes} />`)
    .replace(/<blockquote><\/blockquote>/g, '<blockquote>\n</blockquote>')
    .replace(/>\n\n</g, '>\n<');
}

describe('CommonMark compatibility', () => {
  it('compares every non-allowlisted official example and reports intentional differences', () => {
    const mismatches: Array<{ id: string; markdown: string; expected: string; actual: string }> = [];
    const exclusions: Record<string, number> = {
      rawHtmlPolicy: 0,
      htmlBlocks: 0,
      autolinkOrLinkifyPolicy: 0,
    };
    let checked = 0;
    let matched = 0;

    for (const example of commonMarkExamples) {
      const reason = intentionalDifferences.get(example.number);
      if (reason) {
        exclusions[reason]++;
        continue;
      }

      checked++;
      const markdown = example.markdown.replaceAll('→', '\t');
      const expected = example.html.replaceAll('→', '\t');
      const actual = render(markdown);
      if (normalizeHtml(actual) !== normalizeHtml(expected)) {
        mismatches.push({
          id: `#${example.number} ${example.section}`,
          markdown,
          expected,
          actual,
        });
      } else {
        matched++;
      }
    }

    assert.equal(commonMarkExamples.length, 652);
    assert.equal(intentionalDifferences.size, 105);
    assert.deepEqual(exclusions, {
      rawHtmlPolicy: 42,
      htmlBlocks: 44,
      autolinkOrLinkifyPolicy: 19,
    });
    assert.equal(checked, 547);
    assert.equal(matched, 547);
    assert.deepEqual(mismatches, []);
    console.log(JSON.stringify({
      commonmark: {
        totalExamples: commonMarkExamples.length,
        directlyCompared: checked,
        directMatches: matched,
        unexpectedMismatches: mismatches.length,
        excluded: exclusions,
      },
    }));
  });

  it('renders headings, paragraphs, emphasis, links, and code spans', () => {
    const html = render('# Heading\n\n## Repeat\n\n## Repeat\n\nA **strong** and *emphasized* [link](https://example.com) with `code`.');
    assert.match(html, /<h1 id="heading">Heading<\/h1>/);
    assert.match(html, /<h2 id="repeat">Repeat<\/h2>/);
    assert.match(html, /<h2 id="repeat-1">Repeat<\/h2>/);
    assert.match(html, /<strong>strong<\/strong>/);
    assert.match(html, /<em>emphasized<\/em>/);
    assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
    assert.match(html, /<code>code<\/code>/);
  });

  it('renders nested lists, block quotes, fenced code, and hard line breaks', () => {
    const html = render([
      '> quoted',
      '>',
      '> - parent',
      '>   - child',
      '',
      '```text',
      'a < b',
      '```',
      '',
      'line  ',
      'break',
    ].join('\n'));
    assert.match(html, /<blockquote>/);
    assert.match(html, /<li>parent/);
    assert.match(html, /<li>child<\/li>/);
    assert.match(html, /<pre><code class="language-text">a &lt; b\n<\/code><\/pre>/);
    assert.match(html, /line<br>\nbreak/);
  });
});

describe('GFM compatibility', () => {
  it('renders disabled labeled task checkboxes, including nested items, without changing source text', () => {
    const source = [
      '- [x] done',
      '  - [ ] nested pending',
      '- [ ] pending',
      '',
      'Literal [x] text',
    ].join('\n');
    const originalSource = source;
    const html = render(source);

    assert.equal(source, originalSource);
    assert.equal((html.match(/<input\b/g) ?? []).length, 3);
    assert.match(html, /<ul class="contains-task-list">/);
    assert.match(html, /<li class="task-list-item"><input[^>]*checked=""[^>]*disabled=""[^>]*><label class="task-list-item-label" for="task-item-\d+"> done<\/label>/);
    assert.match(html, /<ul class="contains-task-list">\s*<li class="task-list-item"><input[^>]*disabled=""[^>]*><label class="task-list-item-label" for="task-item-\d+"> nested pending<\/label>/);
    assert.equal((html.match(/<input[^>]*disabled=""/g) ?? []).length, 3);
    assert.match(html, /<p>Literal \[x\] text<\/p>/);
    assert.match(html, /<p>Literal \[x\] text<\/p>/);
  });

  it('renders GFM tables, strikethrough, and autolinks', () => {
    const html = render([
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | 1 |',
      '',
      '~~removed~~',
      '',
      '<https://example.com>',
      '',
      'www.example.com',
    ].join('\n'));

    assert.match(html, /<table>/);
    assert.match(html, /<td>alpha<\/td>/);
    assert.match(html, /<s>removed<\/s>/);
    assert.match(html, /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/);
    assert.match(html, /<a href="http:\/\/www\.example\.com">www\.example\.com<\/a>/);
  });
});

describe('HTML and URL safety', () => {
  it('escapes raw script and event-handler HTML', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /<[^>]*\sonerror\s*=/i);
  });

  it('does not emit javascript URLs for links or images', () => {
    const html = render('[unsafe](javascript:alert%281%29)\n\n![unsafe](javascript:alert%281%29)');
    assert.doesNotMatch(html, /href\s*=\s*["']?javascript:/i);
    assert.doesNotMatch(html, /src\s*=\s*["']?javascript:/i);
  });

  it('resolves allowed image sources and omits sources rejected by the Host policy', () => {
    const source = [
      '![local](images/a.svg)',
      '',
      '![remote](https://example.com/a.png)',
      '',
      '![blocked](data:image/svg+xml,%3Csvg%3E)',
    ].join('\n');
    const resolved: string[] = [];
    const html = parseDocument(source, {
      uri: 'file:///workspace/docs/readme.md',
      generation: 1,
      resolveImage: src => {
        resolved.push(src);
        if (src === 'images/a.svg') return 'vscode-webview-resource://workspace/images/a.svg';
        if (src.startsWith('https://')) return src;
        return null;
      },
    }).blocks.map(block => block.html).join('\n');

    assert.deepEqual(resolved, ['images/a.svg', 'https://example.com/a.png']);
    assert.match(html, /src="vscode-webview-resource:\/\/workspace\/images\/a\.svg"/);
    assert.match(html, /src="https:\/\/example\.com\/a\.png"/);
    assert.doesNotMatch(html, /<img\b[^>]*src="[^"]*data:image/i);
  });
});

describe('Mermaid security and cache invalidation', () => {
  it('keeps strict security and varies the SVG cache key by each input', () => {
    assert.equal(MERMAID_SECURITY_LEVEL, 'strict');
    const key = mermaidSvgCacheKey('11.4.1', MERMAID_SECURITY_LEVEL, 'dark', 'abc');
    assert.notEqual(mermaidSvgCacheKey('11.4.2', MERMAID_SECURITY_LEVEL, 'dark', 'abc'), key);
    assert.notEqual(mermaidSvgCacheKey('11.4.1', 'loose', 'dark', 'abc'), key);
    assert.notEqual(mermaidSvgCacheKey('11.4.1', MERMAID_SECURITY_LEVEL, 'light', 'abc'), key);
    assert.notEqual(mermaidSvgCacheKey('11.4.1', MERMAID_SECURITY_LEVEL, 'dark', 'def'), key);
  });
});

describe('Webview queue cleanup', () => {
  it('disconnects highlight observers on disposal', () => {
    let intersectionDisconnects = 0;
    let mutationDisconnects = 0;
    const previousIntersectionObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');

    class TestIntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void { intersectionDisconnects++; }
    }

    class TestMutationObserver {
      observe(): void {}
      disconnect(): void { mutationDisconnects++; }
      takeRecords(): MutationRecord[] { return []; }
    }

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: TestIntersectionObserver,
    });
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      value: TestMutationObserver,
    });

    try {
      const queue = new HighlightQueue();
      queue.attach({ querySelectorAll: () => [] } as unknown as HTMLElement);
      queue.dispose();

      assert.equal(intersectionDisconnects, 1);
      assert.equal(mutationDisconnects, 1);
    } finally {
      if (previousIntersectionObserver) {
        Object.defineProperty(globalThis, 'IntersectionObserver', previousIntersectionObserver);
      } else {
        Reflect.deleteProperty(globalThis, 'IntersectionObserver');
      }
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        Reflect.deleteProperty(globalThis, 'MutationObserver');
      }
    }
  });

  it('clears pending render work and ignores new work after disposal', () => {
    let upsertCount = 0;
    const queue = new RenderQueue({
      upsert: () => { upsertCount++; },
    } as unknown as BlockStore);
    queue.enqueueInsert('pending', '<p>pending</p>');

    queue.dispose();
    queue.enqueueInsert('late', '<p>late</p>');
    queue.flush();

    assert.equal(queue.pending, 0);
    assert.equal(upsertCount, 0);
  });
});
