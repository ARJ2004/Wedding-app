import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import type { JobQueue } from '../../common/jobs';
import { z } from '../../common/openapi';

const FailedJobSchema = z
  .object({
    id: z.string(),
    queue: z.string(),
    deadLettered: z.boolean(),
    attempts: z.number().int(),
    error: z.string().nullable(),
    failedAt: z.string(),
  })
  .openapi('FailedJob');

/**
 * FND-06b: failed/dead-lettered jobs for platform ops. Allowed only for emails in
 * OPS_ADMIN_EMAILS (env, not a DB flag); everyone else gets 404 so the route stays invisible.
 */
export function opsRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; jobs: JobQueue; opsAdmins: string[] }) {
  const requireOps = async (req: Request) => {
    const user = await deps.prisma.users.findUnique({ where: { id: req.principal!.userId }, select: { email: true } });
    if (!user || !deps.opsAdmins.includes(user.email.toLowerCase())) throw new AppError('NOT_FOUND', 'Route not found', 404);
  };

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/ops/jobs',
    summary: 'Failed and dead-lettered jobs (ops admins only; no payloads)',
    tags: ['ops'],
    auth: 'host',
    errors: [404],
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    response: { status: 200, schema: z.object({ items: z.array(FailedJobSchema) }) },
    handler: async ({ req, query }) => {
      await requireOps(req);
      return { items: await deps.jobs.failed(query.limit) };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/ops/jobs/:jobId/retry',
    summary: 'Re-queue a failed or dead-lettered job',
    tags: ['ops'],
    auth: 'host',
    errors: [404],
    request: { params: z.object({ jobId: z.string().uuid() }) },
    response: { status: 204 },
    handler: async ({ req, params }) => {
      await requireOps(req);
      if (!(await deps.jobs.retry(params.jobId))) throw new AppError('OPS_JOB_NOT_FOUND', 'Job not found or not retryable', 404);
    },
  });
}
