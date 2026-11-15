# E15 — Pickup batching (PCK)

Status: design · Owner module: `apps/api/src/modules/pickups` · SQL: [`sql/15-pck.sql`](./sql/15-pck.sql)

## 1. Summary

Turns "needs pickup" arrivals into **vehicle runs**: guests landing at the same airport/station within a time window are grouped into batches that fit the vehicles the family hired. The coordinator manages **vehicles and drivers**, moves guests between batches, **notifies guests** on WhatsApp (driver, phone, vehicle number, pickup point), gets **alerts with a suggested move** when someone is late or a flight is delayed, and gives each driver a **no-login link** listing their pickups where they mark "picked up" (which updates the arrivals board).

| Story | Sprint (plan) | Covered here |
| --- | --- | --- |
| PCK-01 Auto-batch arrivals | S10 | deterministic batching algorithm (§2.1) |
| PCK-02 Vehicles, drivers, manual edits | S10 | CRUD + "Move to…" editing in Host mode |
| PCK-03 Notify guests | S10 | MSG `pickup_notice`, versioned so only changes re-notify |
| PCK-04 Reassign on delays | S10 | alerts + suggestions from ARR/TRV events |
| PCK-05 Driver link | S10 | server-rendered `/d/:token` page |

**Stack reinterpretation:** the coordinator UI is native Host mode screens (no web console); drag-and-drop becomes multi-select + "Move to…" (see §14); the driver page reuses the server-rendered guest-lite-web stack; guest alerts go through the MSG module; coordinator alerts are FCM pushes to host devices.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Algorithm | Deterministic sweep over ETA per point + first-fit-decreasing bin packing + smallest-free-vehicle assignment (§2.1) | Optimisation solver (OR-tools VRP) | Problem is small (≤ 1,500 pickups/wedding), coordinators must understand and predict the result, and reruns must be stable. FFD is within 11/9 of optimal seat usage. |
| What the planner may change | Only **unlocked draft** batches; any manual edit locks a batch; confirmed/dispatched/completed are never re-planned | Re-plan everything | Coordinators lose trust if a re-run undoes their phone calls. |
| Vehicle/driver double booking | Postgres `EXCLUDE USING gist (vehicle_id =, busy &&)` and same for driver (needs `btree_gist`) | Service-level check only | Two coordinators editing at once can't double-book a car; error maps to `409 PCK_VEHICLE_BUSY`. |
| Unit of batching | A **leg** (people travelling together) — never split unless larger than the biggest vehicle | Individual guests | Families stay together; splitting is explicit and flagged. |
| Time model | `depart_at = last ETA in batch + point.pickup_buffer_minutes`; vehicle busy until `depart_at + 2 × transfer_minutes` | Fixed slots | Matches how drivers actually work (wait for the last bag, drive, come back). |
| Delay handling | Alert + suggested move the coordinator applies with one tap | Automatic reassignment | A wrong automatic move strands a guest; the coordinator often knows something we don't. |
| Driver access | 128-bit link token (hash stored), expires day after the wedding, revocable; server-rendered page | Driver app / OTP login | Drivers use basic Android phones, change daily, and will not install an app. |
| Guest notifications | Explicit "Notify" by coordinator; per-batch `version` vs `notified_version` so only changed batches are sent | Auto-send on every edit | Avoids spamming guests during planning; idempotency key includes version. |

### 2.1 Batching algorithm (PCK-01)

Pure function `planPickups(input, params) → {batches, alerts, stats}` in `modules/pickups/planner.ts` (no I/O; unit-tested with fixtures). The service loads input, runs it under `pg_advisory_xact_lock(hash(wedding_id))`, deletes unlocked drafts in the range and inserts the result in one transaction.

**Parameters:** `windowMinutes` W (default 45, 15–120), date range `[from, to)` (default: the selected day in wedding timezone), optional `pointIds`, `defaultSeats` (used only when no vehicles exist; default 6).

**Input**

