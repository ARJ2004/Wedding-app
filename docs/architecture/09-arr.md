# E09 — Arrivals board and check-in (ARR)

Status: design · Owner module: `apps/api/src/modules/arrivals` · SQL: [`sql/09-arr.sql`](./sql/09-arr.sql)

## 1. Summary

Guests tell us where they are ("I've landed", "Running late by X", "At the hotel") from the **app**, the **guest lite web page** or a **WhatsApp quick reply**. Hosts see a **live arrivals board** — expected vs arrived per time window and arrival point, with status chips — that updates within 5 s without refresh. Desk staff **check in** guests at the hotel/venue by **name search** or by **scanning the party QR** with the phone camera, for the whole party or some members, even on flaky venue Wi-Fi. A **"still missing"** list shows who is overdue, with their last status and (for hosts only) a call button.

| Story | Sprint (plan) | Covered here |
| --- | --- | --- |
| ARR-01 Guest travel status | S6 | app button, lite web button, WhatsApp quick reply (dispatched from MSG) |
| ARR-02 Live arrivals board | S6 | `arrival_state` read model + SSE channel `arrivals` |
| ARR-03 Desk check-in | S6 | pg_trgm search, QR scan (RN camera), partial party, offline queue |
| ARR-04 "Still missing" list | S6 | overdue query, host-only call button |
| ARR-05 Realtime infrastructure | S6 | **Reinterpreted:** the hub (`realtime_events`, `rt_publish()`, LISTEN/NOTIFY, SSE endpoint, replay) is built by FND (`01-fnd.sql`). ARR-05 becomes: the `arrivals` channel contract, the RN SSE client hook, Nginx/PM2 settings check, and load test of the board. |

**Stack reinterpretation:** backlog says "Redis pub/sub → SSE". Baseline replaces Redis with Postgres `LISTEN/NOTIFY`; "guest home" is the RN Guest mode plus the lite web page; the desk runs the RN app in **Host mode** signed in as `desk_staff` (Google SSO), on a phone or tablet.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Board data source | Denormalised `arrival_state` (one row per expected guest), written by ARR on travel events, status updates and check-ins | Compute the board live from `travel_legs` + latest status per guest | One indexed scan per board load (< 5 ms at 2,000 guests); each change touches one small row; payloads are the row itself. |
| Realtime | FND hub: `rt_publish(wedding,'arrivals','arrival.updated', rows)` in the same transaction; clients replay with `Last-Event-ID` | Own NOTIFY channel / own sequence | One realtime mechanism for the product; replay and 24 h retention come for free. |
| Delta payload | Masked board rows (≤ 40 rows per event, chunked) | "Something changed, refetch" pings | 2,000-guest board refetching on every tap from 10 screens = needless load; rows are ~80 bytes each. |
| Status history | Append-only `travel_status_updates` + current value in `arrival_state` | Only current value | Disputes ("I told you I landed!") and the "last status" column; also the dedupe point for WhatsApp retries. |
| Check-in model | Per **guest** (partial party natural); `check_in_events` log with device-generated `client_op_id` | Per party flag | Families arrive in pieces; offline replays must be idempotent. |
| Desk offline | Desk app caches a **masked roster** (names, party, status, room, check-in code — never phones) and queues check-ins in MMKV | Online-only search | Venue Wi-Fi is the norm-bad case; check-in must keep working and sync later. |
| Name search | Device-local search over the cached roster; server `pg_trgm` search when the roster isn't loaded yet | Server-only | Instant results as you type on a budget tablet, works offline. |
| QR content | `https://<domain>/q/<checkin_code>` — 60-bit code per party, **not** the link token | Encode the guest link token | The link token is a login credential; a photo of the QR must not let anyone into the guest's home. The code resolves only for a signed-in team member of that wedding; opened by anyone else it shows "Show this at the welcome desk". |
| Camera | `react-native-vision-camera` v4 `useCodeScanner` (ML Kit on Android, AVFoundation on iOS) | `react-native-camera` (deprecated); a JS decoder | Maintained, fast on budget Android, New Architecture ready. |
| WhatsApp status | MSG decodes button payloads into actions `arr.landed`, `arr.at_hotel`, `arr.late`, `arr.late:<minutes>` and calls `arrivals.handleInboundAction()`; "Running late" opens an interactive list (30 min / 1 h / 2 h / 3 h+) inside the 24 h session | Free-text parsing | WhatsApp templates allow max 3 quick-reply buttons; the list keeps it one-tap. |
| Phones for desk staff | Never in any ARR response or realtime payload; call button only in the host-roles variant of "still missing" | Mask at the UI | Baseline and ROL-02: masking in serialisers, and the realtime channel is shared by all roles so it never carries phones. |

