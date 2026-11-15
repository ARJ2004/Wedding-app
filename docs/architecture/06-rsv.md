# E06 — RSVP (RSV)

## 1. Summary

Each guest answers **per event**: Attending, Not attending or Maybe. One person can answer for the whole party. **Plus-ones** are added within the host's limit, and **dietary needs** are recorded per person. Guests answer in the **RN app**, on the **guest lite web page**, or with **one tap in WhatsApp**. Hosts see a **live headcount** per event (by side and by diet) that updates within 5 s. They can **chase non-responders** with one click and **record RSVPs on a guest's behalf**, with an audit trail.

| | |
| --- | --- |
| Stories | RSV-01 per-event RSVP (split 01a app+API / 01b lite web) · RSV-02 one-tap WhatsApp · RSV-03 live headcount · RSV-04 chase · RSV-05 host on behalf |
| Phase / sprint | MVP: S4 (01a, 03), S5 (02), S7 (01b with the lite web, 04), S9 (05, P0\*) |
| Module | `apps/api/src/modules/rsvp` · app `apps/mobile/src/features/rsvp` |
| Not in this epic | Inbound webhook parsing and reply routing (MSG-11), message sending and templates (MSG), who is invited to what (SET `party_invited_events`), creating guest rows (GST `addPlusOne`), the SSE hub (FND-14) |

**How the stories change on this stack.** "Web RSVP" in RSV-01 becomes the RN Guest-mode RSVP screen plus a server-rendered form at `/g/:token/rsvp`. The "live" headcount uses FND's `rt_publish` → SSE, not Redis. The host views are RN Host-mode screens, not a web console.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Granularity | One `rsvps` row per (event, guest); no row = pending | Party-level answer with counts | Headcount by side and diet needs people. Partial attendance ("Dad skips Haldi") is common. |
| Who is invited | SET's `party_invited_events` view × live guests | Our own invite table; RSV's own view | One source of truth (SET-04); nothing to keep in sync |
| Plus-ones | **Real guest rows** (`is_plus_one`) created through GST `addPlusOne(partyId, name?)` (default name "Guest of {primary}"), limited by `parties.plus_ones_allowed` | Anonymous count per party per event | Every headcount, diet, check-in and travel query stays "one row per person". The desk can check in a plus-one. |
| Diet | Per person (`guest_dietary`), not per event | Per RSVP row | People don't change diet between events. Smaller table. |
| Concurrency | Last write wins **except** a guest write never overwrites a newer host override (skipped and reported) | Optimistic versions (`If-Match`) | Offline app writes replay late from the APP-04 outbox. Families answer twice from two phones, and that should just work. |
| Headcount | Aggregate SQL on read (70–80 ms for 2,100 guests × 6 events) **plus realtime deltas** via `rt_publish('headcount', …)` that clients apply to their cached numbers; `headcount.stale` → refetch | Counter table; recompute and broadcast on every write | Counters drift and contend under an invite-wave burst. Recomputing 50 weddings × every write costs real CPU. Deltas are computed from data the writer already has. |
| WhatsApp one-tap scope | The answer applies to the **responder and every party member who has not answered**, for the events in the message context that are open | Responder only; overwrite everyone | The household head usually answers for the family, and nobody's explicit answer is clobbered (§13 Q1). |
| Chase "after N days" | RSV computes pending parties; MSG supplies `firstSentAt(kind='invite')` per party | RSV tracking invite sends | MSG owns send history. |
| RSVP close | `events.rsvp_closes_at` (guests blocked, hosts allowed) and `rsvp_enabled` | Wedding-wide deadline only | Caterers want different cut-offs per event. |

## 3. Data model

DDL: [`sql/06-rsv.sql`](./sql/06-rsv.sql). **Schema check passed**: `scripts/check-schema.sh arch_rsv 000-core.sql 03-set.sql 05-acc.sql 06-rsv.sql` → `OK: 24 tables`. The chain through 14-prv → `OK: 58 tables`.

**EXPLAIN** on 50 weddings × 700 parties × 3 guests (105k guests, 322k RSVPs):
- Headcount for one wedding (invited × status × side × diet) uses `rsvps_headcount_idx`, `guest_dietary_wedding_idx`, `party_groups_group_idx` (SET) and `guests_wedding_phone_idx` (core): **70–80 ms**. The query must filter `guests.wedding_id` as well as `party_invited_events.wedding_id`; without that filter it seq-scans all guests (240 ms).
- Party RSVP read (guest home and RSVP screen): `rsvps_event_id_guest_id_key` + `guests_party_idx`, **0.3 ms**.

