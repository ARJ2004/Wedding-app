import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

const app = boot();
beforeEach(resetData);
afterAll(closePrisma);

let installs = 0;
async function guestFor(owner: { auth: Record<string, string> }, W: string, partyId: string) {
  const install = `install-trv-${String(++installs).padStart(10, '0')}`;
  const link = await request(app).get(`${W}/parties/${partyId}/link`).set(owner.auth).expect(200);
  const start = await request(app).post('/v1/guest/auth/start').send({ token: link.body.url.split('/').pop(), installId: install, platform: 'android' }).expect(200);
  const otp = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(200);
  const v = await request(app).post('/v1/guest/auth/verify').send({ challengeId: otp.body.challengeId, code: '000000', installId: install }).expect(200);
  const auth = { Authorization: `Bearer ${v.body.accessToken}` };
  await request(app).put('/v1/guest/consents/core').set(auth).send({ noticeVersion: 'guest-2027.1' }).expect(200);
  return auth;
}

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14', cities: ['Udaipur'] }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const pts = await request(app).post(`${W}/travel-points`).set(owner.auth).send({ kind: 'airport', name: 'Udaipur Airport (UDR)', code: 'udr' }).expect(201);
  await request(app).post(`${W}/travel-points`).set(owner.auth).send({ kind: 'station', name: 'Udaipur City (UDZ)', code: 'UDZ' }).expect(201);
  const fam = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma family', members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma' }, { fullName: 'Kabir Sharma' }] }).expect(201);
  const other = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
  const guest = await guestFor(owner, W, fam.body.id);
  return { owner, W, weddingId: w.body.id as string, airport: pts.body.items[0], fam: fam.body, other: other.body, guest, ids: (fam.body.members as { id: string }[]).map((m) => m.id) };
}

