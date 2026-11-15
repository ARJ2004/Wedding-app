import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app';
import { InlineJobQueue } from '../src/common/jobs';
import { LogSinkProvider, TemplateService } from '../src/modules/messaging';
import { closePrisma, resetData, signInHost, silentLogger, testDeps, testPrisma, truncate } from './helpers';

const jobs = new InlineJobQueue();
const { app, fanout } = createApp(testDeps({ jobs }));

beforeEach(async () => {
  await resetData();
  await truncate('message_templates', 'messaging_log_sink', 'messaging_opt_outs');
  jobs.sent.length = 0;
  const prisma = testPrisma();
  await new TemplateService(prisma, new LogSinkProvider(prisma, 'x'.repeat(32)), pino({ level: 'silent' })).syncCatalogue();
});
afterAll(closePrisma);

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const party = (label: string, members: { fullName: string; phone?: string }[]) => request(app).post(`${W}/parties`).set(owner.auth).send({ label, members }).expect(201);
  await party('Sharma family', [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma', phone: '9845012345' }, { fullName: 'Chintu Sharma' }]);
  await party('Kiran', [{ fullName: 'Kiran Rao', phone: '9845012399' }]);
  await party('Undeliverable', [{ fullName: 'Old Number', phone: '9845099999' }]);
  await party('Rate limited', [{ fullName: 'Busy Phone', phone: '9845099998' }]);
  const m = await request(app).post(`${W}/messages`).set(owner.auth).send({ templateKey: 'announcement_text', bodyText: 'Buses leave at 4:15 pm.' }).expect(201);
  return { owner, W, messageId: m.body.id as string };
}

describe('fan-out (MSG-05)', () => {
  it('sends each reachable guest once, retries rate limits, fails final errors and finishes the message', async () => {
    const { owner, W, messageId } = await setup();
    const prisma = testPrisma();
    const send = () => request(app).post(`${W}/messages/${messageId}/send`).set(owner.auth).set('Idempotency-Key', 'send-key-0001').send({});
    const first = await send();
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: 'resolving', recipientCountEstimate: 6 });
    await send().expect(202); // same key: replayed, no second resolve
    expect(jobs.sent.filter((j) => j.name === 'msg.resolve')).toHaveLength(1);
    const other = await request(app).post(`${W}/messages/${messageId}/send`).set(owner.auth).send({}).expect(409);
    expect(other.body.error.code).toBe('MSG_ALREADY_SENT');

    await jobs.drain(silentLogger);

    const recipients = await prisma.message_recipients.findMany({ where: { message_id: messageId } });
    expect(recipients).toHaveLength(6);
    expect(recipients.map((r) => r.suppressed_reason).sort()).toEqual(['duplicate_phone', 'no_phone', null, null, null, null]);
    expect(new Set(recipients.map((r) => r.reply_ref)).size).toBe(6);
    const deliveries = await prisma.message_deliveries.findMany({ where: { message_id: messageId } });
    const byStatus = Object.fromEntries(['sent', 'failed'].map((s) => [s, deliveries.filter((d) => d.status === s).length]));
    expect(byStatus).toEqual({ sent: 2, failed: 2 });
    expect(deliveries.find((d) => d.error_code === '131056')).toMatchObject({ status: 'failed', attempts: 4 }); // 1 + 3 retries
    expect(deliveries.find((d) => d.error_code === '131026')).toMatchObject({ status: 'failed', attempts: 1 });
    expect(deliveries.filter((d) => d.status === 'sent').every((d) => d.provider_message_id?.startsWith('wamid.log.') && d.fallback_due_at)).toBe(true);
    expect(await prisma.messaging_log_sink.count()).toBe(2);
    expect((await prisma.messaging_log_sink.findFirstOrThrow()).rendered).toBe('mehfil_announcement_text_v1(Ananya & Rohan | Buses leave at 4:15 pm.)');
    expect(await prisma.messages.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({ status: 'sent', recipient_count: 6 });

    // A re-delivered batch job (pg-boss at-least-once) claims nothing and sends nothing.
    expect(await fanout.sendDeliveries(deliveries.map((d) => d.id))).toEqual([]);
    expect(await prisma.messaging_log_sink.count()).toBe(2);
    // A retried resolve after success is a no-op.
    expect(await fanout.resolve(messageId, 1)).toEqual({ skipped: true });
  });

  it('marks deliveries stuck in sending as unknown and never resends them', async () => {
    const { owner, W, messageId } = await setup();
    const prisma = testPrisma();
    await request(app).post(`${W}/messages/${messageId}/send`).set(owner.auth).send({}).expect(202);
    // Run only the resolve, then simulate a worker that claimed a batch and crashed mid-call.
    const resolve = jobs.sent.shift()!;
    expect(resolve.name).toBe('msg.resolve');
    await fanout.resolve(messageId, 1);
    jobs.sent.length = 0;
    await prisma.message_deliveries.updateMany({ where: { message_id: messageId }, data: { status: 'sending', status_rank: 1, claimed_at: new Date(Date.now() - 10 * 60_000) } });
    expect(await fanout.markStuck()).toBe(4);
    expect(await prisma.message_deliveries.count({ where: { message_id: messageId, status: 'unknown' } })).toBe(4);
    expect(await fanout.sendDeliveries((await prisma.message_deliveries.findMany({ where: { message_id: messageId } })).map((d) => d.id))).toEqual([]);
    expect(await prisma.messaging_log_sink.count()).toBe(0);
    expect((await prisma.messages.findUniqueOrThrow({ where: { id: messageId } })).status).toBe('sent');
  });

  it('re-queues a message whose resolve job was lost', async () => {
    const { owner, W, messageId } = await setup();
    const prisma = testPrisma();
    await request(app).post(`${W}/messages/${messageId}/send`).set(owner.auth).send({}).expect(202);
    jobs.sent.length = 0; // the job never reached the queue
    expect(await fanout.sweepResolving()).toBe(0); // too fresh
    await prisma.messages.update({ where: { id: messageId }, data: { updated_at: new Date(Date.now() - 120_000) } });
    expect(await fanout.sweepResolving()).toBe(1);
    await jobs.drain(silentLogger);
    expect((await prisma.messages.findUniqueOrThrow({ where: { id: messageId } })).status).toBe('sent');
  });

  it('refuses an empty audience', async () => {
    const owner = await signInHost(app, 'owner@example.com');
    const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
    const m = await request(app).post(`/v1/weddings/${w.body.id}/messages`).set(owner.auth).send({ templateKey: 'announcement_text', bodyText: 'Hi' }).expect(201);
    const r = await request(app).post(`/v1/weddings/${w.body.id}/messages/${m.body.id}/send`).set(owner.auth).send({}).expect(409);
    expect(r.body.error.code).toBe('MSG_AUDIENCE_EMPTY');
  });
});
