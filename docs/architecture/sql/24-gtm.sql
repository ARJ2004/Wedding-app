-- E24 Self-serve onboarding and site (GTM). Design: docs/architecture/24-gtm.md
-- References 000-core.sql only. Owning modules: onboarding (onboarding_sessions),
-- analytics (analytics_events, users.analytics_opt_out), marketing (marketing_leads).

-- ── Product-analytics consent for hosts (DPDP: opt-out toggle in Settings, notice at sign-up) ──
ALTER TABLE users
  ADD COLUMN analytics_opt_out boolean NOT NULL DEFAULT false;

-- ── Onboarding wizard progress (GTM-01) ───────────────────────────────────────
-- Lets the wizard resume on another device and measures time-to-first-invite.
CREATE TABLE onboarding_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wedding_id      uuid REFERENCES weddings(id) ON DELETE CASCADE,       -- set after step "create"
  current_step    text NOT NULL DEFAULT 'create'
                  CHECK (current_step IN ('create','events','guests','review','invite','done')),
  completed_steps text[] NOT NULL DEFAULT '{}',
  import_source   text CHECK (import_source IN ('contacts','file','sheet','manual')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  first_invite_sent_at timestamptz,
  completed_at    timestamptz,
  abandoned_at    timestamptz,                                           -- no activity for 7 days (job)
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- At most one open wizard per user.
CREATE UNIQUE INDEX onboarding_one_open_uq ON onboarding_sessions (user_id)
  WHERE completed_at IS NULL AND abandoned_at IS NULL;
CREATE UNIQUE INDEX onboarding_wedding_uq ON onboarding_sessions (wedding_id) WHERE wedding_id IS NOT NULL;

-- ── First-party analytics events (app, server, marketing beacon) ──────────────
-- Pseudonymous: actor_hash = HMAC-SHA256(ANALYTICS_KEY, user_id) for hosts; guests and site
-- visitors have no actor id at all. props is allow-listed per event name (Zod) and never holds
-- names, phones, emails or free text. Monthly partitions; dropped after 13 months.
CREATE TABLE analytics_events (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  name         text NOT NULL CHECK (name ~ '^[a-z]+(\.[a-z_]+)+$'),   -- 'onboarding.step_completed'
  source       text NOT NULL CHECK (source IN ('app_host','app_guest','lite_web','site','server')),
  actor_hash   bytea,
  wedding_id   uuid,                                                  -- no FK: partitioned + survives as aggregate; nulled by PRV erasure job
  session_id   uuid,                                                  -- random per app launch / site visit, not persisted across days
  platform     text CHECK (platform IN ('android','ios','web')),
  app_version  text,
  props        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at),
  CHECK (source IN ('app_host','server') OR actor_hash IS NULL)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX analytics_events_name_idx ON analytics_events (name, occurred_at);
CREATE INDEX analytics_events_wedding_idx ON analytics_events (wedding_id, occurred_at) WHERE wedding_id IS NOT NULL;

-- Partitions are created ahead by cron job gtm.analytics.partitions (next 2 months).
CREATE TABLE analytics_events_2027_06 PARTITION OF analytics_events FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE analytics_events_2027_07 PARTITION OF analytics_events FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE analytics_events_default PARTITION OF analytics_events DEFAULT;   -- safety net; alert if non-empty

-- ── Marketing leads (demo booking / planner enquiries, GTM-02) ───────────────
CREATE TABLE marketing_leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('demo','planner_enquiry','family_question')),
  name               text NOT NULL CHECK (length(name) <= 100),
  email              citext,
  phone_e164         text,
  company            text,
  city               text,
  weddings_per_year  int CHECK (weddings_per_year BETWEEN 0 AND 1000),
  message            text CHECK (length(message) <= 2000),
  utm                jsonb NOT NULL DEFAULT '{}'::jsonb,              -- utm_source/medium/campaign only
  consent_contact_at timestamptz NOT NULL,                            -- checkbox: "contact me about this request"
  consent_marketing_at timestamptz,                                   -- separate, optional
  notice_version     text NOT NULL,
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','won','lost','spam')),
  delete_after       timestamptz NOT NULL DEFAULT now() + interval '12 months',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);
CREATE INDEX marketing_leads_created_idx ON marketing_leads (created_at DESC);
CREATE INDEX marketing_leads_delete_idx ON marketing_leads (delete_after);
