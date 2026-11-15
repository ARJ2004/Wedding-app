import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { idempotent } from '../../common/idempotency';
import { writeAudit } from '../audit';
import { WeddingParams } from '../weddings/schemas';
import { AudienceSpec, resolveAudience } from './audience';
import type { MessagingProvider } from './providers';

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
export function messageRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; provider: MessagingProvider; piiHashKey: string }) {
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
}
