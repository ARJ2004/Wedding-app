# E10 — Roles, permissions and audit (ROL)

Status: design · Owner modules: `apps/api/src/modules/team` (wedding_members, team_invitations, organizations), `apps/api/src/modules/audit` (audit_log) · Domain: `packages/domain/src/permissions.ts` · Common: `apps/api/src/common/auth/` (`requireWeddingRole`, `route()`), `apps/api/src/common/serialize/` · SQL: [`sql/10-rol.sql`](./sql/10-rol.sql)

## 1. Summary

Defines who can do what in a wedding, how team members join (email invite to a Google SSO account), the planner-agency model, field-level masking, the audit log writer and viewer, and the per-role e2e strategy that proves it.

| Story | Sprint (plan) | Sprint (proposed) |
| --- | --- | --- |
| ROL-04 Organisation (agency) model | S2 | S2 |
| ROL-02 Permission enforcement | S8 | **Split:** ROL-02a matrix + `route()`/middleware + serialiser masking → **S2** (every endpoint needs it from day 1); ROL-02b generated per-role matrix tests + leak sentinel + review of all modules → S8 |
| ROL-03 Audit log | S8 | **Split:** ROL-03a `audit.record` writer + append-only guard → **S2**; ROL-03b viewer, filters, redaction → S8 |
| ROL-01 Team roles and invites | S4 | **S5** (swap with SET-04; still before ARR-03 desk check-in in S6) |

**Stack reinterpretation.** Backlog says "invite by phone/email". With Google SSO for hosts/staff, an invite targets a **Google account email**; the phone is only a delivery channel (the inviter shares the invite link from their phone via the OS share sheet to WhatsApp/SMS). "Console" = RN Host mode. "Automated tests per role" = Jest + supertest generated from the matrix.

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Where the matrix lives | `packages/domain/src/permissions.ts`: `Action` union, `MATRIX: Record<Role, ReadonlySet<Action>>`, `can(role, action)` | Ad-hoc role checks; DB-stored policies | One file shared by API and app (hide buttons), reviewable in PRs, testable. No per-wedding custom roles at MVP. |
| Endpoint declaration | Every route built with `route({ method, path, auth: 'host'|'guest'|'public', permission, input, output, handler })`; a boot-time check fails if a route lacks `permission` (or explicit `public`) | Middleware sprinkled by hand | Makes "every endpoint enforces the matrix" mechanically checkable and lets tests enumerate routes. |
| 404 vs 403 | Not a member (or other wedding) → **404**; member lacking permission → **403 `ROL_FORBIDDEN`** | 403 everywhere / 404 everywhere | Baseline rule; 403 for members helps the app explain "ask the owner". |
| Membership freshness | `requireWeddingRole` reads `wedding_members` (+ org admin rule) on each request; no role in the JWT | Role claims in JWT | Removal takes effect immediately, not after 15 min. Cost: one PK lookup per request. |
| Field-level masking | **Output Zod schema chosen by permission** (`GuestFull` vs `GuestDesk`), parsed with `.strip()` so unlisted fields cannot leak even if a service returns them | Deleting fields in serialisers | Allowlist beats denylist; new columns are hidden by default. |
| Invite delivery | Invite link `https://<domain>/i/<token>` shared via OS share sheet + in-app "pending invitations" for the matching email on sign-in | Email via SES | No new provider at MVP; WhatsApp is how families talk. SES `Mailer` can be added behind an interface (P1). |
| Invite acceptance | Signed-in Google account's **verified email must equal** the invited email | Anyone holding the link | Forwarded links in family WhatsApp groups are common. |
| Owner | Exactly one per wedding (partial unique index); transfer = owner → co_host + target → owner in one transaction | Multiple owners | Clear accountability for deletion, billing and DPDP requests. |
| Agency model | Wedding belongs to one org. `org_owner`/`org_admin` of that org get **implicit `planner_member`** on all the org's weddings; `org_member` sees only weddings with an explicit `wedding_members` row | Org members see all org weddings | Matches "assigned per wedding and see only those"; agency heads still oversee everything. |
| Audit writer | `audit.record(tx, entry)` inside the same Prisma transaction as the change | Async via events/jobs | No lost audit rows on crash; ordering is consistent. |
| Audit immutability | DB trigger blocks UPDATE/DELETE unless `SET LOCAL mehfil.audit_maintenance='on'` (used only by redaction and retention jobs) | Trust the code | Cheap tamper resistance on a single self-hosted DB. |
| Diffs | Store only changed fields; sensitive fields masked by a per-entity redaction map before write | Full row snapshots | Smaller rows; no phone/ID data in the audit table. |

