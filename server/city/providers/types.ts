/**
 * Provider-facing types: one interface per external OSM source.
 */

import type { CitySource, ModelTarget } from '../../../shared/types.ts';
import type { RawOsmData } from '../raw.ts';

export type ProviderStatus = 'up' | 'down' | 'unknown';

export interface ProviderFetchRequest {
  target: ModelTarget;
  /** Projection/query centre. */
  center: { lat: number; lon: number };
  radiusM: number;
  /** Aborted by job cancellation or service shutdown. */
  signal: AbortSignal;
  /** Progress inside the fetch phase (0..100). */
  onProgress?: (percent: number, label: string, detail?: string) => void;
}

export interface CityDataProvider {
  /** Stable id used in health output and warnings. */
  readonly id: string;
  /** `CitySource` value recorded in model metadata. */
  readonly source: CitySource;
  fetchRaw(request: ProviderFetchRequest): Promise<RawOsmData>;
  status(): ProviderStatus;
}
