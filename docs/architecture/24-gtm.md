# E24 — Self-serve onboarding and site (GTM)

## 1. Summary

Lets a family go from nothing to invites sent **in under 20 minutes without help**, and gives Mehfil a product site that sells. Delivers:

- **Onboarding wizard** in the RN Host app: sign in → create wedding → events → import guests → review → send invites (GTM-01);
- **Marketing site**: static pages (home, pricing, planners, privacy/terms, demo booking), hosted on S3 + CloudFront at `www.<domain>`; prices read from the billing catalogue; purchases link to the BIL web checkout (GTM-02);
- **Analytics** (new GTM-03): first-party, pseudonymous event pipeline into Postgres for the onboarding funnel, activation and sales metrics.

| Stories | Phase / sprint |
| --- | --- |
| GTM-01 | Season readiness · S17 |
| GTM-02 | S16 in backlog → recommend S18 (needs BIL-05 checkout pages; must be live before S19 sales start) |
| GTM-03 (new) | S16 (events must be flowing before the wizard ships so the < 20 min target can be measured) |

**Reinterpreted for the current stack:** "sign up" is Google SSO in the RN app (dev bypass `dev:<email>`); the wizard composes existing RN Host-mode flows (SET, GST, MSG) rather than web console pages; phone-contacts import uses the native contacts picker instead of the Android-Chrome Contact Picker API; the site is a separate static app (`apps/site`), not part of the API.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Wizard location | RN Host app, a dedicated `OnboardingNavigator` stack that **reuses** SET/GST/MSG screens in "wizard mode" (compact header, progress bar, Next/Skip) | A separate web onboarding | The app is the host client; reuse avoids a second implementation of import/compose. |
| Wizard state | Server-side `onboarding_sessions` (step, completed steps, timestamps) + local MMKV draft for the current form | Local only | Resume on another device (phone → tablet); funnel timings come from server truth. |
| Import paths in the wizard | Phone contacts (native picker, multi-select, `react-native-contacts` read with permission at the moment of use), CSV/XLSX (document picker → GST-02 import job), Google Sheets link (GST-03), type a few by hand | Contacts sync of the whole address book | Minimisation (DPDP): only the contacts the host picks leave the phone. |
| Free limit inside the wizard | Free covers 25 guests. If the import exceeds it, the wizard imports everything (guests are not the blocking cost), sends invites to the first 25 parties the host picks, and shows the neutral limit banner; if the user already holds a **pass** (bought on the site), the wizard offers "Activate Essentials/Complete" first | Selling in the wizard | Store rules (BIL §2): no in-app purchase or CTA. Families who come from the site buy a pass before installing. **Requires** GST-side support for "import beyond limit, block send" — see Deviations / §13. |
| "Send invites" step | Pick invite template (MSG-02), preview on a phone mock, **test send to self**, then send to selected parties via MSG-03/05 (`Idempotency-Key`) | Auto-send at the end | Sending to 300 relatives is irreversible; a test send catches typos. |
| Site generator and hosting | **Astro** static build in `apps/site` (zero JS by default), deployed by GitHub Actions to **S3 + CloudFront** at `www.<domain>`; apex `<domain>` stays on Nginx/EC2 for `/g/*`, `/account/*`, `/.well-known/*` and redirects `/` → `www` | Serve the site from Nginx on the EC2 box; Vercel/Netlify; CloudFront path-routing apex to two origins | The site must stay up during API incidents and deploys and absorb ad/launch traffic without touching the prod box; S3/CloudFront is already in our AWS account (ACM, ap-south-1 bucket). Keeping guest links and universal-link files on the apex host avoids CloudFront path rules and keeps the baseline link format unchanged. |
| Prices on the site | Build fetches `/v1/billing/catalog`; a nightly rebuild + a rebuild on catalogue change (GitHub `repository_dispatch` from an ops script) | Hard-coded prices | Single source of truth (BIL). |
| Buy buttons on the site | Link to `https://<domain>/account/checkout?sku=…` (BIL-05) | Razorpay on the static site | Needs auth + server-side order; already built in BIL. |
| Demo booking | Lead form → `POST /v1/leads` (stored in `marketing_leads`, email to founder via SES) + a Google Calendar appointment-schedule link | Calendly/HubSpot | No new paid tool; leads stay in our DB with consent. |
| Product analytics | **First-party**: `analytics_events` (monthly partitions) via `POST /v1/analytics/events` (batched from app) and server-side emitters; funnels as saved SQL in `infra/analytics/*.sql`, weekly report job | PostHog / Mixpanel / Firebase Analytics | No SDK weight on budget Android, no third-party transfer of host/guest behaviour, no consent-banner burden for a vendor; volumes are small (≤ a few million events/month). Revisit PostHog (self-hosted or EU cloud) if the team needs self-serve funnels. |
| Site analytics | Cookieless beacon (`navigator.sendBeacon` to `POST /v1/analytics/site`, ~1 KB inline script): page, referrer host, UTM; no cookies, no IP stored | Google Analytics | No cookie banner; DPDP-friendly. |
| Guest analytics | Event names + wedding id only, **no actor id** | Per-guest tracking | Not needed for the product; minimisation. |