## 3. Data model

SQL: [`sql/10-rol.sql`](./sql/10-rol.sql). **Schema check passed** (`arch_rol`: 000 + 03 + 04 + 10 → `OK: 22 tables`; also 000 + 10 alone → 17). Append-only trigger tested: plain `DELETE` raises; redaction `UPDATE` under the maintenance flag succeeds.

| Table | Change | Notes |
| --- | --- | --- |
| `wedding_members` | + `updated_at`; partial unique **one owner per wedding** | Removal = delete row (audited). |
| `organizations` | + `created_by`, `updated_at` | Family org auto-created by SET-01. |
| `organization_members` | + index `(user_id)` | Implicit access lookup. |
| `team_invitations` (new) | wedding **or** org target; `email` (citext), `role` / `org_role`, `token_hash` (sha256), `expires_at` (7 d), accepted/revoked | Partial unique: one open invite per (wedding, email) / (org, email). Owner is never invited — only transferred. |
| `audit_log` | + `organization_id`, `actor_role`, `actor_label`, `request_id`, `redacted_at`; indexes `(wedding_id, id DESC)`, by entity, actor, action; org index; append-only trigger | Keyset pagination on `id`. |

Retention: invitations deleted 90 days after expiry/accept/revoke (cron). Audit rows live as long as the wedding and are deleted with it by the PRV purge (cascade under the maintenance flag); guest deletion (PRV-02) redacts `before/after` of that guest's rows.

## 4. Permission matrix

Roles: `owner`, `co_host`, `planner_member` (incl. implicit org admins), `desk_staff`, `guest` (guest JWT, scoped to own party). ✓ = allowed, — = denied, *own* = only own party/self.

| Action | owner | co_host | planner_member | desk_staff | guest |
| --- | :-: | :-: | :-: | :-: | :-: |
| `wedding.read` (overview, settings read) | ✓ | ✓ | ✓ | ✓ | — (guest view endpoints) |
| `wedding.update`, `wedding.settings.update` | ✓ | ✓ | ✓ | — | — |
| `wedding.delete`, `wedding.transfer_ownership` | ✓ | — | — | — | — |
| `event.read` | ✓ | ✓ | ✓ | ✓ | *own invited* |
| `event.write`, `venue.write`, `contact.write` | ✓ | ✓ | ✓ | — | — |
| `guest.read` (names, party, groups) | ✓ | ✓ | ✓ | ✓ (names only, via check-in list) | *own party* |
| `guest.contact.read` (phone, email, notes, relation) | ✓ | ✓ | ✓ | **—** | *own party* |
| `guest.write`, `group.write` | ✓ | ✓ | ✓ | — | — |
| `guest.import`, `guest.merge` | ✓ | ✓ | ✓ | — | — |
| `guest.export` | ✓ | ✓ | ✓ | — | — |
| `link.rotate` (ACC) | ✓ | ✓ | ✓ | — | — |
| `rsvp.read` (headcount, per guest) | ✓ | ✓ | ✓ | headcount only | *own* |
| `rsvp.write_on_behalf` (RSV-05) | ✓ | ✓ | ✓ | — | *own* (`rsvp.self`) |
| `travel.read` | ✓ | ✓ | ✓ | arrival point/time only | *own* |
| `travel.write` | ✓ | ✓ | ✓ | — | *own* (`travel.self`) |
| `arrival.read` (board, still missing) | ✓ | ✓ | ✓ | ✓ (no phones) | *own status* |
| `arrival.checkin` | ✓ | ✓ | ✓ | ✓ | — |
| `message.read` (announcements, delivery) | ✓ | ✓ | ✓ | **—** | *own inbox* |
| `message.send`, `message.schedule` | ✓ | ✓ | ✓ | — | — |
| `media.upload` | ✓ | ✓ | ✓ | ✓ | ✓ (within shot limit) |
| `gallery.read` | ✓ | ✓ | ✓ | ✓ | ✓ (after reveal) |
| `media.moderate` (hide/unhide), `album.download` | ✓ | ✓ | ✓ | — | — |
| `pickup.read` / `room.read` | ✓ | ✓ | ✓ | ✓ (names, no phones) | *own* |
| `pickup.write` / `room.write` | ✓ | ✓ | ✓ | — | — |
| `idv.view` (decrypt ID) | ✓ | — | ✓ (if owner enables) | **—** | *own upload* |
| `team.read` | ✓ | ✓ | ✓ | — | — |
| `team.invite` / `team.remove` | ✓ (any role) | ✓ (planner_member, desk_staff) | ✓ (desk_staff) | — | — |
| `audit.read` | ✓ | ✓ | ✓ | — | — |
| `billing.manage` | ✓ | — | ✓ (planner org pays) | — | — |
| `privacy.delete_guest` (PRV-02) | ✓ | ✓ | — | — | *own request* |

