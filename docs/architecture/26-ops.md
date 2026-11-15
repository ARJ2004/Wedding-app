# E26 — Scale, reliability and ops (OPS)

Status: design for review · Owner module: `apps/api/src/modules/ops` + `infra/` · SQL: [`sql/26-ops.sql`](./sql/26-ops.sql)

## 1. Summary

Makes the one-box Mehfil deployment survive real wedding days and tells us, with numbers, when one box stops being enough.

- **Load tests (k6)** for the PRD targets: 2,000-guest announcement (95% delivered < 2 min), 300 photo uploads/min, 50 live weddings, SSE connection counts.
- **Capacity estimate** for one EC2 box with Postgres on it, and **explicit trigger points** for RDS, a second API box and Redis.
- **Per-wedding live dashboard** and alerting — the simplest thing that works: counters in Postgres, an internal `/admin/ops` page, CloudWatch for the box, an external uptime/paging service.
- **Status page and on-call** for wedding dates, with a deploy freeze during live events.
- **Backups and PITR** with pgBackRest (WAL archiving to S3) plus the baseline's encrypted nightly `pg_dump`; **DR drill** with measured RTO/RPO.
- **Device test lab** for the React Native app and the guest lite web.

| Story | Backlog sprint | Proposed |
| --- | --- | --- |
| OPS-01 Load tests | S14 first pass, S21 full | S14 (harness + first pass, 01a), S21 (peak, 01b) |
| OPS-02 Status page and on-call | S15 | **S9** (first pilot is in S9; paging is needed before it) |
| OPS-03 Per-wedding live dashboard (P0\*) | S9 | S9 |
| OPS-04 Device test lab (P0\*) | S9 | split: 04a devices + manual checklist **S4**, 04b automated smoke **S9** |
| OPS-05 Autoscaling and CDN tuning | S17 | S17 (reinterpreted) |
| OPS-06 Backup and DR drill | S17 / S24 | **first drill S9** (before real pilot data), repeat S24 |
| OPS-07 Season hot standby (new) | — | S21 (PO decision) |

**Stack reinterpretation:** the backlog assumes ECS autoscaling, ElastiCache, RDS PITR and a PWA tested in browsers. Under the baseline: no autoscaling (one box, resized vertically, worker concurrency tuned), no Redis until a trigger fires, PITR via pgBackRest on the self-hosted Postgres, and a device matrix for the bare RN app plus the lite web page.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Live dashboard | Per-wedding counters flushed to Postgres (`ops_wedding_minute`), server-rendered `/admin/ops` page auto-refreshing every 15 s | Prometheus + node/pg exporters + Grafana on the box | Two more services to run, patch and secure on the same box; they die with the box; ~1 GB RAM. Counters in Postgres answer the actual question ("is this wedding's messaging OK?") with one indexed query. |
| Box metrics | CloudWatch agent (CPU, memory, disk, nofile) + alarms → SNS | Self-hosted exporters | Off-box, survives the box, near-zero ops. |
| Uptime, status page, paging | One hosted service (e.g. Better Stack Uptime: monitors + status page + phone/SMS on-call) | PagerDuty + Statuspage; self-hosted Uptime Kuma | One vendor, low cost, and it must live off the box to report the box being down. Vendor is a PO pick. |
| Backups / PITR | **pgBackRest** to S3 (weekly full, daily diff, continuous WAL, `archive_timeout=60s`) **plus** nightly `pg_dump | age` to an Object-Locked bucket | wal-g; RDS | pgBackRest is in the PGDG apt repo, has repo encryption, `check`/`verify`/`expire`, parallel restore. The logical dump is immutable (ransomware-safe) and is the RDS migration path. |
| Load test tool | **k6** with `xk6-sse` for SSE; run from a separate load-generator EC2 in `ap-south-1` | Locust, Artillery | Requested; JS like the codebase; good thresholds/reporting. |
| WhatsApp in load tests | `LatencyFakeProvider` (configurable latency, failure rate, async delivered/read webhooks) + one small real send to 50 test phones | Real BSP at 2,000 messages | Real sends cost money, hit the Meta tier limit and test Meta, not us. |
| Scaling path | Vertical first (resize instance), then RDS, then second API box behind an ALB, then Redis | ECS / autoscaling now | Fewest moving parts until a measured trigger. |
| Season availability | Hot standby (streaming replica on a 2nd small EC2, other AZ) during Oct–Feb, promoted manually | Accept single box all year; RDS Multi-AZ now | 99.9% on wedding dates is not credible with one box and a 60-min restore. A standby gives ~10-min failover for ~₹4–5k/month in season. |
| Device automation | **Maestro** flows on physical devices + Firebase Test Lab / BrowserStack for breadth | Detox | Maestro is YAML, black-box, works on release builds, little test-ID plumbing. |

