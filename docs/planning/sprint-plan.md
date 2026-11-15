# Mehfil — Sprint Plan

From validation (Nov 2026) to launch for the Nov 2027 wedding season. Story IDs refer to [feature-backlog.md](./feature-backlog.md).

## Assumptions

- **Team:** founder/PM, 2 full-stack engineers (Python + React), 1 frontend engineer (PWA/mobile web), 1 part-time designer. Adjust velocity if this changes.
- **Sprints:** 2 weeks, Monday to Sunday. Planning on day 1, demo and retro on the last Friday.
- **Velocity:** ~32 points per sprint; ~20 in the holiday sprint (S3). From S10 onwards, 8 points per sprint are held back for pilot feedback and bugs, so ~24 are planned.
- **Gates:** each phase starts only when the gate before it passes (PRD release plan).

## Timeline at a glance

| Phase | Sprints | Dates | Outcome | Gate at the end |
| --- | --- | --- | --- | --- |
| 0. Validation | S0–S1 | 16 Nov – 13 Dec 2026 | Interviews, concierge pilot, long-lead admin started, repo and data model ready | **Gate 1:** ≥ 3 planners willing to pay for a pilot |
| 1. MVP build (P0) | S2–S8 | 14 Dec 2026 – 21 Mar 2027 | One wedding can run end to end on the product | **Gate 2:** a 50-guest rehearsal wedding run end to end |
| 2. Pilots + P1 | S9–S15 | 22 Mar – 27 Jun 2027 | 3–5 real pilot weddings; logistics and engagement P1s | **Gate 3:** pilot metrics hit (below) |
| 3. Season readiness | S16–S24 | 28 Jun – 31 Oct 2027 | Billing, native host app, scale, P2 picks, sales | **Gate 4:** launch readiness checklist |
| 4. Launch | S25 | 1 – 14 Nov 2027 | Live for the Nov 2027 season, hypercare | — |

```
Nov  Dec  Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov
|S0 S1|S2 S3 S4 S5 S6 S7 S8|S9 S10 S11 S12 S13 S14 S15|S16 ... S24|S25
 Valid.      MVP build (P0)        Pilots + P1             Season ready  Launch
      G1                     G2                        G3            G4
```

---

## Phase 0 — Validation (S0–S1)

The research says to validate before writing much code. Engineering in this phase is limited to low-regret setup that every outcome needs.

### S0 · 16 – 29 Nov 2026 · "Talk to people, start the slow paperwork"

**Goal:** first interviews done; every long-lead registration submitted; repo scaffolded.

| Track | Items |
| --- | --- |
| Validation | VAL-01, VAL-02 (the wedding you are attending), start VAL-03 (5 of 15 planners), start VAL-05 concierge pilot |
| Admin (long lead) | VAL-08 name shortlist, VAL-09 Meta business verification + BSP account, VAL-10 DLT registration, VAL-11 Razorpay KYC |
| Engineering (12 pts) | FND-01 (3), FND-02 (3), FND-03 (2), SPIKE-1 WhatsApp BSP comparison — Gupshup vs Interakt vs Meta Cloud API direct: price per conversation, interactive buttons, webhook reliability (2), SPIKE-2 browser camera on 3 budget Androids and iOS 15 Safari (2) |
| Design | DSN-01 wireframes for guest home + RSVP |

**Demo:** interview notes; repo with CI green; spike write-ups.

### S1 · 30 Nov – 13 Dec 2026 · "Decide"

**Goal:** go/no-go decision with evidence.

| Track | Items |
| --- | --- |
| Validation | Finish VAL-03 (15 planners), VAL-04 (5 families), VAL-05 concierge pilot results, VAL-06 landing page live, VAL-07 decision, start VAL-12 pilot recruiting |
| Engineering (15 pts) | FND-04 data model (5), FND-06 workers (3), FND-09 i18n (2), FND-10 design system (5) |
| Design | DSN-01 tested with 3 older + 3 younger guests; DSN-02 console IA |