Org-level (`organization_members.org_role`): `org.manage_seats`, `org.update` → `org_owner`, `org_admin`; `org.read` → all; only `org_owner` can delete the org or change `org_admin`s.

### `packages/domain/src/permissions.ts` (shape)

```ts
export const WEDDING_ROLES = ['owner', 'co_host', 'planner_member', 'desk_staff'] as const;
export type WeddingRole = typeof WEDDING_ROLES[number];
export type Role = WeddingRole | 'guest';

export const ACTIONS = [
  'wedding.read', 'wedding.update', 'wedding.settings.update', 'wedding.delete', 'wedding.transfer_ownership',
  'event.read', 'event.write', 'venue.write', 'contact.write',
  'guest.read', 'guest.contact.read', 'guest.write', 'group.write', 'guest.import', 'guest.merge', 'guest.export',
  'link.rotate', 'rsvp.read', 'rsvp.headcount', 'rsvp.write_on_behalf', 'rsvp.self',
  'travel.read', 'travel.read_logistics', 'travel.write', 'travel.self',
  'arrival.read', 'arrival.checkin', 'arrival.self',
  'message.read', 'message.send', 'message.inbox.self',
  'media.upload', 'gallery.read', 'media.moderate', 'album.download',
  'pickup.read', 'pickup.write', 'room.read', 'room.write', 'idv.view', 'idv.self',
  'team.read', 'team.invite', 'team.remove', 'audit.read', 'billing.manage',
  'privacy.delete_guest', 'privacy.request.self',
] as const;
export type Action = typeof ACTIONS[number];

const HOST_ALL: Action[] = ACTIONS.filter(a => !a.endsWith('.self') && a !== 'rsvp.headcount' && a !== 'travel.read_logistics');
export const MATRIX: Record<Role, ReadonlySet<Action>> = {
  owner:          new Set(HOST_ALL),
  co_host:        new Set(HOST_ALL.filter(a => !['wedding.delete', 'wedding.transfer_ownership', 'billing.manage', 'idv.view'].includes(a))),
  planner_member: new Set(HOST_ALL.filter(a => !['wedding.delete', 'wedding.transfer_ownership', 'privacy.delete_guest', 'idv.view'].includes(a))),
  desk_staff:     new Set<Action>(['wedding.read', 'event.read', 'guest.read', 'rsvp.headcount', 'travel.read_logistics',
                    'arrival.read', 'arrival.checkin', 'media.upload', 'gallery.read', 'pickup.read', 'room.read']),
  guest:          new Set<Action>(['rsvp.self', 'travel.self', 'arrival.self', 'message.inbox.self', 'media.upload',
                    'gallery.read', 'idv.self', 'privacy.request.self']),
};
export const can = (role: Role, action: Action) => MATRIX[role].has(action);

// Who may grant which role (team.invite / team.remove / role change)
const ASSIGNABLE: Record<WeddingRole, readonly WeddingRole[]> = {
  owner: ['co_host', 'planner_member', 'desk_staff'], co_host: ['planner_member', 'desk_staff'],
  planner_member: ['desk_staff'], desk_staff: [],
};
export const canAssign = (actor: WeddingRole, target: WeddingRole) => ASSIGNABLE[actor].includes(target);

// Wedding-level toggles that refine the static matrix (stored in weddings.settings, read via ctx):
// settings.team.plannerCanViewIds (idv.view for planner_member; default false)
```

