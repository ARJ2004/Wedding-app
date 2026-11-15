import { ConfigError, loadConfig } from './env';

const base = {
  DATABASE_URL: 'postgresql://x@localhost/db',
  JWT_HOST_SECRET: 'h'.repeat(32),
  JWT_GUEST_SECRET: 'g'.repeat(32),
};

const prod = {
  ...base,
  NODE_ENV: 'production',
  GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
  SENTRY_DSN: 'https://key@sentry.example/1',
  S3_BUCKET: 'mehfil-prod',
  S3_REGION: 'ap-south-1',
  LINK_TOKEN_KEY: 'l'.repeat(40),
  OTP_PEPPER: 'o'.repeat(40),
  PII_HASH_KEY: 'p'.repeat(40),
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_WABA_ID: '9876543210',
  WHATSAPP_ACCESS_TOKEN: 'EAAG-token',
  WHATSAPP_APP_SECRET: 'a'.repeat(32),
  WHATSAPP_VERIFY_TOKEN: 'v'.repeat(16),
};

function problemsFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('loadConfig', () => {
  it('applies safe defaults in development', () => {
    const c = loadConfig(base);
    expect(c.NODE_ENV).toBe('development');
    expect(c.PORT).toBe(4000);
    expect(c.DEV_AUTH_ENABLED).toBe(false);
    expect(c.OPENAPI_DOCS).toBe(false);
  });

  it('parses boolean strings', () => {
    const c = loadConfig({ ...base, DEV_AUTH_ENABLED: 'true', OPENAPI_DOCS: '1' });
    expect(c.DEV_AUTH_ENABLED).toBe(true);
    expect(c.OPENAPI_DOCS).toBe(true);
  });

  it('rejects short JWT secrets and a missing DATABASE_URL together', () => {
    const problems = problemsFor({ JWT_HOST_SECRET: 'short', JWT_GUEST_SECRET: 'g'.repeat(32) });
    expect(problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
    expect(problems.some((p) => p.startsWith('JWT_HOST_SECRET'))).toBe(true);
  });

  it('accepts a complete production config', () => {
    expect(problemsFor(prod)).toEqual([]);
  });

  it.each([
    ['DEV_AUTH_ENABLED', 'true', 'DEV_AUTH_ENABLED must be false in production'],
    ['OBJECT_STORE', 'fake', 'OBJECT_STORE=fake is not allowed in production'],
    ['OBJECT_STORE', 'local', 'OBJECT_STORE=local is not allowed in production'],
    ['MESSAGING_PROVIDER', 'log', 'MESSAGING_PROVIDER=log is not allowed in production'],
    ['OPENAPI_DOCS', 'true', 'OPENAPI_DOCS must be false in production'],
    ['GOOGLE_WEB_CLIENT_ID', '', 'GOOGLE_WEB_CLIENT_ID is required in production'],
    ['SENTRY_DSN', '', 'SENTRY_DSN is required in production'],
    ['S3_BUCKET', '', 'S3_BUCKET is required in production'],
    ['S3_REGION', '', 'S3_REGION is required in production'],
    ['LINK_TOKEN_KEY', 'dev-only-link-token-key-change-me-0123456789', 'LINK_TOKEN_KEY must be set to a real secret in production'],
  ])('refuses to boot in production when %s=%s', (key, value, message) => {
    expect(problemsFor({ ...prod, [key]: value })).toEqual([message]);
  });

  it('needs WhatsApp credentials in production', () => {
    const rest: Record<string, string> = { ...prod };
    delete rest.WHATSAPP_ACCESS_TOKEN;
    delete rest.WHATSAPP_APP_SECRET;
    expect(problemsFor(rest)).toEqual([
      'WHATSAPP_ACCESS_TOKEN is required in production',
      'WHATSAPP_APP_SECRET must be set to a real secret in production',
    ]);
  });

  it('allows the dev bypass outside production', () => {
    expect(problemsFor({ ...base, NODE_ENV: 'test', DEV_AUTH_ENABLED: 'true', OBJECT_STORE: 'fake' })).toEqual([]);
  });
});
