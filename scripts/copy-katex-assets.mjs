// Copies the KaTeX stylesheet and fonts into dist/katex/ so the webview
// can load them as local resources (the CSP allows no external hosts).
// Only woff2 fonts are copied: the webview is Chromium, and katex.min.css
// lists woff2 first in every @font-face src.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const katexDist = join(projectRoot, 'node_modules', 'katex', 'dist');
const outDir = join(projectRoot, 'dist', 'katex');
const outFontsDir = join(outDir, 'fonts');

mkdirSync(outFontsDir, { recursive: true });
cpSync(join(katexDist, 'katex.min.css'), join(outDir, 'katex.min.css'));
for (const name of readdirSync(join(katexDist, 'fonts'))) {
  if (name.endsWith('.woff2')) {
    cpSync(join(katexDist, 'fonts', name), join(outFontsDir, name));
  }
}