`idv.view` for `planner_member` is gated by an owner toggle (`ctx.weddingFlags`), evaluated by `canInWedding(ctx, action)`, which wraps `can()`. Guest actions are additionally scoped by `party_id` from the guest JWT in each service.

## 5. API

| Method | Path | Caller (permission) | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/me` | host user | Profile, memberships `[{weddingId, role, via:'member'|'org_admin'}]`, orgs, pending invitations for my email | — |
| GET | `/v1/weddings/:wid/team` | `team.read` | Members + open invitations | — |
| POST | `/v1/weddings/:wid/invitations` | `team.invite` + `canAssign` | Create invite `{email, role}` → `{inviteUrl, expiresAt}` (URL returned once) | `ROL_ROLE_NOT_ASSIGNABLE`, `ROL_ALREADY_MEMBER`, `ROL_INVITE_EXISTS` |
| DELETE | `/v1/weddings/:wid/invitations/:iid` | `team.invite` | Revoke | — |
| POST | `/v1/invitations/:token/accept` | host user (any) | Accept by link | `ROL_INVITE_EXPIRED`, `ROL_INVITE_EMAIL_MISMATCH`, `ROL_INVITE_USED` |
| POST | `/v1/me/invitations/:iid/accept` | host user, email matches | Accept from in-app list | same |
| PATCH | `/v1/weddings/:wid/team/:userId` | `team.invite` + `canAssign` (old and new role) | Change role | `ROL_ROLE_NOT_ASSIGNABLE`, `ROL_CANNOT_CHANGE_OWNER` |
| DELETE | `/v1/weddings/:wid/team/:userId` | `team.remove` + `canAssign`; or self (leave) | Remove access | `ROL_LAST_OWNER` |
| POST | `/v1/weddings/:wid/transfer-ownership` | owner | `{toUserId}` (must be a member) | `ROL_NOT_MEMBER` |
| GET / POST | `/v1/organizations` | host user | My orgs / create planner org | — |
| GET | `/v1/organizations/:oid` | `org.read` | Org + weddings visible to me | 404 |
| GET / POST | `/v1/organizations/:oid/members`, `/invitations` | `org.manage_seats` | Seats + invite `{email, orgRole}` | `ROL_INVITE_EXISTS` |
| PATCH / DELETE | `/v1/organizations/:oid/members/:userId` | `org.manage_seats` (only org_owner touches org_admins) | Change seat / remove (also removes their `wedding_members` in org weddings) | `ROL_LAST_ORG_OWNER` |
| GET | `/v1/weddings/:wid/audit?entityType=&entityId=&actorId=&action=&from=&to=&cursor=&limit=` | `audit.read` | Viewer (desc by id) | — |
| GET | `/v1/organizations/:oid/audit` | `org.manage_seats` | Org seat changes | — |

Middleware chain per wedding route: `authHost` (JWT `aud=host`) → `loadMembership(wid)` (explicit row, else org admin of `weddings.organization_id` → `planner_member`, else **404**) → `requirePermission(action)` (403) → handler. Guest routes: `authGuest` → `ctx.guest = {guestId, partyId, weddingId}`; services filter by `party_id`.

### Examples

`POST /v1/weddings/:wid/invitations`
```json
{ "email": "meera.planner@gmail.com", "role": "planner_member" }
```
→ `201`
```json
{ "id": "inv…", "email": "meera.planner@gmail.com", "role": "planner_member",
  "inviteUrl": "https://mehfil.app/i/q7Yc…(22 chars base64url)", "expiresAt": "2027-01-21T10:00:00Z",
  "shareText": "Join Ananya & Rohan's wedding team on Mehfil: https://mehfil.app/i/q7Yc…" }