**Gate 1 (13 Dec):** ≥ 3 planners willing to pay for a pilot. Also review: which P1s planners ranked highest (this reorders Phase 2), and the price points that held up. If the gate fails, re-scope before S2 (e.g. narrow to planner ops only or WhatsApp comms only).

---

## Phase 1 — MVP build (S2–S8)

MVP scope (PRD): wedding setup, guest import, RSVP, announcements, travel collection, arrivals board and check-in, roles, guest web home, travel status updates, disposable camera, shared gallery.

### S2 · 14 – 27 Dec 2026 · "A host can create a wedding"

| Story | Pts |
| --- | --- |
| FND-05 Host and staff auth | 5 |
| FND-07 AWS staging environment | 8 |
| SET-01 Create a wedding | 2 |
| SET-02 Events with presets | 3 |
| SET-03 Venues and map pins | 3 |
| GST-01 Add and edit guests in parties | 3 |
| GST-04 Phone normalisation | 2 |
| ROL-04 Organisation (agency) model | 3 |
| **Total** | **29** |

Design: DSN-02 console hi-fi, DSN-05 WhatsApp template copy (submit for approval as soon as VAL-09 clears).
**Demo:** log in on staging, create a wedding with 6 events and venues, add guests by hand.

### S3 · 28 Dec 2026 – 10 Jan 2027 · "Real guest lists" (holiday sprint)

| Story | Pts |
| --- | --- |
| GST-02 Import from Excel/CSV | 5 |
| GST-05 Dedupe and merge | 3 |
| GST-06 Groups and tags | 3 |
| GST-07 Guest list views and export | 3 |
| SET-05 Key contacts | 1 |
| SET-06 Wedding settings | 2 |
| FND-08 Observability | 3 |
| **Total** | **20** |

**Demo:** import a messy 500-row real-world guest sheet (from the concierge pilot), dedupe, group, export.

### S4 · 11 – 24 Jan 2027 · "A guest can open their link and RSVP"

| Story | Pts |
| --- | --- |
| ACC-01 Personal unguessable link | 3 |
| ACC-02 New-device verification (OTP) | 5 |
| ACC-04 Consent capture (DPDP) | 3 |
| ACC-05 Abuse protection | 2 |
| GH-01 PWA shell, fast and offline | 5 |
| GH-02 Personal schedule | 3 |
| RSV-01 Per-event web RSVP | 5 |
| RSV-03 Live headcount | 3 |
| ROL-01 Team roles and invites | 3 |
| **Total** | **32** |

Note: ACC-02 can use the fake sink / SMS until WhatsApp templates are approved.
**Demo:** guest opens link on a budget Android, consents, sees schedule, RSVPs for the family; host sees headcount move.

### S5 · 25 Jan – 7 Feb 2027 · "Send it once, reach everyone"

| Story | Pts |
| --- | --- |
| MSG-01 Provider abstraction + WhatsApp BSP | 8 |
| MSG-02 Template catalogue | 3 |
| MSG-03 Announcement composer | 5 |
| MSG-05 Fan-out worker | 5 |
| MSG-06 Delivery and read status | 3 |
| RSV-02 One-tap WhatsApp RSVP | 5 |
| SET-04 Event visibility by group | 3 |
| **Total** | **32** |

**Risk:** if Meta verification or template approval is not done by now, build against the BSP sandbox and move RSV-02 to S7.
**Demo:** WhatsApp invite to 20 test phones, one-tap RSVP, per-guest delivered/read status.

### S6 · 8 – 21 Feb 2027 · "Who has landed?"