Scratch DBs dropped.

| Table / change | Purpose | Notes |
| --- | --- | --- |
| `events` + `rsvp_enabled`, `rsvp_closes_at` | RSVP window per event | Edited in SET's event form; SET writes, RSV reads |
| `rsvps` | Answer per (event, guest) | `source` app / lite_web / whatsapp / host / import; `responded_by_guest_id` (shared phone) or `responded_by_user_id` (host); `responded_at` = first answer; CHECK host rows carry a user |
| `guest_dietary` | Diet enum, allergy set, free-text note (≤ 280) | Allergies are health-adjacent: deleted at wedding end + 30 days (PRV-03 participant) |
| `rsvp_chase_runs` | Each chase: events, N days, party snapshot, MSG `message_id`, idempotency key | "Last chased" in the host list; idempotency on `(wedding_id, idempotency_key)` |
| History | `audit_log` (`rsvp.set`, `rsvp.set_whatsapp`, `rsvp.override`, `rsvp.diet_set`) with before/after | No separate history table |

**Headcount query** (service `headcount.ts`, Prisma `$queryRaw` / TypedSQL):
```sql
WITH inv AS (SELECT pie.event_id, g.party_id, g.id AS guest_id
             FROM party_invited_events pie
             JOIN guests g ON g.party_id = pie.party_id AND g.deleted_at IS NULL
             WHERE pie.wedding_id = $1 AND g.wedding_id = $1),
     r    AS (SELECT event_id, guest_id, status FROM rsvps WHERE wedding_id = $1),
     side AS (SELECT pg.party_id, min(gg.system_key) AS key FROM guest_groups gg
              JOIN party_groups pg ON pg.group_id = gg.id
              WHERE gg.wedding_id = $1 AND gg.system_key IN ('bride_side','groom_side') GROUP BY pg.party_id),
     d    AS (SELECT guest_id, diet FROM guest_dietary WHERE wedding_id = $1)
SELECT inv.event_id, coalesce(r.status,'pending') AS status, side.key AS side, coalesce(d.diet,'unknown') AS diet, count(*)
FROM inv LEFT JOIN r USING (event_id, guest_id) LEFT JOIN side USING (party_id) LEFT JOIN d USING (guest_id)
GROUP BY 1,2,3,4;
```
It runs in a `REPEATABLE READ` transaction together with `SELECT max(id) FROM realtime_events WHERE wedding_id=$1 AND channel='headcount'`, so the response carries an `rtCursor` that clients use to apply only newer deltas.

## 4. API