```

`GET /v1/weddings/:wid/audit?entityType=guest&entityId=g1…`
```json
{ "items": [ { "id": 9812, "at": "2027-02-11T07:31:05Z", "actor": { "type": "user", "id": "u2…", "label": "Meera (planner)", "role": "planner_member" },
  "action": "guest.update", "entity": { "type": "guest", "id": "g1…", "label": "Ravi Sharma" },
  "changes": [ { "field": "phone", "before": "******2345", "after": "******9876" }, { "field": "relation", "before": null, "after": "Mama ji" } ] } ],
  "nextCursor": "9811" }
```

Error for a member without permission: `403 { "error": { "code": "ROL_FORBIDDEN", "message": "Your role (desk_staff) can't do guest.export." } }`.

## 6. Serialisers and masking

- Each resource defines output schemas per audience in `modules/<x>/schemas.ts`, e.g. `GuestOutFull`, `GuestOutDesk`, `GuestOutSelf`. `serialize(ctx, 'guest', row)` picks by `canInWedding(ctx, 'guest.contact.read')` and runs `schema.strip().parse(row)`.
- Desk staff schemas never include: `phone`, `altPhone`, `email`, `notes`, `relation`, `phoneRaw`, ID-vault fields, ticket media, announcement bodies. The "call" action in ARR-04 is therefore host-only (ARR design must follow).
- Guest schemas include only the guest's own party; other parties are never queried (service-level `party_id` filter), not just masked.
- CSV exports use the same schemas (columns derived from the chosen schema).

## 7. Audit log

Writer API (`modules/audit/index.ts`):
```ts
audit.record(tx, { weddingId, action: 'guest.update', entityType: 'guest', entityId, before, after, label? })
// actor, actorRole, actorLabel, requestId come from AsyncLocalStorage request context; 'system' for jobs.
```
- `diff(before, after, redactionMap)` keeps changed keys; redaction map per entity: phones → `******` + last 4, emails → `r***@gmail.com`, ID numbers / OTPs / tokens → never stored.
- Mandatory actions (lint test lists the services that must call it): guest/party/group CRUD, import/export/merge, RSVP override (RSV-05), travel edits by hosts, check-ins, room/pickup changes, role/invite/ownership changes, settings, link rotation, `idv.view`, announcement sends, media hide, privacy deletions.
- Bulk operations write one summary row (`{count, filter}`), not one row per guest.
- Viewer filters map to the four indexes; free-text search not supported (by design).
- Redaction (PRV-02): `UPDATE audit_log SET before = '{"redacted":true}', after = ..., actor_label = ..., redacted_at = now()` under `SET LOCAL mehfil.audit_maintenance='on'`.

## 8. Jobs, events and realtime

| Kind | Name | Notes |
| --- | --- | --- |
| Domain event | `team.member_added/removed/role_changed`, `wedding.ownership_transferred` | Push notification to the affected user (FCM, via MSG/push module); SSE `team` channel not needed. |
| Domain event | `org.member_removed` | Team module deletes that user's `wedding_members` rows in org weddings in the same transaction. |
| pg-boss cron | `rol.invitations.cleanup` (daily, `default`) | Delete invitations closed/expired > 90 d. |
| On sign-in | — | `/v1/me` returns pending invitations for the verified email (no job). |
| SSE | When a member is removed, the SSE hub closes their open streams for that wedding (`LISTEN` on `membership_changed`). | Desk tablets lose the arrivals board immediately. |

## 9. Mobile app

**Host mode** (`apps/mobile/src/features/team/`, `.../audit/`):

| Screen | Notes |
| --- | --- |
| `Team` | Members with role chips; open invitations (copy/share/revoke); "Invite" button shown only if `canAssign` to any role. |
| `InviteMember` | Email + role (only assignable roles listed, with one-line descriptions: "Desk staff: check guests in; can't see phone numbers"); on success opens share sheet with `shareText`. |
| `PendingInvitations` | Shown after sign-in if `/me` has invitations; Accept / Decline. Deep link `https://<domain>/i/:token` (app link) → sign in → accept. |
| `MemberDetail` | Change role, remove, transfer ownership (owner; confirm by typing the wedding title). |
| `Activity` (audit viewer) | Infinite list grouped by day; filters: person, entity type, action; tap entity to jump to it. Wedding-tz timestamps. |
| `Organization` (planner) | Org members, invite seat, list of org weddings (PLN builds the dashboard later). |

