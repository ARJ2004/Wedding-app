import type { Prisma, PrismaClient } from '@prisma/client';
import { REALTIME_CHANNELS, type RealtimeChannel } from '@mehfil/domain';
import type { z } from 'zod';

type Kinds<C extends RealtimeChannel> = (typeof REALTIME_CHANNELS)[C]['kinds'];

/**
 * Writes one realtime event through rt_publish() (FND-14). Call it inside the writer's
 * transaction: NOTIFY fires only on commit, and a rollback drops the event too.
 * The payload is checked against the channel catalogue so nothing private slips onto a channel.
 */
export async function rtPublish<C extends RealtimeChannel, K extends keyof Kinds<C> & string>(
  db: PrismaClient | Prisma.TransactionClient,
  weddingId: string,
  channel: C,
  kind: K,
  payload: z.infer<Kinds<C>[K] & z.ZodTypeAny>,
): Promise<bigint> {
  const schema = (REALTIME_CHANNELS[channel].kinds as Record<string, z.ZodTypeAny>)[kind];
  if (!schema) throw new Error(`unknown realtime kind ${channel}/${kind}`);
  const body = JSON.stringify(schema.parse(payload));
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT rt_publish(${weddingId}::uuid, ${channel}, ${kind}, ${body}::jsonb) AS id`;
  return rows[0]!.id;
}
