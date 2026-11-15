-- From docs/architecture/sql/03-set.sql + 04-gst.sql + 10-rol.sql (S2: SET, GST, ROL). Reviewed DDL is the source of truth.
-- E03 Wedding setup (SET). Design: docs/architecture/03-set.md
-- Builds on 000-core.sql only. Adds columns to core tables; one new table (wedding_contacts); one view.

-- ── weddings: couple names, cities, cover photo, settings shape ───────────────
ALTER TABLE weddings
  ADD COLUMN partner_one_name text,                       -- "Ananya"; title stays the display name
  ADD COLUMN partner_two_name text,                       -- "Rohan"
  ADD COLUMN cities          text[] NOT NULL DEFAULT '{}', -- {"Udaipur","Delhi"}; free text, max 5 (API)
  ADD COLUMN cover_media_id  uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  ADD COLUMN settings_version int NOT NULL DEFAULT 1,      -- Zod schema version of weddings.settings
  ADD COLUMN updated_by      uuid REFERENCES users(id),
  ADD CONSTRAINT weddings_settings_is_object CHECK (jsonb_typeof(settings) = 'object'),
  ADD CONSTRAINT weddings_cities_max CHECK (cardinality(cities) <= 5);

-- ── events: soft delete (RSVPs hang off events), audit of who edited ──────────
ALTER TABLE events
  ADD COLUMN deleted_at  timestamptz,
  ADD COLUMN updated_by  uuid REFERENCES users(id),
  ADD CONSTRAINT events_end_after_start CHECK (ends_at IS NULL OR ends_at > starts_at);

-- Host schedule list and guest schedule: live events of one wedding in display order.
CREATE INDEX events_wedding_order_idx ON events (wedding_id, sort_order, starts_at)
  WHERE deleted_at IS NULL;

-- Guest schedule resolves "which events can my party see" from the group side.
CREATE INDEX event_groups_group_idx ON event_groups (group_id, event_id);
CREATE INDEX party_groups_group_idx ON party_groups (group_id, party_id);

-- ── venues: parking notes, city, Google place id (optional), edit tracking ────
ALTER TABLE venues
  ADD COLUMN city           text,
  ADD COLUMN parking_notes  text,
  ADD COLUMN google_place_id text,                        -- only when the pasted link carried one
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT venues_lat_range CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  ADD CONSTRAINT venues_lng_range CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  ADD CONSTRAINT venues_latlng_pair CHECK ((lat IS NULL) = (lng IS NULL));

-- ── Key contacts (SET-05): per-side helplines shown to guests ─────────────────
-- Deliberately guest-visible personal data: the host enters it for this purpose (notice in UI).
CREATE TABLE wedding_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  side          text NOT NULL DEFAULT 'both' CHECK (side IN ('bride','groom','both')),
  label         text NOT NULL,                            -- "Travel help", "Bride's brother"
  name          text NOT NULL,
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  has_whatsapp  boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wedding_contacts_wedding_idx ON wedding_contacts (wedding_id, sort_order);

-- ── Which events a party is invited to (SET-04) ───────────────────────────────
-- Single source of truth for RSV, GH, MSG targeting. Read-only; owned by the events module.
CREATE VIEW party_invited_events AS
SELECT p.wedding_id, p.id AS party_id, e.id AS event_id
FROM parties p
JOIN events e ON e.wedding_id = p.wedding_id AND e.deleted_at IS NULL
WHERE p.deleted_at IS NULL
  AND (
    e.visibility = 'all'
    OR EXISTS (
      SELECT 1 FROM event_groups eg
      JOIN party_groups pg ON pg.group_id = eg.group_id
      WHERE eg.event_id = e.id AND pg.party_id = p.id
    )
  );

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

-- E10 Roles, permissions and audit (ROL). Design: docs/architecture/10-rol.md
-- Builds on 000-core.sql only. New table: team_invitations. Adds columns/indexes/guards to
-- wedding_members, organization_members, organizations and audit_log.

-- ── Exactly one owner per wedding; transfer is a two-row update in one transaction ──
CREATE UNIQUE INDEX wedding_members_one_owner_uq ON wedding_members (wedding_id) WHERE role = 'owner';

ALTER TABLE wedding_members
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- "My weddings" for an org admin (implicit access) and team-seat listing.
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

ALTER TABLE organizations
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ── Team invitations (ROL-01, ROL-04) ─────────────────────────────────────────
-- An invitation targets a wedding role OR an organisation seat, never both.
-- Delivered as a link shared from the inviter's phone (share sheet → WhatsApp/email) and shown
-- in-app to any signed-in user whose verified Google email matches.
CREATE TABLE team_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid REFERENCES weddings(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  email            citext NOT NULL,
  role             text CHECK (role IN ('co_host','planner_member','desk_staff')),      -- wedding invites; owner only by transfer
  org_role         text CHECK (org_role IN ('org_admin','org_member')),                  -- org invites
  token_hash       bytea NOT NULL UNIQUE,                 -- sha256 of 128-bit token; token never stored
  invited_by       uuid NOT NULL REFERENCES users(id),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at      timestamptz,
  accepted_by      uuid REFERENCES users(id),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((wedding_id IS NULL) <> (organization_id IS NULL)),
  CHECK ((wedding_id IS NOT NULL) = (role IS NOT NULL)),
  CHECK ((organization_id IS NOT NULL) = (org_role IS NOT NULL)),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
-- At most one open invite per email per wedding / per org (re-invite = revoke + create).
CREATE UNIQUE INDEX team_invitations_open_wedding_uq ON team_invitations (wedding_id, email)
  WHERE wedding_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX team_invitations_open_org_uq ON team_invitations (organization_id, email)
  WHERE organization_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
-- "Invitations waiting for me" on sign-in.
CREATE INDEX team_invitations_email_open_idx ON team_invitations (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── Audit log (ROL-03) ────────────────────────────────────────────────────────
ALTER TABLE audit_log
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- org-level actions (seats)
  ADD COLUMN actor_role      text,                         -- role at the time: owner, desk_staff, guest, system
  ADD COLUMN actor_label     text,                         -- name snapshot so the viewer survives user deletion
  ADD COLUMN request_id      text,                         -- correlates with Pino logs / Sentry
  ADD COLUMN redacted_at     timestamptz;                  -- set when PRV-02 scrubs before/after for a deleted guest

-- Viewer filters (all keyset-paginated on id DESC within a wedding).
CREATE INDEX audit_wedding_id_idx     ON audit_log (wedding_id, id DESC);
CREATE INDEX audit_wedding_entity_idx ON audit_log (wedding_id, entity_type, entity_id, id DESC);
CREATE INDEX audit_wedding_actor_idx  ON audit_log (wedding_id, actor_id, id DESC);
CREATE INDEX audit_wedding_action_idx ON audit_log (wedding_id, action, id DESC);
CREATE INDEX audit_org_idx            ON audit_log (organization_id, id DESC) WHERE organization_id IS NOT NULL;

-- Append-only guard. UPDATE is allowed only to redact (PRV-02) and DELETE only for retention purges,
-- and both only when the transaction sets `SET LOCAL mehfil.audit_maintenance = 'on'`.
-- ON DELETE CASCADE from weddings runs under the purge job, which sets the flag.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('mehfil.audit_maintenance', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_log is append-only (%)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.action <> OLD.action OR NEW.created_at <> OLD.created_at
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
      RAISE EXCEPTION 'audit_log redaction may only change before/after/actor_label/redacted_at';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

