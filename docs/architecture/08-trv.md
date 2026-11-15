# E08 — Travel collection (TRV)

Status: design · Owner module: `apps/api/src/modules/travel` · SQL: [`sql/08-trv.sql`](./sql/08-trv.sql)

## 1. Summary

Guests (or the host for them) record **arrival and departure legs** per party or per member: date/time, mode, flight/train number, origin, arrival point, needs pickup, and an optional **ticket** (PDF/image in private S3). Hosts see a **travel view** by day, hour and point, edit it, and **export to Excel**. Hosts **chase** out-station parties with no details through the MSG module. P1 adds **flight status lookup** (delays flow to the arrivals board and pickups) and **AI ticket reading** (prefill from the uploaded ticket; guest confirms).

| Story | Pri | Sprint (plan) | Covered here |
| --- | --- | --- | --- |
| TRV-01 Guest travel form | P0 | S6 | RN Guest mode form + guest lite web form, host edit |
| TRV-02 Ticket upload | P0 | S6 (needs CAM-01 helper) | `media_objects` kind `ticket`, presigned PUT |
| TRV-03 Host travel view | P0 | S6 | Host mode list + day/hour/point summary + `.xlsx` export |
| TRV-04 Chase missing travel | P0 | S6 | Chase list + MSG `travel_reminder` |
| TRV-05 Flight status lookup | P1 | S13 | `FlightStatusProvider` (AeroDataBox) + shared cache + poller |
| TRV-06 AI ticket reading | P1 | S15 (if not FEED) | `TicketReader` (Claude API) + confirm screen |

**Stack reinterpretation:** the backlog says "PWA" and "signed URL / presigned POST". Here the guest form lives in the **React Native Guest mode** (`features/travel`) with a **server-rendered lite web form** at `/g/:token/travel` for guests without the app; uploads use the baseline's **presigned PUT** flow (`POST /v1/weddings/:id/uploads`), not presigned POST. "Excel export" is generated server-side with `exceljs` and handed to the app's share sheet.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Shape of travel data | `travel_legs` + `travel_leg_guests` (one leg shared by N members; one arrival + one departure leg per guest, DB-enforced) | One travel row per guest | A family of 5 on one flight is entered once; per-member splits still possible; uniqueness per guest keeps the board unambiguous. |
| Arrival points | Host-managed `travel_points` list (airport/station/bus stand) + "direct to venue/hotel" (`point_id` null) | Free-text "arrival point" | Board grouping and pickup batching need exact matches; free text gives "UDR", "Udaipur airport", "Maharana Pratap". |
| Connecting journeys | Record only the final leg into / out of the wedding city | Multi-segment itineraries | All downstream features (board, pickups, rooms) need only the last leg. |
| Concurrency (guest vs host edit) | `version` column + `If-Match` → `409 TRV_VERSION_CONFLICT` | Last write wins | Host fixes a time while the guest edits on a phone; silent overwrite loses the host fix. |
| Export | Synchronous `exceljs` streaming → S3 `export` object (24 h `delete_after`) → presigned GET URL | pg-boss job + notification | ≤ 2,000 rows builds in < 1 s; async adds a polling UI for nothing. Same pattern as ROM-04. |
| Chase reminders | Call `messaging.sendToGuests()` with kind `travel_reminder`, idempotency key per party per day | TRV sends WhatsApp itself | Baseline module boundaries; MSG owns templates, quota, opt-outs, fallback. |
| Flight status provider | **AeroDataBox** (API.market/RapidAPI plan) behind `FlightStatusProvider`; FlightAware AeroAPI as the swap-in | FlightAware first; Aviationstack; Cirium | Cheapest with good Indian domestic coverage and per-flight-date queries; FlightAware is better but costs ~10× per query; Aviationstack data is often stale; Cirium is enterprise-priced. |
| Flight status storage | Global `flight_status_cache` keyed by (carrier, number, date) — not wedding-scoped | Per-leg polling | Many guests share flights (the baraat from Delhi); one call serves all weddings. Public, non-personal data. |
| Trains | Not tracked (manual "running late" only) | Scraping NTES / unofficial APIs | No official IRCTC/NTES API; scraping is brittle and against ToS. |
| AI ticket reading | `TicketReader` interface; **Anthropic Claude API** adapter (`@anthropic-ai/sdk`, model `claude-opus-5-5` from config, structured output) ; `FakeTicketReader` in dev/test | On-device OCR + regex; Google Document AI | Tickets vary wildly (IndiGo PDF, IRCTC e-ticket, WhatsApp screenshot); an LLM with a JSON schema handles them in one call. Model id is config so the PO can trade cost (see §13). |
| AI output trust | Never written directly to a leg: stored in `ticket_extractions.result`, shown as a prefilled form the guest confirms | Auto-apply above a confidence threshold | Wrong date = guest stranded at the airport. |

