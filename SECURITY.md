# Security Policy

## Supported versions

Only the latest released version is supported with security fixes.

## Reporting

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/0x2fff/markdown-source-preview/security/advisories/new).
Do not open public issues for security reports.

We aim to provide an initial response within 7 days.

## Security model

- Raw HTML in Markdown is escaped and never rendered as active content.
- Unsafe URL schemes (`javascript:`, `data:`, etc.) are rejected.
- External images are limited to `https:` URLs; local images are restricted
  to approved resource roots.
- Mermaid diagrams render with `securityLevel: strict`; diagram markup is
  sanitized and foreign content is blocked.
- The webview loads no remote scripts. Bundled code and icon data only.
- Webview scripts are protected by a nonce-based Content Security Policy.
- Read-only documents (non-writable files, unsupported schemes) cannot be
  modified through the preview.
