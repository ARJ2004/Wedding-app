import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { defineJob } from '../../common/jobs';
import { rtPublish } from '../../common/sse';

export const DELIVERY_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown', 'cancelled'] as const;
export type Counts = Record<(typeof DELIVERY_STATUSES)[number], number>;

/** Counts per delivery status for one message (one indexed GROUP BY). */
export async function deliveryCounts(prisma: PrismaClient | Prisma.TransactionClient, messageId: string): Promise<Counts> {
  const rows = await prisma.message_deliveries.groupBy({ by: ['status'], where: { message_id: messageId, channel: 'whatsapp' }, _count: { _all: true } });
  const counts = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as Counts;
  for (const r of rows) if (r.status in counts) counts[r.status as keyof Counts] = r._count._all;
  return counts;
}

/**
 * Keeps `messages.stats` fresh and tells open message screens (MSG-06): after each batch, and
 * every minute while webhooks move deliveries along. Publishes on the `messages` SSE channel.
 */
export class MessageStats {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async refresh(messageId: string) {
    const m = await this.prisma.messages.findUnique({ where: { id: messageId }, select: { wedding_id: true, status: true, stats: true } });
    if (!m) return null;
    const counts = await deliveryCounts(this.prisma, messageId);
    const before = JSON.stringify((m.stats as { whatsapp?: unknown } | null)?.whatsapp ?? null);
    if (before === JSON.stringify(counts)) return counts;
    await this.prisma.$transaction(async (tx) => {
      await tx.messages.update({ where: { id: messageId }, data: { stats: { whatsapp: counts, refreshedAt: new Date().toISOString() } } });
      await rtPublish(tx, m.wedding_id, 'messages', 'msg.progress', { messageId, status: m.status, counts });
    });
    return counts;
  }

  /** Messages still moving: sending now, or sent in the last two days (read receipts keep coming). */
  async refreshActive() {
    const active = await this.prisma.messages.findMany({
      where: { OR: [{ status: 'sending' }, { status: 'sent', sent_at: { gte: new Date(Date.now() - 2 * 86_400_000) } }] },
      select: { id: true },
      take: 500,
    });
    for (const a of active) await this.refresh(a.id);
    return active.length;
  }

  readonly job = defineJob({
    name: 'msg.stats-refresh',
    lane: 'messaging',
    schema: z.object({}).passthrough(),
    cron: { expression: '* * * * *' },
    handler: async (_p, { logger }) => {
      const n = await this.refreshActive();
      logger.debug({ messages: n }, 'message stats refreshed');
    },
  });
}

/** Stable error code → short label hosts can act on. */
export function errorLabel(code: string | null): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    '131026': 'not_on_whatsapp',
    '131047': 'outside_window',
    '131049': 'meta_limited',
    '131050': 'opted_out',
    '131056': 'rate_limited',
    '130429': 'rate_limited',
    network: 'unclear',
    stuck: 'unclear',
    no_destination: 'no_phone',
  };
  return known[code] ?? 'provider_error';
}
