# E01 — Foundations and platform (FND)

Status: design · Architect agent · 15 Nov 2026 · SQL: [`sql/01-fnd.sql`](./sql/01-fnd.sql)

## 1. Summary

Delivers the platform every other epic builds on: the pnpm monorepo, the Express 5 app factory and its middleware (config, errors, validation, rate limits, idempotency, OpenAPI → generated client), host sign-in (Google SSO + `dev:<email>` bypass, rotating refresh tokens), the pg-boss worker process, the S3 `ObjectStore`, SSE realtime on Postgres `LISTEN/NOTIFY`, test harness, CI, EC2 staging and production, observability, the i18n framework and the shared design system.

**Reinterpreted for the new stack.** The backlog's FND stories assume FastAPI, Alembic, a React console, a PWA, Redis/RQ, Terraform and ECS/RDS. They are rewritten here for Express 5 + TS + Zod + Prisma 6 on self-hosted Postgres 16, pg-boss, S3, a bare React Native 0.88 app (Host + Guest mode) and a server-rendered guest lite page, on one EC2 box per environment. Story IDs are kept; four new stories (FND-12..15) make implicit work explicit.

| Stories | FND-01..11 (reinterpreted), FND-12 app factory + API contract, FND-13 ObjectStore, FND-14 realtime (absorbs ARR-05), FND-15 dev seed |
| --- | --- |
| Phase / sprints | S0–S1 (scaffold, CI, local stack, data model, workers, i18n, design system) · S2–S3 (auth, staging, observability) · S8 (production) |
| Not in this epic | Guest link + OTP sessions (ACC; reuses `refresh_tokens` and the guest-token middleware scaffolded here), role matrix content (ROL), upload endpoints (CAM-01), the RN app shell (APP-01) |

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| HTTP framework | Express 5, plain functions, explicit `createApp(deps)` | NestJS (Expense-Tracker) | Baseline. Express 5 forwards rejected promises to the error handler, so no async wrappers. |
| Dependency wiring | One `Deps` object built in `main.ts`/`worker.ts`/tests (`prisma`, `objectStore`, `messaging`, `push`, `jobs`, `clock`, `verifiers`, `config`) passed to module factories | DI container (tsyringe/inversify) | Readable, trivially overridable in tests, no decorators. |
| Route definition | `defineRoute({ method, path, auth, request: {params, query, body}, responses, handler })` registers the Zod schemas with `zod-to-openapi` **and** mounts the Express handler | Hand-written OpenAPI next to routers | Spec can't drift from code; the generated client is always right. |
| Config | Zod schema parsed once at boot; process exits on error | `dotenv` + ad-hoc reads | Bad deploy fails fast. Mirrors ET `validateConfig`. |
| Dev bypass guard | Refuse to boot when `NODE_ENV=production` and any of: `DEV_AUTH_ENABLED=true`, `OBJECT_STORE=fake`, `MESSAGING_PROVIDER=log`, `OPENAPI_DOCS=true`, missing `GOOGLE_WEB_CLIENT_ID`/`SENTRY_DSN`/`S3_*` | Warn only | Requirement; a test asserts each case. Staging also runs `NODE_ENV=production`, so the bypass is **local/CI only**. |
| Host + guest JWT | HS256, separate secrets `JWT_HOST_SECRET` / `JWT_GUEST_SECRET`, plus `aud` check | One secret + `aud` | A guest token can never satisfy host middleware even if an `aud` check is forgotten. |
| Refresh tokens | One `refresh_tokens` table for both audiences, ET rotation + family reuse detection | Separate host/guest tables | One rotation implementation; ACC only adds OTP + device trust. |
| Jobs | pg-boss (≥10, pinned at implementation) in schema `pgboss`; separate `worker` process owns all `work()` and `schedule()` calls | Jobs inside the API process (ET) | Media processing must not starve HTTP; cron registers once. |
| Realtime | SSE; writers call `rt_publish()` in-transaction; one dedicated `pg` LISTEN client per API process; replay from `realtime_events` via `Last-Event-ID` | WebSockets; NOTIFY carrying full payload | SSE is plain HTTP through Nginx; replay matters on venue networks; NOTIFY is capped at 8 kB. |
| Rate limiting | `express-rate-limit` behind a `RateLimitStore` interface, memory store with **one API process**; Nginx `limit_req` as outer layer | Postgres/Redis store now | Single fork instance at MVP (like ET). Swap to a Postgres store before running >1 API process (OPS-05). Durable OTP lockouts live in ACC's tables, not here. |
| Media storage | `ObjectStore` interface: `S3ObjectStore` (prod/staging), MinIO via same class (dev), `FakeObjectStore` (tests) | Direct AWS SDK calls in modules | Baseline; testable without network. |
| IaC | Idempotent AWS CLI scripts + runbooks in `infra/` | Terraform/CDK (backlog FND-07) | One EC2 box per env; ET pattern; far less to learn and maintain. Revisit if a second region/RDS lands. |
| Deploy transport | GitHub Actions → AWS SSM Run Command (OIDC role) → `infra/deploy.sh` on the box; release dirs + `current` symlink + `pm2 reload` | `pm2 deploy` over SSH (ET) | No inbound SSH from GitHub's IP ranges; rollback = flip symlink. |
| Backups | **pgBackRest** to S3 (weekly full, daily diff, continuous WAL → PITR) **plus** nightly encrypted `pg_dump` | Nightly `pg_dump` only (baseline) | 24 h RPO is unacceptable mid-wedding; FND-11 asks for PITR. See §14. |
| Metrics / alerts | `prom-client` on `127.0.0.1:9464`, scraped by CloudWatch agent with log shipping; CloudWatch alarms → SNS (email + SMS to on-call) | Grafana Cloud / self-hosted Prometheus | One vendor (AWS) the team already needs. |
| i18n | FormatJS (ICU) everywhere: `react-intl` in the app, `@formatjs/intl` on the server (lite web, push, templates), catalogs in `packages/i18n` | i18next | ICU plurals/selects; one message format for app, server and WhatsApp copy. Hermes needs only the `Intl.PluralRules` polyfill. |
| Design system | Tokens in `packages/design-tokens` (TS) → RN theme + generated CSS variables for the lite web; RN components in `apps/mobile/src/ui`; dev-only "UI catalog" screen | Storybook RN | Lighter; catalog ships in debug builds only. |
| Test DB | Real Postgres `mehfil_test`, `prisma migrate reset` once in globalSetup, `TRUNCATE … CASCADE` per file, `--runInBand` | Testcontainers / SQLite | Baseline; same engine as prod. Per-worker DBs from a template when the suite exceeds ~5 min. |