## 3. Data model

DDL: [`sql/08-trv.sql`](./sql/08-trv.sql). **Schema check passed** (`scripts/check-schema.sh arch_trv 000-core.sql 08-trv.sql` → `OK: 22 tables`; also applied cleanly in the full-directory run). EXPLAIN on 36,000 guests / 20 weddings: day view uses `travel_legs_sched_idx` (0.9 ms).

| Table | Purpose | Notes |
| --- | --- | --- |
| `travel_points` | Airports / stations / bus stands per wedding | `code` (IATA / station code) used to match flight-status arrivals; `pickup_buffer_minutes` and `transfer_minutes` are read by PCK. Seeded from wedding city on setup (e.g. "Udaipur Airport (UDR)", "Udaipur City (UDZ)"). Host-only CRUD. |
| `travel_legs` | One journey in or out | `scheduled_at` = arrival time (arrival) or departure time (departure), UTC. `estimated_at`/`flight_status*` written only by the flight-status job. `source` = guest / host / ticket_ai. `version` for optimistic concurrency. `UNIQUE (id, wedding_id, direction)` is the target of the composite FK that keeps `travel_leg_guests` consistent. |
| `travel_leg_guests` | Members on a leg | `UNIQUE (guest_id, direction)` → at most one arrival and one departure leg per guest. Composite FK guarantees same wedding and direction as the leg. |
| `travel_party_state` | Per-party progress | `pending` / `partial` (some members) / `submitted` / `not_travelling` (local guest said "no travel"). `last_chased_at`, `chase_count` drive TRV-04 and a 24 h chase cool-down. |
| `ticket_extractions` | TRV-06 attempts | One per ticket (`UNIQUE media_id`). `result` = normalised fields + per-field confidence only; raw OCR text is not stored. Deleted with the ticket. |
| `flight_status_cache` | TRV-05 provider results | Not wedding-scoped (documented deviation). `next_poll_at` drives the poller. |

Tickets reuse core `media_objects` (`kind='ticket'`, private bucket, `delete_after = weddings.ends_on + 1 day` set at upload; PRV-03 deletes).

Retention: legs and party state live with the wedding (deleted by PRV whole-wedding deletion / guest deletion via cascade); `ticket_extractions` cascade with the media row; `flight_status_cache` rows older than 7 days are purged nightly.

## 4. API

