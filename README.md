# Markdown Source Preview

**Click the preview. Edit the Markdown.**

Read rendered Markdown and edit each block's source inline.

A source-preserving Markdown preview for Visual Studio Code.

Markdown Source Preview renders large Markdown documents and lets you select a
rendered block to edit its Markdown source in an inline source editor at the
same position. The edit is applied to the original Markdown file, which
remains the single source of truth. It is not a rich-text or WYSIWYG editor.

## Features

- **Viewport-first rendering** — large documents (multi-MB) render
  progressively; expensive work (syntax highlighting, Mermaid) is deferred
  until blocks approach the viewport
- **Inline block editing** — select any supported block in edit mode to edit
  its Markdown source inline; scroll stays stable
- **New block insertion** — add Markdown at gaps between blocks, at the
  document start or end, and in an empty document
- **Source fidelity** — edits are applied as precise source-range patches
  to the selected block; content outside the edited source range is
  preserved
- **Mermaid diagrams** — lazy rendering with caching, bundled icon packs,
  Ctrl/Cmd+scroll zoom and Alt/Option+drag pan
- **Scroll sync** — preview and source editor positions stay in sync
- **Read-only safe** — non-writable documents open in a protected mode
- **External-change conflict detection** — edits against stale documents
  are rejected rather than silently overwritten

## Installation

Install from the Visual Studio Marketplace:

```sh
code --install-extension 0x2fff.markdown-source-preview
```

Or search for **Markdown Source Preview** in the Extensions view
(`Ext` → search `@installed` / Marketplace).

For local development builds, package and install the generated VSIX:

```sh
npm ci
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension markdown-source-preview-*.vsix
```

Then open any `.md` file — Markdown Source Preview appears as a preview editor
option ("Reopen Editor With…" → Markdown Source Preview).

## Reading and Editing

- **Edit mode** (default for writable documents): toggle via the status
  bar icon, or the commands `Markdown Source Preview: Toggle Edit Mode` /
  `Enter Edit Mode` / `Exit Edit Mode`. Selecting an editable block opens an
  inline source editor containing that block's full Markdown source.
  `Cmd/Ctrl+S` or blur saves; `Esc` discards. Read-only documents stay in a
  protected read-only mode.

## Supported blocks

| Block | Render | Source editing |
|---|:---:|---:|
| Heading, paragraph, blockquote | ✅ | ✅ |
| Bullet / ordered / task lists | ✅ | ✅ |
| Table | ✅ | ✅ |
| Fenced code (syntax highlighted) | ✅ | ✅ |
| Indented code | ✅ | ✅ |
| Mermaid | ✅ | ✅ |
| Frontmatter (collapsible) | ✅ | ✅ |
| Raw HTML | Escaped | ✅ |

## Mermaid icons

Architecture diagrams support the `logos:` icon pack (bundled,
lazy-loaded, works offline). Custom icon packs are not yet supported.

## Configuration

See `package.json` `contributes.configuration` for settings such as
`markdownSourcePreview.initialBlockLimit` and `markdownSourcePreview.debounceMs`.

## Security

Raw HTML is escaped, unsafe URL schemes are rejected, Mermaid runs at
`securityLevel: strict`, and the webview is locked down by a nonce-based
CSP. Markdown Source Preview does not load remote scripts; `https:` images
referenced by the document may be loaded by the webview. See
`SECURITY.md` for the security model and reporting.

## Development

```sh
npm ci
npm run typecheck
npm run build
```

Tests are maintained separately and are not included in this repository.

## License

MIT — see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
