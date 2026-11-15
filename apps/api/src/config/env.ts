import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
  .transform((v) => v === true || v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

/** Environment the API and worker need; parsed once at boot so a bad deploy fails fast. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  JWT_HOST_SECRET: z.string().min(32),
  JWT_GUEST_SECRET: z.string().min(32),
  DEV_AUTH_ENABLED: bool.default(false),
  OBJECT_STORE: z.enum(['s3', 'minio', 'fake', 'local']).default('s3'),
  /** OBJECT_STORE=local (dev without Docker): objects as files, shared by API and worker. */
  LOCAL_STORE_DIR: z.string().default('.data/objects'),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  /** Dev only, OBJECT_STORE=fake: base URL clients use for the fake upload sink ('' = same origin). */
  FAKE_S3_PUBLIC_BASE: z.string().optional(),
  MESSAGING_PROVIDER: z.enum(['meta', 'log']).default('meta'),
  OPENAPI_DOCS: bool.default(false),
  GOOGLE_WEB_CLIENT_ID: optionalString,
  SENTRY_DSN: optionalString,
  /** Prometheus metrics on 127.0.0.1 (scraped by the CloudWatch agent); 0 disables. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** Comma-separated emails allowed to use /v1/ops/* (failed jobs). Not a DB flag on purpose. */
  OPS_ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Production must never run with development shortcuts. Staging also runs with
 * NODE_ENV=production, so the dev bypass only ever works locally and in CI.
 */
function productionProblems(c: AppConfig): string[] {
  if (c.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (c.DEV_AUTH_ENABLED) problems.push('DEV_AUTH_ENABLED must be false in production');
  if (c.OBJECT_STORE === 'fake' || c.OBJECT_STORE === 'local') problems.push(`OBJECT_STORE=${c.OBJECT_STORE} is not allowed in production`);
  if (c.MESSAGING_PROVIDER === 'log') problems.push('MESSAGING_PROVIDER=log is not allowed in production');
  if (c.OPENAPI_DOCS) problems.push('OPENAPI_DOCS must be false in production');
  if (!c.GOOGLE_WEB_CLIENT_ID) problems.push('GOOGLE_WEB_CLIENT_ID is required in production');
  if (!c.SENTRY_DSN) problems.push('SENTRY_DSN is required in production');
  if (!c.S3_BUCKET) problems.push('S3_BUCKET is required in production');
  if (!c.S3_REGION) problems.push('S3_REGION is required in production');
  return problems;
}

/** Parses and checks the environment; throws ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const problems = productionProblems(parsed.data);
  if (problems.length > 0) throw new ConfigError(problems);
  return parsed.data;
}