- *Units:* for every arrival leg with `needs_pickup = true` and a non-null `point_id`, the leg's guests who are not checked in, not picked up, not marked no-show, and not members of a kept batch (any batch that is locked or not `draft`). `unit.pax` = number of those guests; `unit.eta` = max over its guests of `arrival_state.eta_at` (falls back to `travel_legs.estimated_at`, then `scheduled_at`). Legs with flight status `cancelled` are skipped and reported. Units whose ETA is outside `[from, to)` are ignored.
- *Vehicles:* not deleted; `seats`; optional `available` range; their busy intervals from kept batches.
- *Points:* `pickup_buffer_minutes` B, `transfer_minutes` T.

**Steps**

0. **Top-up kept batches.** For each unit in ETA order: if a kept batch at the same point is `confirmed`, **not locked**, has `window_start − 10 min ≤ eta ≤ window_end`, and has free seats ≥ pax (seats of its vehicle, or `defaultSeats` if none), add the unit to it (version + 1). Locked/dispatched batches are never touched.
1. **Group by point**; inside each point sort remaining units by `(eta asc, pax desc, party_id asc)` — the tie-breaks make the result deterministic.
2. **Sweep windows.** Take the first unassigned unit; its ETA is the anchor `a`. The window's candidates are all unassigned units with `eta ≤ a + W` (a contiguous run in the sorted list).
3. **Split oversize units.** `Cmax` = largest vehicle seat count (or `defaultSeats`). A unit with `pax > Cmax` is split into chunks of `Cmax` (members ordered seniors and children first so they stay in the first car); each chunk is flagged `split`.
4. **Bin-pack the window (first-fit decreasing).** Sort candidates by `(pax desc, eta asc)`. For each, place it in the first open bin with remaining capacity ≥ pax; otherwise open a new bin with capacity `Cmax`. Each bin becomes a draft batch.
5. **Time each batch.** `window_start = min eta`, `window_end = max eta`, `depart_at = window_end + B`, `return_by = depart_at + 2T`. Maximum wait for any guest = W + B.
6. **Repeat** steps 2–5 from the next unassigned unit until the point is empty, then the next point.
7. **Assign vehicles** across all new batches in `depart_at` order: candidate vehicles have `seats ≥ pax`, `available` (if set) covers `[depart_at, return_by)`, and no overlap with busy intervals (kept batches + batches already assigned in this run). Pick the smallest seats; ties → fewest runs assigned so far that day; then label. Driver = vehicle's `default_driver_id` if that driver is free over the same interval, else null. No candidate → `vehicle_id = null` and a `no_vehicle` alert for the batch.
8. **Stats:** units, guests, batches, split units, unassigned batches, mean/max wait; stored in `pickup_plan_runs`.

Complexity: O(n log n + b·v) — < 50 ms for 1,500 guests and 40 vehicles in Node.

Not batched (listed in the plan screen as "needs attention"): guests with no ETA, legs with `point_id` null ("coming directly"), cancelled flights, guests whose unit split could not fit any vehicle.

### 2.2 Delay suggestion rule (PCK-04)

On `arrivals.status.changed` or `travel.flight.updated` for guest g in an active batch β (`draft`/`confirmed`/`dispatched`, g not yet picked up), with new ETA e:

- **Trigger:** `e + B > β.depart_at` (would miss the car), or flight `cancelled`/`diverted`, or driver marks `no_show`.
- **Suggestion, first that applies:**
  1. **Hold the car** — if `e + B − β.depart_at ≤ 20 min`, β not dispatched, and β's vehicle/driver are free until `return_by + delay`: move β's `depart_at` later.
  2. **Move to an existing batch** γ at the same point with `γ.depart_at ≥ e + B`, `γ.depart_at − e ≤ W + B`, status draft/confirmed, free seats ≥ g's unit size; choose the earliest γ.
  3. **New batch** at `depart_at = e + B` with the smallest free vehicle (or none → "book a cab").
- Alerts are deduped per (batch, guest, reason) while open; a newer delay for the same guest supersedes the open one.

