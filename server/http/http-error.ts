/**
 * Small HTTP error type used by route handlers.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? status >= 500;
    this.details = options.details;
  }
}
