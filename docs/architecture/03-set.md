# E03 — Wedding setup (SET)

Status: design · Owner module: `apps/api/src/modules/weddings` (weddings, settings, contacts) and `apps/api/src/modules/events` (events, venues, visibility) · SQL: [`sql/03-set.sql`](./sql/03-set.sql)

## 1. Summary

A host signs in with Google, creates a wedding (couple names, dates, cities, timezone), adds events from presets, attaches venues with map pins, limits events to groups, lists key contacts and sets wedding settings (camera, language, branding with cover photo). Everything is done in **Host mode of the React Native app**; guests read the result through Guest mode and the guest lite web page.

| Story | Sprint (plan) | Sprint (proposed) |
| --- | --- | --- |
| SET-01 Create a wedding | S2 | S2 (cover photo moved to SET-06) |
| SET-02 Events with presets | S2 | S2 |
| SET-03 Venues and map pins | S2 | S2 = SET-03a (venue + pasted link); SET-03b (in-app pin picker) → S9 |
| SET-04 Event visibility by group | S5 | **S4** — GH-02 (S4) shows "only invited events" and needs it |
| SET-05 Key contacts | S3 | S3 |
| SET-06 Wedding settings | S3 | S3 (+ cover photo; needs the upload core, see §12) |

**Stack reinterpretation.** The backlog assumes a web "console" and a PWA. Here every host screen is an RN Host-mode screen, every guest view is RN Guest mode plus `/g/:token` server-rendered HTML. "Console" in acceptance criteria reads as "Host mode".

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Event presets | Static list in `packages/domain/src/events/presets.ts` (kind, default name, default start hour, duration, dress-code hint, icon) | `event_presets` table | Presets change with app releases, not per wedding; no admin UI needed. PLN-05 templates cover per-planner reuse. |
| Event time input | API takes **wall-clock local time** (`startsAtLocal: "2027-02-12T18:30"`) and converts with the wedding timezone | ISO with offset from the device | A host in Dubai editing a Jaipur wedding would otherwise get times shifted by the phone's zone. Responses return both `startsAt` (UTC) and `startsAtLocal`. |
| Timezone change after events exist | Keep wall-clock times: rewrite `starts_at/ends_at` in one transaction, audit-logged | Keep UTC instants | A tz change is almost always fixing a wrong pick; hosts think in local times. |
| Settings storage | `weddings.settings` jsonb validated by a **versioned Zod schema** (`WeddingSettingsV1`) on every write; readers parse with defaults | One column per setting | Settings grow every epic (camera, reveal, language, branding); jsonb + Zod avoids a migration per toggle while keeping validation. |
| Cover photo | `weddings.cover_media_id` → `media_objects` (kind `cover`) via the standard presigned upload | URL string in settings | FK integrity, retention and EXIF stripping come free from the media pipeline. |
| Map pin | Store `lat/lng` + `maps_url`. Host **pastes a Google Maps link** (parsed server-side) or uses "I'm at the venue" (device location). In-app draggable pin (react-native-maps) is SET-03b | Google Places Autocomplete | Places costs per session and needs a billed key; pasted links are what planners already share on WhatsApp. Maps SDK for mobile (dynamic maps) is free, so the pin picker is cheap later. |
| Short-link resolution (`maps.app.goo.gl`) | Server follows up to 3 redirects, **only** to an allowlist (`maps.app.goo.gl`, `goo.gl`, `www.google.com`, `maps.google.com`), 3 s timeout, no body read | Resolve on device | Device can't read redirect targets reliably in RN fetch; server-side with a strict allowlist avoids SSRF. |
| "Which events can this party see" | One SQL view `party_invited_events` owned by events module, exported as `events.listInvitedEventIds(partyId)` | Each module re-implements the rule | RSV, GH, MSG targeting and the lite web must agree exactly. |
| Event delete | Soft delete (`events.deleted_at`) | Hard delete | RSVPs, albums and announcements reference events; an accidental delete during a live wedding must be undoable. |
| Reorder UI | Up/down buttons + long-press drag | Drag only | Drag is hard for older hosts and screen readers. |
| Personal org | `POST /v1/weddings` without `organizationId` auto-creates a `family` org for the user (ROL-04) | Weddings without an org | Core requires `organization_id`; keeps one tenancy model for families and planners. |

