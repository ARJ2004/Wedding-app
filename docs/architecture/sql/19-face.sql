-- E19 Find my photos (FACE) — design: docs/architecture/19-face.md
-- Owning module: apps/api/src/modules/faces.
-- Face vectors live only in the provider (AWS Rekognition collection per wedding); this schema
-- stores provider face IDs, match results and lifecycle state — never images or embeddings.
-- Depends on: 000-core.sql, 12-cam.sql (photos).

-- One Rekognition collection per wedding, created lazily on the first enrolment.
-- ON DELETE RESTRICT: wedding hard-delete must first call faces.purgeWedding (DeleteCollection).
CREATE TABLE face_collections (
  wedding_id          uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE RESTRICT,
  provider            text NOT NULL DEFAULT 'rekognition' CHECK (provider IN ('rekognition','fake')),
  collection_id       text NOT NULL UNIQUE,                 -- "mehfil-<env>-<weddingId>"
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleting','deleted')),
  match_threshold     real NOT NULL DEFAULT 95 CHECK (match_threshold BETWEEN 80 AND 99.9),
  backfill_status     text NOT NULL DEFAULT 'none' CHECK (backfill_status IN ('none','running','done')),
  backfill_cursor     uuid,                                 -- last photos.media_id indexed by the backfill
  vectors_delete_at   timestamptz,                          -- wedding end + N days; collection deleted, matches kept
  api_calls           bigint NOT NULL DEFAULT 0,            -- cost metering
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  deletion_report     jsonb                                 -- {facesBefore, collectionGone:true, matchesDeleted, verifiedAt}
);
CREATE INDEX face_collections_vectors_due_idx ON face_collections (vectors_delete_at) WHERE status IN ('active','paused');

-- A guest's opt-in: one selfie face in the collection. Children (age_band='child') cannot enrol.
CREATE TABLE face_enrolments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id          uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  consent_id        uuid NOT NULL REFERENCES consents(id),  -- purpose = 'face_match'
  selfie_media_id   uuid REFERENCES media_objects(id) ON DELETE SET NULL, -- selfie object deleted right after indexing
  provider_face_id  text,                                   -- Rekognition FaceId of the selfie
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','rejected','withdrawn','deleted')),
  reject_reason     text CHECK (reject_reason IN ('no_face','multiple_faces','low_quality','provider_error')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  withdrawn_at      timestamptz,
  deleted_at        timestamptz,                           -- provider face deleted + matches deleted (verified)
  last_matched_at   timestamptz
);
CREATE UNIQUE INDEX face_enrolments_live_uq ON face_enrolments (guest_id) WHERE status IN ('pending','active');
CREATE INDEX face_enrolments_wedding_idx ON face_enrolments (wedding_id, status);
CREATE UNIQUE INDEX face_enrolments_provider_face_uq ON face_enrolments (provider_face_id) WHERE provider_face_id IS NOT NULL;

-- Per-photo indexing state; provider face IDs kept so a hidden/deleted photo's faces can be removed.
CREATE TABLE face_photo_index (
  photo_id          uuid PRIMARY KEY REFERENCES photos(media_id) ON DELETE CASCADE,
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('indexed','no_faces','failed','purged')),
  provider_face_ids text[] NOT NULL DEFAULT '{}',
  face_count        int NOT NULL DEFAULT 0,
  attempts          int NOT NULL DEFAULT 1,
  indexed_at        timestamptz NOT NULL DEFAULT now(),
  purged_at         timestamptz
);
CREATE INDEX face_photo_index_wedding_idx ON face_photo_index (wedding_id, status);

-- Results: which photos an enrolled guest appears in. Kept until withdrawal or gallery deletion
-- (they are what "My photos" shows), even after the collection's vectors are deleted.
CREATE TABLE face_matches (
  enrolment_id      uuid NOT NULL REFERENCES face_enrolments(id) ON DELETE CASCADE,
  photo_id          uuid NOT NULL REFERENCES photos(media_id) ON DELETE CASCADE,
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id          uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  provider_face_id  text NOT NULL,                         -- the photo face that matched
  similarity        real NOT NULL,
  bbox              jsonb,                                 -- {left,top,width,height} 0..1, for a "this is you" highlight
  dismissed_at      timestamptz,                           -- guest tapped "Not me"
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrolment_id, photo_id)
);
CREATE INDEX face_matches_guest_idx ON face_matches (guest_id, created_at DESC) WHERE dismissed_at IS NULL;
CREATE INDEX face_matches_photo_idx ON face_matches (photo_id);
