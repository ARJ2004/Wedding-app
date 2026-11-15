import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineJob } from './jobs';

/**
 * FND purge crons (01-fnd §5). Each deletes in bounded batches so a backlog never holds
 * long locks on a wedding day.
 */
const BATCH = 5_000;

export function housekeepingJobs(prisma: PrismaClient) {
  return [
    defineJob({
      name: 'fnd.purge-auth',
      lane: 'default',
      schema: z.object({}).passthrough(),
      cron: { expression: '17 3 * * *', tz: 'Asia/Kolkata' },
      handler: async (_p, { logger }) => {
        const n = await prisma.$executeRaw`
          DELETE FROM refresh_tokens WHERE id IN (
            SELECT id FROM refresh_tokens
            WHERE expires_at < now() - interval '7 days'
               OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
            LIMIT ${BATCH})`;
        logger.info({ deleted: n }, 'purged refresh tokens');
      },
    }),
    defineJob({
      name: 'fnd.purge-idempotency',
      lane: 'default',
      schema: z.object({}).passthrough(),
      cron: { expression: '*/30 * * * *' },
      handler: async (_p, { logger }) => {
        const n = await prisma.$executeRaw`
          DELETE FROM idempotency_keys WHERE id IN (
            SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT ${BATCH})`;
        logger.info({ deleted: n }, 'purged idempotency keys');
      },
    }),
    defineJob({
      name: 'fnd.purge-realtime',
      lane: 'default',
      schema: z.object({}).passthrough(),
      cron: { expression: '7 * * * *' },
      handler: async (_p, { logger }) => {
        const n = await prisma.$executeRaw`
          DELETE FROM realtime_events WHERE id IN (
            SELECT id FROM realtime_events WHERE created_at < now() - interval '24 hours' LIMIT ${BATCH})`;
        logger.info({ deleted: n }, 'purged realtime events');
      },
    }),
  ];
}
