import request from 'supertest';
import { createApp } from '../src/app';
import { boot, closePrisma, DEVICE, resetData, signInHost, testDeps, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);

describe('host sign-in (FND-05)', () => {
  it('dev bypass signs in, upserts the user by google_sub and audits it', async () => {
    const app = boot();
    const res = await request(app).post('/v1/auth/google').send({ idToken: 'dev:Asha@Example.com', deviceId: DEVICE }).expect(200);
    expect(res.body).toMatchObject({ expiresIn: 900, user: { email: 'asha@example.com', weddings: [], isOpsAdmin: false } });
    const user = await testPrisma().users.findUniqueOrThrow({ where: { google_sub: 'dev|asha@example.com' } });
    expect(user.last_sign_in_at).not.toBeNull();
    expect(await testPrisma().audit_log.count({ where: { action: 'auth.sign_in', actor_id: user.id } })).toBe(1);
    // Only the hash is stored
    const row = await testPrisma().refresh_tokens.findFirstOrThrow({ where: { user_id: user.id } });
    expect(row.token_hash.length).toBe(32);
    expect(Buffer.from(row.token_hash).toString('base64url')).not.toBe(res.body.refreshToken);
  });

  it('rejects dev tokens when the bypass is off, and Google tokens when Google is not configured', async () => {
    const app = boot({ config: { DEV_AUTH_ENABLED: false, GOOGLE_WEB_CLIENT_ID: undefined } });
    const dev = await request(app).post('/v1/auth/google').send({ idToken: 'dev:a@b.co', deviceId: DEVICE }).expect(401);
    expect(dev.body.error.code).toBe('AUTH_INVALID_GOOGLE_TOKEN');
    const real = await request(app).post('/v1/auth/google').send({ idToken: 'eyJhbGciOi.fake.token', deviceId: DEVICE }).expect(503);
    expect(real.body.error.code).toBe('AUTH_GOOGLE_NOT_CONFIGURED');
  });

  it('rejects a forged Google token when Google is configured', async () => {
    const app = boot({ config: { GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com' } });
    const res = await request(app).post('/v1/auth/google').send({ idToken: 'eyJhbGciOiJSUzI1NiJ9.e30.sig', deviceId: DEVICE }).expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_GOOGLE_TOKEN');
  });

  it('GET /v1/me needs a host token and returns the profile', async () => {
    const app = boot();
    await request(app).get('/v1/me').expect(401);
    await request(app).get('/v1/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
    const s = await signInHost(app, 'me@example.com');
    const res = await request(app).get('/v1/me').set(s.auth).expect(200);
    expect(res.body.email).toBe('me@example.com');
  });

  it('a guest-audience or wrongly signed token is not a host token', async () => {
    const jwt = await import('jsonwebtoken');
    const app = boot();
    const s = await signInHost(app, 'x@example.com');
    const guestish = jwt.default.sign({}, process.env.JWT_GUEST_SECRET!, { audience: 'guest', subject: s.userId });
    await request(app).get('/v1/me').set('Authorization', `Bearer ${guestish}`).expect(401);
    const wrongAud = jwt.default.sign({}, process.env.JWT_HOST_SECRET!, { audience: 'guest', subject: s.userId });
    await request(app).get('/v1/me').set('Authorization', `Bearer ${wrongAud}`).expect(401);
  });

  it('refresh rotates; reusing the old token ends every session', async () => {
    const app = boot();
    const s = await signInHost(app, 'rot@example.com');
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken, deviceId: DEVICE }).expect(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    const reused = await request(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken, deviceId: DEVICE }).expect(401);
    expect(reused.body.error.code).toBe('AUTH_REFRESH_REUSED');
    // the newer token was revoked too
    const after = await request(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken, deviceId: DEVICE }).expect(401);
    expect(after.body.error.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('refresh is bound to the device', async () => {
    const app = boot();
    const s = await signInHost(app, 'dev2@example.com');
    await request(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken, deviceId: 'another-device-000000' }).expect(401);
  });

  it('logout revokes this session; logout-all revokes every session', async () => {
    const app = boot();
    const a = await signInHost(app, 'out@example.com');
    const b = await signInHost(app, 'out@example.com');
    await request(app).post('/v1/auth/logout').set(a.auth).expect(204);
    await request(app).post('/v1/auth/refresh').send({ refreshToken: a.refreshToken, deviceId: DEVICE }).expect(401);
    await request(app).post('/v1/auth/refresh').send({ refreshToken: b.refreshToken, deviceId: DEVICE }).expect(200);
    const c = await signInHost(app, 'out@example.com');
    await request(app).post('/v1/auth/logout-all').set(c.auth).expect(204);
    expect(await testPrisma().refresh_tokens.count({ where: { user_id: c.userId, revoked_at: null } })).toBe(0);
  });

  it('auth routes have their own stricter rate limit', async () => {
    const app = createApp(testDeps({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 1 } })).app;
    await request(app).post('/v1/auth/google').send({ idToken: 'dev:rl@example.com', deviceId: DEVICE }).expect(200);
    const res = await request(app).post('/v1/auth/google').send({ idToken: 'dev:rl@example.com', deviceId: DEVICE }).expect(429);
    expect(res.body.error.code).toBe('AUTH_RATE_LIMITED');
  });
});

describe('ops jobs endpoints (FND-06b)', () => {
  it('are invisible (404) to non-ops users and listed for ops admins', async () => {
    const app = boot({ config: { OPS_ADMIN_EMAILS: ['ops@example.com'] } });
    const normal = await signInHost(app, 'normal@example.com');
    await request(app).get('/v1/ops/jobs').set(normal.auth).expect(404);
    const ops = await signInHost(app, 'ops@example.com');
    const res = await request(app).get('/v1/ops/jobs').set(ops.auth).expect(200);
    expect(res.body).toEqual({ items: [] });
    expect((await request(app).get('/v1/me').set(ops.auth)).body.isOpsAdmin).toBe(true);
  });
});
