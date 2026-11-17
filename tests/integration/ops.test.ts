/**
 * Operational script tests: container-safe cache clearing.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { REPO_ROOT } from '../unit/city-helpers.ts';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'clear-cache.mjs');

async function runClear(cacheDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, CACHE_DIR: cacheDir }
  });
}

test('clear-cache accepts a container-style external CACHE_DIR', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sunlight-ops-'));
  const cacheDir = path.join(root, 'cache');
  try {
    mkdirSync(path.join(cacheDir, 'models'), { recursive: true });
    writeFileSync(path.join(cacheDir, 'models', 'gn-1-r1500-v4.json.gz'), 'x');
    const { stdout } = await runClear(cacheDir);
    assert.match(stdout, /cleared/);
    assert.equal(existsSync(cacheDir), false, 'cache directory must be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clear-cache refuses filesystem roots and non-cache directories', async () => {
  await assert.rejects(
    runClear(path.parse(process.cwd()).root),
    (error: unknown) => (error as { code?: number }).code === 1
  );
  const root = mkdtempSync(path.join(os.tmpdir(), 'sunlight-ops-'));
  const notACache = path.join(root, 'precious-data');
  try {
    mkdirSync(notACache, { recursive: true });
    writeFileSync(path.join(notACache, 'keep.txt'), 'keep me');
    await assert.rejects(
      runClear(notACache),
      (error: unknown) => (error as { code?: number }).code === 1
    );
    assert.equal(existsSync(path.join(notACache, 'keep.txt')), true, 'nothing may be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
