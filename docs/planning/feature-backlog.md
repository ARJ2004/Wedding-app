# Mehfil — Feature Backlog

> **Superseded in part (v2):** the stack is now Express + Prisma + PostgreSQL 16 + pg-boss + S3 + React Native, with Google SSO for hosts (see [architecture baseline](../architecture/00-overview.md)). Every epic below has an architecture design in `docs/architecture/NN-<prefix>.md` with **revised points, split stories and per-story task lists**; the [sprint plan](./sprint-plan.md) uses those. Where this file and a design doc disagree, the design doc wins. Stories here that mention a PWA, web push, Redis or FastAPI are reinterpreted in their design doc.

Source: PRD v0.1 and Market Research (Nov 15, 2026). This file holds every epic and story with its ID, priority, estimate, acceptance criteria and dependencies. The sprint each story lands in is in [sprint-plan.md](./sprint-plan.md).

## How to read this

- **Priority** follows the PRD: **P0** = needed to run one real wedding end to end; **P1** = makes it sellable to planners; **P2** = later. **P0\*** = P0 in the PRD but scheduled just after the MVP build (in the pilot-readiness sprint) to fit capacity.
- **Pts** = story points (1, 2, 3, 5, 8). Rough guide: 1 ≈ half a day, 3 ≈ 2–3 days, 8 ≈ a full sprint for one engineer.
- **Dep** = stories that must be done first.
- Stories marked **(new)** are not in the PRD but are needed to ship (billing, compliance, ops).

## Epic summary

| # | Epic | Prefix | Priority | Pts | Phase |
| --- | --- | --- | --- | --- | --- |
| E00 | Validation and long-lead admin | VAL | — | non-eng | Validation |
| E01 | Foundations and platform | FND | P0 | 44 | Validation + MVP |
| E02 | Design | DSN | P0 | design | Validation + MVP |
| E03 | Wedding setup | SET | P0 | 14 | MVP |
| E04 | Guest list and import | GST | P0 | 25 | MVP |
| E05 | Guest access, identity and consent | ACC | P0 | 15 | MVP |
| E06 | RSVP | RSV | P0 | 16 | MVP |
| E07 | Messaging and announcements | MSG | P0 | 38 | MVP |
| E08 | Travel collection | TRV | P0 / P1 | 11 + 10 | MVP / Pilot |
| E09 | Arrivals board and check-in | ARR | P0 | 18 | MVP |
| E10 | Roles, permissions and audit | ROL | P0 | 14 | MVP |
| E11 | Guest home (PWA) | GH | P0 | 17 | MVP |
| E12 | Disposable camera and media pipeline | CAM | P0 | 24 | MVP |
| E13 | Shared gallery | GAL | P0-lite / P1 | 8 + 5 | MVP / Pilot |
| E14 | Privacy and compliance (new) | PRV | P0 | 13 | MVP |
| E15 | Pickup batching | PCK | P1 | 18 | Pilot |
| E16 | Room allocation | ROM | P1 | 12 | Pilot |
| E17 | ID vault | IDV | P1 | 16 | Pilot |
| E18 | Multi-wedding planner dashboard | PLN | P1 | 16 | Pilot |
| E19 | Find my photos (face search) | FACE | P1 | 15 | Pilot |
| E20 | Languages | L10N | P1 | 13 | Pilot |
| E21 | Couple quiz | QZ | P1 | 14 | Pilot |
| E22 | Wedding feed and moderation | FEED | P1 (validate) | 10 | Pilot |
| E23 | Billing and plans (new) | BIL | P1 | 15 | Season readiness |
| E24 | Self-serve onboarding and site (new) | GTM | P1 | 8 | Season readiness |
| E25 | Native app | APP | P1 | 16 | Season readiness |
| E26 | Scale, reliability and ops | OPS | P0 / P1 | 18 | MVP → Launch |
| E27 | P2: voice, wishes, white-label, post-wedding | VOX / WSH / WL / PWP | P2 | 29 | Season readiness (slots) |

