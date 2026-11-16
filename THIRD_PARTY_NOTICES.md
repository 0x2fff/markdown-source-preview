# Third-Party Notices

Markdown Source Preview bundles or depends on the following packages at build time.
Versions are pinned in `package-lock.json`.

## Runtime dependencies (bundled into dist/)

| Package | License | Use |
|---|---|---|
| markdown-it | MIT | Markdown parsing/rendering |
| markdown-it-task-lists | ISC | GFM task lists |
| highlight.js | BSD-3-Clause | Syntax highlighting (lazy-loaded) |
| mermaid | MIT | Diagram rendering (lazy-loaded) |
| @iconify-json/logos | CC0-1.0 | Mermaid architecture icon pack (lazy-loaded) |

## Development dependencies

| Package | License | Use |
|---|---|---|
| typescript | Apache-2.0 | Type checking |
| esbuild | MIT | Bundling |
| @types/node | MIT | Node.js types |
| @types/vscode | MIT | VS Code API types |
| @types/markdown-it | MIT | markdown-it types |

## Notes

- `@iconify-json/logos` icon data is CC0-1.0 (public domain dedication).
- Icon data may include third-party brand logos. All product names,
  logos, and brands are property of their respective owners.
  Markdown Source Preview is not affiliated with or endorsed by Amazon Web
  Services or other icon owners.
- All code and icon data is bundled locally; no remote scripts are
  fetched at runtime. `https:` images referenced by a document may be
  loaded by the webview.