## 3. Data model

SQL: [`sql/01-fnd.sql`](./sql/01-fnd.sql). **Schema check passed:** `scripts/check-schema.sh arch_fnd 000-core.sql 01-fnd.sql` → `OK: 19 tables`. Hot queries checked with `EXPLAIN` on 50 weddings × 600 parties, 30k tokens, 100k realtime events: refresh lookup uses `refresh_tokens_token_hash_key`; SSE replay uses `realtime_events_replay_idx`. `rt_publish()` verified to NOTIFY only on commit. Scratch DB dropped.

| Table / object | Purpose | Notes |
| --- | --- | --- |
| `users.last_sign_in_at` (ALTER) | Last successful sign-in | Support and inactive-account retention. |
| `refresh_tokens` | Rotating refresh tokens for hosts (`audience='host'`, `user_id`) and guests (`audience='guest'`, `guest_id` + `wedding_id`) | Only `sha256` stored (32 bytes, `bytea`). Bound to `device_id`. `family_id` per sign-in; reuse of a revoked token revokes the family **and** all of that principal's live tokens (ET behaviour). `revoked_reason` for support. Purged 7 days after expiry/revoke. |
| `idempotency_keys` | Replay-safe POSTs (`Idempotency-Key`) | Unique `(scope, idem_key)`; `request_hash` mismatch → 422; `in_progress` duplicate → 409; completed → stored response replayed. TTL 24 h. `wedding_id` for cascade erasure. |
| `realtime_events` + `rt_publish()` | SSE fan-out and replay | Payload ≤ 4 kB, audience-safe fields only. TTL 24 h. BRIN on `created_at` for cheap purge. |

Owned elsewhere but scaffolded here: pg-boss's own schema `pgboss` (created by pg-boss), Prisma `_prisma_migrations`. Platform-ops admins (who may view failed jobs) are an env allowlist `OPS_ADMIN_EMAILS`, **not** a DB column — rejected `users.is_staff` because a DB write would become a privilege escalation path.

At implementation, 000-core + 01-fnd become the first Prisma migration (FND-04); each later epic adds its own migration.

## 4. API

