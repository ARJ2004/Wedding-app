-- E17 ID vault (IDV) — design: docs/architecture/17-idv.md
-- Owning module: apps/api/src/modules/idvault.
-- Objects live in a separate bucket (mehfil-<env>-idvault) encrypted with SSE-KMS under a
-- per-wedding AWS KMS key. Crypto-shredding = disable + schedule deletion of that key.
-- Depends on: 000-core.sql only.

-- One vault per wedding. ON DELETE RESTRICT is a deliberate interlock: a wedding cannot be
-- hard-deleted until the vault has been shredded and this row removed by the IDV PurgeParticipant
-- (wedding purge). After a normal retention shred the row stays with status 'shredded' (tombstone).
CREATE TABLE idv_vaults (
  wedding_id         uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','closed','shredding','shredded')),
  kms_key_arn        text UNIQUE,                         -- null until the first upload provisions the key
  kms_key_state      text NOT NULL DEFAULT 'none'
                     CHECK (kms_key_state IN ('none','enabled','disabled','pending_deletion')),
  delete_after_days  int  NOT NULL DEFAULT 3 CHECK (delete_after_days BETWEEN 3 AND 7),
  uploads_close_at   timestamptz,                         -- null = wedding end; guests cannot upload after
  extra_viewer_roles text[] NOT NULL DEFAULT '{}'         -- owner + co_host always; may add 'planner_member' only
                     CHECK (extra_viewer_roles <@ ARRAY['planner_member']::text[]),
  -- When to shred comes from PRV's wedding_retention_state(data_class='id_documents'), recomputed
  -- by PRV from weddings.ends_on + delete_after_days; not duplicated here.
  reminder_sent_at   timestamptz,                         -- owner told 24 h before shredding
  shred_started_at   timestamptz,
  shredded_at        timestamptz,
  shred_report       jsonb,                               -- {objectsDeleted, objectsRemaining:0, keyState, keyDeletionDate}
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idv_vaults_live_idx ON idv_vaults (status) WHERE status IN ('open','closed','shredding');

-- Named people (beyond the role defaults) the owner lets view IDs, e.g. a specific planner member.
-- Desk staff can never be granted (enforced in the service and by the permission matrix).
CREATE TABLE idv_access_grants (
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz,                                -- default: vault shred time
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wedding_id, user_id)
);

-- One row per uploaded image (front/back). Rows are tombstoned, never hard-deleted, so the
-- deletion record survives; the S3 object and media_objects row are what get deleted.
CREATE TABLE idv_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id            uuid NOT NULL REFERENCES idv_vaults(wedding_id) ON DELETE CASCADE,
  guest_id              uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE, -- the ID's owner
  media_id              uuid UNIQUE REFERENCES media_objects(id) ON DELETE SET NULL,
  doc_type              text NOT NULL CHECK (doc_type IN ('aadhaar_masked','aadhaar','passport','driving_licence','voter_id','other')),
  side                  text NOT NULL CHECK (side IN ('front','back','single')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','rejected','deleted')),
  consent_id            uuid NOT NULL REFERENCES consents(id),               -- purpose = 'id_documents', subject = guest_id
  uploaded_by_guest_id  uuid REFERENCES guests(id) ON DELETE SET NULL,        -- party primary may upload for members
  uploaded_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,         -- host uploading on behalf
  created_at            timestamptz NOT NULL DEFAULT now(),
  ready_at              timestamptz,
  deleted_at            timestamptz,
  deleted_reason        text CHECK (deleted_reason IN ('guest','host','replaced','retention','consent_withdrawn','guest_erasure','wedding_deleted','rejected')),
  CHECK ((uploaded_by_guest_id IS NULL) OR (uploaded_by_user_id IS NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
-- One live document per guest per side; replacing tombstones the old row first.
CREATE UNIQUE INDEX idv_documents_live_uq ON idv_documents (guest_id, side) WHERE status IN ('pending','ready');
CREATE INDEX idv_documents_wedding_idx ON idv_documents (wedding_id, status);

-- Every view and export download. Kept after the documents are shredded (accountability),
-- deleted with the wedding. No image data, no ID numbers.
CREATE TABLE idv_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES idv_documents(id) ON DELETE SET NULL,
  export_id     uuid,                                     -- FK added below
  guest_id      uuid REFERENCES guests(id) ON DELETE SET NULL, -- whose ID
  viewer_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  viewer_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL, -- guest viewing their own party's ID
  action        text NOT NULL CHECK (action IN ('view','export_download')),
  watermark_id  text NOT NULL,                            -- short code printed in the watermark; traces leaks to this row
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((viewer_user_id IS NULL) <> (viewer_guest_id IS NULL))
);
CREATE INDEX idv_access_log_doc_idx ON idv_access_log (document_id, created_at DESC);
CREATE INDEX idv_access_log_guest_idx ON idv_access_log (guest_id, created_at DESC);
CREATE INDEX idv_access_log_wedding_idx ON idv_access_log (wedding_id, created_at DESC);
CREATE UNIQUE INDEX idv_access_log_watermark_uq ON idv_access_log (watermark_id);

-- Hotel export (IDV-03): a watermarked PDF of selected guests, stored encrypted, short-lived.
CREATE TABLE idv_exports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id           uuid NOT NULL REFERENCES idv_vaults(wedding_id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  recipient_label      text NOT NULL CHECK (char_length(recipient_label) BETWEEN 1 AND 120), -- "Taj Lake Palace front desk"
  guest_ids            uuid[] NOT NULL CHECK (cardinality(guest_ids) BETWEEN 1 AND 500),
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','ready','failed','expired','deleted')),
  media_id             uuid UNIQUE REFERENCES media_objects(id) ON DELETE SET NULL,
  page_count           int,
  max_downloads        int NOT NULL DEFAULT 3 CHECK (max_downloads BETWEEN 1 AND 10),
  download_count       int NOT NULL DEFAULT 0,
  expires_at           timestamptz NOT NULL,              -- created_at + 24h
  created_at           timestamptz NOT NULL DEFAULT now(),
  ready_at             timestamptz,
  deleted_at           timestamptz
);
CREATE INDEX idv_exports_wedding_idx ON idv_exports (wedding_id, created_at DESC);
CREATE INDEX idv_exports_expiry_idx ON idv_exports (expires_at) WHERE status IN ('queued','building','ready');

ALTER TABLE idv_access_log
  ADD CONSTRAINT idv_access_log_export_fk FOREIGN KEY (export_id) REFERENCES idv_exports(id) ON DELETE SET NULL;
