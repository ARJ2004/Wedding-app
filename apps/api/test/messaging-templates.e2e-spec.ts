import request from 'supertest';
import pino from 'pino';
import { TemplateService, type MessagingProvider, type ProviderTemplateStatus } from '../src/modules/messaging';
import { boot, closePrisma, resetData, signInHost, testPrisma, truncate } from './helpers';

const app = boot();
beforeEach(async () => {
  await resetData();
  await truncate('message_templates');
});
afterAll(closePrisma);

/** A Meta-like provider whose remote statuses the test controls. */
function fakeMeta(remote: ProviderTemplateStatus[]): MessagingProvider & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    channel: 'whatsapp',
    name: 'meta_cloud',
    submitted,
    sendTemplate: async () => ({ ok: true, providerMessageId: 'x', billableUnits: 1 }),
    verifyWebhook: () => true,
    parseWebhook: () => [],
    listTemplates: async () => remote,
    submitTemplate: async (v) => {
      submitted.push(`${v.name}/${v.language}`);
    },
  };
}

describe('message templates (MSG-02)', () => {
  it('lists approved host-selectable templates to hosts only', async () => {
    const prisma = testPrisma();
    await new TemplateService(prisma, { ...fakeMeta([]), name: 'log' }, pino({ level: 'silent' })).syncCatalogue();
    const owner = await signInHost(app, 'owner@example.com');
    const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
    const W = `/v1/weddings/${w.body.id}`;
    const res = await request(app).get(`${W}/message-templates`).set(owner.auth).expect(200);
    expect(res.body.items.map((t: { key: string }) => t.key)).toEqual(['announcement_image', 'announcement_text', 'rsvp_reminder']);
    expect(res.body.items[1]).toEqual({
      key: 'announcement_text',
      purpose: 'announcement',
      description: 'Host announcement (text)',
      languages: ['en'],
      params: [{ name: 'wedding', max: 60 }, { name: 'text', max: 1024 }],
      header: 'none',
    });
    const hi = await request(app).get(`${W}/message-templates?language=hi`).set(owner.auth).expect(200);
    expect(hi.body.items).toEqual([]);

    const desk = await signInHost(app, 'desk@example.com');
    const deskUser = await prisma.users.findFirstOrThrow({ where: { email: 'desk@example.com' } });
    await prisma.wedding_members.create({ data: { wedding_id: w.body.id, user_id: deskUser.id, role: 'desk_staff' } });
    await request(app).get(`${W}/message-templates`).set(desk.auth).expect(403);
    const other = await signInHost(app, 'other@example.com');
    await request(app).get(`${W}/message-templates`).set(other.auth).expect(404);
  });

  it('pushes drafts, pulls approval and alerts when an approved template is paused', async () => {
    const prisma = testPrisma();
    const remote: ProviderTemplateStatus[] = [];
    const meta = fakeMeta(remote);
    const errors: string[] = [];
    const logger = pino({ level: 'error' }, { write: (line: string) => errors.push(JSON.parse(line).msg) });
    const svc = new TemplateService(prisma, meta, logger);
    await svc.syncCatalogue();
    expect(await prisma.message_template_variants.count({ where: { provider: 'meta_cloud', approval_status: 'draft' } })).toBe(8);
    expect(await svc.push()).toBe(8);
    expect(meta.submitted).toContain('mehfil_announcement_text_v1/en');

    remote.push({ name: 'mehfil_announcement_text_v1', language: 'en', status: 'approved' });
    expect((await svc.pullStatus()).changed).toBe(1);
    remote[0] = { name: 'mehfil_announcement_text_v1', language: 'en', status: 'paused', reason: 'LOW_QUALITY' };
    const r = await svc.pullStatus();
    expect(r.alerts).toEqual(['announcement_text/en is now paused']);
    expect(errors).toEqual(['WhatsApp template announcement_text/en is now paused']);
    const v = await prisma.message_template_variants.findFirstOrThrow({ where: { provider_template_name: 'mehfil_announcement_text_v1' } });
    expect(v).toMatchObject({ approval_status: 'paused', rejection_reason: 'LOW_QUALITY' });

    // Re-sync after a body change sends it back to draft (new approval needed).
    const { CATALOGUE } = await import('../src/modules/messaging');
    const changed = structuredClone(CATALOGUE);
    changed.find((t) => t.key === 'announcement_text')!.variants[0]!.body = 'News from {{1}}: {{2}}';
    await svc.syncCatalogue(changed);
    expect((await prisma.message_template_variants.findUniqueOrThrow({ where: { id: v.id } })).approval_status).toBe('draft');
  });
});
