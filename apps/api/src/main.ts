import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { createLogger } from './common/logger';
import { PgBossJobQueue } from './common/jobs';
import { createObjectStore } from './common/object-store';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const prisma = new PrismaClient();
  const jobs = PgBossJobQueue.create(config.DATABASE_URL, logger);
  await jobs.boss.start();
  const { app } = createApp({ config, logger, prisma, jobs, objectStore: createObjectStore(config) });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV, devAuth: config.DEV_AUTH_ENABLED }, 'api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void Promise.allSettled([jobs.boss.stop({ graceful: true }), prisma.$disconnect()]).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
