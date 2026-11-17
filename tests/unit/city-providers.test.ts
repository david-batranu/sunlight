/**
 * Provider tests. Every network call is mocked with a local `fetch` stub; no
 * test touches the network.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { CityError } from '../../server/city/errors.ts';
import type { ProviderFetchRequest, ProviderStatus } from '../../server/city/providers/types.ts';
import { createFixtureProvider } from '../../server/city/providers/fixture.ts';
import { createOverpassProvider, buildOverpassQuery } from '../../server/city/providers/overpass.ts';
import { createOsmApiProvider, quarterBoxes } from '../../server/city/providers/osm-api.ts';
import { createProviderChain } from '../../server/city/providers/chain.ts';
import { TokenBucket } from '../../server/city/providers/bucket.ts';
import type { FetchLike } from '../../server/city/providers/http.ts';
import {
  BRASOV_CITY,
  FIXTURES_DIR,
  makeTempDir,
  makeTestConfig,
  removeTempDir
} from './city-helpers.ts';

const OVERPASS_JSON = JSON.stringify({
  version: 0.6,
  elements: [
    { type: 'node', id: 1, lat: 45.648, lon: 25.606 },
    { type: 'node', id: 2, lat: 45.649, lon: 25.607 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential' } }
  ]
});

async function osmXmlFixture(): Promise<string> {
  return readFile(path.join(FIXTURES_DIR, 'raw-tile.xml'), 'utf8');
}

function fakeRequest(overrides: Partial<ProviderFetchRequest> = {}): ProviderFetchRequest & { progress: number[] } {
  const progress: number[] = [];
  return {
    target: { kind: 'city', geonameId: 683844 },
    center: { lat: BRASOV_CITY.lat, lon: BRASOV_CITY.lon },
    radiusM: 900,
    signal: new AbortController().signal,
    onProgress: (percent) => progress.push(percent),
    progress,
    ...overrides
  };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

test('fixture provider parses the raw-city fixture without network', async () => {
  const provider = createFixtureProvider({ dir: FIXTURES_DIR });
  assert.equal(provider.status(), 'unknown');
  const request = fakeRequest();
  const raw = await provider.fetchRaw(request);
  assert.equal(raw.source, 'fixture');
  assert.equal(raw.ways.length, 26);
  assert.equal(raw.relations.length, 2);
  assert.equal(provider.status(), 'up');
  assert.ok(request.progress.length > 0);
  for (let i = 1; i < request.progress.length; i += 1) {
    assert.ok(request.progress[i] >= request.progress[i - 1]);
  }
});

test('fixture provider re-centres declared fixture geometry for other targets', async () => {
  const provider = createFixtureProvider({ dir: FIXTURES_DIR });
  const original = await provider.fetchRaw(fakeRequest()); // Brașov (fixture centre)
  const center = { lat: 44.43225, lon: 26.10626 }; // Bucharest
  const recentered = await provider.fetchRaw(
    fakeRequest({ target: { kind: 'city', geonameId: 683506 }, center })
  );
  const deltaLat = center.lat - BRASOV_CITY.lat;
  const deltaLon = center.lon - BRASOV_CITY.lon;
  const before = original.ways[0].geometry ?? [];
  const after = recentered.ways[0].geometry ?? [];
  assert.equal(before.length, after.length);
  assert.ok(before.length > 0);
  for (let i = 0; i < before.length; i += 1) {
    assert.ok(Math.abs(after[i].lat - (before[i].lat + deltaLat)) < 1e-9);
    assert.ok(Math.abs(after[i].lon - (before[i].lon + deltaLon)) < 1e-9);
  }
  // And the whole sample stays inside the requested 1.8 km square.
  for (const way of recentered.ways) {
    for (const coordinate of way.geometry ?? []) {
      const northMetres = (coordinate.lat - center.lat) * 111_320;
      const eastMetres =
        (coordinate.lon - center.lon) * 111_320 * Math.cos((center.lat * Math.PI) / 180);
      assert.ok(Math.abs(northMetres) < 1000 && Math.abs(eastMetres) < 1000);
    }
  }
});

test('fixture provider reports a clear 404 for missing fixtures', async () => {
  const dir = await makeTempDir('sunlight-fixture-');
  try {
    const provider = createFixtureProvider({ dir });
    await assert.rejects(
      provider.fetchRaw(fakeRequest()),
      (error: unknown) => error instanceof CityError && error.code === 'FIXTURE_MISSING' && error.status === 404
    );
    assert.equal(provider.status(), 'down');
  } finally {
    await removeTempDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* Overpass                                                            */
