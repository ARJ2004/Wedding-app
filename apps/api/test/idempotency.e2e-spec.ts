import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/common/errors';
import { idempotent } from '../src/common/idempotency';
import { closePrisma, silentLogger, testPrisma, truncate } from './helpers';

/** A tiny app with one idempotent route; the counter proves the handler ran once. */
function appWithCounter() {
  let runs = 0;
  const app = express();
  app.use(express.json());
  app.post(
    '/v1/things',
    idempotent(testPrisma(), { scope: (req) => `user:${req.header('x-user') ?? 'u1'}`, route: '/v1/things' }),
    async (req, res) => {
      runs += 1;
      if (req.body.fail) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'boom' } });
        return;
      }
      if (req.body.slow) await new Promise((r) => setTimeout(r, 300));
      res.status(201).json({ id: `thing-${runs}`, name: req.body.name });
    },
  );
  app.use(errorHandler(silentLogger));
  return { app, runs: () => runs };
}

beforeEach(() => truncate('idempotency_keys'));
afterAll(closePrisma);

describe('Idempotency-Key', () => {
  it('runs once and replays the stored response for the same key and body', async () => {
    const { app, runs } = appWithCounter();
    const first = await request(app).post('/v1/things').set('Idempotency-Key', 'key-0001').send({ name: 'a', n: 1 }).expect(201);
    const again = await request(app).post('/v1/things').set('Idempotency-Key', 'key-0001').send({ n: 1, name: 'a' }).expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(runs()).toBe(1);
  });

  it('rejects the same key with a different body (422)', async () => {
    const { app } = appWithCounter();
    await request(app).post('/v1/things').set('Idempotency-Key', 'key-0002').send({ name: 'a' }).expect(201);
    const res = await request(app).post('/v1/things').set('Idempotency-Key', 'key-0002').send({ name: 'b' }).expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('returns 409 to a concurrent duplicate', async () => {
    const { app } = appWithCounter();
    const [a, b] = await Promise.all([
      request(app).post('/v1/things').set('Idempotency-Key', 'key-0003').send({ name: 'a', slow: true }),
      new Promise((r) => setTimeout(r, 100)).then(() =>
        request(app).post('/v1/things').set('Idempotency-Key', 'key-0003').send({ name: 'a', slow: true }),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('keeps keys separate per caller scope', async () => {
    const { app, runs } = appWithCounter();
    await request(app).post('/v1/things').set('Idempotency-Key', 'key-0004').set('x-user', 'u1').send({ name: 'a' }).expect(201);
    await request(app).post('/v1/things').set('Idempotency-Key', 'key-0004').set('x-user', 'u2').send({ name: 'a' }).expect(201);
    expect(runs()).toBe(2);
  });

  it('lets the client retry after a 5xx', async () => {
    const { app, runs } = appWithCounter();
    await request(app).post('/v1/things').set('Idempotency-Key', 'key-0005').send({ fail: true }).expect(500);
    await new Promise((r) => setTimeout(r, 50));
    await request(app).post('/v1/things').set('Idempotency-Key', 'key-0005').send({ fail: true }).expect(500);
    expect(runs()).toBe(2);
  });

  it('rejects malformed keys and passes through without a key', async () => {
    const { app, runs } = appWithCounter();
    const bad = await request(app).post('/v1/things').set('Idempotency-Key', 'no').send({}).expect(400);
    expect(bad.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    await request(app).post('/v1/things').send({ name: 'x' }).expect(201);
    await request(app).post('/v1/things').send({ name: 'x' }).expect(201);
    expect(runs()).toBe(2);
  });
});
