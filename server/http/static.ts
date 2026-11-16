/**
 * Minimal dependency-free static file server with gzip caching, ETags and an
 * SPA fallback. Used for the built Vite bundle in production.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { applySecurityHeaders } from './respond.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

interface CachedFile {
  mtimeMs: number;
  gzip: Buffer | null;
  etag: string;
}

const fileCache = new Map<string, CachedFile>();

function cacheKey(file: string, mtimeMs: number): string {
  return `${file}:${mtimeMs}`;
}

function isTextType(ext: string): boolean {
  return ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map'].includes(ext);
}

async function loadFile(file: string): Promise<{ buffer: Buffer; etag: string; gzip: Buffer | null }> {
  const stat = statSync(file);
  const cached = fileCache.get(cacheKey(file, stat.mtimeMs));
  if (cached) return { buffer: await readFile(file), etag: cached.etag, gzip: cached.gzip };
  const buffer = await readFile(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const ext = path.extname(file).toLowerCase();
  const gzip = isTextType(ext) && buffer.length > 1024 ? gzipSync(buffer, { level: 6 }) : null;
  fileCache.set(cacheKey(file, stat.mtimeMs), { mtimeMs: stat.mtimeMs, gzip, etag });
  if (fileCache.size > 200) {
    const first = fileCache.keys().next().value;
    if (first) fileCache.delete(first);
  }
  return { buffer, etag, gzip };
}

function safeResolve(staticDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(staticDir, relative);
  const root = path.resolve(staticDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  staticDir: string
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!existsSync(staticDir)) return false;

  let file = safeResolve(staticDir, pathname);
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return true;
  }

  if (existsSync(file)) {
    const stat = statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
    }
  }

  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback for client-side routes; never for asset-like paths.
    if (path.extname(pathname)) return false;
    file = path.join(staticDir, 'index.html');
    if (!existsSync(file)) return false;
  }

  const ext = path.extname(file).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const { etag, gzip } = await loadFile(file);
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const isHtml = ext === '.html';
  const isHashedAsset = /\/assets\//.test(file);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    ETag: etag,
    'Cache-Control': isHtml ? 'no-cache' : isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    Vary: 'Accept-Encoding'
  };
  applySecurityHeaders(res, isHtml);
  if (gzip && acceptEncoding.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(gzip.length);
  } else {
    headers['Content-Length'] = String(statSync(file).size);
  }

  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  if (gzip && acceptEncoding.includes('gzip')) {
    res.end(gzip);
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
  return true;
}
