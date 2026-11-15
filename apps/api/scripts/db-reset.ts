import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { seed } from './seed-dev';

/** Drops and rebuilds the local database from migrations, then seeds it. Local databases only. */
async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production' || !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error('db:reset only runs against a local database');
  }
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), stdio: 'inherit', env: process.env });
  await seed(prisma, (line) => process.stdout.write(`${line}\n`));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