/* ------------------------------------------------------------------ */

test('buildOverpassQuery requests inline geometry for every bbox', () => {
  const request = fakeRequest();
  const query = buildOverpassQuery(request);
  assert.match(query, /\[out:json\]\[timeout:\d+\]/);
  assert.match(query, /out tags geom/);
  assert.match(query, /way\["building"\]/);
  assert.match(query, /relation\["natural"/);
  assert.match(query, /\(-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6}\)/);
  assert.equal((query.match(/way\["building"\]/g) ?? []).length, 1);

  // Antimeridian cities need two bbox groups.
  const antimeridian = buildOverpassQuery(fakeRequest({ center: { lat: 0, lon: 179.999 } }));
  assert.equal((antimeridian.match(/way\["building"\]/g) ?? []).length, 2);
});

test('overpass provider posts the query with the configured User-Agent', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(OVERPASS_JSON);
  };
  const provider = createOverpassProvider({
    endpoints: ['https://overpass.test/api/interpreter'],
    userAgent: 'SunlightTest/1.0',
    fetchImpl,
    sleep: async () => undefined
  });
  const request = fakeRequest();
  const raw = await provider.fetchRaw(request);
  assert.equal(raw.source, 'overpass');
  assert.equal(raw.ways.length, 1);
  assert.equal(provider.status(), 'up');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://overpass.test/api/interpreter');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['User-Agent'], 'SunlightTest/1.0');
  const form = new URLSearchParams(String(calls[0].init?.body));
  assert.ok(form.has('data'), 'request body is form-encoded Overpass data');
  assert.match(form.get('data') ?? '', /out tags geom/);
  assert.ok(request.progress.length > 0);
});

test('overpass provider rotates to the next endpoint after a retryable failure', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('primary')) return textResponse('upstream down', 503);
    return jsonResponse(OVERPASS_JSON);
  };
  const provider = createOverpassProvider({
    endpoints: ['https://primary.test/api', 'https://backup.test/api'],
    userAgent: 'SunlightTest/1.0',
    fetchImpl,
    sleep: async () => undefined
  });
  const raw = await provider.fetchRaw(fakeRequest());
  assert.equal(raw.ways.length, 1);
  assert.equal(provider.status(), 'up');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /primary/);
  assert.match(calls[1], /backup/);
});

test('overpass provider surfaces total failure as a retryable CityError', async () => {
  const fetchImpl: FetchLike = async () => textResponse('saturated', 503);
  const provider = createOverpassProvider({
    endpoints: ['https://a.test/api', 'https://b.test/api'],
    userAgent: 'SunlightTest/1.0',
    fetchImpl,
    sleep: async () => undefined
  });
  await assert.rejects(
    provider.fetchRaw(fakeRequest()),
    (error: unknown) =>
      error instanceof CityError && error.code === 'PROVIDER_FAILED' && error.status === 502 && error.retryable
  );
  assert.equal(provider.status(), 'down');
});

test('overpass provider converts request timeouts into retryable failures', async () => {
  const fetchImpl: FetchLike = async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const provider = createOverpassProvider({
    endpoints: ['https://slow.test/api'],
    userAgent: 'SunlightTest/1.0',
    timeoutMs: 20,
    fetchImpl,
    sleep: async () => undefined
  });
  await assert.rejects(
    provider.fetchRaw(fakeRequest()),
    (error: unknown) => error instanceof CityError && error.retryable === true
  );
  assert.equal(provider.status(), 'down');
});

/* ------------------------------------------------------------------ */
/* OSM API fallback                                                    */
/* ------------------------------------------------------------------ */

test('osm-api provider fetches a single tile and parses OSM XML', async () => {
  const xml = await osmXmlFixture();
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    urls.push(String(input));
    return textResponse(xml);
  };
  const provider = createOsmApiProvider({
    baseUrl: 'https://osm.test/api/0.6/map',
    userAgent: 'SunlightTest/1.0',
    fetchImpl,
    sleep: async () => undefined
  });
  const raw = await provider.fetchRaw(fakeRequest());
  assert.equal(raw.source, 'osm-api');
  assert.equal(raw.ways.length, 4);
  assert.equal(raw.nodes.length, 12);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/osm\.test\/api\/0\.6\/map\?bbox=-?\d/);
  assert.equal(provider.status(), 'up');
});

