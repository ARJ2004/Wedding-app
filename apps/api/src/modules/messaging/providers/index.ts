import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../../config/env';
import { LogSinkProvider } from './log-sink';
import { MetaCloudProvider } from './meta-cloud';
import type { MessagingProvider } from './types';

export * from './types';
export * from './meta-format';
export { LogSinkProvider, LOG_SINK_FAIL_FINAL, LOG_SINK_FAIL_RETRY } from './log-sink';
export { MetaCloudProvider } from './meta-cloud';

/** Never sends and accepts no webhooks: what production gets if config checks were bypassed. */
const unconfigured: MessagingProvider = {
  channel: 'whatsapp',
  name: 'unconfigured',
  sendTemplate: async () => ({ ok: false, retryable: false, code: 'not_configured' }),
  verifyWebhook: () => false,
  parseWebhook: () => [],
  listTemplates: async () => [],
  submitTemplate: async () => {
    throw new Error('WhatsApp is not configured');
  },
};

/** Picks the WhatsApp adapter from config. Meta without credentials falls back to the log sink outside production. */
export function createWhatsAppProvider(config: AppConfig, prisma: PrismaClient): MessagingProvider {
  const haveMeta = config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_WABA_ID && config.WHATSAPP_ACCESS_TOKEN;
  if (config.MESSAGING_PROVIDER === 'meta' && haveMeta) {
    return new MetaCloudProvider({
      graphBase: config.WHATSAPP_GRAPH_BASE,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID!,
      wabaId: config.WHATSAPP_WABA_ID!,
      accessToken: config.WHATSAPP_ACCESS_TOKEN!,
      appSecret: config.WHATSAPP_APP_SECRET,
    });
  }
  if (config.NODE_ENV === 'production') return unconfigured; // loadConfig already refuses this; belt and braces
  return new LogSinkProvider(prisma, config.WHATSAPP_APP_SECRET);
}
