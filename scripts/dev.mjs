#!/usr/bin/env node
/**
 * Development runner: starts the API server (watch mode) and Vite together.
 *   npm run dev
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const children = [];
let shuttingDown = false;

function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false
  });
  child.label = label;
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] ${label} exited (${code ?? signal})`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', node, ['--watch', 'server/index.ts'], {
  PORT: process.env.PORT || '8090',
  HOST: process.env.HOST || '127.0.0.1'
});
start('web', node, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
  FORCE_COLOR: '1'
});

console.log('[dev] API expected on http://127.0.0.1:8090, SPA on http://127.0.0.1:5173');