---

## E00 — Validation and long-lead admin (VAL)

Non-engineering work from the market research validation plan, plus admin with long lead times that blocks messaging and payments. **Start the admin items in week 1.**

| ID | Task | Done when | Owner |
| --- | --- | --- | --- |
| VAL-01 | Interview the couple or planner of the wedding you are attending | Notes cover what they paid, why that tool, % of guests who used it | Founder |
| VAL-02 | Observe that wedding | List of features guests used vs where they fell back to WhatsApp | Founder |
| VAL-03 | Interview 10 Bangalore planners + 5 destination-venue planners (Udaipur, Jaipur, Goa, Coorg) | 15 interview notes; top 3 time sinks; willingness to pay per wedding and per year | Founder |
| VAL-04 | Interview 5 families who planned without a planner | 5 notes; price sensitivity for ₹6,999 / ₹14,999 | Founder |
| VAL-05 | Concierge pilot: WhatsApp bot + Google Sheet on one real wedding | RSVP response rate, % arrivals tracked, photos collected | Founder + 1 eng |
| VAL-06 | Landing page with three price tiers + sign-up tracking | Live page, analytics on tier clicks and sign-ups | Founder |
| VAL-07 | Go / no-go decision | ≥ 3 planners willing to pay for a pilot (Gate 1) | Founder |
| VAL-08 | Product name and brand | Name chosen, domain bought, WhatsApp display name approved | Founder + designer |
| VAL-09 | Meta Business verification + WhatsApp Business account via chosen BSP | Verified business, sender number, display name approved | Founder |
| VAL-10 | TRAI DLT registration (entity, sender ID/header, SMS templates) for SMS fallback | DLT entity ID and approved templates | Founder |
| VAL-11 | Razorpay (or Cashfree) merchant KYC | Live keys available | Founder |
| VAL-12 | Recruit 3–5 pilot weddings for Apr–Jun 2027 | Signed pilot agreements with dates | Founder |
| VAL-13 | DPDP privacy notice and terms (legal review) | Published privacy notice and ToS | Founder + counsel |

---

## E01 — Foundations and platform (FND) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| FND-01 | Monorepo scaffold | `api/` (FastAPI, Python 3.12), `console/` (React + Vite + TS), `guest/` (PWA, Preact or React + Vite), `infra/`; lint, format, type-check, pre-commit hooks | 3 | — |
| FND-02 | CI pipeline | GitHub Actions runs lint, tests and builds for all three apps on every PR; required to merge | 3 | FND-01 |
| FND-03 | Local dev stack | `docker compose up` gives Postgres, Redis, MinIO (S3) and a fake WhatsApp/SMS sink that logs outbound messages | 2 | FND-01 |
| FND-04 | Core data model + migrations | Alembic migrations for Organization, User, Wedding, Event, Venue, Party, Guest, Group, RSVP, Travel, Message, Delivery, Photo, AuditLog; every table carries `wedding_id` for tenant scoping | 5 | FND-01 |
| FND-05 | Host and staff auth | OTP login by phone (WhatsApp/SMS) or email; JWT sessions; permission-policy layer scaffolded so every endpoint declares its required permission | 5 | FND-04 |
| FND-06 | Background workers | RQ or Celery with separate `messaging`, `media` and `default` queues; retries with backoff; dead-letter queue visible in admin | 3 | FND-03 |
| FND-07 | AWS staging environment | IaC (Terraform or CDK) in `ap-south-1`: ECS, RDS Postgres, ElastiCache, S3, CloudFront, Secrets Manager; deploy on merge to `main` | 8 | FND-02 |
| FND-08 | Observability | Structured JSON logs, Sentry for API + both frontends, basic metrics (request latency, queue depth, send/upload errors) | 3 | FND-07 |
| FND-09 | i18n framework | All guest-facing strings externalised (ICU messages) from day 1; English only at MVP; locale-aware date/time formatting | 2 | FND-01 |
| FND-10 | Shared design system | Tokens, buttons, forms, icon-with-label component, large-text and high-contrast modes, used by console and guest app | 5 | DSN-01 |
| FND-11 | Production environment | Separate prod account/env, automated DB backups, point-in-time recovery, deploy runbook, rollback tested | 5 | FND-07 |

