import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma, truncate } from './helpers';

const app = boot();
beforeEach(async () => {
  await resetData();
  await truncate('realtime_events');
});
afterAll(closePrisma);

describe('live headcount (RSV-03)', () => {
  it('counts per event by status, side, diet, allergy and age; desk staff get totals only', async () => {
    const owner = await signInHost(app, 'owner@example.com');
    const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
    const W = `/v1/weddings/${w.body.id}`;
    const ev = await request(app).post(`${W}/events/bulk-from-presets`).set(owner.auth).send({ items: [{ kind: 'haldi', date: '2027-02-12' }, { kind: 'sangeet', date: '2027-02-12' }] }).expect(201);
    const [haldi, sangeet] = ev.body.items as { id: string }[];
    const groups = (await request(app).get(`${W}/groups`).set(owner.auth)).body.items as { id: string; systemKey: string }[];
    const g = (k: string) => groups.find((x) => x.systemKey === k)!.id;
    await request(app).put(`${W}/events/${haldi!.id}/groups`).set(owner.auth).send({ visibility: 'groups', groupIds: [g('family')] }).expect(200);
    const fam = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma', groupIds: [g('family'), g('bride_side')], members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Chintu Sharma', ageBand: 'child' }] }).expect(201);
    const fr = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Kiran', groupIds: [g('groom_side')], members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
    expect(await testPrisma().realtime_events.count({ where: { channel: 'headcount', kind: 'headcount.stale' } })).toBeGreaterThanOrEqual(2);

    const prisma = testPrisma();
    const [ravi, chintu] = (fam.body.members as { id: string }[]).map((m) => m.id) as [string, string];
    const kiran = fr.body.members[0].id as string;
    const rsvp = (guest: string, party: string, event: string, status: string) =>
      prisma.rsvps.create({ data: { wedding_id: w.body.id, event_id: event, party_id: party, guest_id: guest, status, source: 'app', responded_by_guest_id: guest } });
    await rsvp(ravi, fam.body.id, sangeet!.id, 'attending');
    await rsvp(chintu, fam.body.id, sangeet!.id, 'maybe');
    await rsvp(kiran, fr.body.id, sangeet!.id, 'declined');
    await prisma.guest_dietary.create({ data: { guest_id: ravi, wedding_id: w.body.id, diet: 'jain', allergies: ['nuts'] } });

    const h = await request(app).get(`${W}/rsvp/headcount`).set(owner.auth).expect(200);
    expect(h.body.detail).toBe(true);
    const byName = Object.fromEntries(h.body.events.map((e: { name: string }) => [e.name, e]));
    expect(byName.Haldi).toMatchObject({ invited: 2, counts: { attending: 0, declined: 0, maybe: 0, pending: 2 } });
    expect(byName.Sangeet).toMatchObject({
      invited: 3,
      counts: { attending: 1, declined: 1, maybe: 1, pending: 0 },
      bySide: { bride_side: { attending: 1, maybe: 1 }, groom_side: { declined: 1 } },
      diet: { jain: 1, unknown: 1 },
      allergies: { nuts: 1 },
      ageBand: { adult: 1, child: 1 },
    });
    expect(Number(h.body.rtCursor)).toBeGreaterThan(0);

    const desk = await signInHost(app, 'desk@example.com');
    await prisma.wedding_members.create({ data: { wedding_id: w.body.id, user_id: desk.userId, role: 'desk_staff' } });
    const d = await request(app).get(`${W}/rsvp/headcount`).set(desk.auth).expect(200);
    expect(d.body.detail).toBe(false);
    expect(d.body.events[1]).not.toHaveProperty('diet');
    expect(d.body.events[1].counts).toEqual({ attending: 1, declined: 1, maybe: 1, pending: 0 });
    const stranger = await signInHost(app, 'stranger@example.com');
    await request(app).get(`${W}/rsvp/headcount`).set(stranger.auth).expect(404);
  });
});
