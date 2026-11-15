import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { idempotent } from '../../common/idempotency';
import { writeAudit } from '../audit';
import { WeddingParams } from '../weddings/schemas';
import { AudienceSpec, resolveAudience } from './audience';
import type { MessagingProvider } from './providers';
import type { FanoutService } from './fanout';
import { deliveryCounts, errorLabel } from './status';

const Lang = z.enum(['en', 'hi', 'kn']);
const Channel = z.enum(['whatsapp', 'push']);
const MessageParams = WeddingParams.extend({ messageId: z.string().uuid() });

const DraftInput = z.object({
  templateKey: z.string().min(1).max(64),
  title: z.string().trim().max(80).nullish(),
  bodyText: z.string().trim().min(1).max(1024),
  sourceLanguage: Lang.default('en'),
  mediaId: z.string().uuid().nullish(),
  linkTarget: z.enum(['none', 'guest_home', 'schedule', 'travel', 'rsvp', 'gallery']).default('guest_home'),
  audience: AudienceSpec.default({}),
  channels: z.array(Channel).min(1).max(2).default(['whatsapp', 'push']),
  smsFallback: z.boolean().default(true),
  fallbackAfterMinutes: z.number().int().min(1).max(120).default(10),
});
const PatchInput = DraftInput.partial().extend({ version: z.number().int().min(1) });

const Message = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    status: z.enum(['draft', 'scheduled', 'resolving', 'sending', 'sent', 'cancelled', 'failed']),
    version: z.number().int(),
    templateKey: z.string().nullable(),
    title: z.string().nullable(),
    bodyText: z.string().nullable(),
    sourceLanguage: Lang,
    mediaId: z.string().nullable(),
    linkTarget: z.string().nullable(),
    audience: AudienceSpec,
    channels: z.array(Channel),
    smsFallback: z.boolean(),
    fallbackAfterMinutes: z.number().int(),
    scheduledAt: z.string().nullable(),
    recipientCount: z.number().int().nullable(),
    stats: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Message');

const AudiencePreview = z
  .object({
    recipients: z.number().int(),
    byChannel: z.object({ whatsapp: z.number().int(), push: z.number().int() }),
    byLanguage: z.record(z.string(), z.number().int()),
    suppressed: z.object({ noPhone: z.number().int(), optedOut: z.number().int(), duplicatePhone: z.number().int() }),
    missingTemplateLanguages: z.array(Lang),
    unitsNeeded: z.number().int(),
    quota: z.object({ limit: z.number().int(), used: z.number().int(), reserved: z.number().int() }).nullable(),
  })
  .openapi('AudiencePreview');

const MessagePreview = z
  .object({ language: Lang, whatsapp: z.object({ text: z.string(), hasImage: z.boolean() }), push: z.object({ title: z.string(), body: z.string() }) })
  .openapi('MessagePreview');

type Row = Prisma.messagesGetPayload<{ include: { message_templates: true } }>;
const toDto = (m: Row): z.infer<typeof Message> => ({
  id: m.id,
  kind: m.kind,
  status: m.status as z.infer<typeof Message>['status'],
  version: m.version,
  templateKey: m.message_templates?.key ?? null,
  title: m.title,
  bodyText: m.body_text,
  sourceLanguage: m.source_language as z.infer<typeof Lang>,
  mediaId: m.media_id,
  linkTarget: m.link_target,
  audience: AudienceSpec.parse(m.audience ?? {}),
  channels: m.channels.filter((c): c is 'whatsapp' | 'push' => c === 'whatsapp' || c === 'push'),
  smsFallback: m.sms_fallback,
  fallbackAfterMinutes: m.fallback_after_minutes,
  scheduledAt: m.scheduled_at?.toISOString() ?? null,
  recipientCount: m.recipient_count,
  stats: (m.stats ?? {}) as Record<string, unknown>,
  createdAt: m.created_at.toISOString(),
  updatedAt: m.updated_at.toISOString(),
});

/** Fills {{1}}..{{n}} from named params in the variant's order. */
export function renderTemplate(body: string, schema: { name: string }[], values: Record<string, string>) {
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => values[schema[Number(n) - 1]?.name ?? ''] ?? '');
}

