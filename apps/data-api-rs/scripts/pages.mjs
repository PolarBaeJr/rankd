// Writes the two public HTML pages the Rust binary serves, from the
// TypeScript modules that are their source of truth:
//   src/docs/documentations.html  <- apps/data-api/src/docs-page.ts DOCS_HTML
//   src/docs/changelog.html       <- apps/data-api/src/changelog-page.ts CHANGELOG_HTML
//
//   node apps/data-api-rs/scripts/pages.mjs           rewrite both files
//   node apps/data-api-rs/scripts/pages.mjs --check   exit 1 when either is stale
//
// The TypeScript is compiled with the workspace's tsc into a temporary
// directory, so nothing is written into apps/data-api.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(rustRoot, '../..');
const tsSources = path.join(repoRoot, 'apps/data-api/src');
const checking = process.argv.includes('--check');

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-api-pages-'));
try {
  const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      '--outDir', buildDir,
      '--rootDir', tsSources,
      '--target', 'ES2023',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--skipLibCheck',
      '--types', 'node',
      path.join(tsSources, 'docs-page.ts'),
      path.join(tsSources, 'changelog-page.ts'),
    ],
    { stdio: 'inherit', cwd: repoRoot },
  );
  // NodeNext emits ESM only when the nearest package.json says so.
  fs.writeFileSync(path.join(buildDir, 'package.json'), '{"type":"module"}\n');
  const { DOCS_HTML } = await import(pathToFileURL(path.join(buildDir, 'docs-page.js')).href);
  const { CHANGELOG_HTML } = await import(pathToFileURL(path.join(buildDir, 'changelog-page.js')).href);

  const pages = [
    ['src/docs/documentations.html', DOCS_HTML],
    ['src/docs/changelog.html', CHANGELOG_HTML],
  ];
  let stale = 0;
  for (const [relative, html] of pages) {
    const target = path.join(rustRoot, relative);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === html) continue;
    if (checking) {
      console.error(`stale: apps/data-api-rs/${relative} (run node apps/data-api-rs/scripts/pages.mjs)`);
      stale += 1;
    } else {
      fs.writeFileSync(target, html);
      console.log(`wrote apps/data-api-rs/${relative}`);
    }
  }
  if (stale > 0) process.exitCode = 1;
  else if (checking) console.log('pages OK: both match the TypeScript service');
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