| Story | Pts |
| --- | --- |
| TRV-01 Guest travel form | 5 |
| TRV-02 Ticket upload | 2 |
| TRV-03 Host travel view | 3 |
| TRV-04 Chase missing travel details | 1 |
| ARR-05 Realtime infrastructure | 3 |
| ARR-01 Guest travel status | 3 |
| ARR-02 Live arrivals board | 5 |
| ARR-03 Desk check-in | 5 |
| ARR-04 "Still missing" list | 2 |
| GH-03 My travel and status | 2 |
| GH-07 Guest QR | 1 |
| **Total** | **32** |

Note: CAM-01 (signed uploads) is needed by TRV-02; pull the upload helper forward or build TRV-02 on it at the start of S7.
**Demo:** 30 test guests submit travel; tap "I've landed"; desk staff check in by QR on a tablet; board updates live.

### S7 · 22 Feb – 7 Mar 2027 · "The disposable camera"

| Story | Pts |
| --- | --- |
| CAM-01 Signed direct-to-S3 uploads | 3 |
| CAM-02 Browser camera | 5 |
| CAM-03 Shot limit | 2 |
| CAM-04 Film filter | 3 |
| CAM-05 Offline queue | 5 |
| CAM-07 Media worker | 3 |
| CAM-08 Camera QR / link | 1 |
| MSG-04 Scheduled sends | 2 |
| MSG-07 SMS fallback | 5 |
| RSV-04 Chase non-responders | 2 |
| **Total** | **31** |

**Demo:** shoot 10 photos in airplane mode, reconnect, see them upload; announcement falls back to SMS for a phone without WhatsApp.

### S8 · 8 – 21 Mar 2027 · "Gallery, hardening and rehearsal"

| Story | Pts |
| --- | --- |
| GAL-01 Albums per event | 3 |
| GAL-02 Downloads | 3 |
| GAL-03 Hide and report | 2 |
| ROL-02 Permission enforcement (tests per role) | 5 |
| ROL-03 Audit log | 3 |
| PRV-01 Privacy notice and consent records | 2 |
| PRV-04 Encryption and least privilege | 2 |
| PRV-05 Pre-pilot security review | 3 |
| FND-11 Production environment | 5 |
| GH-04 Key contacts | 1 |
| GH-05 Accessibility | 3 |
| GH-06 Announcements inbox | 2 |
| **Total** | **34** |

Rehearsal: run a mock 2-day "wedding" with ~50 friends and family (including 5+ people over 60) on production: invite, RSVP, travel, announcements, check-in, camera, gallery.

**Gate 2 (21 Mar):** the rehearsal ran end to end with no blocker bugs; guest home < 3 s on a budget Android over 4G; camera opens < 2 s; ≥ 90% of rehearsal announcements delivered < 2 min; security review has no open high-severity issues.

---

## Phase 2 — Pilots + P1 (S9–S15)

3–5 pilot weddings in Apr–Jun 2027 (VAL-12). Each pilot has a named engineer on call during wedding dates. The P1 order below is the default from the research (logistics first); **reorder it with the Gate 1 interview ranking and live pilot requests.**

### S9 · 22 Mar – 4 Apr 2027 · "Pilot readiness" (P0\* catch-up)

| Story | Pts |
| --- | --- |
| GST-03 Import from Google Sheets | 3 |
| GST-08 Import from phone contacts | 3 |
| ACC-03 Shared family phone | 2 |
| RSV-05 Host RSVP on behalf | 1 |
| MSG-08 Web push | 3 |
| MSG-09 Message quota metering | 2 |
| MSG-10 Opt-out handling | 2 |
| CAM-06 Delayed reveal | 2 |
| PRV-02 Data requests | 3 |
| PRV-03 Retention jobs | 3 |
| OPS-03 Per-wedding live dashboard | 3 |
| OPS-04 Device test lab | 3 |
| **Total** | **30** |

Also: pilot onboarding playbook, support WhatsApp line, bug triage rota. Onboard pilot #1.

### S10 · 5 – 18 Apr 2027 · "Pickups"

