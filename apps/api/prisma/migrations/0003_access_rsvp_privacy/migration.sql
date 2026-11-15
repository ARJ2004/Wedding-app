-- From docs/architecture/sql/05-acc.sql + 06-rsv.sql + 14-prv.sql (S4: guest access, RSVP, privacy). Reviewed DDL is the source of truth.
-- E05 Guest access, identity and consent (ACC). Design: docs/architecture/05-acc.md
-- Depends on: 000-core.sql only. Owning module: apps/api/src/modules/access.
-- Reuses (not redefined here):
--   refresh_tokens (01-fnd.sql)  audience='guest', family_id = guest_devices.id, device_id = install id
--   consents + privacy_notices (core + 14-prv.sql, PRV owns writes; ACC calls privacy.recordConsent())
--   push_devices.device_id (25-app.sql)   parties.checkin_code (09-arr.sql, shown by GH-07)
-- Personal data here: HMAC'd phone/IP fingerprints only. No raw OTPs, tokens, phones or IPs.

-- ── Party link (ACC-01) ───────────────────────────────────────────────────────
-- token = base64url(first 16 bytes of HMAC-SHA256(LINK_TOKEN_KEY, 'link:v1:' || party_id || ':' || link_version))
-- Only sha256(token) is stored (core parties.link_token_hash). Rotate = link_version + 1, new hash.
-- Revoke without a new link = hash set to NULL and link_revoked_at set.
ALTER TABLE parties
  ADD COLUMN link_version    int NOT NULL DEFAULT 1 CHECK (link_version >= 1),
  ADD COLUMN link_revoked_at timestamptz,
  ADD CONSTRAINT parties_link_revoked_no_hash CHECK (link_revoked_at IS NULL OR link_token_hash IS NULL);

