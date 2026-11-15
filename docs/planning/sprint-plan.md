# Mehfil — Sprint Plan (v2, architecture-reviewed)

From validation (Nov 2026) to launch for the Nov 2027 wedding season. Every story below has been through the **architect** agent (`.claude/agents/architect.md`): its design is in `docs/architecture/NN-<epic>.md`, its tables are in `docs/architecture/sql/` and were applied to the self-hosted Postgres in the sandbox with `scripts/check-schema.sh` (all 28 SQL files, 136 tables, OK). Points and task lists in this plan are the **revised** ones from those designs, not the original backlog guesses.

## What changed from v1

| | v1 | v2 |
| --- | --- | --- |
| Stack | FastAPI, React PWA, Redis, ECS | **Express 5 + TypeScript + Zod + Prisma**, **PostgreSQL 16 (self-hosted)**, **pg-boss**, **S3** media, **React Native 0.88** app (host + guest modes), small server-rendered guest lite web — modelled on `ARJ2004/Expense-Tracker` |
| Login | Unspecified | **Google SSO** for owners, co-hosts, planners and desk staff (Sign in with Apple pending, see decisions); guests use private link + OTP. **Dev bypass:** `DEV_AUTH_ENABLED=true` accepts `dev:<email>` and OTP `000000`; the API refuses to boot with it in production. |
| P0 (MVP) size | ~263 pts | **383 pts**. The native app alone adds ~35; every epic grew once designed (privacy 13 → 26, messaging 38 → 49, camera 24 → 33). |
| Team | 3 engineers | **4 engineers from S2** (2 TypeScript/Express, 2 React Native), part-time designer, founder as PM. |
| MVP end (Gate 2) | 21 Mar 2027 | **4 Apr 2027** (one extra sprint), pilot readiness S10, pilots from 19 Apr. |

**If the team stays at 3 engineers** (velocity ~32), the same P0 scope needs S2–S13: Gate 2 moves to ~30 May, pilots run Jun–Aug, and P1 has to be cut to pickups, rooms, ID vault and planner dashboard before the season. Decide at Gate 1.

## How a story flows

1. **Design** — before sprint planning, the `architect` agent writes or refreshes the story's design (data model tested on local Postgres, API, jobs, mobile screens, security, tests, task breakdown). Product decisions it raises are answered before the story is "ready".
2. **Build** — tasks are tagged `[DB]`, `[API]`, `[JOB]`, `[MOB]`, `[WEB]`, `[TEST]`, `[OPS]` in the tables below; one PR per story where possible.
3. **Test** — unit tests, API e2e with supertest against the self-hosted Postgres (`mehfil_test`), mobile tests with React Native Testing Library, device lab check for guest screens.
4. **Review** — code review; `architect` agent re-checks the design doc against the code when a story changes data model or API.

## Assumptions

- **Sprints:** 2 weeks, Mon–Sun; planning Monday, demo + retro last Friday.
- **Velocity:** S0–S1 ~15 (2 engineers); S2 onwards 42 (4 engineers × ~10.5), S3 26 (holidays). From S11, 10 points per sprint are held back for pilot feedback and bugs.
- **Environments:** local (Docker MinIO + self-hosted Postgres, dev bypass on), staging (real Google, real OTP sandbox, no bypass), production — one EC2 box each in Mumbai (Nginx + PM2 `api` and `worker`, Postgres 16, pgBackRest PITR + nightly encrypted `pg_dump` to S3).
- **Gates:** each phase starts only when the gate before it passes.

## Timeline at a glance

| Phase | Sprints | Dates | Outcome | Gate |
| --- | --- | --- | --- | --- |
| 0. Validation | S0–S1 | 16 Nov – 13 Dec 2026 | Interviews, concierge pilot, long-lead admin, repo + data model | **G1:** ≥ 3 planners will pay for a pilot |
| 1. MVP build | S2–S9 | 14 Dec 2026 – 4 Apr 2027 | One wedding runs end to end in the app + lite web | **G2:** 50-guest rehearsal wedding |
| 1b. Pilot readiness | S10 | 5 – 18 Apr 2027 | P0\* items, backups, on-call | — |
| 2. Pilots + P1 | S11–S16 | 19 Apr – 11 Jul 2027 | 3–5 real weddings; logistics + engagement P1s | **G3:** pilot metrics |
| 3. Season readiness | S17–S24 | 12 Jul – 31 Oct 2027 | Billing, onboarding, P2 picks, scale, sales from S19 | **G4:** launch checklist; freeze 17 Oct |
| 4. Launch | S25 | 1 – 14 Nov 2027 | Live for the season, hypercare | — |

```
Nov  Dec  Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov
|S0 S1|S2 S3 S4 S5 S6 S7 S8 S9|S10|S11 .. S16|S17 ......... S24|S25
 Valid.       MVP build (P0)   rdy  Pilots+P1  Season readiness  Launch
      G1                    G2           G3                   G4
```

## Design documents

| # | Epic | Doc | Revised pts |
| --- | --- | --- | --- |
| — | Baseline (stack, conventions, auth, media flow, testing) | [00-overview](../architecture/00-overview.md) | — |
| E01 | Foundations | [01-fnd](../architecture/01-fnd.md) | 49 |
| E03 | Wedding setup | [03-set](../architecture/03-set.md) | 18 |
| E04 | Guest list and import | [04-gst](../architecture/04-gst.md) | 32 |
| E05 | Guest access, identity, consent | [05-acc](../architecture/05-acc.md) | 20 |
| E06 | RSVP | [06-rsv](../architecture/06-rsv.md) | 19 |
| E07 | Messaging | [07-msg](../architecture/07-msg.md) | 49 |
| E08 | Travel | [08-trv](../architecture/08-trv.md) | 26 |
| E09 | Arrivals and check-in | [09-arr](../architecture/09-arr.md) | 22 |
| E10 | Roles, permissions, audit | [10-rol](../architecture/10-rol.md) | 19 |
| E11 | Guest home (app + lite web) | [11-gh](../architecture/11-gh.md) | 18 |
| E12 | Camera and media pipeline | [12-cam](../architecture/12-cam.md) | 33 |
| E13 | Gallery | [13-gal](../architecture/13-gal.md) | 18 |
| E14 | Privacy (DPDP) | [14-prv](../architecture/14-prv.md) | 26 |
| E15 | Pickups | [15-pck](../architecture/15-pck.md) | 20 |
| E16 | Rooms | [16-rom](../architecture/16-rom.md) | 15 |
| E17 | ID vault | [17-idv](../architecture/17-idv.md) | 22 |
| E18 | Planner dashboard | [18-pln](../architecture/18-pln.md) | 23 |
| E19 | Find my photos | [19-face](../architecture/19-face.md) | 19 |
| E20 | Languages | [20-l10n](../architecture/20-l10n.md) | 16 |
| E21 | Couple quiz | [21-qz](../architecture/21-qz.md) | 16 (+3 optional) |
| E22 | Feed and wishes | [22-feed](../architecture/22-feed.md) | 11 |
| E23 | Billing | [23-bil](../architecture/23-bil.md) | 30 |
| E24 | Onboarding and site | [24-gtm](../architecture/24-gtm.md) | 16 |
| E25 | Native app | [25-app](../architecture/25-app.md) | 35 (+3 optional) |
| E26 | Scale and ops | [26-ops](../architecture/26-ops.md) | 29 |
| E27 | P2 candidates | [27-p2](../architecture/27-p2.md) | 42 |


---

## Phase 0 — Validation (S0–S1)

Low-regret engineering only; the rest of the time goes to interviews and paperwork. Two engineers.


### S0 · 16 – 29 Nov 2026 · Talk to people, start the slow paperwork

**Goal:** Interviews under way, every long-lead registration submitted, monorepo running against the local Postgres.  
**Planned:** 11 pts · Capacity 15

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| FND-01 | Monorepo scaffold | 3 | [OPS] pnpm workspace (`apps/api`, `apps/mobile` placeholder, `packages/{domain,api-client,config,i18n,design-tokens}`), Node 22 `engines`, shared tsconfig/eslint/prettier, Husky + lint-staged, `.editorconfig`, `.nvmrc`; [API] empty Express app with `main.ts`, `worker.ts`, `app.ts` | [01](../architecture/01-fnd.md) |
| FND-02 | CI pipeline | 3 | [OPS] `ci.yml` as §10, branch protection, Dependabot, CODEOWNERS | [01](../architecture/01-fnd.md) |
| FND-03 | Local dev stack | 2 | [OPS] `infra/docker-compose.dev.yml` with MinIO + `mc` bucket init (Postgres native or compose `postgres:16`), `.env.example`, `pnpm dev` (api + worker with `tsx watch`) | [01](../architecture/01-fnd.md) |
| FND-12 | (new) App factory + API contract | 3 | [API] `createApp(deps)`, middleware chain (§4), `AppError` + error handler, `defineRoute`, OpenAPI emit script, `/v1/docs` (non-prod), idempotency middleware + table, rate-limit helper; [OPS] `api-client:generate` + stale check | [01](../architecture/01-fnd.md) |
| | **Total** | **11** | | |

**Spikes (2 pts each):** SPIKE-1 WhatsApp route (Meta Cloud API direct vs Gupshup/Interakt: price, interactive buttons, webhook reliability); SPIKE-2 RN camera (react-native-vision-camera) cold-open time on 3 budget Androids and an iPhone on iOS 15.