## 3. Data model

DDL: [`sql/15-pck.sql`](./sql/15-pck.sql). **Schema check passed** (`scripts/check-schema.sh arch_pck 000-core.sql 08-trv.sql 09-arr.sql 15-pck.sql` → `OK: 32 tables`; also clean in the full-directory run). Verified: back-to-back runs (`[)` ranges) are accepted; an overlapping run for the same vehicle fails with `pickup_batches_vehicle_overlap`.

| Table | Purpose | Notes |
| --- | --- | --- |
| `drivers` | Driver name, phone, language, vendor | Soft delete (keeps history on past batches). Personal data of vendor staff, purged 30 days after the wedding. |
| `vehicles` | Label, type, passenger seats, registration, default driver, hire window | `UNIQUE (wedding_id, label)`. |
| `pickup_plan_runs` | Parameters + stats of each planner run | Explains "why am I in this car?". |
| `pickup_batches` | One run of one vehicle from one point | `busy` = generated `tstzrange(depart_at, return_by)`; two EXCLUDE constraints (vehicle, driver) ignore cancelled batches. `locked` set by any manual edit. `version`/`notified_version` drive PCK-03. |
| `pickup_batch_members` | Guests in a batch | `UNIQUE (wedding_id, guest_id)`: a guest is in at most one arrival pickup. `picked_up_at`/`no_show_at` written by the driver page or host. |
| `pickup_alerts` | Delay / no-show / no-vehicle alerts and suggestion | One open alert per (batch, guest, reason). |
| `driver_links` | Hashed driver link tokens | One active link per driver. |

`btree_gist` is created in this file (`CREATE EXTENSION IF NOT EXISTS`); see §14.

## 4. API

Team routes under `/v1/weddings/:wid/pickups/...`. Roles: owner, co_host, planner_member = **manage**; desk_staff = **read** (batch list without phones).

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET/POST/PATCH/DELETE | `/vehicles[/:id]` | manage | Vehicle CRUD (delete = soft; refused if in a non-cancelled future batch) | `PCK_VEHICLE_IN_USE`, `PCK_LABEL_TAKEN` |
| GET/POST/PATCH/DELETE | `/drivers[/:id]` | manage | Driver CRUD | `PCK_DRIVER_IN_USE` |
| POST | `/plan` | manage | Run planner `{from,to,windowMinutes,pointIds?}` → new drafts + stats | `PCK_PLAN_IN_PROGRESS` (409, advisory lock busy) |
| GET | `/batches` | manage, desk (masked) | `?date=&pointId=&status=` batches with members, vehicle, driver, alerts count | — |
| GET | `/unbatched` | manage | Needs-pickup guests not in a batch, with reason | — |
| PATCH | `/batches/:id` | manage | Change vehicle/driver/depart_at/status (`If-Match` version); sets `locked` | `PCK_VEHICLE_BUSY` (409, from EXCLUDE), `PCK_DRIVER_BUSY`, `PCK_OVER_CAPACITY` (422, overridable with `force:true`), `PCK_VERSION_CONFLICT` |
| POST | `/batches` | manage | Create empty manual batch | as above |
| POST | `/moves` | manage | `{guestIds[], toBatchId \| newBatch:{pointId,departAt}}` — moves members, locks both batches, bumps versions | `PCK_OVER_CAPACITY`, `PCK_POINT_MISMATCH` (warning unless forced) |
| POST | `/batches/:id/cancel` | manage | Cancel; members return to unbatched | — |
| POST | `/notify` | manage | `{batchIds?}` (default: all confirmed with `version > notified_version`); `Idempotency-Key` | `MSG_QUOTA_EXCEEDED` |
| GET | `/alerts` | manage | Open alerts with suggestions | — |
| POST | `/alerts/:id/apply` | manage | Apply suggestion (hold / move / new batch) atomically; returns changed batches | `PCK_SUGGESTION_STALE` (409: state changed; recompute) |
| POST | `/alerts/:id/dismiss` | manage | Dismiss | — |
| POST | `/drivers/:id/link` | manage | Create/rotate driver link → `{url}` (shown once) | — |
| DELETE | `/drivers/:id/link` | manage | Revoke | — |
| GET | `/d/:token` | driver (no login) | Server-rendered list of this driver's runs (now − 6 h … + 24 h) | 404 page if token unknown/expired/revoked |
| POST | `/d/:token/members/:guestId` | driver | Form: `picked_up` / `no_show` / `undo` | — |
| POST | `/d/:token/batches/:batchId` | driver | Form: `started` (→ dispatched) / `completed` | — |
| GET | `/v1/guest/pickup` | guest | Own party's pickup: time, point, vehicle reg, driver name + phone | — |

