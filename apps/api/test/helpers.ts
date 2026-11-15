import { Pool } from 'pg';
import pino from 'pino';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config/env';
import type { Db, Deps } from '../src/deps';

let pool: Pool | undefined;

export function testPool(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Boots the real app against mehfil_test; override any dependency or config value per test. */
export function boot(overrides: { config?: Partial<AppConfig>; db?: Db } = {}) {
  const config = { ...loadConfig(), ...overrides.config };
  const deps: Deps = { config, logger: pino({ level: 'silent' }), db: overrides.db ?? testPool() };
  return createApp(deps).app;
}
