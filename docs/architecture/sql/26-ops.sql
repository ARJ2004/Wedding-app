-- E26 Scale, reliability and ops (OPS). Design: docs/architecture/26-ops.md
-- Builds on 000-core.sql and 14-prv.sql (platform_staff). Owning module: apps/api/src/modules/ops.
-- Counters only: no names, phones or message text in any of these tables.

-- Per-wedding, per-minute counters, flushed by api and worker processes every 10 s
-- with INSERT ... ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col. Only active minutes get rows.
CREATE TABLE ops_wedding_minute (
  wedding_id        uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  bucket            timestamptz NOT NULL,          -- date_trunc('minute', now())
  msg_queued        int NOT NULL DEFAULT 0,
  msg_sent          int NOT NULL DEFAULT 0,
  msg_delivered     int NOT NULL DEFAULT 0,
  msg_read          int NOT NULL DEFAULT 0,
  msg_failed        int NOT NULL DEFAULT 0,
  msg_sms_fallback  int NOT NULL DEFAULT 0,
  msg_latency_over_2m int NOT NULL DEFAULT 0,      -- delivered later than 120 s after queueing
  otp_sent          int NOT NULL DEFAULT 0,
  otp_failed        int NOT NULL DEFAULT 0,        -- provider failure or wrong-code lockout
  upload_started    int NOT NULL DEFAULT 0,        -- presigned URLs issued
  upload_completed  int NOT NULL DEFAULT 0,
  upload_failed     int NOT NULL DEFAULT 0,        -- complete() rejected, size/type mismatch, never completed
  media_processed   int NOT NULL DEFAULT 0,
  media_failed      int NOT NULL DEFAULT 0,
  api_requests      int NOT NULL DEFAULT 0,
  api_5xx           int NOT NULL DEFAULT 0,
  checkins          int NOT NULL DEFAULT 0,
  sse_peak          int NOT NULL DEFAULT 0,        -- GREATEST() on upsert, not sum
  PRIMARY KEY (wedding_id, bucket)
);
CREATE INDEX ops_wedding_minute_bucket_brin ON ops_wedding_minute USING brin (bucket);

-- Box-wide sample, written once a minute by the worker's ops.sample cron.
CREATE TABLE ops_system_minute (
  bucket                timestamptz PRIMARY KEY,
  q_messaging_depth     int,
  q_messaging_oldest_s  int,                        -- age of oldest queued job: the 2-minute SLO guard
  q_media_depth         int,
  q_media_oldest_s      int,
  q_default_depth       int,
  q_failed_last_min     int,
  db_connections        int,
  db_size_bytes         bigint,
  wal_archive_lag_s     int,                        -- now() - pg_stat_archiver.last_archived_time
  wal_archive_failed    int,                        -- pg_stat_archiver.failed_count (monotonic)
  sse_connections       int,
  live_weddings         int
);

-- Alerts raised by the ops.evaluate cron; one open alert per (wedding, rule).
CREATE TABLE ops_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id     uuid REFERENCES weddings(id) ON DELETE CASCADE,   -- null = system-wide
  rule           text NOT NULL,                     -- 'msg_failure_rate','msg_queue_age','otp_failures',...
  severity       text NOT NULL CHECK (severity IN ('page','warn')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  notified_at    timestamptz,
  acked_by       uuid REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  details        jsonb                              -- numbers only
);
CREATE UNIQUE INDEX ops_alerts_one_open ON ops_alerts
  (COALESCE(wedding_id, '00000000-0000-0000-0000-000000000000'::uuid), rule) WHERE resolved_at IS NULL;
CREATE INDEX ops_alerts_open_idx ON ops_alerts (opened_at DESC) WHERE resolved_at IS NULL;

-- Named engineer(s) per wedding date. The paging tool holds the general rota;
-- this table drives "who is watching this wedding" on the dashboard and alert routing.
CREATE TABLE wedding_ops_watch (
  wedding_id     uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  staff_user_id  uuid NOT NULL REFERENCES platform_staff(user_id) ON DELETE CASCADE,
  watch_role     text NOT NULL CHECK (watch_role IN ('primary','secondary')),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  PRIMARY KEY (wedding_id, watch_role, starts_at),
  CHECK (ends_at > starts_at)
);
CREATE INDEX wedding_ops_watch_time_idx ON wedding_ops_watch (starts_at, ends_at);

-- Deploy freeze windows: deploy script refuses (without --force) when any live event overlaps.
-- Derived from events, so no table; the query lives in infra/scripts/deploy-guard.sql.