## E02 — Design (DSN) · P0

| ID | Task | Done when |
| --- | --- | --- |
| DSN-01 | Guest home, RSVP and travel flows (wireframes → hi-fi) | Tested on paper/prototype with 3 guests over 60 and 3 under 30 |
| DSN-02 | Host console information architecture | Navigation, guest list, event setup, announcement composer screens |
| DSN-03 | Disposable camera UX | Shot counter, filter, offline state, delayed reveal states |
| DSN-04 | Arrivals board + desk check-in | Works on a laptop at a front desk and on a tablet; readable at a distance |
| DSN-05 | WhatsApp template copy | Invite, RSVP, reminder, announcement, OTP templates written to Meta's utility-category rules |
| DSN-06 | P1 screens (pickups, rooms, ID vault, planner dashboard) | Ready one sprint before each build sprint |

## E03 — Wedding setup (SET) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| SET-01 | Create a wedding | Couple names, dates, cities, cover photo, timezone; creator becomes Owner | 2 | FND-05 |
| SET-02 | Events with presets | One-click presets for Haldi, Mehendi, Sangeet, Baraat, Pheras, Reception; edit name, start/end, dress code, notes; reorder | 3 | SET-01 |
| SET-03 | Venues and map pins | Venue with address, Google Maps pin/link, parking notes; link each event to a venue | 3 | SET-02 |
| SET-04 | Event visibility by group | e.g. Haldi visible only to "Family"; guest home shows only events the guest is invited to | 3 | SET-02, GST-06 |
| SET-05 | Key contacts | Per-side helpline contacts shown on guest home with call/WhatsApp buttons | 1 | SET-01 |
| SET-06 | Wedding settings | Camera shot limit, reveal mode, default language, basic branding (cover, colour) | 2 | SET-01 |

## E04 — Guest list and import (GST) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| GST-01 | Add and edit guests in parties | A party (household/invite) has a main guest and members/plus-ones; add, edit, remove | 3 | FND-04 |
| GST-02 | Import from Excel/CSV | Upload .xlsx/.csv, map columns, preview, import 1,000 rows in < 30 s, downloadable error report | 5 | GST-01, GST-04 |
| GST-03 | Import from Google Sheets (P0\*) | Paste a sheet link (published CSV or OAuth); same mapping flow as GST-02 | 3 | GST-02 |
| GST-04 | Phone normalisation | libphonenumber; handles 10-digit Indian, `0`-prefixed, `+91`, spaces/dashes and international numbers; flags invalid | 2 | — |
| GST-05 | Dedupe and merge | Detects duplicates by phone and fuzzy name; merge UI keeps RSVP/travel data | 3 | GST-02 |
| GST-06 | Groups and tags | Built-in groups (Bride side, Groom side, Family, Friends, VIP) + custom; bulk assign | 3 | GST-01 |
| GST-07 | Guest list views and export | Search; filter by group, RSVP, travel and arrival status; CSV export | 3 | GST-06 |
| GST-08 | Import from phone contacts (P0\*) | Contact Picker API on Android Chrome; vCard upload as fallback (iOS) | 3 | GST-01 |

## E05 — Guest access, identity and consent (ACC) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| ACC-01 | Personal unguessable link | ≥ 128-bit random token per party; host can revoke and regenerate; link never exposes other guests' data | 3 | GST-01 |
| ACC-02 | New-device verification | Opening on a new device triggers a one-time code to the guest's phone (WhatsApp OTP template, SMS fallback); device remembered 90 days | 5 | ACC-01, MSG-01 |
| ACC-03 | Shared family phone (P0\*) | One link can switch between party members; actions are attributed to the selected member | 2 | ACC-01 |
| ACC-04 | Consent capture (DPDP) | First open shows a short purpose notice; consent stored with timestamp and version; guest can withdraw | 3 | ACC-01, VAL-13 |
| ACC-05 | Abuse protection | Rate limits on token lookups and OTP sends; lockout after repeated failures; alerts on spikes | 2 | ACC-02 |

