import type { Prisma, PrismaClient } from '@prisma/client';
import express, { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors';
import { phoneHash } from './phone-hash';
import type { DeliveryStatus, MessagingProvider, WebhookItem } from './providers';

const RANK: Record<DeliveryStatus, number> = { sent: 2, delivered: 3, read: 4, failed: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_STATUS: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', PENDING: 'submitted', FLAGGED: 'approved', REINSTATED: 'approved' };

export interface WebhookDeps {
  prisma: PrismaClient;
  logger: Logger;
  providers: MessagingProvider[];
  piiHashKey: string;
  verifyToken: string;
  /** MSG-11 plugs the inbound router in here. */
  onInbound?: (webhookEventId: bigint) => Promise<void>;
}

/**
 * Applies one status inline (07-msg §2): a single indexed UPDATE that never lowers status_rank,
 * matched by our delivery id (biz_opaque_callback_data) or the provider's message id.
 * Returns 'applied' | 'stale' (older than what we have) | 'unmatched' (stored for later).
 */
export async function applyStatus(prisma: PrismaClient, provider: string, s: Extract<WebhookItem, { type: 'status' }>) {
  const rank = RANK[s.status];
  const ref = s.callbackRef && UUID.test(s.callbackRef) ? s.callbackRef : null;
  const failed = s.status === 'failed';
  const n = await prisma.$executeRaw`
    UPDATE message_deliveries d SET
      status = ${s.status},
      status_rank = GREATEST(d.status_rank, ${rank}::smallint),
      provider_message_id = COALESCE(d.provider_message_id, ${s.providerMessageId}),
      sent_at = CASE WHEN ${s.status} <> 'failed' THEN COALESCE(d.sent_at, ${s.at}) ELSE d.sent_at END,
      delivered_at = CASE WHEN ${s.status} IN ('delivered','read') THEN COALESCE(d.delivered_at, ${s.at}) ELSE d.delivered_at END,
      read_at = CASE WHEN ${s.status} = 'read' THEN COALESCE(d.read_at, ${s.at}) ELSE d.read_at END,
      failed_at = CASE WHEN ${failed} THEN ${s.at} ELSE d.failed_at END,
      error_code = CASE WHEN ${failed} THEN ${s.error?.code ?? null} ELSE d.error_code END,
      error_detail = CASE WHEN ${failed} THEN ${s.error?.title?.slice(0, 200) ?? null} ELSE d.error_detail END
    WHERE d.provider = ${provider}
      AND (d.provider_message_id = ${s.providerMessageId} OR d.id = ${ref}::uuid)
      AND (d.status_rank < ${rank}::smallint
           OR (${failed} AND d.status NOT IN ('failed','delivered','read','cancelled')))`;
  if (n > 0) return 'applied' as const;
  const known = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM message_deliveries
    WHERE provider = ${provider} AND (provider_message_id = ${s.providerMessageId} OR id = ${ref}::uuid) LIMIT 1`;
  if (known.length) return 'stale' as const;
  await prisma.messaging_webhook_events.createMany({
    data: [
      {
        provider,
        kind: 'status_unmatched',
        external_id: `${s.providerMessageId}:${s.status}`,
        payload: { ...s, at: s.at.toISOString() } as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return 'unmatched' as const;
}

async function applyItem(deps: WebhookDeps, provider: string, item: WebhookItem) {
  if (item.type === 'status') return applyStatus(deps.prisma, provider, item);
  if (item.type === 'template_status') {
    const status = TEMPLATE_STATUS[item.event];
    if (status) {
      await deps.prisma.message_template_variants.updateMany({
        where: { provider, provider_template_name: item.name, language: item.language },
        data: { approval_status: status, rejection_reason: item.reason ?? null, status_synced_at: new Date(), updated_at: new Date() },
      });
    }
    await deps.prisma.messaging_webhook_events.createMany({
      data: [{ provider, kind: 'template_status', external_id: item.externalId, payload: item as unknown as Prisma.InputJsonValue, route_status: 'ignored', processed_at: new Date() }],
      skipDuplicates: true,
    });
    return 'template';
  }
  // Inbound reply: stored (deduped by WhatsApp id) for the reply router; no clear phone kept.
  const rows = await deps.prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO messaging_webhook_events (provider, kind, external_id, from_hash, inbound_type, payload, received_at)
    VALUES (${provider}, 'inbound', ${item.externalId}, ${phoneHash(deps.piiHashKey, item.fromE164)}, ${item.inboundType},
            ${JSON.stringify({ payload: item.payload ?? null, text: item.text?.slice(0, 1000) ?? null, contextId: item.contextId ?? null })}::jsonb, ${item.at})
    ON CONFLICT (provider, kind, external_id) DO NOTHING
    RETURNING id`;
  if (rows[0] && deps.onInbound) await deps.onInbound(rows[0].id);
  return rows[0] ? 'inbound' : 'duplicate';
}

/**
 * Provider webhooks (MSG-01). Mounted before express.json and the global rate limit: the
 * signature is checked on the raw body, and one blast produces thousands of callbacks.
 */
export function webhookRouter(deps: WebhookDeps) {
  const router = Router();
  const byName = new Map(deps.providers.map((p) => [p.name, p]));
  const raw = express.raw({ type: '*/*', limit: '1mb' });

  // Meta's subscription handshake.
  router.get('/v1/webhooks/whatsapp/meta', (req: Request, res: Response) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === deps.verifyToken) {
      res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    throw new AppError('MSG_WEBHOOK_FORBIDDEN', 'Verification failed', 403);
  });

  router.post('/v1/webhooks/whatsapp/:provider', raw, async (req: Request, res: Response) => {
    const name = req.params.provider === 'meta' ? 'meta_cloud' : String(req.params.provider);
    const provider = byName.get(name);
    if (!provider) throw new AppError('NOT_FOUND', 'Not found', 404);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!provider.verifyWebhook(body, req.headers)) throw new AppError('MSG_WEBHOOK_SIGNATURE', 'Bad signature', 401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Body is not JSON', 400);
    }
    const counts: Record<string, number> = {};
    for (const item of provider.parseWebhook(parsed)) {
      const outcome = await applyItem(deps, provider.name, item);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    deps.logger.debug({ provider: provider.name, counts }, 'whatsapp webhook');
    res.json({ received: counts });
  });
  return router;
}
