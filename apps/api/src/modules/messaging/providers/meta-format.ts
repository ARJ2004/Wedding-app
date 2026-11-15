import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { DeliveryStatus, WebhookItem } from './types';

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body); constant-time compare. */
export function verifyMetaSignature(secret: string, rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const header = headers['x-hub-signature-256'];
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signMetaBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const STATUSES = new Set<DeliveryStatus>(['sent', 'delivered', 'read', 'failed']);
const asDate = (ts: unknown) => new Date(Number(ts) * 1000 || Date.now());
const e164 = (waId: string) => (waId.startsWith('+') ? waId : `+${waId}`);

interface MetaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  context?: { id?: string };
}
interface MetaStatus {
  id: string;
  status: string;
  timestamp?: string;
  biz_opaque_callback_data?: string;
  errors?: { code?: number | string; title?: string }[];
}

/** Parses a WhatsApp Business Account webhook into items; unknown shapes are skipped, never thrown. */
export function parseMetaWebhook(body: unknown): WebhookItem[] {
  const items: WebhookItem[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return items;
  for (const entry of entries as { changes?: { field?: string; value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'message_template_status_update') {
        items.push({
          type: 'template_status',
          externalId: `${String(v.message_template_id)}:${String(v.event)}:${String(v.message_template_language)}`,
          name: String(v.message_template_name ?? ''),
          language: String(v.message_template_language ?? ''),
          event: String(v.event ?? ''),
          reason: typeof v.reason === 'string' && v.reason !== 'NONE' ? v.reason : undefined,
        });
        continue;
      }
      if (change.field !== 'messages') continue;
      for (const s of (v.statuses as MetaStatus[] | undefined) ?? []) {
        if (!s.id || !STATUSES.has(s.status as DeliveryStatus)) continue;
        const err = s.errors?.[0];
        items.push({
          type: 'status',
          providerMessageId: s.id,
          status: s.status as DeliveryStatus,
          at: asDate(s.timestamp),
          callbackRef: s.biz_opaque_callback_data || undefined,
          error: err ? { code: String(err.code ?? 'unknown'), title: String(err.title ?? '') } : undefined,
        });
      }
      for (const m of (v.messages as MetaMessage[] | undefined) ?? []) {
        if (!m.id || !m.from) continue;
        const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
        const inboundType =
          m.type === 'button' ? 'button' : m.type === 'interactive' ? 'interactive' : m.type === 'text' ? 'text' : ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type ?? '') ? 'media' : 'other';
        items.push({
          type: 'inbound',
          externalId: m.id,
          fromE164: e164(m.from),
          inboundType,
          payload: m.button?.payload ?? reply?.id,
          text: m.text?.body ?? m.button?.text ?? reply?.title,
          contextId: m.context?.id,
          at: asDate(m.timestamp),
          raw: m,
        });
      }
    }
  }
  return items;
}
