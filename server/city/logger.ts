/**
 * Minimal logger for the city subsystem.
 *
 * The application server owns request logging; the city pipeline only needs a
 * few diagnostics (cache corruption, seed manifest problems, provider
 * fallbacks). Level is controlled with `SUNLIGHT_LOG_LEVEL` and defaults to
 * `warn` so tests stay quiet unless something is actually wrong.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

function threshold(): number {
  const raw = process.env.SUNLIGHT_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVELS) return LEVELS[raw as LogLevel];
  return LEVELS.warn;
}

function emit(level: Exclude<LogLevel, 'silent'>, message: string, details?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const line = `[city] ${message}`;
  if (details === undefined) {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line);
  } else {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line, details);
  }
}

export const log = {
  debug: (message: string, details?: unknown) => emit('debug', message, details),
  info: (message: string, details?: unknown) => emit('info', message, details),
  warn: (message: string, details?: unknown) => emit('warn', message, details),
  error: (message: string, details?: unknown) => emit('error', message, details)
};
