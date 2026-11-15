-- E20 Languages (L10N). Design: docs/architecture/20-l10n.md
-- References 000-core.sql only (content_translations.entity_type covers 07-msg messages without an FK). Owning module: apps/api/src/modules/l10n.
-- Supported languages: 'en', 'hi', 'kn' (packages/domain SUPPORTED_LANGUAGES; Zod enforces on parties.preferred_language).

-- Per-guest override; effective language = guests.preferred_language ?? parties.preferred_language ?? wedding default.
ALTER TABLE guests
  ADD COLUMN preferred_language text CHECK (preferred_language IN ('en','hi','kn'));

-- Machine-translated (and host-reviewed) copies of host-written text.
-- Polymorphic by design: the owning module of each entity stays the only writer of the source text.
CREATE TABLE content_translations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('event','venue','message','key_contact','wedding','faq')),
  entity_id       uuid NOT NULL,
  field           text NOT NULL,                    -- 'name', 'notes', 'dress_code', 'body_text', 'title'
  language        text NOT NULL CHECK (language IN ('en','hi','kn')),
  source_language text NOT NULL CHECK (source_language IN ('en','hi','kn')),
  source_hash     bytea NOT NULL,                   -- sha256 of the source text this was made from
  text            text NOT NULL,
  status          text NOT NULL DEFAULT 'machine'
                  CHECK (status IN ('machine','approved','edited','stale','failed')),
  provider        text,                             -- 'google_v3', 'fake', null when host-written
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, field, language),
  CHECK (language <> source_language)
);
CREATE INDEX content_translations_review_idx ON content_translations (wedding_id, language, status)
  WHERE status IN ('machine','stale','failed');
CREATE INDEX content_translations_entity_idx ON content_translations (entity_id);

-- Terms that MT must not mangle: couple names, ceremony names, venue names.
-- wedding_id NULL = global seed list (e.g. "Haldi" → "हल्दी"), kept as transliteration, not translation.
CREATE TABLE translation_glossary_terms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid REFERENCES weddings(id) ON DELETE CASCADE,
  source_term   text NOT NULL,
  language      text NOT NULL CHECK (language IN ('hi','kn')),
  target_term   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX glossary_unique_idx
  ON translation_glossary_terms (COALESCE(wedding_id, '00000000-0000-0000-0000-000000000000'::uuid), language, lower(source_term));

-- Monthly MT usage per wedding (characters sent to the provider) for cost caps.
CREATE TABLE translation_usage (
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  month         date NOT NULL,
  characters    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (wedding_id, month)
);
