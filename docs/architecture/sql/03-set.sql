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
