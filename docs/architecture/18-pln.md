# E18 — Multi-wedding planner dashboard (PLN)

## 1. Summary

Gives a planner agency one place to run all its weddings: an **org overview** with per-wedding health (RSVP %, travel %, messages used, days to go), **team seats** and per-wedding assignment, a read-only **credits** view, **planner branding** (logo + colours on the guest app, guest lite web and WhatsApp messages), and **clone a wedding / templates**.

| Stories | Phase / sprint |
| --- | --- |
| PLN-01 (split 01a/01b), PLN-02, PLN-05 | Pilots · S12 (01b → S13) |
| PLN-04 | Pilots · S15 |
| PLN-03 | Season readiness · S16 (with BIL-03) |

**Reinterpreted for the current stack:** the backlog assumed a web console. The baseline has no React web app, so the dashboard is a **Host-mode section of the React Native app** with a two-pane tablet layout (decision below). "Guest home" branding means the RN Guest mode **and** the server-rendered `/g/:token` page. Health aggregation runs on pg-boss, not Celery/Redis. Team seats reuse ROL's `team_invitations` (org invites) instead of a new invite system. Credits are **defined in BIL** (`sql/23-bil.sql`); PLN only calls `billing` module exports.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| **Where the dashboard lives** | **RN app, Host mode**, "Organisation" tab; phone list + **tablet two-pane** (≥ 768 dp: list left, wedding health/detail right) | A new React web console | The stack has no web app; adding one means a second UI stack, auth flow, design system and CI target (~2–3 sprints) for 5 stories. Planners already carry the host app for desk check-in and arrivals, and during peak season they work on the move. The overview is read-mostly and fits a list/detail layout. Desktop-only planners are the gap; the cheap answer later is a read-only server-rendered `/account/org` page on the BIL `/account` stack (cookie session already exists), not a SPA. Validate with pilot planners (§13). |
| **How health is computed** | **Summary table** `wedding_health_snapshots`, recomputed by a **debounced pg-boss job** per wedding (fired by domain events, ≤ 1 run/60 s/wedding) + a **nightly rebuild**; "days to go" and red/amber/green computed at read time | (a) Live aggregate queries on every page load; (b) DB triggers maintaining counters | (a) For an org with 30+ weddings × up to 2,000 guests the overview would fan out into RSV/TRV/MSG/GST tables on each request — 4–5 grouped queries over ~60k rows per load, repeated by every planner refreshing during peak season, while the same DB is fanning out announcements and camera uploads; it also makes PLN read other modules' tables (breaks module boundaries). (b) Triggers on hot RSVP/travel tables add write amplification during a Sangeet and couple PLN to other modules' schemas. The snapshot makes the overview one index scan regardless of org size; ≤ ~1–2 min staleness is fine for a planning view (the live arrivals board stays SSE). |
| Health inputs | Each owning module exports a batched count function (`guests.healthCounts`, `rsvp.healthCounts`, `travel.healthCounts`, `messaging.usage`, `entitlements.get`); PLN only stores results | PLN writes SQL against their tables | Baseline rule: one owner per table, cross-module only via `index.ts`. |
| Team seats | Reuse `organization_members` + ROL `team_invitations` (org invites) + `wedding_members.role = planner_member` for assignment; seat limit from BIL `organization_entitlements.seats_max` | New `org_invites` table | ROL already designed org invites (10-rol.sql); one invite flow. |
| Removing a team member | Removes the org membership **and** every `planner_member` row in that org's weddings, revokes their refresh tokens for those weddings, in one transaction | Leave wedding access in place | A departed employee must lose access to every client wedding at once. |
| Logo storage | `media_objects` row with `organization_id` (core `wedding_id` made nullable, exactly-one check) | Separate `org_assets` table or a URL field | Reuses the media pipeline (presign → S3 → `sharp` → WebP previews, EXIF strip). **Deviation**. |
| Brand colour safety | API computes `on_primary_colour` (#FFF/#000) for WCAG AA ≥ 4.5:1 and rejects primaries that can't reach 3:1 against both; **high-contrast mode ignores brand colours** | Trust the planner's colours | Older guests and outdoor venue glare; GH-05 accessibility. |
| Branding in WhatsApp | Planner display name as a **template parameter** in the footer/body of invite/announcement variants ("Sent by {{n}} for Ananya & Rohan"); optional logo as the image header of the invite | Per-planner WhatsApp sender numbers | Per-planner senders are white-label (WL-01, P2) and need separate Meta verification. Template variants with the parameter need Meta approval → MSG-02 lead time. |
| Clone mechanism | **Export → versioned JSON snapshot → import**, the same code path for "clone from wedding" and "create from template". Each module provides `exportTemplatePart(weddingId)` / `importTemplatePart(tx, newWeddingId, part, dateShift)` | Deep-copy SQL across tables | Keeps module boundaries; a template is just a stored snapshot; never copies guests/phones/media. |
| Dates on clone | Events shifted by `newStartsOn − sourceStartsOn` days, keeping local wall-clock times in the wedding timezone | Copy without dates | Presets usually keep the same day structure (Mehendi D-1 evening, etc.). |
| Clone billing | A clone is a new **Free/draft** wedding; a credit is consumed only on activation (BIL-03) | Consume on clone | Planners clone speculatively for proposals. |

## 3. Data model

DDL: [`sql/18-pln.sql`](./sql/18-pln.sql). References `000-core.sql` only. **Schema check passed**: `scripts/check-schema.sh arch_pln 000-core.sql 18-pln.sql` → `OK: 20 tables`; also passes in sequence with `23-bil.sql`, `24-gtm.sql` and every other epic file present up to 24 (excluding `14-prv.sql`, which currently clashes with `05-acc.sql`). EXPLAIN on 300 orgs × 40 weddings: the overview query (org's weddings ⨝ snapshots, ordered by `starts_on`) uses core `weddings_org_idx` + the snapshot PK, **0.3 ms**; no extra index needed.

| Table / change | Purpose | Notes |
| --- | --- | --- |
| `media_objects` + `organization_id`, `wedding_id` nullable, `media_objects_scope_ck` | Org-scoped media for logos | Logos use `kind = 'other'` until core adds `'logo'`. |
| `wedding_health_snapshots` | One row per wedding: guests, parties, invited, responded, attending, outstation, travel submitted, messages used/limit, plan code, computed_at | Counts not percentages; `organization_id` denormalised; cascade on wedding delete. |
| `organization_branding` | Display name, logo media id, primary/accent colours, computed `on_primary_colour`, `show_in_messages`, website, `version` | `version` busts app/lite-web caches. |
| `weddings.planner_branding_enabled` (ALTER) | Couple can turn the planner badge off per wedding | Default on. |
| `wedding_templates` | Org library: name, source wedding, `schema_version`, `payload` jsonb (≤ 256 KB) | Soft delete; unique name per org. |
| `wedding_clones` | Provenance: source wedding/template, parts copied, date shift | Shown as "Cloned from …". |

**Health definitions** (in `packages/domain/src/health.ts`, shared by API and app):
- RSVP % = `parties_responded / parties_invited` (a party counts once every member has answered every invited event); shown as "—" before invites go out.
- Travel % = `travel_submitted / outstation_parties`.
- Messages = `messages_used / messages_limit` (from MSG `message_quotas` + entitlements).
- Days to go = `starts_on − today` in the wedding timezone.
- Status: **red** if days ≤ 14 and RSVP < 60% or travel < 50%, or messages ≥ 95%; **amber** if days ≤ 30 and RSVP < 80% or travel < 70%, or messages ≥ 80%; else **green**. Thresholds are constants, tuned with pilots.

**Template payload v1** (Zod `WeddingTemplateV1`): `events[]` (kind, name, day offset, local start/end time, dress code, notes, venue ref, visibility groups), `venues[]` (name, address, maps url, notes), `groups[]` (name, system key, colour), `settings` (camera, reveal, language, branding colour — no cover photo), `contacts[]` (role labels only, **no phone numbers**), `drafts[]` (saved announcement drafts: template key + text). Excluded always: guests, parties, RSVPs, travel, media, phone numbers, ID data.

## 4. API

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/orgs/:oid/weddings?status=upcoming\|live\|past&cursor=&limit=` | org_owner, org_admin (all); org_member (assigned only) | Overview rows with health + status | 404 not a member |
| POST | `/v1/orgs/:oid/weddings/:wid/health/refresh` | org_owner, org_admin, assigned member | Enqueue recompute now (rate-limited 1/min/wedding) | `PLN_REFRESH_TOO_SOON` |
| GET | `/v1/orgs/:oid/members` | org members (phones hidden from org_member) | Seats: members, org role, assigned weddings, open invites, `seatsUsed/seatsMax` | — |
| POST | `/v1/orgs/:oid/invites` | org_owner, org_admin | Invite by email to a seat (ROL `team_invitations`), optional initial wedding assignments | `PLN_SEATS_FULL`, `ROL_INVITE_EXISTS` |
| PATCH | `/v1/orgs/:oid/members/:uid` | org_owner (org_admin can't change owners/admins) | Change org role | `PLN_LAST_OWNER` |
| DELETE | `/v1/orgs/:oid/members/:uid` | org_owner, org_admin | Remove seat + all wedding assignments in this org | `PLN_LAST_OWNER` |
| PUT | `/v1/orgs/:oid/members/:uid/weddings` | org_owner, org_admin | Replace the member's assigned weddings (`planner_member`) | `PLN_WEDDING_NOT_IN_ORG` |
| GET | `/v1/orgs/:oid/credits`, `/v1/orgs/:oid/credits/ledger` | org_owner, org_admin; org_member read | Proxies `billing.getCreditSummary/listLedger` (PLN-03) | — |
| GET / PUT | `/v1/orgs/:oid/branding` | GET: org members; PUT: org_owner, org_admin | Read/update branding; PUT needs entitlement `planner_branding` | `PLN_COLOUR_CONTRAST`, `BIL_FEATURE_NOT_IN_PLAN` |
| POST | `/v1/orgs/:oid/uploads` | org_owner, org_admin | Presigned PUT for a logo (PNG/JPEG/WebP ≤ 2 MB, `kind=other`, `purpose=logo`) | `MEDIA_TOO_LARGE` |
| PATCH | `/v1/weddings/:wid/planner-branding` | wedding owner | Turn planner badge on/off for this wedding | — |
| GET | `/v1/orgs/:oid/templates` | org members | Template library | — |
| POST | `/v1/weddings/:wid/save-as-template` | owner, co_host, org_admin, assigned planner_member | Snapshot → `wedding_templates` | `PLN_TEMPLATE_NAME_TAKEN` |
| DELETE | `/v1/orgs/:oid/templates/:tid` | org_owner, org_admin | Soft delete | — |
| POST | `/v1/orgs/:oid/weddings` (`Idempotency-Key`) | org_owner, org_admin, org_member | Create a wedding from `fromWeddingId` or `fromTemplateId` (or blank) | `PLN_SOURCE_NOT_IN_ORG`, `SET_INVALID_DATES` |

Guest side (owned by GH / lite web, data from `planner.brandingForWedding(weddingId)`): guest home payload gains `branding: { plannerName, logoUrl, primary, onPrimary, accent, version } | null`.

### Examples

`GET /v1/orgs/0b5…/weddings?status=upcoming&limit=50` → `200`
```json
{ "items": [
  { "weddingId": "a71…", "title": "Ananya & Rohan", "startsOn": "2027-12-12", "daysToGo": 27,
    "plan": "planner", "status": "amber",
    "rsvp": { "responded": 212, "invited": 300, "pct": 71 },
    "travel": { "submitted": 88, "outstation": 140, "pct": 63 },
    "messages": { "used": 4120, "limit": 8000, "pct": 52 },
    "guests": 1150, "computedAt": "2027-11-15T09:41:02Z", "myRole": "planner_member" } ],
  "nextCursor": "MjAyNy0xMi0xMnxhNzE…" }
```

`POST /v1/orgs/0b5…/weddings` · `Idempotency-Key: …`
```json
{ "title": "Meera & Arjun", "startsOn": "2028-01-20", "endsOn": "2028-01-22",
  "fromTemplateId": "t19…", "include": ["events","venues","groups","settings","drafts"] }
```
→ `201 { "weddingId": "c03…", "plan": "free", "copied": { "events": 6, "venues": 3, "groups": 7, "drafts": 4 }, "dateShiftDays": null }`

`PUT /v1/orgs/0b5…/branding`
```json
{ "displayName": "Shaadi Squad", "logoMediaId": "m88…", "primaryColour": "#8E1B3A", "accentColour": "#E2B04A", "showInMessages": true }
```
→ `200 { …, "onPrimaryColour": "#FFFFFF", "version": 3 }` or `422 PLN_COLOUR_CONTRAST`.

## 5. Jobs, events and realtime

| Job | Queue | Trigger | Notes |
| --- | --- | --- | --- |
| `pln.health.recompute {weddingId}` | `default` | Domain events `guest.changed`, `guest.imported`, `rsvp.recorded`, `travel.submitted`, `messaging.usage.changed`, `billing.entitlements.changed`, `wedding.updated`; manual refresh | pg-boss `singletonKey = weddingId`, `singletonSeconds = 60` (debounce); upsert snapshot; ~20 ms for a 2,000-guest wedding |
| `pln.health.rebuild` | cron 02:20 IST | Nightly | All weddings with `ends_on ≥ today − 7`; heals events lost on crash (in-process emitter is not durable) |
| `pln.clone` | — | none | Clone runs synchronously in one transaction (< 1 s for 20 events); no job |
| `pln.seat.removed` effects | in-transaction | — | Revoke refresh tokens (FND `refresh_tokens.revoked_reason = 'access_removed'`) |

No SSE channel: the overview is pull-to-refresh with `staleTime` 60 s. Branding updates publish `rt_publish(wedding, 'guest', 'branding.changed', {version})` for each live wedding of the org so open guest apps refetch (bounded: only `status = 'live'` weddings).

## 6. Mobile app

**Host mode** — new bottom tab **Organisation** (shown when the user is a member of a `planner` org; org switcher if several):

| Screen | Phone | Tablet (≥ 768 dp) |
| --- | --- | --- |
| Overview | FlashList of wedding cards: title, date, days-to-go, status chip (icon + label, not colour alone), three mini progress bars; filter chips Upcoming/Live/Past; search by title | Two-pane: list left (sortable by days-to-go / status), right pane = health detail + shortcuts (Guests, Messages, Arrivals) that open the wedding's Host navigator |
| Team | Members with role and assigned weddings; invite sheet (email, role, weddings); remove with confirm | same, master/detail |
| Credits (PLN-03) | Balance per plan, expiring soon, ledger by wedding; **no buy button** (store policy, see BIL §2) | same |
| Branding | Logo picker (image picker → upload queue), colour pickers with live contrast check, preview of guest home light/dark/high-contrast | side-by-side preview |
| Templates | Library; "Save this wedding as template" from wedding settings; "New wedding" → blank / from template / from past wedding, parts checklist, new dates | same |

Navigation and deep links: `mehfil://org/:oid`, `mehfil://org/:oid/wedding/:wid`; ROL invite link opens Team acceptance. Query keys: `['org', oid, 'weddings', status]`, `['org', oid, 'members']`, `['org', oid, 'credits']`, `['org', oid, 'branding']`, `['org', oid, 'templates']`. Offline: the overview query is persisted to MMKV and shown read-only with an "as of 09:41" banner; mutations (invite, branding, clone) are disabled offline. Accessibility: status uses icon + text; progress bars have text values; large-text mode switches cards to a single column; tablet layout tested on an entry-level Android tablet (Lenovo Tab M8-class).

**Guest mode** — guest home header shows the planner logo (cached by version), "Planned by X" footer, and primary/accent colours applied to the header and primary buttons via the theme provider; high-contrast mode overrides them. Logos load from CloudFront previews (WebP, ≤ 30 KB).

## 7. Guest lite web

Applies (PLN-04). `/g/:token` renders the logo `<img>` (CloudFront signed URL, width-bounded), "Planned by X", and the colours as CSS variables (`--brand-primary`, `--brand-on-primary`) inline in the page head; no extra request, no JS. Hidden when `planner_branding_enabled = false` or the wedding lacks the `planner_branding` entitlement.

## 8. Security and privacy

| Area | Measure |
| --- | --- |
| Tenant isolation | Every org route loads `organization_members` for the caller; non-members get **404**. org_member sees only weddings with a `wedding_members` row; snapshot rows are filtered through the same join |
| Least data | Overview returns counts only — no guest names or phones. Team list hides member phones from org_member |
| Desk staff | Never see the Organisation tab, branding settings or credits |
| Templates | Payload schema has no field for guests/phones/media; import validates with Zod and rejects unknown keys; contact entries carry role labels only |
| Seat removal | Same transaction removes wedding access + revokes refresh tokens; audit `org.member.removed` with organization_id |
| Logos | Content-type sniffed by the media worker; SVG rejected (script risk); EXIF stripped |
| Audit | `org.invite.*`, `org.member.*`, `org.branding.update`, `wedding.clone`, `template.create/delete` in `audit_log` (ROL `organization_id` column) |
| DPDP | Snapshots hold aggregates only and cascade with the wedding. Logos are business data. Templates are org business data, deleted with the org. |

## 9. Scale and performance

- Overview: one org with 40–150 weddings → one bitmap index scan + PK lookups, < 1 ms; response < 20 KB for 50 rows. Independent of guest counts.
- Recompute load: debounce caps it at 1/min/wedding; with 50 live weddings that's ≤ 50 small jobs/min on `default`, each ~5 grouped count queries on indexed `wedding_id` (~20 ms). During a 2,000-guest announcement, `messaging.usage.changed` fires many times but collapses into one job per minute.
- Nightly rebuild: ~1,000 active weddings × 20 ms ≈ 20 s.
- Branding on guest home: one extra PK lookup (cached in-process 5 min keyed by `organization_id + version`); the logo is a CDN asset.

## 10. Testing plan

| Level | Cases |
| --- | --- |
| Unit | Health status thresholds; percentages with zero denominators; date shift across DST-free IST and other timezones; contrast calculator |
| API e2e | Overview: org_admin sees all, org_member only assigned, non-member 404; snapshot recompute after RSVP; debounce (10 events → 1 job); seat full; remove member drops all `planner_member` rows and tokens; last owner protection; clone from wedding and template copies parts and never guests (assert zero rows in parties/guests/media); template payload with an extra `guests` key rejected; branding PUT without entitlement 402; logo SVG rejected |
| Module contracts | Each module's `healthCounts` and `export/importTemplatePart` has its own test in that module |
| Mobile | RNTL: overview cards, offline "as of" banner, tablet two-pane breakpoint, branding preview in high-contrast; device check on a budget Android tablet and iPad |
| Lite web | Snapshot test of `/g/:token` head with and without branding |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| **PLN-01a** Overview API + health snapshots | [DB] snapshots · [API] module `healthCounts` exports (GST, RSV, TRV, MSG), overview endpoint, refresh · [JOB] recompute (debounced) + nightly rebuild · [MOB] phone overview list · [TEST] | 5 → **5** | — |
| **PLN-01b** Tablet two-pane + offline (split) | [MOB] two-pane layout, persisted cache + "as of" banner, deep links · [TEST] device check on tablet | (in PLN-01) → **3** | No web console in the new stack, so the "console" experience has to be built in RN for tablets. |
| **PLN-02** Team seats | [API] org invites via ROL, assignments PUT, removal cascade + token revoke, seat limit check · [MOB] Team screens · [TEST] | 3 → **3** | Unchanged thanks to ROL's `team_invitations`. |
| **PLN-03** Credits | [API] proxy to `billing` exports · [MOB] Credits screen (no purchase CTA) · [TEST] | 2 → **2** | Unchanged; tables live in BIL. |
| **PLN-04** Planner branding | [DB] branding, media org scope, wedding toggle · [API] branding CRUD, org uploads, contrast check, guest-home payload · [MOB] host branding screen + guest theming · [WEB] lite web CSS vars · [OPS] Meta approval of template variants with planner-name param (via MSG-02) · [TEST] | 3 → **5** | Org-scoped media needs a core change and an org upload endpoint; RN dynamic theming must coexist with high-contrast; WhatsApp variants need approval. |
| **PLN-05** Clone / templates | [DB] templates, clones · [API] snapshot/import orchestration; export/import parts in SET (events, venues, settings, contacts), GST (groups), MSG (drafts) · [MOB] templates library + new-wedding flow · [TEST] no-PII assertions | 3 → **5** | Cross-module contracts in three modules plus a template library (backlog only had "reuse"). |
| **Total** | | **16 → 23** | |

## 12. Dependencies and sequencing

- **Needs first:** ROL-04 org model and `team_invitations` (S? MVP), SET-02 events, GST-06 groups, MSG-02 templates + `message_quotas`, RSV-01, TRV-01, GH-01 guest home, CAM-07 media worker (logo previews), BIL-01 for `planner_branding` / `seats_max` entitlements — until BIL-01 lands (S15 recommended), PLN treats every planner org as entitled (`seats_max` = 10).
- **Sprints:** S12 PLN-01a, PLN-02, PLN-05 · S13 PLN-01b (from pilot buffer) · **S13: submit WhatsApp template variants with the planner-name parameter** so PLN-04 in S15 isn't blocked by Meta approval · S15 PLN-04 · S16 PLN-03 with BIL-03.
- **DSN-06** must deliver tablet layouts for the overview one sprint before S12.

## 13. Risks and open questions

| # | Item | Owner |
| --- | --- | --- |
| 1 | **RN tablet vs web console.** Do pilot planners run their business from a laptop? If most do, plan a read-only `/account/org` overview page (≈ 3 pts on the BIL `/account` stack) for S17–S18. | PO (ask in VAL-03 follow-ups / pilots) |
| 2 | Health thresholds and the RSVP definition (party-level vs guest-level) — confirm with pilots. | PO |
| 3 | Seat limits per planner tier (placeholder 10) and whether seats are priced separately. | PO |
| 4 | Branding on messages depends on Meta approving template variants with a planner-name parameter; fallback is branding on guest home only. | Eng + PO |
| 5 | Snapshot staleness ≤ 1–2 min; if planners expect live numbers, add SSE `health.changed` from the job (cheap). | Eng |
| 6 | Template payloads evolve with SET/GST/MSG schemas → `schema_version` + upgrade functions; old templates must still import. | Eng |

## 14. Deviations from the baseline

1. **`media_objects` becomes org- or wedding-scoped**: `organization_id` added, `wedding_id` nullable, `CHECK ((wedding_id IS NULL) <> (organization_id IS NULL))`. The media pipeline and retention jobs must handle `wedding_id IS NULL`. Recommend core add `'logo'` to `media_objects.kind` (this file uses `'other'` to avoid redefining the core check).
2. **Org-scoped upload endpoint** `POST /v1/orgs/:oid/uploads` alongside the wedding-scoped one in the media flow.
3. Backlog E25's assumption ("MVP console is web-only") no longer holds; the planner dashboard is in the RN app. The overview's "Decisions that change the PRD" table should record that planners get no desktop console in v1.
