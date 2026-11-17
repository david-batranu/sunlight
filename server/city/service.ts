/**
 * City service facade — the public API of the city subsystem.
 *
 * Responsibilities:
 *  - GeoNames search index (diacritic-insensitive search + nearest city).
 *  - Target resolution to canonical cache/URL keys.
 *  - Seed → cache → job-queue model resolution (`ensureModel` never blocks for
 *    the duration of generation).
 *  - Generation jobs: provider fetch on the main thread (I/O), geometry build in
 *    a `worker_threads` worker, atomic gzip cache write, monotonic progress,
 *    dedupe and cancellation.
 *  - Health reporting for the HTTP layer.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import tzlookup from 'tz-lookup';

import type { AppConfig } from '../config.ts';
import type {
  CityInfo,
  CityModel,
  CitySearchResponse,
  GenerationStep,
  HealthCheck,
  JobStatus,
  ModelMeta,
  ModelTarget,
  NearestCityResponse
} from '../../shared/types.ts';
import { buildCityModel, type BuildInput, type BuildProgressEvent } from './build.ts';
import { CityIndex } from './city-index.ts';
import type {
  CityService,
  CityServiceHealth,
  EnsureModelOptions,
  EnsureModelResult,
  ReadyModel,
  ResolvedTarget
} from './contract.ts';
import { CityError, isAbortError, isCityError, type CityErrorStatus } from './errors.ts';
import { JobQueue, type JobContext } from './job-queue.ts';
import { cityModelKey, formatCoordinate, isValidModelKey, pointModelKey } from './keys.ts';
import { log } from './logger.ts';
import { fetchTerrain } from './elevation.ts';
import { ModelCache, type CachedModel } from './model-cache.ts';
import { gzipModel, modelEtag } from './model-io.ts';
import { rawOsmElementCount, type RawOsmData } from './raw.ts';
import { safeErrorMessage } from './redact.ts';
import { createProviderChain, type ProviderChain } from './providers/chain.ts';
import { SeedStore } from './seed-store.ts';
import type { WorkerBuildRequest, WorkerResponse } from './worker-protocol.ts';

export type {
  CityService,
  CityServiceHealth,
  EnsureModelResult,
  QueuedModel,
  ReadyModel,
  ResolvedTarget
} from './contract.ts';
export { CityError } from './errors.ts';

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 50;
const NEAREST_NAME_RADIUS_KM = 40;
const RECENT_MODEL_LIMIT = 8;
const RECENT_BYTES_LIMIT = 64 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 240_000;
const WORKER_BUILD_TIMEOUT_MS = 120_000;
const MAX_TRACKED_FAILURES = 256;
/**
 * Upper bound on parsed OSM elements for one generation. Provider bodies are
 * capped separately (96 MB); this protects the event loop from pathological
 * dense targets that are valid JSON but expensive to parse/build.
 */
const DEFAULT_MAX_RAW_ELEMENTS = 500_000;

interface BuildArtifact {
  gzipped: Buffer;
  etag: string;
  bytes: number;
  meta: ModelMeta;
}

interface GenerationDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  clear(): void;
}

/** Injection seams used by tests (and to override providers on constrained hosts). */
export interface CityServiceOptions {
  providerChain?: ProviderChain;
  /** Terrain sampler override; tests inject one that fails to exercise degraded models. */
  terrainFetcher?: typeof fetchTerrain;
  /** Worker entry override. `null` forces in-process builds; `undefined` auto-locates. */
  workerEntry?: string | null;
  /** Override the parsed-element cap (tests use a tiny cap). */
  maxRawElements?: number;
}

export function createCityService(config: AppConfig, options: CityServiceOptions = {}): CityService {
  return new CityServiceImpl(config, options);
}

class CityServiceImpl implements CityService {
  private readonly config: AppConfig;
  private readonly options: CityServiceOptions;
  private readonly radiusM: number;
  private readonly modelVersion: number;
  private readonly failureCooldownMs: number;

