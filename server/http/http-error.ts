/**
 * Small HTTP error type used by route handlers.
 */

export interface HttpErrorOptions {
  retryable?: boolean;
  details?: unknown;
  /** Seconds until the caller may retry (drives the `Retry-After` header). */
  retryAfterSec?: number;
  /** Extra response headers, e.g. `Allow` for 405s. */
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly retryAfterSec?: number;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? status >= 500;
    this.details = options.details;
    this.retryAfterSec = options.retryAfterSec;
    this.headers = options.headers;
  }
}