## 3. Data model

SQL: [`sql/03-set.sql`](./sql/03-set.sql). **Schema check passed** (`scripts/check-schema.sh arch_set 000-core.sql 03-set.sql` → `OK: 18 tables`), also with 04 and 10 applied on top.

| Table | Change | Notes |
| --- | --- | --- |
| `weddings` | + `partner_one_name`, `partner_two_name`, `cities text[]` (≤ 5), `cover_media_id`, `settings_version`, `updated_by`; CHECK settings is an object | `title` stays the display name ("Ananya & Rohan"), defaulted from the two names. `status` transitions: `draft → live` (owner action or first invite send, MSG), `live → ended` (daily cron, day after `ends_on`), `→ archived` (PRV). |
| `events` | + `deleted_at`, `updated_by`; CHECK `ends_at > starts_at`; index `(wedding_id, sort_order, starts_at) WHERE deleted_at IS NULL` | `kind` uses the core CHECK (six presets + `custom`). |
| `venues` | + `city`, `parking_notes`, `google_place_id`, `updated_at`; lat/lng range and pair checks | Venue delete → events keep `venue_id = NULL` (core FK). |
| `event_groups` / `party_groups` | + index on `group_id` | For the invited-events view. |
| `wedding_contacts` (new) | id, wedding_id, side (`bride/groom/both`), label, name, phone_e164, has_whatsapp, sort_order | Guest-visible by design; max 10 per wedding (API). |
| `party_invited_events` (view) | party × event where `visibility='all'` or a shared group | Read by RSV/GH/MSG via the events module. Prisma: `view` preview feature or `$queryRaw`. |

### Settings schema (`packages/domain/src/wedding/settings.ts`)

> **Implemented as** `packages/domain/src/wedding-settings.ts` (SET-06). Change from this design: `branding` holds `palette` (one of the contrast-tested palettes in `packages/design-tokens`, or null for the app default) instead of `accentColour`/`theme`, so a host can never pick an unreadable colour. The app applies the wedding palette to its theme (device choice still wins).

```ts
export const WeddingSettingsV1 = z.object({
  camera: z.object({
    shotLimit: z.number().int().min(0).max(200).default(24),       // CAM-03 reads; BIL-01 caps by plan
    limitScope: z.enum(['wedding', 'event']).default('wedding'),
    revealMode: z.enum(['instant', 'next_morning', 'after_wedding', 'scheduled']).default('next_morning'),
    revealAt: z.string().datetime({ offset: true }).nullable().default(null), // required when scheduled
  }).default({}),
  language: z.object({
    default: z.enum(['en', 'hi', 'kn', 'ta', 'te', 'mr', 'gu', 'bn', 'pa', 'ml']).default('en'),
  }).default({}),
  branding: z.object({
    accentColour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#B5446E'),
    theme: z.enum(['classic', 'marigold', 'rose', 'emerald']).default('classic'),
  }).default({}),
  guests: z.object({
    phoneDefaultRegion: z.string().length(2).default('IN'),         // GST-04 import default
  }).default({}),
}).strict().superRefine((s, ctx) => {
  if (s.camera.revealMode === 'scheduled' && !s.camera.revealAt)
    ctx.addIssue({ code: 'custom', path: ['camera', 'revealAt'], message: 'required' });
});
```

`PATCH /settings` deep-merges the patch onto the stored value, parses the merged object with the full schema (defaults filled), and stores it. Unknown keys → 400. Readers use `WeddingSettingsV1.parse(stored)`; a future V2 adds a migration function keyed on `settings_version`. Plan limits (BIL-01) are applied as a second check (`entitlements.assertSettings`) once billing exists. Accent colour is checked for ≥ 4.5:1 contrast against white text; the API rejects colours that fail (`SET_COLOUR_LOW_CONTRAST`).

## 4. API

All under `/v1`. Roles via `requireWeddingRole` + `can()` ([10-rol.md](./10-rol.md)). Other weddings → 404.

