# Changelog

## 0.1.2

- Fix Mermaid diagrams keeping stale theme colors after a theme switch
- Split webview insert editor and save-state controllers out of main.ts
- Diagnostics builds fully separated; production bundles no longer
  contain edit metrics or patch timing code
- Type markdown-it usage and trim redundant comments
- Rename `initialSourceBytes` setting to `initialHtmlCharLimit`

## 0.1.1

- Fix insert marker activation: open on pointerdown, enlarge hit area,
  and keep the marker visible when the pointer moves onto it
- Dependency updates: markdown-it 15, TypeScript 7, esbuild 0.28,
  @types/node 26, VS Code actions majors

## 0.1.0

- Inline block editing (headings, paragraphs, lists, tables, code,
  blockquotes, Mermaid, frontmatter) with inline source editors
- New block insertion at gaps between blocks, document start/end, and
  in empty documents
- Frontmatter collapsible rendering
- Mermaid architecture icons via bundled `logos` icon pack
- Ctrl/Cmd+scroll zoom and Alt+drag pan for diagrams
- Read/edit mode toggle with status bar indicator
- Scroll synchronization between source and preview
- Correct block placement when Undo restores a deleted block
