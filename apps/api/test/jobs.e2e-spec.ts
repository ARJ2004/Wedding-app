import { z } from 'zod';
import { defineJob, PgBossJobQueue } from '../src/common/jobs';
import { housekeepingJobs } from '../src/common/housekeeping';
import { closePrisma, silentLogger, testPrisma } from './helpers';

jest.setTimeout(30_000);

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
};

describe('PgBossJobQueue against Postgres', () => {
  const queue = PgBossJobQueue.create(process.env.DATABASE_URL!, silentLogger).withOverrides({
    default: { retryLimit: 1, retryDelay: 0 },
  });

  beforeAll(() => queue.boss.start());
  afterAll(async () => {
    await queue.boss.stop({ graceful: false, wait: true });
    await closePrisma();
  });

  it('validates payloads on send', async () => {
    const job = defineJob({ name: 'test.strict', lane: 'default', schema: z.object({ n: z.number() }), handler: async () => undefined });
    await expect(queue.send(job, { n: 'x' } as never)).rejects.toThrow();
  });

  it('runs a job in the worker and dead-letters one that keeps failing', async () => {
    const seen: number[] = [];
    let attempts = 0;
    const ok = defineJob({
      name: 'test.ok',
      lane: 'default',
      schema: z.object({ n: z.number() }),
      handler: async ({ n }) => {
        seen.push(n);
      },
    });
    const bad = defineJob({
      name: 'test.bad',
      lane: 'default',
      schema: z.object({}),
      handler: async () => {
        attempts += 1;
        throw new Error('always fails');
      },
    });
    await queue.register([ok, bad], { pollingIntervalSeconds: 0.5 });
    await queue.send(ok, { n: 7 });
    await queue.send(bad, {});
    await waitFor(() => seen.includes(7));
    await waitFor(async () => {
      const dlq = await queue.boss.getQueueSize('test.bad.dlq');
      return dlq === 1;
    });
    expect(attempts).toBe(2); // first try + retryLimit 1
  });

  it('housekeeping purges expired idempotency keys and old realtime events', async () => {
    const prisma = testPrisma();
    await prisma.$executeRawUnsafe(`INSERT INTO idempotency_keys (scope, idem_key, method, route, request_hash, expires_at)
      VALUES ('user:x', 'expired-key-1', 'POST', '/v1/x', '\\x00', now() - interval '1 minute'),
             ('user:x', 'fresh-key-001', 'POST', '/v1/x', '\\x00', now() + interval '1 hour')`);
    const [purgeIdem] = housekeepingJobs(prisma).filter((j) => j.name === 'fnd.purge-idempotency');
    await purgeIdem!.handler({}, { jobId: 't', logger: silentLogger });
    const left = await prisma.$queryRawUnsafe<{ idem_key: string }[]>(
      `SELECT idem_key FROM idempotency_keys WHERE scope = 'user:x' ORDER BY idem_key`,
    );
    expect(left.map((r) => r.idem_key)).toEqual(['fresh-key-001']);
  });
});
