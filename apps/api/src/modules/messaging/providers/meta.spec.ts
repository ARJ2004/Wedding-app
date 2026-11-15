import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MetaCloudProvider } from './meta-cloud';
import { parseMetaWebhook, signMetaBody, verifyMetaSignature } from './meta-format';

const fixture = readFileSync(join(__dirname, '../../../../test/fixtures/meta/webhook-mixed.json'));
const SECRET = 'meta-app-secret-for-tests-000000';
const cfg = { graphBase: 'https://graph.test/v21.0', phoneNumberId: '1065', wabaId: '1022', accessToken: 'tok', appSecret: SECRET };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('Meta webhook format', () => {
  it('verifies X-Hub-Signature-256 on the raw body only', () => {
    const sig = signMetaBody(SECRET, fixture);
    expect(verifyMetaSignature(SECRET, fixture, { 'x-hub-signature-256': sig })).toBe(true);
    expect(verifyMetaSignature('other-secret-000000000000000000', fixture, { 'x-hub-signature-256': sig })).toBe(false);
    expect(verifyMetaSignature(SECRET, Buffer.concat([fixture, Buffer.from(' ')]), { 'x-hub-signature-256': sig })).toBe(false);
    expect(verifyMetaSignature(SECRET, fixture, {})).toBe(false);
    expect(verifyMetaSignature(SECRET, fixture, { 'x-hub-signature-256': 'sha256=abc' })).toBe(false);
  });

  it('parses statuses, button and text replies, and template status', () => {
    const items = parseMetaWebhook(JSON.parse(fixture.toString()));
    expect(items.map((i) => i.type)).toEqual(['status', 'status', 'inbound', 'inbound', 'template_status']);
    expect(items[1]).toMatchObject({ status: 'failed', error: { code: '131026', title: 'Message undeliverable' } });
    expect(items[2]).toMatchObject({ inboundType: 'button', fromE164: '+919845012399', payload: 'rsv.attend|k3j9m2p4q8r7s6t5', contextId: expect.stringMatching(/^wamid\./) });
    expect(items[3]).toMatchObject({ inboundType: 'text', text: 'STOP' });
    expect(items[4]).toMatchObject({ name: 'announcement_text', language: 'en', event: 'APPROVED', reason: undefined });
    expect(parseMetaWebhook({ nonsense: true })).toEqual([]);
  });
});

describe('MetaCloudProvider', () => {
  it('sends a template with body params, quick-reply payloads and our delivery id', async () => {
    const { fn, calls } = fakeFetch(200, { messages: [{ id: 'wamid.OK' }] });
    const p = new MetaCloudProvider(cfg, fn);
    const r = await p.sendTemplate({ to: '+919845012399', templateName: 'rsvp_invite', language: 'hi', params: ['Ananya & Rohan', 'Sangeet'], buttonPayloads: ['rsv.attend|ref', 'rsv.decline|ref'], callbackRef: 'd-1' });
    expect(r).toEqual({ ok: true, providerMessageId: 'wamid.OK', billableUnits: 1 });
    expect(calls[0]!.url).toBe('https://graph.test/v21.0/1065/messages');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ to: '919845012399', type: 'template', biz_opaque_callback_data: 'd-1', template: { name: 'rsvp_invite', language: { code: 'hi' } } });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Ananya & Rohan' }, { type: 'text', text: 'Sangeet' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'rsv.attend|ref' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'rsv.decline|ref' }] },
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('maps rate limits to retryable and undeliverable to final', async () => {
    const limited = await new MetaCloudProvider(cfg, fakeFetch(400, { error: { code: 131056, message: 'pair rate limit' } }).fn).sendTemplate({ to: '+91', templateName: 't', language: 'en', params: [], callbackRef: 'x' });
    expect(limited).toMatchObject({ ok: false, retryable: true, code: '131056' });
    const final = await new MetaCloudProvider(cfg, fakeFetch(400, { error: { code: 131026, message: 'undeliverable' } }).fn).sendTemplate({ to: '+91', templateName: 't', language: 'en', params: [], callbackRef: 'x' });
    expect(final).toMatchObject({ ok: false, retryable: false, code: '131026' });
    const down = await new MetaCloudProvider(cfg, fakeFetch(503, {}).fn).sendTemplate({ to: '+91', templateName: 't', language: 'en', params: [], callbackRef: 'x' });
    expect(down).toMatchObject({ ok: false, retryable: true, code: '503' });
    const thrown = await new MetaCloudProvider(cfg, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch).sendTemplate({ to: '+91', templateName: 't', language: 'en', params: [], callbackRef: 'x' });
    expect(thrown).toMatchObject({ ok: false, retryable: true, code: 'network' });
  });

  it('lists templates across pages and submits new ones', async () => {
    let page = 0;
    const fn = (async (url: string) => {
      page++;
      const body = page === 1
        ? { data: [{ name: 'invite', language: 'en', status: 'APPROVED' }], paging: { next: `${cfg.graphBase}/1022/message_templates?after=X` } }
        : { data: [{ name: 'invite', language: 'hi', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }] };
      expect(url.startsWith(cfg.graphBase)).toBe(true);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const list = await new MetaCloudProvider(cfg, fn).listTemplates();
    expect(list).toEqual([
      { name: 'invite', language: 'en', status: 'approved', reason: undefined },
      { name: 'invite', language: 'hi', status: 'rejected', reason: 'INVALID_FORMAT' },
    ]);
    const { fn: submitFn, calls } = fakeFetch(200, { id: '1', status: 'PENDING' });
    await new MetaCloudProvider(cfg, submitFn).submitTemplate({ name: 'invite', language: 'en', category: 'utility', body: 'Hi {{1}}', examples: ['Kiran'], quickReplies: ['Attending'] });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ category: 'UTILITY', components: [{ type: 'BODY', example: { body_text: [['Kiran']] } }, { type: 'BUTTONS' }] });
  });
});
