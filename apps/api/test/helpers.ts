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

/** Empties the given tables between test files (CASCADE follows FKs; the append-only audit trigger allows TRUNCATE). */
export async function truncate(...tables: string[]) {
  if (tables.length === 0) return;
  await testPrisma().$executeRawUnsafe(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

export const DEVICE = 'test-device-0123456789';

/** Signs a host in through the real endpoint with the dev bypass; returns tokens and user id. */
export async function signInHost(app: Parameters<typeof import('supertest')>[0], email: string) {
  const request = (await import('supertest')).default;
  const res = await request(app).post('/v1/auth/google').send({ idToken: `dev:${email}`, deviceId: DEVICE }).expect(200);
  return {
    userId: res.body.user.id as string,
    accessToken: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

/** Wipes everything the host-side tests create (keeps pg-boss's own schema). */
export async function resetData() {
  await truncate('audit_log', 'refresh_tokens', 'idempotency_keys', 'weddings', 'organizations', 'users');
}
