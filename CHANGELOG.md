# Changelog

## 0.2.0

- Render TeX math with KaTeX, matching VS Code's built-in Markdown
  support (@vscode/markdown-it-katex): inline `$...$` inside paragraphs
  and `$$...$$` as its own block kind with inline source editing
- Invalid formulas keep their source visible instead of failing the
  block; currency text such as `$20` is not treated as math
- KaTeX CSS and fonts are bundled into the extension and loaded as
  local webview resources — no CDN and no CSP changes

## 0.1.4

- Fix native textarea shortcuts (select all, cut, copy, paste, undo,
  redo) inside block and insert editors on macOS, where the VS Code
  webview host suppresses the default handling
- Route Cmd/Ctrl+S and Cmd/Ctrl+Enter to apply the current block, and
  Escape to discard uncommitted edits, in both editors

## 0.1.3

- Consolidate parser and protocol types; extract shared loaders and
  idle scheduling in the webview
- Fully isolate LAB diagnostics from production behavior; production
  bundles contain no edit metrics or table-queue telemetry
- Merge Mermaid security/cache contract into `mermaidTheme.ts` and
  drop `mermaidSecurity.ts`

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