All host routes are `/v1/weddings/:weddingId/...` behind `requireWeddingRole`; guest routes use the guest JWT (ACC) and are scoped to `party_id` from the token.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/guest/travel` | guest | Party's legs, members, state, travel points | — |
| POST | `/v1/guest/travel/legs` | guest | Create leg for some/all members | `TRV_GUEST_NOT_IN_PARTY`, `TRV_LEG_EXISTS_FOR_GUEST` (409), `TRV_POINT_INACTIVE` |
| PATCH | `/v1/guest/travel/legs/:legId` | guest | Edit (requires `If-Match: <version>`) | `TRV_VERSION_CONFLICT` (409) |
| DELETE | `/v1/guest/travel/legs/:legId` | guest | Remove leg | — |
| POST | `/v1/guest/travel/not-travelling` | guest | Mark party as local / no travel | — |
| POST | `/v1/guest/travel/tickets` | guest | Attach an uploaded ticket (`mediaId`) to a leg or to the party (pre-leg, for AI) | `TRV_MEDIA_NOT_TICKET`, `TRV_MEDIA_NOT_UPLOADED` |
| GET | `/v1/guest/travel/tickets/:mediaId/url` | guest | Presigned GET (60 s) for own ticket | 404 if not own party |
| POST | `/v1/guest/travel/tickets/:mediaId/extract` | guest | TRV-06: start AI reading (idempotent per media) | `TRV_AI_DISABLED`, `TRV_AI_RATE_LIMITED` (429) |
| GET | `/v1/guest/travel/extractions/:id` | guest | Poll extraction (`queued`/`succeeded`/`failed`) | — |
| GET | `/v1/weddings/:wid/travel-points` | owner, co_host, planner_member, desk_staff | List points | — |
| POST/PATCH/DELETE | `/v1/weddings/:wid/travel-points[/:id]` | owner, co_host, planner_member | Manage points (delete = `is_active=false` if referenced) | `TRV_POINT_NAME_TAKEN` |
| GET | `/v1/weddings/:wid/travel/legs` | owner, co_host, planner_member | Host list: `?direction=&from=&to=&pointId=&mode=&needsPickup=&q=&cursor=&limit=` | — |
| GET | `/v1/weddings/:wid/travel/summary` | owner, co_host, planner_member | Counts by day × hour × point (guests, parties, needs pickup) | — |
| POST/PATCH/DELETE | `/v1/weddings/:wid/travel/legs[/:id]` | owner, co_host, planner_member | Host create/edit for a party (`source='host'`), audit-logged | as guest |
| GET | `/v1/weddings/:wid/travel/missing` | owner, co_host, planner_member | TRV-04: out-station parties with `pending`/`partial`, last chased | — |
| POST | `/v1/weddings/:wid/travel/chase` | owner, co_host, planner_member | Send reminder to `{partyIds}` or `{allMissing:true}`; `Idempotency-Key` required | `TRV_CHASE_COOLDOWN` (per party, 24 h, skipped not failed), `MSG_QUOTA_EXCEEDED` (from MSG) |
| POST | `/v1/weddings/:wid/travel/export` | owner, co_host, planner_member | `.xlsx` (sheets: Arrivals, Departures, Summary) → `{url, expiresAt}` | — |
| POST | `/v1/weddings/:wid/travel/legs/:id/refresh-flight` | owner, co_host, planner_member | TRV-05: force a status fetch (rate-limited 1/min/flight) | `TRV_NOT_A_FLIGHT` |

Desk staff never call travel endpoints except `travel-points` (board filter labels); they see arrivals through ARR's masked board.

Uploading a ticket uses the baseline media flow: `POST /v1/weddings/:wid/uploads {kind:'ticket', contentType:'application/pdf'|'image/jpeg'|'image/png'|'image/heic', size ≤ 10 MB}` (guest token allowed for `ticket`), PUT to S3, `POST /v1/uploads/:mediaId/complete`, then `POST /v1/guest/travel/tickets`. The media worker skips thumbnails for PDFs and strips EXIF from images as usual.

**Create leg (guest)**

```http
POST /v1/guest/travel/legs
{ "direction": "arrival", "mode": "flight", "carrierCode": "6E", "serviceNumber": "6E 2134",
  "originCity": "Delhi", "pointId": "6a1…", "scheduledAt": "2027-04-09T10:40:00+05:30",
  "needsPickup": true, "guestIds": ["c1…","c2…","c3…"], "ticketMediaId": null }
→ 201 { "id": "9f…", "version": 1, "direction": "arrival", "mode": "flight",
        "carrierCode": "6E", "serviceNumber": "6E2134", "scheduledAt": "2027-04-09T05:10:00Z",
        "point": { "id": "6a1…", "name": "Udaipur Airport (UDR)" }, "needsPickup": true,
        "guests": [{ "id": "c1…", "fullName": "Asha Sharma" }, …], "flight": null }
```

Validation (Zod): `scheduledAt` within `[weddings.starts_on − 7 days, ends_on + 7 days]` (`TRV_DATE_OUT_OF_RANGE`); flight number normalised `^[A-Z0-9]{2}\d{1,4}[A-Z]?$`; train `^\d{5}$` (warning only); `guestIds` ⊆ party and none already on an arrival leg.

**Travel summary (host)**

```http
GET /v1/weddings/:wid/travel/summary?direction=arrival
→ 200 { "timezone": "Asia/Kolkata", "days": [ { "date": "2027-04-09",
    "hours": [ { "hour": 10, "byPoint": [ { "pointId": "6a1…", "guests": 23, "parties": 8, "needsPickup": 19 } ] } ] } ],
    "noDetails": { "parties": 41, "guests": 117 } }
