import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AppConfig } from './config/env';
import type { JobQueue } from './common/jobs';
import type { ObjectStore } from './common/object-store';

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
}
