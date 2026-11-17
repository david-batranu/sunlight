/**
 * Client identity extraction for rate limiting.
 *
 * By default the TCP peer address is the client. Behind a reverse proxy that is
 * not true: every request shares the proxy's address. When `TRUST_PROXY` is
 * enabled the forwarded headers are parsed instead:
 *
 * - `X-Forwarded-For` is a comma-separated hop list, left-most = original
 *   client. Proxies *append* the address they received the request from, so the
 *   right-most entries are the trustworthy ones. We walk from the right and use
 *   the first hop that is not a trusted proxy. Without a `TRUSTED_PROXY_CIDRS`
 *   allow-list the direct peer is assumed to be a single trusted proxy and the
 *   right-most valid `X-Forwarded-For` entry is used.
 * - `X-Real-IP` is only consulted when `X-Forwarded-For` is absent.
 * - Invalid/malformed header entries are ignored; an invalid header never
 *   disables rate limiting because we fall back to the socket address.
 *
 * Addresses are normalized before they become bucket keys: IPv4-mapped IPv6
 * (`::ffff:1.2.3.4`) collapses to IPv4 and raw IPv6 addresses are bucketed by
 * their /64 prefix, so a client can not rotate through its own /64 to bypass a
 * limiter (a single host prefix typically owns a whole /64).
 */

import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export interface ClientIpOptions {
  trustProxy: boolean;
  /** CIDRs (or plain addresses) of reverse proxies whose headers are trusted. */
  trustedProxyCidrs?: string[];
}

/** Stable, non-reversible-ish bucket key for a client address. */
export function clientRateKey(req: IncomingMessage, options: ClientIpOptions): string {
  return ipRateLimitKey(extractClientIp(req, options));
}

/**
 * Returns the normalized client IP (canonical IPv4 or expanded IPv6), or
 * `'unknown'` when no address is available at all.
 */
export function extractClientIp(req: IncomingMessage, options: ClientIpOptions): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress ?? null);
  if (!options.trustProxy) return socketIp ?? 'unknown';

  const allowList = (options.trustedProxyCidrs ?? []).filter(Boolean);
  // If an allow-list is configured and the direct peer is not on it, the
  // headers can not be trusted: fall back to the socket address.
  if (allowList.length > 0 && (!socketIp || !allowList.some((cidr) => matchesCidr(socketIp, cidr)))) {
    return socketIp ?? 'unknown';
  }

  const forwarded = parseForwardedFor(readHeader(req, 'x-forwarded-for'));
  if (forwarded.length > 0) {
    if (allowList.length > 0) {
      // Walk from the right-most hop (closest to us) leftwards, skipping the
      // proxies whose addresses are trusted. The first untrusted hop is the
      // client.
      for (let index = forwarded.length - 1; index >= 0; index -= 1) {
        const hop = forwarded[index];
        if (!allowList.some((cidr) => matchesCidr(hop, cidr))) return hop;
      }
      return forwarded[0];
    }
    // Single trusted proxy: it appended the real client address last.
    return forwarded[forwarded.length - 1];
  }

  const realIp = normalizeIp(readHeader(req, 'x-real-ip'));
  if (realIp) return realIp;

  return socketIp ?? 'unknown';
}

/** IPv4 → `v4:a.b.c.d`, IPv6 → `v6:<first 4 hextets>` (/64 bucket). */
export function ipRateLimitKey(ip: string): string {
  const normalized = normalizeIp(ip) ?? ip;
  if (isIP(normalized) === 4) return `v4:${normalized}`;
  if (isIP(normalized) === 6) {
    const groups = expandIpv6(normalized);
    if (groups) return `v6:${groups.slice(0, 4).join(':')}`;
  }
  return 'unknown';
}

/**
 * Normalizes an address: strips ports/brackets and IPv4-mapped prefixes,
 * lowercases and expands IPv6 to its eight hextet groups.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;

  // `[::1]:443` / `[::1]`
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracket) value = bracket[1];

  // `1.2.3.4:5678` (but not bare IPv6, which contains multiple colons)
  if (value.includes(':') && value.indexOf(':') === value.lastIndexOf(':')) {
    const [host, port] = value.split(':');
    if (host && /^\d+$/.test(port ?? '')) value = host;
  }

  if (value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4) {
    value = value.slice(7);
  }

  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) {
    const groups = expandIpv6(value);
    return groups ? groups.join(':') : null;
  }
  return null;
}

/** Parses a comma-separated `X-Forwarded-For` header into valid normalized hops. */
export function parseForwardedFor(header: string | null | undefined): string[] {
  if (!header) return [];
  const hops: string[] = [];
  for (const part of header.split(',')) {
    const normalized = normalizeIp(part);
    if (normalized) hops.push(normalized);
  }
  return hops;
}

/** True when `ip` (normalized by `normalizeIp`) is inside `cidr` (e.g. `10.0.0.0/8`). */
export function matchesCidr(ip: string, cidr: string): boolean {
  const address = normalizeIp(ip);
  if (!address) return false;
  const trimmed = (cidr ?? '').trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf('/');
  const network = normalizeIp(slash >= 0 ? trimmed.slice(0, slash) : trimmed);
  if (!network) return false;
  const family = isIP(address);
  if (family !== isIP(network)) return false;
  const maxBits = family === 4 ? 32 : 128;
  const prefix = slash >= 0 ? Number(trimmed.slice(slash + 1)) : maxBits;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false;

  if (family === 4) {
    const a = ipv4ToInt(address);
    const b = ipv4ToInt(network);
    if (a === null || b === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }

  const a = expandIpv6(address);
  const b = expandIpv6(network);
  if (!a || !b) return false;
  const fullGroups = Math.floor(prefix / 16);
  for (let index = 0; index < fullGroups; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  const remainder = prefix % 16;
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  const groupA = Number.parseInt(a[fullGroups], 16);
  const groupB = Number.parseInt(b[fullGroups], 16);
  return (groupA & mask) === (groupB & mask);
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : null;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) + octet;
  }
  return result >>> 0;
}

/** Expands a valid IPv6 address (possibly with `::`) into eight hex groups. */
function expandIpv6(value: string): string[] | null {
  const raw = value.toLowerCase();
  if (raw.includes('.')) {
    // IPv4-mapped tail: convert to two hex groups.
    const tail = raw.slice(raw.lastIndexOf(':') + 1);
    const mapped = ipv4ToInt(tail);
    if (mapped === null) return null;
    const hi = (mapped >>> 16).toString(16);
    const lo = (mapped & 0xffff).toString(16);
    return expandIpv6(`${raw.slice(0, raw.lastIndexOf(':') + 1)}${hi}:${lo}`);
  }
  const doubleColon = raw.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    head = raw.slice(0, doubleColon).split(':').filter(Boolean);
    tail = raw.slice(doubleColon + 2).split(':').filter(Boolean);
    if (head.length + tail.length > 7) return null;
    const fill = new Array<string>(8 - head.length - tail.length).fill('0');
    head = [...head, ...fill];
  } else {
    head = raw.split(':');
    tail = [];
  }
  const groups = [...head, ...tail];
  if (groups.length !== 8) return null;
  const normalized: string[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    normalized.push(group.replace(/^0+(?=.)/, '') || '0');
  }
  return normalized;
}
