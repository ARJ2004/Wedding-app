import { mapLimit, TokenBucket } from './token-bucket';

describe('TokenBucket (MSG-05)', () => {
  it('allows a burst of `rate`, then paces at rate per second', async () => {
    let now = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket(5, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    for (let i = 0; i < 5; i++) await bucket.take();
    expect(waits).toEqual([]);
    await bucket.take();
    await bucket.take();
    expect(waits).toEqual([200, 200]);
    expect(now).toBe(400);
  });

  it('mapLimit keeps at most `limit` calls in flight and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
