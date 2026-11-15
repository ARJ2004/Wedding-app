# Mehfil — Build Progress

Tracked by the Ralph loop (`.claude/ralph/PROMPT.md`). Status: `todo`, `doing`, `done`, `blocked: <reason>`, `human` (not code).

## S0 · 16 – 29 Nov 2026 · Talk to people, start the slow paperwork

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| FND-01 | Monorepo scaffold | 3 | done | pnpm workspace, shared config, api/worker entry points. Husky/lint-staged deferred (CI enforces lint). |
| FND-02 | CI pipeline | 3 | done | ci.yml: Postgres 16 service, lint, typecheck, unit, schema check, e2e, stale client, audit; Dependabot. Branch protection is a repo setting (human). |
| FND-03 | Local dev stack | 2 | done | infra/docker-compose.dev.yml (Postgres + MinIO + bucket init), scripts/dev-db.sh, .env.example. |
| FND-12 | (new) App factory + API contract | 3 | done | createApp, AppError + error handler, defineRoute → OpenAPI 3.1, /v1/health(+ready), /v1/docs non-prod, rate limit, request id, api-client generation. Idempotency middleware moved to S1 (needs FND-04 tables). |
| SPIKE-1 | WhatsApp route comparison | 2 | human | Needs account sign-ups and pricing calls |
| SPIKE-2 | RN camera cold-open on budget phones | 2 | blocked: needs physical devices | |

## S1 · 30 Nov – 13 Dec 2026 · Decide

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| FND-04 | Core data model + migrations | 3 | done | prisma/migrations/0001_init from 000-core + 01-fnd DDL; schema.prisma pulled (snake_case models); prisma:drift check in CI (no drift); test DB rebuilt from migrations per e2e run. |
| FND-06 | Background workers | 3 | done | pg-boss 10: JobQueue/defineJob, 4 lanes, per-job DLQ, Zod payload guard, FND purge crons, InlineJobQueue fake; worker boots. /v1/ops/jobs endpoints split to FND-06b (needs host auth). |
| FND-09 | i18n framework | 3 | done | packages/i18n: FormatJS ICU, en catalogue (hi/kn empty), English fallback, wedding-timezone formatting, checkCatalogs() run in tests/CI. RN IntlProvider + Hermes polyfill land with APP-01. |
| FND-10 | Shared design system | 5 | done | Split. FND-10a done: packages/design-tokens (light/dark, large text, high contrast, Indic line heights, WCAG tests, lite-web CSS vars). RN theme provider + ui/ components = FND-10b with APP-01. |
| FND-13 | (new) ObjectStore | 2 | done | ObjectStore port: S3ObjectStore (S3 + MinIO path-style), FakeObjectStore with simulateUpload; presign tests offline. CloudFront signer moves to CAM-07. |
| FND-12b | Idempotency middleware + table (moved from FND-12) | 1 | done | idempotent() middleware on idempotency_keys: replay, 409 concurrent, 422 different body, per-caller scope, 5xx retryable; e2e on Postgres. |
| FND-15 | (new) Dev seed and demo wedding | 1 | done | scripts/seed-dev.ts + pnpm db:seed / db:reset (local only): 4 dev users by role, planner org, demo wedding, 6 events, 40 parties, sample /g/ links. |

