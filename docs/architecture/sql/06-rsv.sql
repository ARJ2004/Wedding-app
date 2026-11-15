-- E06 RSVP (RSV). Design: docs/architecture/06-rsv.md
-- Depends on: 000-core.sql, 03-set.sql (events.deleted_at, party_invited_events view, party_groups_group_idx).
-- Owning module: apps/api/src/modules/rsvp.
-- "Invited" = party_invited_events (SET) x live guests of the party. "Pending" = invited and no rsvps row.
-- Plus-ones are ordinary guests rows (is_plus_one = true) created through GST's addPlusOne(); they follow
-- their party's invitations, so every count below is one row per person.

-- Per-event RSVP window. Edited in SET's event form (SET writes events; RSV reads).
ALTER TABLE events
  ADD COLUMN rsvp_enabled   boolean NOT NULL DEFAULT true,   -- false: on the schedule, no RSVP asked (e.g. Vidaai)
  ADD COLUMN rsvp_closes_at timestamptz;                     -- guests can't change after this; hosts still can

CREATE TABLE rsvps (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id            uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id              uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  party_id              uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  guest_id              uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  status                text NOT NULL CHECK (status IN ('attending','declined','maybe')),
  source                text NOT NULL CHECK (source IN ('app','lite_web','whatsapp','host','import')),
  responded_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,   -- shared phone: the selected member
  responded_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,    -- host on behalf (RSV-05)
  host_note             text CHECK (length(host_note) <= 280),           -- "Took this on the phone with Mamaji"
  responded_at          timestamptz NOT NULL DEFAULT now(),              -- first answer (chase logic, "replied in N days")
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, guest_id),
  CHECK (responded_by_guest_id IS NULL OR responded_by_user_id IS NULL),
  CHECK (source <> 'host' OR responded_by_user_id IS NOT NULL)
);
-- Headcount and host list for one wedding; INCLUDE keeps the aggregate index-only.
CREATE INDEX rsvps_headcount_idx ON rsvps (wedding_id, event_id) INCLUDE (guest_id, status);
CREATE INDEX rsvps_party_idx     ON rsvps (party_id, event_id);
CREATE INDEX rsvps_guest_idx     ON rsvps (guest_id);

-- Diet belongs to the person, not the event. Allergies are health-adjacent: purged at wedding end + 30 days (PRV-03).
CREATE TABLE guest_dietary (
  guest_id    uuid PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  diet        text CHECK (diet IN ('veg','jain','vegan','eggetarian','non_veg')),
  allergies   text[] NOT NULL DEFAULT '{}'
              CHECK (allergies <@ ARRAY['nuts','gluten','dairy','shellfish','egg','soy','other']::text[]),
  notes       text CHECK (length(notes) <= 280),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_dietary_wedding_idx ON guest_dietary (wedding_id) INCLUDE (guest_id, diet);

-- Each "chase non-responders" run (RSV-04): audience snapshot and the MSG message that carried it.
CREATE TABLE rsvp_chase_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_ids        uuid[] NOT NULL CHECK (cardinality(event_ids) BETWEEN 1 AND 20),
  no_reply_days    int NOT NULL CHECK (no_reply_days BETWEEN 0 AND 60),
  party_ids        uuid[] NOT NULL,
  message_id       uuid,                                       -- messages.id (07-msg); no FK across epics
  idempotency_key  text NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, idempotency_key)
);
CREATE INDEX rsvp_chase_runs_wedding_idx ON rsvp_chase_runs (wedding_id, created_at DESC);