| Story | Pts |
| --- | --- |
| PCK-01 Auto-batch arrivals | 5 |
| PCK-02 Vehicles, drivers and manual edits | 5 |
| PCK-03 Notify guests | 2 |
| PCK-04 Reassign on delays | 3 |
| PCK-05 Driver link | 3 |
| ROM-01 Room inventory import | 3 |
| ROM-04 Rooming list export | 2 |
| Pilot buffer | 8 |
| **Total** | **24 + 8** |

### S11 · 19 Apr – 2 May 2027 · "Rooms and the ID vault"

| Story | Pts |
| --- | --- |
| ROM-02 Assign parties to rooms | 5 |
| ROM-03 Guest and desk view | 2 |
| IDV-01 Encrypted ID upload | 5 |
| IDV-02 Restricted view with logging | 3 |
| IDV-03 Export for hotel | 2 |
| IDV-04 Auto-delete | 3 |
| FACE-01 Spike: face-matching provider | 3 |
| Pilot buffer | 8 |
| **Total** | **23 + 8** |

### S12 · 3 – 16 May 2027 · "Planners and Hindi"

| Story | Pts |
| --- | --- |
| IDV-05 Vault security review | 3 |
| PLN-01 Wedding overview | 5 |
| PLN-02 Team seats | 3 |
| PLN-05 Clone a wedding / templates | 3 |
| L10N-01 Hindi | 3 |
| L10N-03 Language preference + content translation | 5 |
| L10N-04 Indic fonts and formats | 2 |
| Pilot buffer | 8 |
| **Total** | **24 + 8** |

### S13 · 17 – 30 May 2027 · "Find my photos"

| Story | Pts |
| --- | --- |
| FACE-02 Opt-in and selfie | 3 |
| FACE-03 Matching worker | 5 |
| FACE-04 "My photos" view | 2 |
| FACE-05 Face data deletion | 2 |
| GAL-04 Guest full-album download, favourites | 3 |
| GAL-05 Upload from phone gallery | 2 |
| TRV-05 Flight status lookup | 5 |
| Pilot buffer | 8 |
| **Total** | **22 + 8** |

### S14 · 31 May – 13 Jun 2027 · "Sangeet quiz and Kannada"

| Story | Pts |
| --- | --- |
| QZ-01 Quiz builder | 3 |
| QZ-02 Live quiz mode | 8 |
| QZ-03 Leaderboard and async mode | 3 |
| L10N-02 Kannada | 3 |
| OPS-01 Load tests (first pass) | 5 |
| Pilot buffer | 8 |
| **Total** | **22 + 8** |

### S15 · 14 – 27 Jun 2027 · "Feed or AI tickets, then measure"

| Story | Pts |
| --- | --- |
| FEED-01..03 Feed and moderation **if** pilot hosts asked for it, **else** TRV-06 AI ticket reading (5) + extra hardening | 10 |
| PLN-04 Planner branding | 3 |
| OPS-02 Status page and on-call | 2 |
| Pilot metrics report and retro | — |
| Pilot buffer | 8 |
| **Total** | **15 + 8** |

**Gate 3 (27 Jun):** measured across pilots (PRD success metrics):

| Metric | Target |
| --- | --- |
| Guest activation (opened guest home) | ≥ 70% |
| RSVP response within 7 days | ≥ 85% |
| Travel details captured (out-station guests) | ≥ 80% |
| Arrivals tracked | ≥ 90% |
| Photos collected | ≥ 15 per 10 guests |
| Guests over 60 reached by any channel | ≥ 80% |
| Pilot planners who intend to buy a pack | ≥ 50% |
| NPS | Host ≥ 50, guest ≥ 40 |

If older-guest reach misses, pull VOX-01 (voice calls) into S18. If planner intent misses, revisit pricing and the wedge before Phase 3.

---

## Phase 3 — Season readiness (S16–S24)