## S2 · 14 – 27 Dec 2026 · A host signs in and creates a wedding

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| FND-05 | Host and staff auth | 5 | done | POST /v1/auth/google (Google verifier + dev bypass), /refresh (rotation, device-bound, reuse → all sessions revoked), /logout, /logout-all, GET /v1/me; separate host/guest secrets; auth rate limit. |
| FND-07 | AWS staging environment | 5 | blocked: needs an AWS account, Mumbai region access and credentials (human) | IaC scripts can be written once access exists. |
| FND-08 | Observability | 3 | done | prom-client on 127.0.0.1:9464 (api) / 9465 (worker): HTTP latency by route template, job outcomes, process metrics; Sentry when SENTRY_DSN set, no bodies/headers/PII. Needs credentials: Sentry DSN, CloudWatch agent on EC2. |
| APP-01a | App shell, sessions and host sign-in | 5 | done | RN 0.88 bare app (in.mehfil.app) in apps/mobile: Welcome (Google + dev sign-in), session store (keychain, single-flight refresh), typed API client, Welcome/Picker/Host navigators. React Native Web preview + Playwright screenshots (docs/screenshots). Native Android/iOS builds not run here (no emulator/Xcode). Needs credentials: Google OAuth Web client ID. |
| ROL-04 | Organisation model | 3 | done | Partial: family org auto-created per wedding, planner-org weddings require a seat, org_owner/org_admin get implicit planner_member. Seat/org management endpoints split to ROL-04b. |
| ROL-02a | Matrix + enforcement scaffold (S2) | 2 | done | packages/domain permissions.ts (matrix, can, canAssign); defineRoute `permission` → loadMembership (404 for outsiders) + can() (403 ROL_FORBIDDEN); desk-staff masking in serialisers. |
| ROL-04b | Org seats and org management endpoints — split from ROL-04 | 2 | done | /v1/organizations (list/create), seats list/patch/delete (owner-only for admin/owner seats, last-owner guard, removal cascades wedding access), org invitations by link (URL returned once), POST /v1/invitations/:token/accept (email must match). Mobile org screen deferred to PLN (S13). |
| ROL-03a | Audit writer (S2) | 1 | done | writeAudit() in-transaction + diff(); used by auth, weddings, events, venues, parties, guests. |
| SET-01 | Create a wedding | 3 | done | POST/GET/PATCH /v1/weddings(+/:id): dates/timezone validation, owner membership, built-in groups, audit. |
| SET-02 | Events with presets | 3 | done | Event presets, create/bulk-from-presets (wedding timezone), patch, reorder, soft delete + restore. |
| SET-03a | Venues + pasted map link | 3 | done | Venues CRUD; pin from pasted Google/Apple Maps link (offline parser; short links later); cross-wedding venue rejected. |
| GST-01 | Add/edit guests in parties | 5 | done | Parties with members: create/list (search name/label/last-4 digits, cursor), get, patch, delete; add/edit/remove guests; primary rules; groups list. |
| GST-04 | Phone normalisation | 2 | done | normalisePhone (libphonenumber-js/max): 10-digit, 0-prefix, 91…, 00…, intl; valid/landline/invalid/missing; phone_raw kept for fixes. |
| FND-06b | Ops job endpoints (/v1/ops/jobs, retry) — split from FND-06 | 1 | done | GET /v1/ops/jobs, POST /v1/ops/jobs/:id/retry; OPS_ADMIN_EMAILS only, 404 for everyone else. |
| SET/GST-MOB | Host screens for S2 stories: wedding picker, create wedding, home, events (+presets), guests (search, groups, masked for desk staff), appearance | — | done | Mobile tasks of SET-01/02, GST-01; screenshots in docs/screenshots. |
| FND-10b | RN theme provider + ui/ components — split from FND-10 | 3 | done | ThemeProvider + useStyles from packages/design-tokens (THEME_CONFIG + 4 palettes), appearance prefs (scheme, large text, high contrast, palette), ui/ kit: Text, Screen, Button, TextField, Card, Chip, ListRow, ToggleRow, Tag, Empty/Error/Loading. |