## 3. Data model

Schema: [`sql/26-ops.sql`](./sql/26-ops.sql) (references `platform_staff` from `14-prv.sql`). **Schema check passed** (`scripts/check-schema.sh arch_ops 000-core.sql 14-prv.sql 26-ops.sql` → `OK: 29 tables`). EXPLAIN on 200k minute rows: the per-wedding 2-hour dashboard query uses the primary key `(wedding_id, bucket)`.

| Table | Purpose | Notes |
| --- | --- | --- |
| `ops_wedding_minute` | Counters per wedding per minute: messages queued/sent/delivered/read/failed, SMS fallback, deliveries > 2 min, OTP sent/failed, uploads started/completed/failed, media processed/failed, API requests/5xx, check-ins, SSE peak | Written by `metrics.flush()` every 10 s per process with additive upsert (`sse_peak` uses `GREATEST`). Only active minutes get rows: 50 weddings × 1,440 = 72k rows/day max. Retention 30 days (deleted by `ops.prune`). BRIN on `bucket` for prune and cross-wedding scans. |
| `ops_system_minute` | Box-wide sample once a minute: queue depth and **oldest job age** per pg-boss queue, failed jobs, DB connections and size, WAL archive lag/failures, SSE connections, live weddings | 43k rows/month; retention 90 days. |
| `ops_alerts` | Open/resolved alerts from rule evaluation; one open per (wedding, rule) | Dedupe + re-notify every 15 min while open and unacked. |
| `wedding_ops_watch` | Named primary/secondary engineer per wedding date window | Shown on the dashboard; per-wedding alerts page this person first. |

No personal data in any OPS table.

## 4. API

Admin endpoints are for `platform_staff` (roles in brackets) and live under `/v1/admin`; the dashboard pages are server-rendered under `/admin` (same API process, like the guest lite web).

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | uptime monitor, Nginx | Liveness: process up | — |
| GET | `/readyz` | uptime monitor, deploy script | DB reachable, pg-boss running, last worker heartbeat < 90 s, disk < 90% | 503 with failing check names |
| GET | `/admin/login` → Google web OAuth → `/admin/ops` | platform_staff | Cookie session (httpOnly, `SameSite=Strict`, 8 h) | 404 for non-staff |
| GET | `/admin/ops` | platform_staff (ops, admin, support) | Live weddings grid: traffic-light per wedding, open alerts, queue ages, box sample | — |
| GET | `/admin/ops/weddings/:weddingId` | platform_staff | One wedding: 2-hour sparkline per counter, failure drill-down **by code** (no phone numbers), watcher, upcoming events | 404 |
| GET | `/v1/admin/ops/weddings/live` | platform_staff | JSON behind the grid | — |
| GET | `/v1/admin/ops/weddings/:weddingId/minutes?from=&to=` | platform_staff | Counter series | `OPS_RANGE_TOO_LARGE` 400 (> 48 h) |
| POST | `/v1/admin/ops/alerts/:id/ack` | platform_staff (ops, admin) | Acknowledge | `OPS_ALERT_RESOLVED` 409 |
| PUT | `/v1/admin/ops/weddings/:weddingId/watch` | platform_staff (admin) | Set primary/secondary watchers | — |
| GET | `/v1/admin/ops/deploy-guard` | deploy script (token in SSM) | `{ allowed: false, reason: "Sangeet live: Sharma–Iyer until 23:30 IST" }` | — |

