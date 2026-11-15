import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app';
import { rtPublish } from '../src/common/sse';
import { closePrisma, resetData, signInHost, testDeps, testPrisma } from './helpers';

const { app, realtime } = createApp(testDeps());
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(resetData);
afterAll(async () => {
  await realtime.stop();
  await new Promise((r) => server.close(r));
  await closePrisma();
});

interface Sse {
  status: number;
  events: { id?: string; event?: string; data?: unknown }[];
  waitFor(n: number, ms?: number): Promise<void>;
  close(): void;
}

/** Minimal SSE client over node:http so the test reads the real wire format. */
function open(path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      const events: Sse['events'] = [];
      let buf = '';
      const waiters: (() => void)[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const e: Sse['events'][number] = {};
          for (const line of block.split('\n')) {
            const [k, ...v] = line.split(': ');
            const val = v.join(': ');
            if (k === 'id') e.id = val;
            if (k === 'event') e.event = val;
            if (k === 'data') e.data = JSON.parse(val);
          }
          if (e.event) events.push(e);
          for (const w of waiters.splice(0)) w();
        }
      });
      const sse: Sse = {
        status: res.statusCode ?? 0,
        events,
        waitFor: (n, ms = 3000) =>
          new Promise((ok, fail) => {
            const t = setTimeout(() => fail(new Error(`saw ${events.length} of ${n} events`)), ms);
            const check = () => (events.length >= n ? (clearTimeout(t), ok()) : waiters.push(check));
            check();
          }),
        close: () => req.destroy(),
      };
      resolve(sse);
    });
    req.on('error', (err) => (String(err).includes('socket hang up') ? undefined : reject(err)));
  });
}

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14', cities: ['Udaipur'] }).expect(201);
  return { owner, weddingId: w.body.id as string, W: `/v1/weddings/${w.body.id}` };
}

describe('realtime stream (FND-14)', () => {
  it('delivers committed events live and replays after Last-Event-ID', async () => {
    const { owner, weddingId, W } = await setup();
    const s = await open(`${W}/stream?channels=headcount,debug.ping`, owner.auth);
    expect(s.status).toBe(200);
    const prisma = testPrisma();
    await prisma.$transaction((tx) => rtPublish(tx, weddingId, 'debug.ping', 'debug.ping', { at: 'one' }));
    // Rolled back → never delivered.
    await prisma.$transaction(async (tx) => {
      await rtPublish(tx, weddingId, 'debug.ping', 'debug.ping', { at: 'rolled-back' });
      throw new Error('rollback');
    }).catch(() => undefined);
    await rtPublish(prisma, weddingId, 'debug.ping', 'debug.ping', { at: 'two' });
    await s.waitFor(2);
    expect(s.events.map((e) => (e.data as { payload: { at: string } }).payload.at)).toEqual(['one', 'two']);
    const firstId = s.events[0]!.id!;
    s.close();

    const again = await open(`${W}/stream?channels=debug.ping`, { ...owner.auth, 'Last-Event-ID': firstId });
    await again.waitFor(1);
    expect(again.events[0]).toMatchObject({ event: 'debug.ping', data: { channel: 'debug.ping', payload: { at: 'two' } } });
    again.close();
  });

  it('hides other weddings, checks channel permission and validates channels', async () => {
    const { W } = await setup();
    const stranger = await signInHost(app, 'stranger@example.com');
    const nf = await request(app).get(`${W}/stream?channels=headcount`).set(stranger.auth).expect(404);
    expect(nf.body.error.code).toBe('WEDDING_NOT_FOUND');
    await request(app).get(`${W}/stream?channels=headcount`).expect(401);
    const owner = await signInHost(app, 'owner@example.com');
    const bad = await request(app).get(`${W}/stream?channels=nope`).set(owner.auth).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('caps open streams per person', async () => {
    const { owner, W } = await setup();
    const open3 = await Promise.all([1, 2, 3].map(() => open(`${W}/stream?channels=debug.ping`, owner.auth)));
    const res = await request(app).get(`${W}/stream?channels=debug.ping`).set(owner.auth).expect(429);
    expect(res.body.error.code).toBe('RT_TOO_MANY_STREAMS');
    for (const s of open3) s.close();
  });

  it('publishes a headcount change when a guest answers their RSVP', async () => {
    const { owner, W } = await setup();
    const ev = await request(app).post(`${W}/events/bulk-from-presets`).set(owner.auth).send({ items: [{ kind: 'sangeet', date: '2027-02-12' }] }).expect(201);
    const party = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
    const link = await request(app).get(`${W}/parties/${party.body.id}/link`).set(owner.auth).expect(200);
    const start = await request(app).post('/v1/guest/auth/start').send({ token: link.body.url.split('/').pop(), installId: 'install-rt-000000000001', platform: 'android' }).expect(200);
    const otp = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(200);
    const v = await request(app).post('/v1/guest/auth/verify').send({ challengeId: otp.body.challengeId, code: '000000', installId: 'install-rt-000000000001' }).expect(200);
    const guest = { Authorization: `Bearer ${v.body.accessToken}` };
    await request(app).put('/v1/guest/consents/core').set(guest).send({ noticeVersion: 'guest-2027.1' }).expect(200);

    // Guests may not follow the host headcount channel.
    const forbidden = await request(app).get(`${W}/stream?channels=headcount`).set(guest).expect(403);
    expect(forbidden.body.error.code).toBe('RT_CHANNEL_FORBIDDEN');

    const s = await open(`${W}/stream?channels=headcount`, owner.auth);
    const sangeet = ev.body.items[0].id as string;
    await request(app).put('/v1/guest/rsvp').set(guest).send({ answers: [{ eventId: sangeet, guestId: start.body.members[0].guestId, status: 'attending' }], diets: [] }).expect(200);
    await s.waitFor(1);
    expect(s.events[0]).toMatchObject({ event: 'rsvp.changed', data: { channel: 'headcount', payload: { partyId: party.body.id, eventIds: [sangeet] } } });
    s.close();
  });
});