## S3 · 28 Dec 2026 – 10 Jan 2027 · Real guest lists (holiday sprint)

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| GST-02a | Import pipeline + API | 5 | done | Import pipeline: xlsx (cached formula values only) / csv (BOM), Hinglish header suggestions, mapping → validate job (normalise, party grouping, members cell, kids), preview rows, actions, idempotent commit job (resumable batches, groups/sides), errors.csv (CSV-injection safe), cancel, one import per wedding. |
| GST-02b | Import mobile flow | 3 | done | App import flow: file picker (native document picker / web input), presigned upload, mapping chips (current choice first), live progress polling, preview stats + problem rows, idempotent commit, done → guest list. Dev: OBJECT_STORE=local disk store shared by API + worker, dev-only upload sink. Sample sheet: docs/samples/guest-list-sample.xlsx. Screenshots: docs/screenshots/import-*. |
| GST-05a | In-import duplicates | 1 | done | In-file duplicate phones and existing-guest phone matches flagged as duplicate (default skip, can merge). |
| GST-06 | Groups and tags | 3 | done | Groups: create/rename/recolour/delete (built-ins protected), bulk add/remove ≤500 parties (cross-wedding rejected), audit. App: "+ New group", Select mode → add selected families to a group. |
| GST-07a | Search, filters, export | 3 | done | Search (name/label/last-4 digits) + group/phone filters were in GST-01; export.csv one row per guest with shared csvCell guard (keeps +91 phones intact, neutralises formulas), BOM for Indic names; desk staff 403. App: Export CSV (share sheet / download). RSVP/travel/arrival filters arrive with their epics (GST-07b). |
| SET-05 | Key contacts | 1 | done | Key contacts: CRUD + reorder, max 10, phone validated/normalised, audit masks phones. App: list + add in Wedding settings. |
| SET-06 | Wedding settings + cover | 3 | done | Settings: versioned Zod schema in packages/domain (camera, language, branding.palette, guests), GET/PATCH deep merge + strict validation + audit. Deviation: branding = one of the contrast-tested palettes (design-tokens) instead of a free accent colour. Cover photo via upload purpose "cover" → PATCH coverMediaId (same wedding, uploaded) → coverUrl. App: Wedding settings (cover, shots, reveal, language, palette applied to the app theme). Fixed: PATCH /weddings reset timezone/cities via schema defaults. |
| CAM-01a | Upload core | 2 | done | media module: upload policy registry (cover, import), POST /v1/weddings/:id/uploads → presigned PUT, POST /v1/uploads/:id/complete (HEAD + size check) → media.process job. Needs credentials: S3 bucket (MinIO/fake in dev). |
| APP-05a | Store release pipeline | 3 | todo | |
| OPS-04a | Device lab setup (S4) | 1 | todo | |

## S4 · 11 – 24 Jan 2027 · A guest opens their link and RSVPs

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| APP-01b | App shell, sessions and host sign-in | 3 | todo | |
| APP-02 | Deep and universal links | 3 | todo | |
| APP-04 | Offline cache and mutation outbox | 3 | todo | |
| FND-14 | (new, absorbs ARR-05) Realtime infra | 3 | todo | |
| PRV-01 | Notice and consent records | 3 | todo | |
| ACC-01 | Personal link | 3 | todo | |
| ACC-02a | New-device OTP (app) | 5 | todo | |
| ACC-04 | Consent capture | 3 | todo | |
| SET-04 | Event visibility by group | 3 | todo | |
| GH-01 | Guest-mode shell (was "PWA shell") | 2 | todo | |
| GH-02 | Personal schedule + home aggregate | 5 | todo | |
| RSV-01a | Per-event RSVP (API + app) | 5 | todo | |

## S5 · 25 Jan – 7 Feb 2027 · Send it once, reach everyone

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| MSG-01 | Provider abstraction + WhatsApp | 8 | todo | |
| MSG-02 | Template catalogue | 3 | todo | |
| MSG-11 | Inbound reply router (new) | 3 | todo | |
| MSG-03 | Announcement composer | 8 | todo | |
| MSG-05 | Fan-out worker | 5 | todo | |
| MSG-06 | Delivery and read status | 5 | todo | |
| RSV-02 | One-tap WhatsApp RSVP | 3 | todo | |
| RSV-03 | Live headcount | 3 | todo | |
| ACC-05 | Abuse protection | 3 | todo | |

## S6 · 8 – 21 Feb 2027 · Who has landed?

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| TRV-01 | Guest travel form | 6 | todo | |
| TRV-03 | Host travel view | 5 | todo | |
| ARR-05 | Realtime infrastructure | 2 | todo | |
| ARR-01 | Guest travel status | 5 | todo | |
| ARR-02 | Live arrivals board | 5 | todo | |
| ARR-03a | Desk check-in | 5 | todo | |
| ARR-04 | "Still missing" | 2 | todo | |
| GH-03 | My travel and status | 2 | todo | |
| GH-07 | Guest QR | 1 | todo | |
| GST-07b | Status filters | 1 | todo | |
| ROL-01 | Team roles and invites | 5 | todo | |
| APP-06 | iOS platform bring-up | 3 | todo | |

