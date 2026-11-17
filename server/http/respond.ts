/**
 * HTTP response helpers: JSON, errors, gzip, security headers.
 */

import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Ignored over plain HTTP (local development); enforced by browsers on HTTPS.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "form-action 'self'"
].join('; ');

export function applySecurityHeaders(res: ServerResponse, html = false): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (html) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

function isHeadRequest(res: ServerResponse): boolean {
  return res.req?.method === 'HEAD';
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  const acceptEncoding = String(res.req?.headers['accept-encoding'] || '');
  const gzipped = payload.length > GZIP_MIN_BYTES && acceptEncoding.includes('gzip');
  // Compress exactly once and reuse the buffer for the length and the body.
  const wire = gzipped ? gzipSync(payload) : payload;
  if (gzipped) res.setHeader('Content-Encoding', 'gzip');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(wire.length),
    'Cache-Control': 'no-store',
    ...headers
  });
  if (isHeadRequest(res)) {
    res.end();
    return;
  }
  res.end(wire);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; details?: unknown; headers?: Record<string, string> } = {}
): void {
  sendJson(
    res,
    status,
    { error: { code, message, retryable: options.retryable ?? status >= 500, details: options.details } },
    options.headers
  );
}

/**
 * Sends a cached JSON payload that may already be gzipped (models) or has a
 * gzip variant available (sky). Handles ETag revalidation and Accept-Encoding.
 */
export function sendCachedJson(
  res: ServerResponse,
  payload: { json: Buffer; gzip: Buffer | null; etag: string },
  cacheControl: string,
  status = 200
): void {
  const req = res.req;
  const acceptEncoding = String(req?.headers['accept-encoding'] || '');
  const canGzip = payload.gzip !== null && acceptEncoding.includes('gzip');
  const wire = canGzip ? payload.gzip : payload.json;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ETag: payload.etag,
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
    'Content-Length': String(wire?.length ?? 0)
  };
  if (canGzip) headers['Content-Encoding'] = 'gzip';

  if (req && String(req.headers['if-none-match'] || '') === payload.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  if (isHeadRequest(res)) {
    res.end();
    return;
  }
  res.end(wire ?? Buffer.alloc(0));
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store'
  });
  if (isHeadRequest(res)) {
    res.end();
    return;
  }
  res.end(text);
}

export const GZIP_MIN_BYTES = 1024;