## E06 — RSVP (RSV) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| RSV-01 | Per-event web RSVP | For each invited event and each party member: Attending / Not / Maybe; plus-one count within host limit; dietary needs (veg, Jain, vegan, allergies, free text) | 5 | ACC-01, SET-02 |
| RSV-02 | One-tap WhatsApp RSVP | Interactive buttons in the invite template; webhook records the reply against the right party and event; guest gets a confirmation with their link | 5 | MSG-01, RSV-01 |
| RSV-03 | Live headcount | Per event: attending / declined / pending, by side and by diet; updates within 5 s | 3 | RSV-01 |
| RSV-04 | Chase non-responders | Filter "no reply after N days"; one-click reminder to that set | 2 | MSG-03 |
| RSV-05 | Host RSVP on behalf (P0\*) | Host records an RSVP taken by phone; audit-logged | 1 | RSV-01, ROL-03 |

## E07 — Messaging and announcements (MSG) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| MSG-01 | Provider abstraction + WhatsApp BSP | `MessagingProvider` interface; first adapter for the chosen BSP; send template, receive inbound webhooks and status callbacks; signature verification | 8 | FND-06, VAL-09 |
| MSG-02 | Template catalogue | Invite, RSVP, reminder, announcement, OTP templates; approval status synced from provider; only approved templates selectable | 3 | MSG-01, DSN-05 |
| MSG-03 | Announcement composer | Text + optional image + link to guest home; target by group, event, RSVP status or hand-picked list; recipient count and preview before send | 5 | MSG-02, GST-06 |
| MSG-04 | Scheduled sends | Send later in wedding timezone; edit/cancel until sent | 2 | MSG-03 |
| MSG-05 | Fan-out worker | Throttled to provider limits; idempotent per (message, guest); retries; 1,000 recipients queued in < 10 s | 5 | MSG-01 |
| MSG-06 | Delivery and read status | Per guest: queued / sent / delivered / read / failed; summary per announcement; drill-down list of failures | 3 | MSG-05 |
| MSG-07 | SMS fallback | If WhatsApp fails or is not delivered within N minutes (default 10), send DLT-approved SMS with the guest link | 5 | MSG-06, VAL-10 |
| MSG-08 | Web push (P0\*) | Guests who allow notifications on the PWA get pushes for announcements | 3 | GH-01 |
| MSG-09 | Message quota metering (P0\*) | Counts billable messages per wedding; warns at 80%; blocks at limit (plan limits from BIL-01 later) | 2 | MSG-05 |
| MSG-10 | Opt-out handling (P0\*) | "STOP" or opt-out button suppresses future marketing sends; utility updates respect provider rules | 2 | MSG-01 |

## E08 — Travel collection (TRV) · P0 / P1

| ID | Story | Acceptance criteria | Pri | Pts | Dep |
| --- | --- | --- | --- | --- | --- |
| TRV-01 | Guest travel form | Arrival and departure date/time, mode (flight/train/car/bus), flight/train number, origin city, arrival point (airport/station/direct), needs pickup; shared for the party or per member | P0 | 5 | GH-01 |
| TRV-02 | Ticket upload | Optional PDF/image upload to private S3 via signed URL | P0 | 2 | CAM-01 |
| TRV-03 | Host travel view | Arrivals and departures by day, hour and arrival point; edit; Excel export | P0 | 3 | TRV-01 |
| TRV-04 | Chase missing travel details | Out-station guests with no travel details; one-click reminder | P0 | 1 | MSG-03 |
| TRV-05 | Flight status lookup | Auto-fetch delays for flight numbers on arrival day; flags late guests on the board | P1 | 5 | TRV-01, ARR-02 |
| TRV-06 | AI ticket reading | Prefill travel form from an uploaded ticket; guest confirms | P1 | 5 | TRV-02 |

