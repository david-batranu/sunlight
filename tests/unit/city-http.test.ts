/**
 * Bounded provider body reading: reject oversized uploads before/while
 * buffering rather than after a potentially huge allocation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CityError } from '../../server/city/errors.ts';
import { requestText } from '../../server/city/providers/http.ts';

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers });
}

test('requestText rejects a declared oversized body before reading it', async () => {
  let read = false;
  const fetchImpl = (async () => {
    read = true;
    return streamResponse([new TextEncoder().encode('{}')], { 'content-length': '9999' });
  }) as typeof fetch;
  await assert.rejects(
    requestText({
      url: 'https://example.test/data',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImpl,
      maxBodyBytes: 10
    }),
    (error: unknown) => error instanceof CityError && error.code === 'PROVIDER_TOO_LARGE'
  );
  assert.equal(read, true);
});

test('requestText stops streaming once the cap is crossed', async () => {
  const fetchImpl = (async () =>
    streamResponse([
      new TextEncoder().encode('123456'),
      new TextEncoder().encode('789012')
    ])) as typeof fetch;
  await assert.rejects(
    requestText({
      url: 'https://example.test/data',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetchImpl,
      maxBodyBytes: 8
    }),
    (error: unknown) => error instanceof CityError && error.code === 'PROVIDER_TOO_LARGE'
  );
});

test('requestText still returns bodies under the cap', async () => {
  const fetchImpl = (async () => streamResponse([new TextEncoder().encode('hello')])) as typeof fetch;
  const response = await requestText({
    url: 'https://example.test/data',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetchImpl,
    maxBodyBytes: 64
  });
  assert.equal(response.text, 'hello');
});