test('osm-api provider quarters tiles that exceed the node limit', async () => {
  const xml = await osmXmlFixture();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      return textResponse('You requested too many nodes (limit 50000). Perhaps reduce the bbox.', 400);
    }
    return textResponse(xml);
  };
  const provider = createOsmApiProvider({
    baseUrl: 'https://osm.test/api/0.6/map',
    userAgent: 'SunlightTest/1.0',
    fetchImpl,
    sleep: async () => undefined
  });
  const raw = await provider.fetchRaw(fakeRequest());
  assert.equal(calls.length, 5, 'one parent request plus four quarters');
  // Overlapping tiles return the same elements; ids are merged.
  assert.equal(raw.ways.length, 4);
  assert.equal(provider.status(), 'up');
});

test('quarterBoxes adds a 10% overlap around the seams', () => {
  const box = { south: 44.0, west: 25.0, north: 44.1, east: 25.2 };
  const quarters = quarterBoxes(box);
  assert.equal(quarters.length, 4);
  assert.equal(quarters[0].south, box.south);
  assert.equal(quarters[0].west, box.west);
  assert.ok(quarters[0].north > 44.05, 'southern tiles extend past the middle');
  assert.ok(quarters[0].east > 25.1, 'western tiles extend past the middle');
  assert.equal(quarters[3].north, box.north);
  assert.equal(quarters[3].east, box.east);
});

test('osm-api provider fails clearly after retries are exhausted', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new TypeError('fetch failed');
  };
  const provider = createOsmApiProvider({
    baseUrl: 'https://osm.test/api/0.6/map',
    userAgent: 'SunlightTest/1.0',
    retries: 1,
    fetchImpl,
    sleep: async () => undefined
  });
  await assert.rejects(
    provider.fetchRaw(fakeRequest()),
    (error: unknown) => error instanceof CityError && error.code === 'PROVIDER_FAILED' && error.retryable
  );
  assert.equal(provider.status(), 'down');
});

/* ------------------------------------------------------------------ */
/* Chain                                                               */
/* ------------------------------------------------------------------ */

function chainConfig(overrides: Parameters<typeof makeTestConfig>[1] = {}) {
  const dir = path.join(FIXTURES_DIR, '..', '..', '..', '.cache', 'test-config');
  return makeTestConfig(dir, overrides);
}

test('auto chain falls back from Overpass to the tiled OSM API', async () => {
  const xml = await osmXmlFixture();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('overpass')) return textResponse('saturated', 503);
    return textResponse(xml);
  };
  const chain = createProviderChain(
    chainConfig({ citySource: 'auto', overpassEndpoints: ['https://overpass.test/api'] }),
    {
      fetchImpl,
      sleep: async () => undefined,
      overpassEndpoints: ['https://overpass.test/api'],
      osmApiBaseUrl: 'https://osm.test/api/0.6/map'
    }
  );
  assert.equal(chain.canGenerate, true);
  const raw = await chain.fetchRaw(fakeRequest());
  assert.equal(raw.source, 'osm-api');
  assert.ok(raw.warnings.some((warning) => warning.includes('overpass')));
  const statuses = chain.statuses();
  assert.equal(statuses.overpass, 'down');
  assert.equal(statuses['osm-api'], 'up');
  assert.ok(calls.some((url) => url.includes('overpass')));
  assert.ok(calls.some((url) => url.includes('osm.test')));
});

test('auto chain reports MODEL_FAILED when both providers fail', async () => {
  const fetchImpl: FetchLike = async () => textResponse('nope', 503);
  const chain = createProviderChain(
    chainConfig({ citySource: 'auto', overpassEndpoints: ['https://overpass.test/api'] }),
    {
      fetchImpl,
      sleep: async () => undefined,
      overpassEndpoints: ['https://overpass.test/api'],
      osmApiBaseUrl: 'https://osm.test/api/0.6/map'
    }
  );
  await assert.rejects(
    chain.fetchRaw(fakeRequest()),
    (error: unknown) => error instanceof CityError && error.code === 'MODEL_FAILED' && error.retryable
  );
});

test('CITY_SOURCE=fixture never touches the network', async () => {
  const networkFetch: FetchLike = async () => {
    throw new Error('network must not be used in fixture mode');
  };
  const chain = createProviderChain(chainConfig({ citySource: 'fixture' }), {
    fetchImpl: networkFetch
  });
  const raw = await chain.fetchRaw(fakeRequest());
  assert.equal(raw.source, 'fixture');
  assert.equal(raw.ways.length, 26);
  assert.equal(chain.statuses().fixture, 'up');
  assert.equal(chain.statuses().overpass, undefined);
});

