-- MSG (S5): messaging tables from docs/architecture/sql/07-msg.sql.
-- E07 Messaging and announcements (MSG). Design: docs/architecture/07-msg.md
-- References 000-core.sql only. Owning module: apps/api/src/modules/messaging.
-- Phone numbers are never stored here in clear: to_hash / phone_hash = HMAC-SHA256(PHONE_HASH_KEY, e164).

-- ── Template catalogue (platform-wide; templates belong to Mehfil's sender, not to a wedding) ──
CREATE TABLE message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,              -- 'invite', 'rsvp_reminder', 'announcement_text', 'otp', ...
  purpose       text NOT NULL CHECK (purpose IN ('invite','rsvp','reminder','announcement','otp','travel','arrival','confirmation','system')),
  category      text NOT NULL CHECK (category IN ('utility','authentication','marketing')),
  host_selectable boolean NOT NULL DEFAULT false,  -- shown in the composer
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per (template, channel, language). WhatsApp approval and DLT registration are per language.
CREATE TABLE message_template_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('whatsapp','sms','push')),
  language            text NOT NULL CHECK (language IN ('en','hi','kn')),
  provider            text NOT NULL,                -- 'meta_cloud', 'gupshup', 'msg91', 'fcm', 'log'
  provider_template_name text,                      -- WhatsApp template name; null for push
  dlt_template_id     text,                         -- TRAI DLT template id (sms only)
  body                text NOT NULL,                -- body with {{1}}.. placeholders (sms: {#var#})
  params_schema       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered param names + max lengths
  buttons             jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type:'quick_reply', action:'rsv.attend'}, {type:'url'}]
  header_kind         text CHECK (header_kind IN ('none','text','image','document')),
  approval_status     text NOT NULL DEFAULT 'draft'
                      CHECK (approval_status IN ('draft','submitted','approved','rejected','paused','disabled')),
  rejection_reason    text,
  status_synced_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, channel, language, provider),
  CHECK (channel <> 'sms' OR dlt_template_id IS NOT NULL OR approval_status <> 'approved')
);
CREATE INDEX template_variants_approved_idx ON message_template_variants (channel, language) WHERE approval_status = 'approved';

-- ── Messages (an announcement, an invite wave, a reminder, an OTP, a confirmation) ──
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('announcement','invite','rsvp_reminder','travel_reminder',
                                                 'pickup_notice','rsvp_confirmation','arrival_ack','otp','system')),
  template_id      uuid REFERENCES message_templates(id),
  title            text,                             -- push title / inbox heading
  body_text        text,                             -- host-written text (source language)
  source_language  text NOT NULL DEFAULT 'en' CHECK (source_language IN ('en','hi','kn')),
  media_id         uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  link_target      text CHECK (link_target IN ('none','guest_home','schedule','travel','rsvp','gallery')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- template params common to all recipients
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"event_ids":[...]} for RSVP button replies
  audience         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"groups":[],"events":[],"rsvp":{...},"guest_ids":[],"party_ids":[]}
  channels         text[] NOT NULL DEFAULT ARRAY['whatsapp','push'],
  sms_fallback     boolean NOT NULL DEFAULT true,
  fallback_after_minutes int NOT NULL DEFAULT 10 CHECK (fallback_after_minutes BETWEEN 1 AND 120),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),  -- high = OTP / confirmations
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','resolving','sending','sent','cancelled','failed')),
  scheduled_at     timestamptz,
  version          int NOT NULL DEFAULT 1,           -- bumped on edit; scheduled job checks it
  idempotency_key  text,
  recipient_count  int,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- denormalised counts per channel/status, refreshed by worker
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_module text,                            -- 'rsv', 'trv', 'acc' when created by another module
  sending_started_at timestamptz,
  sent_at          timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE UNIQUE INDEX messages_idem_idx ON messages (wedding_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_wedding_list_idx ON messages (wedding_id, created_at DESC, id);
CREATE INDEX messages_scheduled_idx ON messages (scheduled_at) WHERE status = 'scheduled';

-- Audience resolved at send time. One row per guest; feeds the guest inbox (GH-06).
CREATE TABLE message_recipients (
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  language      text NOT NULL CHECK (language IN ('en','hi','kn')),
  reply_ref     text NOT NULL UNIQUE,              -- random 80-bit base32; carried in button payloads
  suppressed_reason text CHECK (suppressed_reason IN ('opted_out','no_phone','duplicate_phone','quota','no_template')),
  read_in_app_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, guest_id)
);
CREATE INDEX message_recipients_inbox_idx ON message_recipients (guest_id, created_at DESC);
CREATE INDEX message_recipients_wedding_idx ON message_recipients (wedding_id, created_at);

