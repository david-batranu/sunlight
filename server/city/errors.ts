/**
 * Typed errors for the city service.
 *
 * Every expected failure in the city pipeline is reported as a `CityError` so
 * that the HTTP layer can map `code`/`status`/`retryable` onto a structured
 * API error body without leaking Node internals.
 */

export type CityErrorStatus = 400 | 404 | 422 | 500 | 502 | 503;

export class CityError extends Error {
  /** Stable machine-readable error code, e.g. `NO_DATA`. */
  readonly code: string;
  /** HTTP status the API layer should use. */
  readonly status: CityErrorStatus;
  /** Whether the caller may retry the same request later. */
  readonly retryable: boolean;
  /** Optional structured context (never contains secrets). */
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status: CityErrorStatus = 500,
    retryable = false,
    details?: unknown
  ) {
    super(message);
    this.name = 'CityError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isCityError(value: unknown): value is CityError {
  return value instanceof CityError;
}

/** True for `AbortSignal`/`Worker` cancellation errors. */
export function isAbortError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const name = (value as { name?: unknown }).name;
  const code = (value as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR';
}

export function abortError(reason?: string): Error {
  const error = new Error(reason ?? 'Operation aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Normalizes an unknown thrown value into a `CityError`.
 *
 * The original message is preserved (truncated) so that job errors are
 * actionable, but the resulting code/status come from `fallback`.
 */
export function asCityError(
  value: unknown,
  fallback: { code: string; message: string; status: CityErrorStatus; retryable: boolean }
): CityError {
  if (isCityError(value)) return value;
  if (value instanceof Error) {
    const message = value.message ? `${fallback.message}: ${value.message}` : fallback.message;
    return new CityError(fallback.code, truncate(message, 400), fallback.status, fallback.retryable);
  }
  const message = typeof value === 'string' && value ? `${fallback.message}: ${value}` : fallback.message;
  return new CityError(fallback.code, truncate(message, 400), fallback.status, fallback.retryable);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
