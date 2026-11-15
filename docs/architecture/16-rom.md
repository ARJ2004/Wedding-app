# E16 — Room allocation (ROM)

Status: design · Owner module: `apps/api/src/modules/rooms` · SQL: [`sql/16-rom.sql`](./sql/16-rom.sql)

## 1. Summary

The host imports the **room block** (hotels, room types, room numbers, capacity, dates) from Excel, **assigns parties to rooms** manually or by accepting an **auto-suggestion** (party size, side, seniors), with **conflict and over-capacity checks** enforced by the database. **Guests** see their hotel, room and check-in time; **desk staff** see room numbers at check-in. The host **exports a rooming list** in a hotel-friendly Excel format.

| Story | Sprint (plan) | Covered here |
| --- | --- | --- |
| ROM-01 Room inventory import | S10 | `.xlsx` parse → preview → commit, plus manual add |
| ROM-02 Assign parties to rooms | S11 | manual assign/move/swap, auto-suggest (§2.1), conflicts (§2.2) |
| ROM-03 Guest and desk view | S11 | guest `GET /v1/guest/room`, lite web card, room in desk check-in |
| ROM-04 Rooming list export | S10 | `exceljs` per-hotel sheets |

**Stack reinterpretation:** the host UI is native Host mode screens instead of a web console; uploads use the baseline presigned PUT flow (`media_objects`, kind `other`); the guest view lives in RN Guest mode and the guest lite web page. Note: the plan schedules ROM-04 (export) in S10 before ROM-02 (assign) in S11 — export of an empty list is useless, so build ROM-04 with or after ROM-02 (§12).

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Stay model | `room_assignments` with a `daterange` of nights `[check-in, check-out)`; guests in `room_assignment_guests` | One assignment per party | Cousins from two parties often share a room; one family may need two rooms; stays differ per party. |
| Double-booking | Two EXCLUDE constraints: room × overlapping stay; guest × overlapping stay (stay copied to the guest row via composite FK `ON UPDATE CASCADE`) | Service-level check | Race-free with two planners editing; verified in the schema test. Errors map to `409 ROM_ROOM_TAKEN` / `ROM_GUEST_ALREADY_ROOMED`. |
| Capacity | `capacity` (normal) is a warning (extra bed), `max_occupancy` is a hard limit in the service | DB trigger | Over-capacity is a judgement call ("kids can share"); max occupancy is the hotel's rule. |
| Suggestions | Written as `status='suggested'` rows grouped by `suggestion_run_id`; host accepts or discards the run (or edits rows) | Return a plan without saving | Saved suggestions take part in the same constraints, survive app restarts, and can be reviewed on two devices. |
| Algorithm | Greedy best-fit in priority order (§2.1) | ILP / constraint solver | Explainable, deterministic, < 100 ms for 700 parties × 400 rooms. |
| Import | Synchronous parse (≤ 3,000 rows) into `room_imports.rows` → preview → commit (upsert by hotel + room number) | pg-boss import job like GST | Inventory files are small and contain no personal data; sync keeps the flow one screen. |
| Unknown room numbers | Allowed placeholders `TBA-NN`, renamed later; export shows "TBA" | Require real numbers | Hotels often allot numbers only on the day. |
| Guest visibility | Wedding settings `rooms.visibleToGuests` (default off) and `rooms.showRoomNumber` (default off) | Always visible | Hosts finalise rooms late; showing half-done allocations causes calls. |

### 2.1 Auto-suggest (ROM-02)

Pure function `suggestRooms(parties, rooms, existing, settings)` in `modules/rooms/suggest.ts`.

**Parties to place:** live parties with `is_outstation = true` (or host-flagged "needs room"), not `travel_party_state.status = 'not_travelling'`, excluding parties whose every guest declined every event (if RSV data exists), minus guests already in a confirmed/suggested stay. `pax` = live guests not yet roomed. `stay` = `[min arrival date, max departure date)` from TRV legs of its members (arrival before 06:00 counts from the previous night only if `settings.rooms.earlyArrivalPreviousNight`), else the wedding default `[starts_on − 1, ends_on)`. `side` = bride/groom from `party_groups` system keys. `senior` = any member with `age_band='senior'`. `vip` = member of the `vip` system group.

