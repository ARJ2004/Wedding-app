import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { RealtimeListener, Notice } from './listener';

export interface RtRow {
  id: bigint;
  wedding_id: string;
  channel: string;
  kind: string;
  payload: unknown;
}

/** Reads behind a port so the hub's fan-out can be unit-tested without Postgres. */
export interface RtStore {
  latestId(weddingId: string): Promise<bigint>;
  after(weddingId: string, channels: string[], afterId: bigint, limit: number): Promise<RtRow[]>;
  byId(id: bigint): Promise<RtRow | null>;
}

export function prismaRtStore(prisma: PrismaClient): RtStore {
  return {
    async latestId(weddingId) {
      const r = await prisma.realtime_events.aggregate({ where: { wedding_id: weddingId }, _max: { id: true } });
      return r._max.id ?? 0n;
    },
    after: (weddingId, channels, afterId, limit) =>
      prisma.realtime_events.findMany({
        where: { wedding_id: weddingId, channel: { in: channels }, id: { gt: afterId } },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    byId: (id) => prisma.realtime_events.findUnique({ where: { id } }),
  };
}

/** What a stream writes to; the route adapts an Express response to it. */
export interface StreamSink {
  write(chunk: string): void;
  end(): void;
}

interface Stream {
  weddingId: string;
  channels: Set<string>;
  principal: string;
  sink: StreamSink;
  lastId: bigint;
  /** Serialises replay and live writes so a stream never sees an event twice or out of order. */
  chain: Promise<void>;
  timers: NodeJS.Timeout[];
  closed: boolean;
}

export interface HubOptions {
  maxReplay?: number;
  perPrincipal?: number;
  perProcess?: number;
  heartbeatMs?: number;
  maxAgeMs?: number;
  onCount?: (open: number) => void;
}

export class TooManyStreams extends Error {}

export const formatEvent = (row: RtRow) =>
  `id: ${row.id}\nevent: ${row.kind}\ndata: ${JSON.stringify({ id: String(row.id), channel: row.channel, kind: row.kind, payload: row.payload })}\n\n`;

/**
 * SSE fan-out (FND-14, 01-fnd §5). One LISTEN connection per process; on a notice the row is
 * read once by id and written to every local stream subscribed to (wedding, channel).
 * Streams resume from Last-Event-ID; gaps over `maxReplay` get `event: reset` (client refetches).
 */
export class RealtimeHub {
  private readonly streams = new Set<Stream>();
  private started?: Promise<void>;
  private readonly opts: Required<Omit<HubOptions, 'onCount'>> & Pick<HubOptions, 'onCount'>;

  constructor(
    private readonly store: RtStore,
    private readonly listener: RealtimeListener,
    private readonly logger: Logger,
    opts: HubOptions = {},
  ) {
    this.opts = {
      maxReplay: 500,
      perPrincipal: 3,
      perProcess: 5_000,
      heartbeatMs: 20_000,
      maxAgeMs: 60 * 60_000,
      ...opts,
    };
  }

  get size() {
    return this.streams.size;
  }

  /** Starts LISTEN lazily, so processes and tests that never stream never hold a connection. */
  private ensureStarted() {
    this.started ??= this.listener
      .start(
        (n) => this.onNotice(n),
        () => this.replayAll(),
      )
      .catch((err: unknown) => {
        this.started = undefined;
        throw err;
      });
    return this.started;
  }

  /** Throws TooManyStreams when a limit is hit (the route maps it to 429). */
  async open(input: { weddingId: string; channels: string[]; principal: string; lastEventId?: bigint; sink: StreamSink }): Promise<() => void> {
    const mine = [...this.streams].filter((s) => s.principal === input.principal).length;
    if (mine >= this.opts.perPrincipal || this.streams.size >= this.opts.perProcess) throw new TooManyStreams();
    await this.ensureStarted();
    const from = input.lastEventId ?? (await this.store.latestId(input.weddingId));
    const stream: Stream = {
      weddingId: input.weddingId,
      channels: new Set(input.channels),
      principal: input.principal,
      sink: input.sink,
      lastId: from,
      chain: Promise.resolve(),
      timers: [],
      closed: false,
    };
    this.streams.add(stream);
    this.opts.onCount?.(this.streams.size);
    input.sink.write('retry: 3000\n: connected\n\n');
    // Replays anything committed after `from` (also covers the gap between latestId and add()).
    this.enqueue(stream, () => this.replay(stream));
    stream.timers.push(setInterval(() => this.safeWrite(stream, ': hb\n\n'), this.opts.heartbeatMs));
    stream.timers.push(setTimeout(() => close(), this.opts.maxAgeMs));
    for (const t of stream.timers) t.unref?.();
    const close = () => {
      if (stream.closed) return;
      stream.closed = true;
      for (const t of stream.timers) clearTimeout(t);
      this.streams.delete(stream);
      this.opts.onCount?.(this.streams.size);
      try {
        stream.sink.end();
      } catch {
        /* already gone */
      }
    };
    return close;
  }

  private enqueue(stream: Stream, task: () => Promise<void>) {
    stream.chain = stream.chain.then(task).catch((err: unknown) => {
      this.logger.warn({ err }, 'realtime stream write failed');
    });
  }

  private safeWrite(stream: Stream, chunk: string) {
    if (stream.closed) return;
    try {
      stream.sink.write(chunk);
    } catch {
      /* the close handler cleans up */
    }
  }

  private deliver(stream: Stream, row: RtRow) {
    if (row.id <= stream.lastId) return;
    stream.lastId = row.id;
    this.safeWrite(stream, formatEvent(row));
  }

  private async replay(stream: Stream) {
    const rows = await this.store.after(stream.weddingId, [...stream.channels], stream.lastId, this.opts.maxReplay + 1);
    if (rows.length > this.opts.maxReplay) {
      stream.lastId = await this.store.latestId(stream.weddingId);
      this.safeWrite(stream, `id: ${stream.lastId}\nevent: reset\ndata: {}\n\n`);
      return;
    }
    for (const row of rows) this.deliver(stream, row);
  }

  private onNotice(n: Notice) {
    const targets = [...this.streams].filter((s) => s.weddingId === n.w && s.channels.has(n.c));
    if (targets.length === 0) return;
    const row = this.store.byId(BigInt(n.id));
    for (const s of targets) {
      this.enqueue(s, async () => {
        const r = await row;
        if (r) this.deliver(s, r);
      });
    }
  }

  private replayAll() {
    for (const s of this.streams) this.enqueue(s, () => this.replay(s));
  }

  /** Waits for queued writes (tests). */
  async flush() {
    await Promise.all([...this.streams].map((s) => s.chain));
  }

  async stop() {
    for (const s of [...this.streams]) {
      s.closed = true;
      for (const t of s.timers) clearTimeout(t);
      try {
        s.sink.end();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
    this.started = undefined;
    await this.listener.stop();
  }
}