| Method | Path | Caller (permission) | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/weddings` | any host user | Weddings I'm a member of (+ org-admin implicit) with my role | — |
| POST | `/weddings` | any host user | Create; caller becomes `owner`; seeds built-in groups (GST) | `SET_DATES_INVALID`, `SET_TIMEZONE_INVALID`, `SET_ORG_FORBIDDEN` |
| GET | `/weddings/:wid` | member (`wedding.read`) | Wedding + settings + cover URL | 404 |
| PATCH | `/weddings/:wid` | `wedding.update` | Names, title, dates, cities, timezone, cover_media_id | `SET_EVENTS_OUTSIDE_DATES` (warning in body, not error), `SET_COVER_NOT_READY` |
| DELETE | `/weddings/:wid` | `wedding.delete` (owner) | Soft delete; PRV purge after 30 d | `SET_CONFIRM_TITLE_MISMATCH` |
| GET / PATCH | `/weddings/:wid/settings` | read: `wedding.read`; write: `wedding.settings.update` | Validated settings | `SET_SETTINGS_INVALID` (Zod issues), `SET_COLOUR_LOW_CONTRAST` |
| GET | `/event-presets` | any host user | Preset catalogue (from domain, cached) | — |
| GET | `/weddings/:wid/events` | `event.read` | Live events in order, with venue and group ids | — |
| POST | `/weddings/:wid/events` | `event.write` | Create one event (from preset or custom) | `SET_EVENT_TIME_INVALID` |
| POST | `/weddings/:wid/events:bulk-from-presets` | `event.write` | One-click add of chosen presets on chosen dates | `SET_EVENT_TIME_INVALID` |
| PATCH | `/weddings/:wid/events/:eid` | `event.write` | Edit fields, venue, visibility | `SET_VENUE_NOT_FOUND` |
| PUT | `/weddings/:wid/events/order` | `event.write` | Full ordered id list | `SET_ORDER_MISMATCH` (ids ≠ live events) |
| DELETE | `/weddings/:wid/events/:eid` | `event.write` | Soft delete; response includes `rsvpCount` affected | — |
| POST | `/weddings/:wid/events/:eid/restore` | `event.write` | Undo delete (30 d) | — |
| PUT | `/weddings/:wid/events/:eid/groups` | `event.write` | Set `visibility` and group ids (SET-04) | `SET_GROUP_NOT_FOUND`, `SET_VISIBILITY_EMPTY` (groups mode with 0 groups) |
| GET | `/weddings/:wid/events/:eid/audience` | `event.read` | Count of parties/guests who can see it (preview for SET-04) | — |
| GET / POST | `/weddings/:wid/venues` | read `event.read`; write `venue.write` | List / create | `SET_MAPS_LINK_UNRECOGNISED` |
| PATCH / DELETE | `/weddings/:wid/venues/:vid` | `venue.write` | Edit / delete (events unlinked) | — |
| POST | `/maps/resolve-link` | any host user (rate-limited 20/min) | Paste a Maps link → `{lat,lng,placeId?,name?}` | `SET_MAPS_LINK_UNRECOGNISED`, `SET_MAPS_LINK_HOST_NOT_ALLOWED` |
| GET / POST | `/weddings/:wid/contacts` | read `wedding.read`; write `contact.write` | Key contacts | `SET_CONTACTS_LIMIT` (10), `GST_PHONE_INVALID` |
| PATCH / DELETE | `/weddings/:wid/contacts/:cid` | `contact.write` | — | — |
| PUT | `/weddings/:wid/contacts/order` | `contact.write` | Reorder | — |
| GET | `/guest/wedding` | guest | Title, dates, cities, cover URL, branding, language, contacts (GH-04 reads this) | — |
| GET | `/guest/events` | guest | Only invited events (view), with venue + map URL; GH-02 renders | — |

Cover upload uses the shared upload endpoints (`POST /v1/weddings/:wid/uploads` kind `cover`, then `/complete`), then `PATCH /weddings/:wid {coverMediaId}`. The service checks the media row is `processed`, kind `cover`, same wedding.

### Examples

`POST /v1/weddings`
```json
{ "partnerOneName": "Ananya", "partnerTwoName": "Rohan", "title": "Ananya & Rohan",
  "startsOn": "2027-02-11", "endsOn": "2027-02-13", "cities": ["Udaipur"],
  "timezone": "Asia/Kolkata", "organizationId": null }