Example `GET /v1/admin/ops/weddings/live`:
```json
{ "asOf": "2027-04-24T15:31:00Z",
  "weddings": [ { "weddingId": "…", "title": "Ananya & Rohan", "liveEvent": "Sangeet", "health": "amber",
      "last5m": { "msgSent": 1840, "msgFailed": 22, "msgOver2m": 31, "uploadsCompleted": 512, "uploadFailed": 4,
                  "otpFailed": 1, "api5xx": 0, "ssePeak": 412 },
      "openAlerts": [ { "rule": "msg_latency", "severity": "warn", "openedAt": "…" } ],
      "watch": { "primary": "Eng A", "secondary": "Eng B" } } ],
  "system": { "qMessagingOldestS": 14, "qMediaOldestS": 38, "dbConnections": 61, "walArchiveLagS": 22, "sseConnections": 2310 } }
```

## 5. Jobs, events and realtime

### Metrics collection

`apps/api/src/common/metrics.ts` — `metrics.inc(weddingId, 'msg_failed', n = 1)` and `metrics.gauge(weddingId, 'sse_peak', v)`. In-memory map, flushed every 10 s in one multi-row upsert; also flushed on SIGTERM. A crash loses ≤ 10 s of counters (acceptable). Call sites are owned by each module (MSG status callbacks, CAM complete/process, ACC OTP, ARR check-in, SSE hub, an Express middleware for requests/5xx on `/v1/weddings/:weddingId/*` and `/g/*`).

### pg-boss crons (`default` queue unless noted)

| Job | Schedule | Does |
| --- | --- | --- |
| `ops.sample` | every minute | Reads `pgboss.job` (depth, oldest `created_on` per queue, failed), `pg_stat_activity`, `pg_database_size`, `pg_stat_archiver`; SSE count from each API process via `NOTIFY ops_sse_report` replies; writes `ops_system_minute`; heartbeat for `/readyz` |
| `ops.evaluate` | every minute | Applies the alert rules below over the last 5 minutes; opens/resolves `ops_alerts`; sends new/unacked alerts to the paging webhook |
| `ops.prune` | daily 04:15 IST | Deletes minute rows > 30 d / 90 d, resolved alerts > 180 d |
| `ops.backup.check` | daily 09:00 IST | Confirms last pgBackRest backup and last dump object exist and are < 26 h old (`pgbackrest info --output=json`, S3 `HeadObject`) |

pg-boss's own `monitor-states` is not used for alerting (runs inside the process we're monitoring); `ops.sample` is, and **a missing `ops.sample` heartbeat is itself caught externally** by the uptime monitor hitting `/readyz`.

### Alert rules

"Live window" = wedding `status = 'live'` and now within an event's `starts_at − 6 h` to `ends_at + 3 h`. Outside the window, `page` downgrades to `warn` (business hours only).

| Rule | Condition (5-min window) | Severity |
| --- | --- | --- |
| `msg_queue_age` | `q_messaging_oldest_s > 60` (system) | page — the 2-min SLO is at risk |
| `msg_latency` | `msg_latency_over_2m / msg_delivered > 5%` with ≥ 50 delivered | warn → page if 15 min |
| `msg_failure_rate` | `msg_failed / (msg_sent + msg_failed) > 5%` with ≥ 20 | page |
| `otp_failures` | `otp_failed / otp_sent > 20%` with ≥ 10 | page — guests locked out |
| `upload_failure_rate` | `upload_failed / upload_started > 10%` with ≥ 20 | warn |
| `media_lag` | `q_media_oldest_s > 300` | warn → page at 900 |
| `api_5xx` | `api_5xx / api_requests > 2%` with ≥ 100 | page |
| `wal_archive` | `wal_archive_lag_s > 600` or `failed_count` increased | page (PITR broken) |
| `backup_missing` | `ops.backup.check` fails | warn |
| `prv_sla` | data request due in < 48 h (from PRV) | warn |
| CloudWatch (off-box) | CPU > 85% 10 min; memory > 90%; disk > 80% (warn) / 90% (page); status check failed | page via SNS |
| Uptime (off-box) | `/readyz` and `/g/health` fail 2 checks from 2 regions | page |

