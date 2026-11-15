import pino from 'pino';
import { RealtimeHub, TooManyStreams, type RtRow, type RtStore } from './hub';
import type { Notice, RealtimeListener } from './listener';

const W = '00000000-0000-4000-8000-000000000001';

class FakeListener implements RealtimeListener {
  notice?: (n: Notice) => void;
  reconnect?: () => void;
  starts = 0;
  async start(onNotice: (n: Notice) => void, onReconnect: () => void) {
    this.starts++;
    this.notice = onNotice;
    this.reconnect = onReconnect;
  }
  async stop() {}
}

function memoryStore(rows: RtRow[]): RtStore {
  return {
    latestId: async (w) => rows.filter((r) => r.wedding_id === w).reduce((m, r) => (r.id > m ? r.id : m), 0n),
    after: async (w, ch, after, limit) => rows.filter((r) => r.wedding_id === w && ch.includes(r.channel) && r.id > after).slice(0, limit),
    byId: async (id) => rows.find((r) => r.id === id) ?? null,
  };
}

const sink = () => {
  const out: string[] = [];
  return { out, sink: { write: (c: string) => out.push(c), end: () => out.push('<end>') }, ids: () => out.flatMap((c) => /^id: (\d+)\nevent: (?!reset)/.exec(c)?.[1] ?? []) };
};
const row = (id: number, channel = 'headcount', w = W): RtRow => ({ id: BigInt(id), wedding_id: w, channel, kind: 'rsvp.changed', payload: { n: id } });

describe('RealtimeHub', () => {
  it('replays from Last-Event-ID, then fans live notices out once, in order, to matching streams only', async () => {
    const rows = [row(1), row(2), row(3, 'debug.ping')];
    const listener = new FakeListener();
    const hub = new RealtimeHub(memoryStore(rows), listener, pino({ level: 'silent' }));
    const a = sink();
    const b = sink();
    await hub.open({ weddingId: W, channels: ['headcount'], principal: 'u:1', lastEventId: 0n, sink: a.sink });
    await hub.open({ weddingId: W, channels: ['debug.ping'], principal: 'u:2', sink: b.sink });
    await hub.flush();
    expect(a.ids()).toEqual(['1', '2']);
    expect(b.ids()).toEqual([]); // no Last-Event-ID → starts at the latest id

    rows.push(row(4), row(5, 'headcount', '00000000-0000-4000-8000-000000000002'));
    listener.notice!({ id: '4', w: W, c: 'headcount' });
    listener.notice!({ id: '4', w: W, c: 'headcount' }); // duplicate NOTIFY
    listener.notice!({ id: '5', w: '00000000-0000-4000-8000-000000000002', c: 'headcount' });
    listener.reconnect!(); // reconnect replay must not duplicate either
    await hub.flush();
    expect(a.ids()).toEqual(['1', '2', '4']);
    expect(a.out.find((c) => c.startsWith('id: 4'))).toContain('"payload":{"n":4}');
    expect(listener.starts).toBe(1);
    await hub.stop();
  });

  it('sends reset when the gap is too large and limits streams per principal', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
    const hub = new RealtimeHub(memoryStore(rows), new FakeListener(), pino({ level: 'silent' }), { maxReplay: 3, perPrincipal: 2 });
    const a = sink();
    await hub.open({ weddingId: W, channels: ['headcount'], principal: 'u:1', lastEventId: 1n, sink: a.sink });
    await hub.flush();
    expect(a.out.join('')).toContain('id: 6\nevent: reset');
    expect(a.ids()).toEqual([]);
    const close = await hub.open({ weddingId: W, channels: ['headcount'], principal: 'u:1', sink: sink().sink });
    await expect(hub.open({ weddingId: W, channels: ['headcount'], principal: 'u:1', sink: sink().sink })).rejects.toBeInstanceOf(TooManyStreams);
    close();
    expect(hub.size).toBe(1);
    await hub.open({ weddingId: W, channels: ['headcount'], principal: 'u:1', sink: sink().sink });
    await hub.stop();
    expect(hub.size).toBe(0);
  });
});