**Validation and admin:** VAL-01, VAL-02, start VAL-03 and VAL-05; VAL-08 name shortlist; VAL-09 Meta business verification; VAL-10 DLT; VAL-11 Razorpay KYC; **VAL-14 (new) D-U-N-S number → Apple Developer and Google Play organisation accounts** (avoids Play's 12-tester/14-day rule for personal accounts).

**Design:** DSN-01 guest-mode wireframes.

**Demo:** `pnpm test` green in CI with a Postgres 16 service; `GET /v1/health` from the Express app factory; spike write-ups.


### S1 · 30 Nov – 13 Dec 2026 · Decide

**Goal:** Go/no-go with evidence; data model, workers, design system and seed data ready.  
**Planned:** 17 pts · Capacity 17

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| FND-04 | Core data model + migrations | 3 | [DB] translate 000-core + 01-fnd into `schema.prisma`, first migration, `prisma:deploy` script, migration lint (no destructive change without expand/contract note) | [01](../architecture/01-fnd.md) |
| FND-06 | Background workers | 3 | [JOB] `worker.ts`, `JobQueue` wrapper, three queues + DLQs, Zod payload guard, FND purge crons, `/v1/ops/jobs` + retry [TEST] | [01](../architecture/01-fnd.md) |
| FND-09 | i18n framework | 3 | [MOB] `packages/i18n`, `IntlProvider`, Hermes polyfill, lint rule; [API] server formatter for lite web/push; [TEST] key-presence check in CI | [01](../architecture/01-fnd.md) |
| FND-10 | Shared design system | 5 | [MOB] tokens, theme provider (large text, high contrast, OS font scale), components in §6, UI catalog; [WEB] generated CSS variables for lite web | [01](../architecture/01-fnd.md) |
| FND-13 | (new) ObjectStore | 2 | [API] `ObjectStore` (`presignPut`, `presignGet`, `head`, `get`, `put`, `delete`, `copy`), `S3ObjectStore` (MinIO via `endpoint` + `forcePathStyle`), `FakeObjectStore`, CloudFront signer helper; [TEST] | [01](../architecture/01-fnd.md) |
| FND-15 | (new) Dev seed and demo wedding | 1 | [DB] `pnpm db:seed`: dev owner/planner/desk users (`dev:owner@mehfil.local`…), one wedding with 6 events, 40 parties, printed guest link tokens; [OPS] `pnpm db:reset` | [01](../architecture/01-fnd.md) |
| | **Total** | **17** | | |

**Validation:** finish VAL-03, VAL-04, VAL-05 results, VAL-06 landing page, **VAL-07 decision**, start VAL-12 pilot recruiting.

**Design:** DSN-01 tested with 3 guests over 60 and 3 under 30; DSN-02 host-mode information architecture (phone and tablet).

**Gate 1 (13 Dec):** ≥ 3 planners willing to pay for a pilot. Also confirm the team plan below (4 engineers from S2) and the product decisions in the last section marked "before S2".

**Demo:** Prisma migrations from the core DDL apply to `mehfil_dev`; demo wedding seeded; a pg-boss job runs in the worker; design-system screens in Storybook-style gallery in the app.


---

## Phase 1 — MVP build (S2–S10)

Velocity 42 (S3: 26). Every story here is P0 or P0\*. Each sprint starts with an architecture check: the story's design doc is re-read against the code by the `architect` agent and updated if the code or decisions moved.


### S2 · 14 – 27 Dec 2026 · A host signs in and creates a wedding

**Goal:** Google sign-in (and the dev bypass) on Android; host creates a wedding with events, venues and guests; permission and audit scaffolds in place.  
**Planned:** 40 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| FND-05 | Host and staff auth | 5 | [API] `auth` module: verifiers (Google, dev), `TokenService` (both audiences), `/v1/auth/{google,refresh,logout,logout-all}`, `/v1/me`; `authHost`/`authGuest` middleware; `requireWeddingRole` + `can()` scaffold; audit entries [TEST] unit + e2e incl. reuse detection | [01](../architecture/01-fnd.md) |
| FND-07 | AWS staging environment | 5 | [OPS] `infra/aws/*.sh` (VPC default, SG, EC2 `t4g.medium`, IAM instance role, S3 buckets media/backups, CloudFront + OAC for previews, KMS key), Nginx site (TLS, SSE settings, `.well-known`), PM2 `ecosystem.config.js` (`api`, `worker`), `infra/deploy.sh` (release dir, migrate, symlink, reload, health gate), GH OIDC role + `deploy-staging.yml` via SSM | [01](../architecture/01-fnd.md) |
| FND-08 | Observability | 3 | [API] Pino + redaction, request ids, Sentry Node (`instrument.ts`), `prom-client` metrics (HTTP latency histogram by route, queue depth/age, SSE connections, send/upload errors); [OPS] CloudWatch agent config, log groups (30-day retention), alarms (5xx rate, p95 > 1 s, queue age, disk > 80 %, backup missing), SNS | [01](../architecture/01-fnd.md) |
| APP-01a | App shell, sessions and host sign-in — first half: project, navigators, session store, Google + dev sign-in | 5 | [MOB] RN 0.88 bare project (Android first), flavours, `write-env`, Root/Welcome/Host/Guest navigator skeletons, multi-identity session store, secure-store, host+guest API clients with refresh middleware (ET pattern), Google sign-in + **dev sign-in screen** + URL picker, launch/offline/update-gate, Sentry RN, Intl + theme providers [API] `/v1/app/config` [TEST] | [25](../architecture/25-app.md) |
| ROL-04 | Organisation model | 3 | [DB] org columns/index · [API] orgs, seats, org invitations, implicit org-admin access in `loadMembership`, seat removal cascade · [MOB] Organization screen (basic) · [TEST] | [10](../architecture/10-rol.md) |
| ROL-02a | Matrix + enforcement scaffold (S2) | 2 | [API/domain] `permissions.ts`, `route()` builder, `loadMembership`/`requirePermission`, `serialize()` with audience schemas, route-coverage check · [TEST] matrix unit tests | [10](../architecture/10-rol.md) |
| ROL-03a | Audit writer (S2) | 1 | [DB] audit columns, trigger · [API] `audit.record`, diff + redaction map, request context | [10](../architecture/10-rol.md) |
| SET-01 | Create a wedding | 3 | [DB] ALTER weddings · [API] weddings router/service, family-org auto-create, owner membership, group seeding hook, IANA tz validation · [MOB] WeddingsHome, CreateWeddingWizard, WeddingOverview · [TEST] e2e create/list/404 | [03](../architecture/03-set.md) |
| SET-02 | Events with presets | 3 | [DB] events soft delete · [API] presets catalogue, events CRUD, bulk-from-presets, order, local-time conversion · [MOB] EventsList with reorder, EventEditor · [TEST] tz unit tests, e2e | [03](../architecture/03-set.md) |
| SET-03a | Venues + pasted map link | 3 | [DB] ALTER venues · [API] venues CRUD, link parser, resolve-link with allowlist · [MOB] VenuesList/Editor, clipboard prompt, "I'm at the venue" · [TEST] parser cases, SSRF tests | [03](../architecture/03-set.md) |
| GST-01 | Add/edit guests in parties | 5 | [DB] ALTER parties/guests · [API] parties/guests CRUD, primary rules, move, soft delete, serialiser with masking · [MOB] GuestList (basic), PartyEditor · [TEST] e2e + role masking | [04](../architecture/04-gst.md) |
| GST-04 | Phone normalisation | 2 | [API/domain] `phone.ts` (max/min builds) · [TEST] 40-case table | [04](../architecture/04-gst.md) |
| | **Total** | **40** | | |

**Demo:** On a real Android phone against staging: sign in with Google; on a dev build sign in with `dev:host@example.com`; create a 6-event wedding with venues; add a family party by hand. Staging refuses `dev:` tokens.


### S3 · 28 Dec 2026 – 10 Jan 2027 · Real guest lists (holiday sprint)

**Goal:** Import a messy real-world spreadsheet; groups; first S3 upload path; Android builds reach Play internal testing.  
**Planned:** 25 pts · Capacity 26

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| GST-02a | Import pipeline + API | 5 | [DB] import_jobs/rows · [JOB] parse/validate/commit/purge · [API] imports endpoints, error CSV · [TEST] fixtures, 1,000-row timing, crash resume | [04](../architecture/04-gst.md) |
| GST-02b | Import mobile flow | 3 | [MOB] ImportStart (file), Mapping, Preview, Progress · [TEST] RNTL | [04](../architecture/04-gst.md) |
| GST-05a | In-import duplicates | 1 | [JOB] in-file + existing match (phone exact, fuzzy) · [API] row actions | [04](../architecture/04-gst.md) |
| GST-06 | Groups and tags | 3 | [DB] group columns · [API] groups CRUD, seed, bulk assign · [MOB] group chips, multi-select bulk · [TEST] | [04](../architecture/04-gst.md) |
| GST-07a | Search, filters, export | 3 | [API] search, group/phone filters, `FilterContributor` registry, CSV stream · [MOB] filter sheet, export share · [TEST] | [04](../architecture/04-gst.md) |
| SET-05 | Key contacts | 1 | [DB] wedding_contacts · [API] CRUD/order, `/guest/wedding` contacts · [MOB] KeyContacts with native single-contact picker · [TEST] | [03](../architecture/03-set.md) |
| SET-06 | Wedding settings + cover | 3 | [API] settings Zod + merge, contrast check, cover link · [MOB] WeddingSettings, cover upload via upload queue · [TEST] | [03](../architecture/03-set.md) |
| CAM-01a | Upload core | 2 | [API] `media` module: policy registry, `POST /uploads`, `POST /complete`, `ObjectStore.presignPut` with signed length/checksum (FND-13) · [JOB] `media.process` skeleton (sanitise + derivatives for `cover`) · [TEST] e2e + MinIO header test | [12](../architecture/12-cam.md) |
| APP-05a | Store release pipeline — Android: Play internal testing pipeline | 3 | [OPS] Android: upload key + Play App Signing (ET `release-signing.md`), Fastlane `supply`, internal → closed testing → production (staged rollout); iOS: `match`, `gym`, `pilot` → TestFlight internal → external public link → App Store; `mobile-release.yml` on `mobile-v*` tags (iOS on macOS runner), Sentry source maps/dSYM/R8 mapping upload, versioning; listings, Data safety, privacy labels | [25](../architecture/25-app.md) |
| OPS-04a | Device lab setup (S4) | 1 | `[OPS]` buy 4 devices, manual checklist, Sentry release health | [26](../architecture/26-ops.md) |
| | **Total** | **25** | | |

**Demo:** Import the 500-row sheet from the concierge pilot into a wedding (with in-file duplicates flagged), group and export it; cover photo uploaded to S3 (MinIO locally); build installed from Play internal testing.


### S4 · 11 – 24 Jan 2027 · A guest opens their link and RSVPs

**Goal:** Guest mode end to end in the app: link → OTP (dev code 000000) → consent → schedule → RSVP; realtime hub live.  
**Planned:** 41 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| APP-01b | App shell, sessions and host sign-in — second half: guest identity, refresh middleware hardening, update gate | 3 | [MOB] RN 0.88 bare project (Android first), flavours, `write-env`, Root/Welcome/Host/Guest navigator skeletons, multi-identity session store, secure-store, host+guest API clients with refresh middleware (ET pattern), Google sign-in + **dev sign-in screen** + URL picker, launch/offline/update-gate, Sentry RN, Intl + theme providers [API] `/v1/app/config` [TEST] | [25](../architecture/25-app.md) |
| APP-02 | Deep and universal links | 3 | [OPS] `assetlinks.json`, AASA, Nginx; [MOB] `linking.ts`, Guest entry, Paste link, team-invite route; [WEB] lite page app block + Smart Banner [TEST] link matrix | [25](../architecture/25-app.md) |
| APP-04 | Offline cache and mutation outbox | 3 | [MOB] encrypted MMKV persister, `meta.persist` filter, per-identity namespaces, NetInfo/onlineManager, paused-mutation persistence + resume, stale banner [TEST] | [25](../architecture/25-app.md) |
| FND-14 | (new, absorbs ARR-05) Realtime infra | 3 | [DB] `realtime_events`, `rt_publish`; [API] SSE hub, `/stream` route, channel catalogue, limits; [JOB] purge; [MOB] `useEventStream` hook on `react-native-sse` (headers + reconnect + Last-Event-ID) [TEST] | [01](../architecture/01-fnd.md) |
| PRV-01 | Notice and consent records | 3 | `[DB]` notices, texts, consents alter, user acceptances · `[API]` notice + consent endpoints, stale-version 409, JWT consent claims · `[MOB]` re-consent sheet, privacy settings screen (consent screen itself in ACC-04) · `[WEB]` `/privacy`, `/g/:token/consent` · `[TEST]` e2e + children rule | [14](../architecture/14-prv.md) |
| ACC-01 | Personal link | 3 | [DB] `link_version`, `link_revoked_at` · [API] `link.ts` derive/hash, `auth/start` + `linkTicket`, host link GET/rotate/revoke, `linkForParty` export for MSG, `acc.link_rotated` · [WEB] landing page · [TEST] | [05](../architecture/05-acc.md) |
| ACC-02a | New-device OTP (app) | 5 | [DB] `guest_devices`, `otp_challenges` · [API] otp/verify, `OtpSender` + dev/fake, `GuestSessionPolicy` for FND refresh, session/devices endpoints, expiry job · [MOB] Welcome, OtpEntry (autofill), Devices · [TEST] | [05](../architecture/05-acc.md) |
| ACC-04 | Consent capture | 3 | [API] `requireConsent` middleware, `cns` claim, `consent_changed` handler · [MOB] ConsentGate incl. children · [WEB] redirect to PRV page · [TEST] | [05](../architecture/05-acc.md) |
| SET-04 | Event visibility by group | 3 | [DB] view + indexes · [API] PUT groups, audience count, `listInvitedEventIds` export, `/guest/events` · [MOB] "Who can see this" picker · [TEST] e2e visibility matrix | [03](../architecture/03-set.md) |
| GH-01 | Guest-mode shell (was "PWA shell") | 2 | [MOB] GuestNavigator tabs, home skeleton/states (empty, partial, offline banner), cache wiring with APP-04 · [TEST] | [11](../architecture/11-gh.md) |
| GH-02 | Personal schedule + home aggregate | 5 | [API] `guest-home` module, `GET /v1/guest/home` (parallel exports, ETag, partial), event detail · [MOB] GuestHome hero, ScheduleScreen, EventDetail, Open in Maps · [TEST] | [11](../architecture/11-gh.md) |
| RSV-01a | Per-event RSVP (API + app) | 5 | [DB] `rsvps`, `guest_dietary`, events alter · [API] guest GET/PUT, plus-ones via GST, override-skip rule, audit · [MOB] RsvpScreen, PlusOneSheet, DietSheet, outbox wiring · [TEST] | [06](../architecture/06-rsv.md) |
| | **Total** | **41** | | |

**Demo:** Tap a `https://<domain>/g/<token>` link on a budget Android: app opens in guest mode, OTP, consent, schedule shows only the events the party is invited to; RSVP for the whole family offline, syncs on reconnect.


### S5 · 25 Jan – 7 Feb 2027 · Send it once, reach everyone

**Goal:** WhatsApp sending through the provider interface, inbound replies routed, one-tap RSVP, live headcount.  
**Planned:** 41 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| MSG-01 | Provider abstraction + WhatsApp | 8 | [DB] templates, variants, messages, recipients, deliveries · [API] provider interfaces, `MetaCloudProvider`, `LogSinkProvider`, config guard · [API] webhook endpoints with signature + inline status apply · [TEST] fixtures, e2e | [07](../architecture/07-msg.md) |
| MSG-02 | Template catalogue | 3 | [DB] seed · [OPS] templates-as-code + push CLI · [JOB] template-sync + alert · [API] list endpoint | [07](../architecture/07-msg.md) |
| MSG-11 | Inbound reply router (new) | 3 | [DB] webhook events · [JOB] `msg.inbound-route` · [API] handler registry, payload codec, phone-hash fallback · [TEST] fake RSV/ARR handlers | [07](../architecture/07-msg.md) |
| MSG-03 | Announcement composer | 8 | [API] CRUD, audience spec + filter registry, preview, test-send · [MOB] composer stack, audience picker, preview, MMKV draft · [TEST] | [07](../architecture/07-msg.md) |
| MSG-05 | Fan-out worker | 5 | [JOB] resolve, send-batch, send-one, priority queue, token bucket, stuck sweep · [TEST] idempotency + crash cases | [07](../architecture/07-msg.md) |
| MSG-06 | Delivery and read status | 5 | [API] summary, deliveries list, retry-failed · [JOB] stats refresh + SSE · [MOB] detail + failures list | [07](../architecture/07-msg.md) |
| RSV-02 | One-tap WhatsApp RSVP | 3 | [API] `rsv` reply handler, scope rule, confirmation/closed replies, `context.eventIds` on invites · [TEST] contract tests with MSG fakes | [06](../architecture/06-rsv.md) |
| RSV-03 | Live headcount | 3 | [API] headcount query + `rtCursor`, delta publisher, `stale` triggers, channel in the FND catalogue · [MOB] HeadcountScreen + delta reducer · [TEST] | [06](../architecture/06-rsv.md) |
| ACC-05 | Abuse protection | 3 | [DB] `party_auth_state` · [API] limits table above, lock/unlock, host access view · [JOB] `acc.abuse-scan`, `acc.purge` · [OPS] Nginx zone, alarms · [TEST] | [05](../architecture/05-acc.md) |
| | **Total** | **41** | | |

**Risk:** if Meta verification or template approval is late, build against the BSP/Meta test number and the `LogSinkProvider`; RSV-02 slips to S8.

**Demo:** Invite 20 test phones on WhatsApp; tap "Attending"; headcount moves live on the host phone; per-guest sent/delivered/read.


### S6 · 8 – 21 Feb 2027 · Who has landed?

**Goal:** Travel details, guest status taps, live arrivals board and desk check-in by name.  
**Planned:** 42 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| TRV-01 | Guest travel form | 6 | [DB] travel_points, travel_legs, travel_leg_guests, travel_party_state · [API] guest CRUD, not-travelling, host CRUD, points CRUD · [MOB] TravelHome, TravelLegForm (arrival/departure), draft offline · [WEB] `/g/:token/travel` form · [TEST] e2e + RNTL | [08](../architecture/08-trv.md) |
| TRV-03 | Host travel view | 5 | [API] list with filters, summary, export (exceljs → S3 → URL) · [MOB] TravelOverview grid, TravelList, TravelLegEdit, share-sheet export · [TEST] xlsx read-back | [08](../architecture/08-trv.md) |
| ARR-05 | Realtime infrastructure | 2 | [API] register `arrivals` channel + ACL on FND hub · [MOB] `useRealtime` hook (`react-native-sse`, backoff, AppState) · [OPS] Nginx SSE config check · [TEST] SSE e2e | [09](../architecture/09-arr.md) |
| ARR-01 | Guest travel status | 5 | [DB] travel_status_updates, arrival_state · [API] guest status, host/desk status, inbound action handler · [JOB] travel-day ping (optional) · [MOB] status buttons + late sheet · [WEB] lite web forms · [TEST] | [09](../architecture/09-arr.md) |
| ARR-02 | Live arrivals board | 5 | [API] board snapshot + aggregate, event subscribers (TRV, PCK, GST) · [MOB] ArrivalsBoard (phone + tablet) · [TEST] | [09](../architecture/09-arr.md) |
| ARR-03a | Desk check-in — search, party sheet, partial check-in, undo, roster | 5 | search, party sheet, partial check-in, undo, roster | [09](../architecture/09-arr.md) |
| ARR-04 | "Still missing" | 2 | [API] missing list with role-gated contact · [MOB] StillMissing · [TEST] masking | [09](../architecture/09-arr.md) |
| GH-03 | My travel and status | 2 | [MOB] TravelStatusCard (ARR buttons), travel summary card, room placeholder · [TEST] | [11](../architecture/11-gh.md) |
| GH-07 | Guest QR | 1 | [MOB] MyQrScreen (ARR code, brightness, offline) · [TEST] | [11](../architecture/11-gh.md) |
| GST-07b | Status filters | 1 | [API] RSV/TRV/ARR contributors (each module adds its own) · [MOB] filter chips | [04](../architecture/04-gst.md) |
| ROL-01 | Team roles and invites | 5 | [DB] team_invitations, one-owner index · [API] team, invitations, accept, role change, remove, transfer · [MOB] Team, InviteMember (share sheet), PendingInvitations, MemberDetail, app link `/i/:token` · [JOB] cleanup cron · [TEST] | [10](../architecture/10-rol.md) |
| APP-06 | iOS platform bring-up | 3 | [MOB] iOS project, bundle ids per config, Associated Domains, push entitlement + APNs key in Firebase, Google Sign-In iOS client/URL scheme, permission strings, Keychain access settings; parity pass of APP-01..04 on iOS 15+ [TEST] | [25](../architecture/25-app.md) |
| | **Total** | **42** | | |

**Demo:** 30 test guests submit travel; tap "I've landed"; a desk-staff account (no phone numbers visible) checks a party in on a tablet; the board updates live. App runs on an iPhone.


### S7 · 22 Feb – 7 Mar 2027 · The disposable camera

**Goal:** Native camera with shot limits and film filter, offline upload queue, media worker; tickets upload; QR check-in; iOS pipeline.  
**Planned:** 41 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| CAM-01b | Camera purposes and S3 config | 3 | [API] `camera`/`gallery` policies (consent, event visibility, window, idempotency, dedupe) · [JOB] `media.reconcile`, `media.reap` · [OPS] bucket lifecycle rules, tags, CloudFront behaviour + key group + bucket policy, IAM delta · [TEST] | [12](../architecture/12-cam.md) |
| CAM-02 | Native camera | 5 | [MOB] VisionCamera screen, format selection, permission flow, fallback to `launchCamera`, open-time span · [TEST] RNTL + device timing | [12](../architecture/12-cam.md) |
| CAM-03 | Shot limit | 3 | [DB] counters · [API] atomic reservation, per-event/wedding scope, `GET /guest/camera`, host event overrides · [MOB] counter + offline mirror + "Film finished" · [TEST] concurrency e2e | [12](../architecture/12-cam.md) |
| CAM-04 | Film filter | 2 | [JOB] 3 `sharp` recipes + grain asset · [MOB] look chips + tint overlay · [TEST] golden images | [12](../architecture/12-cam.md) |
| CAM-05a | Persistent upload queue | 5 | [MOB] `lib/upload-queue` (MMKV index, file store, resize + hash, streaming PUT, retry classes, blocked/save-to-phone, queue screen) · [TEST] state machine | [12](../architecture/12-cam.md) |
| CAM-07 | Media worker | 5 | [JOB] full `media.process` (sniff, limits, re-hash dedupe, rotate, derivatives, blurhash, tags, delete raw, metrics, DLQ) · [TEST] fixtures | [12](../architecture/12-cam.md) |
| TRV-02 | Ticket upload | 3 | [API] attach/presigned GET, `kind=ticket` rules + `delete_after` · [MOB] TicketAttach via upload-queue, PDF picker · [TEST] | [08](../architecture/08-trv.md) |
| TRV-04 | Chase missing | 2 | [API] missing list, chase (idempotent, cool-down) via MSG interface · [MOB] TravelMissing · [TEST] | [08](../architecture/08-trv.md) |
| ARR-03b | Desk check-in — QR scan (vision-camera, checkin_code), offline queue and sync | 3 | QR scan (vision-camera, checkin_code), offline queue and sync | [09](../architecture/09-arr.md) |
| PRV-02a | Erasure framework (P0\) | 5 | `[API]` `PurgeParticipant` contract + registry + CI claim test · `[JOB]` `prv.request.process` with steps/resume · `[DB]` requests, steps, ledger · `[API]` guest + host erase endpoints, undo · `[OPS]` ledger bucket + mirror · `[TEST]` completeness e2e | [14](../architecture/14-prv.md) |
| APP-07 | Sign in with Apple for hosts (iOS) | 3 | [API] `AppleIdTokenVerifier` (JWKS, aud = bundle id), `google_sub = 'apple | [25](../architecture/25-app.md) |
| APP-05b | Store release pipeline — iOS: TestFlight pipeline | 2 | [OPS] Android: upload key + Play App Signing (ET `release-signing.md`), Fastlane `supply`, internal → closed testing → production (staged rollout); iOS: `match`, `gym`, `pilot` → TestFlight internal → external public link → App Store; `mobile-release.yml` on `mobile-v*` tags (iOS on macOS runner), Sentry source maps/dSYM/R8 mapping upload, versioning; listings, Data safety, privacy labels | [25](../architecture/25-app.md) |
| | **Total** | **41** | | |

**Demo:** Shoot 10 photos in airplane mode, kill the app, reconnect: all upload, EXIF/GPS stripped, previews appear. Check in by scanning the party QR. TestFlight build installed.


### S8 · 8 – 21 Mar 2027 · Push, SMS fallback, gallery and the no-install path

**Goal:** Push + SMS fallback complete the messaging chain; guest lite web covers schedule, RSVP and travel status without the app; gallery v1.  
**Planned:** 41 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| MSG-04 | Scheduled sends | 2 | [JOB] delayed `msg.resolve` + version check + sweep · [API] schedule/edit/cancel · [MOB] date-time picker in wedding tz | [07](../architecture/07-msg.md) |
| MSG-07 | SMS fallback | 5 | [API] `Msg91Provider` + DLR endpoint · [JOB] fallback sweep, immediate fallback on final WA errors · [DB] DLT ids on variants | [07](../architecture/07-msg.md) |
| APP-03 | Push notifications | 5 | [DB] `25-app.sql` [API] `devices` module, `PushProvider` + FCM + Fake, `push.send`, `push.purge` [MOB] permission ask at a meaningful moment (after first RSVP / host sign-in), channels, token refresh, tap routing [TEST] | [25](../architecture/25-app.md) |
| MSG-08 | Push (was web push) | 5 | [MOB] `@react-native-firebase/messaging`, APNs key, permission prompt, token registration, deep links, read receipt · [API] `FcmPushProvider`, token pruning; device registration slice of APP's `devices` module pulled forward | [07](../architecture/07-msg.md) |
| RSV-04 | Chase non-responders | 3 | [DB] `rsvp_chase_runs` · [API] non-responders, chase (idempotent), audience filter · [MOB] ChaseSheet, "last chased" · [TEST] | [06](../architecture/06-rsv.md) |
| ACC-02b | (split) Lite web session | 3 | [API] `mhf_gs` cookie session on `refresh_tokens`, `requireGuestSession`, CSRF helper · [WEB] OTP/verify forms, logout · [TEST] | [05](../architecture/05-acc.md) |
| RSV-01b | (split) Lite web RSVP form | 3 | [WEB] `/g/:token/rsvp` form + PRG · [TEST] | [06](../architecture/06-rsv.md) |
| GH-08 | (new) Guest lite web home | 3 | [WEB] layout, home partials, get-the-app block slot, headers/CSP, size-budget CI check · [TEST] | [11](../architecture/11-gh.md) |
| GAL-01 | Albums per event | 5 | [API] albums, keyset feed, `visibleTo`, CloudFront signer with window + LRU · [MOB] GalleryHome, AlbumGrid, PhotoViewer, FastImage · [TEST] | [13](../architecture/13-gal.md) |
| GAL-02a | Single download | 2 | [API] presigned GET with disposition · [MOB] save to camera roll + permission · [TEST] | [13](../architecture/13-gal.md) |
| GAL-03 | Hide and report | 3 | [DB] reports · [API] hide/unhide/delete, report, auto-hide, moderation queue · [JOB] hide purge + invalidation, rebuild, purge deleted · [MOB] report sheet, ModerationQueue · [TEST] | [13](../architecture/13-gal.md) |
| CAM-08 | Camera QR / link | 2 | [API] codes, resolve, rotate, `qr.pdf` · [WEB] `/c/:code` landing · [MOB] linking routes · [OPS] AASA/assetlinks `/c/*` · [TEST] | [12](../architecture/12-cam.md) |
| | **Total** | **41** | | |

**Demo:** An announcement reaches an app user by push, a WhatsApp user, and a phone without WhatsApp by SMS; a guest without the app RSVPs and taps "I've landed" on the lite web page; photos browse by event and the host hides one.


### S9 · 22 Mar – 4 Apr 2027 · Hardening and the rehearsal wedding

**Goal:** Per-role permission suite, audit viewer, security review, production environment, accessibility; run the rehearsal.  
**Planned:** 40 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| ROL-02b | Per-role test suite (S8) | 5 | [TEST] generated route × role e2e, leak sentinel, desk navigator review across all modules · [MOB] DeskNavigator, `useCan` audit of screens | [10](../architecture/10-rol.md) |
| ROL-03b | Audit viewer (S8) | 3 | [DB] viewer indexes · [API] viewer endpoints, redaction function for PRV-02 · [MOB] Activity screen · [TEST] | [10](../architecture/10-rol.md) |
| PRV-04 | Encryption and least privilege | 3 | `[OPS]` EBS default encryption, bucket policies, KMS backup key, Object Lock dumps bucket, `age` key ceremony, IAM roles, OIDC deploy role, SSM params + `render-env.sh`, CloudTrail/GuardDuty, gitleaks, log redaction config | [14](../architecture/14-prv.md) |
| PRV-05 | Pre-pilot security review | 5 | `[TEST]` isolation harness, permission-coverage test · `[OPS]` `prod-audit.sh` · threat model + OWASP pass · fix budget | [14](../architecture/14-prv.md) |
| PRV-06 | Store privacy disclosures (new) | 2 | App Store privacy label, Play data safety form, permission purpose strings, SDK inventory, review with counsel | [14](../architecture/14-prv.md) |
| FND-11 | Production environment | 5 | [OPS] separate AWS account (Organizations), prod box `m7g.large`, gp3 100 GB, pgBackRest + nightly `pg_dump`, `deploy-prod.yml` (manual approval, tag), rollback (symlink flip + `prisma migrate` expand/contract rule), runbook, restore test | [01](../architecture/01-fnd.md) |
| GH-04 | Key contacts | 1 | [MOB] ContactsScreen, call/WhatsApp intents · [TEST] | [11](../architecture/11-gh.md) |
| GH-05 | Accessibility | 3 | [MOB] font-scale 2.0 pass, high contrast, labels · [WEB] lite web a11y · [TEST] usability sessions with 3 guests over 60 | [11](../architecture/11-gh.md) |
| GH-06 | Announcements inbox | 1 | [MOB] AnnouncementsScreen on MSG endpoints, unread badge, deep link · [TEST] | [11](../architecture/11-gh.md) |
| APP-08 | Performance budget and release checks | 2 | [MOB] start-up spans, lazy host/camera/gallery, bundle-size CI check, dev-string grep; [TEST] budget run on reference device | [25](../architecture/25-app.md) |
| APP-09 | Store compliance | 3 | [API] `DELETE /v1/me` + job (uses PRV erasure) [MOB] delete-account + leave-invitation flows, privacy links [OPS] web deletion page, Data safety/labels, **reviewer demo access** (demo wedding + review credentials, see §13) | [25](../architecture/25-app.md) |
| OPS-03 | Per-wedding live dashboard (P0\) | 5 | `[DB]` minute/system/alerts/watch tables · `[API]` `metrics.ts` + flush, call sites in MSG/CAM/ACC/ARR/SSE, admin JSON endpoints · `[JOB]` sample, evaluate, prune, backup check · `[WEB]` `/admin` Google login + two pages · `[TEST]` | [26](../architecture/26-ops.md) |
| MSG-10 | Opt-out | 2 | [DB] opt-outs · [JOB] STOP/START keywords · [API] guest and host endpoints · [WEB] lite-page link | [07](../architecture/07-msg.md) |
| | **Total** | **40** | | |

**Rehearsal:** a mock 2-day wedding with ~50 friends and family (5+ over 60, 5+ without the app) on production: invite, RSVP, travel, announcements, check-in, camera, gallery.

**Gate 2 (4 Apr):** rehearsal ran end to end with no blocker bugs; app cold start < 3 s and camera open < 2 s on the budget Android; ≥ 90% of rehearsal announcements delivered < 2 min; security review has no open high-severity issues; both store builds approved for internal/closed testing.

**Demo:** The rehearsal itself, plus the live per-wedding dashboard during it.


### S10 · 5 – 18 Apr 2027 · Pilot readiness (P0\* catch-up)

**Goal:** Everything a real pilot wedding needs that the rehearsal could live without.  
**Planned:** 41 pts · Capacity 42

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| GST-03 | Google Sheets (link) | 2 | [JOB] sheet fetcher with allowlist · [API] url parse · [MOB] paste flow · [TEST] stub | [04](../architecture/04-gst.md) |
| GST-05b | Duplicate finder + merge | 4 | [API] duplicates, dismiss, guest/party merge + registry · [MOB] Duplicates · [TEST] merge with RSV/TRV hooks | [04](../architecture/04-gst.md) |
| ACC-03 | Shared family phone | 3 | [API] switch endpoint, `sub`/`vid` claims, audit attribution helper used by RSV/TRV/ARR · [MOB] MemberSwitcher, banner, consent-on-switch · [WEB] member switch form · [TEST] | [05](../architecture/05-acc.md) |
| RSV-05 | Host RSVP on behalf | 2 | [API] host PUT with note + audit · [MOB] PartyRsvpEditor, RsvpListScreen · [TEST] | [06](../architecture/06-rsv.md) |
| MSG-09 | Quota metering | 3 | [DB] quotas · [API] reserve/commit/release, 80% warning push to owner, block · [MOB] banner | [07](../architecture/07-msg.md) |
| CAM-05b | Background drain | 3 | [MOB] `react-native-background-fetch` headless task (Android) + BGAppRefresh (iOS), identity token refresh in headless context · [TEST] device kill/reboot | [12](../architecture/12-cam.md) |
| CAM-06 | Delayed reveal | 3 | [API] reveal computation, override + "Reveal now", recompute job · [JOB] `photos.reveal_notify` push · [MOB] developing states, host controls · [TEST] | [12](../architecture/12-cam.md) |
| GAL-02b | Host album zip | 3 | [DB] `gallery_exports` · [API] create/status · [JOB] `build_zip`, `expire_exports` · [OPS] exports bucket lifecycle · [MOB] Exports screen, share link · [TEST] | [13](../architecture/13-gal.md) |
| PRV-02b | Export + web request + account deletion | 3 | `[JOB]` export zip · `[API]` export download with step-up, host account delete/export, web request + verify · `[MOB]` host account screens, guest download/delete · `[WEB]` `/privacy/delete` · `[TEST]` | [14](../architecture/14-prv.md) |
| PRV-03 | Retention jobs (P0\) | 5 | `[DB]` `wedding_retention_state`, weddings alter, runs · `[API]` `/retention` · `[JOB]` media, classes, weddings, recompute, warn crons · `[OPS]` S3 lifecycle (exports, noncurrent versions, multipart) · `[MOB]` host retention screen · `[TEST]` dry-run, tz edge | [14](../architecture/14-prv.md) |
| OPS-04b | Automated smoke (S9) | 4 | `[TEST]` Maestro flows host + guest, network throttle profiles, Firebase Test Lab job · `[MOB]` testIDs for key controls, diagnostics screen | [26](../architecture/26-ops.md) |
| OPS-02 | Status page and on-call | 3 | `[OPS]` uptime monitors (`/readyz`, `/g/health`, 2 regions), status page, paging schedule, CloudWatch → SNS → pager, deploy-guard in deploy script, runbooks (messaging stuck, BSP down → SMS fallback, uploads failing, disk full, box lost → restore, OTP failures, cert expiry) | [26](../architecture/26-ops.md) |
| OPS-06 | Backup and DR drill | 3 | `[OPS]` pgBackRest + dump setup is **FND-11**; this story: drill script, isolated restore VPC, erasure replay, key-custody check, RTO/RPO record | [26](../architecture/26-ops.md) |
| | **Total** | **41** | | |

Also: pilot onboarding playbook, support WhatsApp line, on-call rota for pilot dates, first DR drill (OPS-06). **Onboard pilot #1.**

**Demo:** Restore production from backup into a clean box; guest data export and erasure run end to end; status page live.


---

## Phase 2 — Pilots + P1 (S11–S16)

3–5 pilot weddings, Apr–Jul 2027. **~32 planned + 10 pilot buffer per sprint.** Default P1 order is logistics first; reorder with the Gate 1 ranking and live pilot requests (re-run the `architect` agent on any story whose scope changes).


### S11 · 19 Apr – 2 May 2027 · Pickups

**Goal:** Batch arrivals into vehicles, drivers, notify guests; room inventory and manual assignment.  
**Planned:** 31 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| GST-08 | Phone contacts | 3 | [MOB] ContactsPicker, permission rationale, iOS limited access, Play data-safety · [API] inline rows source · [TEST] | [04](../architecture/04-gst.md) |
| PCK-01 | Auto-batch arrivals | 5 | [DB] batches, members, plan runs, btree_gist · [API] plan, unbatched · [MOB] PickupsHome plan flow, PickupTimeline · [TEST] planner fixtures + property test | [15](../architecture/15-pck.md) |
| PCK-02 | Vehicles, drivers, manual edits | 5 | [DB] vehicles, drivers, EXCLUDE · [API] CRUD, PATCH batch, moves, cancel · [MOB] BatchDetail + Move sheet, Vehicles, Drivers · [TEST] | [15](../architecture/15-pck.md) |
| PCK-03 | Notify guests | 2 | [API] notify (versioned, idempotent) · [MOB] Notify screen · [WEB] "Your pickup" on lite page · [OPS] `pickup_assigned` template approval | [15](../architecture/15-pck.md) |
| PCK-05 | Driver link | 3 | [DB] driver_links · [WEB] `/d/:token` page + forms · [API] link create/revoke · [TEST] | [15](../architecture/15-pck.md) |
| ROM-01 | Room inventory import | 3 | [DB] hotels, room_types, rooms, room_imports · [API] template, parse, commit, manual CRUD · [MOB] RoomImport, RoomsHome · [TEST] parser fixtures | [16](../architecture/16-rom.md) |
| ROM-02a | Assign parties to rooms — manual assign/move/swap, conflict checks, room grid | 5 | manual assign/move/swap, conflict checks, room grid | [16](../architecture/16-rom.md) |
| FACE-01 | Spike | 3 | [OPS] dataset with consent, Rekognition test account + AI opt-out, quota check · [TEST] accuracy/cost/latency report, licence check | [19](../architecture/19-face.md) |
| SET-03b | In-app pin picker (split, P1) | 2 | [MOB] react-native-maps (Android key, iOS Apple Maps), draggable pin · [OPS] Maps SDK key restricted to app signatures | [03](../architecture/03-set.md) |
| | **Total** | **31** | | |

Start the Rekognition quota-increase request (FACE-01 outcome).


### S12 · 3 – 16 May 2027 · Rooms, ID vault and Hindi

**Goal:** Auto-suggest rooms, rooming list, encrypted ID vault with auto-delete; Hindi guest mode.  
**Planned:** 30 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| ROM-02b | Assign parties to rooms — auto-suggest + suggestion review | 3 | auto-suggest + suggestion review | [16](../architecture/16-rom.md) |
| ROM-03 | Guest and desk view | 2 | [API] guest room, `getRoomForGuests` for ARR, settings flags · [MOB] guest room card · [WEB] lite card · [TEST] | [16](../architecture/16-rom.md) |
| ROM-04 | Rooming list export | 2 | [API] export (per-hotel sheets + summary) · [MOB] export + share sheet · [TEST] read-back | [16](../architecture/16-rom.md) |
| IDV-01a | Vault, keys and upload API | 5 | [DB] vaults, documents · [OPS] idv bucket + policy + lifecycle, `mehfil-idv-keys` role, CloudTrail data events · [API] key provisioning, upload create with SSE-KMS presign, settings · [JOB] `idv.process_document` · [TEST] incl. `FakeKms` | [17](../architecture/17-idv.md) |
| IDV-01b | App upload flow | 3 | [MOB] IdVaultHome, consent sheet (masked Aadhaar guidance), card-frame capture, sensitive queue mode · [TEST] | [17](../architecture/17-idv.md) |
| IDV-02 | Restricted view with logging | 5 | [DB] grants, access log · [API] view with log-first + watermark, grants, access-log list, guest "viewed N times" · [MOB] IdViewer (biometric, `FLAG_SECURE`), dashboard, access log · [TEST] | [17](../architecture/17-idv.md) |
| IDV-04 | Auto-delete | 3 | [API] IDV `PurgeParticipant` (class, guest, wedding subjects) · [JOB] reminder, verify · [OPS] alarms · [TEST] shred e2e | [17](../architecture/17-idv.md) |
| L10N-01 | Hindi | 5 | [MOB] `hi` catalogues for Guest mode, consent notice, errors · [API] server-side `l10n.t` for lite web, push, SMS · [OPS] submit `hi` WhatsApp templates and DLT `hi` SMS templates · [TEST] CI key checks, device QA | [20](../architecture/20-l10n.md) |
| L10N-03a | Language preference | 2 | [DB] `guests.preferred_language` · [API] preference endpoint, effective-language helper, MSG recipient language · [MOB] picker on first open + settings · [WEB] lite `?lang` | [20](../architecture/20-l10n.md) |
| | **Total** | **30** | | |

Submit Hindi WhatsApp and DLT SMS templates.


### S13 · 17 – 30 May 2027 · Planners

**Goal:** Multi-wedding overview (phone + tablet), team seats, clone a wedding; hotel ID export; translated host content.  
**Planned:** 29 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| IDV-03 | Export for hotel | 3 | [DB] exports · [API] create/status/download · [JOB] PDF build + expiry · [MOB] IdExport · [TEST] | [17](../architecture/17-idv.md) |
| IDV-05 | Vault security review | 3 | [OPS] external review, fixes | [17](../architecture/17-idv.md) |
| PLN-01a | Overview API + health snapshots | 5 | [DB] snapshots · [API] module `healthCounts` exports (GST, RSV, TRV, MSG), overview endpoint, refresh · [JOB] recompute (debounced) + nightly rebuild · [MOB] phone overview list · [TEST] | [18](../architecture/18-pln.md) |
| PLN-01b | Tablet two-pane + offline (split) | 3 | [MOB] two-pane layout, persisted cache + "as of" banner, deep links · [TEST] device check on tablet | [18](../architecture/18-pln.md) |
| PLN-02 | Team seats | 3 | [API] org invites via ROL, assignments PUT, removal cascade + token revoke, seat limit check · [MOB] Team screens · [TEST] | [18](../architecture/18-pln.md) |
| PLN-05 | Clone / templates | 5 | [DB] templates, clones · [API] snapshot/import orchestration; export/import parts in SET (events, venues, settings, contacts), GST (groups), MSG (drafts) · [MOB] templates library + new-wedding flow · [TEST] no-PII assertions | [18](../architecture/18-pln.md) |
| L10N-03b | Content translation with host review | 5 | [DB] translations, glossary, usage · [JOB] translate, enable-language · [API] review, preview, glossary · [MOB] review screen, composer preview tabs, "Show original" · [TEST] | [20](../architecture/20-l10n.md) |
| L10N-04 | Indic fonts and formats | 2 | [MOB] script line-height tokens, no fixed heights · [API/domain] date-fns locales, Indian number grouping · [WEB] font stack · [TEST] device checks | [20](../architecture/20-l10n.md) |
| | **Total** | **29** | | |

Submit WhatsApp templates that carry the planner name (needed by PLN-04).


### S14 · 31 May – 13 Jun 2027 · Find my photos and flight delays

**Goal:** Opt-in face search; flight status feeds the board and pickup reassignment; first load test.  
**Planned:** 31 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| FACE-02 | Opt-in and selfie | 3 | [DB] enrolments · [API] enrolment endpoints, `selfie` upload policy · [MOB] intro, consent, SelfieCapture, settings · [TEST] | [19](../architecture/19-face.md) |
| FACE-03a | Collections and indexing | 5 | [DB] collections, photo index · [JOB] collection lifecycle, backfill, `index_photo`, `unindex_photo`, throttling · [API] `FaceProvider` + Rekognition + fake · [OPS] IAM · [TEST] | [19](../architecture/19-face.md) |
| FACE-03b | Matching | 3 | [JOB] `face.enrol` search, per-face search on new photos, push · [DB] matches · [TEST] | [19](../architecture/19-face.md) |
| FACE-04 | "My photos" | 2 | [API] list + dismiss (GAL `visibleTo`) · [MOB] MyPhotos | [19](../architecture/19-face.md) |
| FACE-05 | Face data deletion | 3 | [API] PurgeParticipant · [JOB] withdraw, delete_collection, verify_deletions · [TEST] | [19](../architecture/19-face.md) |
| TRV-05 | Flight status lookup | 5 | [DB] flight_status_cache · [JOB] schedule + poll · [API] refresh endpoint · [OPS] AeroDataBox account, key in `.env`, cost alert · [TEST] fake timeline | [08](../architecture/08-trv.md) |
| PCK-04 | Reassign on delays | 5 | [DB] alerts · [JOB] event subscribers, no-vehicle cron · [API] alerts list/apply/dismiss · [MOB] PickupAlerts + push deep link · [TEST] | [15](../architecture/15-pck.md) |
| OPS-01a | Load-test harness + first pass (S14) | 5 | `[TEST]` seed generator, k6 scripts S1–S4, `xk6-sse` build · `[API]` `LatencyFakeProvider` with webhook callbacks · `[OPS]` load-generator instance, staging sized like prod · SQL latency report | [26](../architecture/26-ops.md) |
| | **Total** | **31** | | |

Face search needs counsel sign-off on Rekognition storage (decision below) before FACE-03a starts.


### S15 · 14 – 27 Jun 2027 · Sangeet quiz and Kannada

**Goal:** Live quiz with projector screen and leaderboard; Kannada; wishes; planner branding.  
**Planned:** 28 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| QZ-01 | Quiz builder | 3 | [DB] quiz tables + Prisma; [API] quiz/question/option CRUD, reorder, validation; [MOB] QuizList, QuizEditor, QuestionEditor with image upload, preview; [TEST] e2e CRUD + one-correct | [21](../architecture/21-qz.md) |
| QZ-02a | Live engine + guest player | 5 | [API] sessions, commands with versions, join, question GET with LRU, answer insert, `/me`, `/time`; [JOB] `quiz.close-question`; [API] SSE channel auth for `quiz:*` (with FND); [MOB] guest lobby/question/reveal, SSE store, clock sync, retry; [TEST] e2e live run, fairness edge cases; [TEST][OPS] 500-player load test | [21](../architecture/21-qz.md) |
| QZ-02b | Projector screen + host console | 5 | [WEB] `/screen` page, pairing, keyboard/clicker control, distribution + leaderboard views; [API] screens, pairing, screen state; [MOB] QuizControl console; [TEST] Playwright smoke, pairing security tests | [21](../architecture/21-qz.md) |
| QZ-03 | Leaderboard + async | 3 | [API] leaderboard/rank, async start/next/answer, async close job; [MOB] leaderboard views, QuizAsync, home card; [TEST] async timer can't reset, async → live exclusion | [21](../architecture/21-qz.md) |
| L10N-02 | Kannada | 2 | Same as L10N-01 for `kn`, reusing the pipeline | [20](../architecture/20-l10n.md) |
| FEED-03a | Wishes (can ship without the feed) | 3 | [DB] `feed_settings`, `feed_posts`, `feed_post_media`; [API] settings, create wish, wishes list; [MOB] WishesCompose, WishesBook, FeedSettings; [WEB] `/g/:token/wish`; [TEST] private-wish leakage, mode gates | [22](../architecture/22-feed.md) |
| PLN-04 | Planner branding | 5 | [DB] branding, media org scope, wedding toggle · [API] branding CRUD, org uploads, contrast check, guest-home payload · [MOB] host branding screen + guest theming · [WEB] lite web CSS vars · [OPS] Meta approval of template variants with planner-name param (via MSG-02) · [TEST] | [18](../architecture/18-pln.md) |
| GAL-05 | Upload from phone gallery | 2 | [API] `gallery` purpose + limit · [MOB] picker, JPEG conversion, event choice, remaining count · [TEST] | [13](../architecture/13-gal.md) |
| | **Total** | **28** | | |


### S16 · 28 Jun – 11 Jul 2027 · Feed or AI tickets, entitlements, then measure

**Goal:** Feed only if pilot hosts asked for it; AI ticket reading; plan entitlements; pilot metrics report.  
**Planned:** 24 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| FEED-01 | Threads and photo posts | 4 | [API] threads, thread page with pins + cursor, create post with media, edit/delete; [MOB] FeedThreads, FeedThread, FeedCompose (upload queue); [JOB] retention; [TEST] visibility, media validation, idempotency | [22](../architecture/22-feed.md) |
| FEED-02 | Moderation | 3 | [DB] `feed_reports`; [API] moderation actions, queue, reports, auto-hold, word list; [MOB] FeedModeration; [TEST] audit + threshold | [22](../architecture/22-feed.md) |
| FEED-03b | Reactions | 1 | [DB] `feed_reactions`; [API] set/clear, aggregation; [MOB] reaction picker; [TEST] | [22](../architecture/22-feed.md) |
| TRV-06 | AI ticket reading | 5 | [DB] ticket_extractions · [JOB] extract · [API] start/poll/apply · [MOB] TicketReviewScreen · [OPS] Anthropic key, spend cap · [TEST] golden set of 30 real (redacted) tickets run against the real model in a manual eval, fake in CI | [08](../architecture/08-trv.md) |
| BIL-01 | Plans and entitlements | 8 | [DB] catalogue, wedding_plans, addons, entitlements tables + seed · [API] `entitlements` service (`get/require/checkLimit/forOrg`), lazy Free default, `requireFeature` middleware, GET entitlements · [API] wire GST/CAM checks, MSG `setQuotaLimit`, PRV retention hook, feature gates on PCK/ROM/IDV/FACE/QZ/FEED/L10N · [API] admin overrides + comp · [MOB] Plan & usage screen, limit banners · [TEST] per-limit e2e | [23](../architecture/23-bil.md) |
| GAL-04 | Save album + favourites | 3 | [DB] favourites · [API] favourite, download-list · [MOB] SaveAlbumSheet download queue, favourites filter · [TEST] | [13](../architecture/13-gal.md) |
| | **Total** | **24** | | |

If the feed is not wanted, drop FEED-01/02/03b (8) and take QZ-04 lite web quiz player (3) + hardening.

**Gate 3 (11 Jul):** pilot metrics (table below).


**Gate 3 (11 Jul) — pilot metrics (PRD):**

| Metric | Target |
| --- | --- |
| Guest activation (opened app **or** lite web) | ≥ 70% — track app installs separately; the native-app choice makes this the riskiest metric |
| RSVP response within 7 days | ≥ 85% |
| Travel details captured (out-station guests) | ≥ 80% |
| Arrivals tracked | ≥ 90% |
| Photos collected | ≥ 15 per 10 guests |
| Guests over 60 reached by any channel | ≥ 80% (if missed, VOX-01 voice calls take P2 slot 1) |
| Pilot planners who intend to buy a pack | ≥ 50% |
| NPS | Host ≥ 50, guest ≥ 40 |


---

## Phase 3 — Season readiness (S17–S24)

Planners choose tools for Nov–Dec weddings in Aug–Sep, so billing, onboarding and the site must be live by **S19 (sales start)**. ~32 planned + 10 buffer per sprint.


### S17 · 12 – 25 Jul 2027 · Get paid

**Goal:** Razorpay web checkout, GST invoices, credit packs, add-ons, analytics, season standby box.  
**Planned:** 30 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| BIL-02a | Checkout + webhooks (split) | 5 | [DB] orders, items, payments, webhook events · [API] `PaymentProvider` (Razorpay + fake), create order, verify, webhook route (raw body), fulfil, upgrade pricing · [JOB] webhook process, reconcile · [TEST] idempotency/race suite · [OPS] Razorpay dashboard webhook + auto-capture, secrets | [23](../architecture/23-bil.md) |
| BIL-02b | GST invoices (split) | 5 | [DB] counters, invoices, lines · [API] gst.ts, numbering, credit notes, invoice list/PDF · [JOB] render (pdfkit) + email · [OPS] SES domain verification (DKIM/SPF), billing S3 prefix + 8-year lifecycle · [TEST] tax math + gapless numbering | [23](../architecture/23-bil.md) |
| BIL-05 | Web account + checkout pages (new) | 3 | [WEB] `/account` sign-in (GIS + dev form), session cookies, CSRF, checkout, receipt, billing pages · [DB] web_sessions · [TEST] HTML e2e · [OPS] CSP, Nginx routes | [23](../architecture/23-bil.md) |
| BIL-03 | Planner credit packs | 5 | [DB] lots + ledger · [API] consume/release/activate, credits endpoints, pass SKUs for families · [JOB] expiry + warning · [MOB] activate sheet · [TEST] concurrency (two activations, one credit) | [23](../architecture/23-bil.md) |
| BIL-04 | Add-ons | 2 | [API] add-on SKUs in checkout, stacking in recompute · [WEB] add-on choice on checkout page · [TEST] | [23](../architecture/23-bil.md) |
| BIL-06 | Store-compliant plan UI + upgrade nudges (new) | 2 | [MOB] neutral copy, lint rule, RNTL test · [JOB] limit-nudge emails · [OPS] legal review of Apple 3.1.3(f) / Play payments policy, App Review notes explaining the model | [23](../architecture/23-bil.md) |
| PLN-03 | Credits | 2 | [API] proxy to `billing` exports · [MOB] Credits screen (no purchase CTA) · [TEST] | [18](../architecture/18-pln.md) |
| GTM-03 | Analytics pipeline (new) | 3 | [DB] analytics_events partitions, opt-out column · [API] ingest endpoints, server emitters, buffer · [MOB] tiny `track()` client with batching · [JOB] partitions, weekly report · [OPS] read-only role, saved SQL funnels · [TEST] | [24](../architecture/24-gtm.md) |
| OPS-07 | Season hot standby (new) | 3 | `[OPS]` streaming replica on `t4g.large` in another AZ, pgBackRest `standby` from repo, promotion runbook, Elastic IP move, drill | [26](../architecture/26-ops.md) |
| | **Total** | **30** | | |

Legal review of the web-only checkout before the S18 store submission.


### S18 · 26 Jul – 8 Aug 2027 · Self-serve + P2 slot 1

**Goal:** Onboarding wizard and marketing site live before sales start; first P2 pick.  
**Planned:** 25 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| GTM-01 | Onboarding wizard | 8 | [DB] onboarding_sessions · [API] onboarding endpoints, domain-event hooks · [MOB] OnboardingNavigator, wizard-mode variants of SET/GST/MSG screens, contacts multi-select, test-send, pass activation · [GST/MSG] "import beyond limit, choose who to invite" support · [TEST] e2e + usability sessions | [24](../architecture/24-gtm.md) |
| GTM-02 | Marketing site | 5 | [WEB] Astro site in `apps/site` (home, pricing from catalogue, planners, demo, privacy/terms) · [API] `/v1/leads` + leads admin list · [JOB] lead notify/purge · [OPS] S3 + CloudFront + ACM, GH Actions deploy, apex redirect · [TEST] Lighthouse, link check | [24](../architecture/24-gtm.md) |
| OPS-05 | CDN and capacity tuning (reinterpreted) | 2 | `[OPS]` CloudFront cache policy for previews (immutable keys, 1-year TTL, signed URLs with stable query handling), worker concurrency config, vertical resize runbook | [26](../architecture/26-ops.md) |
| VOX-01 | Voice calls in the guest's language | 10 | [API] `VoiceProvider` (Exotel + fake), `TtsProvider` (Google + fake), campaigns, webhook; [JOB] place-call with window; [MOB] call flow + results; [OPS] provider KYC/DLT; [TEST] | [27](../architecture/27-p2.md) |
| | **Total** | **25** | | |

P2 slot 1 defaults to voice calls (VOX-01) if Gate 3 showed older-guest reach < 80%; otherwise take WSH-01. Start voice-provider KYC/DLT at Gate 3. APP-10 OTA updates (3) optional.


### S19 · 9 – 22 Aug 2027 · Sales start + P2 slot 2

**Goal:** Planner demo environment and collateral; white-label for venue deals.  
**Planned:** 11 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| WL-01 | White-label (theming + custom domain) | 6 | [OPS] Nginx → Caddy edge; [API] domains + verify job + `ask` hook; link generation; badge entitlement; [TEST] | [27](../architecture/27-p2.md) |
| VOX-02 | WhatsApp voice-note announcements | 5 | [JOB] voice-note video render; [API] MSG video header + audio session send; [MOB] recorder; [WEB] audio page; [TEST] | [27](../architecture/27-p2.md) |
| | **Total** | **11** | | |

Remaining capacity: pilot backlog and hardening (~20 pts).


### S20 · 23 Aug – 5 Sep 2027 · P2 slot 3

**Goal:** Pick from pilot feedback.  
**Planned:** 8 pts · Capacity 42 (32 planned + 10 buffer)

| Story | Title | Pts | Tasks (from the design doc) | Design |
| --- | --- | --- | --- | --- |
| WSH-01 | Video wishes and guest book | 8 | [MOB] record + compress; [JOB] video queue, remux, reel; [API] reel/book; `PdfRenderer`; [TEST][OPS] device lab | [27](../architecture/27-p2.md) |
| | **Total** | **8** | | |

Or PWP-01a album export + reel (8). Third language once chosen (~3 pts on the L10N pipeline).


### S21–S24 · 6 Sep – 31 Oct 2027 · Scale, onboarding, freeze, launch readiness

| Sprint | Dates | Work |
| --- | --- | --- |
| S21 | 6 – 19 Sep | OPS-01b peak + soak load test (2,000-guest announcement, 300 uploads/min, 50 live weddings, SSE connections) (3); external pen test; OPS-07 standby failover drill; fixes |
| S22 | 20 Sep – 3 Oct | Onboard first paying planners: import help, training, support tooling; fixes |
| S23 | 4 – 17 Oct | Bug bash on the device lab; accessibility pass with older users; help centre. **Feature freeze 17 Oct.** |
| S24 | 18 – 31 Oct | Release candidate through both stores; DR drill; on-call rota for every November wedding date; support playbooks |

**Gate 4 (31 Oct):** no open P0/P1 bugs; load-test targets met on the production box (or the RDS / second-box trigger from 26-ops has been acted on); pen-test highs fixed; real payment tested end to end; store builds live; on-call covers every live wedding date.

## Phase 4 — Launch (S25 · 1 – 14 Nov 2027)

Live for the season. Daily triage, per-wedding dashboards watched during events, weekly planner check-ins, 99.9% availability on wedding dates.

---

## Working agreements

**Definition of Ready:** design doc section for the story is current (architect agent run if scope changed); product decisions it depends on are answered; acceptance criteria and designs attached; dependencies done or in the same sprint.

**Definition of Done:**

- Merged with CI green: lint, type-check, unit tests, **API e2e against Postgres 16**, and the generated `packages/api-client` is up to date.
- Every wedding-scoped query filters by `wedding_id`; another wedding's data returns 404; an e2e test per role touched (desk staff never receive phone numbers).
- Guest-facing strings externalised; checked on the budget Android in the device lab and on iOS.
- Modules that store personal data implement `PurgeParticipant` (14-prv) and set retention (`delete_after`) for their media.
- Metrics/log call sites added for anything that matters during a live wedding (26-ops); nothing sensitive in logs (tokens, OTPs, phone numbers, ID data).
- Design doc updated if the implementation changed the data model or API.
- Deployed to staging and shown in the demo.

**Ceremonies:** planning (Mon, 1 h, includes the architecture check of next sprint's stories), 15-min daily stand-up, mid-sprint refinement (45 min), demo + retro (last Fri). During pilots: a short pilot review in each demo.

## Long-lead admin (start in S0 unless noted)

| Item | Blocks | Owner |
| --- | --- | --- |
| Meta business verification, WhatsApp sender, display name, templates (en, then hi/kn in S12) | MSG, ACC OTP over WhatsApp, RSV-02 | Founder |
| WhatsApp messaging tier upgrade (the real capacity ceiling: 50 weddings × 2,000 guests) | Season scale | Founder, from S10 |
| TRAI DLT entity, sender header, SMS templates | MSG-07 SMS fallback, OTP fallback | Founder |
| D-U-N-S → Apple Developer + Google Play **organisation** accounts | APP-05 store pipelines (S3/S7) | Founder |
| Razorpay KYC | BIL (S17) | Founder |
| Amazon SES domain verification | Planner invites, billing emails | Eng, S10 |
| Rekognition request-rate quota (Mumbai) | FACE (S14) | Eng, S11 |
| Voice provider KYC/DLT (if VOX-01 chosen) | S18 | Founder, at Gate 3 |
| Counsel: DPDP notice, fiduciary vs processor, lawful basis for first invite, store data-safety answers, face-data storage, web-only checkout | PRV-01 (S4), FACE (S14), BIL (S17) | Founder + counsel |

## Critical path and schedule risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| App Store / Play review (native app is now on the guest path) | Pilots can't install; rehearsal slips | Organisation accounts in S0; internal testing from S3 (Android) / S7 (iOS); APP-09 store compliance and PRV-06 privacy labels in S9; Sign in with Apple decided before S7 |
| Guests won't install the app | Activation metric fails | WhatsApp one-tap RSVP + guest lite web (S8) cover RSVP, schedule and travel status with no install; Gate 3 tracks installs separately |
| Meta verification / template approval slow | Blocks S5 messaging | Submit in S0; build on test number + `LogSinkProvider`; SMS and push paths |
| P0 grew 46% once designed | MVP slips | 4th engineer from S2 or accept Gate 2 at ~30 May (see "What changed") |
| One EC2 box during peak season | Outage on a wedding day | pgBackRest PITR, DR drill S10, OPS-07 hot standby S17, explicit RDS/second-box triggers in 26-ops |
| Feature creep from pilots | Season missed | 10-pt buffer per sprint; everything else ranked at Gate 3 |

## Product decisions needed

Gathered from the architecture reviews; each doc's "Risks and open questions" has the detail. **Bold = needed before the sprint shown.**

| # | Decision | Recommendation | Needed by | Doc |
| --- | --- | --- | --- | --- |
| 1 | **4th engineer from S2, or Gate 2 at ~30 May?** | 4th engineer | **Gate 1** | this plan |
| 2 | **Sign in with Apple for iOS hosts** (App Store guideline 4.8 likely requires it alongside Google) | Yes (APP-07, S7) | **S7** | 25-app |
| 3 | **Hosts are phone/tablet only, no web console** (spreadsheet import, planner dashboard on tablet) | Yes for MVP; revisit a read-only desktop page (~3 pts) after pilots | **S2** | 25-app, 04-gst, 18-pln |
| 4 | **WhatsApp route:** Meta Cloud API direct vs a BSP (Gupshup/Interakt) | Meta Cloud API direct | **S5** | 07-msg |
| 5 | **Can the link alone show the schedule without OTP?** Device trust 90 days or wedding end + 30 days | No; 90 days / wedding+30, whichever sooner | **S4** | 05-acc |
| 6 | Shared family phone: switch to another adult without their OTP, and consent on their behalf? | Switch yes, consent no | S10 | 05-acc |
| 7 | Does one-tap WhatsApp "Yes" fill unanswered family members? Does "Maybe" count for catering? Collect allergies? | Yes / no / yes (free text) | **S4** | 06-rsv |
| 8 | Announcements to app users: push only, or push + WhatsApp? SMS fallback delay and language | Push + WhatsApp; 10 min; English SMS at MVP | **S5** | 07-msg |
| 9 | "STOP" opts out of one wedding or all? | One wedding | S9 | 07-msg |
| 10 | Message, guest and photo limits per plan; pack sizes and expiry; free-plan photo retention (3 months proposed) | Set before BIL-01 | S16 | 23-bil, 14-prv |
| 11 | **Web-only checkout** (no buy button in the app) — needs legal review | Yes | **S17** | 23-bil |
| 12 | **Face search provider:** Rekognition (InsightFace pretrained models are non-commercial); counsel approval for Rekognition storing non-opted-in face vectors up to 30 days, or pay for the storage-free mode | Rekognition, counsel to choose mode | **S14** | 19-face |
| 13 | Accept full Aadhaar in the ID vault, or masked only? | Masked only | S12 | 17-idv |
| 14 | Photos-consent withdrawal: keep photos de-named, or delete? | Keep de-named | S10 | 14-prv |
| 15 | Season hot standby (OPS-07) for 99.9% on wedding dates | Yes | S17 | 26-ops |
| 16 | AI ticket reading model and whether free plans get it | Claude Haiku tier for cost; paid plans only | S16 | 08-trv |
| 17 | Who owns a planner-created wedding (planner org or couple)? Do org admins see all org weddings? | Planner org owns; admins see all | S2 | 10-rol |
| 18 | Desk staff need a Google account — acceptable? | Yes for MVP | S6 | 10-rol |
| 19 | Feed: build at all? Ship wishes regardless? | Wishes yes (S15); feed only if pilots ask | S16 | 22-feed |
| 20 | White-label = runtime theming + custom domain (separate branded apps are blocked by Apple 4.2.6) | Yes | S19 | 27-p2 |
