import request from 'supertest';
import { boot, closePrisma, resetData, signInHost, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);

const app = boot();

describe('organisations and seats (ROL-04b)', () => {
  it('owner creates an org, invites by link, invitee accepts and gets implicit wedding access as admin', async () => {
    const boss = await signInHost(app, 'boss@agency.in');
    const org = await request(app).post('/v1/organizations').set(boss.auth).send({ name: 'Shaadi Squad' }).expect(201);
    expect(org.body).toMatchObject({ kind: 'planner', myRole: 'org_owner', weddingCount: 0 });
    const w = await request(app)
      .post('/v1/weddings')
      .set(boss.auth)
      .send({ title: 'Agency wedding', startsOn: '2027-03-01', endsOn: '2027-03-02', organizationId: org.body.id })
      .expect(201);

    const inv = await request(app).post(`/v1/organizations/${org.body.id}/invitations`).set(boss.auth).send({ email: 'Priya@Agency.in', orgRole: 'org_admin' }).expect(201);
    expect(inv.body.inviteUrl).toMatch(/^https:\/\/mehfil\.app\/i\/[A-Za-z0-9_-]{22}$/);
    const token = inv.body.inviteUrl.split('/').pop();
    const dup = await request(app).post(`/v1/organizations/${org.body.id}/invitations`).set(boss.auth).send({ email: 'priya@agency.in', orgRole: 'org_member' }).expect(409);
    expect(dup.body.error.code).toBe('ROL_INVITE_EXISTS');

    const stranger = await signInHost(app, 'stranger@example.com');
    const wrong = await request(app).post(`/v1/invitations/${token}/accept`).set(stranger.auth).expect(403);
    expect(wrong.body.error.code).toBe('ROL_INVITE_EMAIL_MISMATCH');

    const priya = await signInHost(app, 'priya@agency.in');
    await request(app).post(`/v1/invitations/${token}/accept`).set(priya.auth).expect(200);
    const again = await request(app).post(`/v1/invitations/${token}/accept`).set(priya.auth).expect(409);
    expect(again.body.error.code).toBe('ROL_INVITE_USED');

    const view = await request(app).get(`/v1/weddings/${w.body.id}`).set(priya.auth).expect(200);
    expect(view.body.myRole).toBe('planner_member');
    const orgs = await request(app).get('/v1/organizations').set(priya.auth).expect(200);
    expect(orgs.body.items).toEqual([expect.objectContaining({ name: 'Shaadi Squad', myRole: 'org_admin', weddingCount: 1 })]);
  });

  it('admins manage members but not admins/owners; the last owner cannot leave; removal cascades', async () => {
    const boss = await signInHost(app, 'boss@agency.in');
    const admin = await signInHost(app, 'admin@agency.in');
    const member = await signInHost(app, 'member@agency.in');
    const org = await request(app).post('/v1/organizations').set(boss.auth).send({ name: 'Agency' }).expect(201);
    const oid = org.body.id;
    await testPrisma().organization_members.createMany({
      data: [
        { organization_id: oid, user_id: admin.userId, org_role: 'org_admin' },
        { organization_id: oid, user_id: member.userId, org_role: 'org_member' },
      ],
    });
    const w = await request(app).post('/v1/weddings').set(boss.auth).send({ title: 'Agency W', startsOn: '2027-03-01', endsOn: '2027-03-01', organizationId: oid }).expect(201);
    await testPrisma().wedding_members.create({ data: { wedding_id: w.body.id, user_id: member.userId, role: 'planner_member' } });

    // members can't see seats
    await request(app).get(`/v1/organizations/${oid}/members`).set(member.auth).expect(403);
    const seats = await request(app).get(`/v1/organizations/${oid}/members`).set(admin.auth).expect(200);
    expect(seats.body.seats.map((s: { orgRole: string }) => s.orgRole).sort()).toEqual(['org_admin', 'org_member', 'org_owner']);

    // admin cannot promote to admin or touch the owner
    const promote = await request(app).patch(`/v1/organizations/${oid}/members/${member.userId}`).set(admin.auth).send({ orgRole: 'org_admin' }).expect(403);
    expect(promote.body.error.code).toBe('ROL_ROLE_NOT_ASSIGNABLE');
    await request(app).delete(`/v1/organizations/${oid}/members/${boss.userId}`).set(admin.auth).expect(403);
    // last owner cannot leave or be demoted
    const leave = await request(app).delete(`/v1/organizations/${oid}/members/${boss.userId}`).set(boss.auth).expect(409);
    expect(leave.body.error.code).toBe('ROL_LAST_ORG_OWNER');
    await request(app).patch(`/v1/organizations/${oid}/members/${boss.userId}`).set(boss.auth).send({ orgRole: 'org_admin' }).expect(409);

    // admin removes the member: their wedding access goes too
    await request(app).get(`/v1/weddings/${w.body.id}`).set(member.auth).expect(200);
    await request(app).delete(`/v1/organizations/${oid}/members/${member.userId}`).set(admin.auth).expect(204);
    await request(app).get(`/v1/weddings/${w.body.id}`).set(member.auth).expect(404);
    expect(await testPrisma().audit_log.count({ where: { organization_id: oid, action: 'org.seat_remove' } })).toBe(1);
  });

  it('outsiders get 404 for an org', async () => {
    const boss = await signInHost(app, 'boss@agency.in');
    const outsider = await signInHost(app, 'out@example.com');
    const org = await request(app).post('/v1/organizations').set(boss.auth).send({ name: 'Agency' }).expect(201);
    await request(app).get(`/v1/organizations/${org.body.id}/members`).set(outsider.auth).expect(404);
  });
});
