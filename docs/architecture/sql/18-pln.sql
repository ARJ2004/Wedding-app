-- E18 Multi-wedding planner dashboard (PLN). Design: docs/architecture/18-pln.md
-- References 000-core.sql only. Owning module: apps/api/src/modules/planner.
-- Team seats reuse team_invitations / organization_members (10-rol.sql); credits are read
-- through the billing module (23-bil.sql) and never joined from here.

-- ── Org-scoped media (planner logo) ───────────────────────────────────────────
-- Core media_objects is wedding-scoped. A planner logo belongs to the organisation and is shown
-- on every wedding it runs, so media_objects gains an organization_id and wedding_id becomes
-- optional (exactly one of the two is set). See "Deviations from the baseline".
-- Logo rows use kind = 'other' until core adds a 'logo' kind.
ALTER TABLE media_objects
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ALTER COLUMN wedding_id DROP NOT NULL,
  ADD CONSTRAINT media_objects_scope_ck CHECK ((wedding_id IS NULL) <> (organization_id IS NULL));
CREATE INDEX media_org_idx ON media_objects (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;

-- Overview listing uses core weddings_org_idx (EXPLAIN: 40 weddings/org → bitmap scan + sort, 0.3 ms);
-- no extra index needed.

-- ── Health snapshot per wedding (PLN-01) ──────────────────────────────────────
-- One row per wedding, recomputed by job pln.health.recompute (debounced 60 s per wedding,
-- fired by domain events) and a nightly rebuild. Holds counts, not percentages; "days to go"
-- and the red/amber/green status are computed at read time from weddings.starts_on.
-- organization_id is denormalised so the overview is a single index range scan.
CREATE TABLE wedding_health_snapshots (
  wedding_id          uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  guests_total        int NOT NULL DEFAULT 0,
  parties_total       int NOT NULL DEFAULT 0,
  parties_invited     int NOT NULL DEFAULT 0,   -- invite delivered or link opened
  parties_responded   int NOT NULL DEFAULT 0,   -- every invited event answered for every member
  guests_attending    int NOT NULL DEFAULT 0,   -- attending at least one event
  outstation_parties  int NOT NULL DEFAULT 0,
  travel_submitted    int NOT NULL DEFAULT 0,   -- outstation parties with arrival details
  messages_used       int NOT NULL DEFAULT 0,   -- billable units (MSG message_quotas.used_units)
  messages_limit      int,                      -- null = unlimited
  plan_code           text,                     -- copy of entitlements for the badge
  computed_at         timestamptz NOT NULL DEFAULT now(),
  compute_ms          int,
  CHECK (parties_responded <= parties_total AND travel_submitted <= outstation_parties)
);
CREATE INDEX wedding_health_org_idx ON wedding_health_snapshots (organization_id);
-- Nightly rebuild finds stale rows of weddings that are not over.
CREATE INDEX wedding_health_computed_idx ON wedding_health_snapshots (computed_at);

-- ── Planner branding (PLN-04) ─────────────────────────────────────────────────
CREATE TABLE organization_branding (
  organization_id   uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),  -- "Planned by <display_name>"
  logo_media_id     uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  primary_colour    text CHECK (primary_colour ~ '^#[0-9A-Fa-f]{6}$'),
  accent_colour     text CHECK (accent_colour  ~ '^#[0-9A-Fa-f]{6}$'),
  on_primary_colour text CHECK (on_primary_colour IN ('#FFFFFF','#000000')),      -- picked by the API for WCAG AA
  show_in_messages  boolean NOT NULL DEFAULT true,   -- planner name in WhatsApp template footer param
  website_url       text CHECK (website_url ~ '^https://'),
  version           int NOT NULL DEFAULT 1,           -- bumps cache keys in app and lite web
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Per-wedding switch: some couples don't want the planner's badge on their guest pages.
ALTER TABLE weddings
  ADD COLUMN planner_branding_enabled boolean NOT NULL DEFAULT true;

-- ── Wedding templates (PLN-05) ────────────────────────────────────────────────
-- A versioned JSON snapshot assembled from module exports (SET: events/venues/settings/contacts
-- roles; GST: groups; MSG: saved announcement drafts). Never contains guests, phones or media.
CREATE TABLE wedding_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description       text,
  source_wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  schema_version    int NOT NULL DEFAULT 1,
  payload           jsonb NOT NULL,                  -- validated by Zod WeddingTemplateV1
  payload_bytes     int GENERATED ALWAYS AS (octet_length(payload::text)) STORED,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (octet_length(payload::text) <= 262144)
);
CREATE UNIQUE INDEX wedding_templates_org_name_uq ON wedding_templates (organization_id, lower(name)) WHERE deleted_at IS NULL;

-- Provenance of a cloned wedding (shown in the overview, used for template popularity).
CREATE TABLE wedding_clones (
  wedding_id        uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  source_wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  template_id       uuid REFERENCES wedding_templates(id) ON DELETE SET NULL,
  parts             text[] NOT NULL,                 -- {'events','venues','groups','settings','contacts','drafts'}
  date_shift_days   int NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()   -- both sources may be NULL later (deleted)
);
