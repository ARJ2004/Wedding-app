import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { InlineJobQueue } from '../src/common/jobs';
import { FakeObjectStore } from '../src/common/object-store';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';

/** Writes the OpenAPI spec for packages/api-client without touching a database. */
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused',
  JWT_HOST_SECRET: 'x'.repeat(32),
  JWT_GUEST_SECRET: 'y'.repeat(32),
});
const { openApiDocument } = createApp({
  config,
  logger: pino({ level: 'silent' }),
  prisma: {} as PrismaClient,
  objectStore: new FakeObjectStore(),
  jobs: new InlineJobQueue(),
});
const out = join(__dirname, '../../../packages/api-client/openapi.json');
writeFileSync(out, `${JSON.stringify(openApiDocument, null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