## 3. Data model

DDL: [`sql/09-arr.sql`](./sql/09-arr.sql). **Schema check passed** (`scripts/check-schema.sh arch_arr 000-core.sql 08-trv.sql 09-arr.sql` → `OK: 25 tables`; also applied cleanly in the full-directory run). EXPLAIN with 36,000 guests (20 weddings × 1,800): "still missing" uses `arrival_state_missing_idx` (0.6 ms); board aggregate uses `arrival_state_board_idx` (3.2 ms); name search uses `guests_name_trgm_idx` ∧ wedding index bitmap-AND (1.4 ms).

| Table / change | Purpose | Notes |
| --- | --- | --- |
| `parties.checkin_code` (ALTER) | Party QR code | 12-char Crockford base32, unique per wedding, generated lazily on first `GET` of the guest QR (GH-07) or roster build. Regenerated when the host rotates the party link (ACC-01). |
| `arrival_state` | Board read model, one row per expected guest | Created on: arrival leg created (TRV event), party marked out-station (GST event), or unplanned desk check-in. `expected_at` = leg schedule; `eta_at` = flight estimate (TRV-05) or `expected_at + late_by`; `status` = latest of expected / running_late / landed / picked_up / at_hotel / checked_in; `checked_in_*` set only by check-in. Written only by ARR. |
| `travel_status_updates` | Append-only status history | Unique `(wedding_id, client_op_id)` for app/lite retries and unique `inbound_message_id` for WhatsApp webhook retries. `guest_id` null = whole party on the leg. |
| `check_in_events` | Check-in / undo log | `UNIQUE (wedding_id, client_op_id, guest_id)` makes offline replay idempotent. `occurred_at` = device time, clamped to [now − 24 h, now]. |

Status precedence (applied in `arrivals.service.applyStatus`): `checked_in` is terminal unless undone; `at_hotel` > `picked_up` > `landed` > `running_late` > `expected`; a later `running_late` after `landed` is ignored; `on_time` clears `late_by_minutes`.

Retention: `travel_status_updates`, `check_in_events` and `arrival_state` are purged 30 days after `weddings.ends_on` (PRV-03 job calls `arrivals.purgeWedding()`); realtime events 24 h (FND).