Error codes are prefixed `RSV_`. Guest routes need `authGuest` + `requireConsent('core')` (ACC). Host routes use `requireWeddingRole`; ROL adds the actions `rsvp.read`, `rsvp.headcount`, `rsvp.write_on_behalf`, `rsvp.chase`.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/guest/rsvp` | guest | Invited events × party members with status; plus-one allowance; diets | — |
| PUT | `/v1/guest/rsvp` | guest | Set answers and diets for any members of my party (batch). Returns the new state plus `skipped[]` | 404 `RSV_EVENT_NOT_INVITED`, 404 `RSV_GUEST_NOT_IN_PARTY`, 409 `RSV_CLOSED`, 409 `RSV_DISABLED` |
| POST | `/v1/guest/rsvp/plus-ones` | guest | Add a plus-one `{ name? }` (GST `addPlusOne`) | 409 `RSV_PLUS_ONE_LIMIT` |
| PATCH / DELETE | `/v1/guest/rsvp/plus-ones/:guestId` | guest | Rename or remove my party's plus-one (removes its RSVPs) | 404 if not a plus-one of my party |
| GET | `/v1/weddings/:wid/rsvp/headcount` | owner, co_host, planner_member (full); desk_staff (totals only) | Per event: invited / attending / declined / maybe / pending, by side, by diet and allergy (attending + maybe), adults/children; `rtCursor` | 404 |
| SSE | `/v1/weddings/:wid/stream?channels=headcount` | same roles (FND-14) | `headcount.delta`, `headcount.stale` | 403 `RT_CHANNEL_FORBIDDEN` |
| GET | `/v1/weddings/:wid/rsvps?eventId=&status=&groupId=&side=&diet=&q=&cursor=` | owner, co_host, planner_member | Guest rows with status (pending included), source, responded at, diet; cursor on (party label, guest id) | 404 |
| PUT | `/v1/weddings/:wid/parties/:pid/rsvp` | owner, co_host, planner_member | RSV-05: same body as the guest PUT + `note`; ignores `rsvp_closes_at`; audited `rsvp.override` | 404, 404 `RSV_EVENT_NOT_INVITED` |
| GET | `/v1/weddings/:wid/rsvp/non-responders?eventIds=&noReplyDays=` | owner, co_host, planner_member | Pending parties invited ≥ N days ago: label, pending members, invited at, last chased | 404 |
| POST | `/v1/weddings/:wid/rsvp/chase` | owner, co_host (`rsvp.chase`); **`Idempotency-Key` required** | Send the `rsvp_reminder` template to one recipient per pending party (primary, else the first member with a valid phone) with quick-reply buttons | 409 `MSG_QUOTA_EXCEEDED` (from MSG), 422 `RSV_NOTHING_TO_CHASE` |

**Internal exports:** `rsvp.partySummary(partyId)` (GH home), `rsvp.registerWithMessaging()` (reply handler + audience filter, called at boot), purge participant `rsvp`.

**Lite web (RSV-01b):** `GET /g/:token/rsvp` (form) and `POST /g/:token/rsvp` (PRG 303 → `/g/:token?saved=rsvp`). Both use the same service, the ACC cookie session and CSRF.

### Examples

`PUT /v1/guest/rsvp` (active member Sunita answering for the family; offline replay carries `clientChangedAt`)
```json
{ "clientChangedAt": "2027-01-20T10:02:11Z",
  "responses": [
    { "eventId": "e-sangeet", "guestId": "g1", "status": "attending" },
    { "eventId": "e-sangeet", "guestId": "g3", "status": "attending" },
    { "eventId": "e-haldi",   "guestId": "g3", "status": "declined" } ],
  "dietary": [ { "guestId": "g3", "diet": "jain", "allergies": ["nuts"], "notes": "No onion/garlic" } ] }
```
→ `200`
```json
{ "events": [ { "eventId": "e-sangeet", "name": "Sangeet", "closesAt": "2027-02-01T18:29:59Z", "isClosed": false,
                "members": [ { "guestId": "g1", "name": "Sunita Sharma", "status": "attending", "source": "app", "byHost": false },
                             { "guestId": "g3", "name": "Kamla Sharma",  "status": "attending", "source": "app", "byHost": false } ] } ],
  "plusOnes": { "allowed": 1, "used": 0 },
  "skipped": [ { "eventId": "e-haldi", "guestId": "g3", "reason": "HOST_OVERRIDE_NEWER" } ] }
```

`GET /v1/weddings/:wid/rsvp/headcount` → `200`
```json
{ "rtCursor": 918273, "generatedAt": "2027-01-21T09:00:00Z",
  "events": [ { "eventId": "e-sangeet", "name": "Sangeet", "invited": 1840,
                "counts": { "attending": 1022, "declined": 140, "maybe": 61, "pending": 617 },
                "bySide": { "bride_side": { "attending": 540, "pending": 300 }, "groom_side": { "attending": 470, "pending": 310 }, "none": { "attending": 12, "pending": 7 } },
                "diet": { "veg": 410, "jain": 52, "vegan": 9, "eggetarian": 30, "non_veg": 380, "unknown": 202 },
                "allergies": { "nuts": 14, "gluten": 6 },
                "ageBand": { "adult": 900, "child": 80, "senior": 104 } } ] }
