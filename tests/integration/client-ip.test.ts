/**
 * Client identity extraction tests for proxy-aware rate limiting.
 * Pure unit tests over synthetic `IncomingMessage`-shaped objects; no network.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import {
  clientRateKey,
  extractClientIp,
  ipRateLimitKey,
  matchesCidr,
  normalizeIp,
  parseForwardedFor
} from '../../server/http/client-ip.ts';

function fakeRequest(remoteAddress: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

const TRUST = { trustProxy: true } as const;
const NO_TRUST = { trustProxy: false } as const;

test('without TRUST_PROXY the socket address wins and forwarded headers are ignored', () => {
  const request = fakeRequest('203.0.113.5', {
    'x-forwarded-for': '198.51.100.1',
    'x-real-ip': '198.51.100.2'
  });
  assert.equal(extractClientIp(request, NO_TRUST), '203.0.113.5');
  assert.equal(clientRateKey(request, NO_TRUST), 'v4:203.0.113.5');
});

test('with TRUST_PROXY the right-most X-Forwarded-For hop is the client', () => {
  // A single trusted proxy appends the address it received the request from, so
  // attacker-supplied left-most entries must not win.
  const request = fakeRequest('127.0.0.1', {
    'x-forwarded-for': '1.2.3.4, 203.0.113.9'
  });
  assert.equal(extractClientIp(request, TRUST), '203.0.113.9');
  assert.equal(clientRateKey(request, TRUST), 'v4:203.0.113.9');
});

test('with TRUST_PROXY malformed forwarded entries are ignored', () => {
  const request = fakeRequest('127.0.0.1', {
    'x-forwarded-for': 'not-an-ip, , 203.0.113.10:443'
  });
  assert.equal(extractClientIp(request, TRUST), '203.0.113.10');
});

test('X-Real-IP is used only when X-Forwarded-For is absent', () => {
  assert.equal(
    extractClientIp(fakeRequest('127.0.0.1', { 'x-real-ip': '203.0.113.11' }), TRUST),
    '203.0.113.11'
  );
  assert.equal(
    extractClientIp(
      fakeRequest('127.0.0.1', { 'x-real-ip': '203.0.113.11', 'x-forwarded-for': '203.0.113.12' }),
      TRUST
    ),
    '203.0.113.12'
  );
});

test('forwarded headers fall back to the socket address when nothing valid is present', () => {
  const request = fakeRequest('127.0.0.1', { 'x-forwarded-for': 'garbage, ;;', 'x-real-ip': 'nope' });
  assert.equal(extractClientIp(request, TRUST), '127.0.0.1');
  assert.equal(extractClientIp(fakeRequest(undefined, {}), TRUST), 'unknown');
});

test('a configured trusted-proxy allow-list rejects headers from untrusted peers', () => {
  const request = fakeRequest('203.0.113.50', { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(
    extractClientIp(request, { trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8'] }),
    '203.0.113.50'
  );
  const trustedPeer = fakeRequest('10.1.2.3', { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(
    extractClientIp(trustedPeer, { trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8'] }),
    '198.51.100.7'
  );
});

test('a multi-proxy chain walks from the right, skipping trusted proxies', () => {
  // Client -> Caddy A (10.0.0.5) -> internal proxy B (10.0.0.6) -> app
  const request = fakeRequest('10.0.0.6', {
    'x-forwarded-for': '203.0.113.20, 10.0.0.5'
  });
  assert.equal(
    extractClientIp(request, { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/24'] }),
    '203.0.113.20'
  );
});

test('IPv4-mapped IPv6 addresses collapse to IPv4 keys', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipRateLimitKey('::ffff:203.0.113.9'), 'v4:203.0.113.9');
  assert.equal(extractClientIp(fakeRequest('::ffff:203.0.113.9'), NO_TRUST), '203.0.113.9');
});

test('IPv6 clients are bucketed by /64 so a host prefix cannot rotate keys', () => {
  const first = ipRateLimitKey('2001:db8:abcd:1234::1');
  const second = ipRateLimitKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
  const other = ipRateLimitKey('2001:db8:abcd:9999::1');
  assert.equal(first, 'v6:2001:db8:abcd:1234');
  assert.equal(second, first);
  assert.notEqual(other, first);
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8:0:0:0:0:0:1');
});

test('parseForwardedFor keeps only valid normalized hops', () => {
  assert.deepEqual(parseForwardedFor('1.2.3.4, nope, [2001:db8::1]'), ['1.2.3.4', '2001:db8:0:0:0:0:0:1']);
  assert.deepEqual(parseForwardedFor(undefined), []);
});

test('matchesCidr supports IPv4, IPv6 and exact addresses', () => {
  assert.equal(matchesCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(matchesCidr('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(matchesCidr('127.0.0.1', '127.0.0.1'), true);
  assert.equal(matchesCidr('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(matchesCidr('2001:db9::1', '2001:db8::/32'), false);
  assert.equal(matchesCidr('10.0.0.1', '2001:db8::/32'), false);
  assert.equal(matchesCidr('10.0.0.1', 'not-a-cidr'), false);
  assert.equal(matchesCidr('anything', '0.0.0.0/0'), false);
});