**Plan**

```http
POST /v1/weddings/:wid/pickups/plan
{ "from": "2027-04-09T00:00:00+05:30", "to": "2027-04-10T00:00:00+05:30", "windowMinutes": 45 }
→ 201 { "runId": "r1…", "stats": { "units": 214, "guests": 498, "batches": 81, "split": 3, "noVehicle": 4, "maxWaitMinutes": 75 },
        "batches": [ { "id": "b1…", "point": "UDR", "departAt": "2027-04-09T05:40:00Z", "pax": 6,
                       "vehicle": { "id": "v3…", "label": "Innova 3", "seats": 6 }, "driver": { "id": "d2…", "name": "Ramesh" },
                       "members": [ { "guestId": "c1…", "name": "Asha Sharma", "etaAt": "2027-04-09T05:10:00Z" } ], "locked": false } ] }
```

**Apply alert**

```http
POST /v1/weddings/:wid/pickups/alerts/al9…/apply
→ 200 { "kind": "move", "changed": [ { "id": "b1…", "version": 4 }, { "id": "b7…", "version": 2 } ], "notifyPending": 2 }
```

**Driver page** (`GET /d/:token`, HTML, ~10 KB): per run — point, depart time, vehicle, list of guests with party label and one tap-to-call number per party, big "Picked up" / "No show" buttons, "Started" / "Completed". Works without JS (plain forms); a 6-line inline script adds `fetch` + optimistic toggles when available. Refresh every 60 s via `<meta http-equiv="refresh">` only while a run is active.

## 5. Jobs, events and realtime

| Kind | Name | Notes |
| --- | --- | --- |
| Subscribes | `travel.leg.changed` | Leg deleted / point changed / `needs_pickup` false → remove member from draft batch, alert on confirmed ones. |
| Subscribes | `arrivals.status.changed`, `travel.flight.updated` | Run §2.2; insert alert; push to coordinators. |
| Subscribes | `arrivals.checked_in` | Mark members of not-yet-completed batches as done (`picked_up_source='desk'` if not picked up — they arrived on their own). |
| Emits | `pickups.member.picked_up {weddingId, guestIds, batchId}` | ARR sets `status='picked_up'` (board updates live). |
| Realtime | channel `pickups`, kinds `batch.updated`, `alert.created` (payload: ids + version only) | Coordinator screens refetch the touched batch. ACL: manage roles. |
| Push | `notifications.pushToUsers(manageRoleUserIds, {title:'Pickup alert', body:'Sharma family (3) delayed 50 min — suggested: move to Innova 5 at 11:40'})` | Via MSG/push module interface. |
| Via MSG | `messaging.sendToGuests({kind:'pickup_notice', templateKey:'pickup_assigned', guestIds:[members with phones; party primary otherwise], params:{driver_name, driver_phone, vehicle_label, vehicle_reg, point_name, depart_time}, idempotencyKey:'pck:'+batchId+':'+guestId+':v'+version, createdByModule:'pck'})` | After success sets `notified_version = version`. |
| pg-boss cron | `pickups.no-vehicle-check` every 15 min on wedding days | Re-alerts unassigned batches departing within 2 h. |

## 6. Mobile app

