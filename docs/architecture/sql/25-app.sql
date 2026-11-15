-- E25 Native app (APP). Design: docs/architecture/25-app.md
-- Depends on: 000-core.sql, 01-fnd.sql (device_id convention shared with refresh_tokens).
-- Owning module: push_devices → devices (apps/api/src/modules/devices).

-- One phone can hold several identities at once: a host account and guest sessions at one or
-- more weddings (the bride is a guest at her cousin's wedding). FCM gives the install one token,
-- so the core UNIQUE (fcm_token) would allow only one identity per phone.
-- DEVIATION from 000-core.sql (see 25-app.md §14): replace it with one row per (token, identity).
ALTER TABLE push_devices DROP CONSTRAINT push_devices_fcm_token_key;
CREATE UNIQUE INDEX push_devices_token_user_uq  ON push_devices (fcm_token, user_id)  WHERE user_id  IS NOT NULL;
CREATE UNIQUE INDEX push_devices_token_guest_uq ON push_devices (fcm_token, guest_id) WHERE guest_id IS NOT NULL;

ALTER TABLE push_devices
  ADD COLUMN device_id     text CHECK (length(device_id) BETWEEN 16 AND 64),  -- same per-install id as refresh_tokens.device_id
  ADD COLUMN wedding_id    uuid REFERENCES weddings(id) ON DELETE CASCADE,    -- set for guest rows (tenant scoping, erasure)
  ADD COLUMN locale        text NOT NULL DEFAULT 'en',
  ADD COLUMN os_version    text,
  ADD COLUMN permission    text NOT NULL DEFAULT 'unknown' CHECK (permission IN ('granted','denied','unknown')),
  ADD COLUMN disabled_at   timestamptz,                                       -- FCM said UNREGISTERED / INVALID_ARGUMENT
  ADD CONSTRAINT push_devices_guest_wedding_chk CHECK (guest_id IS NULL OR wedding_id IS NOT NULL);

-- Fan-out: "push targets for these guests" (announcements) and "for these team members" (late-guest alerts).
CREATE INDEX push_devices_guest_idx ON push_devices (guest_id) WHERE guest_id IS NOT NULL AND disabled_at IS NULL;
CREATE INDEX push_devices_user_idx  ON push_devices (user_id)  WHERE user_id  IS NOT NULL AND disabled_at IS NULL;
-- Sign-out / session revoke on one install removes that install's rows for that identity.
CREATE INDEX push_devices_device_idx ON push_devices (device_id) WHERE device_id IS NOT NULL;
-- Weekly purge of rows not seen for 60 days.
CREATE INDEX push_devices_last_seen_idx ON push_devices (last_seen_at);