- Role-aware navigation: `useCan(action)` hook from `packages/domain` hides tabs/buttons. Desk staff get a reduced `DeskNavigator` (check-in, arrivals board, camera) — the API still enforces.
- Query keys: `['me']`, `['team', wid]`, `['audit', wid, filters]` (infinite), `['org', oid]`.
- On 404 for a wedding (removed access), the app clears that wedding's cache and returns to `WeddingsHome` with a message.

## 10. Guest lite web

Not applicable: no team or audit features for guests. Guest-side permissions (own party only) are enforced by the same services the lite page calls.

## 11. Security and privacy

- Invite token: 128-bit random, base64url, only sha256 stored; single-use; 7-day expiry; rate limit 30 invites/day per wedding; accept endpoint 10/min per user.
- Google email must be `email_verified=true`; dev bypass (`dev:<email>`) is only in non-production (baseline guard).
- Removal is immediate (membership read per request; SSE streams closed). Refresh tokens of a removed user are not revoked (they may belong to other weddings).
- Desk staff accounts: least data (matrix + masking); recommend owners remove desk staff after the wedding — `team` screen shows a "Remove all desk staff" action after `ends_on`.
- Audit log contains no raw phones/IDs/tokens; append-only trigger; personal data in it is redacted on guest deletion; deleted with the wedding.
- DPDP: the owner is the Data Fiduciary's contact for the wedding; planner orgs act as processors for family-owned weddings (PO/legal to confirm, §15).
- Tenant isolation: every wedding-scoped query includes `wedding_id`; PRV-05 tenant-isolation tests reuse the matrix generator with an "outsider" member of another wedding.

## 12. Scale and performance

Membership lookup per request: PK `(wedding_id, user_id)` + org fallback via `organization_members` PK — sub-millisecond; cached per request only. Audit writes: one insert per mutation in the same transaction; at peak (check-in rush, ~10 writes/s per wedding, 50 weddings) far below Postgres limits. Audit viewer EXPLAIN on 210k rows: **0.13 ms** via `audit_wedding_entity_idx`. Audit table growth ~50k rows per 2,000-guest wedding; partitioning not needed before ~10M rows.

## 13. Testing plan

| Level | What |
| --- | --- |
| Unit (domain) | Matrix snapshot test (any change shows up in PR diff); invariants: desk_staff lacks every `*.contact.read`, `message.read`, `idv.view`, `guest.export`; guest has only `*.self`-style actions + upload/gallery; `canAssign` table; owner ⊇ co_host ⊇ … where intended. |
| Route coverage | Boot the app, enumerate the route registry: every route has `permission` or `public`; fails CI otherwise. |
| **Per-role e2e (generated)** | Fixture: wedding W1 with one user per role + org admin (implicit) + org member (not assigned) + outsider (member of W2) + guest of W1 party A + guest of W2. For every registered route × principal, build a minimal valid request from the route's input schema example; expect: allowed → 2xx/4xx-validation (never 401/403/404); member denied → 403 `ROL_FORBIDDEN`; non-member/outsider/org member unassigned → 404; guest on host route → 401. Runs as one Jest file with `describe.each`, ~2 min. |
| **Leak sentinel** | Seed guests with sentinel phone `+919999000111`, email `sentinel@leak.test`, note `SENTINEL-NOTE`; as desk_staff and as guest of another party, call every GET route and SSE snapshot; assert the raw body never contains a sentinel string. |
| Invitations | Create/accept/email mismatch/expired/revoked/already member/role escalation (co_host inviting co_host → 403). Ownership transfer and one-owner constraint. Org admin implicit access and loss on seat removal. |
| Audit | Each mandatory action writes one row with masked diff; append-only trigger raises; redaction path; viewer filters + pagination. |
| Mobile | RNTL: `useCan` hides Invite/Export for desk staff; DeskNavigator for desk staff; InviteMember lists only assignable roles; PendingInvitations accept. |