Host mode only (guests see their pickup on guest home via `GET /v1/guest/pickup`).

| Screen | Notes |
| --- | --- |
| `PickupsHome` | Day tabs; summary (batches, guests, unassigned, open alerts); "Plan this day" button (window slider 15–120 min, default 45) → result preview → "Keep". |
| `PickupTimeline` | Per point, batch cards in depart order: time, vehicle chip, driver chip, pax/seats bar, status, lock icon, notify badge (changed since notified). |
| `BatchDetail` | Members (multi-select) → "Move to…" sheet (lists compatible batches with seats left + "New batch"); change vehicle/driver (busy ones greyed with reason); confirm; cancel. |
| `PickupAlerts` | Alert cards with the suggestion and "Apply" / "Dismiss". Deep link from push: `mehfil://host/w/:wid/pickups/alerts/:id`. |
| `Vehicles`, `Drivers` | Simple lists + forms; "Share driver link" → share sheet (WhatsApp). |
| `Notify` | Shows count of guests to notify and template preview → send. |

Query keys: `['wedding',wid,'pickups','batches',date]`, `['wedding',wid,'pickups','alerts']`, `['wedding',wid,'pickups','vehicles']`, `['wedding',wid,'pickups','drivers']`. `useRealtime('pickups')` invalidates touched keys. Offline: read-only cached view; edits need network (conflict-prone).

Accessibility/performance: cards are plain views in a FlashList (≤ 100 batches/day); large-text mode stacks chips vertically.

## 7. Guest lite web

**Applicable in two ways.** (1) The **driver page** `/d/:token` is built on the lite web stack. (2) The guest lite page `/g/:token` shows "Your pickup" (time, point, vehicle, driver and tap-to-call) once notified.

## 8. Security and privacy

- **Permissions:** `pickups.manage` → owner, co_host, planner_member; `pickups.read` → desk_staff (no driver or guest phones in the desk variant). Guests see only their own party's pickup and their driver's name/phone/vehicle.
- **Driver link:** 128-bit random token, sha256 stored, `expires_at` = end of `ends_on + 1 day` (IST), revocable, rate-limited (60 req/min/token), `Referrer-Policy: no-referrer`, `noindex`. It shows guest names, party labels and one contact phone per party **only for runs within now − 6 h … now + 24 h**. Every driver action is written to `audit_log` with `actor_type='system'`, `action='pickups.driver.<action>'`, driver id in `after`.
- **Disclosure:** the privacy notice (PRV-01) must say that name and phone are shared with the assigned driver, and the driver's name/phone with the guest.
- **Retention:** drivers, vehicles, batches, alerts, links purged 30 days after the wedding (PRV-03 hook `pickups.purgeWedding`).
- **Audit:** manual moves, vehicle/driver changes on confirmed batches, alert apply/dismiss, link create/revoke, notify.

## 9. Scale and performance

