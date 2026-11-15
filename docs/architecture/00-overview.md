# Mehfil — Architecture Baseline

This is the system-wide baseline every epic design builds on. Per-epic designs live next to it (`NN-<prefix>.md`) and are written by the **architect** agent (`.claude/agents/architect.md`). If an epic design needs to break a rule here, it says so under "Deviations from the baseline" and this file is updated in the same change.

The structure follows the `ARJ2004/Expense-Tracker` project (pnpm monorepo, bare React Native app, typed API client generated from OpenAPI, Google sign-in with a dev bypass, Postgres-backed jobs, EC2 deploy), with **Express** in place of NestJS and **S3** for all media.

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Mobile | React Native 0.88 (bare, New Architecture), TypeScript, React Navigation 7, TanStack Query 5, Zustand, MMKV, react-native-keychain | One app with two modes: **Host** (Google SSO) and **Guest** (private link + OTP). iOS and Android. |
| Guest lite web | Server-rendered HTML pages served by the API at `/g/:token` (no SPA framework) | Keeps the PRD's no-install promise for the basics: schedule, RSVP, travel status, "get the app". Camera, gallery, quiz live in the app. |
| API | Node.js 22, **Express 5**, TypeScript, **Zod** for validation, `@asteasolutions/zod-to-openapi` for the spec, Pino logging | OpenAPI at `/v1/docs` (off in production). |
| API client | `packages/api-client`: `openapi-typescript` + `openapi-fetch`, generated from the API spec | CI fails if the generated client is stale. |
| Database | **PostgreSQL 16**, **Prisma 6** | Self-hosted. Locally and in this sandbox: `postgresql://mehfil:mehfil@localhost:5432/mehfil_dev` and `mehfil_test`. |
| Jobs | **pg-boss** (Postgres-backed queues, cron) | No Redis. Queues: `messaging`, `media`, `default`. Worker runs as a separate process. |
| Realtime | Server-Sent Events from the API; fan-out with Postgres `LISTEN/NOTIFY` | Arrivals board, headcount, live quiz. |
| Media | **Amazon S3** (`ap-south-1`), presigned PUT from the app, `sharp` thumbnails in the media worker, CloudFront for previews | Dev: MinIO in Docker, or the in-memory `FakeObjectStore` in tests. |
| Push | Firebase Cloud Messaging (Android + iOS via APNs) | |
| Messaging | WhatsApp Business API through a BSP, SMS (DLT) fallback, behind a `MessagingProvider` interface | Dev: `LogSinkProvider` writes outbound messages to a table and the console. |
| Secrets / keys | `.env` on the server (chmod 600); AWS KMS for ID-vault envelope keys | |
| Errors / logs | Sentry (API + app), Pino JSON logs | Never log tokens, phone numbers, OTPs or ID data. |
| Deploy | One EC2 instance in Mumbai: Nginx → PM2 (`api`, `worker`), Postgres 16 on the box (moves to RDS when needed), nightly encrypted `pg_dump` to S3 | Same shape as Expense-Tracker's `docs/deploy-ec2.md`. |

## Repository layout

```
apps/api/                 Express API + worker (same codebase, two entry points)
  src/main.ts             HTTP server
  src/worker.ts           pg-boss worker
  src/app.ts              builds the Express app (used by tests)
  src/config/             env schema (Zod), tunables
  src/common/             auth middleware, errors, validation, db, s3, events, sse
  src/modules/<feature>/  router.ts, service.ts, schemas.ts, jobs.ts, events.ts, index.ts
  prisma/schema.prisma    single schema; migrations in prisma/migrations
  test/                   e2e tests (supertest against the local Postgres)
apps/mobile/              React Native app
  src/features/<feature>/ screens/, components/, hooks.ts, api.ts, index.ts
  src/navigation/         HostNavigator, GuestNavigator, linking (deep links)
  src/lib/                api, auth, secure-store, upload-queue, push, sentry
  src/ui/ src/theme/      design system (large-text and high-contrast modes)
packages/domain/          framework-free types: roles, permissions matrix, phone normalisation, IST dates, enums
packages/api-client/      generated client
packages/config/          shared tsconfig / eslint / prettier
docs/architecture/        this file, one design per epic, sql/ (reviewable DDL)
infra/                    nginx, pm2 ecosystem, backup script, S3 lifecycle rules
```

## API conventions