## E09 — Arrivals board and check-in (ARR) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| ARR-01 | Guest travel status | One tap on guest home or WhatsApp quick reply: "I've landed", "At the hotel", "Running late by X"; host sees it in < 5 s | 3 | TRV-01, ARR-05 |
| ARR-02 | Live arrivals board | Expected vs arrived per time window and arrival point; status chips; auto-updates without refresh | 5 | ARR-05, TRV-03 |
| ARR-03 | Desk check-in | Search by name or scan guest QR; mark whole party or some members arrived; works on a phone or tablet | 5 | GH-07, ROL-01 |
| ARR-04 | "Still missing" list | Expected but not arrived, with last status and call button | 2 | ARR-02 |
| ARR-05 | Realtime infrastructure | Redis pub/sub → Server-Sent Events per wedding; reconnect and catch-up | 3 | FND-06 |

## E10 — Roles, permissions and audit (ROL) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| ROL-01 | Team roles and invites | Owner, Co-host, Planner member, Desk staff; invite by phone/email; remove access | 3 | FND-05 |
| ROL-02 | Permission enforcement | Every endpoint enforces the role matrix in the PRD; desk staff never receive phone numbers, IDs or announcements in API responses; automated tests per role | 5 | ROL-01 |
| ROL-03 | Audit log | Who, what, when, before/after for guest, RSVP, travel, room and role changes; filterable viewer | 3 | FND-04 |
| ROL-04 | Organisation (agency) model | A planner org owns many weddings; members are assigned per wedding and see only those | 3 | FND-04 |

## E11 — Guest home PWA (GH) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| GH-01 | PWA shell, fast and offline | Loads in < 3 s on throttled 4G on a budget Android; initial JS < 150 KB gz; service worker caches schedule for offline use | 5 | FND-01 |
| GH-02 | Personal schedule | Only invited events, in order, with time, venue, map button, dress code and RSVP state | 3 | GH-01, SET-04 |
| GH-03 | My travel and status | Shows submitted travel, status buttons, placeholder for room (filled by ROM-03) | 2 | TRV-01, ARR-01 |
| GH-04 | Key contacts | Tap to call or WhatsApp | 1 | SET-05 |
| GH-05 | Accessibility | Large-text toggle, high contrast, icon + label everywhere; usability-tested with 3 guests over 60 | 3 | FND-10 |
| GH-06 | Announcements inbox | All announcements sent to this guest, newest first | 2 | MSG-03 |
| GH-07 | Guest QR | Party QR for desk check-in, shown on guest home | 1 | ACC-01 |

## E12 — Disposable camera and media pipeline (CAM) · P0

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| CAM-01 | Signed direct-to-S3 uploads | Presigned POST with size/type limits; no media passes through the API | 3 | FND-07 |
| CAM-02 | Browser camera | Opens in < 2 s; front/back switch; works on Android 9+ Chrome and iOS 15+ Safari; falls back to file-input capture | 5 | GH-01 |
| CAM-03 | Shot limit | Per guest per wedding (or per event); visible counter; enforced server-side | 2 | CAM-01 |
| CAM-04 | Film filter | Client-side canvas filter applied before upload; 1–3 looks | 3 | CAM-02 |
| CAM-05 | Offline queue | Photos stored in IndexedDB when offline; auto-upload on reconnect; survives app close | 5 | CAM-02 |
| CAM-06 | Delayed reveal (P0\*) | Host sets reveal time; photos hidden from guests until then | 2 | GAL-01 |
| CAM-07 | Media worker | WebP thumbnails and previews, EXIF/GPS stripped, duplicate detection by hash; handles 300 uploads/min | 3 | FND-06 |
| CAM-08 | Camera QR / link | Printable QR per event that opens the camera for the guest (identifies via their link session) | 1 | CAM-02 |