## 3. Data model

DDL: [`sql/24-gtm.sql`](./sql/24-gtm.sql). References `000-core.sql` only. **Schema check passed**: `scripts/check-schema.sh arch_gtm 000-core.sql 24-gtm.sql` → `OK: 22 tables`; the full chain (000 → 27) → `OK: 136 tables`.

| Table / change | Purpose | Notes |
| --- | --- | --- |
| `users.analytics_opt_out` (ALTER) | Host opt-out of product analytics | Toggle in Settings; checked by the ingest service (events dropped, not stored). |
| `onboarding_sessions` | Wizard progress per user: step, completed steps, import source, `started_at`, `first_invite_sent_at`, `completed_at`, `abandoned_at` | One open session per user; one per wedding. |
| `analytics_events` (partitioned monthly) | `name`, `source` (app_host/app_guest/lite_web/site/server), `actor_hash` (HMAC of user id, hosts only), `wedding_id`, `session_id`, platform, version, allow-listed `props` | Default partition is a safety net (alert if non-empty); partitions created 2 months ahead; dropped after 13 months. No FK on `wedding_id`; PRV erasure job nulls it. |
| `marketing_leads` | Demo/planner enquiries with contact consent and optional marketing consent, UTM, status | `delete_after` 12 months; purged by job. |

**Event catalogue v1** (Zod allow-list in `packages/domain/src/analytics.ts`; unknown names/props rejected):

| Event | Props |
| --- | --- |
| `auth.signed_in` | `first_time` |
| `onboarding.started`, `onboarding.step_completed`, `onboarding.step_skipped` | `step`, `elapsed_s` |
| `onboarding.import_completed` | `source`, `rows_bucket` (1–25, 26–100, 101–500, 500+), `errors_bucket` |
| `onboarding.invites_sent` | `parties_bucket`, `elapsed_s` (since start) |
| `onboarding.completed` / `onboarding.abandoned` | `last_step` |
| `plan.limit_hit` | `key` |
| `billing.checkout_started`, `billing.order_fulfilled` | `sku`, `kind` (server-side) |
| `plan.activated` | `plan`, `source` |
| `site.page_view`, `site.cta_click`, `site.lead_submitted` | `path`, `cta`, `utm_*` |
| `guest.link_opened`, `guest.rsvp_submitted`, `guest.app_installed` | `channel` (app/lite_web) — no actor |

## 4. API

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/onboarding` | host | Current open session (or 404) | — |
| POST | `/v1/onboarding` | host | Start (idempotent: returns the open one) | — |
| PATCH | `/v1/onboarding/:id` | session owner | `{ step, completed, weddingId?, importSource? }` | `GTM_STEP_ORDER` |
| POST | `/v1/onboarding/:id/complete` | session owner | Mark done (also set automatically on first invite send) | — |
| POST | `/v1/analytics/events` | host or guest JWT; anonymous allowed for `lite_web` | Batch ≤ 50 events; dropped silently if opted out | `422 ANALYTICS_EVENT_UNKNOWN` (dev only; prod drops) |
| POST | `/v1/analytics/site` | public, CORS `www.<domain>` | Site beacon | rate-limited 60/min/IP |
| POST | `/v1/leads` | public, CORS `www.<domain>` | Lead/demo form (honeypot + rate limit) | `GTM_LEAD_INVALID`, 429 |
| GET | `/v1/admin/leads?status=&cursor=` / PATCH `/v1/admin/leads/:id` | platform staff | Triage leads | — |
| GET | `/v1/billing/catalog` | public | (BIL) prices for the site | — |

Example — `PATCH /v1/onboarding/5d2…` `{ "step": "guests", "completed": true, "importSource": "contacts" }` → `200 { "id": "5d2…", "currentStep": "review", "completedSteps": ["create","events","guests"], "weddingId": "a71…", "elapsedSeconds": 412 }`.

Example — `POST /v1/analytics/events`
```json
{ "events": [ { "name": "onboarding.step_completed", "occurredAt": "2027-07-20T10:02:11Z",
  "sessionId": "c7e…", "props": { "step": "events", "elapsed_s": 95 } } ] }