### Realtime

The SSE hub reports connection counts per wedding to metrics. No new channels.

## 6. Mobile app

OPS adds no guest screens. Two app-side pieces:

- **Sentry release health** (crash-free sessions per app version, by device class) — the device lab release gate uses it.
- A hidden **diagnostics screen** (Settings → About → tap version 7×): app version, API base, network type, upload queue length, last sync — for support calls on a wedding day. No PII shown beyond the user's own name.

### Device test lab (OPS-04)

| Tier | Device (or equivalent) | OS | RAM | Why |
| --- | --- | --- | --- | --- |
| Budget Android (floor) | Samsung Galaxy A10 / M10 class | **Android 9** | 2 GB | PRD floor; cold start < 3 s, camera < 2 s |
| Budget Android (common) | Redmi 9A / A2 class | Android 10–13 (Go-ish) | 2–3 GB | Most common budget profile among older guests |
| Mid Android | Galaxy M14 / Redmi Note 12 class | Android 13–14 | 4–6 GB | Desk-staff phone |
| Recent Android | Pixel 7a class | Android 15+ | 8 GB | Photo picker, notification permission, edge-to-edge |
| Android tablet | Galaxy Tab A8 class | Android 13+ | 3–4 GB | Desk check-in, arrivals board (DSN-04) |
| Old iPhone (floor) | iPhone 7 / 8 | **iOS 15.x** | 2 GB | PRD floor (confirm RN 0.88 minimum iOS — see risks) |
| Mid iPhone | iPhone SE 3 / 11 | iOS 17–18 | 3–4 GB | |
| Recent iPhone | iPhone 13+ | latest iOS | | |
| Lite web | Android 9 Chrome; iOS 15 Safari; KaiOS not supported | | | No-install path |

Bought devices: the two budget Androids, the tablet and the iPhone 7/8 (~₹40–50k total). The rest via **Firebase Test Lab** (Android, Maestro-compatible) and **BrowserStack App Live** for spot checks.

**Release smoke (Maestro, ~15 min per device, run on the four owned devices every release):** guest link open → OTP (dev code on staging) → consent → schedule → RSVP → travel form → camera opens and shoots 3 → airplane mode → 3 more → reconnect, uploads drain → gallery; host: dev sign-in → guest list search → send announcement → arrivals board updates → QR check-in. Throttled network via Android `adb` network profile / iOS Network Link Conditioner "3G" and "Very Bad Network". Measured: cold start, camera open, JS frame drops (Perf Monitor), memory at gallery scroll (no OOM on 2 GB).

**Release gate:** smoke green on all owned devices; crash-free sessions ≥ 99.5% on the previous release in Sentry; cold start < 3 s on the A10.

## 7. Guest lite web

Applicable for monitoring and testing only: the uptime monitor probes `/g/health` (renders the lite template without data), the device matrix includes Android 9 Chrome and iOS 15 Safari, and the load test includes lite-web page views (guests without the app open WhatsApp links into it).

## 8. Security and privacy

