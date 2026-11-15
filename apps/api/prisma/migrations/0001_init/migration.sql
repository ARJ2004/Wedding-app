-- Generated from docs/architecture/sql/000-core.sql + 01-fnd.sql (FND-04). Reviewed DDL is the source of truth.
-- Mehfil core schema (owned by docs/architecture/00-overview.md).
-- Epic files (NN-<prefix>.sql) may reference these tables and ALTER them to add columns,
-- but may not redefine them. Apply order: 000-core.sql, then epic files in numeric order.
-- Conventions: uuid PKs (gen_random_uuid), timestamptz in UTC, snake_case, soft delete only where stated.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Accounts (hosts, planners, staff: Google SSO) ─────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    text UNIQUE NOT NULL,           -- "dev|<email>" for dev-bypass users
  email         citext UNIQUE NOT NULL,
  name          text,
  phone_e164    text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE organizations (                      -- planner agency, or a family's personal org
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('family','planner','venue')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role        text NOT NULL CHECK (org_role IN ('org_owner','org_admin','org_member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- ── Weddings ──────────────────────────────────────────────────────────────────
CREATE TABLE weddings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  title           text NOT NULL,                 -- "Ananya & Rohan"
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  plan            text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','essentials','complete','planner')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','ended','archived')),
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX weddings_org_idx ON weddings (organization_id) WHERE deleted_at IS NULL;

-- Team access per wedding. Role matrix lives in docs/architecture/10-rol.md.
CREATE TABLE wedding_members (
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','co_host','planner_member','desk_staff')),
  invited_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wedding_id, user_id)
);
CREATE INDEX wedding_members_user_idx ON wedding_members (user_id);

CREATE TABLE venues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name          text NOT NULL,
  address       text,
  lat           double precision,
  lng           double precision,
  maps_url      text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venues_wedding_idx ON venues (wedding_id);

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  venue_id      uuid REFERENCES venues(id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'custom'
                CHECK (kind IN ('haldi','mehendi','sangeet','baraat','pheras','reception','custom')),
  name          text NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  dress_code    text,
  notes         text,
  sort_order    int NOT NULL DEFAULT 0,
  visibility    text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','groups')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_wedding_idx ON events (wedding_id, starts_at);

-- ── Guests ────────────────────────────────────────────────────────────────────
CREATE TABLE guest_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name          text NOT NULL,
  system_key    text CHECK (system_key IN ('bride_side','groom_side','family','friends','vip')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, name)
);

-- A party is one invite: a household or a guest with plus-ones. It owns the private link.
CREATE TABLE parties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  label            text NOT NULL,                 -- "Sharma family"
  link_token_hash  bytea UNIQUE,                  -- sha256 of the 128-bit link token; token itself never stored
  link_rotated_at  timestamptz,
  plus_ones_allowed int NOT NULL DEFAULT 0,
  is_outstation    boolean NOT NULL DEFAULT false,
  preferred_language text NOT NULL DEFAULT 'en',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX parties_wedding_idx ON parties (wedding_id) WHERE deleted_at IS NULL;

CREATE TABLE guests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  is_primary    boolean NOT NULL DEFAULT false,
  full_name     text NOT NULL,
  phone_e164    text,                            -- normalised; null for children / plus-ones without phones
  email         citext,
  age_band      text CHECK (age_band IN ('child','adult','senior')),
  is_plus_one   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX guests_party_idx ON guests (party_id);
CREATE INDEX guests_wedding_phone_idx ON guests (wedding_id, phone_e164) WHERE deleted_at IS NULL;
CREATE INDEX guests_name_trgm_idx ON guests USING gin (full_name gin_trgm_ops);
CREATE UNIQUE INDEX guests_one_primary_per_party ON guests (party_id) WHERE is_primary AND deleted_at IS NULL;

CREATE TABLE party_groups (
  party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES guest_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (party_id, group_id)
);

-- Which groups see an event when events.visibility = 'groups'.
CREATE TABLE event_groups (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES guest_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, group_id)
);

-- ── Consent (DPDP) ────────────────────────────────────────────────────────────
CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('core','photos','face_match','id_documents','marketing')),
  notice_version text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE INDEX consents_guest_idx ON consents (guest_id, purpose);

-- ── Media (every S3 object the app knows about) ───────────────────────────────
CREATE TABLE media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('photo','ticket','id_document','selfie','video','export','cover','other')),
  s3_bucket     text NOT NULL,
  s3_key        text NOT NULL UNIQUE,
  content_type  text NOT NULL,
  byte_size     bigint,
  sha256        bytea,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','processed','rejected','deleted')),
  uploaded_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  uploaded_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  delete_after  timestamptz,                      -- retention; enforced by PRV jobs
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_wedding_kind_idx ON media_objects (wedding_id, kind, created_at DESC);
CREATE INDEX media_delete_after_idx ON media_objects (delete_after) WHERE delete_after IS NOT NULL AND status <> 'deleted';

