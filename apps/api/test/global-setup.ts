import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import './setup-env';

/** Rebuilds mehfil_test from the migrations once per e2e run (same engine as production). */
export default async function globalSetup() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;');
  await client.end();
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });
}