```
→ `201`
```json
{ "id": "7c1e…", "title": "Ananya & Rohan", "status": "draft", "myRole": "owner",
  "organizationId": "a9…", "settings": { "camera": { "shotLimit": 24, "limitScope": "wedding", "revealMode": "next_morning", "revealAt": null }, "language": { "default": "en" }, "branding": { "accentColour": "#B5446E", "theme": "classic" }, "guests": { "phoneDefaultRegion": "IN" } } }
```

`POST /v1/weddings/:wid/events:bulk-from-presets`
```json
{ "items": [
  { "kind": "mehendi", "date": "2027-02-11" },
  { "kind": "sangeet", "date": "2027-02-11", "startsAtLocal": "2027-02-11T19:00" },
  { "kind": "pheras",  "date": "2027-02-12", "venueId": "c3…" } ] }
```
→ `201 { "events": [ { "id": "…", "kind": "sangeet", "name": "Sangeet", "startsAt": "2027-02-11T13:30:00Z", "startsAtLocal": "2027-02-11T19:00", "endsAtLocal": "2027-02-11T23:30", "dressCode": "Indo-western", "sortOrder": 1, "visibility": "all" } ] }`

`PUT /v1/weddings/:wid/events/:eid/groups`
```json
{ "visibility": "groups", "groupIds": ["<Family group id>"] }
```
→ `200 { "visibility": "groups", "groupIds": ["…"], "audience": { "parties": 41, "guests": 133 } }`

## 5. Jobs, events and realtime

| Kind | Name | Payload / trigger | Notes |
| --- | --- | --- | --- |
| Domain event | `wedding.created` | `{weddingId, ownerId}` | GST seeds 5 built-in groups in the same transaction (call, not async). |
| Domain event | `event.changed` / `event.deleted` | `{weddingId, eventId, fields[]}` | GH cache bust; MSG may offer "notify guests of time change" (MSG owns). |
| Domain event | `event.visibility_changed` | `{weddingId, eventId}` | RSV keeps RSVPs of now-hidden parties but hides them from headcount (RSV decides). |
| pg-boss cron | `set.wedding-status` (daily 02:00 IST, `default`) | — | `live → ended` the day after `ends_on`. Idempotent. |
| SSE | none | — | Setup is not live data; TanStack Query refetch on focus is enough. |

## 6. Mobile app

**Host mode** (`apps/mobile/src/features/wedding-setup/`):

| Screen | Notes |
| --- | --- |
| `WeddingsHome` | List of my weddings (role badge); "Create wedding". First screen after sign-in when >1 wedding. |
| `CreateWeddingWizard` (3 steps) | Names → dates + cities + timezone (default `Asia/Kolkata`, searchable list) → pick event presets (checkbox list with dates). Ends on wedding overview. |
| `WeddingOverview` | Cover, countdown, setup checklist (events, venues, guests, contacts, team). Entry point to all modules. |
| `EventsList` | Ordered cards; up/down buttons + long-press drag (`react-native-reanimated` drag list); swipe to delete with Undo snackbar. |
| `EventEditor` | Name, kind, local date/time pickers in wedding tz, dress code, notes, venue picker, "Who can see this" (All / chosen groups with live audience count). |
| `VenuesList`, `VenueEditor` | Paste Maps link (clipboard detection prompt), "I'm at the venue" (`react-native-geolocation-service`, permission asked only on tap), address, parking notes; SET-03b adds a `react-native-maps` draggable pin. |
| `KeyContacts` | Pick from phone contacts (single-contact native picker, no bulk read) or type; side; WhatsApp toggle. |
| `WeddingSettings` | Camera limits, reveal mode, default language, theme + accent colour (swatches only, all contrast-safe), cover photo (image picker → crop → upload queue). |

- Navigation: `HostNavigator` stack `Weddings → WeddingTabs(weddingId)`; deep link `mehfil://host/w/:weddingId/events/:eventId`.
- Query keys: `['weddings']`, `['wedding', wid]`, `['wedding', wid, 'settings']`, `['events', wid]`, `['venues', wid]`, `['contacts', wid]`, `['eventPresets']` (staleTime ∞).
- Offline: reads persisted to MMKV via TanStack Query persister so a host can see the schedule at a venue with no signal. Writes are online-only with a clear "No connection — not saved" banner (setup is not done at the venue; avoiding conflict handling is worth it).
- Accessibility: all buttons icon + label; time pickers show 12-hour with AM/PM and the city name ("7:00 PM in Udaipur"); large-text layout tested at 200% font scale.