**Order:** VIP first, then `pax` desc, then earliest stay start, then `party_id` (deterministic).

**For each party:**

1. Candidate rooms: `status='active'`, `block @> stay`, no overlap with existing or already-suggested stays.
2. **Single room fit:** rooms with `capacity ≥ pax`; else rooms with `max_occupancy ≥ pax` (flag `extra_bed`).
3. Score = hotel `side_hint` matches side (+4) · `accessible` and party has a senior (+3; non-senior parties get −1 on accessible rooms to keep them free) · same hotel as other parties of the same group already placed (+1) · waste = `capacity − pax` (lower is better). Pick the best score; ties → lowest room number.
4. **No single room fits:** split the party across rooms of **one hotel** with best-fit decreasing on remaining pax, preferring the same floor and adjacent numbers; seniors/children placed with an adult; flag `split`.
5. Nothing fits → add to "unplaced" with the reason (no free room in dates / too large).

Output: suggested assignments with flags and the unplaced list. Accept = update the run's rows to `confirmed`; discard = delete the run's rows.

### 2.2 Conflict and warning checks (any manual or accepted assignment)

| Check | Kind | Code |
| --- | --- | --- |
| Room already has an overlapping live stay | error (DB EXCLUDE) | `ROM_ROOM_TAKEN` |
| Guest already in another room on an overlapping night | error (DB EXCLUDE) | `ROM_GUEST_ALREADY_ROOMED` |
| Stay outside the room's block | error | `ROM_OUTSIDE_BLOCK` |
| Occupants > `max_occupancy` | error | `ROM_OVER_MAX_OCCUPANCY` |
| Occupants > `capacity` | warning | `ROM_EXTRA_BED` |
| Stay doesn't cover the guest's travel dates (arrives earlier / leaves later) | warning | `ROM_STAY_TRAVEL_MISMATCH` |
| Party split across hotels | warning | `ROM_PARTY_SPLIT_HOTELS` |
| Bride and groom sides in one room | info | `ROM_MIXED_SIDES` |

Warnings come back in `warnings[]` on 200 responses; the app shows them as chips.

## 3. Data model

DDL: [`sql/16-rom.sql`](./sql/16-rom.sql). **Schema check passed** (`scripts/check-schema.sh arch_rom 000-core.sql 16-rom.sql` → `OK: 22 tables`; also clean in the full-directory run). Verified on sample data (20 weddings, 12,000 rooms, 24,000 guests): overlapping room stay and overlapping guest stay both rejected by their EXCLUDE constraints; changing an assignment's `stay` cascades to its guest rows. Room-availability query for one wedding: 5 ms.

| Table | Purpose | Notes |
| --- | --- | --- |
| `hotels` | Hotels used by the wedding | Times for check-in/out, front desk number (business), `side_hint` for auto-suggest, optional link to a `venues` row. |
| `room_types` | Per hotel | default capacity / max occupancy, used to fill rooms on import. |
| `rooms` | Inventory | `block` daterange = nights held; `accessible`; `status='released'` when the host gives rooms back to the hotel (kept for history). `UNIQUE (hotel_id, room_number)`. |
| `room_assignments` | One stay in one room | `status` suggested/confirmed/cancelled; `source`; `suggestion_run_id`; `version` for `If-Match`. EXCLUDE on (room, stay). |
| `room_assignment_guests` | Occupants | stay copied via FK `(assignment_id, stay)` `ON UPDATE CASCADE`; EXCLUDE on (guest, stay). Cancelling an assignment deletes its occupants. |
| `room_imports` | Staged Excel import | rows + per-cell errors; committed or discarded; source file in `media_objects` (deleted 7 days after commit). |

`btree_gist` is created idempotently here as in `15-pck.sql` (see §14). Retention: all ROM rows are removed with the wedding; occupant rows are deleted with the guest (cascade) for PRV-02.

## 4. API

