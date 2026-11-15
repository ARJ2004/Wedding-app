// Defaults for e2e runs against the self-hosted Postgres (CI sets the same values).
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://mehfil:mehfil@localhost:5432/mehfil_test';
process.env.JWT_HOST_SECRET ??= 'test-only-host-secret-0123456789abcdef0123';
process.env.JWT_GUEST_SECRET ??= 'test-only-guest-secret-0123456789abcdef012';
process.env.DEV_AUTH_ENABLED ??= 'true';
process.env.OBJECT_STORE ??= 'fake';
process.env.MESSAGING_PROVIDER ??= 'log';
process.env.OPENAPI_DOCS ??= 'true';
process.env.LOG_LEVEL ??= 'silent';
process.env.RATE_LIMIT_PER_MINUTE ??= '100000';
process.env.AUTH_RATE_LIMIT_PER_MINUTE ??= '100000';