**Guest mode** consumes `/guest/wedding` and `/guest/events` (screens owned by GH): schedule, "Open in Maps" (`https://www.google.com/maps/search/?api=1&query=<lat>,<lng>` or the stored link), call / WhatsApp (`https://wa.me/<digits>`) buttons for contacts.

## 7. Guest lite web

Applicable, read-only. `/g/:token` renders the wedding header (title, dates, cover preview), the invited schedule from `party_invited_events` with "Open in Maps" links, and key contacts with `tel:` and `wa.me` links. Server-rendered from the same service functions; no JS needed. Owned by GH; SET provides the service exports `weddings.getGuestView(weddingId)` and `events.listInvitedEvents(partyId)`.

## 8. Security and privacy

- Permissions per [10-rol.md](./10-rol.md): desk staff can read events/venues (they run the desk) but cannot edit; guests see only invited events and never `notes` fields that are host-only (`events.notes` is guest-visible by product intent — label it "Notes for guests" in UI; there is no host-only event note at MVP).
- Key contacts are personal data entered by the host for display to guests: UI copy says "Guests will see this number". Deleted with the wedding.
- Venue coordinates are not personal data. Device location is used once on tap, never stored beyond the venue pin.
- `POST /maps/resolve-link`: allowlisted hosts, max 3 redirects, 3 s timeout, response body never fetched, 20 req/min per user. URL never logged with query string.
- Audit (`audit.record` in the same transaction): `wedding.create/update/delete`, `wedding.settings.update` (diff), `event.create/update/delete/restore/reorder`, `event.visibility.update`, `venue.*`, `contact.*`. Contact phone numbers are masked in audit diffs.

## 9. Scale and performance

Light load: tens of writes per wedding per day. Hot read is the **guest schedule** (`party_invited_events` for one party) during invite blasts (2,000 guests opening links within minutes). EXPLAIN on 50 weddings × 2,100 guests × 6 events: 0.4 ms, party PK + events by wedding; `event_groups` uses its PK `(event_id, group_id)` at real sizes. Guest schedule responses carry `ETag` and `Cache-Control: private, max-age=60`.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit (domain) | Preset defaults; local ↔ UTC conversion incl. tz change keeping wall clock; settings Zod (defaults, strict, scheduled reveal needs `revealAt`); contrast check; Maps URL parser (≥ 15 real link shapes: `@lat,lng,zoom`, `?q=lat,lng`, `/place/…/data=!3d…!4d…`, `maps.app.goo.gl` short). |
| API e2e | Create wedding → owner membership + family org + 5 groups; events bulk/order/soft-delete/restore; visibility + `/guest/events` for a Family vs non-Family party; settings PATCH merge and errors; cover with media in wrong wedding → 400; resolve-link against a stub HTTP server and a disallowed host. Per-role matrix rows come from ROL-02 generator. |
| Mobile | RNTL: wizard happy path; EventEditor shows wedding-tz time when device tz is Asia/Dubai (mock); reorder buttons; settings form validation messages. |
| Device | Map link paste and "Open in Maps" on budget Android 9 and iOS 15; 200% font. |

