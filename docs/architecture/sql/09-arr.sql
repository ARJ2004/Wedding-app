-- E09 Arrivals board and check-in (ARR). Design: docs/architecture/09-arr.md
-- Depends on: 000-core.sql, 08-trv.sql. Owning module: apps/api/src/modules/arrivals.

-- Party check-in code printed in the party QR (GH-07 displays it). NOT a login credential:
-- it only resolves for an authenticated team member of the same wedding.
-- 12 chars Crockford base32 (60 bits). QR content: https://<domain>/q/<checkin_code>
ALTER TABLE parties ADD COLUMN checkin_code text;
CREATE UNIQUE INDEX parties_checkin_code_uidx ON parties (wedding_id, checkin_code) WHERE checkin_code IS NOT NULL;

-- ── One row per expected guest: the board's read model (denormalised, ARR writes it) ──
-- Created when a guest gets an arrival leg, when an out-station party is imported, or on
-- an unplanned desk check-in. Every write also calls rt_publish(wedding,'arrivals',...) (01-fnd.sql)
-- in the same transaction; SSE replay uses realtime_events ids, not this table.
CREATE TABLE arrival_state (
  guest_id          uuid PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id          uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  leg_id            uuid REFERENCES travel_legs(id) ON DELETE SET NULL,
  point_id          uuid REFERENCES travel_points(id) ON DELETE SET NULL,
  expected_at       timestamptz,                         -- from the leg (scheduled); null = out-station, no details yet
  eta_at            timestamptz,                         -- best estimate: flight estimate or guest "late by X"
  needs_pickup      boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'expected'
                    CHECK (status IN ('expected','running_late','landed','picked_up','at_hotel','checked_in')),
  late_by_minutes   int CHECK (late_by_minutes BETWEEN 0 AND 1440),
  flight_flag       text CHECK (flight_flag IN ('delayed','cancelled','diverted')),
  status_source     text CHECK (status_source IN ('app','lite_web','whatsapp','host','desk','driver','flight_api')),
  status_at         timestamptz,
  checked_in_at     timestamptz,
  checked_in_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- board snapshot by point and window (expected_at drives the "expected" columns)
CREATE INDEX arrival_state_board_idx    ON arrival_state (wedding_id, point_id, expected_at);
-- board windows and "still missing": not yet checked in, ordered by ETA
CREATE INDEX arrival_state_missing_idx  ON arrival_state (wedding_id, eta_at) WHERE checked_in_at IS NULL;
CREATE INDEX arrival_state_party_idx    ON arrival_state (party_id);

-- ── Append-only status history (guest taps, WhatsApp replies, host/driver/flight API) ──
CREATE TABLE travel_status_updates (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id          uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id            uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  guest_id            uuid REFERENCES guests(id) ON DELETE CASCADE,  -- null = whole party on the leg
  status              text NOT NULL CHECK (status IN ('running_late','landed','picked_up','at_hotel','on_time')),
  late_by_minutes     int CHECK (late_by_minutes BETWEEN 0 AND 1440),
  source              text NOT NULL CHECK (source IN ('app','lite_web','whatsapp','host','desk','driver','flight_api')),
  actor_type          text NOT NULL CHECK (actor_type IN ('user','guest','system','driver')),
  actor_id            uuid,
  client_op_id        uuid,                                -- app/lite web idempotency
  inbound_message_id  text,                                -- provider message id for WhatsApp dedupe
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX travel_status_updates_op_uidx  ON travel_status_updates (wedding_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE UNIQUE INDEX travel_status_updates_wa_uidx  ON travel_status_updates (inbound_message_id) WHERE inbound_message_id IS NOT NULL;
CREATE INDEX travel_status_updates_party_idx ON travel_status_updates (party_id, created_at DESC);

-- ── Check-in log (offline replay, undo, disputes). arrival_state holds the current value. ──
CREATE TABLE check_in_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id        uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action IN ('check_in','undo')),
  method          text NOT NULL CHECK (method IN ('search','qr','host','offline_replay')),
  by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  client_op_id    uuid NOT NULL,                           -- generated on the device; replay-safe
  occurred_at     timestamptz NOT NULL,                    -- device clock (clamped server-side)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, client_op_id, guest_id)
);
CREATE INDEX check_in_events_guest_idx ON check_in_events (guest_id, created_at DESC);
