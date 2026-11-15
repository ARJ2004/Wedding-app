import type { IncomingHttpHeaders } from 'node:http';

/** Outcome of one provider call (07-msg §4). `retryable` drives send-one backoff in MSG-05. */
export type SendResult =
  | { ok: true; providerMessageId: string; billableUnits: number }
  | { ok: false; retryable: boolean; code: string; detail?: string };

export interface TemplateSendRequest {
  to: string; // E.164
  templateName: string;
  language: 'en' | 'hi' | 'kn';
  params: string[];
  headerMediaUrl?: string;
  /** Quick-reply payloads in button order, e.g. "rsv.attend|<reply_ref>". */
  buttonPayloads?: string[];
  /** Our delivery id; Meta echoes it back on status webhooks (biz_opaque_callback_data). */
  callbackRef: string;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type WebhookItem =
  | { type: 'status'; providerMessageId: string; status: DeliveryStatus; at: Date; callbackRef?: string; error?: { code: string; title: string } }
  | {
      type: 'inbound';
      externalId: string;
      fromE164: string;
      inboundType: 'button' | 'text' | 'interactive' | 'media' | 'other';
      /** Button / interactive reply payload, e.g. "rsv.attend|<reply_ref>". */
      payload?: string;
      text?: string;
      /** The WhatsApp id of our message this replies to. */
      contextId?: string;
      at: Date;
      raw: unknown;
    }
  | { type: 'template_status'; externalId: string; name: string; language: string; event: string; reason?: string };

export interface ProviderTemplateStatus {
  name: string;
  language: string;
  status: 'approved' | 'submitted' | 'rejected' | 'paused' | 'disabled';
  reason?: string;
}

export interface TemplateVariantDef {
  name: string;
  language: string;
  category: 'utility' | 'authentication' | 'marketing';
  body: string;
  /** Example values for each {{n}}; Meta requires them on submission. */
  examples: string[];
  quickReplies?: string[];
  headerKind?: 'none' | 'text' | 'image' | 'document';
}

/** WhatsApp provider port. Adapters: MetaCloudProvider (prod), LogSinkProvider (dev/test). */
export interface MessagingProvider {
  readonly channel: 'whatsapp';
  /** Stored on deliveries.provider and webhook events. */
  readonly name: string;
  sendTemplate(req: TemplateSendRequest): Promise<SendResult>;
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  parseWebhook(body: unknown): WebhookItem[];
  listTemplates(): Promise<ProviderTemplateStatus[]>;
  submitTemplate(v: TemplateVariantDef): Promise<void>;
}