All under `/v1`. Auth column: `public`, `host` (host access JWT), `guest` (guest JWT), `ops` (host JWT + email in `OPS_ADMIN_EMAILS`).

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/google` | public | Exchange Google ID token (or `dev:<email>` when bypass on) for host tokens; upserts `users` | 401 `AUTH_INVALID_GOOGLE_TOKEN`, 503 `AUTH_GOOGLE_NOT_CONFIGURED`, 429 |
| POST | `/v1/auth/refresh` | public | Rotate refresh token (host or guest; audience from row) | 401 `AUTH_REFRESH_INVALID`, 401 `AUTH_REFRESH_REUSED` |
| POST | `/v1/auth/logout` | host / guest | Revoke this device's refresh token; drop its `push_devices` row | — |
| POST | `/v1/auth/logout-all` | host | Revoke every host session of the caller | — |
| GET | `/v1/me` | host | Profile + weddings the caller belongs to (role per wedding) | 401 `AUTH_UNAUTHENTICATED` |
| GET | `/v1/health` | public | Liveness (process up) | — |
| GET | `/v1/health/ready` | public (Nginx only) | DB + pg-boss reachable | 503 |
| GET | `/v1/app/config` | public | Min/recommended app version per platform, feature flags, support contacts (see APP) | — |
| GET | `/v1/weddings/:weddingId/stream?channels=a,b` | host / guest | SSE stream; resumes from `Last-Event-ID` | 404 (not member), 403 `RT_CHANNEL_FORBIDDEN` (member but channel not allowed), 429 `RT_TOO_MANY_STREAMS` |
| GET | `/v1/ops/jobs?state=failed&queue=` | ops | Failed / dead-lettered jobs (id, queue, error message, attempts; **no payload**) | 404 for non-ops |
| POST | `/v1/ops/jobs/:jobId/retry` | ops | Re-queue a dead-lettered job | 404 |
| GET | `/v1/docs`, `/v1/openapi.json` | public, **non-production only** | Swagger UI and spec | — |

### Platform middleware (order in `createApp`)

1. `helmet` (API-appropriate CSP off for JSON), `trust proxy = 1` (Nginx).
2. `requestId` — accepts/sets `X-Request-Id`; bound into Pino child logger and Sentry scope.
3. `pino-http` with redaction (`authorization`, `cookie`, `*.phone*`, `*.otp*`, `*.token*`, `*.idToken`, `*.refreshToken`, request/response bodies never logged).
4. `express.json({ limit: '256kb' })` (media never transits the API).
5. Rate limits: global 300/min/IP; `/v1/auth/*` 20/min/IP; guest link/OTP routes get ACC-defined limits via the same helper.
6. Routers (each module exports `router(deps)` built with `defineRoute`).
7. `authHost()` / `authGuest()` per route (from `auth` option of `defineRoute`), then `requireWeddingRole(...)` (ROL fills the matrix in `packages/domain/src/permissions.ts`).
8. `idempotent()` on routes flagged `idempotent: true`.
9. Error handler → `{ "error": { "code", "message", "details"? } }`.

| Thrown | Response |
| --- | --- |
| `AppError(code, message, status, details?)` | as given |
| `ZodError` | 400 `VALIDATION_FAILED`, `details: [{ path, message }]` |
| Prisma `P2002` unique | 409 `CONFLICT` (modules map to specific codes where useful) |
| Prisma `P2025` not found | 404 `NOT_FOUND` |
| `WeddingNotVisible` | 404 `WEDDING_NOT_FOUND` (never 403) |
| anything else | 500 `INTERNAL`, generic message, Sentry event with request id |

### Examples

`POST /v1/auth/google`
```json
// request
{ "idToken": "dev:asha@example.com", "deviceId": "8f1c2a9e0b7d4c6fa1e2b3c4d5e6f708" }
// 200
{ "accessToken": "eyJ…", "refreshToken": "q3V…", "expiresIn": 900,
  "user": { "id": "0193…", "email": "asha@example.com", "name": "asha",
            "weddings": [ { "id": "0193…", "title": "Ananya & Rohan", "role": "owner" } ] } }
```

`POST /v1/auth/refresh`
```json
{ "refreshToken": "q3V…", "deviceId": "8f1c2a9e0b7d4c6fa1e2b3c4d5e6f708" }
// 200 → same shape as above (guest refresh returns { accessToken, refreshToken, expiresIn, guest: {...} })
// 401 { "error": { "code": "AUTH_REFRESH_REUSED", "message": "Session ended, sign in again" } }
```

`GET /v1/weddings/:id/stream?channels=arrivals,headcount` (`Accept: text/event-stream`)
```
retry: 3000
: connected

id: 48213
event: arrival.updated
data: {"partyId":"0193…","status":"landed","at":"2027-04-02T05:41:00Z"}

: ping            ← every 20 s
```

### Access token claims

| Audience | Claims | TTL |
| --- | --- | --- |
| `host` | `sub=user_id`, `aud=host`, `sid=family_id` | 15 min |
| `guest` | `sub=guest_id`, `aud=guest`, `pid=party_id`, `wid=wedding_id`, `sid=family_id` | 15 min (ACC may shorten) |

Removing a member's wedding access (ROL) does not need token revocation: membership is loaded per request by `requireWeddingRole`. Removing a user entirely revokes their refresh tokens (`access_removed`).

## 5. Jobs, events and realtime

**Worker process** (`src/worker.ts`, PM2 app `worker`): builds the same `Deps`, starts pg-boss, registers every module's `jobs.ts` (`register(boss, deps)`), and all cron schedules. The API process only `send()`s.

| Queue | Concurrency (`teamSize`/`batchSize`) | Default retry | Used by |
| --- | --- | --- | --- |
| `messaging` | 10 | 5, exponential backoff from 10 s, DLQ `messaging.dlq` | MSG fan-out, OTP sends (ACC) |
| `media` | 4 (CPU-bound `sharp`; `sharp.concurrency(1)`) | 3, backoff 30 s, DLQ `media.dlq` | CAM, IDV, exports |
| `default` | 5 | 3, backoff 30 s, DLQ `default.dlq` | everything else |

Conventions: job names `<module>.<verb>` (`media.process`); payload validated with a Zod schema on both send and work; handlers idempotent (use `singletonKey` or check-and-set on the domain row); payloads carry ids, never PII; `expireInSeconds` set per job. Job failures go to Sentry with `job.name`, `job.id`, attempt.

**FND cron jobs** (IST via `tz: 'Asia/Kolkata'`):

| Job | Schedule | Does |
| --- | --- | --- |
| `fnd.purge-auth` | 03:10 daily | Delete refresh tokens expired/revoked > 7 days |
| `fnd.purge-idempotency` | hourly | Delete `idempotency_keys` past `expires_at` |
| `fnd.purge-realtime` | every 15 min | Delete `realtime_events` older than 24 h |
| `fnd.queue-health` | every minute | Export queue depth / oldest-job age gauges (read from pgboss) |

**Domain events:** `src/common/events.ts` — a typed in-process emitter (`emit('rsvp.changed', {...})`) for same-process reactions; anything that must survive a crash is a pg-boss job. Events are emitted **after** the transaction commits (`prisma.$transaction(...).then(emit)`).

**SSE hub** (`src/common/sse/`):
- One dedicated `pg.Client` per API process runs `LISTEN mehfil_rt`; auto-reconnects with backoff and, on reconnect, tells every open stream to replay from its last id.
- On NOTIFY `{id, w, c}`: if any local stream subscribes to `(w, c)`, read the row once by id and write it to those streams.
- Stream lifecycle: auth → membership + `can(role, 'realtime:<channel>')` → set `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no` → replay rows after `Last-Event-ID` (max 500; if the gap is larger send `event: reset` so the client refetches) → heartbeat comment every 20 s → close after 1 h (client reconnects; refreshes its token first).
- Limits: 3 streams per principal, 5,000 per process; `RT_TOO_MANY_STREAMS` beyond.
- Channel catalogue lives in `packages/domain/src/realtime.ts` (name → permission action → payload Zod schema). FND ships the mechanism and a `debug.ping` channel; ARR, RSV, QZ add channels.

## 6. Mobile app

FND provides foundations consumed by the app shell (designed in [25-app.md](./25-app.md)):

| Piece | Where | Detail |
| --- | --- | --- |
| Generated client | `packages/api-client` | `openapi-typescript` + `openapi-fetch`; `createApiClient({ baseUrl })`; app adds host/guest auth middleware (ET `authMiddleware` pattern, one per audience). |
| Domain helpers | `packages/domain` | roles, `can()`, phone normalisation (`libphonenumber-js/min`), IST date helpers, realtime channel catalogue, error codes enum. Framework-free, used by API and app. |
| i18n | `packages/i18n` | `locales/en/{common,guest,host}.json` ICU catalogs; `IntlProvider` in app; `formatDate/Time` in the wedding's timezone; Hermes polyfill `@formatjs/intl-pluralrules` (+ `en`, later `hi`, `kn` locale data only). ESLint `formatjs/no-literal-string-in-jsx` (error) and CI check that every key exists in `en` and that other locales have no unknown keys. |
| Design system | `packages/design-tokens` + `apps/mobile/src/ui` + `apps/mobile/src/theme` | Tokens: colour (default + high-contrast palettes, WCAG AA min, AAA in high contrast), type scale with a **large-text** multiplier (1.0 / 1.3) on top of OS font scale (`maxFontSizeMultiplier` capped at 2.0 per component), spacing, radii, 48 dp min touch target. Components: `Screen`, `TopBar`, `Text`, `Button`, `IconLabel` (icon always with label), `TextField`, `OtpField`, `Card`, `ListRow`, `Chip`, `Badge`, `Banner` (offline/stale), `EmptyState`, `BottomSheet`, `SegmentedControl`, `Toggle`, `Skeleton`, `QrCode`, `Avatar`. Built from ET's `ui/` set. Dev-only UI catalog screen. |

## 7. Guest lite web

FND provides the plumbing only; content is ACC/GH/RSV.

- Express route group `/g/:token` rendering server-side HTML with a tiny template layer (`eta`), no client framework, ≤ 30 kB CSS+JS gzipped, CSS variables generated from `packages/design-tokens`, strings from `packages/i18n` via `@formatjs/intl`.
- Security headers: strict CSP (`default-src 'self'`), `Referrer-Policy: no-referrer` (the token is in the path), `X-Robots-Tag: noindex`, `Cache-Control: private, no-store`.
- Nginx serves `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` (APP).

## 8. Security and privacy

| Area | Control |
| --- | --- |
| Dev bypass | Config refuses to boot in production with `DEV_AUTH_ENABLED=true` (and other fakes). Unit test per case. Staging runs `NODE_ENV=production` → bypass impossible outside local/CI. Dev users are `google_sub='dev|<email>'`. |
| Google verification | `google-auth-library` `verifyIdToken` with audience = Web client ID; require `email_verified=true`. iOS uses the same Web client ID as audience. |
| Tokens | Access in memory only (app); refresh in Keychain/Keystore; refresh stored hashed; rotation with reuse detection; device-bound. Separate signing secrets per audience; secrets ≥ 32 bytes; rotation runbook supports `JWT_*_SECRET_PREVIOUS` for zero-downtime key roll. |
| Transport | TLS 1.2+ at Nginx (certbot), HSTS; API binds `127.0.0.1`; Postgres not exposed; SG opens 443/80 only; no SSH (SSM Session Manager). |
| Secrets | `/srv/mehfil/shared/api.env` chmod 600, owned by app user. Baseline says `.env` on server; PRV-04's "Secrets Manager" is reinterpreted as this (see §14 of PRV). KMS only for ID vault. |
| Logging | Pino redaction list in §4; Sentry `beforeSend` strips request bodies, query strings on `/g/*`, and headers; `sendDefaultPii: false`. |
| Rate limits | §4; Nginx `limit_req zone=auth 10r/s burst=20` on `/v1/auth/`, `zone=link 5r/s` on `/g/`. Alert on 429 spikes (ACC-05). |
| Audit | `auth.sign_in` (user, method google/dev), `auth.reuse_detected`, `auth.logout_all`, `ops.job_retry` → `audit_log` (`wedding_id` null). |
| DPDP | FND stores only account data needed to sign in (Google sub, email, name, avatar). Tokens purged after 7 days post-expiry; realtime events 24 h; idempotency responses 24 h. Host account deletion endpoint is in APP-09 (store requirement) and PRV-02. |
| Supply chain | `pnpm install --frozen-lockfile`, Dependabot weekly, `pnpm audit --prod` in CI (fail on high). |
| Backups | pgBackRest repo in S3 with SSE-KMS, separate bucket per env, `pg_dump` encrypted with `age` to a separate prefix; bucket versioning + 35-day lifecycle; restore drill monthly (OPS-06). |

## 9. Scale and performance

| Target | Where FND is stressed | How it holds |
| --- | --- | --- |
| 50 live weddings, 2,000 guests | API process count, DB connections | 1 API + 1 worker process on `m7g.large` (2 vCPU / 8 GB) prod; Prisma pool 10 (API) + 5 (worker) + pg-boss 3 + 1 LISTEN ≈ 20 of `max_connections=100`. |
| SSE (boards, headcount, quiz 500 players) | Open connections, fan-out | Idle SSE costs ~a few kB each; 5,000/process cap. One DB read per NOTIFY regardless of subscriber count. Nginx `worker_connections 4096`. Quiz at 500 players × ~1 msg/s is fine; revisit at OPS-01. |
| 300 uploads/min | `media` queue CPU | `sharp` on 1 core ≈ 5–10 previews/s for 12 MP JPEG → 300/min = 5/s, at the edge. Media worker concurrency 4 with `sharp.concurrency(1)`; queue-age alarm at 2 min. **OPS-01 decides** whether media moves to its own instance. |
| 95% messages < 2 min | `messaging` queue latency | Separate queue, concurrency 10; `fnd.queue-health` gauges oldest-job age; alarm at 60 s. |
| 99.9% on wedding dates | Single box | Nightly + WAL backups, tested restore, `pm2` auto-restart, CloudWatch alarms; documented RTO 1 h / RPO 5 min. Moving to RDS Multi-AZ is the pre-season escape hatch (baseline). |
| Cold start < 3 s (app) | Bundle/i18n/tokens | i18n catalogs split per namespace and lazy-loaded per mode; only `en` bundled at MVP. |

## 10. Testing plan

| Layer | What | Tooling / fakes |
| --- | --- | --- |
| Unit | config validation (each production refusal), verifiers (dev/Google), token rotation & reuse, error mapper, idempotency hashing, `defineRoute` → OpenAPI, SSE hub fan-out (fake LISTEN client) | Jest + ts-jest |
| API e2e | auth flows (dev sign-in, refresh, reuse → 401 and family revoked, logout), `/v1/me`, health, 404 for other wedding via a sample protected route, rate-limit 429, idempotent replay/409/422, SSE replay after `Last-Event-ID` and `reset` when gap > 500, ops endpoints hidden from non-ops | supertest against `createApp(testDeps)` on `mehfil_test`; `FakeObjectStore`, `LogSinkProvider`, `FakePushProvider`, `InlineJobQueue` (records sends; `drain()` runs handlers) |
| Worker | pg-boss real: send → work → DLQ after retries; cron registration idempotent | `mehfil_test`, pgboss schema reset per file |
| Contract | generated client up to date (`git diff --exit-code`) | CI |
| Mobile | theme/large-text snapshots, `ui/` components a11y props, i18n key presence | Jest + RNTL |
| Ops | deploy to staging on every merge; smoke test (`/v1/health/ready`, dev-free sign-in with a staging Google test account); restore drill before pilots | GitHub Actions, runbook |

Test helpers (ET `helpers.ts` port): `boot(overrides)`, `signInHost(email)`, `signInGuest(partyId)` (ACC), `truncate(...tables)`, `bearer(session)`.

**CI** (`.github/workflows/ci.yml`, ET shape): `postgres:16` service (`mehfil_test`), Node 22, pnpm cache; steps: install → build packages → lint → typecheck → unit → `prisma migrate deploy` → API e2e → stale-client check → i18n key check → `pnpm audit`. Mobile: `android-build.yml` on PRs touching `apps/mobile` (debug assemble, cached Gradle) — see APP-05. Required checks on `main`.

## 11. Story breakdown

Backlog total **44**; revised **49** (net +5, of which +3 is ARR-05 moved in, so +2 real).

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| **FND-01** Monorepo scaffold | [OPS] pnpm workspace (`apps/api`, `apps/mobile` placeholder, `packages/{domain,api-client,config,i18n,design-tokens}`), Node 22 `engines`, shared tsconfig/eslint/prettier, Husky + lint-staged, `.editorconfig`, `.nvmrc`; [API] empty Express app with `main.ts`, `worker.ts`, `app.ts` | 3 → 3 | Reinterpreted: no FastAPI/console/PWA; the RN project itself is APP-01. |
| **FND-02** CI pipeline | [OPS] `ci.yml` as §10, branch protection, Dependabot, CODEOWNERS | 3 → 3 | Unchanged; mobile build job is in APP-05. |
| **FND-03** Local dev stack | [OPS] `infra/docker-compose.dev.yml` with MinIO + `mc` bucket init (Postgres native or compose `postgres:16`), `.env.example`, `pnpm dev` (api + worker with `tsx watch`) | 2 → 2 | No Redis; fake WhatsApp/SMS is the in-process `LogSinkProvider` (MSG). Seed moved to FND-15. |
| **FND-04** Core data model + migrations | [DB] translate 000-core + 01-fnd into `schema.prisma`, first migration, `prisma:deploy` script, migration lint (no destructive change without expand/contract note) | 5 → 3 | Domain tables (RSVP, travel, messages, photos) are now owned and migrated by their epics. |
| **FND-05** Host and staff auth | [API] `auth` module: verifiers (Google, dev), `TokenService` (both audiences), `/v1/auth/{google,refresh,logout,logout-all}`, `/v1/me`; `authHost`/`authGuest` middleware; `requireWeddingRole` + `can()` scaffold; audit entries [TEST] unit + e2e incl. reuse detection | 5 → 5 | Reinterpreted: Google SSO + dev bypass instead of phone/email OTP for hosts. ET code ports directly. |
| **FND-06** Background workers | [JOB] `worker.ts`, `JobQueue` wrapper, three queues + DLQs, Zod payload guard, FND purge crons, `/v1/ops/jobs` + retry [TEST] | 3 → 3 | pg-boss instead of RQ/Celery; DLQ view is an API endpoint (no admin UI) used via the ops screen in Host mode or curl. |
| **FND-07** AWS staging environment | [OPS] `infra/aws/*.sh` (VPC default, SG, EC2 `t4g.medium`, IAM instance role, S3 buckets media/backups, CloudFront + OAC for previews, KMS key), Nginx site (TLS, SSE settings, `.well-known`), PM2 `ecosystem.config.js` (`api`, `worker`), `infra/deploy.sh` (release dir, migrate, symlink, reload, health gate), GH OIDC role + `deploy-staging.yml` via SSM | 8 → 5 | One box, no ECS/RDS/ElastiCache/Terraform. |
| **FND-08** Observability | [API] Pino + redaction, request ids, Sentry Node (`instrument.ts`), `prom-client` metrics (HTTP latency histogram by route, queue depth/age, SSE connections, send/upload errors); [OPS] CloudWatch agent config, log groups (30-day retention), alarms (5xx rate, p95 > 1 s, queue age, disk > 80 %, backup missing), SNS | 3 → 3 | Unchanged scope; Sentry RN is APP-01. |
| **FND-09** i18n framework | [MOB] `packages/i18n`, `IntlProvider`, Hermes polyfill, lint rule; [API] server formatter for lite web/push; [TEST] key-presence check in CI | 2 → 3 | Now three consumers (app, lite web, server push/templates) and a Hermes Intl gap to cover. |
| **FND-10** Shared design system | [MOB] tokens, theme provider (large text, high contrast, OS font scale), components in §6, UI catalog; [WEB] generated CSS variables for lite web | 5 → 5 | Unchanged; RN instead of React web. Dep DSN-01. |
| **FND-11** Production environment | [OPS] separate AWS account (Organizations), prod box `m7g.large`, gp3 100 GB, pgBackRest + nightly `pg_dump`, `deploy-prod.yml` (manual approval, tag), rollback (symlink flip + `prisma migrate` expand/contract rule), runbook, restore test | 5 → 5 | Unchanged; PITR via pgBackRest. |
| **FND-12** (new) App factory + API contract | [API] `createApp(deps)`, middleware chain (§4), `AppError` + error handler, `defineRoute`, OpenAPI emit script, `/v1/docs` (non-prod), idempotency middleware + table, rate-limit helper; [OPS] `api-client:generate` + stale check | — → 3 | Implicit in backlog; must exist before any module. |
| **FND-13** (new) ObjectStore | [API] `ObjectStore` (`presignPut`, `presignGet`, `head`, `get`, `put`, `delete`, `copy`), `S3ObjectStore` (MinIO via `endpoint` + `forcePathStyle`), `FakeObjectStore`, CloudFront signer helper; [TEST] | — → 2 | Lets TRV-02 and CAM-01 start without waiting for each other (S6 note in sprint plan). |
| **FND-14** (new, absorbs ARR-05) Realtime infra | [DB] `realtime_events`, `rt_publish`; [API] SSE hub, `/stream` route, channel catalogue, limits; [JOB] purge; [MOB] `useEventStream` hook on `react-native-sse` (headers + reconnect + Last-Event-ID) [TEST] | ARR-05 3 → 3 | Moves from ARR to FND so every realtime feature (RSV-03 headcount in S4!) shares it. ARR keeps only its channel payloads. |
| **FND-15** (new) Dev seed and demo wedding | [DB] `pnpm db:seed`: dev owner/planner/desk users (`dev:owner@mehfil.local`…), one wedding with 6 events, 40 parties, printed guest link tokens; [OPS] `pnpm db:reset` | — → 1 | Every mobile and API dev needs it from S2. |

## 12. Dependencies and sequencing

| Sprint | FND stories | Needs first |
| --- | --- | --- |
| S0 | FND-01, FND-02, FND-03 | GitHub org/repo; AWS org created (long-lead: account verification) |
| S1 | FND-04, FND-06, FND-09, FND-10, **FND-12**, **FND-15** | DSN-01 for FND-10 tokens |
| S2 | FND-05, FND-07, **FND-13** | Google Cloud project + OAuth Web/Android/iOS clients; domain bought (VAL-08) for TLS + App Links |
| S3 | FND-08 | Sentry org |
| S4 | **FND-14** (needed by RSV-03 headcount this sprint, earlier than ARR-05 in S6) | ROL-01 permission names for channels |
| S8 | FND-11 | Separate prod AWS account |

Other epics depend on: `refresh_tokens` + `authGuest` (ACC), `requireWeddingRole`/`can()` scaffold (ROL), `ObjectStore` (CAM, TRV, IDV, GAL), `rt_publish`/SSE (ARR, RSV, QZ), `idempotent()` (MSG, BIL), `JobQueue`/queues (MSG, CAM, PRV).

S1 capacity: backlog had 15 pts; this plan puts 3+3+2+5+3+1 = 17 (FND-04 shrank, FND-12/15 added) — fits the validation-phase allowance if FND-10 starts late in S1 and finishes in S2.

## 13. Risks and open questions

| # | Risk / question | Impact | Mitigation / owner |
| --- | --- | --- | --- |
| 1 | Single EC2 box hosts API, worker, Postgres, `sharp` | Media spikes at a Sangeet slow APIs | Separate processes, `nice` the worker, queue-age alarm; OPS-01 load test decides on a second box or RDS. |
| 2 | In-memory rate limits with one API process | Can't scale API horizontally without a store swap | `RateLimitStore` interface; Postgres-backed store before `instances > 1`. |
| 3 | `LISTEN` client drops silently | Boards freeze | Keep-alive query every 30 s on the LISTEN client; reconnect triggers replay; metric `sse_listen_reconnects_total`. |
| 4 | Hermes `Intl` gaps (`PluralRules`, `RelativeTimeFormat`) and timezone support on old Android | Wrong plurals or times | Polyfills for missing APIs only; device-lab check in OPS-04; IST helpers fall back to fixed +05:30 offset (India has no DST). |
| 5 | Team skills: plan assumed Python + React web | Velocity | PO to confirm the team (now TS + RN). |
| 6 | Staging cannot use dev bypass (NODE_ENV=production) | Testers need Google accounts; guest OTPs on staging need a real or sandbox sender | Staging uses a BSP sandbox/test numbers; **PO confirm** this is acceptable rather than a `DEPLOY_ENV=staging` exception. |
| 7 | pg-boss major-version API changes | Rework | Pin exact version; wrapper `JobQueue` isolates it. |

## 14. Deviations from the baseline

| Baseline says | This design | Reason |
| --- | --- | --- |
| Backups: nightly encrypted `pg_dump` to S3 | **Add** pgBackRest (WAL archiving, PITR) alongside the nightly dump | 24 h RPO is too much during a live wedding; FND-11 asks for PITR. |
| `.env` on server | Unchanged, but PRV-04 "secrets only in Secrets Manager" is reinterpreted as `.env` (chmod 600) | Flag for PRV architect / PO. |
| Realtime: SSE + LISTEN/NOTIFY | Adds a `realtime_events` table for replay; NOTIFY carries only ids | Bad venue networks need resume; NOTIFY 8 kB cap. |
| Worker as separate PM2 process | Unchanged; all cron schedules registered only in the worker | (ET registers them in the API; called out to avoid copying that.) |

Requested baseline update: add `refresh_tokens`, `idempotency_keys`, `realtime_events` to the "Data" list in 00-overview once accepted.
