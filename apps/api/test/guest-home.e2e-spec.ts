import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);
const app = boot();
const INSTALL = 'install-bbbbbbbbbbbbbbbb';

async function guestFor(owner: { auth: Record<string, string> }, W: string, partyId: string, install = INSTALL, consent = true) {
  const link = await request(app).get(`${W}/parties/${partyId}/link`).set(owner.auth).expect(200);
  const start = await request(app).post('/v1/guest/auth/start').send({ token: link.body.url.split('/').pop(), installId: install, platform: 'android' }).expect(200);
  const otp = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(200);
  const v = await request(app).post('/v1/guest/auth/verify').send({ challengeId: otp.body.challengeId, code: '000000', installId: install }).expect(200);
  const auth = { Authorization: `Bearer ${v.body.accessToken}` };
  if (consent) await request(app).put('/v1/guest/consents/core').set(auth).send({ noticeVersion: 'guest-2027.1' }).expect(200);
  return { auth, members: v.body.session.party.members as { id: string; fullName: string }[] };
}

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14', cities: ['Udaipur'] }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const venue = await request(app).post(`${W}/venues`).set(owner.auth).send({ name: 'Garden Lawn', mapsUrl: 'https://maps.google.com/?q=24.57,73.68' }).expect(201);
  const events = await request(app).post(`${W}/events/bulk-from-presets`).set(owner.auth).send({ items: [{ kind: 'haldi', date: '2027-02-12' }, { kind: 'sangeet', date: '2027-02-12' }] }).expect(201);
  const [haldi, sangeet] = events.body.items;
  await request(app).patch(`${W}/events/${haldi.id}`).set(owner.auth).send({ venueId: venue.body.id }).expect(200);
  const groups = (await request(app).get(`${W}/groups`).set(owner.auth)).body.items;
  const family = groups.find((g: { systemKey: string }) => g.systemKey === 'family').id;
  const vis = await request(app).put(`${W}/events/${haldi.id}/groups`).set(owner.auth).send({ visibility: 'groups', groupIds: [family] }).expect(200);
  const fam = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma family', groupIds: [family], members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma' }] }).expect(201);
  const friend = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Kiran', members: [{ fullName: 'Kiran Rao', phone: '9845012399' }] }).expect(201);
  await request(app).post(`${W}/contacts`).set(owner.auth).send({ label: 'Travel help', name: 'Vikram', phone: '9845011111' }).expect(201);
  return { owner, W, haldi, sangeet, family, fam: fam.body, friend: friend.body, vis: vis.body };
}

describe('event visibility (SET-04)', () => {
  it('limits an event to groups and previews the audience', async () => {
    const { owner, W, haldi, vis } = await setup();
    expect(vis).toMatchObject({ visibility: 'groups', audience: { parties: 0, guests: 0 } }); // set before parties existed
    const a = await request(app).get(`${W}/events/${haldi.id}/audience`).set(owner.auth).expect(200);
    expect(a.body).toEqual({ parties: 1, guests: 2 });
    const empty = await request(app).put(`${W}/events/${haldi.id}/groups`).set(owner.auth).send({ visibility: 'groups', groupIds: [] }).expect(400);
    expect(empty.body.error.code).toBe('SET_VISIBILITY_EMPTY');
  });
});

describe('guest home (GH-02)', () => {
  it('needs consent first, then shows only invited events with venue, RSVP counts and contacts', async () => {
    const { owner, W, fam, friend } = await setup();
    const noConsent = await guestFor(owner, W, fam.id, 'install-noconsent-0001', false);
    const blocked = await request(app).get('/v1/guest/home').set(noConsent.auth).expect(403);
    expect(blocked.body.error.code).toBe('ACC_CONSENT_REQUIRED');

    const family = await guestFor(owner, W, fam.id);
    const home = await request(app).get('/v1/guest/home').set(family.auth).expect(200);
    expect(home.body.events.map((e: { name: string }) => e.name)).toEqual(['Haldi', 'Sangeet']);
    expect(home.body.events[0]).toMatchObject({ venue: { name: 'Garden Lawn', lat: 24.57 }, rsvp: { enabled: true, answered: 0, total: 2 } });
    expect(home.body).toMatchObject({ party: { label: 'Sharma family', memberCount: 2 }, rsvpPending: 4, contacts: [{ name: 'Vikram', label: 'Travel help' }] });

    const etag = String((await request(app).get('/v1/guest/home').set(family.auth)).headers.etag);
    await request(app).get('/v1/guest/home').set(family.auth).set('If-None-Match', etag).expect(304);

    const friendG = await guestFor(owner, W, friend.id, 'install-friend-000001');
    const fh = await request(app).get('/v1/guest/home').set(friendG.auth).expect(200);
    expect(fh.body.events.map((e: { name: string }) => e.name)).toEqual(['Sangeet']); // Haldi is family-only
  });
});

describe('guest RSVP (RSV-01a)', () => {
  it('answers for family members, records diets, and refuses other parties and hidden or closed events', async () => {
    const { owner, W, fam, friend, haldi, sangeet } = await setup();
    const g = await guestFor(owner, W, fam.id);
    const [ravi, anita] = g.members;
    const state = await request(app)
      .put('/v1/guest/rsvp')
      .set(g.auth)
      .send({
        answers: [
          { eventId: haldi.id, guestId: ravi!.id, status: 'attending' },
          { eventId: haldi.id, guestId: anita!.id, status: 'maybe' },
          { eventId: sangeet.id, guestId: anita!.id, status: 'declined' },
        ],
        diets: [{ guestId: anita!.id, diet: 'jain', allergies: ['nuts'] }],
      })
      .expect(200);
    expect(state.body.events[0].answers.map((a: { status: string | null }) => a.status)).toEqual(['attending', 'maybe']);
    expect(state.body.members[1]).toMatchObject({ fullName: 'Anita Sharma', diet: 'jain', allergies: ['nuts'] });
    const row = await testPrisma().rsvps.findFirstOrThrow({ where: { guest_id: anita!.id, event_id: haldi.id } });
    expect(row).toMatchObject({ source: 'app', responded_by_guest_id: ravi!.id });

    const friendG = await guestFor(owner, W, friend.id, 'install-friend-000002');
    const hidden = await request(app).put('/v1/guest/rsvp').set(friendG.auth).send({ answers: [{ eventId: haldi.id, guestId: friendG.members[0]!.id, status: 'attending' }] }).expect(404);
    expect(hidden.body.error.code).toBe('RSV_EVENT_NOT_INVITED');
    const notMine = await request(app).put('/v1/guest/rsvp').set(friendG.auth).send({ answers: [{ eventId: sangeet.id, guestId: ravi!.id, status: 'declined' }] }).expect(404);
    expect(notMine.body.error.code).toBe('RSV_GUEST_NOT_IN_PARTY');

    await testPrisma().events.update({ where: { id: sangeet.id }, data: { rsvp_closes_at: new Date(Date.now() - 1000) } });
    const closed = await request(app).put('/v1/guest/rsvp').set(g.auth).send({ answers: [{ eventId: sangeet.id, guestId: ravi!.id, status: 'attending' }] }).expect(409);
    expect(closed.body.error.code).toBe('RSV_CLOSED');
    const home = await request(app).get('/v1/guest/home').set(g.auth).expect(200);
    expect(home.body.events.find((e: { name: string }) => e.name === 'Haldi').rsvp).toMatchObject({ answered: 2, attending: 1 });
  });
});
