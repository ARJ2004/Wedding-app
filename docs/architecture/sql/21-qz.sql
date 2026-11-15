-- E21 Couple quiz (QZ). Design: docs/architecture/21-qz.md
-- Depends on: 000-core.sql only. Owning module: apps/api/src/modules/quiz.
-- Live and async plays are both "sessions" so scoring and leaderboards share one code path.

-- ── Builder (QZ-01) ───────────────────────────────────────────────────────────
CREATE TABLE quizzes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id         uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  event_id           uuid REFERENCES events(id) ON DELETE SET NULL,     -- usually the Sangeet; used for copy + who can join
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
  default_time_limit_s int NOT NULL DEFAULT 20 CHECK (default_time_limit_s BETWEEN 5 AND 120),
  speed_bonus        boolean NOT NULL DEFAULT true,                     -- off = only correctness counts (kinder to elders / bad network)
  async_enabled      boolean NOT NULL DEFAULT false,
  async_opens_at     timestamptz,
  async_closes_at    timestamptz,                                       -- also closed automatically when a live session starts
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (async_closes_at IS NULL OR async_opens_at IS NULL OR async_closes_at > async_opens_at)
);
CREATE INDEX quizzes_wedding_idx ON quizzes (wedding_id) WHERE status <> 'archived';

CREATE TABLE quiz_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  quiz_id       uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position      int NOT NULL CHECK (position >= 0),
  kind          text NOT NULL DEFAULT 'mcq' CHECK (kind IN ('mcq','image_mcq')),   -- image_mcq: options are pictures
  prompt        text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 300),
  prompt_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,          -- optional picture on the question
  -- translations: L10N content_translations (entity_type 'quiz_question' / 'quiz_option'; needs 20-l10n CHECK extended)
  time_limit_s  int CHECK (time_limit_s BETWEEN 5 AND 120),                       -- null = quiz default
  points        int NOT NULL DEFAULT 1000 CHECK (points BETWEEN 0 AND 5000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quiz_id, position) DEFERRABLE INITIALLY DEFERRED                       -- reorder in one transaction
);

CREATE TABLE quiz_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  position      smallint NOT NULL CHECK (position BETWEEN 0 AND 5),               -- 2..6 options, rendered A–F
  label         text CHECK (length(label) <= 80),
  media_id      uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  is_correct    boolean NOT NULL DEFAULT false,
  UNIQUE (question_id, position) DEFERRABLE INITIALLY DEFERRED,
  CHECK (label IS NOT NULL OR media_id IS NOT NULL)
);
CREATE UNIQUE INDEX quiz_options_one_correct ON quiz_options (question_id) WHERE is_correct;

-- ── Plays (QZ-02 live, QZ-03 async) ───────────────────────────────────────────
CREATE TABLE quiz_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id          uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  quiz_id             uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('live','async')),
  -- live state machine: lobby → question_open → question_closed → revealed → (leaderboard) → … → ended
  status              text NOT NULL DEFAULT 'lobby'
                      CHECK (status IN ('lobby','question_open','question_closed','revealed','leaderboard','ended')),
  join_code           text NOT NULL,                       -- 6 chars, shown on the projector QR; scoped to the wedding
  current_question_id uuid REFERENCES quiz_questions(id) ON DELETE SET NULL,
  current_opens_at    timestamptz,                         -- server clock; includes the "get ready" lead-in
  current_closes_at   timestamptz,                         -- opens_at + time limit; answers accepted until closes_at + grace
  state_version       int NOT NULL DEFAULT 0,              -- bumped on every transition; clients drop stale SSE events
  started_by          uuid REFERENCES users(id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  CHECK (kind = 'live' OR status IN ('lobby','ended'))     -- async sessions have no shared state machine
);
CREATE UNIQUE INDEX quiz_sessions_one_open_live ON quiz_sessions (quiz_id) WHERE kind = 'live' AND status <> 'ended';
CREATE UNIQUE INDEX quiz_sessions_one_async ON quiz_sessions (quiz_id) WHERE kind = 'async';
CREATE UNIQUE INDEX quiz_sessions_join_code ON quiz_sessions (wedding_id, join_code) WHERE status <> 'ended';

-- Projector screens pair like a TV app: the screen page shows a code, the host types it in the app.
-- Not wedding-scoped until paired (wedding_id is null before pairing).
CREATE TABLE quiz_screens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_code_hash  bytea NOT NULL,                        -- sha256(code); code lives 10 min
  secret_hash        bytea NOT NULL UNIQUE,                 -- sha256 of the screen's bearer secret (kept in page memory + cookie)
  wedding_id         uuid REFERENCES weddings(id) ON DELETE CASCADE,
  session_id         uuid REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  paired_by          uuid REFERENCES users(id),
  paired_at          timestamptz,
  expires_at         timestamptz NOT NULL,                  -- 10 min unpaired; 12 h once paired
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((session_id IS NULL) = (wedding_id IS NULL))
);
CREATE INDEX quiz_screens_pairing_idx ON quiz_screens (pairing_code_hash) WHERE session_id IS NULL;
CREATE INDEX quiz_screens_expiry_idx ON quiz_screens (expires_at);

CREATE TABLE quiz_players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id      uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  guest_id        uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 24),  -- defaults to first name; editable
  total_score     int NOT NULL DEFAULT 0,
  correct_count   int NOT NULL DEFAULT 0,
  total_elapsed_ms bigint NOT NULL DEFAULT 0,             -- tie-break: faster total wins
  joined_at       timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,                             -- async only
  removed_at      timestamptz,                             -- host removed (rude name etc.); answers rejected, off leaderboard
  UNIQUE (session_id, guest_id)
);
-- Leaderboard: top N and "my rank" (count of players strictly ahead).
CREATE INDEX quiz_players_leaderboard_idx ON quiz_players (session_id, total_score DESC, total_elapsed_ms ASC)
  WHERE removed_at IS NULL;
CREATE INDEX quiz_players_guest_idx ON quiz_players (guest_id);

CREATE TABLE quiz_answers (
  player_id     uuid NOT NULL REFERENCES quiz_players(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  wedding_id    uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  option_id     uuid REFERENCES quiz_options(id) ON DELETE SET NULL,  -- null = shown but not answered (async timeout)
  shown_at      timestamptz,                               -- async: server time the question was served (set once)
  received_at   timestamptz,                               -- server time the answer arrived; first answer wins
  elapsed_ms    int CHECK (elapsed_ms >= 0),
  is_correct    boolean,                                   -- filled when the question is scored
  points        int,
  PRIMARY KEY (player_id, question_id)
);
-- Scoring and the answer distribution on reveal: all answers to one question in one session.
CREATE INDEX quiz_answers_session_question_idx ON quiz_answers (session_id, question_id);
