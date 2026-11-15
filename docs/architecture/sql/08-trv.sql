-- E08 Travel collection (TRV). Design: docs/architecture/08-trv.md
-- Depends on: 000-core.sql. Owning module: apps/api/src/modules/travel.

-- ── Arrival / departure points the host sets up (airport, station, bus stand) ──
-- Shared by TRV (guest picks one), ARR (board grouping) and PCK (batching).
CREATE TABLE travel_points (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id            uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  kind                  text NOT NULL CHECK (kind IN ('airport','station','bus_stand','other')),
  name                  text NOT NULL,                   -- "Udaipur Airport (UDR)"
  code                  text,                            -- IATA "UDR" / station code "UDZ"; used for flight matching
  lat                   double precision,
  lng                   double precision,
  pickup_buffer_minutes int NOT NULL DEFAULT 30 CHECK (pickup_buffer_minutes BETWEEN 0 AND 180), -- baggage / exit time (PCK)
  transfer_minutes      int NOT NULL DEFAULT 45 CHECK (transfer_minutes BETWEEN 0 AND 600),     -- one-way drive to the hotel (PCK)
  is_active             boolean NOT NULL DEFAULT true,
  sort_order            int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, name)
);

-- ── One leg = one journey into (arrival) or out of (departure) the wedding city ──
-- Shared by a whole party or by some members (travel_leg_guests). Connecting flights:
-- only the final leg into the city is recorded.
CREATE TABLE travel_legs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id             uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id               uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  direction              text NOT NULL CHECK (direction IN ('arrival','departure')),
  mode                   text NOT NULL CHECK (mode IN ('flight','train','car','bus','other')),
  carrier_code           text,                           -- "6E", "AI"; null for train/car
  service_number         text,                           -- normalised: "6E2134", "12951"
  origin_city            text,                           -- arrival: where from; departure: where to
  point_id               uuid REFERENCES travel_points(id) ON DELETE SET NULL, -- null = direct to venue/hotel
  scheduled_at           timestamptz NOT NULL,           -- arrival time at point / departure time from point
  needs_pickup           boolean NOT NULL DEFAULT false,
  notes                  text CHECK (length(notes) <= 500),
  ticket_media_id        uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  source                 text NOT NULL DEFAULT 'guest' CHECK (source IN ('guest','host','ticket_ai')),
  -- TRV-05 flight status (written by the travel.flight-status job only)
  estimated_at           timestamptz,
  flight_status          text CHECK (flight_status IN ('scheduled','delayed','departed','landed','cancelled','diverted','unknown')),
  flight_status_checked_at timestamptz,
  version                int NOT NULL DEFAULT 1,         -- optimistic concurrency (If-Match) between guest and host edits
  created_by_guest_id    uuid REFERENCES guests(id) ON DELETE SET NULL,
  created_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, wedding_id, direction),                    -- target of the composite FK below
  CHECK (mode <> 'flight' OR carrier_code IS NOT NULL OR service_number IS NULL)
);
CREATE INDEX travel_legs_party_idx   ON travel_legs (party_id);
-- host travel view + ARR board seed: by day/hour within a wedding
CREATE INDEX travel_legs_sched_idx   ON travel_legs (wedding_id, direction, scheduled_at);
-- flight-status poller: arrival flights in the next/last day across all weddings
CREATE INDEX travel_legs_flight_poll_idx ON travel_legs (scheduled_at)
  WHERE mode = 'flight' AND direction = 'arrival';

-- Which party members travel on a leg. One arrival and one departure leg per guest.
CREATE TABLE travel_leg_guests (
  leg_id      uuid NOT NULL,
  wedding_id  uuid NOT NULL,
  direction   text NOT NULL,
  guest_id    uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  PRIMARY KEY (leg_id, guest_id),
  FOREIGN KEY (leg_id, wedding_id, direction)
    REFERENCES travel_legs (id, wedding_id, direction) ON DELETE CASCADE,
  UNIQUE (guest_id, direction)
);
CREATE INDEX travel_leg_guests_wedding_idx ON travel_leg_guests (wedding_id, direction);

-- Per-party travel progress, for the chase list (TRV-04) and "not travelling" answers.
CREATE TABLE travel_party_state (
  party_id        uuid PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','submitted','not_travelling')),
  submitted_at    timestamptz,
  last_chased_at  timestamptz,
  chase_count     int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX travel_party_state_chase_idx ON travel_party_state (wedding_id, status, last_chased_at);

-- ── TRV-06 AI ticket reading: one row per extraction attempt ──
CREATE TABLE ticket_extractions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id            uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  party_id              uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  media_id              uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  requested_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  requested_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','succeeded','failed','applied','discarded')),
  provider              text NOT NULL,                   -- "anthropic", "fake"
  model                 text,
  result                jsonb,                           -- normalised fields + per-field confidence; no raw OCR text
  error_code            text,
  applied_leg_id        uuid REFERENCES travel_legs(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  UNIQUE (media_id)                                      -- one extraction per ticket (idempotent re-request)
);
CREATE INDEX ticket_extractions_party_idx ON ticket_extractions (party_id, created_at DESC);

-- ── TRV-05 flight status cache: NOT wedding-scoped (public flight data, no personal data). ──
-- One provider call per (flight, date) serves every guest on that flight across all weddings.
CREATE TABLE flight_status_cache (
  carrier_code        text NOT NULL,
  flight_number       text NOT NULL,                     -- digits only, "2134"
  flight_date         date NOT NULL,                     -- scheduled departure date, local to origin (provider convention)
  status              text NOT NULL CHECK (status IN ('scheduled','delayed','departed','landed','cancelled','diverted','unknown')),
  arrival_iata        text,
  arrival_terminal    text,
  scheduled_arrival   timestamptz,
  estimated_arrival   timestamptz,
  actual_arrival      timestamptz,
  provider            text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  next_poll_at        timestamptz,                       -- null = stop polling (landed/cancelled)
  PRIMARY KEY (carrier_code, flight_number, flight_date)
);
CREATE INDEX flight_status_cache_poll_idx ON flight_status_cache (next_poll_at) WHERE next_poll_at IS NOT NULL;
