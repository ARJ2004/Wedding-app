-- E15 Pickup batching (PCK). Design: docs/architecture/15-pck.md
-- Depends on: 000-core.sql, 08-trv.sql, 09-arr.sql. Owning module: apps/api/src/modules/pickups.

-- btree_gist lets one EXCLUDE constraint combine "same vehicle" (=) with "overlapping time" (&&).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE drivers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone_e164    text NOT NULL,                           -- shared with the guests they pick up (PCK-03)
  language      text NOT NULL DEFAULT 'hi',
  vendor_name   text,                                    -- transport vendor
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX drivers_wedding_idx ON drivers (wedding_id) WHERE deleted_at IS NULL;

CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  label            text NOT NULL,                        -- "Innova 3"
  vehicle_type     text NOT NULL CHECK (vehicle_type IN ('sedan','suv','tempo_traveller','minibus','bus','other')),
  seats            int NOT NULL CHECK (seats BETWEEN 1 AND 60), -- passenger seats, driver excluded
  registration_no  text,                                 -- "RJ27 TA 1234"; shown to guests
  default_driver_id uuid REFERENCES drivers(id) ON DELETE SET NULL,
  available        tstzrange,                            -- hire window; null = whole wedding
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (wedding_id, label)
);

-- One run of the batching algorithm; parameters kept for "why was I put in this car?".
CREATE TABLE pickup_plan_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  params        jsonb NOT NULL,                          -- {window_minutes, from, to, point_ids}
  stats         jsonb,                                   -- {units, guests, batches, unassigned}
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pickup_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  point_id         uuid NOT NULL REFERENCES travel_points(id),
  window_start     timestamptz NOT NULL,                 -- earliest member ETA when planned
  window_end       timestamptz NOT NULL,
  depart_at        timestamptz NOT NULL,                 -- leaves the point: last ETA + pickup buffer
  return_by        timestamptz NOT NULL,                 -- depart_at + 2 × transfer_minutes (vehicle free again)
  vehicle_id       uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id        uuid REFERENCES drivers(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','dispatched','completed','cancelled')),
  locked           boolean NOT NULL DEFAULT false,       -- set by any manual edit; re-planning never touches it
  plan_run_id      uuid REFERENCES pickup_plan_runs(id) ON DELETE SET NULL,
  version          int NOT NULL DEFAULT 1,               -- bumped on any change guests must hear about
  notified_version int NOT NULL DEFAULT 0,               -- last version guests were told about (PCK-03)
  busy             tstzrange GENERATED ALWAYS AS (tstzrange(depart_at, return_by, '[)')) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start AND depart_at >= window_start AND return_by >= depart_at),
  -- a vehicle (and a driver) cannot be on two overlapping runs
  CONSTRAINT pickup_batches_vehicle_overlap EXCLUDE USING gist (vehicle_id WITH =, busy WITH &&)
    WHERE (vehicle_id IS NOT NULL AND status <> 'cancelled'),
  CONSTRAINT pickup_batches_driver_overlap EXCLUDE USING gist (driver_id WITH =, busy WITH &&)
    WHERE (driver_id IS NOT NULL AND status <> 'cancelled')
);
CREATE INDEX pickup_batches_board_idx  ON pickup_batches (wedding_id, depart_at) WHERE status <> 'cancelled';
CREATE INDEX pickup_batches_driver_idx ON pickup_batches (driver_id, depart_at) WHERE status <> 'cancelled';

-- A guest is in at most one arrival pickup. Cancelling a batch deletes its members.
CREATE TABLE pickup_batch_members (
  batch_id         uuid NOT NULL REFERENCES pickup_batches(id) ON DELETE CASCADE,
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id         uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  party_id         uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  leg_id           uuid REFERENCES travel_legs(id) ON DELETE SET NULL,
  picked_up_at     timestamptz,
  picked_up_source text CHECK (picked_up_source IN ('driver','host','desk')),
  no_show_at       timestamptz,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, guest_id),
  UNIQUE (wedding_id, guest_id)
);
CREATE INDEX pickup_batch_members_party_idx ON pickup_batch_members (party_id);

-- PCK-04: delay / no-show / no-vehicle alerts with a suggested move.
CREATE TABLE pickup_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id         uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  batch_id           uuid NOT NULL REFERENCES pickup_batches(id) ON DELETE CASCADE,
  guest_id           uuid REFERENCES guests(id) ON DELETE CASCADE,  -- null = batch-level (e.g. no vehicle)
  reason             text NOT NULL CHECK (reason IN ('guest_late','flight_delayed','flight_cancelled','no_show','no_vehicle')),
  new_eta            timestamptz,
  suggested_batch_id uuid REFERENCES pickup_batches(id) ON DELETE SET NULL, -- null + suggestion.kind='new_batch'
  suggestion         jsonb,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','dismissed','superseded')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX pickup_alerts_open_uidx
  ON pickup_alerts (batch_id, coalesce(guest_id, '00000000-0000-0000-0000-000000000000'::uuid), reason)
  WHERE status = 'open';
CREATE INDEX pickup_alerts_wedding_idx ON pickup_alerts (wedding_id, created_at DESC) WHERE status = 'open';

-- PCK-05: no-login driver link (/d/<token>). Token = 128-bit random; only its sha256 is stored.
CREATE TABLE driver_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,                    -- weddings.ends_on + 1 day (IST end of day)
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX driver_links_active_uidx ON driver_links (driver_id) WHERE revoked_at IS NULL;