/**
 * Announcement composer API (MSG-03, 07-msg §4). Sending itself (resolve → fan-out) is MSG-05.
 */
export function messageRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; provider: MessagingProvider; piiHashKey: string; fanout: FanoutService }) {
  const { prisma } = deps;
  const W = '/v1/weddings/:weddingId/messages';

  const template = async (key: string) => {
    const t = await prisma.message_templates.findUnique({
      where: { key },
      include: { message_template_variants: { where: { provider: deps.provider.name, channel: 'whatsapp', approval_status: 'approved' } } },
    });
    if (!t || !t.host_selectable || t.message_template_variants.length === 0) {
      throw new AppError('MSG_TEMPLATE_NOT_APPROVED', 'That template is not available yet', 400);
    }
    return t;
  };
  const checkMedia = async (weddingId: string, templateKey: string, mediaId?: string | null) => {
    const t = await template(templateKey);
    if (t.message_template_variants[0]!.header_kind === 'image' && !mediaId) throw new AppError('MSG_IMAGE_REQUIRED', 'Add a photo for this template', 400);
    if (mediaId && !(await prisma.media_objects.count({ where: { id: mediaId, wedding_id: weddingId } }))) throw new AppError('MEDIA_NOT_FOUND', 'Photo not found', 404);
    return t;
  };
  const load = async (weddingId: string, id: string) => {
    const m = await prisma.messages.findFirst({ where: { id, wedding_id: weddingId }, include: { message_templates: true } });
    if (!m) throw new AppError('MSG_NOT_FOUND', 'Message not found', 404);
    return m;
  };

  defineRoute(ctx, {
    method: 'get',
    path: W,
    summary: 'List messages (newest first)',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: WeddingParams, query: z.object({ status: z.string().optional() }) },
    response: { status: 200, schema: z.object({ items: z.array(Message) }) },
    handler: async ({ params, query }) => {
      const rows = await prisma.messages.findMany({
        where: { wedding_id: params.weddingId, kind: 'announcement', ...(query.status ? { status: query.status } : {}) },
        include: { message_templates: true },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return { items: rows.map(toDto) };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: W,
    summary: 'Create an announcement draft (send an Idempotency-Key)',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    before: [idempotent(prisma, { scope: (req) => `user:${req.principal!.userId}`, route: W, weddingId: (req) => String(req.params.weddingId) })],
    request: { params: WeddingParams, body: DraftInput },
    response: { status: 201, schema: Message },
    errors: [409, 422],
    handler: async ({ params, body, req }) => {
      const t = await checkMedia(params.weddingId, body.templateKey, body.mediaId);
      const m = await prisma.messages.create({
        data: {
          wedding_id: params.weddingId,
          kind: 'announcement',
          template_id: t.id,
          title: body.title ?? null,
          body_text: body.bodyText,
          source_language: body.sourceLanguage,
          media_id: body.mediaId ?? null,
          link_target: body.linkTarget,
          audience: body.audience as Prisma.InputJsonValue,
          channels: body.channels,
          sms_fallback: body.smsFallback,
          fallback_after_minutes: body.fallbackAfterMinutes,
          idempotency_key: req.header('idempotency-key') ?? null,
          created_by_user_id: req.principal!.userId,
        },
        include: { message_templates: true },
      });
      return toDto(m);
    },
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:messageId`,
    summary: 'One message',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: MessageParams },
    response: { status: 200, schema: Message },
    handler: async ({ params }) => toDto(await load(params.weddingId, params.messageId)),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/:messageId`,
    summary: 'Edit a draft or scheduled message (send its version)',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    request: { params: MessageParams, body: PatchInput },
    response: { status: 200, schema: Message },
    errors: [404, 409],
    handler: async ({ params, body }) => {
      const m = await load(params.weddingId, params.messageId);
      if (!['draft', 'scheduled'].includes(m.status)) throw new AppError('MSG_NOT_EDITABLE', 'This message has already gone out', 409);
      const key = body.templateKey ?? m.message_templates?.key ?? '';
      const t = await checkMedia(params.weddingId, key, body.mediaId === undefined ? m.media_id : body.mediaId);
      const n = await prisma.messages.updateMany({
        where: { id: m.id, version: body.version },
        data: {
          template_id: t.id,
          ...(body.title !== undefined ? { title: body.title ?? null } : {}),
          ...(body.bodyText !== undefined ? { body_text: body.bodyText } : {}),
          ...(body.sourceLanguage ? { source_language: body.sourceLanguage } : {}),
          ...(body.mediaId !== undefined ? { media_id: body.mediaId ?? null } : {}),
          ...(body.linkTarget ? { link_target: body.linkTarget } : {}),
          ...(body.audience ? { audience: body.audience as Prisma.InputJsonValue } : {}),
          ...(body.channels ? { channels: body.channels } : {}),
          ...(body.smsFallback !== undefined ? { sms_fallback: body.smsFallback } : {}),
          ...(body.fallbackAfterMinutes ? { fallback_after_minutes: body.fallbackAfterMinutes } : {}),
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });
      if (n.count === 0) throw new AppError('MSG_VERSION_CONFLICT', 'Someone else changed this message; reload it', 409);
      return toDto(await load(params.weddingId, params.messageId));
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/audience-preview`,
    summary: 'Who would receive this audience, by channel and language',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    request: { params: WeddingParams, body: z.object({ audience: AudienceSpec, templateKey: z.string().optional(), channels: z.array(Channel).optional() }) },
    response: { status: 200, schema: AudiencePreview },
    handler: async ({ params, body }) => {
      const members = await resolveAudience(prisma, params.weddingId, body.audience, deps.piiHashKey);
      const sendable = members.filter((m) => !m.suppressed);
      const channels = body.channels ?? ['whatsapp', 'push'];
      const byLanguage: Record<string, number> = {};
      for (const m of members) byLanguage[m.language] = (byLanguage[m.language] ?? 0) + 1;
      let missing: z.infer<typeof Lang>[] = [];
      if (body.templateKey) {
        const t = await template(body.templateKey);
        const have = new Set(t.message_template_variants.map((v) => v.language));
        missing = (Object.keys(byLanguage) as z.infer<typeof Lang>[]).filter((l) => !have.has(l)).sort();
      }
      const whatsapp = channels.includes('whatsapp') ? sendable.length : 0;
      const q = await prisma.message_quotas.findUnique({ where: { wedding_id: params.weddingId } });
      return {
        recipients: members.length,
        byChannel: { whatsapp, push: 0 }, // push devices arrive with MSG-08
        byLanguage,
        suppressed: {
          noPhone: members.filter((m) => m.suppressed === 'no_phone').length,
          optedOut: members.filter((m) => m.suppressed === 'opted_out').length,
          duplicatePhone: members.filter((m) => m.suppressed === 'duplicate_phone').length,
        },
        missingTemplateLanguages: missing,
        unitsNeeded: whatsapp,
        quota: q ? { limit: q.limit_units, used: q.used_units, reserved: q.reserved_units } : null,
      };
    },
  });

  const renderFor = async (weddingId: string, m: Row, language: z.infer<typeof Lang>) => {
    const wedding = await prisma.weddings.findUniqueOrThrow({ where: { id: weddingId }, select: { title: true } });
    const t = await template(m.message_templates?.key ?? '');
    const v = t.message_template_variants.find((x) => x.language === language) ?? t.message_template_variants.find((x) => x.language === 'en')!;
    const values = { wedding: wedding.title, text: m.body_text ?? '' };
    return { v, values, text: renderTemplate(v.body, v.params_schema as { name: string }[], values), weddingTitle: wedding.title };
  };

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:messageId/preview`,
    summary: 'Rendered WhatsApp and push text for a language',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: MessageParams, query: z.object({ language: Lang.default('en') }) },
    response: { status: 200, schema: MessagePreview },
    handler: async ({ params, query }) => {
      const m = await load(params.weddingId, params.messageId);
      const r = await renderFor(params.weddingId, m, query.language);
      return {
        language: query.language,
        whatsapp: { text: r.text, hasImage: r.v.header_kind === 'image' },
        push: { title: m.title || r.weddingTitle, body: (m.body_text ?? '').slice(0, 178) },
      };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:messageId/test`,
    summary: 'Send this message to your own WhatsApp (10 a day)',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    request: { params: MessageParams },
    response: { status: 200, schema: z.object({ sentTo: z.string(), providerMessageId: z.string() }) },
    errors: [404, 409, 429, 502],
    handler: async ({ params, req }) => {
      const m = await load(params.weddingId, params.messageId);
      const user = await prisma.users.findUniqueOrThrow({ where: { id: req.principal!.userId }, select: { phone_e164: true } });
      if (!user.phone_e164) throw new AppError('MSG_NO_PHONE_ON_ACCOUNT', 'Add your WhatsApp number in your profile first', 409);
      const since = new Date(Date.now() - 86_400_000);
      const used = await prisma.audit_log.count({ where: { actor_id: req.principal!.userId, action: 'message.test', created_at: { gte: since } } });
      if (used >= 10) throw new AppError('MSG_TEST_LIMIT', 'You can send 10 test messages a day', 429);
      const r = await renderFor(params.weddingId, m, m.source_language as z.infer<typeof Lang>);
      const names = r.v.params_schema as { name: string }[];
      const result = await deps.provider.sendTemplate({
        to: user.phone_e164,
        templateName: r.v.provider_template_name!,
        language: r.v.language as z.infer<typeof Lang>,
        params: names.map((p) => (r.values as Record<string, string>)[p.name] ?? ''),
        callbackRef: `test:${m.id}`,
      });
      if (!result.ok) throw new AppError('MSG_PROVIDER_FAILED', 'WhatsApp did not accept the test message', 502, { code: result.code });
      await writeAudit(prisma, { weddingId: params.weddingId, actor: { type: 'user', id: req.principal!.userId }, action: 'message.test', entityType: 'message', entityId: m.id });
      return { sentTo: `•••• ${user.phone_e164.slice(-4)}`, providerMessageId: result.providerMessageId };
    },
  });
  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:messageId/send`,
    summary: 'Send a draft now (send an Idempotency-Key); 202 while it goes out',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    before: [idempotent(prisma, { scope: (req) => `user:${req.principal!.userId}`, route: `${W}/:messageId/send`, weddingId: (req) => String(req.params.weddingId) })],
    request: { params: MessageParams, body: z.object({ scheduledAt: z.string().datetime().nullish() }) },
    response: { status: 202, schema: z.object({ status: z.string(), recipientCountEstimate: z.number().int() }) },
    errors: [404, 409, 422],
    handler: async ({ params, body, req }) => {
      if (body.scheduledAt) throw new AppError('MSG_SCHEDULE_UNAVAILABLE', 'Scheduling arrives soon; send now for the moment', 400);
      const m = await load(params.weddingId, params.messageId);
      if (m.status !== 'draft') throw new AppError('MSG_ALREADY_SENT', 'This message has already gone out', 409);
      await template(m.message_templates?.key ?? '');
      const members = await resolveAudience(prisma, params.weddingId, AudienceSpec.parse(m.audience ?? {}), deps.piiHashKey);
      if (!members.some((x) => !x.suppressed)) throw new AppError('MSG_AUDIENCE_EMPTY', 'Nobody in this audience can get a message', 409);
      if (!(await deps.fanout.startSend(m, req.principal!.userId))) throw new AppError('MSG_VERSION_CONFLICT', 'Someone else changed this message; reload it', 409);
      return { status: 'resolving', recipientCountEstimate: members.length };
    },
  });
  const Counts = z.record(z.string(), z.number().int());
  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:messageId/summary`,
    summary: 'Delivery counts for a sent message',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: MessageParams },
    response: {
      status: 200,
      schema: z
        .object({
          messageId: z.string(),
          status: z.string(),
          recipients: z.number().int(),
          suppressed: Counts,
          whatsapp: Counts,
          deliveredPct: z.number().int(),
          readPct: z.number().int(),
          sendingStartedAt: z.string().nullable(),
          sentAt: z.string().nullable(),
        })
        .openapi('MessageSummary'),
    },
    handler: async ({ params }) => {
      const m = await load(params.weddingId, params.messageId);
      const whatsapp = await deliveryCounts(prisma, m.id);
      const sup = await prisma.message_recipients.groupBy({ by: ['suppressed_reason'], where: { message_id: m.id, suppressed_reason: { not: null } }, _count: { _all: true } });
      const total = Object.values(whatsapp).reduce((a, b) => a + b, 0) - whatsapp.cancelled;
      const delivered = whatsapp.delivered + whatsapp.read;
      const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
      return {
        messageId: m.id,
        status: m.status,
        recipients: m.recipient_count ?? 0,
        suppressed: Object.fromEntries(sup.map((x) => [x.suppressed_reason!, x._count._all])),
        whatsapp,
        deliveredPct: pct(delivered),
        readPct: pct(whatsapp.read),
        sendingStartedAt: m.sending_started_at?.toISOString() ?? null,
        sentAt: m.sent_at?.toISOString() ?? null,
      };
    },
  });

  const DeliveryItem = z
    .object({
      deliveryId: z.string(),
      guestId: z.string(),
      guestName: z.string(),
      partyLabel: z.string(),
      status: z.string(),
      errorCode: z.string().nullable(),
      errorLabel: z.string().nullable(),
      /** Full number for owner/co-host; masked for planners (07-msg §8). */
      phone: z.string().nullable(),
      phoneMasked: z.boolean(),
      updatedAt: z.string(),
    })
    .openapi('MessageDelivery');
  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:messageId/deliveries`,
    summary: 'Deliveries for a message, e.g. ?status=failed',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: MessageParams, query: z.object({ status: z.enum(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown']).optional() }) },
    response: { status: 200, schema: z.object({ items: z.array(DeliveryItem) }) },
    handler: async ({ params, query, req }) => {
      const m = await load(params.weddingId, params.messageId);
      const fullPhone = req.membership?.role === 'owner' || req.membership?.role === 'co_host';
      const rows = await prisma.message_deliveries.findMany({
        where: { message_id: m.id, ...(query.status ? { status: query.status } : {}) },
        include: { message_recipients: { include: { guests: { select: { full_name: true, phone_e164: true } }, parties: { select: { label: true } } } } },
        orderBy: [{ queued_at: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      return {
        items: rows.map((d) => {
          const g = d.message_recipients.guests;
          const at = d.read_at ?? d.delivered_at ?? d.failed_at ?? d.sent_at ?? d.queued_at;
          return {
            deliveryId: d.id,
            guestId: d.guest_id,
            guestName: g.full_name,
            partyLabel: d.message_recipients.parties.label,
            status: d.status,
            errorCode: d.error_code,
            errorLabel: errorLabel(d.error_code),
            phone: g.phone_e164 ? (fullPhone ? g.phone_e164 : `${g.phone_e164.slice(0, 3)} ••••• ${g.phone_e164.slice(-3)}`) : null,
            phoneMasked: !fullPhone,
            updatedAt: at.toISOString(),
          };
        }),
      };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:messageId/retry-failed`,
    summary: 'Send the failed WhatsApp messages again',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.send',
    request: { params: MessageParams },
    response: { status: 202, schema: z.object({ requeued: z.number().int() }) },
    errors: [404, 409],
    handler: async ({ params, req }) => {
      const m = await load(params.weddingId, params.messageId);
      if (!['sending', 'sent'].includes(m.status)) throw new AppError('MSG_NOTHING_TO_RETRY', 'Nothing to retry', 409);
      const requeued = await deps.fanout.retryFailed(m.id);
      if (requeued === 0) throw new AppError('MSG_NOTHING_TO_RETRY', 'Nothing failed', 409);
      await writeAudit(prisma, { weddingId: params.weddingId, actor: { type: 'user', id: req.principal!.userId }, action: 'message.retry_failed', entityType: 'message', entityId: m.id, after: { requeued } });
      return { requeued };
    },
  });
}
