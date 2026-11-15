import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { defineJob } from '../../../common/jobs';
import type { MessagingProvider } from '../providers';
import { CATALOGUE, type CatalogueTemplate } from './catalogue';

/**
 * Template catalogue (MSG-02): code → DB (`syncCatalogue`), DB drafts → provider (`push`),
 * provider status → DB (`pullStatus`, every 15 min). The log sink approves everything at once.
 */
export class TemplateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: MessagingProvider,
    private readonly logger: Logger,
  ) {}

  /** Upserts the catalogue rows. Body changes on an approved variant reset it to draft. */
  async syncCatalogue(list: CatalogueTemplate[] = CATALOGUE) {
    const autoApprove = this.provider.name === 'log';
    let variants = 0;
    for (const t of list) {
      const tpl = await this.prisma.message_templates.upsert({
        where: { key: t.key },
        create: { key: t.key, purpose: t.purpose, category: t.category, host_selectable: t.hostSelectable, description: t.description },
        update: { purpose: t.purpose, category: t.category, host_selectable: t.hostSelectable, description: t.description },
      });
      for (const v of t.variants) {
        const data = {
          provider_template_name: v.name,
          body: v.body,
          params_schema: v.params as unknown as Prisma.InputJsonValue,
          buttons: (v.buttons ?? []) as unknown as Prisma.InputJsonValue,
          header_kind: v.header ?? 'none',
        };
        const where = { template_id_channel_language_provider: { template_id: tpl.id, channel: v.channel, language: v.language, provider: this.provider.name } };
        const existing = await this.prisma.message_template_variants.findUnique({ where });
        if (!existing) {
          await this.prisma.message_template_variants.create({
            data: { template_id: tpl.id, channel: v.channel, language: v.language, provider: this.provider.name, ...data, approval_status: autoApprove ? 'approved' : 'draft' },
          });
        } else {
          const changed = existing.body !== v.body || existing.provider_template_name !== v.name;
          await this.prisma.message_template_variants.update({
            where: { id: existing.id },
            data: { ...data, ...(changed && !autoApprove ? { approval_status: 'draft', rejection_reason: null } : {}), updated_at: new Date() },
          });
        }
        variants++;
      }
    }
    return { templates: list.length, variants };
  }

  /** Submits every draft variant to the provider; returns how many were submitted. */
  async push(list: CatalogueTemplate[] = CATALOGUE) {
    const drafts = await this.prisma.message_template_variants.findMany({ where: { provider: this.provider.name, approval_status: 'draft' }, include: { message_templates: true } });
    let submitted = 0;
    for (const d of drafts) {
      const def = list.find((t) => t.key === d.message_templates.key)?.variants.find((v) => v.language === d.language && v.channel === d.channel);
      if (!def) continue;
      await this.provider.submitTemplate({
        name: def.name,
        language: def.language,
        category: d.message_templates.category as 'utility' | 'authentication',
        body: def.body,
        examples: def.examples,
        quickReplies: def.buttons?.map((b) => b.text),
        headerKind: def.header,
      });
      await this.prisma.message_template_variants.update({ where: { id: d.id }, data: { approval_status: 'submitted', updated_at: new Date() } });
      submitted++;
    }
    return submitted;
  }

  /** Pulls approval status; an approved template turning paused/rejected/disabled is an alert. */
  async pullStatus() {
    const remote = await this.provider.listTemplates();
    const byKey = new Map(remote.map((r) => [`${r.name}/${r.language}`, r]));
    const ours = await this.prisma.message_template_variants.findMany({ where: { provider: this.provider.name, channel: 'whatsapp' }, include: { message_templates: true } });
    const alerts: string[] = [];
    let changed = 0;
    for (const v of ours) {
      const r = byKey.get(`${v.provider_template_name}/${v.language}`);
      if (!r) continue;
      if (r.status !== v.approval_status) {
        if (v.approval_status === 'approved' && ['paused', 'rejected', 'disabled'].includes(r.status)) {
          alerts.push(`${v.message_templates.key}/${v.language} is now ${r.status}`);
        }
        changed++;
      }
      await this.prisma.message_template_variants.update({
        where: { id: v.id },
        data: { approval_status: r.status, rejection_reason: r.reason ?? null, status_synced_at: new Date() },
      });
    }
    // Logged at error level: the CloudWatch metric filter on level 50 pages the on-call.
    for (const a of alerts) this.logger.error({ alert: 'msg.template_unavailable' }, `WhatsApp template ${a}`);
    return { changed, alerts };
  }

  readonly jobs = {
    sync: defineJob({
      name: 'msg.template-sync',
      lane: 'messaging',
      schema: z.object({}).passthrough(),
      cron: { expression: '*/15 * * * *' },
      handler: async (_p, { logger }) => {
        const r = await this.pullStatus();
        logger.info({ changed: r.changed, alerts: r.alerts.length }, 'template status synced');
      },
    }),
  };
}
