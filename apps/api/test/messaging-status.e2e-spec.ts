import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app';
import { InlineJobQueue } from '../src/common/jobs';
import { loadConfig } from '../src/config/env';
import { LogSinkProvider, signMetaBody, TemplateService } from '../src/modules/messaging';
import { closePrisma, resetData, signInHost, silentLogger, testDeps, testPrisma, truncate } from './helpers';

const jobs = new InlineJobQueue();
const { app } = createApp(testDeps({ jobs }));
const SECRET = loadConfig().WHATSAPP_APP_SECRET;

beforeEach(async () => {
  await resetData();
  await truncate('message_templates', 'messaging_log_sink', 'realtime_events');
  jobs.sent.length = 0;
  const prisma = testPrisma();
  await new TemplateService(prisma, new LogSinkProvider(prisma, 'x'.repeat(32)), pino({ level: 'silent' })).syncCatalogue();
});
afterAll(closePrisma);

function status(wamid: string, s: string) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses: [{ id: wamid, status: s, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
  return request(app).post('/v1/webhooks/whatsapp/log').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(SECRET, body)).send(body).expect(200);
}

async function sent() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  for (const [label, phone] of [['Kiran', '9845012399'], ['Meera', '9845012398'], ['Old number', '9845099999'], ['No phone', undefined]] as const) {
    await request(app).post(`${W}/parties`).set(owner.auth).send({ label, members: [{ fullName: `${label} Rao`, ...(phone ? { phone } : {}) }] }).expect(201);
  }
  const m = await request(app).post(`${W}/messages`).set(owner.auth).send({ templateKey: 'announcement_text', bodyText: 'Buses at 4:15.' }).expect(201);
  await request(app).post(`${W}/messages/${m.body.id}/send`).set(owner.auth).send({}).expect(202);
  await jobs.drain(silentLogger);
  return { owner, W, weddingId: w.body.id as string, M: `${W}/messages/${m.body.id}`, messageId: m.body.id as string };
}

describe('delivery and read status (MSG-06)', () => {
  it('summarises delivery, lists failures with masked phones for planners, and publishes progress', async () => {
    const { owner, M, weddingId, messageId } = await sent();
    const prisma = testPrisma();
    const ok = await prisma.message_deliveries.findMany({ where: { message_id: messageId, status: 'sent' }, orderBy: { id: 'asc' } });
    await status(ok[0]!.provider_message_id!, 'read');
    await status(ok[1]!.provider_message_id!, 'delivered');

    const s = await request(app).get(`${M}/summary`).set(owner.auth).expect(200);
    expect(s.body).toMatchObject({ status: 'sent', recipients: 4, suppressed: { no_phone: 1 }, whatsapp: { read: 1, delivered: 1, failed: 1, sent: 0 }, deliveredPct: 67, readPct: 33 });

    const failed = await request(app).get(`${M}/deliveries?status=failed`).set(owner.auth).expect(200);
    expect(failed.body.items).toEqual([expect.objectContaining({ guestName: 'Old number Rao', partyLabel: 'Old number', errorCode: '131026', errorLabel: 'not_on_whatsapp', phone: '+919845099999', phoneMasked: false })]);

    const planner = await signInHost(app, 'planner@example.com');
    await prisma.wedding_members.create({ data: { wedding_id: weddingId, user_id: planner.userId, role: 'planner_member' } });
    const masked = await request(app).get(`${M}/deliveries?status=failed`).set(planner.auth).expect(200);
    expect(masked.body.items[0]).toMatchObject({ phone: '+91 ••••• 999', phoneMasked: true });

    const progress = await prisma.realtime_events.findMany({ where: { channel: 'messages' } });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)!.payload).toMatchObject({ messageId, counts: { sent: 2, failed: 1 } });
    expect(JSON.stringify(progress.map((p) => p.payload))).not.toMatch(/\+91|Rao/);
  });

  it('retries failed deliveries only, once the number is fixed', async () => {
    const { owner, M, messageId } = await sent();
    const prisma = testPrisma();
    const old = await prisma.guests.findFirstOrThrow({ where: { full_name: 'Old number Rao' } });
    await prisma.guests.update({ where: { id: old.id }, data: { phone_e164: '+919845012300' } });
    const r = await request(app).post(`${M}/retry-failed`).set(owner.auth).expect(202);
    expect(r.body).toEqual({ requeued: 1 });
    await jobs.drain(silentLogger);
    const s = await request(app).get(`${M}/summary`).set(owner.auth).expect(200);
    expect(s.body.whatsapp).toMatchObject({ sent: 3, failed: 0 });
    expect(await prisma.messaging_log_sink.count()).toBe(3);
    const again = await request(app).post(`${M}/retry-failed`).set(owner.auth).expect(409);
    expect(again.body.error.code).toBe('MSG_NOTHING_TO_RETRY');
    expect(await prisma.audit_log.count({ where: { action: 'message.retry_failed', entity_id: messageId } })).toBe(1);
  });
});
