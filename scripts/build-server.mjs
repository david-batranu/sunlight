#!/usr/bin/env node
/**
 * Bundles the Node server (and its worker) with esbuild.
 * Bundling keeps the Docker runtime image dependency-free.
 */

import { build } from 'esbuild';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUTDIR = path.join(ROOT, 'dist-server');

const entries = [
  { entry: 'server/index.ts', outfile: 'index.js' },
  { entry: 'server/city/worker.ts', outfile: 'worker.js' }
].filter(({ entry }) => existsSync(path.join(ROOT, entry)));

if (!entries.some((e) => e.outfile === 'index.js')) {
  console.error('build-server: server/index.ts is missing');
  process.exit(1);
}

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

for (const { entry, outfile } of entries) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(OUTDIR, outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
    banner: {
      js: '// Sunlight application server bundle'
    }
  });
  console.log(`built dist-server/${outfile}`);
}
