import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineJob } from '../../common/jobs';

/**
 * ACC-05 housekeeping: purge old OTP challenges (no codes are kept, only HMACs; 30 days is enough
 * for limits and support) and raise an alert when one phone asks for codes across many weddings.
 */
export function accessJobs(prisma: PrismaClient) {
  return [
    defineJob({
      name: 'acc.purge',
      lane: 'default',
      schema: z.object({}).passthrough(),
      cron: { expression: '23 3 * * *', tz: 'Asia/Kolkata' },
      handler: async (_p, { logger }) => {
        const otp = await prisma.$executeRaw`
          DELETE FROM otp_challenges WHERE id IN (
            SELECT id FROM otp_challenges WHERE created_at < now() - interval '30 days' LIMIT 5000)`;
        const state = await prisma.$executeRaw`
          DELETE FROM party_auth_state
          WHERE (locked_until IS NULL OR locked_until < now() - interval '7 days') AND updated_at < now() - interval '7 days'`;
        logger.info({ otp, state }, 'access purge');
      },
    }),
    defineJob({
      name: 'acc.abuse-scan',
      lane: 'default',
      schema: z.object({}).passthrough(),
      cron: { expression: '41 * * * *' },
      handler: async (_p, { logger }) => {
        const rows = await prisma.$queryRaw<{ weddings: number; sends: number }[]>`
          SELECT count(DISTINCT wedding_id)::int AS weddings, count(*)::int AS sends
          FROM otp_challenges WHERE created_at > now() - interval '24 hours'
          GROUP BY phone_hmac HAVING count(DISTINCT wedding_id) >= 3 OR count(*) >= 15`;
        // Error level: the CloudWatch metric filter pages on it. No phone, party or IP in the log.
        for (const r of rows) logger.error({ alert: 'acc.otp_abuse', weddings: r.weddings, sends: r.sends }, 'one phone asked for many codes');
      },
    }),
  ];
}
