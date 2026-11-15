import type { IncomingHttpHeaders } from 'node:http';
import { parseMetaWebhook, verifyMetaSignature } from './meta-format';
import type { MessagingProvider, ProviderTemplateStatus, SendResult, TemplateSendRequest, TemplateVariantDef } from './types';

type Fetch = typeof fetch;

export interface MetaCloudConfig {
  graphBase: string; // https://graph.facebook.com/v21.0
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
}

/** Meta error codes worth retrying (rate limits, transient). Everything else is final. */
const RETRYABLE = new Set(['1', '2', '4', '17', '80007', '130429', '131000', '131016', '131056', '133004']);
const META_LANG: Record<string, string> = { en: 'en', hi: 'hi', kn: 'kn' };
const STATUS_MAP: Record<string, ProviderTemplateStatus['status']> = {
  APPROVED: 'approved',
  PENDING: 'submitted',
  IN_APPEAL: 'submitted',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

/**
 * WhatsApp Cloud API adapter (MSG-01). Needs credentials: Meta app secret, WABA id, phone number
 * id and a system-user token (VAL-08/09). Never logs the destination or params.
 */
export class MetaCloudProvider implements MessagingProvider {
  readonly channel = 'whatsapp' as const;
  readonly name = 'meta_cloud';

  constructor(
    private readonly cfg: MetaCloudConfig,
    private readonly http: Fetch = fetch,
  ) {}

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
    const res = await this.http(`${this.cfg.graphBase}/${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  }

  async sendTemplate(req: TemplateSendRequest): Promise<SendResult> {
    const components: unknown[] = [];
    if (req.headerMediaUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: req.headerMediaUrl } }] });
    if (req.params.length) components.push({ type: 'body', parameters: req.params.map((text) => ({ type: 'text', text })) });
    (req.buttonPayloads ?? []).forEach((payload, index) =>
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }),
    );
    try {
      const { res, json } = await this.call(`${this.cfg.phoneNumberId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: req.to.replace(/^\+/, ''),
          type: 'template',
          biz_opaque_callback_data: req.callbackRef,
          template: { name: req.templateName, language: { code: META_LANG[req.language] ?? 'en' }, components },
        },
      });
      const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id;
      if (res.ok && id) return { ok: true, providerMessageId: id, billableUnits: 1 };
      const err = (json.error ?? {}) as { code?: number; error_subcode?: number; message?: string };
      const code = String(err.code ?? res.status);
      return { ok: false, retryable: res.status === 429 || res.status >= 500 || RETRYABLE.has(code), code, detail: err.message?.slice(0, 200) };
    } catch (e) {
      // Network error or timeout: Meta may or may not have accepted it; MSG-05 treats this as unknown.
      return { ok: false, retryable: true, code: 'network', detail: e instanceof Error ? e.name : 'error' };
    }
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    return verifyMetaSignature(this.cfg.appSecret, rawBody, headers);
  }

  parseWebhook(body: unknown) {
    return parseMetaWebhook(body);
  }

  async listTemplates(): Promise<ProviderTemplateStatus[]> {
    const out: ProviderTemplateStatus[] = [];
    let path: string | null = `${this.cfg.wabaId}/message_templates?fields=name,language,status,rejected_reason&limit=200`;
    while (path) {
      const { res, json } = await this.call(path, { method: 'GET' });
      if (!res.ok) throw new Error(`template list failed: ${res.status}`);
      for (const t of (json.data as { name: string; language: string; status: string; rejected_reason?: string }[]) ?? []) {
        out.push({ name: t.name, language: t.language, status: STATUS_MAP[t.status] ?? 'submitted', reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : undefined });
      }
      const next = (json.paging as { next?: string } | undefined)?.next;
      path = next ? next.slice(this.cfg.graphBase.length + 1) : null;
    }
    return out;
  }

  async submitTemplate(v: TemplateVariantDef): Promise<void> {
    const components: unknown[] = [{ type: 'BODY', text: v.body, ...(v.examples.length ? { example: { body_text: [v.examples] } } : {}) }];
    if (v.quickReplies?.length) components.push({ type: 'BUTTONS', buttons: v.quickReplies.map((text) => ({ type: 'QUICK_REPLY', text })) });
    const { res, json } = await this.call(`${this.cfg.wabaId}/message_templates`, {
      method: 'POST',
      body: { name: v.name, language: v.language, category: v.category.toUpperCase(), components },
    });
    if (!res.ok) throw new Error(`template submit failed: ${String((json.error as { message?: string } | undefined)?.message ?? res.status)}`);
  }
}