Fakes: dev auth bypass (`dev:<email>`) creates principals; no external services.

## 14. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| ROL-04 Organisation model | [DB] org columns/index · [API] orgs, seats, org invitations, implicit org-admin access in `loadMembership`, seat removal cascade · [MOB] Organization screen (basic) · [TEST] | 3 → **3** | Unchanged. |
| ROL-02a Matrix + enforcement scaffold (S2) | [API/domain] `permissions.ts`, `route()` builder, `loadMembership`/`requirePermission`, `serialize()` with audience schemas, route-coverage check · [TEST] matrix unit tests | (in 02) → **2** | Must exist before the first wedding endpoint. |
| ROL-02b Per-role test suite (S8) | [TEST] generated route × role e2e, leak sentinel, desk navigator review across all modules · [MOB] DeskNavigator, `useCan` audit of screens | 5 → **5** | Unchanged scope, now mostly test generation. |
| ROL-01 Team roles and invites | [DB] team_invitations, one-owner index · [API] team, invitations, accept, role change, remove, transfer · [MOB] Team, InviteMember (share sheet), PendingInvitations, MemberDetail, app link `/i/:token` · [JOB] cleanup cron · [TEST] | 3 → **5** | Invite flow + app links + ownership transfer + RN screens. |
| ROL-03a Audit writer (S2) | [DB] audit columns, trigger · [API] `audit.record`, diff + redaction map, request context | (in 03) → **1** | Every S2+ write must audit from day 1. |
| ROL-03b Audit viewer (S8) | [DB] viewer indexes · [API] viewer endpoints, redaction function for PRV-02 · [MOB] Activity screen · [TEST] | 3 → **3** | Unchanged. |
| **Total** | | **14 → 19** | |

## 15. Dependencies and sequencing

| Needs | From | Note |
| --- | --- | --- |
| Google SSO, JWTs, `users`, request context | FND-05 (S2) | ROL-02a/03a land in the same sprint, right after it. |
| App links (`/i/:token`, `/g/:token`) config (assetlinks.json, apple-app-site-association) | FND / ACC | Shared with guest links. |
| Push to notify invited/removed users | MSG-08 / push module | Optional; share sheet works without it. |
| Consumers | Every epic | All endpoints use `route()` with an `Action`; new actions are added to `permissions.ts` in that epic's PR. ARR-04 "call" button is host-only. |

## 16. Risks and open questions

| # | Item |
| --- | --- |
| R1 | Desk staff (volunteers, cousins) must have a Google account. Almost all Android users do; iOS users may not. Alternative later: per-wedding desk PIN sessions (`aud=desk`). |
| R2 | Generated matrix tests need a valid example input per route; enforce `input.example` in `route()`. |
| R3 | Matrix entries for P1 epics (pickups, rooms, ID vault, billing) are provisional; those designs may refine them. |
| Q1 | PO: when a planner creates a wedding for a family, who is `owner` — the planner (default: creator) or the couple (planner invites them, then transfers)? Affects DPDP accountability and billing. |
| Q2 | PO: should org admins really see **all** org weddings implicitly? |
| Q3 | PO: may `planner_member` view decrypted IDs if the owner allows (default off)? |
| Q4 | PO/legal: is the planner org a processor for the family (DPA in ToS)? |

## 17. Deviations from the baseline

1. Baseline says field masking happens "in serialisers"; this design makes it concrete as **audience-specific Zod output schemas with `.strip()`** — compatible, noted for clarity.
2. `audit_log` gains an append-only trigger with a session-flag escape hatch; the PRV retention purge and any test that hard-deletes a wedding must `SET LOCAL mehfil.audit_maintenance = 'on'` (TRUNCATE in tests is unaffected).
3. No email provider at MVP: team invites are shared via the OS share sheet and surfaced in-app; an SES `Mailer` is P1 if PO wants email delivery (would be a new external service in the baseline).
