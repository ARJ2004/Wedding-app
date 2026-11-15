import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config/env';
import { createLogger } from '../src/common/logger';
import { checkCatalogue, createWhatsAppProvider, TemplateService } from '../src/modules/messaging';

/**
 * Templates as code (MSG-02).
 *   pnpm msg:templates check    validate the catalogue (CI)
 *   pnpm msg:templates sync     write the catalogue to the DB (the worker also does this on start)
 *   pnpm msg:templates push     submit draft variants to the provider (needs WhatsApp credentials)
 *   pnpm msg:templates status   pull approval status from the provider now
 */
async function main(cmd: string) {
  const problems = checkCatalogue();
  if (problems.length) throw new Error(`Template catalogue problems:\n- ${problems.join('\n- ')}`);
  if (cmd === 'check') return 'catalogue OK';
  const config = loadConfig();
  const prisma = new PrismaClient();
  try {
    const svc = new TemplateService(prisma, createWhatsAppProvider(config, prisma), createLogger(config.LOG_LEVEL));
    if (cmd === 'sync') return JSON.stringify(await svc.syncCatalogue());
    if (cmd === 'push') {
      await svc.syncCatalogue();
      return `submitted ${await svc.push()} variant(s)`;
    }
    if (cmd === 'status') return JSON.stringify(await svc.pullStatus());
    throw new Error('usage: msg:templates check|sync|push|status');
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv[2] ?? 'check')
  .then((out) => process.stdout.write(`${out}\n`))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
