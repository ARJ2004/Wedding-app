import request from 'supertest';
import pino from 'pino';
import { loadConfig } from '../src/config/env';
import { LogSinkProvider, phoneHash, TemplateService } from '../src/modules/messaging';
import { boot, closePrisma, resetData, signInHost, testPrisma, truncate } from './helpers';

const app = boot();
beforeEach(async () => {
  await resetData();
  await truncate('message_templates', 'messaging_log_sink', 'messaging_opt_outs');
  const prisma = testPrisma();
  await new TemplateService(prisma, new LogSinkProvider(prisma, 'x'.repeat(32)), pino({ level: 'silent' })).syncCatalogue();
});
afterAll(closePrisma);

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const events = await request(app).post(`${W}/events/bulk-from-presets`).set(owner.auth).send({ items: [{ kind: 'haldi', date: '2027-02-12' }, { kind: 'sangeet', date: '2027-02-12' }] }).expect(201);
  const [haldi, sangeet] = events.body.items;
  const groups = (await request(app).get(`${W}/groups`).set(owner.auth)).body.items;
  const family = groups.find((g: { systemKey: string }) => g.systemKey === 'family').id;
  await request(app).put(`${W}/events/${haldi.id}/groups`).set(owner.auth).send({ visibility: 'groups', groupIds: [family] }).expect(200);
  const fam = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma family', groupIds: [family], members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma', phone: '9845012345' }, { fullName: 'Chintu Sharma' }] }).expect(201);
  const friend = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
  return { owner, W, weddingId: w.body.id as string, haldi, sangeet, family, fam: fam.body, friend: friend.body };
}

const draft = { templateKey: 'announcement_text', title: 'Baraat bus', bodyText: 'Buses leave the hotel lobby at 4:15 pm sharp.' };

describe('announcement composer (MSG-03)', () => {
  it('creates a draft once per Idempotency-Key, edits with versions and lists it', async () => {
    const { owner, W } = await setup();
    const a = await request(app).post(`${W}/messages`).set(owner.auth).set('Idempotency-Key', 'compose-1').send(draft).expect(201);
    const again = await request(app).post(`${W}/messages`).set(owner.auth).set('Idempotency-Key', 'compose-1').send(draft).expect(201);
    expect(again.body.id).toBe(a.body.id);
    expect(a.body).toMatchObject({ status: 'draft', version: 1, templateKey: 'announcement_text', channels: ['whatsapp', 'push'], audience: {} });

    const edited = await request(app).patch(`${W}/messages/${a.body.id}`).set(owner.auth).send({ version: 1, bodyText: 'Buses leave at 4:30 pm.' }).expect(200);
    expect(edited.body).toMatchObject({ version: 2, bodyText: 'Buses leave at 4:30 pm.' });
    const stale = await request(app).patch(`${W}/messages/${a.body.id}`).set(owner.auth).send({ version: 1, bodyText: 'x' }).expect(409);
    expect(stale.body.error.code).toBe('MSG_VERSION_CONFLICT');
    const list = await request(app).get(`${W}/messages`).set(owner.auth).expect(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([a.body.id]);

    const bad = await request(app).post(`${W}/messages`).set(owner.auth).send({ ...draft, templateKey: 'otp' }).expect(400);
    expect(bad.body.error.code).toBe('MSG_TEMPLATE_NOT_APPROVED');
    const noImage = await request(app).post(`${W}/messages`).set(owner.auth).send({ ...draft, templateKey: 'announcement_image' }).expect(400);
    expect(noImage.body.error.code).toBe('MSG_IMAGE_REQUIRED');
  });

  it('previews the audience by group, event, RSVP and hand-picked parties', async () => {
    const { owner, W, haldi, sangeet, family, fam, friend } = await setup();
    const preview = (audience: object) => request(app).post(`${W}/messages/audience-preview`).set(owner.auth).send({ audience, templateKey: 'announcement_text' }).expect(200);

    const all = await preview({});
    expect(all.body).toMatchObject({ recipients: 4, byChannel: { whatsapp: 2 }, suppressed: { noPhone: 1, duplicatePhone: 1, optedOut: 0 }, unitsNeeded: 2, byLanguage: { en: 4 }, missingTemplateLanguages: [] });
    expect((await preview({ groups: [family] })).body.recipients).toBe(3);
    expect((await preview({ events: [haldi.id] })).body.recipients).toBe(3); // Haldi is family-only
    expect((await preview({ events: [sangeet.id] })).body.recipients).toBe(4);
    expect((await preview({ rsvp: { eventId: sangeet.id, statuses: ['pending'] } })).body.recipients).toBe(4);
    expect((await preview({ partyIds: [friend.id] })).body.recipients).toBe(1);
    expect((await preview({ groups: [family], partyIds: [friend.id] })).body.recipients).toBe(4);

    // Opted-out phones are suppressed.
    await testPrisma().messaging_opt_outs.create({ data: { phone_hash: phoneHash(loadConfig().PII_HASH_KEY, '+919845012399'), channel: 'whatsapp', source: 'stop_keyword' } });
    expect((await preview({})).body).toMatchObject({ byChannel: { whatsapp: 1 }, suppressed: { optedOut: 1 } });
    void fam;
  });

  it('renders the preview, sends a test to the host, and keeps desk staff and strangers out', async () => {
    const { owner, W, weddingId } = await setup();
    const prisma = testPrisma();
    const m = await request(app).post(`${W}/messages`).set(owner.auth).send(draft).expect(201);
    const p = await request(app).get(`${W}/messages/${m.body.id}/preview?language=en`).set(owner.auth).expect(200);
    expect(p.body).toEqual({
      language: 'en',
      whatsapp: { text: 'Update from Ananya & Rohan: Buses leave the hotel lobby at 4:15 pm sharp.', hasImage: false },
      push: { title: 'Baraat bus', body: 'Buses leave the hotel lobby at 4:15 pm sharp.' },
    });

    const noPhone = await request(app).post(`${W}/messages/${m.body.id}/test`).set(owner.auth).expect(409);
    expect(noPhone.body.error.code).toBe('MSG_NO_PHONE_ON_ACCOUNT');
    await prisma.users.update({ where: { id: owner.userId }, data: { phone_e164: '+919845000001' } });
    const t = await request(app).post(`${W}/messages/${m.body.id}/test`).set(owner.auth).expect(200);
    expect(t.body.sentTo).toBe('•••• 0001');
    const sink = await prisma.messaging_log_sink.findMany();
    expect(sink).toMatchObject([{ to_address: '+919845000001', template_key: 'mehfil_announcement_text_v1', rendered: 'mehfil_announcement_text_v1(Ananya & Rohan | Buses leave the hotel lobby at 4:15 pm sharp.)' }]);

    const desk = await signInHost(app, 'desk@example.com');
    await prisma.wedding_members.create({ data: { wedding_id: weddingId, user_id: desk.userId, role: 'desk_staff' } });
    await request(app).get(`${W}/messages`).set(desk.auth).expect(403);
    await request(app).post(`${W}/messages`).set(desk.auth).send(draft).expect(403);
    const stranger = await signInHost(app, 'stranger@example.com');
    await request(app).get(`${W}/messages/${m.body.id}`).set(stranger.auth).expect(404);
  });
});
