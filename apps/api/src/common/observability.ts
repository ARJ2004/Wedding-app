import { createServer, type Server } from 'node:http';
import * as Sentry from '@sentry/node';
import type { RequestHandler } from 'express';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * FND-08 observability. Metrics are labelled by route *template* (never the raw URL, which can
 * carry ids or tokens) and served on 127.0.0.1 only. Sentry runs only when SENTRY_DSN is set and
 * never sends request bodies, headers, cookies or user details.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration = new Histogram({
    name: 'mehfil_http_request_duration_seconds',
    help: 'HTTP request latency by route template',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly jobs = new Counter({
    name: 'mehfil_jobs_total',
    help: 'Background jobs by queue and outcome',
    labelNames: ['queue', 'outcome'] as const,
    registers: [this.registry],
  });
  readonly sseConnections = new Gauge({
    name: 'mehfil_sse_connections',
    help: 'Open realtime (SSE) streams in this process',
    registers: [this.registry],
  });
  readonly sseListenReconnects = new Counter({
    name: 'mehfil_sse_listen_reconnects_total',
    help: 'Times the LISTEN client reconnected',
    registers: [this.registry],
  });

  constructor(opts: { defaults?: boolean } = {}) {
    if (opts.defaults !== false) collectDefaultMetrics({ register: this.registry, prefix: 'mehfil_' });
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      const end = this.httpDuration.startTimer();
      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
        end({ method: req.method, route, status: String(res.statusCode) });
      });
      next();
    };
  }

  /** Serves /metrics on localhost only; returns null when disabled (port 0). */
  listen(port: number): Server | null {
    if (port === 0) return null;
    const server = createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.statusCode = 404;
        res.end();
        return;
      }
      void this.registry.metrics().then((body) => {
        res.setHeader('Content-Type', this.registry.contentType);
        res.end(body);
      });
    });
    return server.listen(port, '127.0.0.1');
  }
}

export function initSentry(dsn: string | undefined, environment: string, release: string): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
  });
  return true;
}

export function captureError(err: unknown, requestId?: string) {
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag('request_id', requestId);
    Sentry.captureException(err);
  });
}