## E13 — Shared gallery (GAL) · P0-lite / P1

The PRD lists "Shared gallery" as P1 in the feature table but inside the MVP scope. Plan: a lite gallery (GAL-01..03) ships in the MVP so camera photos have somewhere to go; the rest is P1.

| ID | Story | Acceptance criteria | Pri | Pts | Dep |
| --- | --- | --- | --- | --- | --- |
| GAL-01 | Albums per event | Guests browse lazy-loaded thumbnails via CDN | P0 | 3 | CAM-07 |
| GAL-02 | Downloads | Guest downloads a single photo; host downloads a full album (zip built by worker, link emailed/WhatsApped) | P0 | 3 | GAL-01 |
| GAL-03 | Hide and report | Host hides/unhides any photo; guests can report a photo | P0 | 2 | GAL-01 |
| GAL-04 | Guest full-album download, favourites | Guests download a whole album; favourite photos | P1 | 3 | GAL-02 |
| GAL-05 | Upload from phone gallery | Guests add existing photos (counts against a separate limit) | P1 | 2 | CAM-01 |

## E14 — Privacy and compliance (PRV) · P0 (new)

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| PRV-01 | Privacy notice and consent records | Published notice; consent versions stored; linked from guest home and console | 2 | VAL-13, ACC-04 |
| PRV-02 | Data requests (P0\*) | Guest can request export or deletion; host can delete a guest; completes within 7 days | 3 | PRV-01 |
| PRV-03 | Retention jobs (P0\*) | Scheduled jobs delete per plan: ticket uploads after wedding, photos after 12 months (paid) or N months (free), whole wedding on request | 3 | FND-06 |
| PRV-04 | Encryption and least privilege | RDS and S3 encrypted; least-privilege IAM per service; secrets only in Secrets Manager | 2 | FND-07 |
| PRV-05 | Pre-pilot security review | OWASP Top 10 pass, token-link threat model, tenant-isolation tests | 3 | ROL-02 |

---

## E15 — Pickup batching (PCK) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| PCK-01 | Auto-batch arrivals | Group needs-pickup arrivals by airport/station and time window (default 45 min) into vehicles by capacity | 5 | TRV-03 |
| PCK-02 | Vehicles, drivers and manual edits | CRUD vehicles and drivers; drag-and-drop guests between batches | 5 | PCK-01, DSN-06 |
| PCK-03 | Notify guests | WhatsApp to each guest: driver name, phone, vehicle number, pickup point | 2 | PCK-02, MSG-03 |
| PCK-04 | Reassign on delays | "Running late" or flight delay flags the batch; coordinator gets an alert and a suggested move | 3 | PCK-02, ARR-01 |
| PCK-05 | Driver link | No-login link listing the driver's pickups; driver marks "picked up" which updates the board | 3 | PCK-02 |

## E16 — Room allocation (ROM) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| ROM-01 | Room inventory import | Hotels, room types, numbers, capacity, dates from Excel | 3 | GST-02 |
| ROM-02 | Assign parties to rooms | Manual + auto-suggest by party size and side; conflict and over-capacity warnings | 5 | ROM-01 |
| ROM-03 | Guest and desk view | Guest sees hotel, room and check-in time; desk staff see room numbers | 2 | ROM-02 |
| ROM-04 | Rooming list export | Excel export in a hotel-friendly format | 2 | ROM-02 |

## E17 — ID vault (IDV) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| IDV-01 | Encrypted ID upload | Per member; envelope encryption with a per-wedding KMS key; guidance to upload masked Aadhaar | 5 | CAM-01, PRV-04 |
| IDV-02 | Restricted view with logging | Only Owner/Co-host (configurable); every view logged; watermark on view | 3 | IDV-01, ROL-03 |
| IDV-03 | Export for hotel | Logged export (zip/PDF) of selected guests | 2 | IDV-02 |
| IDV-04 | Auto-delete | Deletes 3–7 days after the wedding (configurable); deletion recorded in audit log; key scheduled for deletion | 3 | IDV-01, PRV-03 |
| IDV-05 | Vault security review | External review or pen test of upload, view, export and delete paths | 3 | IDV-04 |

