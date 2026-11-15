-- E04 Guest list and import (GST). Design: docs/architecture/04-gst.md
-- Builds on 000-core.sql (and nothing from 03-set.sql). Adds columns to parties, guests, guest_groups;
-- new tables: import_jobs, import_rows, guest_duplicate_dismissals.

-- ── parties ───────────────────────────────────────────────────────────────────
ALTER TABLE parties
  ADD COLUMN city           text,
  ADD COLUMN notes          text,                              -- host-only
  ADD COLUMN source         text NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual','import_file','import_sheet','contacts')),
  ADD COLUMN import_job_id  uuid,                              -- FK added below (table created later)
  ADD COLUMN merged_into_party_id uuid REFERENCES parties(id),  -- set when soft-deleted by a merge
  ADD COLUMN updated_by     uuid REFERENCES users(id),
  ADD CONSTRAINT parties_plus_ones_range CHECK (plus_ones_allowed BETWEEN 0 AND 20);

-- Host list: parties of one wedding sorted by label, keyset-paginated on (lower(label), id).
CREATE INDEX parties_wedding_label_idx ON parties (wedding_id, lower(label), id) WHERE deleted_at IS NULL;
CREATE INDEX parties_label_trgm_idx ON parties USING gin (label gin_trgm_ops);

-- ── guests ────────────────────────────────────────────────────────────────────
ALTER TABLE guests
  ADD COLUMN phone_raw      text,                              -- as typed/imported, kept for host to fix invalid numbers
  ADD COLUMN phone_status   text NOT NULL DEFAULT 'missing'
                            CHECK (phone_status IN ('valid','invalid','missing','landline')),
  ADD COLUMN relation       text,                              -- "Mama ji", "College friend"
  ADD COLUMN notes          text,                              -- host-only
  ADD COLUMN merged_into_guest_id uuid REFERENCES guests(id),
  ADD COLUMN updated_by     uuid REFERENCES users(id),
  ADD CONSTRAINT guests_phone_e164_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT guests_phone_status_consistent CHECK (
    (phone_status IN ('valid','landline') AND phone_e164 IS NOT NULL)
    OR (phone_status IN ('invalid','missing') AND phone_e164 IS NULL)
  );

-- Search by name within a wedding (core has a global trigram index on full_name; a wedding-scoped
-- composite keeps the dedupe self-join and search inside one tenant cheap).
CREATE INDEX guests_wedding_live_idx ON guests (wedding_id, party_id) WHERE deleted_at IS NULL;
-- "Invalid / missing phone" filter and the fix-up queue.
CREATE INDEX guests_wedding_phone_status_idx ON guests (wedding_id, phone_status)
  WHERE deleted_at IS NULL AND phone_status <> 'valid';

-- ── groups ────────────────────────────────────────────────────────────────────
ALTER TABLE guest_groups
  ADD COLUMN colour      text CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN sort_order  int NOT NULL DEFAULT 0;
-- One built-in group per system_key per wedding.
CREATE UNIQUE INDEX guest_groups_system_key_uq ON guest_groups (wedding_id, system_key) WHERE system_key IS NOT NULL;

-- ── Imports (GST-02, GST-03, GST-08) ──────────────────────────────────────────
CREATE TABLE import_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('xlsx','csv','google_sheet','contacts')),
  file_media_id   uuid REFERENCES media_objects(id) ON DELETE SET NULL,  -- xlsx/csv upload (kind 'other', delete_after 7 d)
  sheet_id        text,                                   -- Google Sheet id (never the full URL with tokens)
  sheet_gid       text,
  status          text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
                    'uploaded','parsing','mapping','validating','preview','committing','done','failed','cancelled')),
  headers         jsonb,                                  -- ["Name","Mobile","Side",...]
  sheet_name      text,                                   -- chosen worksheet for xlsx
  mapping         jsonb,                                  -- validated by ImportMappingSchema (Zod)
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {total, ok, warnings, errors, duplicates, imported, skipped}
  error_code      text,                                   -- GST_IMPORT_TOO_MANY_ROWS, GST_SHEET_NOT_PUBLIC, ...
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz,
  purge_after     timestamptz NOT NULL DEFAULT now() + interval '30 days',  -- rows + file deleted by retention job
  CHECK ((source = 'google_sheet') = (sheet_id IS NOT NULL))
);
CREATE INDEX import_jobs_wedding_idx ON import_jobs (wedding_id, created_at DESC);
CREATE INDEX import_jobs_purge_idx ON import_jobs (purge_after);
-- One import in flight per wedding (keeps dedupe against "existing guests" coherent).
CREATE UNIQUE INDEX import_jobs_one_active_uq ON import_jobs (wedding_id)
  WHERE status IN ('parsing','validating','committing');

ALTER TABLE parties
  ADD CONSTRAINT parties_import_job_fk FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE SET NULL;

CREATE TABLE import_rows (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_job_id   uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  row_number      int NOT NULL,                           -- 1-based row in the source sheet (header = row 1)
  party_key       text,                                   -- rows sharing a key become one party
  raw             jsonb NOT NULL,                         -- {"Name":"...", "Mobile":"..."} as read
  normalized      jsonb,                                  -- {fullName, phoneE164, phoneStatus, groups[], ...}
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ok','warning','error','duplicate')),
  issues          jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{"field":"phone","code":"PHONE_INVALID"}]
  match_guest_id  uuid REFERENCES guests(id) ON DELETE SET NULL,
  match_kind      text CHECK (match_kind IN ('phone','name','in_file')),
  action          text NOT NULL DEFAULT 'create' CHECK (action IN ('create','merge','skip')),
  result          text CHECK (result IN ('imported','merged','skipped','failed')),
  result_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  UNIQUE (import_job_id, row_number)
);
-- Preview paging and "show only errors/duplicates" tabs.
CREATE INDEX import_rows_job_status_idx ON import_rows (import_job_id, status, row_number);
-- Resumable commit: rows not yet applied.
CREATE INDEX import_rows_job_pending_idx ON import_rows (import_job_id, row_number) WHERE result IS NULL;

-- ── Dedupe (GST-05) ───────────────────────────────────────────────────────────
-- Pairs a host said "not a duplicate"; stored with guest_a < guest_b.
CREATE TABLE guest_duplicate_dismissals (
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_a       uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  guest_b       uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  dismissed_by  uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wedding_id, guest_a, guest_b),
  CHECK (guest_a < guest_b)
);
