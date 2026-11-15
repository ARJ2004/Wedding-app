import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { defineJob } from '../../../common/jobs';
import { decodeReply } from './codec';

export interface InboundReplyCommand {
  /** messaging_webhook_events.id: handlers must be idempotent on it. */
  inboundId: string;
  action: string;
  weddingId: string;
  guestId: string;
  partyId: string;
  messageId?: string;
  context: Record<string, unknown>;
  args: Record<string, string>;
  providerMessageId: string;
  receivedAt: Date;
}
export interface InboundReplyResult {
  outcome: 'ok' | 'already_done' | 'rejected';
  reply?: { templateKey: string; params: Record<string, string> };
}
export interface InboundReplyHandler {
  handle(cmd: InboundReplyCommand): Promise<InboundReplyResult>;
}

const MAX_ATTEMPTS = 5;

interface Resolved {
  weddingId: string;
  guestId: string;
  partyId: string;
  messageId?: string;
  deliveryId?: string;
  context: Record<string, unknown>;
}

/**
 * Inbound reply router (MSG-11). RSV registers `rsv`, ARR registers `arr` at boot, so MSG never
 * imports them (dependency inversion, 07-msg §2). Resolution: WhatsApp context id → delivery;
 * else the payload's reply_ref → recipient; else the sender's phone hash → latest delivery (30 days).
 */
export class ReplyRouter {
  private readonly handlers = new Map<string, InboundReplyHandler>();
  /** MSG-05 sends handler replies; until then they are kept on the event. */
  sendReply?: (cmd: InboundReplyCommand, reply: NonNullable<InboundReplyResult['reply']>) => Promise<void>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  register(prefix: string, handler: InboundReplyHandler) {
    if (prefix === 'msg') throw new Error('msg.* is handled by messaging itself');
    this.handlers.set(prefix, handler);
  }

  private async resolve(ev: { from_hash: Uint8Array | null; payload: Prisma.JsonValue }, replyRef?: string): Promise<Resolved | null> {
    const p = ev.payload as { contextId?: string | null };
    const pick = async (where: Prisma.message_deliveriesWhereInput) => {
      const d = await this.prisma.message_deliveries.findFirst({
        where,
        orderBy: { queued_at: 'desc' },
        include: { message_recipients: { select: { party_id: true, messages: { select: { context: true } } } } },
      });
      return d
        ? { weddingId: d.wedding_id, guestId: d.guest_id, partyId: d.message_recipients.party_id, messageId: d.message_id, deliveryId: d.id, context: (d.message_recipients.messages.context ?? {}) as Record<string, unknown> }
        : null;
    };
    if (p.contextId) {
      const byContext = await pick({ provider_message_id: p.contextId });
      if (byContext) return byContext;
    }
    if (replyRef) {
      const r = await this.prisma.message_recipients.findUnique({ where: { reply_ref: replyRef }, include: { messages: { select: { context: true } } } });
      if (r) return { weddingId: r.wedding_id, guestId: r.guest_id, partyId: r.party_id, messageId: r.message_id, context: (r.messages.context ?? {}) as Record<string, unknown> };
    }
    if (ev.from_hash) {
      return pick({ to_hash: Buffer.from(ev.from_hash), queued_at: { gte: new Date(Date.now() - 30 * 86_400_000) } });
    }
    return null;
  }

  /** Routes one stored inbound event. Safe to run twice: a routed event is skipped. */
  async route(eventId: bigint) {
    const ev = await this.prisma.messaging_webhook_events.findUnique({ where: { id: eventId } });
    if (!ev || ev.kind !== 'inbound' || ev.route_status !== 'pending') return 'skipped';
    const p = ev.payload as { payload?: string | null; text?: string | null };
    const decoded = decodeReply(p.payload, p.text);
    const target = await this.resolve(ev, decoded?.replyRef);
    const base = {
      wedding_id: target?.weddingId ?? null,
      guest_id: target?.guestId ?? null,
      delivery_id: target?.deliveryId ?? null,
      action: decoded?.action ?? null,
      processed_at: new Date(),
      attempts: { increment: 1 },
    };
    const finish = (route_status: string, route_result?: unknown) =>
      this.prisma.messaging_webhook_events.update({ where: { id: eventId }, data: { ...base, route_status, ...(route_result ? { route_result: route_result as Prisma.InputJsonValue } : {}) } });

    if (!decoded) {
      await finish('unmatched'); // free text: shown to hosts in the replies view (MSG-06)
      return 'unmatched';
    }
    if (decoded.action === 'msg.stop' || decoded.action === 'msg.start') {
      if (!ev.from_hash) return (await finish('ignored'), 'ignored');
      const phone_hash = Buffer.from(ev.from_hash);
      if (decoded.action === 'msg.stop') {
        await this.prisma.messaging_opt_outs.upsert({
          where: { phone_hash_channel: { phone_hash, channel: 'whatsapp' } },
          create: { phone_hash, channel: 'whatsapp', source: p.payload ? 'button' : 'stop_keyword', wedding_id: target?.weddingId ?? null },
          update: {},
        });
      } else {
        await this.prisma.messaging_opt_outs.deleteMany({ where: { phone_hash, channel: 'whatsapp' } });
      }
      await finish('routed', { outcome: 'ok' });
      return 'routed';
    }
    const handler = this.handlers.get(decoded.action.split('.')[0]!);
    if (!handler) return (await finish('ignored', { reason: 'no_handler' }), 'ignored');
    if (!target) return (await finish('unmatched', { reason: 'no_recipient' }), 'unmatched');

    const cmd: InboundReplyCommand = {
      inboundId: String(ev.id),
      action: decoded.action,
      weddingId: target.weddingId,
      guestId: target.guestId,
      partyId: target.partyId,
      messageId: target.messageId,
      context: target.context,
      args: decoded.args,
      providerMessageId: ev.external_id,
      receivedAt: ev.received_at,
    };
    try {
      const result = await handler.handle(cmd);
      if (result.reply && this.sendReply) await this.sendReply(cmd, result.reply);
      await finish('routed', result);
      return 'routed';
    } catch (err) {
      const final = ev.attempts + 1 >= MAX_ATTEMPTS;
      this.logger.warn({ err, action: decoded.action, final }, 'reply handler failed');
      await this.prisma.messaging_webhook_events.update({
        where: { id: eventId },
        data: { attempts: { increment: 1 }, ...(final ? { route_status: 'failed', processed_at: new Date() } : {}) },
      });
      if (!final) throw err; // pg-boss retries
      return 'failed';
    }
  }

  readonly job = defineJob({
    name: 'msg.inbound-route',
    lane: 'messaging',
    schema: z.object({ webhookEventId: z.string().regex(/^\d+$/) }),
    handler: async ({ webhookEventId }) => {
      await this.route(BigInt(webhookEventId));
    },
  });

  /** Safety net: re-enqueue anything still pending after 2 minutes (a lost job, a crash). */
  sweepJob(enqueue: (id: bigint) => Promise<void>) {
    return defineJob({
      name: 'msg.inbound-sweep',
      lane: 'messaging',
      schema: z.object({}).passthrough(),
      cron: { expression: '*/5 * * * *' },
      handler: async () => {
        const stuck = await this.prisma.messaging_webhook_events.findMany({
          where: { kind: 'inbound', route_status: 'pending', received_at: { lt: new Date(Date.now() - 120_000) } },
          select: { id: true },
          take: 500,
        });
        for (const s of stuck) await enqueue(s.id);
      },
    });
  }
}