## 4. API

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| POST | `/v1/guest/arrivals/status` | guest | `{status, lateByMinutes?, guestIds?, clientOpId}`; default = all party members on the arrival leg | `ARR_STATUS_INVALID`, `ARR_NO_ARRIVAL_EXPECTED` (no leg and not out-station → still accepted, creates row) |
| GET | `/v1/guest/arrivals/status` | guest | Party members' current status (for GH-03 buttons) | — |
| GET | `/v1/guest/checkin-code` | guest | Party QR payload (used by GH-07) | — |
| GET | `/v1/weddings/:wid/arrivals/board` | owner, co_host, planner_member, desk_staff | `?date=YYYY-MM-DD&pointId=&window=60` → buckets + rows (masked) + `lastEventId` | — |
| GET | `/v1/weddings/:wid/arrivals/missing` | owner, co_host, planner_member, desk_staff | Overdue list; `contact` present only for host roles | — |
| POST | `/v1/weddings/:wid/arrivals/status` | owner, co_host, planner_member, desk_staff | Record a status on a guest's behalf (`source='host'|'desk'`) | — |
| GET | `/v1/weddings/:wid/arrivals/roster` | owner, co_host, planner_member, desk_staff | Desk offline roster (all live guests, masked); `ETag`, `?since=<updatedAt>` delta | — |
| GET | `/v1/weddings/:wid/arrivals/search` | same | `?q=` (≥ 2 chars) trigram search over guest and party names → party groups with members | `ARR_QUERY_TOO_SHORT` |
| GET | `/v1/weddings/:wid/arrivals/parties/by-code/:code` | same | Resolve scanned QR → party + members + status | 404 `ARR_CODE_UNKNOWN` (also for codes of other weddings) |
| POST | `/v1/weddings/:wid/arrivals/check-ins` | same | Batch `{ops:[{clientOpId, guestIds[], method, occurredAt}]}` (≤ 50 ops) → per-op result | per-op `ARR_GUEST_NOT_IN_WEDDING`, `ARR_ALREADY_CHECKED_IN` (not an error: returns existing time) |
| POST | `/v1/weddings/:wid/arrivals/check-ins/undo` | owner, co_host, planner_member, desk_staff (own check-ins within 15 min; hosts any) | `{clientOpId, guestIds[]}` | `ARR_UNDO_NOT_ALLOWED` |
| GET | `/v1/weddings/:wid/realtime?channels=arrivals` | same roles | FND SSE endpoint; ARR registers the channel's ACL (team roles only) | — |
| POST | `/v1/weddings/:wid/arrivals/rebuild` | owner | Repair: rebuild `arrival_state` from TRV + logs (idempotent, async job) | — |
| POST | `/g/:token/status` (form) | guest (lite web) | Same as guest status, CSRF-protected form post | — |

Internal (module interface, not HTTP): `arrivals.handleInboundAction({weddingId, guestId, partyId, action, providerMessageId})` — called by MSG's webhook router; returns `{reply: 'arr_ack_landed' | 'arr_late_list' | null}` so MSG can send the session reply.

**Board**

```http
GET /v1/weddings/:wid/arrivals/board?date=2027-04-09&window=60
→ 200 {
  "lastEventId": "88231", "timezone": "Asia/Kolkata",
  "totals": { "expected": 612, "arrived": 344, "late": 21, "noDetails": 117 },
  "buckets": [ { "start": "2027-04-09T04:30:00Z", "pointId": "6a1…", "expected": 23, "landed": 9, "checkedIn": 11, "late": 2 } ],
  "rows": [ ["g:c1…","p:7d…","Asha Sharma","Sharma family","6a1…","2027-04-09T05:10:00Z","2027-04-09T05:55:00Z","running_late",45,"delayed",null,true] ],
  "rowFields": ["guestId","partyId","name","partyLabel","pointId","expectedAt","etaAt","status","lateBy","flightFlag","checkedInAt","needsPickup"] }
```

Rows are positional arrays (≈ 40 % smaller than objects on the wire). No phone field exists in this shape.

**Check-in (batch, offline replay)**

```http
POST /v1/weddings/:wid/arrivals/check-ins
{ "ops": [ { "clientOpId": "0f6e…", "guestIds": ["c1…","c2…"], "method": "qr", "occurredAt": "2027-04-09T07:02:11Z" } ] }
→ 200 { "results": [ { "clientOpId": "0f6e…", "ok": true,
          "guests": [ { "id": "c1…", "checkedInAt": "2027-04-09T07:02:11Z", "room": "214 · Hotel Lakend" },
                      { "id": "c2…", "checkedInAt": "2027-04-09T07:02:11Z", "room": "214 · Hotel Lakend" } ] } ] }
```

**Guest status**

```http
POST /v1/guest/arrivals/status
{ "status": "running_late", "lateByMinutes": 60, "clientOpId": "a2b…" }
→ 200 { "members": [ { "guestId": "c1…", "status": "running_late", "etaAt": "2027-04-09T06:10:00Z" } ] }
```

## 5. Jobs, events and realtime