-- One row per (message, guest, channel): the idempotency unit for sending.
CREATE TABLE message_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id          uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  message_id          uuid NOT NULL,
  guest_id            uuid NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('whatsapp','sms','push','log')),
  provider            text NOT NULL,
  variant_id          uuid REFERENCES message_template_variants(id),
  to_hash             bytea,                         -- HMAC of the destination phone; null for push
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sending','sent','delivered','read','failed','unknown','suppressed','cancelled')),
  status_rank         smallint NOT NULL DEFAULT 0,   -- queued 0, sending 1, sent 2, delivered 3, read 4; webhooks never lower it
  provider_message_id text,
  attempts            smallint NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  error_code          text,
  error_detail        text,
  billable_units      smallint NOT NULL DEFAULT 0,   -- WhatsApp 1 per message; SMS = segments; push 0
  is_fallback         boolean NOT NULL DEFAULT false,
  fallback_due_at     timestamptz,                   -- whatsapp only: when to try SMS if not delivered
  fallback_done       boolean NOT NULL DEFAULT false,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  UNIQUE (message_id, guest_id, channel),
  FOREIGN KEY (message_id, guest_id) REFERENCES message_recipients(message_id, guest_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX deliveries_provider_msg_idx ON message_deliveries (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX deliveries_message_status_idx ON message_deliveries (message_id, status);
CREATE INDEX deliveries_fallback_due_idx ON message_deliveries (fallback_due_at)
  WHERE channel = 'whatsapp' AND NOT fallback_done AND status IN ('queued','sending','sent','failed','unknown');
CREATE INDEX deliveries_stuck_idx ON message_deliveries (claimed_at) WHERE status = 'sending';
CREATE INDEX deliveries_to_hash_idx ON message_deliveries (to_hash, queued_at DESC) WHERE to_hash IS NOT NULL;
CREATE INDEX deliveries_wedding_idx ON message_deliveries (wedding_id, queued_at);

-- ── Inbound (user replies) and webhook events we could not apply inline ──────
CREATE TABLE messaging_webhook_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('inbound','status_unmatched','template_status','other')),
  external_id       text NOT NULL,                  -- provider's message/event id; dedupes retries
  wedding_id        uuid REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id          uuid REFERENCES guests(id) ON DELETE SET NULL,
  delivery_id       uuid REFERENCES message_deliveries(id) ON DELETE SET NULL,
  from_hash         bytea,
  inbound_type      text CHECK (inbound_type IN ('button','text','interactive','media','other')),
  action            text,                           -- decoded: 'rsv.attend', 'arr.landed', 'msg.stop', ...
  route_status      text NOT NULL DEFAULT 'pending'
                    CHECK (route_status IN ('pending','routed','ignored','unmatched','failed')),
  route_result      jsonb,
  payload           jsonb NOT NULL,                 -- raw body fragment; purged after 30 days
  attempts          smallint NOT NULL DEFAULT 0,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, kind, external_id)
);
CREATE INDEX webhook_events_pending_idx ON messaging_webhook_events (received_at) WHERE route_status = 'pending';
CREATE INDEX webhook_events_wedding_idx ON messaging_webhook_events (wedding_id, received_at DESC) WHERE wedding_id IS NOT NULL;

-- ── Opt-outs (global per phone and channel; honoured across weddings) ───────
CREATE TABLE messaging_opt_outs (
  phone_hash    bytea NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  source        text NOT NULL CHECK (source IN ('stop_keyword','button','guest_app','host_recorded','provider')),
  wedding_id    uuid REFERENCES weddings(id) ON DELETE SET NULL,   -- where it was received, for display only
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_hash, channel)
);

-- ── Quota metering per wedding ───────────────────────────────────────────────
CREATE TABLE message_quotas (
  wedding_id      uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  limit_units     int NOT NULL,                     -- from plan (BIL-01) or a pilot override
  reserved_units  int NOT NULL DEFAULT 0,           -- reserved by messages being sent
  used_units      int NOT NULL DEFAULT 0,           -- billable units accepted by providers
  warned_80_at    timestamptz,
  blocked_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_units >= 0 AND used_units >= 0)
);

-- ── Dev/test sink (LogSinkProvider). Config refuses MESSAGING_PROVIDER=log in production. ──
CREATE TABLE messaging_log_sink (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel       text NOT NULL,
  to_address    text NOT NULL,                     -- phone or FCM token (dev data only)
  template_key  text,
  language      text,
  rendered      text NOT NULL,
  payload       jsonb NOT NULL,
  provider_message_id text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Push devices: no changes here. push_devices is owned by the `devices` module (25-app.sql adds
-- locale, disabled_at, wedding_id and the guest/user indexes MSG-08 relies on). See 07-msg.md §12.