  private index: CityIndex | null = null;
  private seeds: SeedStore | null = null;
  private cache: ModelCache | null = null;
  private chain: ProviderChain | null = null;
  private jobs: JobQueue | null = null;

  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private shuttingDown = false;
  private workerEntry: string | null = null;
  private workerDisabled = false;
  private workerFallbacks = 0;

  /** Negative cache for recently failed model keys (avoids upstream retry storms). */
  private readonly failures = new Map<string, { until: number; error: CityError }>();

  private readonly recentModels = new Map<string, ReadyModel>();
  private recentBytes = 0;

  constructor(config: AppConfig, options: CityServiceOptions = {}) {
    this.config = config;
    this.options = options;
    this.radiusM = Math.round(config.cityRadiusM);
    this.modelVersion = config.modelVersion;
    this.failureCooldownMs = Math.max(0, config.failureCooldownSec) * 1000;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error: unknown) => {
        this.initPromise = null;
        this.initialized = false;
        throw error;
      });
    }
    return this.initPromise;
  }

  search(query: string, limit: number = SEARCH_LIMIT_DEFAULT): CitySearchResponse {
    this.ensureReady();
    if (typeof query !== 'string') {
      throw new CityError('INVALID_QUERY', 'The search query must be a string.', 400);
    }
    const trimmed = query.trim();
    if (!trimmed) return { results: [] };
    const capped = Number.isFinite(limit)
      ? Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)))
      : SEARCH_LIMIT_DEFAULT;
    const lookup = (geonameId: number): string | null =>
      this.seeds?.byGeonameId(geonameId)?.slug ?? null;
    return { results: this.requireIndex().search(trimmed, capped, lookup) };
  }

  nearest(lat: number, lon: number): NearestCityResponse | null {
    this.ensureReady();
    const coords = validateLatLon(lat, lon);
    const match = this.requireIndex().nearest(coords.lat, coords.lon);
    if (!match) return null;
    const lookup = (geonameId: number): string | null =>
      this.seeds?.byGeonameId(geonameId)?.slug ?? null;
    return {
      city: this.requireIndex().toResult(match.record, lookup),
      distanceKm: match.distanceKm
    };
  }

  resolve(target: ModelTarget): ResolvedTarget {
    this.ensureReady();
    if (!target || typeof target !== 'object') {
      throw new CityError('INVALID_TARGET', 'A model target is required.', 400);
    }
    const kind = (target as { kind?: unknown }).kind;

    if (kind === 'city') {
      const geonameId = (target as { geonameId?: unknown }).geonameId;
      if (!Number.isSafeInteger(geonameId) || (geonameId as number) <= 0) {
        throw new CityError('INVALID_TARGET', 'A city target needs a positive integer GeoNames id.', 400);
      }
      const record = this.requireIndex().get(geonameId as number);
      if (!record) {
        throw new CityError('CITY_NOT_FOUND', `No city with GeoNames id ${String(geonameId)}.`, 404, false, {
          geonameId
        });
      }
      const seedEntry = this.seeds?.byGeonameId(record.geonameId) ?? null;
      const city: CityInfo = {
        geonameId: record.geonameId,
        // Seeded cities use the curated display name from the manifest so the
        // resolved city and the baked model agree (GeoNames spellings vary).
        name: seedEntry?.name ?? record.name,
        country: record.country,
        lat: record.lat,
        lon: record.lon,
        tz: record.tz
      };
      return {
        key: cityModelKey(record.geonameId, this.radiusM, this.modelVersion),
        target: { kind: 'city', geonameId: record.geonameId },
        city,
        seedSlug: seedEntry?.slug ?? null
      };
    }

    if (kind === 'point') {
      const lat = (target as { lat?: unknown }).lat;
      const lon = (target as { lon?: unknown }).lon;
      const coords = validateLatLon(lat, lon);
      const nearest = this.requireIndex().nearest(coords.lat, coords.lon);
      const nearCity = nearest && nearest.distanceKm <= NEAREST_NAME_RADIUS_KM ? nearest.record : null;
      const providedName = sanitizePointName((target as { name?: unknown }).name);
      const name =
        providedName ??
        (nearCity
          ? `${nearCity.name} area`
          : `${formatCoordinate(coords.lat, 3)}, ${formatCoordinate(coords.lon, 3)}`);
      const city: CityInfo = {
        geonameId: null,
        name,
        country: nearCity?.country ?? '',
        lat: coords.lat,
        lon: coords.lon,
        tz: resolveTimezone(coords.lat, coords.lon)
      };
      const normalizedTarget: ModelTarget = { kind: 'point', lat: coords.lat, lon: coords.lon };
      if (providedName) normalizedTarget.name = providedName;
      return {
        key: pointModelKey(coords.lat, coords.lon, this.radiusM, this.modelVersion),
        target: normalizedTarget,
        city,
        seedSlug: null
      };
    }

    throw new CityError('INVALID_TARGET', 'Target kind must be "city" or "point".', 400);
  }

  async ensureModel(target: ModelTarget, options: EnsureModelOptions = {}): Promise<EnsureModelResult> {
    this.ensureReady();
    const resolved = options.resolved ?? this.resolve(target);

    const seed = await this.trySeed(resolved);
    if (seed) return seed;

    const cached = await this.tryCache(resolved.key);
    if (cached) return cached;

    // A recent failure is surfaced immediately (no re-enqueue, no upstream hit).
    const failure = this.recentFailure(resolved.key);
    if (failure) throw failure;

    const existing = this.requireJobs().byKey(resolved.key);
    if (existing) return { state: 'queued', resolved, jobId: existing };

    if (!this.requireChain().canGenerate) {
      throw new CityError(
        'SEED_UNAVAILABLE',
        `No pre-baked seed model exists for ${resolved.city.name} and live generation is disabled.`,
        404,
        false,
        { key: resolved.key, target: resolved.target }
      );
    }

    const { jobId } = this.requireJobs().enqueue(
      resolved.key,
      (context) => this.runGeneration(resolved, context),
      { ...(options.clientId ? { clientId: options.clientId } : {}) }
    );
    return { state: 'queued', resolved, jobId };
  }

  getJob(jobId: string): JobStatus | null {
    if (!this.initialized || !this.jobs) return null;
    if (typeof jobId !== 'string' || jobId.length === 0) return null;
    return this.jobs.get(jobId);
  }

  cancelJob(jobId: string): boolean {
    if (!this.initialized || !this.jobs) return false;
    if (typeof jobId !== 'string' || jobId.length === 0) return false;
    return this.jobs.cancel(jobId);
  }

  async readModel(key: string): Promise<ReadyModel | null> {
    if (!this.initialized || !this.seeds || !this.cache) return null;
    if (typeof key !== 'string' || !isValidModelKey(key)) return null;

    const recent = this.recentModels.get(key);
    if (recent) return recent;

    const seedEntry = this.requireSeeds().byKey(key);
    if (seedEntry) {
      const ready = await this.requireSeeds().read(seedEntry);
      if (ready) {
        this.rememberModel(ready);
        return ready;
      }
    }

    const cached = await this.cache?.read(key);
    if (!cached) return null;
    const ready = readyFromCache(cached);
    this.rememberModel(ready);
    return ready;
  }

  health(): CityServiceHealth {
    const cacheInitialised = this.cache !== null;
    const cache = this.cache
      ? { models: this.cache.models, bytes: this.cache.bytes, maxBytes: this.cache.maxBytesLimit }
      : { models: 0, bytes: 0, maxBytes: Math.max(0, this.config.cacheMaxBytes) };
    const queue = this.jobs
      ? { active: this.jobs.active, queued: this.jobs.queued }
      : { active: 0, queued: 0 };
    const providers: Record<string, 'up' | 'down' | 'unknown'> = {
      overpass: 'unknown',
      'osm-api': 'unknown',
      fixture: 'unknown',
      seed: 'unknown'
    };
    if (this.chain) Object.assign(providers, this.chain.statuses());
    if (this.seeds) providers.seed = this.seeds.statusValue;

    const seedCount = this.seeds?.count ?? 0;
    const seedsDown = this.seeds !== null && this.seeds?.statusValue === 'down';
    const degradedSeeds = this.seeds?.degradedSlugs ?? [];
    const generationAvailable = this.chain?.canGenerate === true;
    const generationOk = generationAvailable || seedCount > 0;

    const checks: HealthCheck[] = [
      {
        name: 'cache',
        ok: this.initialized && cacheInitialised,
        detail: !cacheInitialised
          ? 'not initialised'
          : this.cache?.cacheEnabled
            ? `${cache.models} model(s), ${cache.bytes} B`
            : 'disabled (CACHE_MAX_MB=0)'
      },
      {
        name: 'seeds',
        ok: !seedsDown && degradedSeeds.length === 0,
        detail: seedsDown
          ? 'seed manifest incompatible or unreadable'
          : degradedSeeds.length > 0
            ? `${degradedSeeds.length} degraded seed(s): ${degradedSeeds.slice(0, 5).join(', ')}`
            : `${seedCount} seed(s) verified`
      },
      {
        name: 'generation',
        ok: generationOk,
        detail: generationAvailable
          ? 'live generation enabled'
          : seedCount > 0
            ? 'seeds only (live generation disabled)'
            : 'no generation source available'
      },
      {
        name: 'worker',
        ok: !this.workerDisabled,
        detail: !this.workerEntry
          ? 'in-process builds (no worker entry)'
          : this.workerDisabled
            ? 'in-process fallback active after a worker failure'
            : 'threaded builds'
      },
      { name: 'queue', ok: true, detail: `${queue.active} active, ${queue.queued} queued` }
    ];
    const ready = this.initialized && cacheInitialised && generationOk;
    const degraded = checks.some((check) => !check.ok);
    return {
      cache,
      queue,
      providers,
      seeds: this.seeds ? { count: this.seeds.count, slugs: this.seeds.slugs } : { count: 0, slugs: [] },
      ready,
      degraded,
      checks,
      worker: {
        enabled: this.workerEntry !== null && !this.workerDisabled,
        disabled: this.workerDisabled,
        fallbacks: this.workerFallbacks
      }
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await this.jobs?.shutdown();
    } finally {
      this.chain?.shutdown();
      this.recentModels.clear();
      this.recentBytes = 0;
      this.failures.clear();
      this.initialized = false;
      this.workerDisabled = false;
      this.workerFallbacks = 0;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Initialization                                                    */
  /* ---------------------------------------------------------------- */

  private async initialize(): Promise<void> {
    const startedAt = Date.now();
    const dataPath = path.join(this.config.dataDir, 'cities.json.gz');
    const [index, seeds] = await Promise.all([
      CityIndex.load(dataPath),
      SeedStore.load(this.config.seedsDir, { modelVersion: this.modelVersion, radiusM: this.radiusM })
    ]);
    this.index = index;
    this.seeds = seeds;

    const cache = new ModelCache(this.config.cacheDir, this.config.cacheMaxBytes, {
      modelVersion: this.modelVersion,
      radiusM: this.radiusM
    });
    await cache.init();
    this.cache = cache;

    this.chain = this.options.providerChain ?? createProviderChain(this.config);
    this.jobs = new JobQueue({
      concurrency: this.config.generationConcurrency,
      maxQueued: this.config.jobQueueMax,
      maxPerClient: this.config.jobPerClientMax,
      maxQueuedAgeMs: this.config.queueMaxAgeSec * 1000,
      onRunnerError: (error, jobId) => {
        log.warn(
          `generation job ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    this.workerEntry =
      this.options.workerEntry !== undefined ? this.options.workerEntry : locateWorkerEntry();
    if (!this.workerEntry) {
      log.warn('generation worker entry (worker.ts/worker.js) was not found; using in-process generation');
    }
    for (const warning of seeds.warningList) log.warn(`seed manifest: ${warning}`);
    this.initialized = true;
    this.shuttingDown = false;
    log.info(
      `city service ready in ${Date.now() - startedAt} ms (${index.count} cities, ${seeds.count} seeds, ${cache.models} cached models)`
    );
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  private async runGeneration(resolved: ResolvedTarget, context: JobContext): Promise<void> {
    const center =
      resolved.target.kind === 'city'
        ? { lat: resolved.city.lat, lon: resolved.city.lon }
        : { lat: resolved.target.lat, lon: resolved.target.lon };
    const deadline = createGenerationDeadline(context.signal, GENERATION_TIMEOUT_MS);

    try {
      context.report('fetch', 4, 'Fetching city data');
      const raw = await this.requireChain().fetchRaw({
        target: resolved.target,
        center,
        radiusM: this.radiusM,
        signal: deadline.signal,
        onProgress: (percent, label, detail) => {
          const step: GenerationStep = percent >= 50 ? 'parse' : 'fetch';
          context.report(step, 6 + Math.min(56, Math.round(percent * 0.9)), label, detail);
        }
      });

      const elementCount = rawOsmElementCount(raw);
      const maxElements = this.options.maxRawElements ?? DEFAULT_MAX_RAW_ELEMENTS;
      if (elementCount > maxElements) {
        throw new CityError(
          'TARGET_TOO_DENSE',
          `The requested area contains ${elementCount} OpenStreetMap elements, above the ${maxElements} element limit. Choose a smaller or less dense area.`,
          422,
          false,
          { elements: elementCount, limit: maxElements }
        );
      }

      const warnings = [...raw.warnings];
      const degradedReasons: string[] = [];
      let terrain = null;
      if (raw.source !== 'fixture') {
        context.report('fetch', 58, 'Sampling elevation');
        try {
          terrain = await this.fetchTerrain({
            centerLat: center.lat,
            centerLon: center.lon,
            radiusM: this.radiusM,
            signal: deadline.signal
          });
        } catch (error) {
          if (isAbortError(error) || deadline.signal.aborted) throw error;
          const message = safeErrorMessage(error, 'terrain provider unavailable');
          warnings.push(`terrain unavailable: ${message}`);
          degradedReasons.push('terrain unavailable');
          log.warn(`terrain unavailable for ${resolved.key}: ${message}`);
        }
      }
      if (raw.partial) {
        degradedReasons.push('partial upstream coverage');
        log.warn(`provider coverage was partial for ${resolved.key}; marking the model degraded`);
      }
      if (degradedReasons.length > 0) {
        warnings.push(`degraded model: ${degradedReasons.join('; ')}`);
      }

      context.report('build', 62, 'Generating city model', `${raw.ways.length} ways`);
      const input: BuildInput = {
        key: resolved.key,
        city: resolved.city,
        centerLat: center.lat,
        centerLon: center.lon,
        radiusM: this.radiusM,
        modelVersion: this.modelVersion,
        source: raw.source,
        seed: false,
        generatedAt: new Date().toISOString(),
        warnings,
        terrain,
        degraded: degradedReasons.length > 0,
        degradedReasons
      };

      const artifact = await this.buildModel(raw, input, context, deadline.signal);

      context.report('write', 96, 'Writing model cache');
      this.failures.delete(resolved.key);
      await this.requireCache().write(resolved.key, artifact.gzipped, {
        meta: artifact.meta,
        city: resolved.city,
        target: resolved.target,
        seedSlug: resolved.seedSlug,
        modelVersion: this.modelVersion,
        radiusM: this.radiusM
      });
      this.rememberModel({
        state: 'ready',
        resolved,
        meta: artifact.meta,
        etag: artifact.etag,
        bytes: artifact.bytes,
        gzipped: artifact.gzipped
      });
      context.report('write', 99, 'Model cached');
    } catch (error) {
      if (deadline.timedOut) {
        const timeoutError = new CityError(
          'MODEL_TIMEOUT',
          `City generation timed out after ${Math.round(GENERATION_TIMEOUT_MS / 1000)} s.`,
          502,
          true,
          { key: resolved.key }
        );
        this.recordFailure(resolved.key, timeoutError);
        throw timeoutError;
      }
      this.recordFailure(resolved.key, error);
      throw error;
    } finally {
      deadline.clear();
    }
  }

  /** Terrain sampler behind an injection seam (tests use a failing fake). */
  private fetchTerrain(options: Parameters<typeof fetchTerrain>[0]): ReturnType<typeof fetchTerrain> {
    return (this.options.terrainFetcher ?? fetchTerrain)(options);
  }

  private async buildModel(
    raw: RawOsmData,
    input: BuildInput,
    context: JobContext,
    signal: AbortSignal
  ): Promise<BuildArtifact> {
    if (this.workerEntry && !this.workerDisabled) {
      try {
        return await this.buildInWorker(this.workerEntry, raw, input, context, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Only *boot/crash* failures fall back: a build error reported by the
        // worker itself (NO_DATA, MODEL_FAILED, ...) is a normal job failure.
        const fallbackable =
          error instanceof CityError &&
          (error.code === 'WORKER_START_FAILED' ||
            error.code === 'WORKER_BOOT_FAILED' ||
            error.code === 'WORKER_CRASHED');
        if (!fallbackable) throw error;
        // Fall back at most once per process: disable the worker so later jobs
        // do not retry the broken entry point in a loop.
        this.workerDisabled = true;
        this.workerFallbacks += 1;
        log.warn(
          `generation worker failed (${error.code}: ${error.message}); ` +
            'falling back to in-process generation and disabling the worker'
        );
      }
    }
    return this.buildInProcess(raw, input, context, signal);
  }

  private buildInWorker(
    workerPath: string,
    raw: RawOsmData,
    input: BuildInput,
    context: JobContext,
    signal: AbortSignal
  ): Promise<BuildArtifact> {
    return new Promise<BuildArtifact>((resolve, reject) => {
      let settled = false;
      let receivedMessage = false;
      let worker: Worker;
      try {
        const workerData: WorkerBuildRequest = { type: 'build', raw, input };
        worker = new Worker(workerPath, { workerData });
      } catch (error) {
        reject(
          new CityError(
            'WORKER_START_FAILED',
            `Could not start the generation worker: ${error instanceof Error ? error.message : String(error)}`,
            500,
            false
          )
        );
        return;
      }

      const timeout = setTimeout(() => {
        fail(new CityError('MODEL_TIMEOUT', 'The generation worker timed out.', 502, true));
      }, WORKER_BUILD_TIMEOUT_MS);
      timeout.unref?.();

      const cleanup = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        worker.removeAllListeners();
        void worker.terminate().catch(() => undefined);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const fail = (error: unknown): void => finish(() => reject(error));
      const succeed = (artifact: BuildArtifact): void => finish(() => resolve(artifact));
      const onAbort = (): void => {
        const error = new Error('Operation aborted');
        error.name = 'AbortError';
        fail(error);
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (message: WorkerResponse) => {
        if (settled) return;
        receivedMessage = true;
        if (message.type === 'progress') {
          const local = Math.max(0, Math.min(100, message.percent));
          context.report('build', 62 + Math.round((local / 100) * 32), message.label, message.detail);
        } else if (message.type === 'done') {
          log.info(`worker build finished in ${message.elapsedMs} ms (${message.bytes} B gzipped)`);
          succeed({
            gzipped: Buffer.from(message.gzipped),
            etag: message.etag,
            bytes: message.bytes,
            meta: message.meta
          });
        } else if (message.type === 'error') {
          fail(
            new CityError(
              message.code,
              message.message,
              normalizeStatus(message.status),
              message.retryable,
              message.details
            )
          );
        }
      });
      worker.on('error', (error) => {
        // An `error` before any message means the script failed to evaluate:
        // the entry point is broken and the service falls back in-process.
        const code = receivedMessage ? 'WORKER_CRASHED' : 'WORKER_BOOT_FAILED';
        fail(
          new CityError(
            code,
            `The generation worker ${receivedMessage ? 'crashed' : 'failed to start'}: ${safeErrorMessage(error, 'worker error')}`,
            502,
            true
          )
        );
      });
      worker.on('exit', (exitCode) => {
        if (settled) return;
        if (!receivedMessage) {
          fail(
            new CityError(
              'WORKER_BOOT_FAILED',
              `The generation worker exited during startup (code ${exitCode}).`,
              502,
              true
            )
          );
          return;
        }
        fail(
          new CityError('WORKER_CRASHED', `The generation worker exited unexpectedly (code ${exitCode}).`, 502, true)
        );
      });
    });
  }

  private async buildInProcess(
    raw: RawOsmData,
    input: BuildInput,
    context: JobContext,
    signal: AbortSignal
  ): Promise<BuildArtifact> {
    const onProgress = (event: BuildProgressEvent): void => {
      const local = Math.max(0, Math.min(100, event.percent));
      context.report('build', 62 + Math.round((local / 100) * 32), event.label, event.detail);
    };
    const model: CityModel = buildCityModel(raw, input, onProgress);
    if (signal.aborted) {
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      throw error;
    }
    const gzipped = await gzipModel(model);
    return { gzipped, etag: modelEtag(gzipped), bytes: gzipped.length, meta: model.meta };
  }

  /* ---------------------------------------------------------------- */
  /* Negative cache                                                    */
  /* ---------------------------------------------------------------- */

  /** Returns a still-cooling-down failure for a key, or null when retryable. */
  private recentFailure(key: string): CityError | null {
    const entry = this.failures.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.until <= now) {
      this.failures.delete(key);
      return null;
    }
    const retryAfterSec = Math.max(1, Math.ceil((entry.until - now) / 1000));
    return new CityError(
      entry.error.code,
      entry.error.retryable
        ? `${entry.error.message} Recent attempts failed; retry in ${retryAfterSec} s.`
        : entry.error.message,
      entry.error.status,
      entry.error.retryable,
      entry.error.details,
      retryAfterSec
    );
  }

  private recordFailure(key: string, error: unknown): void {
    if (this.failureCooldownMs <= 0 || isAbortError(error)) return;
    const cityError = isCityError(error)
      ? error
      : new CityError('MODEL_FAILED', safeErrorMessage(error), 502, true);
    this.failures.set(key, { until: Date.now() + this.failureCooldownMs, error: cityError });
    if (this.failures.size > MAX_TRACKED_FAILURES) {
      const now = Date.now();
      for (const [failureKey, entry] of this.failures) {
        if (entry.until <= now || this.failures.size > MAX_TRACKED_FAILURES) this.failures.delete(failureKey);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Seed / cache access                                               */
  /* ---------------------------------------------------------------- */

  private async trySeed(resolved: ResolvedTarget): Promise<ReadyModel | null> {
    if (!resolved.seedSlug) return null;
    if (resolved.target.kind !== 'city') return null;
    const entry = this.requireSeeds().byGeonameId(resolved.target.geonameId);
    if (!entry || entry.key !== resolved.key) return null;
    const ready = await this.requireSeeds().read(entry);
    if (!ready) return null;
    this.rememberModel(ready);
    return ready;
  }

  private async tryCache(key: string): Promise<ReadyModel | null> {
    const cached = await this.requireCache().read(key);
    if (!cached) return null;
    const ready = readyFromCache(cached);
    this.rememberModel(ready);
    return ready;
  }

  private rememberModel(model: ReadyModel): void {
    const key = model.resolved.key;
    const existing = this.recentModels.get(key);
    if (existing) {
      this.recentBytes -= existing.gzipped.length;
      this.recentModels.delete(key);
    }
    this.recentModels.set(key, model);
    this.recentBytes += model.gzipped.length;
    while (
      this.recentModels.size > RECENT_MODEL_LIMIT ||
      (this.recentBytes > RECENT_BYTES_LIMIT && this.recentModels.size > 1)
    ) {
      const oldestKey = this.recentModels.keys().next().value as string | undefined;
      if (!oldestKey || oldestKey === key) break;
      const oldest = this.recentModels.get(oldestKey);
      if (!oldest) break;
      this.recentModels.delete(oldestKey);
      this.recentBytes -= oldest.gzipped.length;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Guards                                                            */
  /* ---------------------------------------------------------------- */

  private ensureReady(): void {
    if (!this.initialized || !this.index || !this.seeds || !this.cache || !this.jobs) {
      throw new CityError('NOT_INITIALIZED', 'The city service has not been initialised.', 503, true);
    }
  }

  private requireIndex(): CityIndex {
    if (!this.index) throw new CityError('NOT_INITIALIZED', 'The city index is not loaded.', 503, true);
    return this.index;
  }

  private requireSeeds(): SeedStore {
    if (!this.seeds) throw new CityError('NOT_INITIALIZED', 'The seed store is not loaded.', 503, true);
    return this.seeds;
  }

  private requireCache(): ModelCache {
    if (!this.cache) throw new CityError('NOT_INITIALIZED', 'The model cache is not loaded.', 503, true);
    return this.cache;
  }

  private requireChain(): ProviderChain {
    if (!this.chain) throw new CityError('NOT_INITIALIZED', 'The provider chain is not loaded.', 503, true);
    return this.chain;
  }

  private requireJobs(): JobQueue {
    if (!this.jobs) throw new CityError('NOT_INITIALIZED', 'The job queue is not running.', 503, true);
    return this.jobs;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readyFromCache(cached: CachedModel): ReadyModel {
  const { entry, gzipped } = cached;
  return {
    state: 'ready',
    resolved: {
      key: entry.key,
      target: entry.target,
      city: entry.city,
      seedSlug: entry.seedSlug
    },
    meta: entry.meta,
    etag: entry.etag,
    bytes: gzipped.length,
    gzipped
  };
}

function validateLatLon(lat: unknown, lon: unknown): { lat: number; lon: number } {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new CityError('INVALID_COORDINATES', 'Latitude must be a number between -90 and 90.', 400);
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new CityError('INVALID_COORDINATES', 'Longitude must be a number between -180 and 180.', 400);
  }
  return { lat, lon };
}

function sanitizePointName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

function resolveTimezone(lat: number, lon: number): string {
  try {
    const zone = tzlookup(lat, lon);
    if (typeof zone === 'string' && /^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(zone)) return zone;
  } catch (error) {
    log.debug(`timezone lookup failed for ${lat},${lon}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'UTC';
}

function createGenerationDeadline(parent: AbortSignal, timeoutMs: number): GenerationDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Generation timed out'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    get timedOut(): boolean {
      return timedOut;
    },
    clear(): void {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  };
}

function normalizeStatus(status: number): CityErrorStatus {
  return status === 400 || status === 404 || status === 422 || status === 500 || status === 502 || status === 503
    ? status
    : 500;
}

/**
 * Finds the generation worker entry next to this module.
 *
 * Development: `server/city/service.ts` sits next to `worker.ts`.
 * Production: the server bundle (`dist-server/index.js`) sits next to
 * `dist-server/worker.js`.
 */
function locateWorkerEntry(): string | null {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['worker.js', 'worker.mjs', 'worker.cjs', 'worker.ts']) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