test('seed mode and SEEDS_ONLY disable generation without network access', async () => {
  const networkFetch: FetchLike = async () => {
    throw new Error('network must not be used in seed mode');
  };
  for (const config of [
    chainConfig({ citySource: 'seed' }),
    chainConfig({ citySource: 'auto', seedsOnly: true })
  ]) {
    const chain = createProviderChain(config, { fetchImpl: networkFetch });
    assert.equal(chain.canGenerate, false);
    await assert.rejects(
      chain.fetchRaw(fakeRequest()),
      (error: unknown) => error instanceof CityError && error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503
    );
  }
});

test('providerStatusCode values are part of the health contract', () => {
  const statuses: ProviderStatus[] = ['up', 'down', 'unknown'];
  assert.deepEqual(statuses, ['up', 'down', 'unknown']);
});

/* ------------------------------------------------------------------ */
/* Upstream budget / retry timing                                      */
/* ------------------------------------------------------------------ */

test('overpass provider does not sleep after the final failed attempt', async () => {
  const sleeps: number[] = [];
  const provider = createOverpassProvider({
    endpoints: ['https://only.test/api'],
    userAgent: 'SunlightTest/1.0',
    retryBackoffMs: 25,
    fetchImpl: async () => textResponse('saturated', 503),
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  await assert.rejects(provider.fetchRaw(fakeRequest()));
  // maxAttempts = max(2, endpoints*2) = 2 → exactly one inter-attempt backoff.
  assert.deepEqual(sleeps, [25]);
});

test('overpass provider honours a Retry-After header between attempts', async () => {
  const sleeps: number[] = [];
  const calls: number[] = [];
  const fetchImpl: FetchLike = async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } });
    }
    return jsonResponse(OVERPASS_JSON);
  };
  const provider = createOverpassProvider({
    endpoints: ['https://retry.test/api'],
    userAgent: 'SunlightTest/1.0',
    retryBackoffMs: 10,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  const raw = await provider.fetchRaw(fakeRequest());
  assert.equal(raw.ways.length, 1);
  assert.deepEqual(sleeps, [2000], 'Retry-After must win over the shorter backoff');
});

test('upstream token buckets refill at the configured rate', () => {
  let now = 0;
  const bucket = new TokenBucket({ ratePerSec: 1, burst: 2, now: () => now });
  assert.equal(bucket.reserve(), 0);
  assert.equal(bucket.reserve(), 0);
  const wait = bucket.reserve();
  assert.ok(wait >= 900 && wait <= 1100, `expected ~1000 ms wait, got ${wait}`);
  now += wait;
  assert.equal(bucket.reserve(), 0, 'one token is available after waiting the interval');
  const nextWait = bucket.reserve();
  assert.ok(nextWait >= 900, `bucket must wait again when empty, got ${nextWait}`);
  assert.ok(bucket.waitedMs >= wait + nextWait);
});

test('osm-api provider flags partial coverage when the tile budget is exhausted', async () => {
  const xml = await osmXmlFixture();
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) {
      return textResponse('You requested too many nodes (limit 50000).', 400);
    }
    return textResponse(xml);
  };
  const provider = createOsmApiProvider({
    baseUrl: 'https://osm.test/api/0.6/map',
    userAgent: 'SunlightTest/1.0',
    maxTiles: 2,
    fetchImpl,
    sleep: async () => undefined
  });
  const raw = await provider.fetchRaw(fakeRequest());
  assert.equal(raw.source, 'osm-api');
  assert.equal(raw.partial, true, 'budget-skipped tiles must mark the raw data partial');
  assert.ok(raw.warnings.some((warning) => /budget/i.test(warning)));
  assert.equal(provider.status(), 'up');
});

test('osm-api retry spacing honours Retry-After instead of the default backoff', async () => {
  const sleeps: number[] = [];
  const xml = await osmXmlFixture();
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } });
    }
    return textResponse(xml);
  };
  const provider = createOsmApiProvider({
    baseUrl: 'https://osm.test/api/0.6/map',
    userAgent: 'SunlightTest/1.0',
    retries: 1,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  await provider.fetchRaw(fakeRequest());
  assert.ok(sleeps.includes(3000), `expected a 3000 ms Retry-After sleep, got ${sleeps.join(',')}`);
});
