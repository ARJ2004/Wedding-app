import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { loadConfig } from '../src/config/env';
import { signMetaBody } from '../src/modules/messaging';
import { boot, closePrisma, resetData, signInHost, testPrisma, truncate } from './helpers';

const app = boot();
const SECRET = loadConfig().WHATSAPP_APP_SECRET;
const fixture = readFileSync(join(__dirname, 'fixtures/meta/webhook-mixed.json'), 'utf8');

beforeEach(async () => {
  await resetData();
  await truncate('messaging_webhook_events', 'message_templates', 'messaging_log_sink');
});
afterAll(closePrisma);

const post = (body: string, secret = SECRET) =>
  request(app).post('/v1/webhooks/whatsapp/log').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(secret, body)).send(body);

function statusBody(deliveryId: string, wamid: string, status: string, ts: number) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses: [{ id: wamid, status, timestamp: String(ts), recipient_id: '919845012399', biz_opaque_callback_data: deliveryId }] } }] }],
  });
}

/** One wedding, one guest and a queued WhatsApp delivery, as MSG-05 will create them. */
async function delivery() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14', cities: ['Udaipur'] }).expect(201);
  const party = await request(app).post(`/v1/weddings/${w.body.id}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
  const prisma = testPrisma();
  const guestId = party.body.members[0].id as string;
  const msg = await prisma.messages.create({ data: { wedding_id: w.body.id, kind: 'announcement', status: 'sending' } });
  await prisma.message_recipients.create({ data: { message_id: msg.id, guest_id: guestId, wedding_id: w.body.id, party_id: party.body.id, language: 'en', reply_ref: `ref${Date.now()}` } });
  const d = await prisma.message_deliveries.create({ data: { wedding_id: w.body.id, message_id: msg.id, guest_id: guestId, channel: 'whatsapp', provider: 'log', status: 'sending', status_rank: 1 } });
  return { deliveryId: d.id };
}

describe('WhatsApp webhooks (MSG-01)', () => {
  it('answers the Meta verification handshake only with the right token', async () => {
    const ok = await request(app).get('/v1/webhooks/whatsapp/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': loadConfig().WHATSAPP_VERIFY_TOKEN, 'hub.challenge': '1158201444' }).expect(200);
    expect(ok.text).toBe('1158201444');
    await request(app).get('/v1/webhooks/whatsapp/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);
  });

  it('rejects unsigned or wrongly signed bodies and unknown providers', async () => {
    await post(fixture, 'not-the-app-secret-0000000000000').expect(401);
    await request(app).post('/v1/webhooks/whatsapp/log').set('Content-Type', 'application/json').send(fixture).expect(401);
    await request(app).post('/v1/webhooks/whatsapp/gupshup').set('X-Hub-Signature-256', signMetaBody(SECRET, fixture)).send(fixture).expect(404);
  });

  it('applies statuses in order of rank, whatever order they arrive in', async () => {
    const { deliveryId } = await delivery();
    const prisma = testPrisma();
    const wamid = 'wamid.ORDER0001';
    await post(statusBody(deliveryId, wamid, 'delivered', 1786000010)).expect(200);
    const late = await post(statusBody(deliveryId, wamid, 'sent', 1786000005)).expect(200);
    expect(late.body.received).toEqual({ stale: 1 });
    let d = await prisma.message_deliveries.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d).toMatchObject({ status: 'delivered', status_rank: 3, provider_message_id: wamid });
    expect(d.delivered_at?.toISOString()).toBe(new Date(1786000010_000).toISOString());
    expect(d.sent_at).not.toBeNull(); // delivered implies sent
    await post(statusBody(deliveryId, wamid, 'read', 1786000020)).expect(200);
    await post(statusBody(deliveryId, wamid, 'failed', 1786000030)).expect(200); // never undoes a read
    d = await prisma.message_deliveries.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d).toMatchObject({ status: 'read', status_rank: 4 });
  });

  it('stores inbound replies once, keeps unmatched statuses and updates template approval', async () => {
    const { deliveryId } = await delivery();
    const prisma = testPrisma();
    const tpl = await prisma.message_templates.create({ data: { key: 'announcement_text', purpose: 'announcement', category: 'utility', host_selectable: true } });
    await prisma.message_template_variants.create({ data: { template_id: tpl.id, channel: 'whatsapp', language: 'en', provider: 'log', provider_template_name: 'announcement_text', body: '{{1}}', approval_status: 'submitted' } });

    const body = fixture.replace('REPLACE_DELIVERY_ID', deliveryId);
    const first = await post(body).expect(200);
    expect(first.body.received).toEqual({ applied: 1, unmatched: 1, inbound: 2, template: 1 });
    const again = await post(body).expect(200); // Meta retries: nothing new
    expect(again.body.received).toEqual({ stale: 1, unmatched: 1, duplicate: 2, template: 1 });

    const events = await prisma.messaging_webhook_events.findMany({ orderBy: { id: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['status_unmatched', 'inbound', 'inbound', 'template_status']);
    const button = events[1]!;
    expect(button).toMatchObject({ inbound_type: 'button', route_status: 'pending', payload: { payload: 'rsv.attend|k3j9m2p4q8r7s6t5', text: 'Attending' } });
    expect(button.from_hash?.length).toBe(32);
    expect(JSON.stringify(events, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('919845012399'); // no clear phone at rest

    const v = await prisma.message_template_variants.findFirstOrThrow({ where: { template_id: tpl.id } });
    expect(v.approval_status).toBe('approved');
    expect((await prisma.message_deliveries.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe('delivered');
  });
});