## E18 — Multi-wedding planner dashboard (PLN) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| PLN-01 | Wedding overview | All org weddings with health: RSVP %, travel %, messages used, days to go | 5 | ROL-04 |
| PLN-02 | Team seats | Add/remove team members; assign to weddings | 3 | ROL-04 |
| PLN-03 | Credits | Credit balance and consumption per wedding | 2 | BIL-03 |
| PLN-04 | Planner branding | Planner logo and colours on guest home and messages | 3 | GH-01 |
| PLN-05 | Clone a wedding / templates | Reuse events, groups and message templates from a past wedding | 3 | SET-02 |

## E19 — Find my photos (FACE) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| FACE-01 | Spike: provider choice | Compare AWS Rekognition (Mumbai) vs InsightFace on 500 test photos: accuracy, cost per wedding, latency | 3 | — |
| FACE-02 | Opt-in and selfie | Separate explicit consent; selfie capture; no matching without opt-in | 3 | FACE-01, ACC-04 |
| FACE-03 | Matching worker | Matches only against opted-in guests' selfies; incremental as new photos arrive | 5 | FACE-02, CAM-07 |
| FACE-04 | "My photos" view | Matched photos with download | 2 | FACE-03 |
| FACE-05 | Face data deletion | Deleted on withdrawal and with the wedding; verified by job report | 2 | FACE-03, PRV-03 |

## E20 — Languages (L10N) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| L10N-01 | Hindi | All guest strings and WhatsApp templates in Hindi (templates approved per language) | 3 | FND-09 |
| L10N-02 | Kannada | Same as L10N-01 for Kannada | 3 | FND-09 |
| L10N-03 | Guest language preference + content translation | Guest picks language; host-written text (event notes, announcements) machine-translated with host review | 5 | L10N-01 |
| L10N-04 | Indic fonts and formats | Subset Indic fonts without breaking the 3 s load budget; local date/time formats | 2 | L10N-01 |

## E21 — Couple quiz (QZ) · P1

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| QZ-01 | Quiz builder | Host writes MCQ and image questions about the couple | 3 | SET-01 |
| QZ-02 | Live quiz mode | Projector screen for host; guests answer on phones with a timer; handles 500 concurrent players | 8 | QZ-01, ARR-05 |
| QZ-03 | Leaderboard and async mode | Live leaderboard; quiz also playable any time before the Sangeet | 3 | QZ-02 |

## E22 — Wedding feed and moderation (FEED) · P1 — validate first

Open question in the PRD: do hosts want a feed, or does it compete with the family WhatsApp group? Build only if pilot hosts ask for it; otherwise swap in TRV-06.

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| FEED-01 | Posts and threads per event | Text/photo posts; one thread per event; no private messages | 5 | GH-01 |
| FEED-02 | Moderation | Host hides/pins; optional pre-moderation; guest report button | 3 | FEED-01 |
| FEED-03 | Wishes and reactions | "Wish" post type; emoji reactions | 2 | FEED-01 |

## E23 — Billing and plans (BIL) · P1 (new)

Not in the PRD feature list, but required to charge the prices in the PRD.

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| BIL-01 | Plans and entitlements | Free (25 guests, 10 shots), Essentials, Complete enforced through feature flags and limits | 5 | MSG-09 |
| BIL-02 | Per-wedding checkout | Razorpay checkout; GST invoice; upgrade from Free/Essentials mid-wedding | 5 | BIL-01, VAL-11 |
| BIL-03 | Planner credit packs | Buy packs (e.g. 10 weddings); one credit consumed per wedding activated | 3 | BIL-02 |
| BIL-04 | Add-ons | Extra message packs, extended photo storage | 2 | BIL-02 |