-- ── Guest devices: one verified app install or browser per party (ACC-02, ACC-03) ──
-- The refresh-token family for this device is refresh_tokens.family_id = guest_devices.id.
CREATE TABLE guest_devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id          uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  install_id        text NOT NULL CHECK (length(install_id) BETWEEN 16 AND 64), -- = refresh_tokens.device_id (Keychain id, or web cookie id)
  platform          text NOT NULL CHECK (platform IN ('android','ios','web')),
  app_version       text,
  client_summary    text CHECK (length(client_summary) <= 80),   -- "Android 10 · 1.4.0" / "Chrome 120 Android"; never the raw UA
  verified_guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,  -- whose phone received the OTP
  active_guest_id   uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,  -- member currently selected on a shared phone
  verified_at       timestamptz NOT NULL DEFAULT now(),
  trusted_until     timestamptz NOT NULL,                                   -- verified_at + 90 days; refresh never extends past it
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoke_reason     text CHECK (revoke_reason IN ('guest_logout','host_revoked','link_rotated','refresh_reuse',
                                                  'expired','guest_deleted','consent_withdrawn','replaced')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (trusted_until > verified_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX guest_devices_live_uq     ON guest_devices (party_id, install_id) WHERE revoked_at IS NULL;
CREATE INDEX guest_devices_wedding_party_idx  ON guest_devices (wedding_id, party_id) WHERE revoked_at IS NULL;
CREATE INDEX guest_devices_trusted_until_idx  ON guest_devices (trusted_until) WHERE revoked_at IS NULL;  -- expiry sweep
CREATE INDEX guest_devices_guest_idx          ON guest_devices (verified_guest_id);                      -- guest deletion

-- ── OTP challenges (ACC-02) ───────────────────────────────────────────────────
CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,   -- owner of the phone the code went to
  install_id    text NOT NULL CHECK (length(install_id) BETWEEN 16 AND 64), -- code only valid for the install that asked
  platform      text NOT NULL CHECK (platform IN ('android','ios','web')),
  phone_hmac    bytea NOT NULL CHECK (length(phone_hmac) = 32),         -- HMAC(PII_HASH_KEY, phone_e164): per-phone limits across weddings
  ip_hmac       bytea CHECK (length(ip_hmac) = 32),                     -- HMAC(PII_HASH_KEY, client ip): abuse analysis
  channel       text NOT NULL CHECK (channel IN ('whatsapp','sms','dev')),
  code_hmac     bytea NOT NULL CHECK (length(code_hmac) = 32),          -- HMAC(OTP_PEPPER, id || code)
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','verified','failed','expired','superseded')),
  delivery_id   uuid,                                                   -- MSG sendOtp() result (07-msg owns deliveries; no FK across epics)
  expires_at    timestamptz NOT NULL,                                   -- created_at + 10 min
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX otp_party_recent_idx ON otp_challenges (party_id, created_at DESC);     -- per-party send limits
CREATE INDEX otp_phone_recent_idx ON otp_challenges (phone_hmac, created_at DESC);   -- per-phone send limits (cross-wedding)
CREATE INDEX otp_created_brin     ON otp_challenges USING brin (created_at);          -- 30-day purge, abuse scan

-- ── Durable lockout per party (ACC-05). Per-IP limits stay in FND's rate-limit helper + Nginx. ──
CREATE TABLE party_auth_state (
  party_id          uuid PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  failed_verifies   int NOT NULL DEFAULT 0 CHECK (failed_verifies >= 0),  -- wrong codes in the current 1 h window
  window_started_at timestamptz,
  locked_until      timestamptz,
  lock_count        int NOT NULL DEFAULT 0 CHECK (lock_count >= 0),      -- 1st lock 1 h; 2nd+ 24 h and host alerted
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX party_auth_locked_idx ON party_auth_state (wedding_id, locked_until) WHERE locked_until IS NOT NULL;

-- E06 RSVP (RSV). Design: docs/architecture/06-rsv.md
-- Depends on: 000-core.sql, 03-set.sql (events.deleted_at, party_invited_events view, party_groups_group_idx).
-- Owning module: apps/api/src/modules/rsvp.
-- "Invited" = party_invited_events (SET) x live guests of the party. "Pending" = invited and no rsvps row.
-- Plus-ones are ordinary guests rows (is_plus_one = true) created through GST's addPlusOne(); they follow
-- their party's invitations, so every count below is one row per person.

-- Per-event RSVP window. Edited in SET's event form (SET writes events; RSV reads).
ALTER TABLE events
  ADD COLUMN rsvp_enabled   boolean NOT NULL DEFAULT true,   -- false: on the schedule, no RSVP asked (e.g. Vidaai)
  ADD COLUMN rsvp_closes_at timestamptz;                     -- guests can't change after this; hosts still can

CREATE TABLE rsvps (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id            uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id              uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  party_id              uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  guest_id              uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  status                text NOT NULL CHECK (status IN ('attending','declined','maybe')),
  source                text NOT NULL CHECK (source IN ('app','lite_web','whatsapp','host','import')),
  responded_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,   -- shared phone: the selected member
  responded_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,    -- host on behalf (RSV-05)
  host_note             text CHECK (length(host_note) <= 280),           -- "Took this on the phone with Mamaji"
  responded_at          timestamptz NOT NULL DEFAULT now(),              -- first answer (chase logic, "replied in N days")
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, guest_id),
  CHECK (responded_by_guest_id IS NULL OR responded_by_user_id IS NULL),
  CHECK (source <> 'host' OR responded_by_user_id IS NOT NULL)
);
-- Headcount and host list for one wedding; INCLUDE keeps the aggregate index-only.
CREATE INDEX rsvps_headcount_idx ON rsvps (wedding_id, event_id) INCLUDE (guest_id, status);
CREATE INDEX rsvps_party_idx     ON rsvps (party_id, event_id);
CREATE INDEX rsvps_guest_idx     ON rsvps (guest_id);

-- Diet belongs to the person, not the event. Allergies are health-adjacent: purged at wedding end + 30 days (PRV-03).
CREATE TABLE guest_dietary (
  guest_id    uuid PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  diet        text CHECK (diet IN ('veg','jain','vegan','eggetarian','non_veg')),
  allergies   text[] NOT NULL DEFAULT '{}'
              CHECK (allergies <@ ARRAY['nuts','gluten','dairy','shellfish','egg','soy','other']::text[]),
  notes       text CHECK (length(notes) <= 280),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_dietary_wedding_idx ON guest_dietary (wedding_id) INCLUDE (guest_id, diet);

-- Each "chase non-responders" run (RSV-04): audience snapshot and the MSG message that carried it.
CREATE TABLE rsvp_chase_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_ids        uuid[] NOT NULL CHECK (cardinality(event_ids) BETWEEN 1 AND 20),
  no_reply_days    int NOT NULL CHECK (no_reply_days BETWEEN 0 AND 60),
  party_ids        uuid[] NOT NULL,
  message_id       uuid,                                       -- messages.id (07-msg); no FK across epics
  idempotency_key  text NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, idempotency_key)
);
CREATE INDEX rsvp_chase_runs_wedding_idx ON rsvp_chase_runs (wedding_id, created_at DESC);

-- E14 Privacy and compliance (PRV). Design: docs/architecture/14-prv.md
-- Builds on 000-core.sql only. Owning module: apps/api/src/modules/privacy.
-- Ledger-style tables (data_requests, erasure_ledger, retention_runs) deliberately hold
-- only ids and counts, never names/phones, and have no FK to guests/weddings so they
-- outlive the data they describe.

-- ── Platform staff (Mehfil employees: support, ops) ─────────────────────────
-- Needed by PRV (process/oversee data requests) and OPS (internal dashboard, on-call).
-- Not a wedding role: never grants access to wedding content through /v1/weddings/*.
CREATE TABLE platform_staff (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  staff_role    text NOT NULL CHECK (staff_role IN ('support','ops','admin')),
  granted_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Privacy notices (versioned) ─────────────────────────────────────────────
CREATE TABLE privacy_notices (
  version            text PRIMARY KEY CHECK (version ~ '^(guest|host)-[0-9]{4}\.[0-9]+$'),  -- "guest-2027.1"
  audience           text NOT NULL CHECK (audience IN ('guest','host')),
  purposes           text[] NOT NULL,             -- purposes this notice describes
  changes_summary    text,                        -- shown when re-consent is asked
  requires_reconsent boolean NOT NULL DEFAULT false,
  effective_from     timestamptz NOT NULL,
  published_at       timestamptz,                 -- null = draft
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (purposes <@ ARRAY['core','photos','face_match','id_documents','marketing']::text[]),
  CHECK (split_part(version, '-', 1) = audience)
);
CREATE INDEX privacy_notices_current_idx ON privacy_notices (audience, effective_from DESC)
  WHERE published_at IS NOT NULL;

CREATE TABLE privacy_notice_texts (
  version     text NOT NULL REFERENCES privacy_notices(version),
  locale      text NOT NULL,                      -- 'en', 'hi', 'kn'
  title       text NOT NULL,
  body_md     text NOT NULL,                      -- rendered by app, lite web and /privacy
  sha256      bytea NOT NULL,                     -- hash of body_md, proves what was shown
  PRIMARY KEY (version, locale)
);

-- ── Consents (core table; PRV owns writes) ──────────────────────────────────
ALTER TABLE consents
  ADD COLUMN source text NOT NULL DEFAULT 'guest_app'
    CHECK (source IN ('guest_app','lite_web','whatsapp','host_recorded')),
  ADD COLUMN locale text NOT NULL DEFAULT 'en',
  ADD COLUMN recorded_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL, -- party primary consenting for a child
  ADD COLUMN withdrawn_source text
    CHECK (withdrawn_source IN ('guest_app','lite_web','whatsapp','support','erasure')),
  ADD CONSTRAINT consents_notice_fk FOREIGN KEY (notice_version) REFERENCES privacy_notices(version);

-- At most one active grant per guest and purpose; re-grant after withdrawal is a new row (history).
CREATE UNIQUE INDEX consents_one_active ON consents (guest_id, purpose) WHERE withdrawn_at IS NULL;
-- Host summary ("42 guests opted in to photos") and module gating per wedding.
CREATE INDEX consents_wedding_purpose_idx ON consents (wedding_id, purpose) WHERE withdrawn_at IS NULL;

-- Host/staff acceptance of the host notice + terms (users are not in consents).
CREATE TABLE user_policy_acceptances (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notice_version text NOT NULL REFERENCES privacy_notices(version),
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notice_version)
);

-- ── Weddings: retention and deletion state ──────────────────────────────────
ALTER TABLE weddings
  ADD COLUMN retention_extended_until timestamptz,    -- set by BIL-04 extended photo storage
  ADD COLUMN deletion_requested_at    timestamptz,    -- owner asked to delete the wedding
  ADD COLUMN purge_after              timestamptz,    -- when the whole wedding is purged
  ADD COLUMN purged_at                timestamptz;    -- row kept as a PII-free tombstone (invoices, ledger)
CREATE INDEX weddings_purge_due_idx ON weddings (purge_after) WHERE purged_at IS NULL AND purge_after IS NOT NULL;

-- Per-wedding schedule of class-level expiries ("tickets deleted on 12 Apr").
-- Rows (re)computed from packages/domain retention policy on wedding create, date change, plan change.
CREATE TABLE wedding_retention_state (
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  data_class  text NOT NULL CHECK (data_class IN (
                'tickets','id_documents','face_data','travel','rooms_pickups',
                'photos','exports','message_content','guest_list','audit_log')),
  expires_at  timestamptz NOT NULL,
  done_at     timestamptz,
  last_run_id uuid,
  PRIMARY KEY (wedding_id, data_class)
);
CREATE INDEX wedding_retention_due_idx ON wedding_retention_state (expires_at) WHERE done_at IS NULL;

-- ── Data subject requests (export / erasure) ────────────────────────────────
CREATE TABLE data_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id        uuid,                         -- no FK: request record outlives the wedding
  kind              text NOT NULL CHECK (kind IN ('export','erasure')),
  scope             text NOT NULL CHECK (scope IN ('guest','party','user','wedding')),
  subject_id        uuid NOT NULL,                -- guests.id / parties.id / users.id / weddings.id
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('guest','user','staff','system')),
  requested_by_id   uuid,
  channel           text NOT NULL CHECK (channel IN ('app','lite_web','web_form','host','support','retention')),
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('verifying','scheduled','running','completed','failed','cancelled','rejected')),
  not_before        timestamptz NOT NULL DEFAULT now(),   -- cooling-off / undo window
  due_at            timestamptz NOT NULL,                 -- received + 7 days (SLA)
  started_at        timestamptz,
  completed_at      timestamptz,
  contact_hash      bytea,                        -- web_form only: sha256(normalised phone/email) for verification
  export_s3_key     text,                         -- exports bucket; object expires after 7 days
  export_expires_at timestamptz,
  rejection_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'user') = (wedding_id IS NULL)),
  CHECK (kind = 'export' OR export_s3_key IS NULL)
);
CREATE UNIQUE INDEX data_requests_one_open ON data_requests (kind, scope, subject_id)
  WHERE status IN ('verifying','scheduled','running');
CREATE INDEX data_requests_wedding_idx ON data_requests (wedding_id, created_at DESC);
CREATE INDEX data_requests_runnable_idx ON data_requests (not_before) WHERE status = 'scheduled';
CREATE INDEX data_requests_sla_idx ON data_requests (due_at) WHERE status IN ('verifying','scheduled','running','failed');

-- One row per module per request: the ordered purge/export across PurgeParticipants.
CREATE TABLE data_request_steps (
  request_id  uuid NOT NULL REFERENCES data_requests(id) ON DELETE CASCADE,
  module      text NOT NULL,                       -- 'face','idv','cam',...,'gst'
  seq         int  NOT NULL,                       -- PurgeParticipant.order
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  attempts    int  NOT NULL DEFAULT 0,
  result      jsonb,                               -- counts only: {"rows_deleted":{"rsvps":4},"s3_keys":2}
  error       text,                                -- error code + message, no PII
  started_at  timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (request_id, module),
  UNIQUE (request_id, seq)
);

-- Append-only record of every erasure (request, host delete, retention, wedding purge).
-- Mirrored to S3 (prv-ledger bucket) so it can be replayed after a backup restore.
CREATE TABLE erasure_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   uuid REFERENCES data_requests(id) ON DELETE SET NULL,
  wedding_id   uuid,
  scope        text NOT NULL CHECK (scope IN ('guest','party','user','wedding','data_class','media')),
  subject_id   uuid,                               -- null for data_class scope
  data_classes text[] NOT NULL DEFAULT '{}',
  reason       text NOT NULL CHECK (reason IN ('data_request','host_delete','retention','consent_withdrawn','wedding_purge')),
  erased_at    timestamptz NOT NULL DEFAULT now(),
  mirrored_at  timestamptz
);
CREATE INDEX erasure_ledger_erased_idx ON erasure_ledger (erased_at);
CREATE INDEX erasure_ledger_unmirrored_idx ON erasure_ledger (id) WHERE mirrored_at IS NULL;

-- ── Retention job runs ──────────────────────────────────────────────────────
CREATE TABLE retention_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job             text NOT NULL CHECK (job IN ('media_expiry','class_expiry','wedding_purge','recompute','ledger_replay')),
  dry_run         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  weddings_touched int NOT NULL DEFAULT 0,
  objects_deleted int NOT NULL DEFAULT 0,
  bytes_freed     bigint NOT NULL DEFAULT 0,
  rows_deleted    int NOT NULL DEFAULT 0,
  errors          int NOT NULL DEFAULT 0,
  details         jsonb                            -- per-wedding counts, error codes; no PII
);
CREATE INDEX retention_runs_job_idx ON retention_runs (job, started_at DESC);

-- ── Indexes on core tables needed by purge ──────────────────────────────────
-- Audit rows about a guest are scrubbed on erasure using 10-rol.sql's audit_wedding_entity_idx,
-- redacted_at column and the `SET LOCAL mehfil.audit_maintenance = 'on'` guard (no index added here).
-- Find a guest's own uploads on erasure/export.
CREATE INDEX media_uploader_guest_idx ON media_objects (uploaded_by_guest_id) WHERE uploaded_by_guest_id IS NOT NULL;

-- First guest privacy notice (PRV-01). DRAFT wording pending counsel review (VAL-13); a new
-- version with requires_reconsent=true replaces it when the reviewed text is ready.
INSERT INTO privacy_notices (version, audience, purposes, changes_summary, requires_reconsent, effective_from, published_at)
VALUES ('guest-2027.1', 'guest', ARRAY['core','photos','face_match','id_documents','marketing'], NULL, false, '2026-11-01', '2026-11-01');
INSERT INTO privacy_notice_texts (version, locale, title, body_md, sha256)
VALUES ('guest-2027.1', 'en', 'How we use your details',
'The couple''s family uses Mehfil to share the wedding schedule with you and plan travel and stays.

**What we keep:** your name, phone number, your RSVP, travel plans you add, and photos you take with the wedding camera.

**Who sees it:** the hosts and their wedding planner. Desk staff at the venue see names only. Other guests never see your phone number or travel.

**How long:** until shortly after the wedding; ID copies are deleted within a week after it.

**Your choices:** you can ask the hosts to correct or delete your details at any time, or withdraw this consent in the app under Me → Privacy.',
decode('00', 'hex'));
UPDATE privacy_notice_texts SET sha256 = sha256(convert_to(body_md, 'UTF8')) WHERE version = 'guest-2027.1';