- **Versioned paths:** `/v1/...`. Wedding-scoped resources live under `/v1/weddings/:weddingId/...`.
- **Thin routers:** a router validates input with Zod, calls a service, and serialises output. No Prisma calls in routers.
- **Module boundaries:** a module uses another only through its `index.ts` exports. Each table has one owning module that writes it.
- **Tenant scoping:** every wedding-scoped query filters by `wedding_id`. Middleware `requireWeddingRole(...roles)` loads the membership; a wedding the caller can't see returns **404**, never 403.
- **Permissions:** checked against the matrix in `packages/domain/src/permissions.ts` (`can(role, action)`), not ad-hoc role comparisons. Field-level masking (e.g. desk staff never get phone numbers) happens in serialisers.
- **Error shape:** `{ "error": { "code": "RSVP_EVENT_NOT_INVITED", "message": "..." } }`. Codes are `SCREAMING_SNAKE`, prefixed by module.
- **Pagination:** cursor-based (`?cursor=&limit=`), default 50, max 200.
- **Idempotency:** POSTs that send messages or create payments accept an `Idempotency-Key` header.
- **Time:** stored as UTC `timestamptz`; shown in the wedding's timezone (default `Asia/Kolkata`) using `packages/domain` helpers.
- **Money:** integer paise (`bigint`).
- **Side effects across modules:** domain events (`events.ts`) through an in-process emitter for fast reactions, and pg-boss jobs for anything that must survive a crash (sending, media processing, deletion).
- **Rate limits:** `express-rate-limit` with stricter limits on auth, OTP and link lookups; `trust proxy` set for Nginx.

## Identity and auth

| Who | How they sign in | Token |
| --- | --- | --- |
| Owner, co-host, planner, desk staff | **Google SSO.** The app gets a Google ID token (`@react-native-google-signin/google-signin`) and posts it to `POST /v1/auth/google`. The API verifies it with `google-auth-library` (audience = Web client ID). | Access JWT (15 min, `aud=host`) + rotating refresh token (30 days, stored hashed; reuse revokes the session family). |
| Guest | **Private link + OTP.** WhatsApp link `https://<domain>/g/<token>` opens the app (universal/app link) or the guest lite web page. First use on a device sends a 6-digit OTP to a phone in the party. | Guest JWT (`aud=guest`, `sub=guest_id`, `party_id`, `wedding_id`), refresh token per device. |