Planners book tools for Nov–Dec weddings in Aug–Sep, so **sales start in S19 (Aug)** and the product must be sellable (billing, onboarding, planner packs) by then.

| Sprint | Dates | Theme | Stories |
| --- | --- | --- | --- |
| S16 | 28 Jun – 11 Jul | Get paid | BIL-01 (5), BIL-02 (5), BIL-03 (3), BIL-04 (2), PLN-03 (2), GTM-02 (3), pilot backlog (8) |
| S17 | 12 – 25 Jul | Self-serve + host app | GTM-01 (5), APP-01 (8), OPS-05 (3), OPS-06 (2), pilot backlog (10) |
| S18 | 26 Jul – 8 Aug | Native + P2 slot 1 | APP-02 (5), APP-03 (3), P2 slot 1 — default VOX-01 voice calls (8), hardening (10) |
| S19 | 9 – 22 Aug | **Sales start** + P2 slot 2 | P2 slot 2 — default VOX-02 (3) + WL-01 white-label for venue deals (5); planner demo environment; sales collateral |
| S20 | 23 Aug – 5 Sep | P2 slot 3 | Default WSH-01 wishes (5) or PWP-01 post-wedding pack (8) — pick from pilot feedback; third language (open question) |
| S21 | 6 – 19 Sep | Scale | OPS-01 full load test at peak (2,000 guests, 300 uploads/min, 50 weddings); external pen test; fixes |
| S22 | 20 Sep – 3 Oct | Onboard first paying planners | Migration/import help, planner training, support tooling, fixes |
| S23 | 4 – 17 Oct | **Feature freeze 17 Oct** | Bug bash on the device lab, accessibility pass with older users, docs and help centre |
| S24 | 18 – 31 Oct | Launch readiness | Release candidate, DR drill, on-call rota for Nov dates, support playbooks |

**Gate 4 (31 Oct):** no open P0/P1 bugs; load test targets met; pen test highs fixed; billing tested end to end with real payments; on-call rota covers every live wedding date in November.

## Phase 4 — Launch (S25 · 1 – 14 Nov 2027)

Live for the season. Hypercare: daily bug triage, per-wedding dashboards watched during events, weekly planner check-ins, a 99.9% availability target on wedding dates.

---

## Working agreements

**Definition of Ready (a story can enter a sprint when):** acceptance criteria written; designs attached if it has UI; dependencies done or in the same sprint; estimate agreed.

**Definition of Done:**

- Code reviewed and merged; CI green; unit tests for logic and an API test per permission rule touched.
- Guest-facing strings externalised (no hard-coded English).
- Guest screens checked on the budget Android in the device lab and on iOS Safari.
- Permissions enforced at the API, not only in the UI.
- Personal data: purpose noted, retention set, nothing sensitive in logs.
- Deployed to staging and shown in the sprint demo.

**Ceremonies:** planning (Mon, 1 h), 15-min daily stand-up, mid-sprint backlog refinement (45 min), demo + retro (last Fri, 1 h). During pilots, a short pilot review in each demo.

## Critical path and schedule risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Meta business verification / template approval slow | Blocks RSV-02, ACC-02 over WhatsApp, all announcements | Submit in S0; build against BSP sandbox; SMS fallback path |
| DLT registration slow | Blocks MSG-07 SMS fallback | Submit in S0; WhatsApp + web push cover the gap for the rehearsal |
| Browser camera quirks on budget Android / iOS | Camera is a P0 differentiator | SPIKE-2 in S0; file-input fallback in CAM-02 |
| Pilot weddings fall through | Gate 3 has no data | Recruit 5 to land 3; offer pilots free; include a friendly family wedding |
| Feature creep from pilots | MVP slips, season missed | 8-pt pilot buffer per sprint; everything else goes to the backlog and is ranked at Gate 3 |
| Small team, peak-season on-call | Burnout, slow fixes | On-call rota from S9; feature freeze 17 Oct |
