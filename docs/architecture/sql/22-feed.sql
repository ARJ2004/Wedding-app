-- E22 Wedding feed and moderation (FEED). Design: docs/architecture/22-feed.md
-- Depends on: 000-core.sql only. Owning module: apps/api/src/modules/feed.
-- Deliberately small: no comments, no DMs, one reaction per person per post.
-- A "thread" is (wedding_id, event_id); event_id NULL = the wedding-wide "Everyone" thread.

-- Per-wedding switches. Feed is OFF until a host turns it on (see PRD open question in the design).
CREATE TABLE feed_settings (
  wedding_id         uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  mode               text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','wishes_only','full')),
  premoderation      boolean NOT NULL DEFAULT false,      -- guest posts start 'pending' until a host approves
  auto_hold_reports  smallint NOT NULL DEFAULT 3 CHECK (auto_hold_reports BETWEEN 1 AND 20),  -- distinct reporters before auto-hold
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feed_posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id         uuid REFERENCES events(id) ON DELETE CASCADE,          -- null = "Everyone" thread
  kind             text NOT NULL DEFAULT 'post' CHECK (kind IN ('post','wish')),
  audience         text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','hosts')),   -- 'hosts' = private wish to the couple
  author_guest_id  uuid REFERENCES guests(id) ON DELETE CASCADE,
  author_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body             text CHECK (length(body) <= 1000),
  status           text NOT NULL DEFAULT 'visible'
                   CHECK (status IN ('pending','visible','held','hidden')),
                   -- pending: awaiting pre-moderation; held: auto-held by reports; hidden: host hid it
  pinned_at        timestamptz,
  pinned_by        uuid REFERENCES users(id),
  moderated_by     uuid REFERENCES users(id),
  moderated_at     timestamptz,
  source           text NOT NULL DEFAULT 'app' CHECK (source IN ('app','lite_web')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,                                           -- author deleted; row purged by retention job
  -- exactly one author at insert (service); both may be null later if a host account is deleted
  CHECK (author_guest_id IS NULL OR author_user_id IS NULL),
  CHECK (kind = 'wish' OR audience = 'all'),
  CHECK (pinned_at IS NULL OR status = 'visible')
);
-- Guest thread read: newest visible posts in one thread, cursor (created_at, id).
CREATE INDEX feed_posts_thread_idx ON feed_posts (wedding_id, event_id, created_at DESC, id DESC)
  WHERE status = 'visible' AND deleted_at IS NULL AND audience = 'all';
-- Pinned strip (max 3 per thread, enforced in service).
CREATE INDEX feed_posts_pinned_idx ON feed_posts (wedding_id, event_id) WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;
-- Host moderation queue and wishes tab.
CREATE INDEX feed_posts_queue_idx ON feed_posts (wedding_id, status, created_at DESC)
  WHERE status IN ('pending','held') AND deleted_at IS NULL;
CREATE INDEX feed_posts_wishes_idx ON feed_posts (wedding_id, created_at DESC) WHERE kind = 'wish' AND deleted_at IS NULL;
CREATE INDEX feed_posts_author_guest_idx ON feed_posts (author_guest_id) WHERE author_guest_id IS NOT NULL;

-- Photos on a post (max 4) and, later, a video wish (WSH-01). Media rows are core media_objects.
CREATE TABLE feed_post_media (
  post_id     uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  wedding_id  uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  position    smallint NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (post_id, position),
  UNIQUE (media_id)
);

-- One reaction per person per post; changing emoji is an UPDATE. Fixed emoji set (validated in Zod).
CREATE TABLE feed_reactions (
  post_id      uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  wedding_id   uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  reactor_type text NOT NULL CHECK (reactor_type IN ('guest','user')),
  reactor_id   uuid NOT NULL,                       -- guests.id or users.id (polymorphic: cleaned up by guest-deletion job)
  emoji        text NOT NULL CHECK (emoji IN ('heart','laugh','clap','fire','pray','wow')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, reactor_type, reactor_id)
);
CREATE INDEX feed_reactions_reactor_idx ON feed_reactions (reactor_type, reactor_id);

CREATE TABLE feed_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id     uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  post_id        uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  reporter_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  reporter_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason         text NOT NULL CHECK (reason IN ('offensive','private','spam','other')),
  note           text CHECK (length(note) <= 300),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id),
  resolution     text CHECK (resolution IN ('kept','hidden')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feed_reports_one_per_guest ON feed_reports (post_id, reporter_guest_id) WHERE reporter_guest_id IS NOT NULL;
CREATE INDEX feed_reports_open_idx ON feed_reports (wedding_id, created_at DESC) WHERE resolved_at IS NULL;
