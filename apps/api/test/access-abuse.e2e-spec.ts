import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);
const app = boot();

async function wedding(email: string, phone = '9845012345') {
  const owner = await signInHost(app, email);
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const party = await request(app).post(`${W}/parties`).set(owner.auth).send({ label: 'Sharma family', members: [{ fullName: 'Ravi Sharma', phone }] }).expect(201);
  const link = await request(app).get(`${W}/parties/${party.body.id}/link`).set(owner.auth).expect(200);
  return { owner, W, weddingId: w.body.id as string, partyId: party.body.id as string, token: link.body.url.split('/').pop() as string };
}

let installs = 0;
async function ask(token: string, ip = '10.0.0.1') {
  const install = `install-abuse-${String(++installs).padStart(8, '0')}`;
  const start = await request(app).post('/v1/guest/auth/start').set('X-Forwarded-For', ip).send({ token, installId: install, platform: 'android' }).expect(200);
  return { install, res: await request(app).post('/v1/guest/auth/otp').set('X-Forwarded-For', ip).send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }) };
}

describe('abuse protection (ACC-05)', () => {
  it('caps codes per party in 15 minutes', async () => {
    const a = await wedding('a@example.com');
    for (let i = 0; i < 3; i++) expect((await ask(a.token, `10.0.1.${i}`)).res.status).toBe(200);
    const fourth = (await ask(a.token, '10.0.1.9')).res;
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatchObject({ code: 'ACC_OTP_SEND_LIMIT', details: { scope: 'party' } });
  });

  it('caps codes per phone across weddings, and per network', async () => {
    const weddings = await Promise.all(['b1', 'b2', 'b3'].map((x) => wedding(`${x}@example.com`, '9845077777')));
    // Two codes per wedding, all to the same phone, from different networks: 5 per hour across weddings.
    let ok = 0;
    for (const [i, w] of weddings.entries()) for (let k = 0; k < 2; k++) if ((await ask(w.token, `10.1.${i}.${k}`)).res.status === 200) ok++;
    expect(ok).toBe(5);
    const blocked = await ask(weddings[2]!.token, '10.9.9.9');
    expect(blocked.res.body.error.details.scope).toMatch(/party|phone/);

    // One network asking for many different families' codes.
    const many = await Promise.all(Array.from({ length: 4 }, (_, i) => wedding(`c${i}@example.com`, `98450100${String(i).padStart(2, '0')}`)));
    const statuses: number[] = [];
    for (const w of many) for (let k = 0; k < 3; k++) statuses.push((await ask(w.token, '172.16.0.1')).res.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(10);
    expect((await ask(many[3]!.token, '172.16.0.1')).res.body.error?.details?.scope).toBeDefined();
  });

  it('locks after 10 wrong codes, escalates a second lock to 24 h, and lets the couple unlock', async () => {
    const a = await wedding('d@example.com');
    const prisma = testPrisma();
    const wrong = async () => {
      const { install, res } = await ask(a.token, `10.2.0.${installs % 200}`);
      for (let i = 0; i < 5; i++) {
        const r = await request(app).post('/v1/guest/auth/verify').send({ challengeId: res.body.challengeId, code: '123456', installId: install });
        if (r.status === 423) return r;
      }
      return null;
    };
    await prisma.otp_challenges.deleteMany(); // keep send limits out of the way
    await wrong();
    await prisma.otp_challenges.deleteMany();
    const locked = await wrong();
    expect(locked?.body.error.code).toBe('ACC_PARTY_LOCKED');
    let state = await prisma.party_auth_state.findUniqueOrThrow({ where: { party_id: a.partyId } });
    expect(state.lock_count).toBe(1);
    expect(state.locked_until!.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);

    const view = await request(app).get(`${a.W}/parties/${a.partyId}/access`).set(a.owner.auth).expect(200);
    expect(view.body).toMatchObject({ locked: true, lastCode: { channel: 'dev' }, devices: [] });
    expect(JSON.stringify(view.body)).not.toMatch(/9845|code_hmac|phone/);

    const planner = await signInHost(app, 'planner@example.com');
    await prisma.wedding_members.create({ data: { wedding_id: a.weddingId, user_id: planner.userId, role: 'planner_member' } });
    await request(app).get(`${a.W}/parties/${a.partyId}/access`).set(planner.auth).expect(200);
    await request(app).post(`${a.W}/parties/${a.partyId}/access/unlock`).set(planner.auth).expect(403);
    await request(app).post(`${a.W}/parties/${a.partyId}/access/unlock`).set(a.owner.auth).expect(204);
    expect(await prisma.audit_log.count({ where: { action: 'party.unlocked', entity_id: a.partyId } })).toBe(1);

    // Locked again within 24 h → 24 h lock.
    await prisma.party_auth_state.update({ where: { party_id: a.partyId }, data: { locked_until: new Date(Date.now() - 60_000) } });
    await prisma.otp_challenges.deleteMany();
    await wrong();
    await prisma.otp_challenges.deleteMany();
    await wrong();
    state = await prisma.party_auth_state.findUniqueOrThrow({ where: { party_id: a.partyId } });
    expect(state.lock_count).toBe(2);
    expect(state.locked_until!.getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
  });

  it('lets the couple sign one phone out', async () => {
    const a = await wedding('e@example.com');
    const { install, res } = await ask(a.token);
    const v = await request(app).post('/v1/guest/auth/verify').send({ challengeId: res.body.challengeId, code: '000000', installId: install }).expect(200);
    const guest = { Authorization: `Bearer ${v.body.accessToken}` };
    await request(app).put('/v1/guest/consents/core').set(guest).send({ noticeVersion: 'guest-2027.1' }).expect(200);
    const view = await request(app).get(`${a.W}/parties/${a.partyId}/access`).set(a.owner.auth).expect(200);
    expect(view.body.devices).toEqual([expect.objectContaining({ platform: 'android', member: 'Ravi Sharma' })]);
    await request(app).delete(`${a.W}/parties/${a.partyId}/access/devices/${view.body.devices[0].id}`).set(a.owner.auth).expect(204);
    await request(app).get('/v1/guest/home').set(guest).expect(401);
  });
});
