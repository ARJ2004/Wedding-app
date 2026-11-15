-- E13 Shared gallery (GAL) — design: docs/architecture/13-gal.md
-- Owning module: apps/api/src/modules/photos (same module as 12-cam.sql).
-- Albums are events (plus an "Other" album for photos with event_id NULL); no album table.
-- Hide state lives on photos (12-cam.sql). Depends on: 000-core.sql, 12-cam.sql.

-- ── Reports (GAL-03) ─────────────────────────────────────────────────────────
CREATE TABLE photo_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id         uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  photo_id           uuid NOT NULL REFERENCES photos(media_id) ON DELETE CASCADE,
  reporter_guest_id  uuid REFERENCES guests(id) ON DELETE SET NULL,
  reporter_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  reason             text NOT NULL CHECK (reason IN ('inappropriate','privacy','i_am_in_it','other')),
  note               text CHECK (char_length(note) <= 280),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolution         text CHECK (resolution IN ('kept','hidden','deleted')),
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
-- One open report per reporter per photo (counts distinct reporters for auto-hide).
CREATE UNIQUE INDEX photo_reports_guest_uq ON photo_reports (photo_id, reporter_guest_id) WHERE reporter_guest_id IS NOT NULL;
CREATE UNIQUE INDEX photo_reports_user_uq  ON photo_reports (photo_id, reporter_user_id)  WHERE reporter_user_id IS NOT NULL;
-- Host moderation queue.
CREATE INDEX photo_reports_open_idx ON photo_reports (wedding_id, created_at DESC) WHERE resolved_at IS NULL;

-- ── Favourites (GAL-04) ──────────────────────────────────────────────────────
CREATE TABLE photo_favourites (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  photo_id    uuid NOT NULL REFERENCES photos(media_id) ON DELETE CASCADE,
  guest_id    uuid REFERENCES guests(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((guest_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX photo_favourites_guest_uq ON photo_favourites (guest_id, photo_id) WHERE guest_id IS NOT NULL;
CREATE UNIQUE INDEX photo_favourites_user_uq  ON photo_favourites (user_id, wedding_id, photo_id) WHERE user_id IS NOT NULL;
CREATE INDEX photo_favourites_photo_idx ON photo_favourites (photo_id);

-- ── Album exports (GAL-02 host zip, GAL-04 optional guest zip) ───────────────
-- The zip itself is a media_objects row (kind 'export') in the exports bucket: gallery/{weddingId}/{exportId}.zip.
CREATE TABLE gallery_exports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id           uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id             uuid REFERENCES events(id) ON DELETE CASCADE,         -- null = whole wedding
  scope                text NOT NULL CHECK (scope IN ('host_all','guest_visible','favourites')),
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  snapshot_key         text NOT NULL,     -- sha256 of the sorted photo-id list; equal key = reuse the zip
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','building','ready','failed','expired')),
  photo_count          int,
  byte_size            bigint,
  media_id             uuid UNIQUE REFERENCES media_objects(id) ON DELETE SET NULL,
  error_code           text,
  idempotency_key      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  ready_at             timestamptz,
  expires_at           timestamptz,                                           -- ready_at + 7 days (S3 lifecycle backstop)
  CHECK ((requested_by_user_id IS NULL) <> (requested_by_guest_id IS NULL))
);
-- Reuse a live export of the same photo set instead of building it again.
CREATE UNIQUE INDEX gallery_exports_live_uq ON gallery_exports (wedding_id, event_id, scope, snapshot_key) NULLS NOT DISTINCT
  WHERE status IN ('queued','building','ready');
CREATE INDEX gallery_exports_wedding_idx ON gallery_exports (wedding_id, created_at DESC);
CREATE INDEX gallery_exports_expiry_idx ON gallery_exports (expires_at) WHERE status = 'ready';
