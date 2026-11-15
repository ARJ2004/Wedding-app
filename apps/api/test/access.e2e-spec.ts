import request from 'supertest';
import { deriveLinkToken } from '../src/common/auth/link-token';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);
const app = boot();
const INSTALL = 'install-aaaaaaaaaaaaaaaa';
const KEY = process.env.LINK_TOKEN_KEY ?? 'dev-only-link-token-key-change-me-0123456789';

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  const W = `/v1/weddings/${w.body.id}`;
  const party = await request(app)
    .post(`${W}/parties`)
    .set(owner.auth)
    .send({ label: 'Sharma family', members: [{ fullName: 'Ravi Sharma', phone: '9845012345' }, { fullName: 'Anita Sharma', phone: '9845012346' }, { fullName: 'Kid Sharma', ageBand: 'child' }] })
    .expect(201);
  const link = await request(app).get(`${W}/parties/${party.body.id}/link`).set(owner.auth).expect(200);
  const token = link.body.url.split('/').pop() as string;
  return { owner, W, weddingId: w.body.id as string, party: party.body, token };
}

async function signInGuest(token: string, memberIndex = 0, install = INSTALL) {
  const start = await request(app).post('/v1/guest/auth/start').send({ token, installId: install, platform: 'android' }).expect(200);
  const otp = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[memberIndex].guestId }).expect(200);
  const v = await request(app).post('/v1/guest/auth/verify').send({ challengeId: otp.body.challengeId, code: '000000', installId: install }).expect(200);
  return { start: start.body, otp: otp.body, auth: { Authorization: `Bearer ${v.body.accessToken}` }, refreshToken: v.body.refreshToken as string, session: v.body.session };
}

describe('invite links (ACC-01)', () => {
  it('derives a stable 128-bit link; only its hash is stored; hosts can read it, desk staff cannot', async () => {
    const { owner, W, party, token, weddingId } = await setup();
    expect(token).toBe(deriveLinkToken(KEY, party.id, 1));
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const row = await testPrisma().parties.findUniqueOrThrow({ where: { id: party.id } });
    expect(Buffer.from(row.link_token_hash!).toString('base64url')).not.toContain(token);
    const desk = await signInHost(app, 'desk@example.com');
    await testPrisma().wedding_members.create({ data: { wedding_id: weddingId, user_id: desk.userId, role: 'desk_staff' } });
    await request(app).get(`${W}/parties/${party.id}/link`).set(desk.auth).expect(403);
    await request(app).get(`${W}/parties/${party.id}/link`).set(owner.auth).expect(200);
  });

  it('the link alone reveals only first names and masked phones; bad links look identical', async () => {
    const { token } = await setup();
    const start = await request(app).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'android' }).expect(200);
    expect(start.body.members).toEqual([
      { guestId: expect.any(String), firstName: 'Ravi', canReceiveCode: true, maskedPhone: '•• 45' },
      { guestId: expect.any(String), firstName: 'Anita', canReceiveCode: true, maskedPhone: '•• 46' },
      { guestId: expect.any(String), firstName: 'Kid', canReceiveCode: false, maskedPhone: null },
    ]);
    expect(JSON.stringify(start.body)).not.toContain('9845012345');
    const a = await request(app).post('/v1/guest/auth/start').send({ token: 'A'.repeat(22), installId: INSTALL, platform: 'android' }).expect(404);
    const b = await request(app).post('/v1/guest/auth/start').send({ token: 'nope', installId: INSTALL, platform: 'android' }).expect(404);
    expect(a.body).toEqual(b.body);
  });
});