- Worst realistic wedding: 1,500 needs-pickup guests over 2 days, 40 vehicles → planner < 50 ms; insert ~300 rows in one transaction.
- EXCLUDE constraints use GiST on (uuid, tstzrange) per wedding-sized sets — negligible cost.
- Delay storm (fog in Delhi, 30 flights late): ~600 events → each runs §2.2 against ≤ 100 batches in memory; alerts deduped; pushes coalesced per coordinator to one every 2 min with a count.
- Notify: 500 guests → one MSG call; MSG fan-out SLA applies.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit (planner) | Fixture tables: single point, multiple points, window edge (eta = a + W included, a + W + 1 min excluded), oversize party split, no vehicles (`defaultSeats`), vehicle availability windows, back-to-back reuse of a car after `return_by`, determinism (same input → identical output), top-up of confirmed unlocked batch, locked batches untouched. Property test: every unit assigned exactly once; no bin over capacity; no vehicle overlap. |
| Unit (suggestions) | Hold vs move vs new batch boundaries; cancelled flight; superseding alerts. |
| API e2e | Plan replaces only unlocked drafts; concurrent plan → 409; `PATCH` vehicle overlap → `PCK_VEHICLE_BUSY` from the constraint; move locks both; notify idempotent per version (LogSink shows one message per guest per version); driver link expiry/revocation; driver marks picked up → `arrival_state.status='picked_up'`; desk_staff sees no phones; guests see only own pickup. |
| Mobile | RNTL: Move sheet capacity hints; alert apply flow; push deep link. |
| Device | Driver page on a ₹6,000 Android with Chrome Lite / 2G throttling; works with JS disabled. |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| PCK-01 Auto-batch arrivals | [DB] batches, members, plan runs, btree_gist · [API] plan, unbatched · [MOB] PickupsHome plan flow, PickupTimeline · [TEST] planner fixtures + property test | 5 → **5** | Unchanged; algorithm is pure and well-specified. |
| PCK-02 Vehicles, drivers, manual edits | [DB] vehicles, drivers, EXCLUDE · [API] CRUD, PATCH batch, moves, cancel · [MOB] BatchDetail + Move sheet, Vehicles, Drivers · [TEST] | 5 → **5** | Unchanged with "Move to…" instead of drag-and-drop (+3 if PO insists on DnD). |
| PCK-03 Notify guests | [API] notify (versioned, idempotent) · [MOB] Notify screen · [WEB] "Your pickup" on lite page · [OPS] `pickup_assigned` template approval | 2 → **2** | Unchanged. |
| PCK-04 Reassign on delays | [DB] alerts · [JOB] event subscribers, no-vehicle cron · [API] alerts list/apply/dismiss · [MOB] PickupAlerts + push deep link · [TEST] | 3 → **5** | Suggestion engine + atomic apply + coordinator push. Flight-delay trigger only works once TRV-05 ships (S13); guest "running late" works from S10. |
| PCK-05 Driver link | [DB] driver_links · [WEB] `/d/:token` page + forms · [API] link create/revoke · [TEST] | 3 → **3** | Unchanged. |
| **Total** | | **18 → 20** | |

## 12. Dependencies and sequencing

- TRV-01/03 (`travel_legs`, `travel_points` with buffer/transfer minutes) and ARR-01/02 (`arrival_state.eta_at`, `arrivals.status.changed`, `arrivals.checked_in`).
- MSG-03/05 (`sendToGuests`, `pickup_notice` kind already in `07-msg.sql`); push to host users (MSG/FND push module).
- FND realtime hub (channel `pickups`).
- TRV-05 for flight-delay alerts (S13) — PCK-04 ships without it and lights up when TRV-05 lands.
- Order in S10: PCK-02 (vehicles/drivers) data → PCK-01 planner → PCK-05 → PCK-03 → PCK-04.

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| Coordinators want departure (drop-to-airport) batching too | Same planner with direction parameter; not in scope — **PO decision** whether to add as a P1 story (~3 pts). |
| Hired cars by the trip, not by the day | `available` range on vehicles covers hire windows; per-trip vendors modelled as many vehicles. |
| Driver forwards the link | Link shows only ±24 h runs and expires after the wedding; host can rotate. |
| Seats vs luggage (6 seats, 6 suitcases don't fit) | `seats` is passenger seats as entered; tip in UI to enter realistic seats; luggage capacity is a later field. |
| Drag-and-drop expectation from backlog AC | **PO decision**: accept "Move to…" (budget Android friendly, accessible) or fund DnD on tablets (+3). |

## 14. Deviations from the baseline

1. **New extension `btree_gist`** (created idempotently here and in `16-rom.sql`). Needed for EXCLUDE constraints combining uuid equality with range overlap. It ships with Postgres contrib (available on RDS too). Propose adding it to `000-core.sql`'s extension list.
2. **New server-rendered surface `/d/:token`** (driver page) alongside the baseline's `/g/:token` guest lite web; same rendering stack, separate token table and rate limits.
3. Backlog AC "drag-and-drop" replaced by multi-select + "Move to…" (product deviation, not baseline).
