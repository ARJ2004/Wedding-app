-- E27 P2 candidates (VOX / WSH / WL / PWP). Design: docs/architecture/27-p2.md
-- Depends on: 000-core.sql, 22-feed.sql (video wishes are feed_posts kind='wish' with a video in feed_post_media).
-- Lighter-weight designs: tables are the minimum each candidate needs; refine when the story is picked at Gate 3.

-- ── Shared: rendered audio/video outputs (VOX-02 voice-note video, WSH-01 wish reel, PWP-01 thank-you reel) ──
CREATE TABLE video_renders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('voice_note_video','wish_reel','thank_you_reel','tts_audio')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','done','failed','cancelled')),
  input           jsonb NOT NULL,                    -- media ids, ordering, text, music track id, language
  output_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  error           text,
  requested_by    uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX video_renders_wedding_idx ON video_renders (wedding_id, created_at DESC);

-- ── VOX-01 voice calls ────────────────────────────────────────────────────────
CREATE TABLE voice_campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id     uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('rsvp_chase','update')),
  event_ids      uuid[] NOT NULL DEFAULT '{}',        -- rsvp_chase: up to 3 events asked in one call
  script         jsonb NOT NULL,                      -- per language: text + tts_audio media id
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','done','cancelled')),
  window_start   time NOT NULL DEFAULT '10:00',        -- calling window in wedding timezone (TRAI: never 21:00–09:00)
  window_end     time NOT NULL DEFAULT '20:00',
  max_attempts   smallint NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start >= '09:00' AND window_end <= '21:00' AND window_end > window_start)
);

CREATE TABLE voice_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  campaign_id       uuid NOT NULL REFERENCES voice_campaigns(id) ON DELETE CASCADE,
  guest_id          uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  language          text NOT NULL,
  attempt           smallint NOT NULL DEFAULT 1,
  provider          text NOT NULL,                    -- 'exotel' | 'plivo' | 'fake'
  provider_call_id  text,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','ringing','answered','no_answer','busy','failed','completed')),
  keypresses        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"event_id": "...", "digit": "1"}]
  duration_s        int,
  cost_paise        bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, guest_id, attempt)              -- idempotent fan-out
);
CREATE UNIQUE INDEX voice_calls_provider_idx ON voice_calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX voice_calls_campaign_status_idx ON voice_calls (campaign_id, status);

-- ── WL-01 custom domains for the guest lite web ───────────────────────────────
CREATE TABLE custom_domains (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hostname         citext NOT NULL UNIQUE CHECK (hostname ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  verify_token     text NOT NULL,                     -- expected in a TXT record _mehfil.<hostname>
  status           text NOT NULL DEFAULT 'pending_dns'
                   CHECK (status IN ('pending_dns','verified','active','failed','removed')),
  verified_at      timestamptz,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_domains_org_idx ON custom_domains (organization_id);

-- ── PWP-01 post-wedding pack orders ───────────────────────────────────────────
CREATE TABLE pwp_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item            text NOT NULL CHECK (item IN ('album_export','printed_album','thank_you_reel')),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','paid','in_production','sent_to_partner','shipped','delivered','cancelled','refunded')),
  selection       jsonb NOT NULL DEFAULT '{}'::jsonb, -- chosen media ids, layout, cover text, size
  output_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,   -- print-ready PDF / zip / reel
  partner         text,                               -- print partner key
  partner_ref     text,
  amount_paise    bigint CHECK (amount_paise >= 0),
  billing_ref     text,                               -- BIL add-on payment id
  shipping        jsonb,                              -- address; deleted 30 days after delivery
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pwp_orders_wedding_idx ON pwp_orders (wedding_id, created_at DESC);
