import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config/env';
import { InlineJobQueue } from '../src/common/jobs';
import { FakeObjectStore } from '../src/common/object-store';
import type { Deps } from '../src/deps';

let prisma: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  prisma ??= new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  return prisma;
}

export async function closePrisma(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}

export const silentLogger = pino({ level: 'silent' });

export function testDeps(overrides: Partial<Omit<Deps, 'config'>> & { config?: Partial<AppConfig> } = {}): Deps {
  return {
    config: { ...loadConfig(), ...overrides.config },
    logger: silentLogger,
    prisma: overrides.prisma ?? testPrisma(),
    objectStore: overrides.objectStore ?? new FakeObjectStore(),
    jobs: overrides.jobs ?? new InlineJobQueue(),
  };
}

/** Boots the real app against mehfil_test; override any dependency or config value per test. */
export function boot(overrides: Parameters<typeof testDeps>[0] = {}) {
  return createApp(testDeps(overrides)).app;
}

/** Empties the given tables between test files (CASCADE follows FKs). */
export async function truncate(...tables: string[]) {
  if (tables.length === 0) return;
  await testPrisma().$executeRawUnsafe(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}
