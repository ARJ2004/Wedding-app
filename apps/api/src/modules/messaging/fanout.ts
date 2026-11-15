import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { defineJob, type JobQueue } from '../../common/jobs';
import { writeAudit } from '../audit';
import { AudienceSpec, resolveAudience } from './audience';
import { phoneHash } from './phone-hash';
import type { MessagingProvider } from './providers';
import { mapLimit, TokenBucket } from './token-bucket';
import type { MessageStats } from './status';

const BATCH = 50;
const IN_FLIGHT = 10;
const BACKOFF_MS = [30_000, 120_000, 600_000];
const STUCK_MS = 5 * 60_000;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 80-bit base32 reply reference carried in button payloads (07-msg §4). */
export function newReplyRef(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export interface FanoutDeps {
  prisma: PrismaClient;
  jobs: JobQueue;
  provider: MessagingProvider;
  logger: Logger;
  piiHashKey: string;
  /** Provider calls per second in this process. */
  rate?: number;
  /** MSG-06: refreshes messages.stats and publishes progress after each batch. */
  stats?: MessageStats;
}

/**
 * Fan-out worker (MSG-05, 07-msg §5): resolve the audience at send time into recipients and
 * deliveries (one transaction, idempotent), then send in batches of 50 with ≤ 10 in flight under
 * a token bucket. A delivery is claimed `queued → sending` before the provider call, so a re-run
 * batch never double-sends; anything left in `sending` for 5 minutes becomes `unknown` and is
 * never resent automatically (at-most-once); the status webhook reconciles it.
 */
export class FanoutService {
  private readonly bucket: TokenBucket;

  constructor(private readonly d: FanoutDeps) {
    this.bucket = new TokenBucket(d.rate ?? 60);
  }

  /** Called by the send endpoint after it moved the message to `resolving`. */
  async enqueueResolve(messageId: string, version: number) {
    const id = await this.d.jobs.send(this.jobs.resolve, { messageId, version }, { singletonKey: `resolve:${messageId}:${version}` });
    // null: pg-boss refused it (queue not created yet, e.g. API deployed before the worker). The sweep picks it up.
    if (id === null) this.d.logger.warn({ messageId }, 'resolve job not queued; sweep will retry');
  }

  /** Safety net: messages left in `resolving` (lost job, deploy order) are re-queued after a minute. */
  async sweepResolving() {
    const stale = await this.d.prisma.messages.findMany({
      where: { status: 'resolving', updated_at: { lt: new Date(Date.now() - 60_000) } },
      select: { id: true, version: true },
      take: 100,
    });
    for (const m of stale) await this.enqueueResolve(m.id, m.version);
    return stale.length;
  }

  async resolve(messageId: string, version: number) {
    const { prisma } = this.d;
    const m = await prisma.messages.findUnique({ where: { id: messageId } });
    if (!m || m.status !== 'resolving' || m.version !== version) return { skipped: true as const };
    const members = await resolveAudience(prisma, m.wedding_id, AudienceSpec.parse(m.audience ?? {}), this.d.piiHashKey);
    const variants = m.template_id
      ? await prisma.message_template_variants.findMany({ where: { template_id: m.template_id, provider: this.d.provider.name, channel: 'whatsapp', approval_status: 'approved' } })
      : [];
    const variantFor = (lang: string) => variants.find((v) => v.language === lang) ?? variants.find((v) => v.language === 'en');
    const wantsWhatsapp = m.channels.includes('whatsapp');
    const fallbackDue = m.sms_fallback ? new Date(Date.now() + m.fallback_after_minutes * 60_000) : null;

    await prisma.$transaction(async (tx) => {
      await tx.message_recipients.createMany({
        data: members.map((r) => ({
          message_id: m.id,
          guest_id: r.guestId,
          wedding_id: m.wedding_id,
          party_id: r.partyId,
          language: r.language,
          reply_ref: newReplyRef(),
          suppressed_reason: r.suppressed ?? (wantsWhatsapp && !variantFor(r.language) ? 'no_template' : null),
        })),
        skipDuplicates: true, // a retried resolve keeps the first rows
      });
      if (wantsWhatsapp) {
        await tx.message_deliveries.createMany({
          data: members
            .filter((r) => !r.suppressed && r.phoneE164 && variantFor(r.language))
            .map((r) => ({
              wedding_id: m.wedding_id,
              message_id: m.id,
              guest_id: r.guestId,
              channel: 'whatsapp',
              provider: this.d.provider.name,
              variant_id: variantFor(r.language)!.id,
              to_hash: phoneHash(this.d.piiHashKey, r.phoneE164!),
              billable_units: 1,
              fallback_due_at: fallbackDue,
            })),
          skipDuplicates: true,
        });
      }
      await tx.messages.update({
        where: { id: m.id },
        data: { status: 'sending', recipient_count: members.length, sending_started_at: new Date(), updated_at: new Date() },
      });
    });

    const queued = await prisma.message_deliveries.findMany({ where: { message_id: m.id, status: 'queued' }, select: { id: true }, orderBy: { id: 'asc' } });
    for (let i = 0; i < queued.length; i += BATCH) {
      await this.d.jobs.send(this.jobs.sendBatch, { deliveryIds: queued.slice(i, i + BATCH).map((q) => q.id) });
    }
    await this.finishIfDone(m.id);
    return { recipients: members.length, deliveries: queued.length };
  }

  /** Claims, renders and sends. Returns per-delivery outcomes (for tests and logs). */
  async sendDeliveries(ids: string[]) {
    const { prisma } = this.d;
    if (ids.length === 0) return [];
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE message_deliveries SET status = 'sending', status_rank = 1, claimed_at = now(), attempts = attempts + 1
      WHERE id = ANY(${ids}::uuid[]) AND status = 'queued'
      RETURNING id`;
    if (claimed.length === 0) return [];
    const rows = await prisma.message_deliveries.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      include: {
        message_template_variants: true,
        message_recipients: { include: { guests: { select: { phone_e164: true } }, messages: { include: { weddings: { select: { title: true } } } } } },
      },
    });
    const outcomes = await mapLimit(rows, IN_FLIGHT, async (d) => {
      const msg = d.message_recipients.messages;
      const v = d.message_template_variants;
      const phone = d.message_recipients.guests.phone_e164;
      if (!v || !phone) {
        await prisma.message_deliveries.update({ where: { id: d.id }, data: { status: 'failed', status_rank: 2, error_code: 'no_destination', failed_at: new Date() } });
        return 'failed' as const;
      }
      const values: Record<string, string> = { wedding: msg.weddings.title, text: msg.body_text ?? '', ...(msg.params as Record<string, string>) };
      const names = (v.params_schema as { name: string }[]).map((p) => p.name);
      await this.bucket.take();
      const r = await this.d.provider.sendTemplate({
        to: phone,
        templateName: v.provider_template_name!,
        language: v.language as 'en' | 'hi' | 'kn',
        params: names.map((n) => values[n] ?? ''),
        callbackRef: d.id,
      });
      if (r.ok) {
        // A fast webhook may already have moved it past `sent`: only the id and timestamps then.
        await prisma.$executeRaw`
          UPDATE message_deliveries SET
            provider_message_id = COALESCE(provider_message_id, ${r.providerMessageId}),
            billable_units = ${r.billableUnits}::smallint,
            sent_at = COALESCE(sent_at, now()),
            status = CASE WHEN status_rank <= 2 THEN 'sent' ELSE status END,
            status_rank = GREATEST(status_rank, 2::smallint)
          WHERE id = ${d.id}::uuid`;
        return 'sent' as const;
      }
      if (r.code === 'network') {
        // Meta may have accepted it: at-most-once, the status webhook will tell us.
        await prisma.message_deliveries.update({ where: { id: d.id }, data: { status: 'unknown', error_code: 'network' } });
        return 'unknown' as const;
      }
      if (r.retryable && d.attempts <= BACKOFF_MS.length) {
        const wait = BACKOFF_MS[d.attempts - 1]!;
        await prisma.message_deliveries.update({ where: { id: d.id }, data: { status: 'queued', status_rank: 0, error_code: r.code, error_detail: r.detail ?? null, next_attempt_at: new Date(Date.now() + wait) } });
        await this.d.jobs.send(this.jobs.sendOne, { deliveryId: d.id }, { startAfter: new Date(Date.now() + wait) });
        return 'retry' as const;
      }
      await prisma.message_deliveries.update({
        where: { id: d.id },
        data: { status: 'failed', status_rank: 2, error_code: r.code, error_detail: r.detail ?? null, failed_at: new Date(), billable_units: 0 },
      });
      return 'failed' as const;
    });
    for (const mid of new Set(rows.map((r) => r.message_id))) {
      await this.finishIfDone(mid);
      await this.d.stats?.refresh(mid);
    }
    return outcomes;
  }

  /** A message is `sent` once nothing is waiting to go (deliveries may still be in flight to handsets). */
  async finishIfDone(messageId: string) {
    const pending = await this.d.prisma.message_deliveries.count({ where: { message_id: messageId, status: { in: ['queued', 'sending'] } } });
    if (pending > 0) return false;
    const n = await this.d.prisma.messages.updateMany({ where: { id: messageId, status: 'sending' }, data: { status: 'sent', sent_at: new Date(), updated_at: new Date() } });
    return n.count > 0;
  }

  /** Re-queues `failed` WhatsApp deliveries (never `unknown`: those may have arrived). */
  async retryFailed(messageId: string) {
    const ids = (
      await this.d.prisma.$queryRaw<{ id: string }[]>`
        UPDATE message_deliveries SET status = 'queued', status_rank = 0, error_code = NULL, error_detail = NULL,
               failed_at = NULL, next_attempt_at = NULL, attempts = 0
        WHERE message_id = ${messageId}::uuid AND channel = 'whatsapp' AND status = 'failed'
        RETURNING id`
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    await this.d.prisma.messages.update({ where: { id: messageId }, data: { status: 'sending', updated_at: new Date() } });
    for (let i = 0; i < ids.length; i += BATCH) await this.d.jobs.send(this.jobs.sendBatch, { deliveryIds: ids.slice(i, i + BATCH) });
    await this.d.stats?.refresh(messageId);
    return ids.length;
  }

  async markStuck() {
    const cutoff = new Date(Date.now() - STUCK_MS);
    const stuck = await this.d.prisma.message_deliveries.findMany({ where: { status: 'sending', claimed_at: { lt: cutoff } }, select: { id: true, message_id: true }, take: 1000 });
    if (stuck.length === 0) return 0;
    await this.d.prisma.message_deliveries.updateMany({ where: { id: { in: stuck.map((s) => s.id) }, status: 'sending' }, data: { status: 'unknown', error_code: 'stuck' } });
    for (const mid of new Set(stuck.map((s) => s.message_id))) await this.finishIfDone(mid);
    return stuck.length;
  }

  readonly jobs = {
    resolve: defineJob({
      name: 'msg.resolve',
      lane: 'messaging',
      schema: z.object({ messageId: z.string().uuid(), version: z.number().int() }),
      handler: async ({ messageId, version }, { logger }) => {
        logger.info({ messageId, ...(await this.resolve(messageId, version)) }, 'message resolved');
      },
    }),
    sendBatch: defineJob({
      name: 'msg.send-batch',
      lane: 'messaging',
      schema: z.object({ deliveryIds: z.array(z.string().uuid()).max(BATCH) }),
      handler: async ({ deliveryIds }) => {
        await this.sendDeliveries(deliveryIds);
      },
    }),
    // Separate queue: OTPs, confirmations and retries never wait behind a 2,000-guest blast.
    sendOne: defineJob({
      name: 'msg.send-one',
      lane: 'messaging-priority',
      schema: z.object({ deliveryId: z.string().uuid() }),
      handler: async ({ deliveryId }) => {
        await this.sendDeliveries([deliveryId]);
      },
    }),
    resolveSweep: defineJob({
      name: 'msg.resolve-sweep',
      lane: 'messaging',
      schema: z.object({}).passthrough(),
      cron: { expression: '* * * * *' },
      handler: async (_p, { logger }) => {
        const n = await this.sweepResolving();
        if (n) logger.warn({ messages: n }, 're-queued messages stuck in resolving');
      },
    }),
    stuckSweep: defineJob({
      name: 'msg.stuck-sweep',
      lane: 'messaging',
      schema: z.object({}).passthrough(),
      cron: { expression: '*/5 * * * *' },
      handler: async (_p, { logger }) => {
        const n = await this.markStuck();
        if (n) logger.warn({ deliveries: n }, 'deliveries stuck in sending marked unknown');
      },
    }),
  };

  /** Audit + state change for POST /send, in one place for the route. */
  async startSend(m: { id: string; wedding_id: string; version: number }, userId: string) {
    const n = await this.d.prisma.messages.updateMany({
      where: { id: m.id, status: 'draft', version: m.version },
      data: { status: 'resolving', updated_at: new Date() },
    });
    if (n.count === 0) return false;
    await writeAudit(this.d.prisma, { weddingId: m.wedding_id, actor: { type: 'user', id: userId }, action: 'message.send', entityType: 'message', entityId: m.id });
    await this.enqueueResolve(m.id, m.version);
    return true;
  }
}
