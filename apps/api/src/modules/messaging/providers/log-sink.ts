import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { parseMetaWebhook, verifyMetaSignature } from './meta-format';
import type { MessagingProvider, ProviderTemplateStatus, SendResult, TemplateSendRequest } from './types';

/** Numbers ending in these digits fail in dev/test, so failure paths can be exercised without Meta. */
export const LOG_SINK_FAIL_FINAL = '99999';
export const LOG_SINK_FAIL_RETRY = '99998';

/**
 * Dev/test WhatsApp provider (MSG-01): writes what would have been sent to `messaging_log_sink`
 * and accepts Meta-format webhooks signed with the dev app secret. Config refuses it in production.
 */
export class LogSinkProvider implements MessagingProvider {
  readonly channel = 'whatsapp' as const;
  readonly name = 'log';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly appSecret: string,
  ) {}

  async sendTemplate(req: TemplateSendRequest): Promise<SendResult> {
    if (req.to.endsWith(LOG_SINK_FAIL_FINAL)) return { ok: false, retryable: false, code: '131026', detail: 'Message undeliverable (log sink)' };
    if (req.to.endsWith(LOG_SINK_FAIL_RETRY)) return { ok: false, retryable: true, code: '131056', detail: 'Pair rate limit (log sink)' };
    const providerMessageId = `wamid.log.${randomUUID()}`;
    await this.prisma.messaging_log_sink.create({
      data: {
        channel: 'whatsapp',
        to_address: req.to,
        template_key: req.templateName,
        language: req.language,
        rendered: `${req.templateName}(${req.params.join(' | ')})${req.buttonPayloads?.length ? ` [${req.buttonPayloads.join(', ')}]` : ''}`,
        payload: { ...req },
        provider_message_id: providerMessageId,
      },
    });
    return { ok: true, providerMessageId, billableUnits: 1 };
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    return verifyMetaSignature(this.appSecret, rawBody, headers);
  }

  parseWebhook(body: unknown) {
    return parseMetaWebhook(body);
  }

  async listTemplates(): Promise<ProviderTemplateStatus[]> {
    return [];
  }

  async submitTemplate(): Promise<void> {
    /* dev: templates count as approved on seed */
  }
}