Fakes: `FakeObjectStore`, stub redirect server for maps links, dev auth bypass.

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| SET-01 Create a wedding | [DB] ALTER weddings · [API] weddings router/service, family-org auto-create, owner membership, group seeding hook, IANA tz validation · [MOB] WeddingsHome, CreateWeddingWizard, WeddingOverview · [TEST] e2e create/list/404 | 2 → **3** | RN screens + org auto-create. Cover photo moved to SET-06. |
| SET-02 Events with presets | [DB] events soft delete · [API] presets catalogue, events CRUD, bulk-from-presets, order, local-time conversion · [MOB] EventsList with reorder, EventEditor · [TEST] tz unit tests, e2e | 3 → **3** | Unchanged. |
| SET-03a Venues + pasted map link | [DB] ALTER venues · [API] venues CRUD, link parser, resolve-link with allowlist · [MOB] VenuesList/Editor, clipboard prompt, "I'm at the venue" · [TEST] parser cases, SSRF tests | 3 → **3** | Same scope as backlog minus pin dragging. |
| SET-03b In-app pin picker (split, P1) | [MOB] react-native-maps (Android key, iOS Apple Maps), draggable pin · [OPS] Maps SDK key restricted to app signatures | new → **2** | Native map SDK setup on both platforms; nice-to-have. |
| SET-04 Event visibility by group | [DB] view + indexes · [API] PUT groups, audience count, `listInvitedEventIds` export, `/guest/events` · [MOB] "Who can see this" picker · [TEST] e2e visibility matrix | 3 → **3** | Unchanged; **move to S4** for GH-02. |
| SET-05 Key contacts | [DB] wedding_contacts · [API] CRUD/order, `/guest/wedding` contacts · [MOB] KeyContacts with native single-contact picker · [TEST] | 1 → **1** | Unchanged. |
| SET-06 Wedding settings + cover | [API] settings Zod + merge, contrast check, cover link · [MOB] WeddingSettings, cover upload via upload queue · [TEST] | 2 → **3** | Cover photo moved here; versioned schema. |
| **Total** | | **14 → 18** | (16 in MVP, SET-03b 2 later) |

## 12. Dependencies and sequencing

| Needs | From | Note |
| --- | --- | --- |
| Google SSO, `requireWeddingRole`, `audit.record`, `can()` | FND-05, ROL-02a, ROL-03a (S2) | ROL split proposed in 10-rol.md |
| Upload core (presign + complete + `FakeObjectStore`, `cover` kind processing) | CAM-01 (plan: S7) | **Pull a 2-pt "upload core" slice into S2/S3** (also unblocks GST import files, TRV-02). Otherwise cover photo slips to S7. |
| Built-in groups seeding, group ids | GST-06 / GST-01 (S2–S3) | SET-01 calls `guests.seedBuiltInGroups(tx, weddingId)`; stub until GST lands in the same sprint. |
| Guest auth for `/guest/*` | ACC-01 (S4) | `/guest/events` ships with SET-04 in S4. |
| Consumers | GH-02, GH-04, RSV-01, MSG-03, CAM-03/06 read view/settings | CAM owns reveal semantics; SET only stores them. |

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | Event kinds limited to 6 presets + custom by the core CHECK; regional ceremonies (Roka, Tilak, Mayra, Nalangu, Muhurtham, Cocktail) become `custom` with no icon. See deviations. |
| R2 | Reveal-mode semantics overlap with CAM-06; CAM design must adopt `settings.camera.*` names or both docs change together. |
| R3 | Changing wedding dates so events fall outside them: allowed with a warning; RSVP deadlines (RSV) may need recomputing. |
| Q1 | Should planners (planner_member) be able to delete a wedding? Matrix says owner only. |
| Q2 | Multiple time zones in one wedding (destination wedding with a pre-event in another country)? Assumed no. |

## 14. Deviations from the baseline

1. **Proposed:** relax `events.kind` CHECK in `000-core.sql` to a domain enum (or add `roka`, `tilak`, `cocktail`, `engagement`, `puja`, `muhurtham`) — not applied here because it requires editing core.
2. **Proposed:** upload core (presign/complete) built in S2–S3 instead of with CAM-01 in S7 (sequencing change to the sprint plan, not to the architecture).