## S7 · 22 Feb – 7 Mar 2027 · The disposable camera

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| CAM-01b | Camera purposes and S3 config | 3 | todo | |
| CAM-02 | Native camera | 5 | todo | |
| CAM-03 | Shot limit | 3 | todo | |
| CAM-04 | Film filter | 2 | todo | |
| CAM-05a | Persistent upload queue | 5 | todo | |
| CAM-07 | Media worker | 5 | todo | |
| TRV-02 | Ticket upload | 3 | todo | |
| TRV-04 | Chase missing | 2 | todo | |
| ARR-03b | Desk check-in | 3 | todo | |
| PRV-02a | Erasure framework (P0\) | 5 | todo | |
| APP-07 | Sign in with Apple for hosts (iOS) | 3 | todo | |
| APP-05b | Store release pipeline | 2 | todo | |

## S8 · 8 – 21 Mar 2027 · Push, SMS fallback, gallery and the no-install path

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| MSG-04 | Scheduled sends | 2 | todo | |
| MSG-07 | SMS fallback | 5 | todo | |
| APP-03 | Push notifications | 5 | todo | |
| MSG-08 | Push (was web push) | 5 | todo | |
| RSV-04 | Chase non-responders | 3 | todo | |
| ACC-02b | (split) Lite web session | 3 | todo | |
| RSV-01b | (split) Lite web RSVP form | 3 | todo | |
| GH-08 | (new) Guest lite web home | 3 | todo | |
| GAL-01 | Albums per event | 5 | todo | |
| GAL-02a | Single download | 2 | todo | |
| GAL-03 | Hide and report | 3 | todo | |
| CAM-08 | Camera QR / link | 2 | todo | |

## S9 · 22 Mar – 4 Apr 2027 · Hardening and the rehearsal wedding

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| ROL-02b | Per-role test suite (S8) | 5 | todo | |
| ROL-03b | Audit viewer (S8) | 3 | todo | |
| PRV-04 | Encryption and least privilege | 3 | todo | |
| PRV-05 | Pre-pilot security review | 5 | todo | |
| PRV-06 | Store privacy disclosures (new) | 2 | todo | |
| FND-11 | Production environment | 5 | todo | |
| GH-04 | Key contacts | 1 | todo | |
| GH-05 | Accessibility | 3 | todo | |
| GH-06 | Announcements inbox | 1 | todo | |
| APP-08 | Performance budget and release checks | 2 | todo | |
| APP-09 | Store compliance | 3 | todo | |
| OPS-03 | Per-wedding live dashboard (P0\) | 5 | todo | |
| MSG-10 | Opt-out | 2 | todo | |

## S10 · 5 – 18 Apr 2027 · Pilot readiness (P0\* catch-up)

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| GST-03 | Google Sheets (link) | 2 | todo | |
| GST-05b | Duplicate finder + merge | 4 | todo | |
| ACC-03 | Shared family phone | 3 | todo | |
| RSV-05 | Host RSVP on behalf | 2 | todo | |
| MSG-09 | Quota metering | 3 | todo | |
| CAM-05b | Background drain | 3 | todo | |
| CAM-06 | Delayed reveal | 3 | todo | |
| GAL-02b | Host album zip | 3 | todo | |
| PRV-02b | Export + web request + account deletion | 3 | todo | |
| PRV-03 | Retention jobs (P0\) | 5 | todo | |
| OPS-04b | Automated smoke (S9) | 4 | todo | |
| OPS-02 | Status page and on-call | 3 | todo | |
| OPS-06 | Backup and DR drill | 3 | todo | |

## S11 · 19 Apr – 2 May 2027 · Pickups

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| GST-08 | Phone contacts | 3 | todo | |
| PCK-01 | Auto-batch arrivals | 5 | todo | |
| PCK-02 | Vehicles, drivers, manual edits | 5 | todo | |
| PCK-03 | Notify guests | 2 | todo | |
| PCK-05 | Driver link | 3 | todo | |
| ROM-01 | Room inventory import | 3 | todo | |
| ROM-02a | Assign parties to rooms | 5 | todo | |
| FACE-01 | Spike | 3 | todo | |
| SET-03b | In-app pin picker (split, P1) | 2 | todo | |

