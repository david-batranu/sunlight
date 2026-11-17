#!/usr/bin/env node
/**
 * Deletes the persisted model cache. Useful after a generation-format bump.
 *   npm run cache:clear
 *
 * Safety:
 *  - Deletes only the directory named by CACHE_DIR (or the workspace default).
 *  - Accepts container paths such as /data/cache when CACHE_DIR is set
 *    explicitly (the Docker image uses CACHE_DIR=/data/cache).
 *  - Refuses filesystem roots, the workspace root itself, the home directory
 *    and paths that do not look like a cache directory.
 */

import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const configured = (process.env.CACHE_DIR || '').trim();
const resolved = path.resolve(ROOT, configured || path.join('.cache', 'sunlight'));
const insideWorkspace = resolved === ROOT || resolved.startsWith(ROOT + path.sep);
const home = path.resolve(os.homedir());

/** Cache dirs are named like the documented defaults; anything else needs CACHE_DIR. */
const normalName = ['cache', 'sunlight', '.cache'].includes(path.basename(resolved));
const filesystemRoot = path.parse(resolved).root === resolved;

function refuse(reason) {
  console.error(`Refusing to clear ${resolved}: ${reason}`);
  process.exit(1);
}

if (filesystemRoot) refuse('it is a filesystem root');
if (resolved === ROOT) refuse('it is the workspace root');
if (resolved === home) refuse('it is the home directory');
if (!configured && !insideWorkspace) refuse('CACHE_DIR is not set for an external cache directory');
if (!insideWorkspace && !normalName) {
  refuse('the path does not look like a model cache directory (set CACHE_DIR to the exact cache dir)');
}

rmSync(resolved, { recursive: true, force: true });
const shown = insideWorkspace ? path.relative(ROOT, resolved) : resolved;
console.log(`cleared ${shown}`);