```

**Chase**

```http
POST /v1/weddings/:wid/travel/chase      Idempotency-Key: 5c0e…
{ "allMissing": true }
→ 202 { "messageId": "m-…", "queued": 38, "skippedCooldown": 3, "skippedNoPhone": 2 }
```

## 5. Jobs, events and realtime

| Kind | Name | Payload / trigger | Notes |
| --- | --- | --- | --- |
| Domain event (in-process) | `travel.leg.changed` | `{weddingId, legId, partyId, guestIds, direction, change: 'created'|'updated'|'deleted'}` | ARR rebuilds `arrival_state` for those guests; PCK marks affected draft batches stale. Emitted after commit. |
| Domain event | `travel.flight.updated` | `{weddingId, legId, guestIds, status, estimatedAt, delayMinutes}` | ARR sets `eta_at`/`flight_flag`; PCK-04 raises alerts. |
| pg-boss cron (`default`) | `travel.flight-status.schedule` every 5 min | — | Upserts cache rows for arrival flights with `scheduled_at` in [now − 6 h, now + 30 h]; sets `next_poll_at`. Only weddings on a plan with TRV-05. |
| pg-boss (`default`) | `travel.flight-status.poll` | `{carrier, number, date}`; singletonKey = same | Poll cadence: T−24 h once, T−6 h → T−1 h every 30 min, T−1 h → landed every 10 min, stop at landed/cancelled or T+6 h. Retries 3 with backoff; provider 429 → back off 15 min. Writes cache, then updates matching `travel_legs` and emits `travel.flight.updated` when ETA moves ≥ 10 min or status changes. |
| pg-boss (`media`) | `travel.ticket.extract` | `{extractionId}`; singletonKey = mediaId | Fetches the object from S3, calls `TicketReader`, stores `result`. Timeout 60 s, 2 retries on 5xx/timeouts, none on refusal/invalid. |
| Via MSG | `messaging.sendToGuests({weddingId, kind:'travel_reminder', templateKey:'travel_details_request', guestIds: party primaries (fallback: any member with valid phone), params:{link_target:'travel'}, idempotencyKey:'trv-chase:'+partyId+':'+istDate, createdByModule:'trv'})` | | MSG handles quota, opt-outs, SMS fallback and delivery status. |

No SSE channel of its own: the host travel view refetches on focus; live movement lives on the ARR board.

**Interfaces with fakes**

```ts
interface FlightStatusProvider {            // adapters: AeroDataBoxProvider, FakeFlightStatusProvider
  getStatus(q: { carrier: string; number: string; date: string /* YYYY-MM-DD */ }):
    Promise<{ status: FlightStatus; arrivalIata?: string; terminal?: string;
              scheduledArrival?: Date; estimatedArrival?: Date; actualArrival?: Date } | null>;
}
interface TicketReader {                     // adapters: ClaudeTicketReader, FakeTicketReader
  read(file: { bytes: Buffer; contentType: string }, hints: { weddingCity: string; dates: [string, string] }):
    Promise<{ legs: Array<{ direction?: 'arrival'|'departure'; mode: Mode; carrierCode?: string;
              serviceNumber?: string; originCity?: string; destinationCode?: string;
              scheduledAt?: string; passengerNames: string[]; confidence: Record<string, number> }> }>;
}
```

`ClaudeTicketReader`: one Messages API call via `@anthropic-ai/sdk`, PDF as a `document` block / image as an `image` block, `output_config.format` JSON schema, model from `TICKET_AI_MODEL` (default `claude-opus-5-5`), server-side refusal fallbacks enabled, `stop_reason` checked before reading content (refusal → `failed` with `TRV_AI_UNREADABLE`). Passenger names are matched to party members in our code (fuzzy, pg_trgm-style similarity), never sent back to the model.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | `TravelHome` | Cards: "Arriving", "Leaving", party members not yet covered, "We're local — no travel" button. Entry from guest home (GH-03) and the WhatsApp reminder deep link `mehfil://g/travel`. |
| Guest | `TravelLegForm` | Steps on one scroll: who's travelling (member chips, default all) → mode (large icon buttons) → number → date + time (native pickers, wedding timezone shown) → arrival point (list from `travel_points` + "Coming directly") → needs pickup toggle → ticket (optional). Departure form reuses the component. |
| Guest | `TicketAttach` | `react-native-document-picker` (PDF) or camera/gallery (image); goes through the shared `upload-queue` (survives offline / app kill). P1: "Fill from ticket" button → `TicketReviewScreen` with prefilled fields highlighted for confirmation. |
| Host | `TravelOverview` | Segmented Arrivals / Departures; day tabs; hour × point grid (counts) → tap opens filtered list. |
| Host | `TravelList` | FlashList, filters (point, mode, needs pickup, no details), search; row → `TravelLegEdit` (same form, host fields). |
| Host | `TravelMissing` | Out-station parties without details, select all → "Send reminder" (confirm sheet with count and template preview). |
| Host | `TravelPoints` | Settings sub-screen to manage points. |
| Host | Export | Header action → API returns URL → download to cache with `react-native-blob-util` → OS share sheet. |

