import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config/env';
import { housekeepingJobs } from './common/housekeeping';
import { PgBossJobQueue, type JobDefinition } from './common/jobs';
import { createLogger } from './common/logger';
import { createObjectStore } from './common/object-store';
import { ImportService } from './modules/guests/import';
import { MediaService } from './modules/media';
import { createWhatsAppProvider, FanoutService, MessageStats, ReplyRouter, TemplateService } from './modules/messaging';
import type { AppConfig } from './config/env';
import type { Logger } from 'pino';
import { initSentry, Metrics } from './common/observability';
import { wireReplies } from './wiring';

/** Every job the worker runs. Modules add their `jobs()` here as they land. */
export function allJobs(deps: { prisma: PrismaClient; jobs: PgBossJobQueue; objectStore: ReturnType<typeof createObjectStore>; linkTokenKey: string; templates: TemplateService; replies: ReplyRouter; fanout: FanoutService; stats: MessageStats }): JobDefinition[] {
  const media = new MediaService(deps);
  const imports = new ImportService({ prisma: deps.prisma, jobs: deps.jobs, media, linkTokenKey: deps.linkTokenKey });
  return [
    ...housekeepingJobs(deps.prisma), ...Object.values(media.jobs), ...Object.values(imports.jobs), ...Object.values(deps.templates.jobs),
    ...Object.values(deps.fanout.jobs),
    deps.stats.job,
    deps.replies.job,
    deps.replies.sweepJob(async (id) => {
      await deps.jobs.send(deps.replies.job, { webhookEventId: String(id) });
    }),
  ] as JobDefinition[];
}

export function templateService(config: AppConfig, prisma: PrismaClient, logger: Logger) {
  return new TemplateService(prisma, createWhatsAppProvider(config, prisma), logger);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const prisma = new PrismaClient();
  initSentry(config.SENTRY_DSN, config.NODE_ENV, process.env.APP_VERSION ?? 'dev');
  const metrics = new Metrics();
  metrics.listen(config.METRICS_PORT === 0 ? 0 : config.METRICS_PORT + 1);
  const queue = PgBossJobQueue.create(config.DATABASE_URL, logger);
  queue.onOutcome = (q, outcome) => metrics.jobs.inc({ queue: q, outcome });
  await queue.boss.start();
  const templates = templateService(config, prisma, logger);
  const stats = new MessageStats(prisma, logger);
  // Catalogue rows follow the code on every deploy (idempotent); approval comes from the provider.
  logger.info(await templates.syncCatalogue(), 'message templates synced');
  const replies = new ReplyRouter(prisma, logger);
  const fanout = new FanoutService({ prisma, jobs: queue, provider: createWhatsAppProvider(config, prisma), logger, piiHashKey: config.PII_HASH_KEY, rate: config.MSG_WA_RATE, stats });
  wireReplies({ prisma, config, replies, fanout });
  const jobs = allJobs({ prisma, jobs: queue, objectStore: createObjectStore(config), linkTokenKey: config.LINK_TOKEN_KEY, templates, replies, stats, fanout });
  await queue.register(jobs);
  logger.info({ jobs: jobs.map((j) => j.name) }, 'worker started');

  const stop = async (signal: string) => {
    logger.info({ signal }, 'worker stopping');
    await queue.boss.stop({ graceful: true, timeout: 20_000 });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
