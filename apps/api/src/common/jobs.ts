import PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import type { z } from 'zod';

/**
 * Lanes group job types by how they must be run (01-fnd §5). Each job type is its own pg-boss
 * queue with a dead-letter queue `<name>.dlq`; the lane decides concurrency and retry policy.
 *   messaging-priority  OTPs and other sends that must never wait behind a broadcast
 *   messaging           announcement fan-out, reminders
 *   media               photo processing, zips
 *   default             housekeeping and everything else
 */
export type Lane = 'messaging-priority' | 'messaging' | 'media' | 'default';

const LANES: Record<Lane, { batchSize: number; retryLimit: number; retryDelay: number }> = {
  'messaging-priority': { batchSize: 10, retryLimit: 5, retryDelay: 2 },
  messaging: { batchSize: 20, retryLimit: 5, retryDelay: 5 },
  media: { batchSize: 4, retryLimit: 3, retryDelay: 10 },
  default: { batchSize: 5, retryLimit: 3, retryDelay: 30 },
};

export interface JobDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Queue name: `<module>.<action>`, e.g. `media.process`. */
  name: string;
  lane: Lane;
  schema: S;
  handler: (payload: z.infer<S>, ctx: { jobId: string; logger: Logger }) => Promise<void>;
  /** Cron (UTC unless tz given) for scheduled jobs; payload must then be `{}`-compatible. */
  cron?: { expression: string; tz?: string };
}

export function defineJob<S extends z.ZodTypeAny>(def: JobDefinition<S>): JobDefinition<S> {
  return def;
}

export interface SendOptions {
  /** Same key within the singleton window → one job (pg-boss singletonKey). */
  singletonKey?: string;
  startAfter?: Date | number;
  priority?: number;
}

/** What API modules see: enqueue only. Handlers run in the worker process. */
export interface JobQueue {
  send<S extends z.ZodTypeAny>(job: JobDefinition<S>, payload: z.infer<S>, opts?: SendOptions): Promise<string | null>;
}

export const DLQ_SUFFIX = '.dlq';

/** pg-boss backed queue, shared by the API (send) and the worker (register + work). */
export class PgBossJobQueue implements JobQueue {
  private readonly created = new Set<string>();

  constructor(
    readonly boss: PgBoss,
    private readonly logger: Logger,
    private readonly overrides: Partial<Record<Lane, Partial<(typeof LANES)[Lane]>>> = {},
  ) {}

  static create(connectionString: string, logger: Logger, opts: { schema?: string } = {}) {
    const boss = new PgBoss({ connectionString, schema: opts.schema ?? 'pgboss', max: 4 });
    boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
    return new PgBossJobQueue(boss, logger);
  }

  withOverrides(overrides: Partial<Record<Lane, Partial<(typeof LANES)[Lane]>>>) {
    return new PgBossJobQueue(this.boss, this.logger, overrides);
  }

  private lane(lane: Lane) {
    return { ...LANES[lane], ...this.overrides[lane] };
  }

  async ensureQueue(job: Pick<JobDefinition, 'name' | 'lane'>) {
    if (this.created.has(job.name)) return;
    const lane = this.lane(job.lane);
    await this.boss.createQueue(job.name + DLQ_SUFFIX, { name: job.name + DLQ_SUFFIX, retryLimit: 0 });
    await this.boss.createQueue(job.name, {
      name: job.name,
      retryLimit: lane.retryLimit,
      retryDelay: lane.retryDelay,
      retryBackoff: lane.retryDelay > 0,
      deadLetter: job.name + DLQ_SUFFIX,
    });
    this.created.add(job.name);
  }

  async send<S extends z.ZodTypeAny>(job: JobDefinition<S>, payload: z.infer<S>, opts: SendOptions = {}) {
    const data = job.schema.parse(payload) as object;
    await this.ensureQueue(job);
    const options: PgBoss.SendOptions = {};
    if (opts.singletonKey !== undefined) options.singletonKey = opts.singletonKey;
    if (opts.startAfter !== undefined) options.startAfter = opts.startAfter;
    if (opts.priority !== undefined) options.priority = opts.priority;
    return this.boss.send(job.name, data, options);
  }

  /** Worker only: registers handlers (and cron schedules) for every job definition. */
  async register(jobs: JobDefinition[], opts: { pollingIntervalSeconds?: number } = {}) {
    for (const job of jobs) {
      await this.ensureQueue(job);
      const lane = this.lane(job.lane);
      await this.boss.work<object>(
        job.name,
        { batchSize: lane.batchSize, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
        async (batch) => {
          for (const j of batch) {
            const parsed = job.schema.safeParse(j.data);
            if (!parsed.success) {
              // A malformed payload will never succeed: fail it straight to the DLQ path.
              throw new Error(`invalid payload for ${job.name}: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
            }
            await job.handler(parsed.data, { jobId: j.id, logger: this.logger.child({ job: job.name, jobId: j.id }) });
          }
        },
      );
      if (job.cron) {
        await this.boss.schedule(job.name, job.cron.expression, {}, { tz: job.cron.tz ?? 'UTC' });
      }
    }
  }
}

/**
 * Test double: records sends; `drain()` runs the handlers inline so e2e tests can assert
 * side effects without a worker process.
 */
export class InlineJobQueue implements JobQueue {
  readonly sent: { name: string; payload: unknown; opts?: SendOptions }[] = [];
  private readonly defs = new Map<string, JobDefinition>();

  async send<S extends z.ZodTypeAny>(job: JobDefinition<S>, payload: z.infer<S>, opts?: SendOptions) {
    const data = job.schema.parse(payload);
    this.defs.set(job.name, job as unknown as JobDefinition);
    this.sent.push({ name: job.name, payload: data, opts });
    return `inline-${this.sent.length}`;
  }

  async drain(logger: Logger) {
    while (this.sent.length > 0) {
      const next = this.sent.shift()!;
      await this.defs.get(next.name)!.handler(next.payload, { jobId: 'inline', logger });
    }
  }
}
