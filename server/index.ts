/**
 * Sunlight application server — entry point.
 */

import { loadConfig } from './config.ts';
import { startSunlightApp } from './app.ts';

const config = loadConfig();
const app = await startSunlightApp(config);
console.log(`[sunlight] listening on ${app.url}`);
console.log(`[sunlight] static: ${config.staticDir}`);
console.log(`[sunlight] cache: ${config.cacheDir}`);
console.log(`[sunlight] source: ${config.citySource}, radius: ${config.cityRadiusM}m`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sunlight] ${signal}, shutting down`);
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
