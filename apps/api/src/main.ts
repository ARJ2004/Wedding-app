import { Pool } from 'pg';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { createLogger } from './common/logger';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const { app } = createApp({ config, logger, db: pool });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV, devAuth: config.DEV_AUTH_ENABLED }, 'api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