**Development bypass** (same pattern as Expense-Tracker's `DevIdTokenVerifier`):

- `DEV_AUTH_ENABLED=true` makes `POST /v1/auth/google` accept `dev:<email>` in place of a Google ID token, creating `users.google_sub = 'dev|<email>'`.
- With the same flag, guest OTPs are not sent; the code is always `DEV_OTP_CODE` (default `000000`) and appears in the API log.
- Config validation **refuses to boot** with `DEV_AUTH_ENABLED=true` when `NODE_ENV=production`. A test asserts this.
- The mobile app shows a "Dev sign-in" email field instead of the Google button when built with `APP_ENV=development`.

## Data

- **Core tables** are defined in `docs/architecture/sql/000-core.sql`: users, organizations, organization_members, weddings, wedding_members, venues, events, guest_groups, parties, guests, party_groups, event_groups, consents, media_objects, audit_log, push_devices.
- Each epic design adds `sql/NN-<prefix>.sql` (NN = epic number from the backlog). An epic file may reference core tables, files of lower number in the same design batch, and may `ALTER` core tables to add columns. It never redefines a core table.
- `scripts/check-schema.sh` applies all SQL files in order to a fresh database on the local Postgres; it must pass before a design is accepted.
- At implementation time the DDL is translated into `apps/api/prisma/schema.prisma` and real migrations; the SQL files remain the reviewed design.

## Media flow (S3)

1. App asks `POST /v1/weddings/:id/uploads` with kind, content type and size → API checks quota/permission, creates a `media_objects` row (`pending`) and returns a presigned PUT URL (5 min expiry, exact content type and max size).
2. App uploads directly to S3 (the upload queue retries offline; see CAM design).
3. App calls `POST /v1/uploads/:mediaId/complete` (or an S3 event triggers it) → API marks `uploaded` and enqueues `media.process`.
4. Worker strips EXIF/GPS, makes WebP previews with `sharp`, writes `processed`.
5. Reads use short-lived CloudFront signed URLs (previews) or S3 presigned GETs (originals). Buckets are private; ID documents use a separate bucket with SSE-KMS.

## Testing

- **Unit:** Jest + ts-jest for services and `packages/domain`.
- **API e2e:** Jest + supertest against `createApp()` and the **self-hosted Postgres** (`mehfil_test`). Migrations are applied before the run; each test file truncates the tables it touches. External services are faked: `LogSinkProvider` for messaging, `FakeObjectStore` for S3, a fake Google verifier via the dev bypass.
- **Mobile:** Jest + React Native Testing Library for screens and hooks; manual device matrix (budget Android 9+, iOS 15+) each release.
- **CI:** GitHub Actions with a `postgres:16` service, the same as Expense-Tracker's `ci.yml`, plus the stale-client check.

### Running Postgres in the cloud sandbox

```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"CREATE ROLE mehfil LOGIN PASSWORD 'mehfil' CREATEDB;\""
su postgres -c "createdb -O mehfil mehfil_dev && createdb -O mehfil mehfil_test"
scripts/check-schema.sh          # applies every design SQL file to a scratch DB
```

## Non-functional targets (from the PRD)

2,000 guests per wedding; 50 live weddings; 300 photo uploads/min during a Sangeet; 95% of announcements delivered within 2 minutes; app cold start < 3 s on a budget Android; camera opens < 2 s; 99.9% availability on wedding dates; DPDP Act compliance; ID copies encrypted with per-wedding keys and deleted 3–7 days after the wedding.

## Decisions that change the PRD

| Decision | Why | Consequence |
| --- | --- | --- |
| Native app (React Native) is the main guest and host client | Requested; matches Expense-Tracker | The PRD's "never install" goal is kept only for WhatsApp RSVP and the guest lite web page. Expect lower guest activation; Gate 3 measures it. App Store / Play review time enters the critical path. |
| Express instead of FastAPI | Requested; one language (TypeScript) across app and API | Shared types via `packages/domain` and the generated client. |
| pg-boss + Postgres `LISTEN/NOTIFY` instead of Redis | Fewer moving parts on one EC2 box | Re-evaluate at OPS-01 load test; Redis can be added behind the same interfaces. |
| EC2 + self-hosted Postgres instead of ECS + RDS | Small team, matches Expense-Tracker | Move to RDS before the Nov 2027 season if the load test or backup drill says so. |
| Google SSO for hosts and staff only | Older guests often have no Google login; PRD promises no guest accounts | Guests use link + OTP. |

## Accepted changes from the epic designs

The architect runs proposed these changes to the baseline. They are reflected in the epic SQL files and docs; the full schema (`scripts/check-schema.sh`, 28 files, 136 tables) passes on Postgres 16. Items marked *pending* wait on a product decision listed in the sprint plan.

| Area | Change | Source |
| --- | --- | --- |
| Push | `push_devices` is owned by APP (`25-app.sql`); `fcm_token` is no longer globally unique (one phone can hold a host session and several guest sessions) | 25-app |
| Auth | Host refresh tokens and guest sessions share `refresh_tokens` (`01-fnd.sql`); Sign in with Apple stores `apple|<sub>` in `users.google_sub` (*pending*) | 01-fnd, 25-app |
| Guest link | Link token derived by HMAC from `LINK_TOKEN_KEY` (still 128-bit, only the hash stored) so reminders can rebuild links; lite web uses a cookie session | 05-acc |
| Secrets | New: `LINK_TOKEN_KEY`, `OTP_PEPPER`, `PII_HASH_KEY`, `CSRF_KEY`; `.env` rendered from SSM Parameter Store on deploy | 05-acc, 14-prv |
| Jobs | Extra pg-boss queues: `messaging-priority` (OTPs never wait behind a broadcast), `faces`, `video` (P2) | 07-msg, 19-face, 27-p2 |
| Realtime | `realtime_events` + `rt_publish()` (NOTIFY on commit, replay by cursor) replaces ARR's own realtime | 01-fnd |
| Media | Uploads carry a `purpose` (only `photos` count as gallery photos); `media_objects.wedding_id` optional for org-owned media (planner logo); `import` kind | 12-cam, 18-pln, 04-gst |
| Postgres | `btree_gist` extension for room/vehicle overlap constraints; `parties.checkin_code` for the party QR; `guests.preferred_language` | 15-pck, 16-rom, 09-arr, 20-l10n |
| Web surfaces served by the API | `/g/:token` guest lite web (+ wish form), `/d/:token` driver page, `/account` billing pages (Google web sign-in), `/admin` for `platform_staff`, quiz projector page; `/c/*` camera deep links | 11-gh, 15-pck, 23-bil, 14-prv, 21-qz, 12-cam |
| Packages | `packages/i18n` (shared catalogues, ICU) | 20-l10n |
| Email / site / analytics | Amazon SES; static `apps/site` on S3 + CloudFront; analytics events table in Postgres | 23-bil, 24-gtm |
| Billing | Only BIL writes `weddings.plan`; plan limits return HTTP 402 | 23-bil |
| Privacy | Deleted weddings become a tombstone row with no personal data; ordered purge via `PurgeParticipant` in every module | 14-prv |
| Ops | pgBackRest WAL archiving (PITR) alongside nightly `pg_dump`; season hot standby (*pending*); Caddy for white-label custom domains (P2, *pending*) | 26-ops, 27-p2 |
| Clients | No host web console: hosts and planners use the app on phone or tablet | 25-app, 18-pln |
