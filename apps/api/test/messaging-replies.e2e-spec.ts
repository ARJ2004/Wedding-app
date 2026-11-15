import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { InlineJobQueue } from '../src/common/jobs';
import { phoneHash, signMetaBody, type InboundReplyCommand } from '../src/modules/messaging';
import { closePrisma, resetData, signInHost, silentLogger, testDeps, testPrisma, truncate } from './helpers';

const jobs = new InlineJobQueue();
const { app, replies } = createApp(testDeps({ jobs }));
const config = loadConfig();
const seen: InboundReplyCommand[] = [];
replies.register('rsv', {
  handle: async (cmd) => {
    seen.push(cmd);
    return { outcome: 'ok' };
  },
});

beforeEach(async () => {
  await resetData();
  await truncate('messaging_webhook_events', 'messaging_opt_outs');
  seen.length = 0;
});
afterAll(closePrisma);

const PHONE = '+919845012399';
let n = 0;
function inbound(msg: Record<string, unknown>) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messages: [{ from: PHONE.slice(1), id: `wamid.IN${++n}`, timestamp: '1786000000', ...msg }] } }] }],
  });
  return request(app).post('/v1/webhooks/whatsapp/log').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(config.WHATSAPP_APP_SECRET, body)).send(body).expect(200);
}

async function sentMessage() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const party = await request(app).post(`/v1/weddings/${w.body.id}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
  const prisma = testPrisma();
  const guestId = party.body.members[0].id as string;
  const msg = await prisma.messages.create({ data: { wedding_id: w.body.id, kind: 'invite', status: 'sent', context: { eventIds: ['e-sangeet'] } } });
  const replyRef = 'k3j7m2p4q7r7s6t5';
  await prisma.message_recipients.create({ data: { message_id: msg.id, guest_id: guestId, wedding_id: w.body.id, party_id: party.body.id, language: 'en', reply_ref: replyRef } });
  await prisma.message_deliveries.create({
    data: { wedding_id: w.body.id, message_id: msg.id, guest_id: guestId, channel: 'whatsapp', provider: 'log', status: 'delivered', status_rank: 3, provider_message_id: 'wamid.OUT1', to_hash: phoneHash(config.PII_HASH_KEY, PHONE) },
  });
  return { weddingId: w.body.id as string, partyId: party.body.id as string, guestId, messageId: msg.id, replyRef };
}

const events = () => testPrisma().messaging_webhook_events.findMany({ orderBy: { id: 'asc' } });

describe('inbound reply router (MSG-11)', () => {
  it('routes a button reply to the registered handler by context id, reply ref or phone', async () => {
    const m = await sentMessage();
    await inbound({ type: 'button', context: { id: 'wamid.OUT1' }, button: { payload: 'rsv.attend', text: 'Attending' } });
    await inbound({ type: 'button', button: { payload: `rsv.decline|${m.replyRef}`, text: 'Can’t make it' } });
    await inbound({ type: 'interactive', interactive: { button_reply: { id: 'rsv.maybe', title: 'Not sure' } } }); // phone fallback
    await jobs.drain(silentLogger);
    expect(seen.map((c) => c.action)).toEqual(['rsv.attend', 'rsv.decline', 'rsv.maybe']);
    for (const c of seen) expect(c).toMatchObject({ weddingId: m.weddingId, guestId: m.guestId, partyId: m.partyId, messageId: m.messageId, context: { eventIds: ['e-sangeet'] } });
    expect((await events()).map((e) => e.route_status)).toEqual(['routed', 'routed', 'routed']);

    // Replaying a routed event is a no-op.
    expect(await replies.route((await events())[0]!.id)).toBe('skipped');
    expect(seen).toHaveLength(3);
  });

  it('records STOP and START against the phone, keeps free text unmatched, ignores unknown modules', async () => {
    await sentMessage();
    const prisma = testPrisma();
    await inbound({ type: 'text', text: { body: 'STOP' } });
    await jobs.drain(silentLogger);
    expect(await prisma.messaging_opt_outs.findMany()).toMatchObject([{ channel: 'whatsapp', source: 'stop_keyword' }]);
    await inbound({ type: 'text', text: { body: 'start' } });
    await inbound({ type: 'text', text: { body: 'Is there parking at the venue?' } });
    await inbound({ type: 'button', button: { payload: 'qz.answer', text: 'B' } });
    await jobs.drain(silentLogger);
    expect(await prisma.messaging_opt_outs.count()).toBe(0);
    expect((await events()).map((e) => [e.action, e.route_status])).toEqual([
      ['msg.stop', 'routed'],
      ['msg.start', 'routed'],
      [null, 'unmatched'],
      ['qz.answer', 'ignored'],
    ]);
    expect((await events())[2]!.wedding_id).not.toBeNull(); // free text still shows on the wedding's replies list
  });

  it('retries a failing handler, then gives up after five attempts', async () => {
    await sentMessage();
    replies.register('arr', { handle: async () => { throw new Error('boom'); } });
    await inbound({ type: 'button', button: { payload: 'arr.landed', text: 'Landed' } });
    const ev = (await events())[0]!;
    jobs.sent.length = 0;
    for (let i = 0; i < 4; i++) await expect(replies.route(ev.id)).rejects.toThrow('boom');
    expect(await replies.route(ev.id)).toBe('failed');
    expect(await testPrisma().messaging_webhook_events.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ route_status: 'failed', attempts: 5 });
  });
});
