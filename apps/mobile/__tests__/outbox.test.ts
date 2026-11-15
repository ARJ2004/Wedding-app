import { initKv } from '../src/lib/kv';
import { useOutbox, startOutbox } from '../src/lib/outbox';

const ok = (status: number) => Promise.resolve({ status } as Response);

describe('offline outbox (APP-04)', () => {
  let stop: () => void;
  beforeAll(() => initKv());
  beforeEach(() => {
    useOutbox.setState({ items: [], flushing: false });
    stop = startOutbox();
  });
  afterEach(() => stop());

  const add = (label: string) => useOutbox.getState().enqueue({ identity: 'guest', method: 'PUT', path: '/v1/guest/rsvp', body: { label }, label });

  it('keeps items while offline and replays them in order with an Idempotency-Key', async () => {
    add('first');
    add('second');
    globalThis.fetch = jest.fn(() => Promise.reject(new TypeError('Network request failed'))) as never;
    await useOutbox.getState().flush();
    expect(useOutbox.getState().items).toHaveLength(2);

    const sent: string[] = [];
    globalThis.fetch = jest.fn((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).label);
      expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^outbox-/);
      return ok(200);
    }) as never;
    await useOutbox.getState().flush();
    expect(sent).toEqual(['first', 'second']);
    expect(useOutbox.getState().items).toHaveLength(0);
  });

  it('drops items the server will never accept (4xx) and keeps them on 5xx', async () => {
    add('closed');
    add('later');
    globalThis.fetch = jest.fn().mockImplementationOnce(() => ok(409)).mockImplementationOnce(() => ok(503)) as never;
    await useOutbox.getState().flush();
    expect(useOutbox.getState().items.map((i) => i.label)).toEqual(['later']);
    expect(useOutbox.getState().items[0]!.attempts).toBe(1);
  });
});
