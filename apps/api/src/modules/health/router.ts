import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { AppError } from '../../common/errors';
import { defineRoute } from '../../common/define-route';
import { z } from '../../common/openapi';
import type { Deps } from '../../deps';

export const HealthResponseSchema = z
  .object({ status: z.literal('ok'), version: z.string() })
  .openapi('HealthResponse');

const READY_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

export function healthRouter(deps: Deps, registry: OpenAPIRegistry, version: string): Router {
  const router = Router();

  defineRoute(router, registry, {
    method: 'get',
    path: '/v1/health',
    summary: 'Liveness: the process is up',
    tags: ['health'],
    auth: 'public',
    response: { status: 200, schema: HealthResponseSchema },
    handler: () => ({ status: 'ok' as const, version }),
  });

  defineRoute(router, registry, {
    method: 'get',
    path: '/v1/health/ready',
    summary: 'Readiness: the database answers',
    tags: ['health'],
    auth: 'public',
    errors: [503],
    response: { status: 200, schema: HealthResponseSchema },
    handler: async () => {
      try {
        await withTimeout(deps.db.query('select 1'), READY_TIMEOUT_MS);
      } catch {
        throw new AppError('NOT_READY', 'Database is not reachable', 503);
      }
      return { status: 'ok' as const, version };
    },
  });

  return router;
}
