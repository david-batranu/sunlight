/**
 * Provider chain: Overpass → official OSM API tiled fallback (auto mode), or a
 * single configured provider. `CITY_SOURCE=fixture` never touches the network;
 * `CITY_SOURCE=seed`/`SEEDS_ONLY=1` disable network generation entirely.
 */

import type { AppConfig } from '../../config.ts';
import { CityError, isAbortError } from '../errors.ts';
import type { RawOsmData } from '../raw.ts';
import { dedupeWarnings } from '../raw.ts';
import { createFixtureProvider } from './fixture.ts';
import type { FetchLike } from './http.ts';
import { createOsmApiProvider } from './osm-api.ts';
import { createOverpassProvider } from './overpass.ts';
import type { CityDataProvider, ProviderFetchRequest, ProviderStatus } from './types.ts';

export interface ProviderChainOptions {
  fixtureDir?: string;
  overpassEndpoints?: string[];
  osmApiBaseUrl?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  overpassTimeoutMs?: number;
  osmApiSpacingMs?: number;
}

export interface ProviderChain {
  /** False in seeds-only / seed modes (no network generation allowed). */
  readonly canGenerate: boolean;
  fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData>;
  statuses(): Record<string, ProviderStatus>;
  shutdown(): void;
}

interface AttemptFailure {
  provider: string;
  code: string;
  message: string;
  retryable: boolean;
}

export function createProviderChain(config: AppConfig, options: ProviderChainOptions = {}): ProviderChain {
  const providers: CityDataProvider[] = [];
  const fixtureDir = options.fixtureDir ?? config.fixtureDir;
  const overpassEndpoints = options.overpassEndpoints ?? config.overpassEndpoints;
  const shared = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {})
  };

  if (!config.seedsOnly) {
    switch (config.citySource) {
      case 'fixture':
        providers.push(createFixtureProvider({ dir: fixtureDir }));
        break;
      case 'overpass':
        providers.push(
          createOverpassProvider({
            endpoints: overpassEndpoints,
            userAgent: config.osmUserAgent,
            ...shared,
            ...(options.overpassTimeoutMs ? { timeoutMs: options.overpassTimeoutMs } : {})
          })
        );
        break;
      case 'osm-api':
        providers.push(
          createOsmApiProvider({
            userAgent: config.osmUserAgent,
            ...shared,
            ...(options.osmApiBaseUrl ? { baseUrl: options.osmApiBaseUrl } : {}),
            ...(options.osmApiSpacingMs ? { spacingMs: options.osmApiSpacingMs } : {})
          })
        );
        break;
      case 'seed':
        break;
      case 'auto':
      default:
        providers.push(
          createOverpassProvider({
            endpoints: overpassEndpoints,
            userAgent: config.osmUserAgent,
            ...shared,
            ...(options.overpassTimeoutMs ? { timeoutMs: options.overpassTimeoutMs } : {})
          })
        );
        providers.push(
          createOsmApiProvider({
            userAgent: config.osmUserAgent,
            ...shared,
            ...(options.osmApiBaseUrl ? { baseUrl: options.osmApiBaseUrl } : {}),
            ...(options.osmApiSpacingMs ? { spacingMs: options.osmApiSpacingMs } : {})
          })
        );
        break;
    }
  }

  const canGenerate = providers.length > 0;

  return {
    canGenerate,
    statuses(): Record<string, ProviderStatus> {
      const statuses: Record<string, ProviderStatus> = {};
      for (const provider of providers) statuses[provider.id] = provider.status();
      return statuses;
    },
    async fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData> {
      if (providers.length === 0) {
        throw new CityError(
          'PROVIDER_UNAVAILABLE',
          config.seedsOnly
            ? 'Live generation is disabled (SEEDS_ONLY=1); only pre-baked seeds and cached models are available.'
            : 'Live generation is disabled by the configured city source.',
          503,
          false
        );
      }

      const failures: AttemptFailure[] = [];
      let lastPercent = 0;
      let singleError: CityError | null = null;

      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        const isLast = index === providers.length - 1;
        try {
          const raw = await provider.fetchRaw({
            ...request,
            onProgress: (percent, label, detail) => {
              const global = Math.max(lastPercent, Math.min(58, Math.round(percent)));
              lastPercent = global;
              request.onProgress?.(global, label, detail);
            }
          });
          if (failures.length > 0) {
            raw.warnings = dedupeWarnings(
              [
                ...raw.warnings,
                ...failures.map((failure) => `${failure.provider} unavailable (${failure.code}); used ${provider.id}`)
              ],
              24
            );
          }
          return raw;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const cityError =
            error instanceof CityError
              ? error
              : new CityError('PROVIDER_FAILED', error instanceof Error ? error.message : String(error), 502, true);
          singleError = cityError;
          failures.push({
            provider: provider.id,
            code: cityError.code,
            message: cityError.message,
            retryable: cityError.retryable
          });
          if (!isLast) {
            request.onProgress?.(
              Math.min(20, 8 + index * 4),
              `${provider.id} unavailable; trying fallback`,
              cityError.message
            );
          }
        }
      }

      if (providers.length === 1 && singleError) throw singleError;
      throw new CityError(
        'MODEL_FAILED',
        `All OSM data providers failed: ${failures.map((failure) => `${failure.provider}: ${failure.message}`).join('; ')}`,
        502,
        failures.some((failure) => failure.retryable),
        { attempts: failures }
      );
    },
    shutdown(): void {
      // Providers hold no timers/handles; request cancellation is signal-driven.
    }
  };
}
