import { Client } from 'pg';
import type { Logger } from 'pino';

export interface Notice {
  id: string;
  w: string;
  c: string;
}

/** The LISTEN side of the hub, behind a port so unit tests can drive it by hand. */
export interface RealtimeListener {
  start(onNotice: (n: Notice) => void, onReconnect: () => void): Promise<void>;
  stop(): Promise<void>;
}

export const RT_CHANNEL = 'mehfil_rt';

/**
 * One dedicated pg client per API process running LISTEN mehfil_rt (01-fnd §5).
 * Keep-alive every 30 s; on error it reconnects with backoff and tells the hub to replay,
 * because NOTIFYs sent while disconnected are lost (the rows are not).
 */
export class PgListener implements RealtimeListener {
  private client?: Client;
  private keepAlive?: NodeJS.Timeout;
  private stopped = false;
  private attempt = 0;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly onReconnectMetric: () => void = () => undefined,
  ) {}

  async start(onNotice: (n: Notice) => void, onReconnect: () => void): Promise<void> {
    this.stopped = false;
    await this.connect(onNotice, onReconnect, false);
  }

  private async connect(onNotice: (n: Notice) => void, onReconnect: () => void, isRetry: boolean): Promise<void> {
    const client = new Client({ connectionString: this.url });
    client.on('notification', (msg) => {
      if (msg.channel !== RT_CHANNEL || !msg.payload) return;
      try {
        const n = JSON.parse(msg.payload) as { id: number | string; w: string; c: string };
        onNotice({ id: String(n.id), w: n.w, c: n.c });
      } catch (err) {
        this.logger.warn({ err }, 'bad realtime notice');
      }
    });
    const retry = (err: unknown) => {
      if (this.stopped || this.client !== client) return;
      this.logger.warn({ err }, 'realtime listener lost; reconnecting');
      this.teardown();
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
      setTimeout(() => {
        if (!this.stopped) void this.connect(onNotice, onReconnect, true).catch(retry);
      }, delay).unref();
    };
    client.on('error', retry);
    client.on('end', () => retry(new Error('connection ended')));
    this.client = client;
    await client.connect();
    await client.query(`LISTEN ${RT_CHANNEL}`);
    this.attempt = 0;
    this.keepAlive = setInterval(() => {
      client.query('SELECT 1').catch(retry);
    }, 30_000).unref();
    if (isRetry) {
      this.onReconnectMetric();
      onReconnect();
    }
  }

  private teardown() {
    clearInterval(this.keepAlive);
    const c = this.client;
    this.client = undefined;
    c?.removeAllListeners('end');
    void c?.end().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.keepAlive);
    const c = this.client;
    this.client = undefined;
    c?.removeAllListeners();
    c?.on('error', () => undefined);
    await c?.end().catch(() => undefined);
  }
}