describe('OTP sign-in and consent (ACC-02a, ACC-04, PRV-01)', () => {
  it('verifies with the dev code, then requires consent before anything personal', async () => {
    const { token } = await setup();
    const g = await signInGuest(token);
    expect(g.otp.channel).toBe('dev');
    expect(g.session).toMatchObject({ guest: { fullName: 'Ravi Sharma' }, party: { label: 'Sharma family' }, consentNeeded: ['core'] });
    expect(g.session.party.members).toHaveLength(3);
    expect(JSON.stringify(g.session)).not.toContain('98450');

    const notice = await request(app).get('/v1/guest/privacy-notice').expect(200);
    expect(notice.body).toMatchObject({ version: 'guest-2027.1', locale: 'en' });
    const outdated = await request(app).put('/v1/guest/consents/core').set(g.auth).send({ noticeVersion: 'guest-2026.1' }).expect(409);
    expect(outdated.body.error.code).toBe('PRV_NOTICE_OUTDATED');
    const after = await request(app).put('/v1/guest/consents/core').set(g.auth).send({ noticeVersion: notice.body.version }).expect(200);
    expect(after.body.consentNeeded).toEqual([]);
    const c = await testPrisma().consents.findFirstOrThrow({ where: { guest_id: g.session.guest.id, purpose: 'core' } });
    expect(c).toMatchObject({ notice_version: 'guest-2027.1', source: 'guest_app', withdrawn_at: null });
  });

  it('wrong codes count down, exhaust the challenge, and enough failures lock the party', async () => {
    const { token, party } = await setup();
    const start = await request(app).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'ios' }).expect(200);
    const first = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(200);
    const wrong = await request(app).post('/v1/guest/auth/verify').send({ challengeId: first.body.challengeId, code: '123456', installId: INSTALL }).expect(400);
    expect(wrong.body.error).toMatchObject({ code: 'ACC_OTP_INVALID', details: { attemptsLeft: 4 } });
    const elsewhere = await request(app).post('/v1/guest/auth/verify').send({ challengeId: first.body.challengeId, code: '000000', installId: 'other-install-000000' }).expect(409);
    expect(elsewhere.body.error.code).toBe('ACC_INSTALL_MISMATCH');
    for (let i = 0; i < 3; i++) await request(app).post('/v1/guest/auth/verify').send({ challengeId: first.body.challengeId, code: '123456', installId: INSTALL }).expect(400);
    await request(app).post('/v1/guest/auth/verify').send({ challengeId: first.body.challengeId, code: '123456', installId: INSTALL }).expect(429);
    // too-soon resend is refused; pretend 31 s passed
    await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(409);
    await testPrisma().otp_challenges.updateMany({ where: { party_id: party.id }, data: { created_at: new Date(Date.now() - 31_000) } });
    const second = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[1].guestId }).expect(200);
    for (let i = 0; i < 4; i++) await request(app).post('/v1/guest/auth/verify').send({ challengeId: second.body.challengeId, code: '999999', installId: INSTALL }).expect(400);
    const locked = await request(app).post('/v1/guest/auth/verify').send({ challengeId: second.body.challengeId, code: '999999', installId: INSTALL }).expect(423);
    expect(locked.body.error.code).toBe('ACC_PARTY_LOCKED');
    await request(app).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'ios' }).expect(423);
  });

  it('refuses members without a phone', async () => {
    const { token } = await setup();
    const start = await request(app).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'web' }).expect(200);
    const res = await request(app).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[2].guestId }).expect(422);
    expect(res.body.error.code).toBe('ACC_NO_PHONE');
  });

  it('is unavailable outside dev until messaging is configured', async () => {
    const { token } = await setup();
    const prodLike = boot({ config: { DEV_AUTH_ENABLED: false } });
    const start = await request(prodLike).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'web' }).expect(200);
    const res = await request(prodLike).post('/v1/guest/auth/otp').send({ linkTicket: start.body.linkTicket, guestId: start.body.members[0].guestId }).expect(503);
    expect(res.body.error.code).toBe('ACC_OTP_CHANNEL_UNAVAILABLE');
  });
});

describe('guest sessions', () => {
  it('guest tokens never pass host routes, and host tokens never pass guest routes', async () => {
    const { owner, W, token } = await setup();
    const g = await signInGuest(token);
    await request(app).get(W).set(g.auth).expect(401);
    await request(app).get('/v1/me').set(g.auth).expect(401);
    await request(app).get('/v1/guest/session').set(owner.auth).expect(401);
  });

  it('refresh rotates within the device trust window; reuse ends the device', async () => {
    const { token } = await setup();
    const g = await signInGuest(token);
    const r1 = await request(app).post('/v1/guest/auth/refresh').send({ refreshToken: g.refreshToken, installId: INSTALL }).expect(200);
    expect(r1.body.refreshToken).not.toBe(g.refreshToken);
    const reused = await request(app).post('/v1/guest/auth/refresh').send({ refreshToken: g.refreshToken, installId: INSTALL }).expect(401);
    expect(reused.body.error.code).toBe('AUTH_REFRESH_REUSED');
    await request(app).post('/v1/guest/auth/refresh').send({ refreshToken: r1.body.refreshToken, installId: INSTALL }).expect(401);
  });

  it('rotating the link signs every device out at once', async () => {
    const { owner, W, party, token } = await setup();
    const g = await signInGuest(token);
    await request(app).get('/v1/guest/session').set(g.auth).expect(200);
    const rotated = await request(app).post(`${W}/parties/${party.id}/link/rotate`).set(owner.auth).expect(200);
    expect(rotated.body.version).toBe(2);
    const res = await request(app).get('/v1/guest/session').set(g.auth).expect(401);
    expect(res.body.error.code).toBe('ACC_DEVICE_EXPIRED');
    await request(app).post('/v1/guest/auth/start').send({ token, installId: INSTALL, platform: 'android' }).expect(404);
    await request(app).post('/v1/guest/auth/start').send({ token: rotated.body.url.split('/').pop(), installId: INSTALL, platform: 'android' }).expect(200);
  });

  it('withdrawing core consent signs the device out', async () => {
    const { token } = await setup();
    const g = await signInGuest(token);
    await request(app).put('/v1/guest/consents/core').set(g.auth).send({ noticeVersion: 'guest-2027.1' }).expect(200);
    await request(app).delete('/v1/guest/consents/core').set(g.auth).expect(204);
    await request(app).get('/v1/guest/session').set(g.auth).expect(401);
  });
});
