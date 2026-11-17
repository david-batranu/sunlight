#!/usr/bin/env node
/**
 * End-to-end runner: builds the SPA/server, starts an isolated Sunlight server
 * with seed-only data, then runs tests/e2e/*.test.mjs with Playwright-core.
 *
 *   npm run test:e2e
 *   E2E_SKIP_BUILD=1 npm run test:e2e
 *   CHROME_PATH=/path/to/Chrome npm run test:e2e
 *
 * Tests receive BASE_URL, QA_SHOTS and CHROME_PATH. External network access is
 * blocked inside the browser by the tests.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = path.join(ROOT, 'qa', 'shots');
const CACHE = path.join(ROOT, '.cache', 'e2e');
const node = process.execPath;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env }
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function waitForHealth(baseUrl, timeoutMs = 40_000, child = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch {
      /* server not up yet */
    }
    if (child && child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (code ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`server did not become healthy at ${baseUrl}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  rmSync(CACHE, { recursive: true, force: true });

  if (!process.env.E2E_SKIP_BUILD) {
    console.log('[e2e] building web + server ...');
    await run(node, ['scripts/build-server.mjs']);
    await run(node, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  }

  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html is missing; run without E2E_SKIP_BUILD or `npm run build` first');
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverLogs = '';
  const server = spawn(node, ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CACHE_DIR: CACHE,
      CITY_SOURCE: process.env.E2E_CITY_SOURCE || 'seed',
      SEEDS_ONLY: process.env.E2E_SEEDS_ONLY || '1',
      RATE_LIMIT_PER_MIN: '0',
      // E2E drives one browser from a single loopback address for many page
      // loads; disable the per-client read/sky limits for the test server.
      READ_RATE_LIMIT_PER_MIN: '0',
      SKY_RATE_LIMIT_PER_MIN: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => {
    serverLogs += chunk.toString();
    process.stdout.write(`[server] ${chunk}`);
  });
  server.stderr.on('data', (chunk) => {
    serverLogs += chunk.toString();
    process.stderr.write(`[server:err] ${chunk}`);
  });

  const shutdown = () => {
    if (server.exitCode === null) server.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown);

  try {
    await waitForHealth(baseUrl, 45_000, server);
    console.log(`[e2e] server ready at ${baseUrl}`);

    const tests = existsSync(path.join(ROOT, 'tests', 'e2e'))
      ? (await import('node:fs')).readdirSync(path.join(ROOT, 'tests', 'e2e')).filter((f) => f.endsWith('.test.mjs'))
      : [];
    if (tests.length === 0) {
      console.log('[e2e] no tests/e2e/*.test.mjs files yet — server is healthy, skipping');
      return;
    }

    await run(node, ['--test', '--test-reporter=spec', ...tests.map((f) => path.join('tests/e2e', f))], {
      BASE_URL: baseUrl,
      QA_SHOTS: SHOTS,
      CHROME_PATH: chromePath() || ''
    });
    console.log(`[e2e] screenshots in ${path.relative(ROOT, SHOTS)}`);
  } catch (error) {
    console.error('[e2e] failed');
    console.error(serverLogs.split('\n').slice(-40).join('\n'));
    throw error;
  } finally {
    shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