```
→ `202 { "accepted": 1 }`. The server adds `actor_hash`, `wedding_id` (from the session), platform and version from headers.

## 5. Jobs, events and realtime

| Job | Schedule | Purpose |
| --- | --- | --- |
| `gtm.onboarding.abandon` | daily 04:10 IST | Sessions idle 7 days → `abandoned_at` + `onboarding.abandoned` event |
| `gtm.analytics.partitions` | monthly (1st, 03:00 IST) | Create next 2 partitions; drop partitions > 13 months; alert if default partition has rows |
| `gtm.analytics.weekly-report` | Mon 08:20 IST | Run `infra/analytics/*.sql` (funnel, median time-to-invite, activation, conversion) → email to founders |
| `gtm.leads.notify` | on insert | Email founder (SES) — no lead data in logs |
| `gtm.leads.purge` | daily | Delete leads past `delete_after` |

Domain events consumed: `wedding.created`, `guest.imported`, `messaging.message.sent` (first invite) → update `onboarding_sessions` and emit server-side analytics events. Analytics writes are fire-and-forget through an in-process buffer flushed every 5 s (`INSERT … VALUES` batch); loss on crash is acceptable.

## 6. Mobile app

**Host mode — Onboarding** (shown after first sign-in when the user has no weddings, and from "New wedding"):

| Step | Screen | Reuses |
| --- | --- | --- |
| 1 Create | Couple names, dates, city, cover photo (optional) | SET-01 form |
| 2 Events | Preset chips (Haldi, Mehendi, Sangeet, Baraat, Pheras, Reception), one tap each, edit times | SET-02 |
| 3 Guests | Choose: Phone contacts / Excel or CSV / Google Sheet / Type them in | GST-01/02/03/08 |
| 4 Review | Count, invalid numbers to fix, duplicates found (GST-05), groups quick-assign (Bride/Groom side) | GST-05/06 |
| 5 Invite | Template + language, preview, **test send to me**, select parties (default all within the plan limit), send | MSG-02/03 |
| 6 Done | "Invites going out", link to delivery status, share link to co-host invite (ROL-01) | MSG-06 |

- Progress bar with step names; "Skip for now" on 2–4; resume from `GET /v1/onboarding`.
- If the user's org holds a pass/credit, step 1 ends with "Activate your Essentials/Complete plan" (BIL-03 activate). No prices, no buy link (store rules).
- Query keys: `['onboarding']`, plus the reused feature keys. Offline: steps 1–2 work offline and sync (create is queued with an idempotency key); import and send need network and say so.
- Accessibility: large-text layouts for every step; contacts picker uses the OS picker; all actions icon + label.
- Performance target: each step interactive < 1 s on a budget Android; contacts picker handles 2,000 contacts (FlashList, search).

The Guest mode has no onboarding beyond ACC's first-open consent.

## 7. Guest lite web

Not affected except analytics: `/g/:token` pages emit `guest.link_opened` / `guest.rsvp_submitted` server-side (no client script). The **marketing site** is a separate static site (§2), not part of the lite web.

## 8. Security and privacy

| Area | Measure |
| --- | --- |
| DPDP notice | Host sign-up notice (PRV host notice) lists "product improvement analytics" with an opt-out toggle in Settings; guests are not tracked individually |
| Pseudonymisation | `actor_hash = HMAC-SHA256(ANALYTICS_KEY, user_id)`; key in `.env`; no names, phones, emails, free text, or guest ids in events; props allow-listed and bucketed |
| Retention | Events 13 months (partition drop); leads 12 months; onboarding sessions deleted with user/wedding |
| Contacts | Read only after the host taps "Phone contacts"; only selected entries are sent; no address-book upload |
| Lead form | Honeypot field, 5/hour/IP, CORS restricted to the site origin, separate optional marketing-consent checkbox, notice version stored |
| Site | Static, no cookies; CSP `default-src 'self'`; `connect-src` the API host only; HSTS; S3 bucket private behind CloudFront OAC |
| Access | Analytics SQL runs as a read-only Postgres role `mehfil_analytics` limited to `analytics_events` and aggregate views |
| Audit | Lead status changes and exports by staff in `audit_log` |

## 9. Scale and performance

- Event volume: ~150 events per onboarding, ~50 per active host/day, guest events ~5 per guest per wedding → at 50 live weddings × 2,000 guests ≈ 0.5 M/month. Batched inserts; partitions keep vacuum and drops cheap.
- Ingest endpoint is off the critical path; it never blocks the app (fire-and-forget, `202`).
- The site on CloudFront absorbs launch traffic; only the lead form and beacon hit the API (rate-limited).
- Wizard import of 1,000 rows uses GST-02's job (< 30 s target).

## 10. Testing plan

| Level | Cases |
| --- | --- |
| Unit | Event allow-list (unknown props rejected), bucketing, HMAC actor hash, opt-out drop |
| API e2e | Onboarding lifecycle + resume; first invite send completes the session; analytics batch from guest JWT stores no actor; opted-out host stores nothing; lead form honeypot / rate limit / consent required |
| Mobile | RNTL: wizard navigation, skip/resume, pass-activation prompt only when a credit exists, no purchase CTA |
| **Usability (acceptance)** | 5 families who have never seen Mehfil, budget Android, real 100–300-row sheet: median time to invites sent < 20 min, measured from `onboarding_sessions` and observed in person. Repeat after fixes. |
| Site | Lighthouse ≥ 90 performance/accessibility on mobile; link checker; pricing page renders the catalogue snapshot |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| **GTM-01** Onboarding wizard | [DB] onboarding_sessions · [API] onboarding endpoints, domain-event hooks · [MOB] OnboardingNavigator, wizard-mode variants of SET/GST/MSG screens, contacts multi-select, test-send, pass activation · [GST/MSG] "import beyond limit, choose who to invite" support · [TEST] e2e + usability sessions | 5 → **8** | Native contacts picker, resume across devices, and the Free-limit handling forced by store rules; usability testing is part of "done". |
| **GTM-02** Marketing site | [WEB] Astro site in `apps/site` (home, pricing from catalogue, planners, demo, privacy/terms) · [API] `/v1/leads` + leads admin list · [JOB] lead notify/purge · [OPS] S3 + CloudFront + ACM, GH Actions deploy, apex redirect · [TEST] Lighthouse, link check | 3 → **5** | Hosting/infra, lead capture with consent and catalogue-driven pricing weren't in the estimate. Copy/design by founder + designer outside points. |
| **GTM-03** Analytics pipeline (new) | [DB] analytics_events partitions, opt-out column · [API] ingest endpoints, server emitters, buffer · [MOB] tiny `track()` client with batching · [JOB] partitions, weekly report · [OPS] read-only role, saved SQL funnels · [TEST] | new → **3** | Needed to prove the < 20 min target and to measure Gate 3/4 metrics; nothing in the backlog owned it. |
| **Total** | | **8 → 16** | |

## 12. Dependencies and sequencing

- **Needs first:** SET-01/02, GST-01/02/03/05/06/08, MSG-02/03/05/06 (all MVP/P0\*), ROL-01 (co-host invite), PRV-01 host notice, BIL-01 (limits), BIL-03 (pass activation), BIL-05 (`/account/checkout` for site buy links), SES (BIL-02b), VAL-06 landing page (replaced), VAL-08 domain.
- **Sprints:** S16 GTM-03 · S17 GTM-01 · S18 GTM-02 (backlog had S16; it needs BIL-05 from S16 and must be live before S19 sales start). Usability sessions in S17–S18; fixes in S22.
- Universal/app links (`/.well-known/apple-app-site-association`, `assetlinks.json`) stay on the apex host served by Nginx/API (APP epic).

## 13. Risks and open questions

| # | Item | Owner |
| --- | --- | --- |
| 1 | **< 20 min with > 25 guests on Free** is impossible to complete *as a paid wedding* inside the app (no in-app purchase). Accept "invite first 25, upgrade on the web", or steer families to buy a pass on the site first? | PO |
| 2 | Families who install from the store without visiting the site never see prices in the app. Measure `plan.limit_hit` → `billing.checkout_started` conversion; revisit the store decision (BIL §13) with data. | PO |
| 3 | First-party analytics means funnels are SQL, not dashboards. OK for a 5-person team? | PO |
| 4 | Domain layout (`www` on CloudFront, apex on EC2) — confirm with VAL-08 domain choice; guest links stay on the apex. | PO + Eng |
| 5 | Contacts permission prompt on iOS may scare older hosts; copy must explain only selected contacts are used. | Design |
| 6 | Site copy, screenshots and planner page content are founder/designer work not in the points. | PO |

## 14. Deviations from the baseline

1. **New app `apps/site`** (Astro static site) deployed to **S3 + CloudFront** at `www.<domain>`; the repository layout in the overview should list it.
2. **First-party analytics** (`analytics_events`, `users.analytics_opt_out`, read-only `mehfil_analytics` DB role) — the baseline names no analytics tool.
3. Relies on the **`/account/*` web pages and SES email** introduced by BIL (see 23-bil.md §14).
4. GST must allow importing guests beyond the plan's `guests_max` while blocking invites/sends beyond it (BIL's default is to block at create/import). Agreed rule proposed here: **`guests_max` limits invited parties' guests, enforced at send time by MSG and RSVP-link issuance, not at import** — this changes the BIL-01 enforcement table if the PO accepts §13 #1.
