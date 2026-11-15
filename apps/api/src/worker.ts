import { loadConfig } from './config/env';
import { createLogger } from './common/logger';

/**
 * Background worker entry point. pg-boss queues (messaging, messaging-priority, media, default)
 * are registered here in FND-06; until then the process only validates config and idles.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  logger.info({ env: config.NODE_ENV }, 'worker started (no queues registered yet)');
  const keepAlive = setInterval(() => undefined, 60_000);
  const stop = () => {
    clearInterval(keepAlive);
    logger.info('worker stopped');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
