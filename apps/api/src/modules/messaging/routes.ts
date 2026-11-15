import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { WeddingParams } from '../weddings/schemas';

const Language = z.enum(['en', 'hi', 'kn']);
const TemplateItem = z
  .object({
    key: z.string(),
    purpose: z.string(),
    description: z.string().nullable(),
    languages: z.array(Language),
    params: z.array(z.object({ name: z.string(), max: z.number().int() })),
    header: z.enum(['none', 'image']),
  })
  .openapi('MessageTemplate');

/** MSG-02: templates a host may pick in the composer (approved, host-selectable, per language). */
export function messagingRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; providerName: string }) {
  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/message-templates',
    summary: 'Approved templates for the announcement composer',
    tags: ['messaging'],
    auth: 'host',
    permission: 'message.read',
    request: { params: WeddingParams, query: z.object({ purpose: z.string().optional(), language: Language.optional() }) },
    response: { status: 200, schema: z.object({ items: z.array(TemplateItem) }) },
    handler: async ({ query }) => {
      const rows = await deps.prisma.message_templates.findMany({
        where: { host_selectable: true, ...(query.purpose ? { purpose: query.purpose } : {}) },
        include: {
          message_template_variants: {
            where: { provider: deps.providerName, channel: 'whatsapp', approval_status: 'approved', ...(query.language ? { language: query.language } : {}) },
            orderBy: { language: 'asc' },
          },
        },
        orderBy: { key: 'asc' },
      });
      return {
        items: rows
          .filter((t) => t.message_template_variants.length > 0)
          .map((t) => {
            const first = t.message_template_variants[0]!;
            return {
              key: t.key,
              purpose: t.purpose,
              description: t.description,
              languages: t.message_template_variants.map((v) => v.language as z.infer<typeof Language>),
              params: first.params_schema as { name: string; max: number }[],
              header: first.header_kind === 'image' ? ('image' as const) : ('none' as const),
            };
          }),
      };
    },
  });
}
