import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app';
import { InlineJobQueue } from '../src/common/jobs';
import { loadConfig } from '../src/config/env';
import { LogSinkProvider, phoneHash, signMetaBody, TemplateService } from '../src/modules/messaging';
import { closePrisma, resetData, signInHost, silentLogger, testDeps, testPrisma, truncate } from './helpers';

const jobs = new InlineJobQueue();
const { app } = createApp(testDeps({ jobs }));
const config = loadConfig();

beforeEach(async () => {
  await resetData();
  await truncate('message_templates', 'messaging_log_sink', 'messaging_webhook_events', 'realtime_events');
  jobs.sent.length = 0;
  const prisma = testPrisma();
  await new TemplateService(prisma, new LogSinkProvider(prisma, 'x'.repeat(32)), pino({ level: 'silent' })).syncCatalogue();
});
afterAll(closePrisma);

let n = 0;
async function tap(payload: string, contextId: string, from = '919845012345') {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messages: [{ from, id: `wamid.TAP${++n}`, timestamp: '1786000000', type: 'button', context: { id: contextId }, button: { payload, text: 'x' } }] } }] }],
  });
  await request(app).post('/v1/webhooks/whatsapp/log').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(config.WHATSAPP_APP_SECRET, body)).send(body).expect(200);
  await jobs.drain(silentLogger);
  return testPrisma().messaging_webhook_events.findFirstOrThrow({ where: { external_id: `wamid.TAP${n}` } });
}

async function setup(context: Record<string, unknown> = {}) {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const ev = await request(app).post(`${W}/events/bulk-from-presets`).set(owner.auth).send({ items: [{ kind: 'mehendi', date: '2027-02-12' }, { kind: 'sangeet', date: '2027-02-12' }] }).expect(201);
  const [mehendi, sangeet] = ev.body.items as { id: string }[];
  const fam = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma family', members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma' }, { fullName: 'Kabir Sharma' }] }).expect(201);
  const [ravi, anita, kabir] = fam.body.members as { id: string }[];
  const prisma = testPrisma();
  // Kabir already said no to the Sangeet himself: a one-tap from Ravi must not overwrite it.
  await prisma.rsvps.create({ data: { wedding_id: w.body.id, event_id: sangeet!.id, party_id: fam.body.id, guest_id: kabir!.id, status: 'declined', source: 'app', responded_by_guest_id: kabir!.id } });
  const msg = await prisma.messages.create({ data: { wedding_id: w.body.id, kind: 'invite', status: 'sent', context: context as object } });
  await prisma.message_recipients.create({ data: { message_id: msg.id, guest_id: ravi!.id, wedding_id: w.body.id, party_id: fam.body.id, language: 'en', reply_ref: 'abcdefghijklmnop' } });
  await prisma.message_deliveries.create({
    data: { wedding_id: w.body.id, message_id: msg.id, guest_id: ravi!.id, channel: 'whatsapp', provider: 'log', status: 'read', status_rank: 4, provider_message_id: 'wamid.INVITE', to_hash: phoneHash(config.PII_HASH_KEY, '+919845012345') },
  });
  return { weddingId: w.body.id as string, partyId: fam.body.id as string, mehendi: mehendi!, sangeet: sangeet!, ravi: ravi!, anita: anita!, kabir: kabir! };
}

const answers = async (partyId: string) =>
  Object.fromEntries((await testPrisma().rsvps.findMany({ where: { party_id: partyId } })).map((r) => [`${r.event_id}:${r.guest_id}`, `${r.status}/${r.source}`]));

describe('one-tap WhatsApp RSVP (RSV-02)', () => {
  it('answers for the family on every open event, keeps own answers, and confirms once', async () => {
    const s = await setup();
    const ev = await tap('rsv.attend|abcdefghijklmnop', 'wamid.INVITE');
    expect(ev).toMatchObject({ action: 'rsv.attend', route_status: 'routed', route_result: { outcome: 'ok' } });
    const a = await answers(s.partyId);
    for (const g of [s.ravi, s.anita, s.kabir]) expect(a[`${s.mehendi.id}:${g.id}`]).toBe('attending/whatsapp');
    expect(a[`${s.sangeet.id}:${s.ravi.id}`]).toBe('attending/whatsapp');
    expect(a[`${s.sangeet.id}:${s.anita.id}`]).toBe('attending/whatsapp');
    expect(a[`${s.sangeet.id}:${s.kabir.id}`]).toBe('declined/app'); // not overwritten

    const sink = await testPrisma().messaging_log_sink.findMany();
    expect(sink).toHaveLength(1);
    expect(sink[0]!.template_key).toBe('mehfil_rsvp_confirmation_v1');
    expect(sink[0]!.rendered).toMatch(/^mehfil_rsvp_confirmation_v1\(Ananya & Rohan \| Attending: Mehendi, Sangeet \| https:\/\/mehfil\.app\/g\/[A-Za-z0-9_-]+\)$/);
    expect(await testPrisma().realtime_events.count({ where: { channel: 'headcount', kind: 'rsvp.changed' } })).toBe(1);

    const again = await tap('rsv.attend|abcdefghijklmnop', 'wamid.INVITE');
    expect(again.route_result).toMatchObject({ outcome: 'already_done' });
    expect(await testPrisma().messaging_log_sink.count()).toBe(1); // no spam

    await tap('rsv.decline|abcdefghijklmnop', 'wamid.INVITE'); // change of mind: only Ravi changes
    const b = await answers(s.partyId);
    expect(b[`${s.mehendi.id}:${s.ravi.id}`]).toBe('declined/whatsapp');
    expect(b[`${s.mehendi.id}:${s.anita.id}`]).toBe('attending/whatsapp');
    expect(await testPrisma().audit_log.count({ where: { action: 'rsvp.answer', actor_id: s.ravi.id } })).toBe(2);
  });

  it('limits the answer to the events the invite named', async () => {
    const pre = await setup();
    await testPrisma().messages.updateMany({ where: { kind: 'invite' }, data: { context: { eventIds: [pre.sangeet.id] } } });
    await tap('rsv.maybe', 'wamid.INVITE');
    const a = await answers(pre.partyId);
    expect(a[`${pre.sangeet.id}:${pre.ravi.id}`]).toBe('maybe/whatsapp');
    expect(a[`${pre.mehendi.id}:${pre.ravi.id}`]).toBeUndefined();
  });

  it('tells the family when RSVPs have closed', async () => {
    const s = await setup();
    await testPrisma().events.updateMany({ where: { wedding_id: s.weddingId }, data: { rsvp_closes_at: new Date(Date.now() - 60_000) } });
    const ev = await tap('rsv.attend', 'wamid.INVITE');
    expect(ev.route_result).toMatchObject({ outcome: 'rejected' });
    expect(Object.keys(await answers(s.partyId))).toHaveLength(1); // only Kabir's earlier answer
    const sink = await testPrisma().messaging_log_sink.findMany();
    expect(sink.map((x) => x.template_key)).toEqual(['mehfil_rsvp_closed_v1']);
  });
});
