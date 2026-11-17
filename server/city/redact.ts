/**
 * Redaction helpers for client-visible errors.
 *
 * Job errors are returned to the browser; absolute filesystem paths and other
 * host internals must never be part of that payload (they are still available
 * in operator logs). Provider hostnames stay visible because they are public
 * infrastructure and help users understand retries.
 */

const POSIX_ABSOLUTE = /(?<![:/\w.-])((?:\/[^\s'")<>]+))(?=$|[\s'"),.;:])/g;
const WINDOWS_ABSOLUTE = /(?<![\w:\\])([A-Za-z]:\\[^\s'")<>]+)/g;
const FILE_URL = /file:\/\/[^\s'")<>]+/gi;

/** Replaces absolute filesystem paths in a message with `<path>`. */
export function redactAbsolutePaths(message: string): string {
  if (typeof message !== 'string' || message.length === 0) return message;
  return message
    .replace(FILE_URL, '<path>')
    .replace(POSIX_ABSOLUTE, (match) => {
      const slashes = (match.match(/\//g) ?? []).length;
      return slashes >= 2 ? '<path>' : match;
    })
    .replace(WINDOWS_ABSOLUTE, '<path>');
}

/** Redacts and truncates an arbitrary thrown value for a client-visible field. */
export function safeErrorMessage(error: unknown, fallback = 'Unexpected error.'): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error === undefined || error === null
          ? ''
          : String(error);
  const redacted = redactAbsolutePaths(message).trim();
  if (!redacted) return fallback;
  return redacted.length > 400 ? `${redacted.slice(0, 399)}…` : redacted;
}

export interface FsErrorDescription {
  /** Node error code, e.g. `ENOSPC`; `FS_ERROR` when unknown. */
  code: string;
  /** Operator-facing description without any path. */
  message: string;
  /** True for conditions that may resolve without a redeploy. */
  retryable: boolean;
}

/**
 * Turns a filesystem error into a path-free description.
 * Node fs errors embed the absolute path in `message`, so never interpolate it.
 */
export function describeFsError(error: unknown, context = 'cache'): FsErrorDescription {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return { code, message: `The ${context} disk is full.`, retryable: true };
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return { code, message: `The ${context} directory is not writable.`, retryable: false };
    case 'EMFILE':
    case 'ENFILE':
      return { code, message: 'The server has too many open files.', retryable: true };
    case 'ENOENT':
      return { code, message: `The ${context} directory is missing.`, retryable: false };
    default:
      return {
        code: code || 'FS_ERROR',
        message: `The ${context} could not be accessed (${code || 'filesystem error'}).`,
        retryable: false
      };
  }
}

/**
 * Recursively redacts absolute paths inside a JSON-ish details payload.
 * Bounded depth/length so a hostile error value can not blow up the job record.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return redactAbsolutePaths(value);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => redactValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}
