import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import type { JobQueue } from './common/jobs';
import type { ObjectStore } from './common/object-store';
import type { Metrics } from './common/observability';
import type { RealtimeHub } from './common/sse';
import type { MessagingProvider } from './modules/messaging/providers/types';

/**
 * Everything a module needs, built once in main.ts / worker.ts / tests and passed down.
 * Later stories add messaging, push, clock and verifiers.
 */
export interface Deps {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  objectStore: ObjectStore;
  jobs: JobQueue;
  /** Optional so tests and scripts can skip it. */
  metrics?: Metrics;
  /** SSE hub; createApp builds one on DATABASE_URL when absent (LISTEN starts on the first stream). */
  realtime?: RealtimeHub;
  /** WhatsApp adapter; createApp picks Meta or the dev log sink from config when absent. */
  whatsapp?: MessagingProvider;
}
