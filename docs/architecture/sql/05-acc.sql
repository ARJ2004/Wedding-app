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