Team routes under `/v1/weddings/:wid/rooms/...`. **manage** = owner, co_host, planner_member. **desk** = desk_staff (read room numbers only).

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/template.xlsx` | manage | Import template | — |
| POST | `/imports` | manage | `{mediaId}` of an uploaded `.xlsx` → parse → `{importId, summary, errors[], previewRows[≤50]}` | `ROM_IMPORT_BAD_FILE`, `ROM_IMPORT_TOO_LARGE` |
| POST | `/imports/:id/commit` | manage | Upsert hotels/types/rooms; rows with errors skipped | `ROM_IMPORT_HAS_BLOCKING_ERRORS` (unless `skipErrors:true`), `ROM_ROOM_IN_USE` (shrinking a block under a live stay) |
| GET/POST/PATCH/DELETE | `/hotels[/:id]`, `/room-types[/:id]`, `/rooms[/:id]` | manage | Manual inventory edits (`DELETE room` = release if it has history) | `ROM_ROOM_IN_USE` |
| GET | `/inventory` | manage | Hotels → rooms with occupancy per night `?from=&to=&hotelId=&free=true` | — |
| GET | `/unassigned` | manage | Parties/guests needing rooms with computed stay and reason | — |
| POST | `/assignments` | manage | `{roomId, stay:{from,to}, guestIds[], note?}` → assignment + `warnings[]` | §2.2 errors |
| PATCH | `/assignments/:id` | manage | Change room/stay/occupants/note (`If-Match`) | §2.2 + `ROM_VERSION_CONFLICT` |
| POST | `/assignments/:id/cancel` | manage | Cancel (occupants freed) | — |
| POST | `/assignments/swap` | manage | Swap occupants of two assignments atomically (deferred-check by doing it in one transaction: cancel → insert) | — |
| POST | `/suggestions` | manage | Run auto-suggest `{hotelIds?, partyIds?}` → `{runId, suggested[], unplaced[]}` | `ROM_SUGGEST_IN_PROGRESS` (advisory lock) |
| POST | `/suggestions/:runId/accept` | manage | Confirm all (or `{assignmentIds}`) | — |
| DELETE | `/suggestions/:runId` | manage | Discard remaining suggested rows | — |
| POST | `/export` | manage | `{hotelIds?, includeContactPhone?:false}` → `{url, expiresAt}` | `ROM_EXPORT_PHONE_FORBIDDEN` (phone column only for owner/co_host) |
| GET | `/v1/guest/room` | guest | Own party's confirmed stays (respecting visibility settings) | — |
| (module) | `rooms.getRoomForGuests(weddingId, guestIds)` | ARR | Room label for desk roster / check-in response (desk gets `"214 · Hotel Lakend"`, nothing else) | — |

**Create assignment**

```http
POST /v1/weddings/:wid/rooms/assignments
{ "roomId": "r214…", "stay": { "from": "2027-04-09", "to": "2027-04-12" }, "guestIds": ["c1…","c2…","c3…"] }
→ 201 { "id": "a1…", "version": 1, "status": "confirmed", "room": { "id": "r214…", "number": "214", "hotel": "Hotel Lakend", "capacity": 2, "maxOccupancy": 3 },
        "stay": { "from": "2027-04-09", "to": "2027-04-12", "nights": 3 },
        "guests": [ { "id": "c1…", "name": "Asha Sharma" }, … ],
        "warnings": [ { "code": "ROM_EXTRA_BED", "message": "3 guests in a room for 2" } ] }
→ 409 { "error": { "code": "ROM_GUEST_ALREADY_ROOMED", "message": "Asha Sharma is already in 118 · Hotel Lakend on 10 Apr" } }
```

**Suggest**

```http
POST /v1/weddings/:wid/rooms/suggestions   {}
→ 201 { "runId": "s7…", "suggested": [ { "assignmentId": "a9…", "party": "Sharma family", "room": "214 · Hotel Lakend", "stay": {"from":"2027-04-09","to":"2027-04-12"}, "flags": ["extra_bed"] } ],
        "unplaced": [ { "partyId": "p4…", "party": "Iyer family", "pax": 7, "reason": "NO_ROOMS_FOR_DATES" } ],
        "stats": { "parties": 212, "placed": 205, "split": 4 } }
