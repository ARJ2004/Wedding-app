import request from 'supertest';
import { createApp } from '../src/app';
import type { FakeObjectStore } from '../src/common/object-store';
import { closePrisma, resetData, signInHost, testDeps, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);
const deps = testDeps();
const app = createApp(deps).app;
const store = deps.objectStore as FakeObjectStore;

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Settings test', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const desk = await signInHost(app, 'desk@example.com');
  await testPrisma().wedding_members.create({ data: { wedding_id: w.body.id, user_id: desk.userId, role: 'desk_staff' } });
  return { owner, desk, W: `/v1/weddings/${w.body.id}`, weddingId: w.body.id as string };
}

describe('wedding settings (SET-06)', () => {
  it('returns defaults, deep-merges patches, validates strictly and audits', async () => {
    const { owner, desk, W, weddingId } = await setup();
    const d = await request(app).get(`${W}/settings`).set(desk.auth).expect(200);
    expect(d.body.camera).toEqual({ shotLimit: 24, limitScope: 'wedding', revealMode: 'next_morning', revealAt: null });
    await request(app).patch(`${W}/settings`).set(desk.auth).send({ camera: { shotLimit: 10 } }).expect(403);

    const p = await request(app).patch(`${W}/settings`).set(owner.auth).send({ camera: { shotLimit: 36 }, branding: { palette: 'mehendiGold' } }).expect(200);
    expect(p.body).toMatchObject({ camera: { shotLimit: 36, revealMode: 'next_morning' }, branding: { palette: 'mehendiGold' } });

    const bad = await request(app).patch(`${W}/settings`).set(owner.auth).send({ camera: { flash: true } }).expect(400);
    expect(bad.body.error.code).toBe('SET_SETTINGS_INVALID');
    const sched = await request(app).patch(`${W}/settings`).set(owner.auth).send({ camera: { revealMode: 'scheduled' } }).expect(400);
    expect(sched.body.error.details).toEqual([{ path: 'camera.revealAt', message: expect.any(String) }]);
    const pal = await request(app).patch(`${W}/settings`).set(owner.auth).send({ branding: { palette: 'neonPink' } }).expect(400);
    expect(pal.body.error.code).toBe('SET_PALETTE_UNKNOWN');

    const entry = await testPrisma().audit_log.findFirstOrThrow({ where: { wedding_id: weddingId, action: 'wedding.settings.update' } });
    expect(entry.after).toMatchObject({ camera: { shotLimit: 36 } });
  });

  it('links an uploaded cover photo and returns a URL; rejects other weddings and unfinished uploads', async () => {
    const { owner, W } = await setup();
    const t = await request(app).post(`${W}/uploads`).set(owner.auth).send({ purpose: 'cover', contentType: 'image/jpeg', byteSize: 4 }).expect(201);
    const early = await request(app).patch(W).set(owner.auth).send({ coverMediaId: t.body.mediaId }).expect(409);
    expect(early.body.error.code).toBe('SET_COVER_NOT_READY');
    store.simulateUpload(t.body.uploadUrl, Buffer.from('jpeg'), 'image/jpeg');
    await request(app).post(`/v1/uploads/${t.body.mediaId}/complete`).set(owner.auth).expect(200);
    const w = await request(app).patch(W).set(owner.auth).send({ coverMediaId: t.body.mediaId }).expect(200);
    expect(w.body.coverUrl).toMatch(/^fake:\/\/.+cover/);
    expect((await request(app).get(W).set(owner.auth)).body.coverUrl).toEqual(expect.any(String));

    const other = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Another one', startsOn: '2027-01-01', endsOn: '2027-01-01' }).expect(201);
    const cross = await request(app).patch(`/v1/weddings/${other.body.id}`).set(owner.auth).send({ coverMediaId: t.body.mediaId }).expect(400);
    expect(cross.body.error.code).toBe('SET_COVER_NOT_FOUND');
    const removed = await request(app).patch(W).set(owner.auth).send({ coverMediaId: null }).expect(200);
    expect(removed.body.coverUrl).toBeNull();
  });
});

describe('key contacts (SET-05)', () => {
  it('adds, validates, reorders and limits contacts; audit masks phones', async () => {
    const { owner, desk, W, weddingId } = await setup();
    const a = await request(app).post(`${W}/contacts`).set(owner.auth).send({ side: 'bride', label: 'Travel help', name: 'Vikram', phone: '098450 12345' }).expect(201);
    expect(a.body).toMatchObject({ phone: '+919845012345', hasWhatsapp: true, sortOrder: 0 });
    const bad = await request(app).post(`${W}/contacts`).set(owner.auth).send({ label: 'X', name: 'Y', phone: '12345' }).expect(400);
    expect(bad.body.error.code).toBe('GST_PHONE_INVALID');
    await request(app).post(`${W}/contacts`).set(desk.auth).send({ label: 'X', name: 'Y', phone: '9845012345' }).expect(403);
    const b = await request(app).post(`${W}/contacts`).set(owner.auth).send({ side: 'groom', label: "Groom's brother", name: 'Rahul', phone: '+91 99000 11223' }).expect(201);

    const list = await request(app).get(`${W}/contacts`).set(desk.auth).expect(200);
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(['Vikram', 'Rahul']);
    const ordered = await request(app).put(`${W}/contacts/order`).set(owner.auth).send({ contactIds: [b.body.id, a.body.id] }).expect(200);
    expect(ordered.body.items.map((c: { name: string }) => c.name)).toEqual(['Rahul', 'Vikram']);

    for (let i = 0; i < 8; i++) {
      await request(app).post(`${W}/contacts`).set(owner.auth).send({ label: `Help ${i}`, name: `Person ${i}`, phone: `+91 9845 0000${i}0` }).expect(201);
    }
    const over = await request(app).post(`${W}/contacts`).set(owner.auth).send({ label: 'One more', name: 'Z', phone: '9845099999' }).expect(409);
    expect(over.body.error.code).toBe('SET_CONTACTS_LIMIT');

    const entry = await testPrisma().audit_log.findFirstOrThrow({ where: { wedding_id: weddingId, action: 'contact.create', entity_id: a.body.id } });
    expect(JSON.stringify(entry.after)).not.toContain('9845012345');
    await request(app).delete(`${W}/contacts/${a.body.id}`).set(owner.auth).expect(204);
  });
});