-- ── Audit log ─────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id    uuid REFERENCES weddings(id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','guest','system')),
  actor_id      uuid,
  action        text NOT NULL,                    -- "guest.update", "rsvp.override", "idv.view"
  entity_type   text NOT NULL,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_wedding_idx ON audit_log (wedding_id, created_at DESC);

-- ── Push devices (FCM), for hosts and guests ──────────────────────────────────
CREATE TABLE push_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_id      uuid REFERENCES guests(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('android','ios')),
  fcm_token     text NOT NULL UNIQUE,
  app_version   text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (guest_id IS NULL))
);

-- E01 Foundations (FND). Design: docs/architecture/01-fnd.md
-- Depends on: 000-core.sql only.
-- Owning module per table:
--   refresh_tokens     → auth      (host sessions here; ACC reuses it for guest device sessions)
--   idempotency_keys   → common/idempotency
--   realtime_events    → common/realtime (written only through rt_publish())

-- ── Users: sign-in bookkeeping ────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN last_sign_in_at timestamptz;          -- set on every successful POST /v1/auth/google

-- ── Refresh tokens (rotating, hashed, one family per sign-in) ─────────────────
-- Same model as Expense-Tracker's refresh_tokens, extended so one table serves both audiences:
--   audience 'host'  → user_id set (Google SSO / dev bypass), wedding_id null
--   audience 'guest' → guest_id + wedding_id set (link + OTP, designed in ACC)
-- Only sha256(token) is stored. Reusing a rotated token revokes the whole family.
CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience       text NOT NULL CHECK (audience IN ('host','guest')),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_id       uuid REFERENCES guests(id) ON DELETE CASCADE,
  wedding_id     uuid REFERENCES weddings(id) ON DELETE CASCADE,
  device_id      text NOT NULL CHECK (length(device_id) BETWEEN 16 AND 64),  -- random per-install id from the app's keychain
  family_id      uuid NOT NULL,                     -- one per sign-in; kept across rotations
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('rotated','logout','reuse_detected','admin','account_deleted','access_removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (audience = 'host'  AND user_id IS NOT NULL AND guest_id IS NULL AND wedding_id IS NULL) OR
    (audience = 'guest' AND guest_id IS NOT NULL AND wedding_id IS NOT NULL AND user_id IS NULL)
  ),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- "revoke every live session of this user" (reuse detection, sign out everywhere, account deletion)
CREATE INDEX refresh_tokens_user_live_idx  ON refresh_tokens (user_id)  WHERE user_id  IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX refresh_tokens_guest_live_idx ON refresh_tokens (guest_id) WHERE guest_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx     ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_wedding_idx    ON refresh_tokens (wedding_id) WHERE wedding_id IS NOT NULL;
-- nightly purge: rows expired or revoked more than 7 days ago (job fnd.purge-auth)
CREATE INDEX refresh_tokens_expires_idx    ON refresh_tokens (expires_at);

-- ── Idempotency keys (Idempotency-Key header on sends / payments) ─────────────
-- scope = caller identity ("user:<uuid>" / "guest:<uuid>"), so two callers can't collide.
-- The first request inserts 'in_progress'; a concurrent duplicate gets 409; a later duplicate
-- replays the stored response. Purged after expires_at (24 h) by job fnd.purge-idempotency.
CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL,
  idem_key        text NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 128),
  wedding_id      uuid REFERENCES weddings(id) ON DELETE CASCADE,
  method          text NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  route           text NOT NULL,                     -- route template, e.g. /v1/weddings/:weddingId/announcements
  request_hash    bytea NOT NULL,                    -- sha256 of canonical body; mismatch → 422 IDEMPOTENCY_KEY_REUSED
  state           text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  response_status int,
  response_body   jsonb,                             -- serialised response; no secrets (serialisers already mask)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (scope, idem_key),
  CHECK (state = 'in_progress' OR response_status IS NOT NULL)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
CREATE INDEX idempotency_keys_wedding_idx ON idempotency_keys (wedding_id) WHERE wedding_id IS NOT NULL;

-- ── Realtime events (SSE fan-out via LISTEN/NOTIFY, with replay) ──────────────
-- Writers call rt_publish() inside the same transaction as the domain change, so the NOTIFY
-- fires only on commit. Every API process LISTENs on 'mehfil_rt'; the NOTIFY carries only the
-- id, wedding and channel (8 kB NOTIFY limit), the hub reads the row once and pushes it to
-- subscribers. Reconnecting clients send Last-Event-ID and get the rows after it.
-- Payload rule: only fields every subscriber of that channel may see (no phones, no ID data).
-- Retention: 24 h (job fnd.purge-realtime).
CREATE TABLE realtime_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_.:-]{1,63}$'),   -- "arrivals", "headcount", "quiz:<uuid>"
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),        -- "arrival.updated"
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 4096),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX realtime_events_replay_idx ON realtime_events (wedding_id, channel, id);
CREATE INDEX realtime_events_created_idx ON realtime_events USING brin (created_at);

CREATE FUNCTION rt_publish(p_wedding uuid, p_channel text, p_kind text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO realtime_events (wedding_id, channel, kind, payload)
  VALUES (p_wedding, p_channel, p_kind, p_payload)
  RETURNING id INTO v_id;
  PERFORM pg_notify('mehfil_rt', json_build_object('id', v_id, 'w', p_wedding, 'c', p_channel)::text);
  RETURN v_id;
END $$;
