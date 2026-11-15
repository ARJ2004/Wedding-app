import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);
const app = boot();

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Groups test', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const a = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Rao family', members: [{ fullName: 'Anil Rao', phone: '9845010001' }, { fullName: 'Kid Rao', ageBand: 'child' }] }).expect(201);
  const b = await request(app).post(`${W}/parties`).set(owner.auth).send({ members: [{ fullName: '=HYPERLINK("http://x")', phone: '12' }] }).expect(201);
  const desk = await signInHost(app, 'desk@example.com');
  await testPrisma().wedding_members.create({ data: { wedding_id: w.body.id, user_id: desk.userId, role: 'desk_staff' } });
  return { owner, desk, W, a: a.body, b: b.body };
}

describe('groups (GST-06)', () => {
  it('creates, renames, bulk-assigns and deletes custom groups; built-ins are protected', async () => {
    const { owner, desk, W, a, b } = await setup();
    const g = await request(app).post(`${W}/groups`).set(owner.auth).send({ name: 'College friends', colour: '#1D4E89' }).expect(201);
    expect(g.body).toMatchObject({ name: 'College friends', systemKey: null, partyCount: 0 });
    const dup = await request(app).post(`${W}/groups`).set(owner.auth).send({ name: 'College friends' }).expect(409);
    expect(dup.body.error.code).toBe('GST_GROUP_NAME_TAKEN');
    await request(app).post(`${W}/groups`).set(desk.auth).send({ name: 'Nope' }).expect(403);

    const added = await request(app).post(`${W}/groups/${g.body.id}/parties`).set(owner.auth).send({ op: 'add', partyIds: [a.id, b.id] }).expect(200);
    expect(added.body).toMatchObject({ changed: 2, group: { partyCount: 2 } });
    const again = await request(app).post(`${W}/groups/${g.body.id}/parties`).set(owner.auth).send({ op: 'add', partyIds: [a.id] }).expect(200);
    expect(again.body.changed).toBe(0);
    const filtered = await request(app).get(`${W}/parties?groupId=${g.body.id}`).set(owner.auth).expect(200);
    expect(filtered.body.items).toHaveLength(2);
    await request(app).post(`${W}/groups/${g.body.id}/parties`).set(owner.auth).send({ op: 'remove', partyIds: [b.id] }).expect(200);

    await request(app).patch(`${W}/groups/${g.body.id}`).set(owner.auth).send({ name: 'College gang' }).expect(200);
    const groups = await request(app).get(`${W}/groups`).set(owner.auth).expect(200);
    const vip = groups.body.items.find((x: { systemKey: string }) => x.systemKey === 'vip');
    const builtin = await request(app).delete(`${W}/groups/${vip.id}`).set(owner.auth).expect(409);
    expect(builtin.body.error.code).toBe('GST_GROUP_BUILTIN');
    await request(app).patch(`${W}/groups/${vip.id}`).set(owner.auth).send({ name: 'Very special' }).expect(200);
    await request(app).delete(`${W}/groups/${g.body.id}`).set(owner.auth).expect(204);
    expect((await request(app).get(`${W}/parties/${a.id}`).set(owner.auth)).body.groupIds).toEqual([]);
  });

  it("rejects another wedding's parties in bulk assignment", async () => {
    const { owner, W } = await setup();
    const other = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Other one', startsOn: '2027-01-01', endsOn: '2027-01-01' }).expect(201);
    const theirs = await request(app).post(`/v1/weddings/${other.body.id}/parties`).set(owner.auth).send({ members: [{ fullName: 'Not yours' }] }).expect(201);
    const g = await request(app).post(`${W}/groups`).set(owner.auth).send({ name: 'Mixed' }).expect(201);
    await request(app).post(`${W}/groups/${g.body.id}/parties`).set(owner.auth).send({ op: 'add', partyIds: [theirs.body.id] }).expect(404);
  });
});

describe('export (GST-07a)', () => {
  it('exports one row per guest with formula injection neutralised; desk staff cannot export', async () => {
    const { owner, desk, W } = await setup();
    const res = await request(app).get(`${W}/parties/export.csv`).set(owner.auth).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\n');
    expect(lines[0]).toBe('Party,Name,Primary,Phone,Phone status,Email,Age,Relation,Groups,City,Travelling,Language,Plus-ones');
    expect(lines).toContain('Rao family,Anil Rao,yes,+919845010001,valid,,,,,,,en,0');
    expect(lines.some((l) => l.includes(`"'=HYPERLINK(""http://x"")"`))).toBe(true);
    expect(lines).toHaveLength(4);
    await request(app).get(`${W}/parties/export.csv`).set(desk.auth).expect(403);
  });
});
