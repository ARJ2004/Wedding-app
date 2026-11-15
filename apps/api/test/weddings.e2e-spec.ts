import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);

const app = boot();

async function weddingWithTeam() {
  const owner = await signInHost(app, 'owner@example.com');
  const created = await request(app)
    .post('/v1/weddings')
    .set(owner.auth)
    .send({ title: 'Ananya & Rohan', partnerOneName: 'Ananya', partnerTwoName: 'Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14', cities: ['Udaipur'] })
    .expect(201);
  const weddingId = created.body.id as string;
  const team: Record<string, Awaited<ReturnType<typeof signInHost>>> = { owner };
  for (const role of ['co_host', 'planner_member', 'desk_staff'] as const) {
    const s = await signInHost(app, `${role}@example.com`);
    await testPrisma().wedding_members.create({ data: { wedding_id: weddingId, user_id: s.userId, role } });
    team[role] = s;
  }
  team.outsider = await signInHost(app, 'outsider@example.com');
  return { weddingId, team, wedding: created.body };
}

describe('weddings (SET-01, ROL-02a, ROL-04)', () => {
  it('creates a wedding: caller is owner, a family org is created, built-in groups and an audit entry exist', async () => {
    const { weddingId, wedding, team } = await weddingWithTeam();
    expect(wedding).toMatchObject({ title: 'Ananya & Rohan', timezone: 'Asia/Kolkata', myRole: 'owner', cities: ['Udaipur'] });
    const org = await testPrisma().organizations.findUniqueOrThrow({ where: { id: wedding.organizationId } });
    expect(org.kind).toBe('family');
    const groups = await request(app).get(`/v1/weddings/${weddingId}/groups`).set(team.owner!.auth).expect(200);
    expect(groups.body.items.map((g: { systemKey: string }) => g.systemKey)).toEqual(['bride_side', 'groom_side', 'family', 'friends', 'vip']);
    expect(await testPrisma().audit_log.count({ where: { wedding_id: weddingId, action: 'wedding.create' } })).toBe(1);
    const mine = await request(app).get('/v1/weddings').set(team.desk_staff!.auth).expect(200);
    expect(mine.body.items).toEqual([{ id: weddingId, title: 'Ananya & Rohan', role: 'desk_staff' }]);
  });

  it('validates dates and timezone', async () => {
    const s = await signInHost(app, 'v@example.com');
    const bad = await request(app).post('/v1/weddings').set(s.auth).send({ title: 'X & Y', startsOn: '2027-02-14', endsOn: '2027-02-12' }).expect(400);
    expect(bad.body.error.code).toBe('SET_DATES_INVALID');
    const tz = await request(app).post('/v1/weddings').set(s.auth).send({ title: 'X & Y', startsOn: '2027-02-12', endsOn: '2027-02-12', timezone: 'Mars/Base' }).expect(400);
    expect(tz.body.error.code).toBe('SET_TIMEZONE_INVALID');
    const shape = await request(app).post('/v1/weddings').set(s.auth).send({ title: 'X', startsOn: 'Feb 12' }).expect(400);
    expect(shape.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('outsiders and malformed ids get 404, never 403', async () => {
    const { weddingId, team } = await weddingWithTeam();
    const res = await request(app).get(`/v1/weddings/${weddingId}`).set(team.outsider!.auth).expect(404);
    expect(res.body.error.code).toBe('WEDDING_NOT_FOUND');
    await request(app).get('/v1/weddings/not-a-uuid').set(team.owner!.auth).expect(404);
    await request(app).get('/v1/weddings/00000000-0000-4000-8000-000000000000').set(team.owner!.auth).expect(404);
  });

  it('desk staff can read but not edit (403 ROL_FORBIDDEN); co-host can edit; edits are audited', async () => {
    const { weddingId, team } = await weddingWithTeam();
    await request(app).get(`/v1/weddings/${weddingId}`).set(team.desk_staff!.auth).expect(200);
    const denied = await request(app).patch(`/v1/weddings/${weddingId}`).set(team.desk_staff!.auth).send({ title: 'Nope' }).expect(403);
    expect(denied.body.error.code).toBe('ROL_FORBIDDEN');
    const ok = await request(app).patch(`/v1/weddings/${weddingId}`).set(team.co_host!.auth).send({ title: 'Ananya weds Rohan' }).expect(200);
    expect(ok.body).toMatchObject({ title: 'Ananya weds Rohan', myRole: 'co_host' });
    const entry = await testPrisma().audit_log.findFirstOrThrow({ where: { wedding_id: weddingId, action: 'wedding.update' } });
    expect(entry).toMatchObject({ actor_role: 'co_host', before: { title: 'Ananya & Rohan' }, after: { title: 'Ananya weds Rohan' } });
  });

  it('org owners/admins get implicit planner access; org members only with an explicit row', async () => {
    const boss = await signInHost(app, 'boss@agency.in');
    const member = await signInHost(app, 'member@agency.in');
    const org = await testPrisma().organizations.create({ data: { name: 'Agency', kind: 'planner' } });
    await testPrisma().organization_members.createMany({
      data: [
        { organization_id: org.id, user_id: boss.userId, org_role: 'org_admin' },
        { organization_id: org.id, user_id: member.userId, org_role: 'org_member' },
      ],
    });
    const created = await request(app)
      .post('/v1/weddings')
      .set(member.auth)
      .send({ title: 'Agency wedding', startsOn: '2027-03-01', endsOn: '2027-03-02', organizationId: org.id })
      .expect(201);
    const view = await request(app).get(`/v1/weddings/${created.body.id}`).set(boss.auth).expect(200);
    expect(view.body.myRole).toBe('planner_member');
    // outsider cannot create in someone else's org
    const outsider = await signInHost(app, 'nobody@example.com');
    const res = await request(app)
      .post('/v1/weddings')
      .set(outsider.auth)
      .send({ title: 'Sneaky', startsOn: '2027-03-01', endsOn: '2027-03-02', organizationId: org.id })
      .expect(403);
    expect(res.body.error.code).toBe('SET_ORG_FORBIDDEN');
  });

  it('removing a member takes effect on the next request', async () => {
    const { weddingId, team } = await weddingWithTeam();
    await request(app).get(`/v1/weddings/${weddingId}`).set(team.co_host!.auth).expect(200);
    await testPrisma().wedding_members.delete({ where: { wedding_id_user_id: { wedding_id: weddingId, user_id: team.co_host!.userId } } });
    await request(app).get(`/v1/weddings/${weddingId}`).set(team.co_host!.auth).expect(404);
  });
});

describe('events and venues (SET-02, SET-03a)', () => {
  it('bulk-adds presets in the wedding timezone, edits, reorders and soft-deletes', async () => {
    const { weddingId, team } = await weddingWithTeam();
    const W = `/v1/weddings/${weddingId}`;
    const presets = await request(app).get('/v1/event-presets').set(team.owner!.auth).expect(200);
    expect(presets.body.items).toHaveLength(6);

    const bulk = await request(app)
      .post(`${W}/events/bulk-from-presets`)
      .set(team.owner!.auth)
      .send({ items: [{ kind: 'sangeet', date: '2027-02-12' }, { kind: 'haldi', date: '2027-02-12', time: '09:30' }] })
      .expect(201);
    const [haldi, sangeet] = bulk.body.items;
    expect(haldi).toMatchObject({ name: 'Haldi', startsAt: '2027-02-12T04:00:00.000Z', dressCode: 'Yellow' });
    expect(sangeet).toMatchObject({ name: 'Sangeet', startsAt: '2027-02-12T14:00:00.000Z', endsAt: '2027-02-12T18:00:00.000Z' });

    const bad = await request(app)
      .patch(`${W}/events/${haldi.id}`)
      .set(team.co_host!.auth)
      .send({ endsAt: '2027-02-12T03:00:00Z' })
      .expect(400);
    expect(bad.body.error.code).toBe('SET_EVENT_TIME_INVALID');

    await request(app).post(`${W}/events`).set(team.desk_staff!.auth).send({ kind: 'custom', name: 'Cocktail', startsAt: '2027-02-13T15:00:00Z' }).expect(403);
    const custom = await request(app).post(`${W}/events`).set(team.planner_member!.auth).send({ kind: 'custom', startsAt: '2027-02-13T15:00:00Z' }).expect(400);
    expect(custom.body.error.code).toBe('SET_EVENT_NAME_REQUIRED');

    const order = await request(app).put(`${W}/events/order`).set(team.owner!.auth).send({ eventIds: [haldi.id, sangeet.id] }).expect(200);
    expect(order.body.items.map((e: { id: string }) => e.id)).toEqual([haldi.id, sangeet.id]);
    const mismatch = await request(app).put(`${W}/events/order`).set(team.owner!.auth).send({ eventIds: [haldi.id] }).expect(400);
    expect(mismatch.body.error.code).toBe('SET_ORDER_MISMATCH');

    await request(app).delete(`${W}/events/${sangeet.id}`).set(team.owner!.auth).expect(200);
    const list = await request(app).get(`${W}/events`).set(team.desk_staff!.auth).expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([haldi.id]);
    await request(app).post(`${W}/events/${sangeet.id}/restore`).set(team.owner!.auth).expect(200);
    expect((await request(app).get(`${W}/events`).set(team.owner!.auth)).body.items).toHaveLength(2);
  });

  it('venues take a pin from a pasted Maps link and cannot be used across weddings', async () => {
    const { weddingId, team } = await weddingWithTeam();
    const W = `/v1/weddings/${weddingId}`;
    const venue = await request(app)
      .post(`${W}/venues`)
      .set(team.owner!.auth)
      .send({ name: 'Lake Palace', mapsUrl: 'https://www.google.com/maps/place/Lake+Palace/@24.5754,73.68,17z' })
      .expect(201);
    expect(venue.body).toMatchObject({ lat: 24.5754, lng: 73.68 });
    const bad = await request(app).post(`${W}/venues`).set(team.owner!.auth).send({ name: 'X', mapsUrl: 'https://evil.example/?q=1,2' }).expect(400);
    expect(bad.body.error.code).toBe('SET_MAPS_LINK_HOST_NOT_ALLOWED');

    const ev = await request(app)
      .post(`${W}/events`)
      .set(team.owner!.auth)
      .send({ kind: 'pheras', startsAt: '2027-02-13T15:00:00Z', venueId: venue.body.id })
      .expect(201);
    expect(ev.body.venueId).toBe(venue.body.id);

    // a venue from another wedding is rejected
    const other = await request(app).post('/v1/weddings').set(team.outsider!.auth).send({ title: 'Other', startsOn: '2027-01-01', endsOn: '2027-01-01' }).expect(201);
    const otherVenue = await request(app).post(`/v1/weddings/${other.body.id}/venues`).set(team.outsider!.auth).send({ name: 'Theirs' }).expect(201);
    const cross = await request(app).post(`${W}/events`).set(team.owner!.auth).send({ kind: 'reception', startsAt: '2027-02-14T13:30:00Z', venueId: otherVenue.body.id }).expect(400);
    expect(cross.body.error.code).toBe('SET_VENUE_NOT_FOUND');

    await request(app).delete(`${W}/venues/${venue.body.id}`).set(team.owner!.auth).expect(204);
    const events = await request(app).get(`${W}/events`).set(team.owner!.auth).expect(200);
    expect(events.body.items[0].venueId).toBeNull();
  });
});

describe('guests (GST-01, GST-04)', () => {
  it('creates parties with normalised phones; desk staff see names only', async () => {
    const { weddingId, team } = await weddingWithTeam();
    const W = `/v1/weddings/${weddingId}`;
    const groups = (await request(app).get(`${W}/groups`).set(team.owner!.auth)).body.items;
    const family = groups.find((g: { systemKey: string }) => g.systemKey === 'family').id;

    const created = await request(app)
      .post(`${W}/parties`)
      .set(team.owner!.auth)
      .send({
        label: 'Sharma family',
        isOutstation: true,
        groupIds: [family],
        members: [
          { fullName: 'Ravi Sharma', phone: '098450 12345' },
          { fullName: 'Sunita Sharma', phone: '12345', relation: 'Mami ji' },
          { fullName: 'Kid Sharma', ageBand: 'child' },
        ],
      })
      .expect(201);
    expect(created.body.members[0]).toMatchObject({ fullName: 'Ravi Sharma', isPrimary: true, phone: '+919845012345', phoneStatus: 'valid' });
    expect(created.body.members[1]).toMatchObject({ phone: null, phoneStatus: 'invalid', phoneRaw: '12345', relation: 'Mami ji' });
    expect(created.body.members[2]).toMatchObject({ phoneStatus: 'missing' });
    expect(created.body.groupIds).toEqual([family]);

    const desk = await request(app).get(`${W}/parties`).set(team.desk_staff!.auth).expect(200);
    const member = desk.body.items[0].members[0];
    expect(member).toEqual({ id: expect.any(String), fullName: 'Ravi Sharma', isPrimary: true, isPlusOne: false, ageBand: null });
    expect(JSON.stringify(desk.body)).not.toContain('98450');
    await request(app).post(`${W}/parties`).set(team.desk_staff!.auth).send({ members: [{ fullName: 'X' }] }).expect(403);
    const filter = await request(app).get(`${W}/parties?phoneStatus=invalid`).set(team.desk_staff!.auth).expect(403);
    expect(filter.body.error.code).toBe('ROL_FORBIDDEN');
  });

  it('searches by name and last digits, paginates, edits and removes', async () => {
    const { weddingId, team } = await weddingWithTeam();
    const W = `/v1/weddings/${weddingId}`;
    for (const [i, name] of ['Anil Rao', 'Bina Iyer', 'Chetan Nair'].entries()) {
      await request(app).post(`${W}/parties`).set(team.owner!.auth).send({ members: [{ fullName: name, phone: `+91 98450 1000${i}` }] }).expect(201);
    }
    const byName = await request(app).get(`${W}/parties?q=iyer`).set(team.owner!.auth).expect(200);
    expect(byName.body.items.map((p: { label: string }) => p.label)).toEqual(['Bina Iyer']);
    const byDigits = await request(app).get(`${W}/parties?q=10002`).set(team.owner!.auth).expect(200);
    expect(byDigits.body.items.map((p: { label: string }) => p.label)).toEqual(['Chetan Nair']);
    const deskDigits = await request(app).get(`${W}/parties?q=10002`).set(team.desk_staff!.auth).expect(200);
    expect(deskDigits.body.items).toEqual([]);

    const page1 = await request(app).get(`${W}/parties?limit=2`).set(team.owner!.auth).expect(200);
    expect(page1.body.items).toHaveLength(2);
    const page2 = await request(app).get(`${W}/parties?limit=2&cursor=${page1.body.nextCursor}`).set(team.owner!.auth).expect(200);
    expect(page2.body.items.map((p: { label: string }) => p.label)).toEqual(['Chetan Nair']);
    expect(page2.body.nextCursor).toBeNull();

    const party = page1.body.items[0];
    const added = await request(app).post(`${W}/parties/${party.id}/guests`).set(team.co_host!.auth).send({ fullName: 'Plus One', isPlusOne: true }).expect(201);
    const plusOne = added.body.members.find((m: { fullName: string }) => m.fullName === 'Plus One');
    const promoted = await request(app).patch(`${W}/guests/${plusOne.id}`).set(team.co_host!.auth).send({ isPrimary: true }).expect(200);
    expect(promoted.body.members.filter((m: { isPrimary: boolean }) => m.isPrimary).map((m: { id: string }) => m.id)).toEqual([plusOne.id]);
    const cant = await request(app).delete(`${W}/guests/${plusOne.id}`).set(team.co_host!.auth).expect(400);
    expect(cant.body.error.code).toBe('GST_PRIMARY_REQUIRED');

    await request(app).delete(`${W}/parties/${party.id}`).set(team.owner!.auth).expect(204);
    await request(app).get(`${W}/parties/${party.id}`).set(team.owner!.auth).expect(404);
    expect(await testPrisma().audit_log.count({ where: { wedding_id: weddingId, action: { startsWith: 'party.' } } })).toBe(4);
  });

  it("another wedding's parties and guests are invisible", async () => {
    const { weddingId, team } = await weddingWithTeam();
    const p = await request(app).post(`/v1/weddings/${weddingId}/parties`).set(team.owner!.auth).send({ members: [{ fullName: 'Mine' }] }).expect(201);
    const other = await request(app).post('/v1/weddings').set(team.outsider!.auth).send({ title: 'Other', startsOn: '2027-01-01', endsOn: '2027-01-01' }).expect(201);
    await request(app).get(`/v1/weddings/${other.body.id}/parties/${p.body.id}`).set(team.outsider!.auth).expect(404);
    await request(app).patch(`/v1/weddings/${other.body.id}/guests/${p.body.members[0].id}`).set(team.outsider!.auth).send({ fullName: 'Hacked' }).expect(404);
  });
});
