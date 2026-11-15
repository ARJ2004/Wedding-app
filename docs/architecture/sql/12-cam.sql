-- E12 Disposable camera and media pipeline (CAM) — design: docs/architecture/12-cam.md
-- Owning module: apps/api/src/modules/photos (camera + gallery share one module and these tables).
-- media_objects (core) stays owned by the `media` module (generic presign / complete / process).
-- Depends on: 000-core.sql only.

-- ── Wedding-level camera + gallery settings ──────────────────────────────────
-- SET-06 "Camera shot limit, reveal mode" is edited through the photos module's endpoints;
-- these values are NOT duplicated into weddings.settings.
CREATE TABLE photo_settings (
  wedding_id                 uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  camera_enabled             boolean NOT NULL DEFAULT true,
  shot_limit_scope           text    NOT NULL DEFAULT 'event' CHECK (shot_limit_scope IN ('wedding','event')),
  shot_limit                 int     NOT NULL DEFAULT 24  CHECK (shot_limit BETWEEN 1 AND 500),
  gallery_upload_limit       int     NOT NULL DEFAULT 20  CHECK (gallery_upload_limit BETWEEN 0 AND 500), -- GAL-05, per guest per wedding
  reveal_mode                text    NOT NULL DEFAULT 'immediate'
                             CHECK (reveal_mode IN ('immediate','at_time','manual')),
  default_reveal_offset      interval,                     -- reveal_mode=at_time: event end + offset (e.g. '10 hours' = next morning)
  report_autohide_threshold  int     NOT NULL DEFAULT 3 CHECK (report_autohide_threshold BETWEEN 1 AND 50), -- GAL-03
  guest_zip_enabled          boolean NOT NULL DEFAULT false, -- GAL-04; guests use "save all to phone" by default
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (reveal_mode <> 'at_time' OR default_reveal_offset IS NOT NULL)
);

-- Per-event camera: QR routing code, overrides, open window and the effective reveal time.
CREATE TABLE photo_event_settings (
  event_id        uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,   -- = events.wedding_id (service-enforced)
  camera_code     text NOT NULL UNIQUE CHECK (camera_code ~ '^[A-HJ-NP-Z2-9]{10}$'), -- public routing code in the QR; not a credential
  camera_enabled  boolean,                          -- null = inherit photo_settings.camera_enabled
  shot_limit      int CHECK (shot_limit BETWEEN 1 AND 500), -- null = inherit
  opens_at        timestamptz,                      -- null = event.starts_at - 2h
  closes_at       timestamptz,                      -- null = event end (or start + 8h) + 6h
  reveal_at       timestamptz NOT NULL DEFAULT '-infinity', -- effective; 'infinity' = manual, not yet revealed
  revealed_notified_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_event_settings_wedding_idx ON photo_event_settings (wedding_id);

-- ── Shot counters (server-side limit, atomic upsert) ─────────────────────────
-- One row per guest × scope × source. event_id is NULL when shot_limit_scope = 'wedding'
-- and always NULL for source = 'gallery' (gallery uploads are per wedding).
-- Reserve: INSERT ... ON CONFLICT DO UPDATE SET used = used + 1 WHERE used < :limit RETURNING used.
CREATE TABLE photo_shot_counters (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id    uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES events(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('camera','gallery')),
  used        int  NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'camera' OR event_id IS NULL)
);
CREATE UNIQUE INDEX photo_shot_counters_uq
  ON photo_shot_counters (guest_id, event_id, source) NULLS NOT DISTINCT;

-- ── Photos (1:1 with a media_objects row of kind 'photo') ────────────────────
CREATE TABLE photos (
  media_id          uuid PRIMARY KEY REFERENCES media_objects(id) ON DELETE CASCADE,
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id          uuid REFERENCES events(id) ON DELETE SET NULL,          -- null = "Other" album
  source            text NOT NULL CHECK (source IN ('camera','gallery','host')),
  client_shot_id    uuid NOT NULL,                                           -- generated on device at capture; idempotency key
  uploader_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  uploader_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  counter_id        bigint REFERENCES photo_shot_counters(id) ON DELETE SET NULL, -- slot to release if abandoned/duplicate
  filter            text NOT NULL DEFAULT 'none' CHECK (filter IN ('none','marigold','mono','faded')),
  sha256            bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32), -- client-declared, verified by S3 checksum + worker
  captured_at       timestamptz NOT NULL,                                    -- device clock, clamped by the API
  reveal_at         timestamptz NOT NULL DEFAULT '-infinity',                -- copied from photo_event_settings; bulk-updated on change
  width             int,
  height            int,
  preview_key       text,                                                    -- w/{wid}/p/{id}/pv.webp
  thumb_key         text,                                                    -- w/{wid}/p/{id}/th.webp
  blurhash          text,
  ready_at          timestamptz,                                             -- set by media.process_photo; null = not yet viewable
  hidden_at         timestamptz,
  hidden_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  hidden_reason     text CHECK (hidden_reason IN ('host','reports')),
  report_count      int NOT NULL DEFAULT 0,
  deleted_at        timestamptz,
  deleted_reason    text CHECK (deleted_reason IN ('uploader','host','duplicate','abandoned','retention','guest_erasure','wedding')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((uploader_guest_id IS NULL) OR (uploader_user_id IS NULL)),
  CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL))
);
CREATE UNIQUE INDEX photos_client_shot_uq ON photos (wedding_id, client_shot_id);
-- Dedupe: one live photo per (wedding, content hash).
CREATE UNIQUE INDEX photos_sha_uq ON photos (wedding_id, sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;
-- Album feed (GAL-01): keyset on (captured_at, media_id) per event.
CREATE INDEX photos_event_feed_idx ON photos (event_id, captured_at DESC, media_id DESC)
  WHERE ready_at IS NOT NULL AND hidden_at IS NULL AND deleted_at IS NULL;
-- Wedding-wide feed and the "Other" album.
CREATE INDEX photos_wedding_feed_idx ON photos (wedding_id, captured_at DESC, media_id DESC)
  WHERE ready_at IS NOT NULL AND hidden_at IS NULL AND deleted_at IS NULL;
-- "My shots" (developing list) and guest erasure.
CREATE INDEX photos_uploader_guest_idx ON photos (uploader_guest_id, created_at DESC) WHERE uploader_guest_id IS NOT NULL;
-- Reaper for uploads that never completed.
CREATE INDEX photos_unready_idx ON photos (created_at) WHERE ready_at IS NULL AND deleted_at IS NULL;
-- Host moderation view of hidden photos.
CREATE INDEX photos_hidden_idx ON photos (wedding_id, hidden_at DESC) WHERE hidden_at IS NOT NULL AND deleted_at IS NULL;
