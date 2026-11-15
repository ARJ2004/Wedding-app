import type { Logger } from 'pino';
import type { AppConfig } from './config/env';

/** Minimal database surface used before Prisma lands (FND-04). */
export interface Db {
  query(sql: string): Promise<unknown>;
}

/**
 * Everything a module needs, built once in main.ts / worker.ts / tests and passed down.
 * Later stories add prisma, objectStore, messaging, push, jobs, clock and verifiers.
 */
export interface Deps {
  config: AppConfig;
  logger: Logger;
  db: Db;
}