| Kind | Name | Notes |
| --- | --- | --- |
| Subscribes | `travel.leg.changed` (TRV) | Upsert/clear `expected_at`, `point_id`, `needs_pickup` for the leg's guests; publish rows. |
| Subscribes | `travel.flight.updated` (TRV-05) | Set `eta_at`, `flight_flag`; publish. |
| Subscribes | `guests.party.updated` (GST: `is_outstation` changes) / guest deleted | Create "no details" rows / cascade. |
| Subscribes | `pickups.member.picked_up` (PCK-05) | `status='picked_up'`, `source='driver'`. |
| Emits | `arrivals.status.changed {weddingId, guestIds, status, etaAt, lateBy}` | PCK-04 consumes (late guests in a batch). |
| Emits | `arrivals.checked_in {weddingId, guestIds}` | PCK marks members done; OPS dashboard counts. |
| Realtime | channel `arrivals`, kind `arrival.updated`, payload `{rows:[…≤40]}` | Published inside the writing transaction via `rt_publish`. Party check-in of 12 → one event; flight update for 90 guests → 3 events. ACL: team roles of the wedding (guests never subscribe). |
| Realtime | kind `arrival.reset` | Sent by ARR after `rebuild`, and by FND when `Last-Event-ID` is older than retention → client refetches the board. |
| pg-boss (`default`) | `arrivals.rebuild {weddingId}` | singletonKey = weddingId. |
| pg-boss cron (`messaging` via MSG) | `arrivals.travel-day-ping` hourly | For guests whose arrival is in the next 3–4 h and who haven't reported: `messaging.sendToGuests({kind:'travel_reminder', templateKey:'travel_day_status', buttons: Landed / Running late / At hotel, idempotencyKey:'arr-ping:'+guestId+':'+date})`. Off by default; host toggles in wedding settings. |

SSE plumbing (FND, verified here): Nginx `proxy_buffering off; proxy_read_timeout 3600s` on `/v1/weddings/*/realtime`; heartbeat comment every 20 s; PM2 cluster instances each hold one `LISTEN mehfil_rt` connection.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | Status buttons on guest home / `TravelHome` (GH-03) | Three big buttons: "I've landed", "Running late", "At the hotel"; late opens a sheet with 30 min / 1 h / 2 h / 3 h+. Optimistic update; queued with `clientOpId` if offline. |
| Guest | `MyQrScreen` (GH-07) | Renders `checkin_code` QR full-screen at max brightness; cached in MMKV so it works offline. |
| Host | `ArrivalsBoard` | Date tabs; totals strip; per-point columns with hour windows (expected / landed / checked-in / late chips); tap a bucket → guest list. Live via `useRealtime('arrivals')`. Tablet: two-pane. |
| Host | `StillMissing` | Sorted by most overdue; last status + time ago; call / WhatsApp buttons (host roles only; hidden for desk_staff because `contact` is absent). |
| Desk (Host mode, desk_staff) | `DeskHome` | Big search field + "Scan QR" button; sync badge (pending ops count, last sync). |
| Desk | `DeskSearch` | Local fuzzy search over roster (normalised, diacritics-insensitive, token prefix + trigram scoring in JS); results grouped by party. |
| Desk | `QrScan` | vision-camera code scanner; on hit → `PartyCheckInSheet`. Torch toggle; fallback "Type code". |
| Desk | `PartyCheckInSheet` | Member checkboxes (not-yet-arrived pre-selected), "Check in 3 of 5"; shows room (from ROM-03) after check-in; undo for 15 min. |

Realtime client: `useRealtime(channel)` wraps `react-native-sse` (XHR-based EventSource with `Authorization` header), reconnects with backoff (1, 2, 5, 10 s) and `Last-Event-ID`; disconnects in background (AppState) and resumes on foreground; applies rows into the TanStack Query cache via `queryClient.setQueryData(['wedding',wid,'arrivals','board',date], …)`.

Query keys: `['wedding',wid,'arrivals','board',date]`, `['wedding',wid,'arrivals','missing']`, `['wedding',wid,'arrivals','roster']` (persisted to MMKV, encrypted with a key from Keychain), `['guest','arrivals','status']`.