describe('guest travel form (TRV-01)', () => {
  it('records a family flight once, tracks progress, and keeps one arrival per person', async () => {
    const s = await setup();
    const empty = await request(app).get('/v1/guest/travel').set(s.guest).expect(200);
    expect(empty.body).toMatchObject({ status: 'pending', legs: [], members: [{ fullName: 'Ravi Sharma' }, {}, {}] });
    expect(empty.body.points.map((p: { code: string }) => p.code)).toEqual(['UDR', 'UDZ']);

    const flight = await request(app)
      .post('/v1/guest/travel/legs')
      .set(s.guest)
      .send({ direction: 'arrival', mode: 'flight', serviceNumber: '6e 2134', originCity: 'Delhi', pointId: s.airport.id, scheduledAt: '2027-02-11T10:40:00+05:30', needsPickup: true, guestIds: s.ids.slice(0, 2) })
      .expect(201);
    expect(flight.body).toMatchObject({ version: 1, carrierCode: '6E', serviceNumber: '6E2134', scheduledAt: '2027-02-11T05:10:00.000Z', point: { name: 'Udaipur Airport (UDR)' }, needsPickup: true, source: 'guest' });
    expect((await request(app).get('/v1/guest/travel').set(s.guest)).body.status).toBe('partial');

    const dup = await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'arrival', mode: 'car', scheduledAt: '2027-02-11T18:00:00+05:30', guestIds: [s.ids[1]] }).expect(409);
    expect(dup.body.error.code).toBe('TRV_LEG_EXISTS_FOR_GUEST');
    await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'arrival', mode: 'train', serviceNumber: '12963', pointId: null, scheduledAt: '2027-02-12T06:00:00+05:30', guestIds: [s.ids[2]] }).expect(201);
    await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'departure', mode: 'flight', serviceNumber: '6E 2135', scheduledAt: '2027-02-15T12:00:00+05:30', guestIds: s.ids }).expect(201);
    const all = await request(app).get('/v1/guest/travel').set(s.guest).expect(200);
    expect(all.body.status).toBe('submitted');
    expect(all.body.legs).toHaveLength(3);

    const bad = await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'departure', mode: 'flight', serviceNumber: 'hello', scheduledAt: '2027-02-15T12:00:00+05:30', guestIds: [s.ids[0]] }).expect(400);
    expect(bad.body.error.code).toBe('TRV_FLIGHT_NUMBER_INVALID');
    const far = await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'arrival', mode: 'car', scheduledAt: '2026-06-01T12:00:00+05:30', guestIds: [s.ids[0]] }).expect(400);
    expect(far.body.error.code).toBe('TRV_DATE_OUT_OF_RANGE');
    const stranger = await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'arrival', mode: 'car', scheduledAt: '2027-02-12T12:00:00+05:30', guestIds: [s.other.members[0].id] }).expect(404);
    expect(stranger.body.error.code).toBe('TRV_GUEST_NOT_IN_PARTY');
  });

  it('stops guest and host edits overwriting each other', async () => {
    const s = await setup();
    const leg = await request(app).post('/v1/guest/travel/legs').set(s.guest).send({ direction: 'arrival', mode: 'flight', serviceNumber: '6E2134', pointId: s.airport.id, scheduledAt: '2027-02-11T10:40:00+05:30', guestIds: s.ids }).expect(201);
    await request(app).patch(`/v1/guest/travel/legs/${leg.body.id}`).set(s.guest).send({ needsPickup: true }).expect(428);
    const host = await request(app).patch(`${s.W}/travel/legs/${leg.body.id}`).set(s.owner.auth).set('If-Match', '1').send({ scheduledAt: '2027-02-11T11:10:00+05:30' }).expect(200);
    expect(host.body).toMatchObject({ version: 2, source: 'host' });
    const stale = await request(app).patch(`/v1/guest/travel/legs/${leg.body.id}`).set(s.guest).set('If-Match', 'W/"1"').send({ needsPickup: true }).expect(409);
    expect(stale.body.error.code).toBe('TRV_VERSION_CONFLICT');
    const fresh = await request(app).patch(`/v1/guest/travel/legs/${leg.body.id}`).set(s.guest).set('If-Match', '2').send({ needsPickup: true, guestIds: s.ids.slice(0, 1) }).expect(200);
    expect(fresh.body).toMatchObject({ version: 3, needsPickup: true, scheduledAt: '2027-02-11T05:40:00.000Z', guests: [{ fullName: 'Ravi Sharma' }] });
    expect(await testPrisma().audit_log.count({ where: { entity_id: leg.body.id } })).toBe(3);

    const blocked = await request(app).post('/v1/guest/travel/not-travelling').set(s.guest).expect(409);
    expect(blocked.body.error.code).toBe('TRV_HAS_LEGS');
    await request(app).delete(`/v1/guest/travel/legs/${leg.body.id}`).set(s.guest).expect(204);
    await request(app).post('/v1/guest/travel/not-travelling').set(s.guest).expect(204);
    expect((await request(app).get('/v1/guest/travel').set(s.guest)).body.status).toBe('not_travelling');
  });

  it('lets hosts manage points and journeys; desk staff only read points', async () => {
    const s = await setup();
    const prisma = testPrisma();
    const desk = await signInHost(app, 'desk@example.com');
    await prisma.wedding_members.create({ data: { wedding_id: s.weddingId, user_id: desk.userId, role: 'desk_staff' } });
    expect((await request(app).get(`${s.W}/travel-points`).set(desk.auth).expect(200)).body.items).toHaveLength(2);
    await request(app).post(`${s.W}/travel-points`).set(desk.auth).send({ kind: 'bus_stand', name: 'Bus stand' }).expect(403);
    await request(app).get(`${s.W}/travel/legs`).set(desk.auth).expect(403);
    const dupName = await request(app).post(`${s.W}/travel-points`).set(s.owner.auth).send({ kind: 'airport', name: 'Udaipur Airport (UDR)' }).expect(409);
    expect(dupName.body.error.code).toBe('TRV_POINT_NAME_TAKEN');

    const leg = await request(app).post(`${s.W}/travel/legs`).set(s.owner.auth).send({ partyId: s.other.id, direction: 'arrival', mode: 'car', pointId: s.airport.id, scheduledAt: '2027-02-12T09:00:00+05:30', guestIds: [s.other.members[0].id] }).expect(201);
    expect(leg.body.source).toBe('host');
    await request(app).post(`${s.W}/travel/legs`).set(s.owner.auth).send({ partyId: s.fam.id, direction: 'arrival', mode: 'car', scheduledAt: '2027-02-12T09:00:00+05:30', guestIds: [s.other.members[0].id] }).expect(404);
    // A point in use is hidden, not deleted; guests no longer see it.
    await request(app).delete(`${s.W}/travel-points/${s.airport.id}`).set(s.owner.auth).expect(204);
    const pts = (await request(app).get(`${s.W}/travel-points`).set(s.owner.auth)).body.items;
    expect(pts.find((p: { id: string }) => p.id === s.airport.id).isActive).toBe(false);
    expect((await request(app).get('/v1/guest/travel').set(s.guest)).body.points.map((p: { code: string }) => p.code)).toEqual(['UDZ']);
    const list = await request(app).get(`${s.W}/travel/legs?direction=arrival`).set(s.owner.auth).expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ point: { id: s.airport.id, name: 'Udaipur Airport (UDR)', kind: 'airport' } })]);
    // Guests can't touch another party's journey.
    await request(app).delete(`/v1/guest/travel/legs/${leg.body.id}`).set(s.guest).expect(404);
  });
});
