import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), 'markdown-source-preview-tests-'));

try {
  const testFiles = ['rendering.test.ts', 'editing.test.ts'];
  const bundles = [];
  for (const testFile of testFiles) {
    const outfile = join(tempDir, testFile.replace(/\.ts$/, '.cjs'));
    await build({
      entryPoints: [join(projectRoot, 'test', 'unit', testFile)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['commonmark-spec'],
      outfile,
    });
    bundles.push(outfile);
  }

  const result = spawnSync(process.execPath, ['--test', ...bundles], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_PATH: [join(projectRoot, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter),
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