- `/admin` requires Google web OAuth + `platform_staff` membership; Google Workspace enforces 2FA for staff accounts; session cookie 8 h; CSRF token on POSTs; every `/admin` page view audit-logged (`ops.view`, `wedding_id`).
- Dashboard shows **counts and error codes only** — staff never see guest names, phones or message bodies there. Wedding title is shown (needed to talk to the planner).
- Status page lists components (Messaging, Uploads, Guest links, Host app), never wedding or customer names.
- Load tests use synthetic weddings with phone numbers in a reserved fake range (`+91 99999 0xxxx`), on the **staging** box only; production is never load-tested.
- DR drills restore into an isolated, short-lived instance in a separate VPC/security group with no inbound except SSM; destroyed after the drill. **Production data is never restored into staging** used by developers.
- Backup encryption, IAM and key custody: see [14-prv.md §8](./14-prv.md#8-security-and-privacy).

## 9. Scale and performance

### Recommended box

| Item | Choice | Notes |
| --- | --- | --- |
| Instance | `m7g.xlarge` (4 vCPU Graviton3, 16 GiB), `ap-south-1` | sharp, Node 22, Postgres 16, pgBackRest all have arm64 builds. Vertical step: `m7g.2xlarge` (8/32) in minutes. |
| Volumes | root gp3 30 GB; **separate gp3 200 GB for `/var/lib/postgresql`** (3,000 IOPS / 125 MB/s baseline) | Separate volume: snapshot/move independently; can raise IOPS online. |
| Processes (PM2) | `api` cluster × 3, `worker` × 1 (queues: messaging concurrency 20, media concurrency 2 with `sharp.concurrency(1)`, default 5) | Leaves ~1 vCPU for Postgres under peak. |
| Postgres | `shared_buffers=4GB`, `effective_cache_size=10GB`, `work_mem=16MB`, `max_connections=150`, `wal_level=replica`, `archive_mode=on`, `archive_timeout=60`, `max_wal_size=4GB`, `checkpoint_timeout=15min`, `pg_stat_statements`, `log_min_duration_statement=500ms`; autovacuum `scale_factor=0.01` on `pgboss.job` | |
| Nginx | `worker_connections 8192`, `LimitNOFILE=65535` (Nginx + PM2), SSE location: `proxy_buffering off`, `proxy_read_timeout 1h`, HTTP/1.1 keep-alive upstream | Each SSE client = 2 sockets at Nginx. |

### Capacity estimate at the PRD peak (all at once — a worst case)

| Workload | Assumption | CPU | Memory | DB |
| --- | --- | --- | --- | --- |
| 2,000-guest announcement | ~1,300 phones; MSG fan-out enqueues batch jobs of 50 recipients (not 2,000 jobs); BSP call ~300 ms | 20 in-flight sends ≈ 60 msg/s ≈ 0.3 vCPU | small | ~3 writes per message (delivery row + status callbacks) ≈ 200 writes/s burst |
| 5 such announcements concurrently (different weddings) | 6,500 messages | 0.5 vCPU | small | 600 writes/s for ~2 min — fine on gp3 |
| 300 uploads/min | App resizes to ≤ 2,048 px (≈ 600 KB) before upload (CAM); sharp makes 2 WebP sizes ≈ 150 ms each | 5/s × 0.3 s ≈ **1.5 vCPU** — media concurrency 2 caps it at 2 vCPU and lets the queue absorb bursts | ~400 MB worker | trivial |
| 50 live weddings, API | ~20 req/s average, 150 req/s bursts after an announcement (2,000 guests opening the app) | ~1 vCPU across 3 API processes | 3 × 300 MB | p95 query < 20 ms with indexes |
| SSE | 50 weddings × 10 boards + one live quiz with 500 players + host apps ≈ **1,500–3,000** connections | idle; ~50 KB each | ~150 MB | LISTEN connection per API process; NOTIFY ≤ 200/s |
| Postgres | 10–30 GB data in season | ~1 vCPU peak | 4 GB buffers + page cache | ~70 connections (3×15 API, 15 worker, 6 pg-boss, 3 LISTEN) |
| **Total** | | **~4 vCPU peak** → on the limit of `m7g.xlarge`; fine at realistic load (peaks don't coincide) | ~8 GB used | |

Conclusion: one `m7g.xlarge` should carry the November 2027 season **if** the app resizes photos before upload and MSG batches fan-out jobs. The S21 load test confirms or forces the next step. **The hard ceiling is not the box but the WhatsApp sender tier**: Meta limits business-initiated conversations per 24 h per number (1k → 10k → 100k unique users) and throughput (~80 msg/s default). 50 weddings × 2,000 guests = 100k unique users/day needs the top tier before the season — a VAL item.

### Trigger points

| Move | Trigger (any one) |
| --- | --- |
| **Resize box** (`m7g.2xlarge`) | CPU > 70% for 15 min on a wedding day; or load test p95 API latency > 500 ms; or media queue oldest job > 5 min at 300 uploads/min |
| **Postgres → RDS** (Multi-AZ, `db.m7g.large`+) | DB CPU > 50% at target load in the load test; or DR drill RTO > 60 min; or data > 150 GB; or a second API box is needed (the DB must leave the box first); or > 10 live weddings on the same day become normal (paying planners need managed failover); or DBA chores (vacuum, upgrades, backup checks) > 2 h/week |
| **Second API box** (ALB, both stateless, DB on RDS) | API CPU > 70% after resize; or availability target needs no single box (contractual SLA); or SSE connections > 10k. SSE fan-out already crosses boxes via Postgres `LISTEN/NOTIFY`. Rate limits must move to a shared store (see Redis). |
| **Separate worker box** | Media processing starves API CPU (API p95 doubles during upload bursts) |
| **Redis** | Shared rate-limit state across > 1 API box; or pg-boss sustained > 300 jobs/s or `pgboss.job` bloat pushes DB CPU > 30%; or `NOTIFY` > 1,000/s or payloads near the 8 KB limit; or a hot cache is needed for guest-home reads (> 500 req/s). Until then: in-memory rate limits per process for coarse limits, **Postgres-backed counters for OTP/link lockouts** (ACC). |
| **PgBouncer** | Connections > 120 sustained |

## 10. Testing plan

### Load tests (OPS-01)

Environment: **staging box identical to production** (same instance type, same config), seeded by `pnpm --filter api seed:load --weddings 50 --guests 2000` (synthetic data, fake phones). `MESSAGING_PROVIDER=latency-fake` (300 ms ± 150 ms, 1% fail, delivered after 2–20 s, read after 30–300 s, webhooks posted back to the API like a BSP). Load generator: `c7g.xlarge` in `ap-south-1`, k6 + `xk6-sse`. Results stored as k6 JSON summaries + an SQL report.

| Scenario | Shape | Pass criteria |
| --- | --- | --- |
| **S1 Announcement** | One host sends to all 2,000 guests of one wedding; simultaneously 1,500 guest VUs open the app/lite page over 3 min (spike after a push) | **95% of messages `delivered_at − queued_at` < 120 s** (SQL over MSG delivery rows); 1,000 recipients queued < 10 s (MSG-05); API p95 < 300 ms; 0 duplicate sends (idempotency) |
| **S2 Uploads** | 300 uploads/min sustained for 30 min, 600/min for 5 min; each: presign → PUT 600 KB to S3 staging bucket → complete | p95 presign < 200 ms; 0 lost uploads; p95 upload-to-`processed` < 60 s; media queue drains within 5 min after the 600/min burst |
| **S3 Fifty weddings** | 50 weddings, mixed traffic for 60 min: guest home reads, RSVP writes, travel updates, check-ins at 2/s, 10 SSE boards per wedding, 5 announcements staggered | API p95 < 300 ms, p99 < 1 s; error rate < 0.1%; DB CPU < 50%; box CPU < 70% |
| **S4 SSE** | Ramp SSE connections to 5,000 (2× expected); 500 of them on one quiz channel receiving 1 event/s; measure event lag | p95 event delivery < 2 s; no dropped connections; memory growth < 1 GB; reconnect storm (kill API process) recovers in < 30 s |
| **S5 Peak combined** (S21) | S1 + S2 + S3 + S4 at once for 30 min | All above hold, or the trigger table names the next step |
| **S6 Soak** (S21) | S3 at 50% for 8 h | No memory leak (RSS flat ± 10%), no growing queue |

Real-provider check: one announcement to 50 internal test phones through the real BSP; measure the same 120-s metric.

### Backups, PITR and DR (OPS-06)

| Item | Setting |
| --- | --- |
| pgBackRest | repo1 S3 `mehfil-prod-pgbackrest` (`ap-south-1`), `repo1-cipher-type=aes-256-cbc`; full weekly Sun 03:00 IST, diff daily 03:00 IST; `repo1-retention-full=2` ⇒ **PITR window ≈ 14 days**; `pgbackrest verify` weekly |
| Logical dump | nightly 02:00 IST `pg_dump -Fc | age` → `mehfil-prod-dumps` (Object Lock 35 d) + replicated to `ap-south-2` |
| Media | S3 versioning (noncurrent kept 7 days, see PRV) — accidental deletes recoverable for 7 days |
| Config | `infra/` in git; AMI baked monthly (Packer or a plain `create-image` script) |
| **RPO** | ≤ 1 min (WAL, `archive_timeout=60`); ≤ 24 h if both repo and box are lost and only the dump survives |
| **RTO** | Target **60 min** for box loss (new instance from AMI, `pgbackrest restore`, replay PRV erasure ledger, DNS/Elastic IP switch). With season standby: **≤ 10 min** (promote replica, move Elastic IP). |

**Drill (quarterly, and S9 + S24):** pick a random timestamp in the last 24 h → launch an isolated instance from the AMI → `pgbackrest restore --type=time --target=<ts>` → `prv:replay-erasures --since <ts>` → run API e2e smoke against it → separately decrypt last night's dump with the offline `age` key into a scratch DB and compare row counts → record start/finish times (RTO), data loss (RPO), issues → destroy instance. Pass: RTO ≤ 60 min, RPO ≤ 1 min, key custody worked.

### Other tests

- Unit: alert rule evaluation (thresholds, minimum counts, live-window downgrade), metrics flush merge logic.
- API e2e: `/admin` 404 for non-staff; metrics upsert additive under concurrent flushes; deploy-guard returns blocked during a seeded live event.
- Infra check script `infra/scripts/prod-audit.sh` (shared with PRV-05): archive_mode on, last WAL archived < 10 min, Object Lock on dumps bucket, nofile limits, Nginx SSE config.

## 11. Story breakdown

| Story | Tasks | Backlog pts | Revised | Why |
| --- | --- | --- | --- | --- |
| **OPS-01a** Load-test harness + first pass (S14) | `[TEST]` seed generator, k6 scripts S1–S4, `xk6-sse` build · `[API]` `LatencyFakeProvider` with webhook callbacks · `[OPS]` load-generator instance, staging sized like prod · SQL latency report | 5 | **5** | Unchanged in size, but the fake provider and SSE extension are explicit work. |
| **OPS-01b** Peak + soak (S21) | `[TEST]` S5, S6, real-provider 50-phone check · `[OPS]` apply trigger-table outcome | (unestimated in S21) | **3** | S21 had the work but no points. |
| **OPS-02** Status page and on-call | `[OPS]` uptime monitors (`/readyz`, `/g/health`, 2 regions), status page, paging schedule, CloudWatch → SNS → pager, deploy-guard in deploy script, runbooks (messaging stuck, BSP down → SMS fallback, uploads failing, disk full, box lost → restore, OTP failures, cert expiry) | 2 | **3** | Deploy freeze and runbooks added. **Move to S9** (first real pilot). |
| **OPS-03** Per-wedding live dashboard (P0\*) | `[DB]` minute/system/alerts/watch tables · `[API]` `metrics.ts` + flush, call sites in MSG/CAM/ACC/ARR/SSE, admin JSON endpoints · `[JOB]` sample, evaluate, prune, backup check · `[WEB]` `/admin` Google login + two pages · `[TEST]` | 3 | **5** | Staff web login (new auth surface) and alert rules were not in the 3. |
| **OPS-04a** Device lab setup (S4) | `[OPS]` buy 4 devices, manual checklist, Sentry release health | 3 (whole) | **1** | Needed from S4 because DoD already requires budget-Android checks. |
| **OPS-04b** Automated smoke (S9) | `[TEST]` Maestro flows host + guest, network throttle profiles, Firebase Test Lab job · `[MOB]` testIDs for key controls, diagnostics screen | (in OPS-04) | **4** | RN native builds and two modes double the flows. |
| **OPS-05** CDN and capacity tuning (reinterpreted) | `[OPS]` CloudFront cache policy for previews (immutable keys, 1-year TTL, signed URLs with stable query handling), worker concurrency config, vertical resize runbook | 3 | **2** | No autoscaling on one box. |
| **OPS-06** Backup and DR drill | `[OPS]` pgBackRest + dump setup is **FND-11**; this story: drill script, isolated restore VPC, erasure replay, key-custody check, RTO/RPO record | 2 | **3** | Erasure replay and key check added. First drill in **S9**. |
| **OPS-07** Season hot standby (new) | `[OPS]` streaming replica on `t4g.large` in another AZ, pgBackRest `standby` from repo, promotion runbook, Elastic IP move, drill | — | **3** | Needed for a credible 99.9% on wedding dates. PO decision. |
| **Total** | | **18** | **29** | |

## 12. Dependencies and sequencing

| Needs | From | For |
| --- | --- | --- |
| FND-07 staging / FND-11 production on EC2 with Nginx + PM2, pgBackRest installed | E01 | everything |
| FND-08 Sentry + Pino | E01 | release health, logs |
| `platform_staff` | 14-prv.sql | admin auth, watchers |
| Erasure ledger replay `prv:replay-erasures` | E14 PRV-02a | DR drill |
| MSG-05 fan-out (batch jobs), MSG-06 delivery timestamps | E07 | OPS-01 S1, counters |
| CAM-01/07 presign + media worker, client-side resize | E12 | OPS-01 S2 |
| ARR-05 SSE hub, QZ-02 live quiz | E09, E21 | OPS-01 S4 |
| Metrics call sites | MSG, CAM, ACC, ARR modules (~0.5 pt each, add to their DoD) | OPS-03 |
| Store builds for both platforms | APP / FND | OPS-04b |
| WhatsApp messaging tier upgrade (new VAL item) | Founder | season capacity |

## 13. Risks and open questions

| # | Item | Owner |
| --- | --- | --- |
| 1 | **WhatsApp tier limits**, not compute, cap 50 × 2,000-guest weddings/day. Need the top tier (or several sender numbers) before Nov 2027. Add a VAL item. | Founder |
| 2 | 99.9% on wedding dates with one box: not achievable without OPS-07 standby (or RDS Multi-AZ + 2 boxes). | PO |
| 3 | Paging/status vendor and budget (Better Stack or similar, ~US$30–60/month); Firebase Test Lab / BrowserStack (~US$40/month). | PO |
| 4 | **RN 0.88 minimum iOS version** may be above iOS 15 (RN 0.76 already needs 15.1). If so, iOS 15.0 devices fall back to the lite web page. Check at FND-01. | Eng |
| 5 | Small team on-call during peak season (many weddings on the same auspicious dates). Two-engineer rota per date; feature freeze 17 Oct (already planned). | PO |
| 6 | Load-test realism: synthetic behaviour may miss real spikes (everyone opening the app after the Baraat). Use pilot data from `ops_wedding_minute` to tune S21 shapes. | Eng |
| 7 | Graviton (arm64) vs x86: if any native dependency lacks arm64, use `m7i.xlarge`. | Eng |

## 14. Deviations from the baseline

| Baseline says | This design | Action |
| --- | --- | --- |
| Deploy: "nightly encrypted `pg_dump` to S3" | Adds **pgBackRest WAL archiving + PITR** (14-day window); dump kept as immutable copy | Update Deploy row in 00-overview |
| No admin web surface | `/admin` server-rendered pages with **Google web OAuth cookie session** for `platform_staff` (shared with PRV) | Add to Identity and auth |
| One EC2 instance | Second small EC2 as **hot standby during season** (OPS-07), if PO approves | Note under Deploy |
| "Re-evaluate Redis at OPS-01 load test" | Kept; explicit trigger table above | none |
| Rate limits via `express-rate-limit` | Memory store is per PM2 process; OTP/link lockouts must be Postgres-backed (ACC) | Clarify in API conventions |
