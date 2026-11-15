import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config/env';
import { housekeepingJobs } from './common/housekeeping';
import { PgBossJobQueue, type JobDefinition } from './common/jobs';
import { createLogger } from './common/logger';

/** Every job the worker runs. Modules add their `jobs()` here as they land. */
export function allJobs(prisma: PrismaClient): JobDefinition[] {
  return [...housekeepingJobs(prisma)];
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const prisma = new PrismaClient();
  const queue = PgBossJobQueue.create(config.DATABASE_URL, logger);
  await queue.boss.start();
  const jobs = allJobs(prisma);
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