```

**Guest room**

```http
GET /v1/guest/room
→ 200 { "stays": [ { "hotel": { "name": "Hotel Lakend", "address": "…", "mapsUrl": "…", "frontDeskPhone": "+91…" },
          "roomNumber": "214", "checkIn": "2027-04-09T14:00:00+05:30", "checkOut": "2027-04-12T11:00:00+05:30",
          "guests": ["Asha Sharma", "Raj Sharma", "Dadi"] } ] }
```

## 5. Jobs, events and realtime

| Kind | Name | Notes |
| --- | --- | --- |
| Subscribes | `travel.leg.changed` | Recompute stay warnings for affected confirmed assignments (no automatic change); flagged in `/inventory` and `/unassigned`. |
| Subscribes | guest/party deleted (GST/PRV) | Cascades remove occupants; empty assignments are cancelled. |
| Emits | `rooms.assignment.changed {weddingId, guestIds}` | ARR republishes affected roster rows so desk devices get new room labels. |
| Realtime | channel `rooms`, kind `assignment.updated` (ids + version) | Two planners editing see each other's changes. |
| pg-boss | none required | Import, suggest and export are synchronous (bounded sizes). |

No guest messages in scope; hosts can announce "rooms are ready" via MSG-03 targeting.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Host | `RoomsHome` | Per hotel: rooms total / occupied / free per night; unassigned parties count; actions: Import, Auto-suggest, Export. |
| Host | `RoomImport` | Pick `.xlsx` (document picker) → upload queue → preview with row errors → Commit. Link to download template. |
| Host | `RoomGrid` | Rooms × nights strip (horizontal scroll, sticky room column); tap room → `RoomDetail`. Tablet-friendly. |
| Host | `RoomDetail` | Occupants, stay, note, warnings; "Add guests" (party picker), "Move to…" (free rooms for these dates), "Swap with…", cancel. |
| Host | `UnassignedParties` | List with computed stay and size → "Assign" opens free-room picker sorted by fit. |
| Host | `SuggestionReview` | Grouped by hotel; per row accept/reject; "Accept all"; unplaced list with reasons. |
| Guest | Room card on guest home (GH-03 placeholder) | Hotel name, address with map button, check-in time, room number (if shown), front desk call button. Cached offline. |
| Desk | (in ARR screens) | Room label shown on the party check-in sheet and search results. |

Query keys: `['wedding',wid,'rooms','inventory',range]`, `['wedding',wid,'rooms','unassigned']`, `['wedding',wid,'rooms','suggestions',runId]`, `['guest','room']`. Host editing is online-only; `If-Match` conflicts show "Someone else changed this room — reload".

Accessibility: grid cells have text labels ("214, occupied, Sharma family") for screen readers; large-text mode switches the grid to a list.

## 7. Guest lite web

**Applicable.** `/g/:token` shows the same room card (hotel, address/map link, check-in time, room number if enabled). Read-only.

## 8. Security and privacy

- **Permissions:** `rooms.manage`, `rooms.export` → owner, co_host, planner_member; `rooms.export.contact` (phone column) → owner, co_host; `rooms.desk.read` → desk_staff gets only room labels through ARR (no inventory, no occupant lists of other parties, no phones). Guests see only their own party's confirmed stays and only when settings allow.
- **Minimisation in the export:** names, adults/children counts, dates, arrival/departure time, notes; **no phones by default**; IDs are never included (IDV-03 handles ID exports separately). Phone column is opt-in per export and audit-logged.
- **Audit:** assignment create/update/cancel/swap (`room.assignment.*` with before/after), suggestion accept/discard, import commit, export (`room.export`, with `includeContactPhone`).
- **Retention:** import source files deleted 7 days after commit (`media_objects.delete_after`); exports 24 h; assignments live with the wedding.
- **Rate limits:** suggest 10/h/wedding; export 10/h/user; import 20/day/wedding.

## 9. Scale and performance

- 2,000 guests ≈ 700 parties; a big wedding blocks ≤ 400 rooms across 3–5 hotels for ≤ 5 nights → suggest runs in memory over ~700 × 400 checks (< 100 ms); one transaction inserts ≤ 700 assignments + 2,000 occupants (EXCLUDE GiST checks are per-row index probes).
- Inventory view: one query of rooms + live assignments for the wedding (measured 5 ms on 12,000 rooms / 8,000 stays across 20 weddings).
- Export: ≤ 2,000 rows, exceljs < 1 s.
- Nothing here is on a live-wedding hot path except `getRoomForGuests` (indexed by guest via the occupant PK/exclusion index) used by desk check-in.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Suggest fixtures: best fit, extra bed fallback, split within one hotel, seniors to accessible rooms, side preference, VIP first, determinism; stay derivation from travel (early arrival rule); import parser (merged cells, Hindi hotel names, date formats `09/04/2027`, `9-Apr`, Excel serial dates). |
| API e2e | Double booking → 409 from constraint (room and guest); concurrent assign of the same room from two requests → exactly one wins; `ROM_OUTSIDE_BLOCK`, `ROM_OVER_MAX_OCCUPANCY`; warnings returned; suggestion accept/discard; import preview/commit idempotent (re-commit = no changes); export parses back with expected columns; phone column forbidden for planner_member; desk_staff can't reach any `/rooms` route (404/403 per matrix) yet sees room labels in ARR check-in; guest sees nothing when `visibleToGuests=false`. |
| Mobile | RNTL: suggestion review accept/reject; RoomDetail warnings; conflict message on 409. |
| Device | RoomGrid scroll performance with 400 rooms × 5 nights on a budget Android tablet. |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| ROM-01 Room inventory import | [DB] hotels, room_types, rooms, room_imports · [API] template, parse, commit, manual CRUD · [MOB] RoomImport, RoomsHome · [TEST] parser fixtures | 3 → **3** | Unchanged. |
| ROM-02 Assign parties to rooms | **Split:** **ROM-02a** manual assign/move/swap + §2.2 checks + RoomGrid/RoomDetail/Unassigned (5) · **ROM-02b** auto-suggest + SuggestionReview (3) | 5 → **8** (5 + 3) | Native grid UI and the suggestion engine are each a few days; split lets 02a ship first for pilots. |
| ROM-03 Guest and desk view | [API] guest room, `getRoomForGuests` for ARR, settings flags · [MOB] guest room card · [WEB] lite card · [TEST] | 2 → **2** | Unchanged. |
| ROM-04 Rooming list export | [API] export (per-hotel sheets + summary) · [MOB] export + share sheet · [TEST] read-back | 2 → **2** | Unchanged; must follow ROM-02a. |
| **Total** | | **12 → 15** | |

## 12. Dependencies and sequencing

- GST-01/02 (parties, guests, groups, `is_outstation`) — the guest list import pattern is reused for UX consistency, not code.
- TRV-01 (stay dates from legs), RSV-01 (optional: skip fully declined parties).
- Media upload flow (CAM-01) for the `.xlsx`; FND realtime (channel `rooms`).
- ARR-03 for desk display (ARR calls `rooms.getRoomForGuests`; returns null until ROM ships).
- **Sequencing fix:** plan has ROM-04 in S10 and ROM-02 in S11. Recommended: S10 = ROM-01 + ROM-02a; S11 = ROM-02b + ROM-03 + ROM-04 (same total).

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| Hotels' rooming-list formats differ | Ship one clean format; collect 3 real hotel formats from pilots before S10 (VAL). |
| Guests change dates after rooms are confirmed | Warning chip + "Stay mismatch" filter; no auto-change. |
| Room numbers unknown until check-in day | `TBA-NN` placeholders, bulk rename on import re-commit. |
| **PO decision:** show room numbers to guests at all (security of single women / elderly) | Default off; host setting. |
| **PO decision:** may the rooming list include guest phones (hotels ask for them) | Designed opt-in, owner/co-host only, audit-logged. |

## 14. Deviations from the baseline

1. **New extension `btree_gist`** (also in `15-pck.sql`), required for the EXCLUDE constraints on (uuid, daterange). Propose adding it to `000-core.sql`.
2. None otherwise.
