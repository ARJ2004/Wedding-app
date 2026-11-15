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