## S12 · 3 – 16 May 2027 · Rooms, ID vault and Hindi

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| ROM-02b | Assign parties to rooms | 3 | todo | |
| ROM-03 | Guest and desk view | 2 | todo | |
| ROM-04 | Rooming list export | 2 | todo | |
| IDV-01a | Vault, keys and upload API | 5 | todo | |
| IDV-01b | App upload flow | 3 | todo | |
| IDV-02 | Restricted view with logging | 5 | todo | |
| IDV-04 | Auto-delete | 3 | todo | |
| L10N-01 | Hindi | 5 | todo | |
| L10N-03a | Language preference | 2 | todo | |

## S13 · 17 – 30 May 2027 · Planners

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| IDV-03 | Export for hotel | 3 | todo | |
| IDV-05 | Vault security review | 3 | todo | |
| PLN-01a | Overview API + health snapshots | 5 | todo | |
| PLN-01b | Tablet two-pane + offline (split) | 3 | todo | |
| PLN-02 | Team seats | 3 | todo | |
| PLN-05 | Clone / templates | 5 | todo | |
| L10N-03b | Content translation with host review | 5 | todo | |
| L10N-04 | Indic fonts and formats | 2 | todo | |

## S14 · 31 May – 13 Jun 2027 · Find my photos and flight delays

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| FACE-02 | Opt-in and selfie | 3 | todo | |
| FACE-03a | Collections and indexing | 5 | todo | |
| FACE-03b | Matching | 3 | todo | |
| FACE-04 | "My photos" | 2 | todo | |
| FACE-05 | Face data deletion | 3 | todo | |
| TRV-05 | Flight status lookup | 5 | todo | |
| PCK-04 | Reassign on delays | 5 | todo | |
| OPS-01a | Load-test harness + first pass (S14) | 5 | todo | |

## S15 · 14 – 27 Jun 2027 · Sangeet quiz and Kannada

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| QZ-01 | Quiz builder | 3 | todo | |
| QZ-02a | Live engine + guest player | 5 | todo | |
| QZ-02b | Projector screen + host console | 5 | todo | |
| QZ-03 | Leaderboard + async | 3 | todo | |
| L10N-02 | Kannada | 2 | todo | |
| FEED-03a | Wishes (can ship without the feed) | 3 | todo | |
| PLN-04 | Planner branding | 5 | todo | |
| GAL-05 | Upload from phone gallery | 2 | todo | |

## S16 · 28 Jun – 11 Jul 2027 · Feed or AI tickets, entitlements, then measure

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| FEED-01 | Threads and photo posts | 4 | todo | |
| FEED-02 | Moderation | 3 | todo | |
| FEED-03b | Reactions | 1 | todo | |
| TRV-06 | AI ticket reading | 5 | todo | |
| BIL-01 | Plans and entitlements | 8 | todo | |
| GAL-04 | Save album + favourites | 3 | todo | |

## S17 · 12 – 25 Jul 2027 · Get paid

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| BIL-02a | Checkout + webhooks (split) | 5 | todo | |
| BIL-02b | GST invoices (split) | 5 | todo | |
| BIL-05 | Web account + checkout pages (new) | 3 | todo | |
| BIL-03 | Planner credit packs | 5 | todo | |
| BIL-04 | Add-ons | 2 | todo | |
| BIL-06 | Store-compliant plan UI + upgrade nudges (new) | 2 | todo | |
| PLN-03 | Credits | 2 | todo | |
| GTM-03 | Analytics pipeline (new) | 3 | todo | |
| OPS-07 | Season hot standby (new) | 3 | todo | |

## S18 · 26 Jul – 8 Aug 2027 · Self-serve + P2 slot 1

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| GTM-01 | Onboarding wizard | 8 | todo | |
| GTM-02 | Marketing site | 5 | todo | |
| OPS-05 | CDN and capacity tuning (reinterpreted) | 2 | todo | |
| VOX-01 | Voice calls in the guest's language | 10 | todo | |

## S19 · 9 – 22 Aug 2027 · Sales start + P2 slot 2

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| WL-01 | White-label (theming + custom domain) | 6 | todo | |
| VOX-02 | WhatsApp voice-note announcements | 5 | todo | |

## S20 · 23 Aug – 5 Sep 2027 · P2 slot 3

| Story | Title | Pts | Status | Note |
| --- | --- | --- | --- | --- |
| WSH-01 | Video wishes and guest book | 8 | todo | |