Offline desk: check-ins write to an MMKV op queue and update the local roster immediately; a sync loop POSTs batches when online; server results reconcile (e.g. someone else checked them in earlier → keep the earlier time). Roster and queue are wiped on sign-out, role removal (401/404 on refresh) and 2 days after the wedding ends.

Performance (budget Android, 2 GB RAM): board list is FlashList; bucket grid is memoised per point; delta application is O(changed rows) via a `Map<guestId,row>`; the 2,000-row roster is ~250 KB in MMKV and searched in < 30 ms.

Accessibility: status chips use icon + text + colour; high-contrast palette for outdoor desks; large-text mode on the check-in sheet; haptic + sound on successful scan.

## 7. Guest lite web

**Applicable.** `/g/:token` shows the three status buttons (plain HTML forms posting to `/g/:token/status`, late options as a second small form) and the party QR as an inline SVG generated server-side (so guests without the app can still be scanned). Session and CSRF as in ACC. No board, no realtime.

## 8. Security and privacy

- **Permissions:** `arrivals.board.read`, `arrivals.checkin`, `arrivals.status.write` → owner, co_host, planner_member, desk_staff. `arrivals.contact.read` (phones in "still missing") → owner, co_host, planner_member only. `arrivals.rebuild` → owner.
- **Desk staff never see phone numbers:** no ARR serializer for team routes includes a phone; the only phone-bearing field (`contact` in `missing`) is added by a separate serializer gated on `can(role,'arrivals.contact.read')`. Realtime payloads never contain phones (channel is shared). ROL-02 table test asserts a phone regex never matches any desk_staff response body across ARR routes and SSE frames.
- **Tenant isolation:** QR code lookup filters by `wedding_id` from the route; codes from another wedding → 404. Guests can only write status for their own party.
- **Minimisation:** board shows name, party label, point and times only; no origin city, flight number or ticket for desk staff (host roles see flight number in the guest detail view, which is TRV's).
- **Audit:** check-in undo (`arrivals.checkin.undo`), host/desk status on behalf (`arrivals.status.override`), rebuild. Plain check-ins are in `check_in_events` (not duplicated into `audit_log`).
- **Rate limits:** guest status 20/h/party; QR lookup 120/min/user; search 60/min/user; roster 6/min/user.
- **Device data:** roster cache encrypted at rest (MMKV encryption key in Keychain/Keystore), wiped as described above.

## 9. Scale and performance

- **2,000 guests:** board snapshot = one index scan of ≤ 2,000 `arrival_state` rows + one grouped aggregate; positional rows ≈ 150 KB raw / ≈ 30 KB gzip. Measured 3 ms aggregate, 0.6 ms missing list at 36k guests in the DB.
- **Write bursts:** a 180-seat flight landing → ≤ 180 status writes over a few minutes; each is one row update + one `rt_publish` (two inserts). Trivial for Postgres.
- **Fan-out:** 50 live weddings × ~10 team viewers = 500 SSE connections across PM2 instances; each NOTIFY results in one `realtime_events` read per process, then in-memory fan-out. Event payload cap 4 KB (FND) → rows chunked at 40.
- **Board stays fast** because nothing on the hot path joins `guests`/`parties` at read time except the name/label (included in the row on write; renames republish).
- Target checked in OPS-01: 2,000-guest board, 20 viewers, 300 status updates/min → p95 update-to-screen < 2 s.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Status precedence; `eta_at` computation (flight vs late-by); overdue rule; roster search scoring (Hindi transliterations, "Sharma ji"); offline queue reconciliation. |
| API e2e | Guest status for own party only; WhatsApp action handler dedupes on `providerMessageId`; batch check-in idempotent on replay (same `clientOpId` twice → one event); partial party check-in; undo window; QR code of another wedding → 404; **desk_staff phone-free responses** on every route; `rt_publish` row present after each write (assert `realtime_events`). |
| Realtime | Supertest + EventSource client: subscribe, check in, receive `arrival.updated` < 1 s; reconnect with stale `Last-Event-ID` → `arrival.reset`. |
| Mobile | RNTL: board applies deltas; desk offline check-in → queue → sync; QR scanner mocked; SSE hook reconnect. |
| Device | Desk flow on a 2 GB Android tablet with Wi-Fi toggled off/on; QR scan in low light; board with 2,000 seeded guests scrolls at 60 fps. |
| Load (OPS-01) | k6 script: 300 status updates/min + 20 SSE subscribers on a 2,000-guest wedding. |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| ARR-05 Realtime infrastructure | [API] register `arrivals` channel + ACL on FND hub · [MOB] `useRealtime` hook (`react-native-sse`, backoff, AppState) · [OPS] Nginx SSE config check · [TEST] SSE e2e | 3 → **2** | Hub, NOTIFY and replay are FND's. Stays 3 if FND does not deliver the hub before S6. |
| ARR-01 Guest travel status | [DB] travel_status_updates, arrival_state · [API] guest status, host/desk status, inbound action handler · [JOB] travel-day ping (optional) · [MOB] status buttons + late sheet · [WEB] lite web forms · [TEST] | 3 → **5** | Three channels (app, lite web, WhatsApp incl. interactive "late by" list) and the read-model maintenance from TRV events. |
| ARR-02 Live arrivals board | [API] board snapshot + aggregate, event subscribers (TRV, PCK, GST) · [MOB] ArrivalsBoard (phone + tablet) · [TEST] | 5 → **5** | Unchanged. |
| ARR-03 Desk check-in | **Split:** **ARR-03a** search + party sheet + partial check-in + undo + roster (5) · **ARR-03b** QR scan (vision-camera, `checkin_code`) + offline queue/sync (3) | 5 → **8** (5 + 3) | Native camera + offline-first desk were implicit; they are the risky parts on budget devices. |
| ARR-04 "Still missing" | [API] missing list with role-gated contact · [MOB] StillMissing · [TEST] masking | 2 → **2** | Unchanged. |
| **Total** | | **18 → 22** | |

## 12. Dependencies and sequencing

1. FND realtime hub (`01-fnd.sql`: `realtime_events`, `rt_publish`, SSE endpoint with `Last-Event-ID`) — must land before ARR-02.
2. TRV-01 (`08-trv.sql`) and its `travel.leg.changed` event.
3. ROL-01/02: `desk_staff` role, `can()` matrix entries listed in §8.
4. MSG-01/05: webhook router decoding `arr.*` actions (already listed in `07-msg.sql` comments) and session interactive-list replies; template `travel_day_status`.
5. GH-07 (guest QR) displays `checkin_code` from `GET /v1/guest/checkin-code`; GH-03 hosts the status buttons.
6. Later consumers: PCK-04/05 (status and picked-up events), ROM-03 (room in check-in response via `rooms.getRoomForGuests()`; returns null until ROM ships).

Order inside S6: ARR-05 → TRV-01 → ARR-01 → ARR-02 → ARR-03a → ARR-04; ARR-03b can trail into S7.

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| S6 is over capacity with the revised points (see report) | Move ARR-03b and TRV-02/TRV-04 to S7; PO to pick what S7 drops. |
| Guests forget to tap anything | Desk check-in and driver pickup (PCK-05) also update status; travel-day ping is opt-in. |
| WhatsApp 24 h session closed when "Running late" is tapped late | MSG falls back to a template with the three late options as buttons (needs approval). |
| Desk staff want to call missing guests | **PO decision:** keep strict (no phones for desk) or add a "request a call" button that pings the host. Designed strict. |
| Unplanned walk-ins (local guests) | Desk can check in any guest of the wedding; row created on the fly under "No details". |

## 14. Deviations from the baseline

1. ARR adds a column to a core table: `parties.checkin_code` (ALTER, allowed). GH-07's design should consume it instead of inventing another QR payload.
2. ARR-05 scope moves to FND (the hub exists in `01-fnd.sql`); no change to the baseline itself.