TanStack Query keys: `['guest','travel']`, `['wedding',wid,'travel','legs',filters]`, `['wedding',wid,'travel','summary',direction]`, `['wedding',wid,'travel','missing']`, `['wedding',wid,'travel-points']`. Mutations invalidate summary + list.

Offline: the guest form saves a draft in MMKV and submits when online (mutation retried with the same `client_op_id`); the ticket upload uses the persistent upload queue. Host screens are online-only with cached last view.

Accessibility: all controls ≥ 48 dp, icon + label for modes, time shown as "10:40 AM, Fri 9 Apr" in the wedding timezone, large-text mode reflows the form into one column; screen-reader labels on member chips.

## 7. Guest lite web

**Applicable.** `/g/:token/travel` (server-rendered, no JS required; ~15 KB) lets a guest without the app add or edit arrival/departure for the party (same service and validation), mark "not travelling", and see what is on file. Ticket upload and AI reading are **app-only** (keeps the page tiny and avoids building a browser upload flow). Session: the ACC lite-web session cookie (OTP-verified device); forms carry a CSRF token. Strings come from the shared i18n catalogue.

## 8. Security and privacy

- **Permissions** (`packages/domain` actions): `travel.read`, `travel.write`, `travel.export`, `travel.chase`, `travel.points.manage` → owner, co_host, planner_member. desk_staff: `travel.points.read` only. Guests: own party only (party from token, never from the body); other weddings → 404.
- **Minimisation:** no PNR, seat, booking reference or fare is stored; AI extraction schema has no such fields. Ticket images/PDFs are the most sensitive item (they often show PNR and phone): private bucket, presigned GET 60 s, not visible to desk staff, deleted 1 day after the wedding (`delete_after`), extraction rows cascade.
- **Consent purpose:** `core` (logistics) covers travel details. AI ticket reading sends the ticket to Anthropic (outside India) — the privacy notice (PRV-01) must name it; the button is shown only when the wedding enables it and the guest taps it (explicit action). Flight-status calls send only carrier + number + date, no names.
- **Audit log:** host create/edit/delete of legs (`travel.leg.update`, before/after), exports (`travel.export`), chase sends (`travel.chase`), ticket view by host (`travel.ticket.view`).
- **Rate limits:** guest leg writes 30/h/party; ticket extract 5/day/party and 200/day/wedding; export 10/h/user; manual flight refresh 1/min/flight.
- **Logs:** never log ticket contents, names or phones; log leg ids only.

## 9. Scale and performance

- 2,000 guests ≈ 700 parties ≈ 700–900 legs per direction: trivial row counts. Summary query is a single grouped scan over `travel_legs_sched_idx` (< 5 ms measured at 36k guests across 20 weddings).
- Export: exceljs streaming writer, ~2,000 rows < 1 s, < 1 MB.
- Flight polling: ~150 distinct flights per big wedding day; across 50 live weddings with overlap maybe 2,000 polls/day at the 10/30-min cadence → AeroDataBox mid-tier plan. Poll jobs are singleton per flight so duplicates collapse.
- Ticket extraction: bursty after a chase (≤ 200/day/wedding cap); runs on the `media` queue with concurrency 4 so it never starves photo processing on the same worker (cap configurable).

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Flight/train number normalisation; date-range validation in IST; `travel_party_state` derivation (pending/partial/submitted); poll cadence calculator; passenger-name matcher; summary bucketing across midnight IST. |
| API e2e (supertest, `mehfil_test`) | Guest CRUD scoped to own party (other party → 404); `TRV_LEG_EXISTS_FOR_GUEST`; `If-Match` conflict; host edit is audit-logged; desk_staff gets 404/403 matrix on every travel route (ROL-02 style table test); chase idempotency + cool-down using `LogSinkProvider`; export returns a parseable xlsx (read back with exceljs); ticket attach rejects non-ticket media; extraction with `FakeTicketReader` → succeeded → apply. |
| Jobs | Flight poll with `FakeFlightStatusProvider` scripted timeline (scheduled → delayed 50 min → landed) emits `travel.flight.updated` exactly at threshold changes. |
| Mobile | RNTL: form validation, member selection, offline draft restore; ticket attach queues upload; host export calls share. |
| Device | Budget Android: form with large text; PDF picker on Android 9; date picker in Hindi locale. |

