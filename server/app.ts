/**
 * Application assembly: city service, sky cache, API routes and static SPA.
 * `server/index.ts` calls this; integration tests import it directly.
 */

import { createServer, type Server } from 'node:http';
import type { AppConfig } from './config.ts';
import type { CityService } from './city/service.ts';
import { createCityService } from './city/service.ts';
import { createApiHandler } from './api/routes.ts';
import { SkyDayCache } from './api/sky-cache.ts';
import { applySecurityHeaders, sendText } from './http/respond.ts';
import { serveStatic } from './http/static.ts';
import { HttpMetrics } from './http/metrics.ts';

export interface SunlightApp {
  config: AppConfig;
  server: Server;
  cityService: CityService;
  skyCache: SkyDayCache;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  /** Pre-built city service (tests inject one with fake providers/terrain). */
  cityService?: CityService;
}

export async function createSunlightApp(config: AppConfig, options: CreateAppOptions = {}): Promise<SunlightApp> {
  const cityService = options.cityService ?? createCityService(config);
  await cityService.init();
  const skyCache = new SkyDayCache();
  const httpMetrics = new HttpMetrics();
  const apiHandler = createApiHandler({ config, cityService, skyCache, httpMetrics });

  const server = createServer(async (req, res) => {
    const startedAt = performance.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    applySecurityHeaders(res);
    const requestPath = url.pathname;
    res.on('finish', () => {
      const duration = performance.now() - startedAt;
      httpMetrics.record(res.statusCode, duration);
      const level = (process.env.SUNLIGHT_LOG_LEVEL || 'warn').toLowerCase();
      if (level === 'info' || level === 'debug') {
        console.info(
          `[http] ${req.method || 'GET'} ${requestPath} ${res.statusCode} ${duration.toFixed(1)}ms`
        );
      }
    });

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await apiHandler(req, res, url);
        if (!handled) {
          res.setHeader('Allow', 'GET, HEAD, POST, DELETE');
          sendText(res, 405, 'Method not allowed.');
        }
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, url.pathname, config.staticDir);
        if (served) return;
        sendText(
          res,
          404,
          'Sunlight API is running, but no built frontend was found. Run `npm run dev` for development or `npm run build` for production.'
        );
        return;
      }

      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('Method not allowed');
    } catch (error) {
      console.error('[sunlight] request failed', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error.', retryable: true } }));
      } else {
        res.end();
      }
    }
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  let closed = false;
  return {
    config,
    server,
    cityService,
    skyCache,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2500);
      });
      await cityService.shutdown();
    }
  };
}

export interface RunningApp extends SunlightApp {
  port: number;
  url: string;
}

/** Starts the app on a port (0 picks a free one) — used by tests and index.ts. */
export async function startSunlightApp(
  config: AppConfig,
  options: { port?: number; host?: string; cityService?: CityService } = {}
): Promise<RunningApp> {
  const app = await createSunlightApp(config, {
    ...(options.cityService ? { cityService: options.cityService } : {})
  });
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { ...app, port: actualPort, url: `http://${host}:${actualPort}` };
}
