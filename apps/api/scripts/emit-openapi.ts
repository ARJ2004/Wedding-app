import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
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
  db: { query: async () => undefined },
});
const out = join(__dirname, '../../../packages/api-client/openapi.json');
writeFileSync(out, `${JSON.stringify(openApiDocument, null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