Fakes needed: `FakeFlightStatusProvider`, `FakeTicketReader`, `FakeObjectStore`, `LogSinkProvider`.

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| TRV-01 Guest travel form | [DB] travel_points, travel_legs, travel_leg_guests, travel_party_state · [API] guest CRUD, not-travelling, host CRUD, points CRUD · [MOB] TravelHome, TravelLegForm (arrival/departure), draft offline · [WEB] `/g/:token/travel` form · [TEST] e2e + RNTL | 5 → **6** | Adds the lite-web form (keeps no-install promise) and the travel-points setup that no story owned. |
| TRV-02 Ticket upload | [API] attach/presigned GET, `kind=ticket` rules + `delete_after` · [MOB] TicketAttach via upload-queue, PDF picker · [TEST] | 2 → **3** | RN document picker + upload queue integration; depends on CAM-01's presign helper which is scheduled after S6. |
| TRV-03 Host travel view | [API] list with filters, summary, export (exceljs → S3 → URL) · [MOB] TravelOverview grid, TravelList, TravelLegEdit, share-sheet export · [TEST] xlsx read-back | 3 → **5** | Host UI is now native screens (not a web console) plus file download/share on RN. |
| TRV-04 Chase missing | [API] missing list, chase (idempotent, cool-down) via MSG interface · [MOB] TravelMissing · [TEST] | 1 → **2** | Needs a new MSG template (`travel_details_request`) approved by Meta and cool-down logic. |
| TRV-05 Flight status lookup | [DB] flight_status_cache · [JOB] schedule + poll · [API] refresh endpoint · [OPS] AeroDataBox account, key in `.env`, cost alert · [TEST] fake timeline | 5 → **5** | Unchanged; board/pickup consumers are in ARR/PCK. |
| TRV-06 AI ticket reading | [DB] ticket_extractions · [JOB] extract · [API] start/poll/apply · [MOB] TicketReviewScreen · [OPS] Anthropic key, spend cap · [TEST] golden set of 30 real (redacted) tickets run against the real model in a manual eval, fake in CI | 5 → **5** | Unchanged. |
| **Total** | | **21 → 26** (P0 11 → 16, P1 10 → 10) | |

## 12. Dependencies and sequencing

- **Before TRV-01:** ACC-01/02 (guest JWT + lite-web session), GST-01 (parties/guests, `is_outstation`), SET (wedding dates, city for point seeding), FND realtime not needed.
- **TRV-02:** baseline upload endpoint (`POST /uploads`, `/complete`) from CAM-01 and the app's `upload-queue` (CAM-05 equivalent in RN). Plan says CAM-01 is S7 → build the minimal presign helper in S6 or move TRV-02 to S7.
- **TRV-04:** MSG-01/02/03/05 — `messaging.sendToGuests` and a `travel_reminder` kind (already in `07-msg.sql`'s `messages.kind`).
- **TRV-05:** ARR-02 (board shows flags); PCK-04 consumes `travel.flight.updated`.
- **Consumers:** ARR (09) reads `travel_legs`, `travel_leg_guests`, `travel_points` and subscribes to `travel.leg.changed`; PCK (15) reads points' buffer/transfer minutes; ROM (16) reads arrival/departure dates for stay suggestions.

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| Guests type wrong dates (AM/PM, day before) | Show "Arriving Fri 9 Apr, 10:40 AM — 1 day before the Mehendi" confirmation line; host sees out-of-pattern legs flagged. |
| AeroDataBox coverage/latency for small Indian airports | Spike in S12 against 20 real flights into UDR/JAI/GOI; FlightAware adapter as fallback. |
| AI ticket reading cost and cross-border transfer | **PO decision:** model tier (`claude-opus-5-5` default vs a cheaper model such as `claude-haiku-5-5`) and whether to offer it at all on the free plan; legal sign-off on the notice wording. |
| WhatsApp template approval for `travel_details_request` | Submit with the S5 template batch. |
| Local (non-outstation) guests driving in | They can add a `car` leg without a point; board shows them under "Direct". |

## 14. Deviations from the baseline

1. `flight_status_cache` is **not wedding-scoped** (no `wedding_id`): it holds public flight data shared across weddings, with no personal data. Baseline rule "every wedding-scoped table has `wedding_id`" is unaffected in spirit; noting it for reviewers.
2. Guest tokens may call `POST /v1/weddings/:wid/uploads` for `kind='ticket'` (the baseline media flow describes the app generally; CAM's design must allow guest uploads of this kind with a 10 MB / PDF+image whitelist).
