-- E16 Room allocation (ROM). Design: docs/architecture/16-rom.md
-- Depends on: 000-core.sql (and btree_gist, created idempotently here as well as in 15-pck.sql).
-- Owning module: apps/api/src/modules/rooms.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE hotels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  venue_id        uuid REFERENCES venues(id) ON DELETE SET NULL,   -- when the hotel is also a venue
  name            text NOT NULL,
  address         text,
  maps_url        text,
  front_desk_phone text,                                 -- business number, not personal data
  check_in_time   time NOT NULL DEFAULT '14:00',
  check_out_time  time NOT NULL DEFAULT '11:00',
  side_hint       text CHECK (side_hint IN ('bride_side','groom_side')),  -- auto-suggest preference
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, name)
);

CREATE TABLE room_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  hotel_id         uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name             text NOT NULL,                        -- "Deluxe Twin"
  default_capacity int NOT NULL CHECK (default_capacity BETWEEN 1 AND 20),
  max_occupancy    int NOT NULL CHECK (max_occupancy BETWEEN 1 AND 20),  -- with extra beds
  CHECK (max_occupancy >= default_capacity),
  UNIQUE (hotel_id, name)
);

CREATE TABLE rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  hotel_id        uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id    uuid REFERENCES room_types(id) ON DELETE SET NULL,
  room_number     text NOT NULL,                        -- "214"; may be "TBA-07" until the hotel assigns
  floor           text,
  capacity        int NOT NULL CHECK (capacity BETWEEN 1 AND 20),
  max_occupancy   int NOT NULL CHECK (max_occupancy BETWEEN 1 AND 20),
  block           daterange NOT NULL,                   -- nights held: [first night, checkout day)
  accessible      boolean NOT NULL DEFAULT false,       -- ground floor / lift; preferred for seniors
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (max_occupancy >= capacity),
  CHECK (NOT isempty(block) AND lower_inc(block) AND NOT upper_inc(block)),
  UNIQUE (hotel_id, room_number)
);
CREATE INDEX rooms_wedding_idx ON rooms (wedding_id, hotel_id) WHERE status = 'active';

-- One stay in one room. A room has at most one live stay per night; one stay may hold
-- guests from more than one party (e.g. two cousins sharing).
CREATE TABLE room_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  room_id           uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  stay              daterange NOT NULL,                  -- nights: [check-in date, check-out date)
  status            text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('suggested','confirmed','cancelled')),
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto','import')),
  suggestion_run_id uuid,                                -- groups one auto-suggest run (accept/discard all)
  note              text CHECK (length(note) <= 500),   -- "extra bed", "early check-in"
  version           int NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(stay) AND lower_inc(stay) AND NOT upper_inc(stay)),
  UNIQUE (id, stay),                                     -- target of the composite FK below
  CONSTRAINT room_assignments_no_double_booking EXCLUDE USING gist (room_id WITH =, stay WITH &&)
    WHERE (status <> 'cancelled')
);
CREATE INDEX room_assignments_wedding_idx ON room_assignments (wedding_id, status);
CREATE INDEX room_assignments_run_idx ON room_assignments (suggestion_run_id) WHERE suggestion_run_id IS NOT NULL;

-- Guests in a stay. stay is copied from the assignment (FK keeps it equal, ON UPDATE CASCADE)
-- so the database itself forbids one guest being in two rooms on the same night.
-- Cancelling an assignment deletes its guest rows.
CREATE TABLE room_assignment_guests (
  assignment_id   uuid NOT NULL,
  stay            daterange NOT NULL,
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id        uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  party_id        uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, guest_id),
  FOREIGN KEY (assignment_id, stay) REFERENCES room_assignments (id, stay) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT room_guests_no_double_booking EXCLUDE USING gist (guest_id WITH =, stay WITH &&)
);
CREATE INDEX room_assignment_guests_party_idx ON room_assignment_guests (party_id);
CREATE INDEX room_assignment_guests_wedding_idx ON room_assignment_guests (wedding_id);

-- ROM-01: staged Excel import (parse → preview → commit), same shape as the guest import.
CREATE TABLE room_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  media_id      uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed','committed','failed','discarded')),
  rows          jsonb NOT NULL DEFAULT '[]'::jsonb,      -- normalised rows (no personal data: hotel inventory)
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{row, column, code}]
  summary       jsonb,                                   -- {hotels, room_types, rooms, updated, skipped}
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);
CREATE INDEX room_imports_wedding_idx ON room_imports (wedding_id, created_at DESC);