```

`headcount.delta` SSE event (≤ 4 kB; split into several events for large batches; no names or ids of people):
```
id: 918274
event: headcount.delta
data: {"changes":[{"eventId":"e-sangeet","from":"pending","to":"attending","side":"bride_side","diet":"jain","ageBand":"senior","n":1}]}
```

### Reply handler for one-tap WhatsApp (contract with MSG-11)

RSV registers `messaging.registerReplyHandler('rsv', handler)` and accepts MSG's `InboundReplyCommand`:

| Input | Use |
| --- | --- |
| `action` | `rsv.attend` → `attending`, `rsv.decline` → `declined`, `rsv.maybe` → `maybe` |
| `guestId`, `partyId`, `weddingId` | Responder, resolved by MSG from `context.id` / `reply_ref` / phone hash |
| `context.eventIds` | Events named in the invite or reminder (RSV sets them when it asks MSG to send). If missing → all invited, open, RSVP-enabled events |
| `inboundId` | Logged in the audit `after.inboundId`. Applying the same answer twice changes nothing → `already_done` |

Behaviour, in one transaction: for each event in scope that is open, set the answer for the responder **and** for every party member with no `rsvps` row yet (`source='whatsapp'`, `responded_by_guest_id = guestId`). Then `rt_publish` the deltas and audit.

Results:
- Something changed → `{ outcome: 'ok', reply: { templateKey: 'rsvp_confirmation', params: { firstName, summary: "Attending: Sangeet, Pheras", link: access.linkForParty(partyId) } } }`.
- Nothing changed → `{ outcome: 'already_done' }` (no reply, avoids spam).
- All events closed → `{ outcome: 'rejected', reply: { templateKey: 'rsvp_closed', params: { firstName, link } } }`.

Invite and reminder templates (MSG-02/DSN-05) carry three quick replies (`rsv.attend|<reply_ref>`, `rsv.decline|…`, `rsv.maybe|…`) and a URL button "Choose per event" → the party link.

**Audience filter** for MSG's composer and RSV-04: `registerAudienceFilter('rsvp_status', { eventIds, statuses: ('attending'|'declined'|'maybe'|'pending')[] }) → guestIds`.

## 5. Jobs, events and realtime

| Item | Kind | Behaviour |
| --- | --- | --- |
| `rsvp.changed { weddingId, partyId, eventIds, guestIds, source }` | domain event (after commit) | ARR (expected list), OPS counters, GH cache hints |
| `rt_publish(wid, 'headcount', 'headcount.delta', …)` | in the write transaction | Delta per (event, from, to, side, diet, ageBand) with count `n`; fires on commit only (FND) |
| `rt_publish(wid, 'headcount', 'headcount.stale', {})` | on `guest.created/removed`, `party.groups_changed`, `event.visibility_changed`, `event.deleted`, diet change | Clients refetch (denominators changed) |
| Chase | `messaging.send({ kind:'rsvp_reminder', templateKey:'rsvp_reminder', guestIds, context:{ eventIds }, idempotencyKey })` | MSG queues and throttles. RSV stores `rsvp_chase_runs` first, under the same key. |
| No pg-boss queues of its own | — | The WhatsApp handler runs inside MSG's `msg.inbound-route` job (worker process). `rt_publish` works from any process. |

## 6. Mobile app

| Mode | Screen | Behaviour |
| --- | --- | --- |
| Guest | `RsvpScreen` | One card per invited event (date, time, venue). Each member row has a 3-way `SegmentedControl` with icon and label (✓ Attending / ✕ Not / ? Maybe). "Same answer for all events" shortcut. Closed events are read-only with "Contact host". "Changed by host" chip. |
| Guest | `PlusOneSheet` | Stepper up to the allowance; optional name |
| Guest | `DietSheet` | Per member: diet chips, allergy chips, note (280) |
| Host | `HeadcountScreen` | Event cards with big numbers; tap → side, diet, allergy and age breakdown; live via `useEventStream(wid, ['headcount'])` applying deltas after `rtCursor` |
| Host | `RsvpListScreen` | Filters (event, status, side, diet, group), search, `FlashList`; row → `PartyRsvpEditor` |
| Host | `PartyRsvpEditor` (RSV-05) | Same control as the guest's, plus note; confirm sheet "Recorded by you, visible in audit" |
| Host | `ChaseSheet` | Pick events, N days (default 3), preview count and last chased, Send (idempotency key kept in MMKV until success) |

**Query keys:** `['guest', wid, 'rsvp']`, `['wedding', wid, 'headcount']`, `['wedding', wid, 'rsvps', filters]`, `['wedding', wid, 'rsvp-non-responders', args]`.

**Offline:** the guest PUT is an optimistic mutation persisted in the APP-04 outbox with `clientChangedAt`, and replays on reconnect (PUT is idempotent). Skipped rows show a toast "Host updated this answer". The headcount is cached (`meta.persist`) with a stale banner.

**Accessibility:** answers are never colour-only; each segment is 48 dp; the screen works at font scale 2.0 (cards stack and controls wrap to a vertical list). Budget Android: no animation libraries; a party of 6 × 6 events renders 36 rows.

## 7. Guest lite web

**Applicable (RSV-01b).** `/g/:token/rsvp` is a plain HTML form, one `<fieldset>` per event with a radio group per member, a diet `<select>` and allergy checkboxes per member, and a plus-one name field when the allowance > 0. It posts and redirects (PRG). The rules match the app, including closed events and host-override protection. The page is ~10 KB and needs no JS. The guest lite home (GH-08) shows each member's RSVP status and a "Change RSVP" link.

## 8. Security and privacy

- **Scope:** guests can only read or write members of their own party (`pid` from the token, never from the body). Events must be in `party_invited_events`. Everything else returns 404.
- **Host roles:** desk_staff get headcount totals only (no lists, no diets per person, no chase). Phone numbers are not in any RSV response; the host list links to GST for contact.
- **Audit:** every RSVP and diet write logs actor (guest + `actingVia` vid, user, or system for WhatsApp), before/after status, `source` and `inboundId`. Host overrides are logged as `rsvp.override` with the note.
- **DPDP:** purpose `core`. Diet and allergies are minimised (enum + 280-char note) and purged at wedding end + 30 days. RSVPs stay until the wedding purge (PRV). The PRV purge participant deletes a guest's `rsvps` and `guest_dietary`.
- **WhatsApp forgery:** MSG verifies the webhook signature and resolves the sender. RSV trusts only `guestId`/`partyId` from MSG, never IDs typed in a payload.
- **Rate limits:** guest PUT 60/h per party; chase 10/day per wedding (plus MSG's send limit); headcount GET 60/min per user.

## 9. Scale and performance

| Stress | Load | How it holds |
| --- | --- | --- |
| Invite wave to 2,000 guests | ~700 parties answer within 30 min, about 1 write/s, bursts of 10/s | Row upserts on a unique key. One `rt_publish` per write. |
| Live headcount, 50 weddings | Hosts keep the screen open all day | No recomputation on writes; deltas cost one small insert + NOTIFY. Full query (≈ 80 ms) only on screen open or `stale`. |
| Hot wedding day | Few writes (most RSVPs closed) | — |
| Host list of 2,000 guests | Cursor pagination, 50 per page | Index on `(wedding_id, event_id)` + `party_invited_events` |

**Realtime latency budget for "< 5 s":** commit → NOTIFY → hub read → SSE ≈ < 1 s.

**Note for SET:** an equivalent `UNION ALL` form of `party_invited_events` measured about 40 % faster than the `EXISTS` form on the same data. It's worth adopting if the headcount query shows up in OPS-01.

## 10. Testing plan

| Level | Cases |
| --- | --- |
| Unit | WhatsApp scope rule (responder + unanswered members, open events only); delta derivation (from/to/side/diet); host-override skip rule; plus-one limit; close rule (guest blocked, host allowed) |
| API e2e (Postgres) | Guest sees only invited events (group-restricted Haldi); cannot write another party's guest (404); `RSV_CLOSED`; plus-one add → appears as invited → limit 409; diet write; host override audited with before/after; guest stale replay → `skipped`; headcount numbers on a seeded wedding equal a brute-force count; `realtime_events` row after each write; `stale` after guest add; chase with the same `Idempotency-Key` twice → one run, one MSG message; non-responder filter with fake `firstSentAt`; desk_staff gets totals only and 404 on lists; other wedding 404 |
| MSG contract | Fake `InboundReplyCommand` → `ok` + confirmation; repeated → `already_done`; closed → `rejected` |
| Lite web | Form round trip, CSRF, closed-event read-only |
| Performance | Headcount on 2,100 guests × 6 events < 150 ms in CI (seeded); 50-wedding seed for EXPLAIN regressions |
| Mobile (RNTL) | RSVP screen at font scale 2.0; optimistic update and outbox replay; headcount applies deltas and refetches on `stale`/`reset` |

## 11. Story breakdown

| Story | Tasks | Points (backlog → revised) | Why |
| --- | --- | --- | --- |
| **RSV-01a** Per-event RSVP (API + app) | [DB] `rsvps`, `guest_dietary`, events alter · [API] guest GET/PUT, plus-ones via GST, override-skip rule, audit · [MOB] RsvpScreen, PlusOneSheet, DietSheet, outbox wiring · [TEST] | 5 → **5** | Same scope; plus-ones reuse GST |
| **RSV-01b** (split) Lite web RSVP form | [WEB] `/g/:token/rsvp` form + PRG · [TEST] | — → **3** | New: no-install path. Lands with GH-08/ACC-02b. |
| **RSV-02** One-tap WhatsApp RSVP | [API] `rsv` reply handler, scope rule, confirmation/closed replies, `context.eventIds` on invites · [TEST] contract tests with MSG fakes | 5 → **3** | Webhook parsing and routing moved to MSG-11 (+3 there) |
| **RSV-03** Live headcount | [API] headcount query + `rtCursor`, delta publisher, `stale` triggers, channel in the FND catalogue · [MOB] HeadcountScreen + delta reducer · [TEST] | 3 → **3** | SSE hub is FND-14 (S4), so the estimate holds |
| **RSV-04** Chase non-responders | [DB] `rsvp_chase_runs` · [API] non-responders, chase (idempotent), audience filter · [MOB] ChaseSheet, "last chased" · [TEST] | 2 → **3** | Idempotent send + "N days since invite" needs MSG send history |
| **RSV-05** Host RSVP on behalf | [API] host PUT with note + audit · [MOB] PartyRsvpEditor, RsvpListScreen · [TEST] | 1 → **2** | The host list screen was not owned by any story |
| **Total** | | **16 → 19** | |

## 12. Dependencies and sequencing

| Needs | From | When |
| --- | --- | --- |
| `party_invited_events`, events with `deleted_at`, event form fields `rsvp_closes_at`/`rsvp_enabled` | SET-02/04 (SET-04 is in S5; the view must land in **S4** for RSV-01a, at least `visibility='all'`) | S4 |
| Guest session, `requireConsent`, `linkForParty`, `signInGuest` test helper | ACC-01/02a/04 | S4 |
| `addPlusOne` / remove plus-one export | GST-01 | S3 |
| `rt_publish`, SSE stream, channel catalogue | FND-14 | S4 |
| `registerReplyHandler`, `registerAudienceFilter`, `send`, `firstSentAt(kind, partyIds)` (**new request to MSG**), `rsvp_reminder` / `rsvp_confirmation` / `rsvp_closed` templates with quick replies | MSG-01/02/03/11 | S5 (RSV-02), S7 (RSV-04) |
| `rsvp.*` actions in the permissions matrix | ROL-01/02 | S4 |
| Outbox / persister | APP-04 | S4 |
| Provides `rsvp.partySummary`, `rsvp_status` filter, `rsvp.changed` | → GH, MSG, ARR | S4–S5 |

## 13. Risks and open questions

| # | Item | Proposal / owner |
| --- | --- | --- |
| Q1 | **PO:** a one-tap WhatsApp "Yes" from the household head fills every **unanswered** member, for the events in that invite. Agree? | Recommended. Alternative: responder only (more chasing). |
| Q2 | **PO:** collect allergies (health-adjacent) or only diet + free note? | Keep the allergy chips (caterers ask); purge at wedding end + 30 d |
| Q3 | **PO:** does "Maybe" count toward catering? | Headcount shows it separately; the caterer export uses attending + maybe (configurable later) |
| Q4 | **PO:** default reminder cadence (N = 3 days) and a cap of 2 chases per party per event? | Recommended, to avoid WhatsApp quality downgrades |
| R1 | Template quick replies need Meta approval; utility vs marketing categorisation | MSG/DSN-05; fall back to the URL button only |
| R2 | SET-04 is planned for S5 but RSV-01a needs the view in S4 | Ship the view in S4 (it's DDL only); the group-visibility UI can stay in S5 |
| R3 | Plus-one rows created by guests clutter the host list | GST shows them under the party with an "added by guest" tag; host can remove |

## 14. Deviations from the baseline

None to the baseline itself. Cross-epic requests:
- MSG adds `firstSentAt({ weddingId, kinds, partyIds })` to its internal API.
- SET ships `party_invited_events` in S4.