## E24 — Self-serve onboarding and site (GTM) · P1 (new)

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| GTM-01 | Onboarding wizard | Family can sign up, create a wedding, import guests and send invites in < 20 minutes without help | 5 | SET, GST, MSG epics |
| GTM-02 | Marketing site | Product site with pricing, planner page, demo booking; replaces the validation landing page | 3 | VAL-06 |

## E25 — Native app (APP) · P1

Assumption: the MVP console is web-only (answers the PRD's open question for v1). The native app targets hosts first.

| ID | Story | Acceptance criteria | Pts | Dep |
| --- | --- | --- | --- | --- |
| APP-01 | Host app (React Native / Expo) | Arrivals board, QR check-in scanner, send announcement, push alerts for late guests | 8 | ARR, MSG epics |
| APP-02 | Optional guest app | Wraps guest home with native push and offline; never required | 5 | APP-01 |
| APP-03 | Store release pipeline | EAS builds, Play Store and App Store listings, OTA updates | 3 | APP-01 |

## E26 — Scale, reliability and ops (OPS)

| ID | Story | Acceptance criteria | Pri | Pts | Dep |
| --- | --- | --- | --- | --- | --- |
| OPS-01 | Load tests | 2,000-guest announcement delivered 95% < 2 min; 300 uploads/min sustained; 50 live weddings | P1 | 5 | MSG-05, CAM-07 |
| OPS-02 | Status page and on-call | Public status page; on-call rota for wedding dates; alert routing | P1 | 2 | FND-08 |
| OPS-03 | Per-wedding live dashboard (P0\*) | Delivery and upload errors per wedding, live during events | P0 | 3 | FND-08 |
| OPS-04 | Device test lab (P0\*) | Matrix: Android 9 / 2 GB RAM, mid-range Android, iOS 15 Safari; smoke tests each release | P0 | 3 | GH-01 |
| OPS-05 | Autoscaling and CDN tuning | Workers scale on queue depth; CDN cache rules for previews | P1 | 3 | FND-07 |
| OPS-06 | Backup and DR drill | Restore prod backup into a clean env; documented RTO/RPO | P1 | 2 | FND-11 |

## E27 — P2 candidates

Pick in priority order at Gate 3 based on pilot data.

| ID | Story | Acceptance criteria | Pts |
| --- | --- | --- | --- |
| VOX-01 | Voice calls for key updates and RSVP chasing | Automated calls in the guest's language (TTS) through a voice provider; keypress RSVP; results on dashboard | 8 |
| VOX-02 | WhatsApp voice-note announcements | Host records or generates a voice note sent to selected groups | 3 |
| WSH-01 | Video wishes and guest book | Short video or text wishes; compiled reel/book for the couple | 5 |
| WL-01 | White-label | Planner/venue custom domain and full branding | 5 |
| PWP-01 | Post-wedding pack | Album export, printed album ordering, thank-you reel as paid add-ons | 8 |

---

## PRD gaps and decisions taken in this plan

1. **Shared gallery** is P1 in the table but in the MVP scope list → lite gallery (GAL-01..03) is in the MVP.
2. **Billing is missing** from the feature list → added E23; not needed for pilots (pilots are invoiced manually).
3. **SMS fallback in India needs TRAI DLT registration**, and WhatsApp needs Meta business verification and template approval. Both take weeks → VAL-09 and VAL-10 start in week 1.
4. **"Read" status exists only for WhatsApp and push**, not SMS. The dashboard shows "delivered" for SMS.
5. **Native app for v1** (open question) → assumed web-only console for MVP and pilots; host app in season readiness.
6. **Feed** (open question) → built last in the pilot phase, only if pilot hosts ask for it.
7. **Complete plan includes quiz and face search**, which arrive during the pilot phase; pilot weddings may get them partway through.
