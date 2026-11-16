#!/usr/bin/env node
/**
 * Deletes the persisted model cache. Useful after a generation-format bump.
 *   npm run cache:clear
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheDir = path.resolve(ROOT, process.env.CACHE_DIR || path.join('.cache', 'sunlight'));
const resolved = path.resolve(cacheDir);
if (!resolved.startsWith(path.resolve(ROOT))) {
  console.error(`Refusing to delete a cache outside the workspace: ${resolved}`);
  process.exit(1);
}
rmSync(resolved, { recursive: true, force: true });
console.log(`cleared ${path.relative(ROOT, resolved)}`);
