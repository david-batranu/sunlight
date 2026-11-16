/**
 * Request body helpers with a hard size limit.
 */

import type { IncomingMessage } from 'node:http';
import { HttpError } from './http-error.ts';

export async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new HttpError(400, 'INVALID_BODY', 'A JSON request body is required.');
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function requireObject(value: unknown, code = 'INVALID_BODY'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, code, 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}
