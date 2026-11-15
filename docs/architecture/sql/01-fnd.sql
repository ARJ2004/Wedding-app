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
