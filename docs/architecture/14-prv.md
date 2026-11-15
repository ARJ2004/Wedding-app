# E14 — Privacy and compliance (PRV)

Status: design for review · Owner module: `apps/api/src/modules/privacy` · SQL: [`sql/14-prv.sql`](./sql/14-prv.sql)

## 1. Summary

Delivers what Mehfil needs to handle guest and host personal data lawfully under India's **Digital Personal Data Protection Act 2023** (and the DPDP Rules 2025, which phase in before the Nov 2027 season — counsel to confirm dates under VAL-13):

- **Versioned privacy notices** and the **consent record** for each purpose (`consents` core table; PRV owns all writes, ACC-04 owns the first-open screen).
- **Data subject requests**: export and erasure for a guest, a party, a host account or a whole wedding, done within 7 days, through an **ordered purge across every module** (`PurgeParticipant`).
- **Retention jobs** driven by `media_objects.delete_after` and per-wedding class expiries computed from the wedding end date and plan.
- **Encryption at rest** (EBS, S3, backups), **least-privilege IAM**, **secrets handling**.
- **Pre-pilot security review** (OWASP API Top 10, token-link threat model, tenant-isolation test harness).
- **App Store privacy label and Play data safety form**, plus the account-deletion paths both stores require.

| Story | Backlog sprint | Proposed sprint |
| --- | --- | --- |
| PRV-01 Privacy notice and consent records | S8 | **S4** (with ACC-04, which cannot store a consent without it) |
| PRV-02 Data requests (P0\*) | S9 | S9, split 02a / 02b |
| PRV-03 Retention jobs (P0\*) | S9 | S9 |
| PRV-04 Encryption and least privilege | S8 | S8 (with FND-11) |
| PRV-05 Pre-pilot security review | S8 | S8 |
| PRV-06 Store privacy labels + account deletion (new) | — | S8 (before the first store submission) |

**Stack reinterpretation:** the backlog assumes RDS, ECS, Secrets Manager and a PWA. Under the baseline this becomes: encrypted EBS for the self-hosted Postgres, encrypted `pg_dump`/pgBackRest backups in S3, one EC2 instance role instead of per-service task roles, `.env` rendered from SSM Parameter Store, and the RN app plus guest lite web instead of the PWA.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Who owns consent writes | `privacy` module owns `consents`, `privacy_notices`; ACC-04 calls `privacy.recordConsent()` | ACC owns the table | One owner for the legal record; FACE, IDV, CAM, MSG all read it. |
| Notice storage | Notice text in Postgres (`privacy_notice_texts`, markdown + sha256), served by API to app, lite web and `/privacy` | Static site page | Need to prove exactly which text a guest saw; the hash and version go in the consent row. |
| Consent history | Re-grant = new row; partial unique index keeps one active grant per purpose | Update in place | Withdrawal history is evidence; cheap. |
| Children | Party primary (OTP-verified) records consent for members with `age_band='child'`; `recorded_by_guest_id` stores who | Ask each child | DPDP requires verifiable parental consent for under-18s; the OTP-verified primary is the practical "verifiable" step. Counsel to confirm. |
| Erasure orchestration | One `prv.request.process` pg-boss job walking registered `PurgeParticipant`s in fixed order, one transaction per module, step rows for resume | One giant transaction; DB `ON DELETE CASCADE` alone | Giant txn locks hot tables during a live wedding and mixes S3 calls with DB; cascade alone misses S3 objects, audit-log text, provider data and gives no proof. |
| Hard vs soft delete | Hard delete (or anonymise in place for counters) at purge time; host "delete guest" is soft for 7 days, then purged | Soft delete forever | DPDP erasure means erasure. 7-day undo matches the request SLA. |
| Wedding purge | Keep a PII-free **tombstone** `weddings` row (`purged_at`, title "Deleted wedding") | Delete the row | GST invoices (BIL) must be kept 8 years and the ledger references the id. |
| Erasure after a backup restore | `erasure_ledger` mirrored to an S3 bucket (ids only); `prv:replay-erasures` runs after any restore before traffic is reopened | Accept resurrection; or purge backups | Backups keep data up to 35 days (stated in the notice); replay stops erased data reappearing in production. |
| Retention policy home | Code: `packages/domain/src/retention.ts` (reviewed, versioned); per-wedding schedule materialised in `wedding_retention_state` | Policy table editable at runtime | Policy is a legal commitment — it changes by PR, not by a click. The materialised table lets hosts see dates and makes the job a cheap index scan. |
| Expiry mechanism | pg-boss crons scanning `media_objects.delete_after` and `wedding_retention_state.expires_at`; S3 lifecycle only as a safety net (exports, `tmp/`, noncurrent versions) | S3 lifecycle tags per object | Tags can't express "wedding end + plan + add-on" and silently diverge from the DB. |
| Tenant isolation | App-level `wedding_id` scoping + a **route-coverage isolation test** that fails CI if any wedding route lacks a cross-tenant case | Postgres row-level security | RLS with Prisma needs per-request `SET` and connection pinning; costly for a small team. Tests give the same assurance at the API boundary. |
| Secrets | `.env` (chmod 600, baseline) **rendered at deploy from SSM Parameter Store SecureString** | AWS Secrets Manager (backlog) | Parameter Store standard tier is free, KMS-encrypted, audited by CloudTrail; Secrets Manager's rotation features aren't needed for these secrets. |
| pg_dump encryption | `pg_dump -Fc | age -r <public key>`; private key offline | GPG; key on the box | `age` is one binary with no keyring; box holding only the public key means a box compromise can't read old dumps. |
| Admin access for support | `platform_staff` table + `/admin` pages (see 26-ops) | Staff added as wedding members | Support must never get wedding content by default; staff see request status and counts, not guest data. |

## 3. Data model

Schema: [`sql/14-prv.sql`](./sql/14-prv.sql). **Schema check passed** (`scripts/check-schema.sh arch_prv 000-core.sql 14-prv.sql` → `OK: 25 tables`; full run of all 26 design files → `OK: 138 tables`). EXPLAIN on 100k media rows / 2k retention rows / 20k consents confirmed `media_delete_after_idx`, `wedding_retention_due_idx` and `consents_one_active` (index-only) are used.

| Table | Purpose | Notes |
| --- | --- | --- |
| `platform_staff` | Mehfil employees with `support` / `ops` / `admin` roles | Shared with OPS. Grants no wedding access. 23-bil.sql's `platform_admins` duplicates it — merge into this one. |
| `privacy_notices` | One row per notice version (`guest-2027.1`, `host-2027.1`): purposes covered, `requires_reconsent`, `effective_from`, `published_at` | Version format checked; purposes must be a subset of the core purpose enum. |
| `privacy_notice_texts` | Text per locale (`en`, later `hi`, `kn`) with `sha256` | DPDP lets a principal read the notice in English or an Eighth-Schedule language — L10N adds rows. |
| `consents` (core, altered) | + `source`, `locale`, `recorded_by_guest_id`, `withdrawn_source`; FK `notice_version → privacy_notices` | `consents_one_active` (unique, active only); `consents_wedding_purpose_idx` for host summary and gating. |
| `user_policy_acceptances` | Host/staff acceptance of host notice + terms | Users are not in `consents` (it requires `guest_id`). |
| `weddings` (core, altered) | + `retention_extended_until` (BIL-04), `deletion_requested_at`, `purge_after`, `purged_at` | `weddings_purge_due_idx`. |
| `wedding_retention_state` | Per wedding × data class: `expires_at`, `done_at` | Recomputed on wedding create, date change, plan change, add-on purchase. Shown to the host. |
| `data_requests` | Export/erasure requests: scope (`guest`/`party`/`user`/`wedding`), subject id, channel, status, `not_before` (undo window), `due_at` (+7 days), export key | No FK to subject — outlives it. One open request per (kind, scope, subject). Web-form requests store only `contact_hash`. |
| `data_request_steps` | One row per module per request, `seq` = participant order, counts in `result` | Lets the job resume at the failed module; is the proof of what was deleted. |
| `erasure_ledger` | Append-only record of every erasure (request, host delete, retention, consent withdrawal, wedding purge) | Mirrored to S3 (`mirrored_at`); replayed after restore. |
| `retention_runs` | One row per retention job run with counts | Dashboard + evidence for audits. |
| Index on core | `media_uploader_guest_idx` | Finds a guest's own uploads on erasure/export. Audit scrubbing uses 10-rol's `audit_wedding_entity_idx` and `redacted_at`. |

### Purposes (core enum, unchanged)

| Purpose | Covers | Default | Withdrawal effect |
| --- | --- | --- | --- |
| `core` | Guest list entry, RSVP, travel, rooms, pickups, wedding messages, check-in | Required to use guest features | Treated as an **erasure request** for that guest (host notified "guest left"), since the service can't run without it. |
| `photos` | Camera uploads, appearing in gallery as uploader | Asked at first camera open | Camera disabled; guest chooses: keep or delete own uploads (default: keep, unattributed). |
| `face_match` | Selfie + face search (FACE) | Off, explicit opt-in | Selfie + embeddings deleted within 24 h (FACE-05 participant). |
| `id_documents` | ID vault (IDV) | Off, asked at upload | ID copies deleted immediately; host sees "withdrawn". |
| `marketing` | Mehfil marketing to guests | Off, never pre-ticked | Suppressed in MSG (MSG-10). |

### Retention policy (`packages/domain/src/retention.ts`, from wedding `ends_on` in wedding timezone)

| Data class | Free | Essentials | Complete / Planner | Notes |
| --- | --- | --- | --- | --- |
| `tickets` | +7 d | +7 d | +7 d | TRV-02 uploads |
| `id_documents` | n/a | +3 d | +3 d (host may set 3–7) | IDV-04 also schedules KMS key deletion |
| `face_data` | n/a | n/a | +30 d | selfies + embeddings |
| `travel`, `rooms_pickups` | +30 d | +30 d | +30 d | PNRs, flight numbers, room numbers |
| `exports` | 7 d after creation | same | same | zips, data exports; also S3 lifecycle |
| `message_content` | +90 d | +90 d | +90 d | personalised bodies + provider ids anonymised; counts kept for quota/billing |
| `photos` (+ videos) | **+N months (PO: propose 3)** | +12 months | +12 months (+ `retention_extended_until`) | `media_objects.delete_after` |
| `guest_list`, `audit_log` → **wedding purge** | = photos expiry | = photos expiry | = photos expiry | everything left; tombstone kept |

Owner gets a push + email/WhatsApp at purge −30 d and −7 d with "Download album" and "Extend storage" (BIL-04).

## 4. API

All under `/v1`. Guest endpoints use the guest JWT; `me` = the guest (or host user) in the token.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/privacy/notices/current?audience=guest&locale=hi` | public | Current published notice + text + purposes | `PRV_NOTICE_NOT_FOUND` 404 |
| GET | `/v1/me/consents` | guest | Active consents for me and (if primary) child members | — |
| PUT | `/v1/me/consents/:purpose` | guest | Grant/withdraw `{ granted, noticeVersion, forGuestId? }` | `PRV_NOTICE_VERSION_STALE` 409, `PRV_NOT_PARTY_MEMBER` 404, `PRV_NOT_GUARDIAN` 403 (forGuestId not a child of my party) |
| GET | `/v1/weddings/:weddingId/consents/summary` | owner, co_host, planner_member | Counts per purpose | 404 other wedding |
| GET | `/v1/weddings/:weddingId/guests/:guestId/consents` | owner, co_host, planner_member | One guest's consent status (no history text) | desk_staff → 404 |
| POST | `/v1/me/data-requests` | guest | `{ kind: export|erasure, guestIds? }` (primary may include party members); `Idempotency-Key` | `PRV_REQUEST_ALREADY_OPEN` 409, `PRV_STEP_UP_REQUIRED` 401 (OTP older than 10 min) |
| GET | `/v1/me/data-requests` | guest, host | My requests + status | — |
| POST | `/v1/me/data-requests/:id/cancel` | guest, host | Cancel during undo window | `PRV_REQUEST_NOT_CANCELLABLE` 409 |
| GET | `/v1/me/data-requests/:id/export` | guest, host | Presigned GET (5 min) for the export zip | `PRV_STEP_UP_REQUIRED` 401, `PRV_EXPORT_EXPIRED` 410 |
| POST | `/v1/weddings/:weddingId/guests/:guestId/erase` | owner, co_host | `{ when: "scheduled"|"now" }`; scheduled = 7-day undo | `PRV_GUEST_HAS_OPEN_REQUEST` 409 |
| GET | `/v1/weddings/:weddingId/data-requests` | owner, co_host | Requests touching this wedding (fiduciary view) | — |
| GET | `/v1/weddings/:weddingId/retention` | owner, co_host, planner_member | Rows of `wedding_retention_state` + purge date | — |
| POST | `/v1/weddings/:weddingId/deletion` | owner | Request whole-wedding deletion (7-day undo) | `PRV_WEDDING_LIVE` 409 (event within ±2 days; needs `confirmLive: true`) |
| DELETE | `/v1/weddings/:weddingId/deletion` | owner | Cancel during undo | `PRV_REQUEST_NOT_CANCELLABLE` 409 |
| POST | `/v1/me/account/deletion` | host | Delete host account (Apple 5.1.1(v)) | `PRV_OWNER_HAS_WEDDINGS` 409 (sole owner of a non-purged wedding: transfer or delete first) |
| POST | `/v1/me/account/export` | host | Export host account data | `PRV_REQUEST_ALREADY_OPEN` 409 |
| POST | `/v1/privacy/web-requests` | public (lite web form) | Play-required web deletion request: `{ contact, kind }` → OTP/email link to verify | rate-limited 5/h/IP; always 202 (no account enumeration) |
| POST | `/v1/privacy/web-requests/verify` | public | Verify code → request moves `verifying → scheduled` | `PRV_VERIFY_FAILED` 400 |
| GET | `/v1/admin/data-requests?status=&overdue=` | platform_staff (support, admin) | SLA queue; ids and statuses only | 404 if not staff |
| POST | `/v1/admin/data-requests/:id/retry` | platform_staff (admin) | Re-run failed steps | — |
| POST | `/v1/admin/retention/dry-run` | platform_staff (admin) | Dry-run counts for next 7 days | — |

### Examples

`PUT /v1/me/consents/photos`
```json
{ "granted": true, "noticeVersion": "guest-2027.1", "forGuestId": null }
→ 200 { "purpose": "photos", "granted": true, "grantedAt": "2027-04-10T06:12:00Z", "noticeVersion": "guest-2027.1" }
```
If a newer notice with `requires_reconsent` is effective → `409 { "error": { "code": "PRV_NOTICE_VERSION_STALE", "message": "Please review the updated notice" } }` and the app re-shows the notice.

`POST /v1/me/data-requests` (guest, `Idempotency-Key: 6b1f…`)
```json
{ "kind": "erasure", "guestIds": ["<me>", "<child member>"] }
→ 202 { "id": "…", "status": "scheduled", "notBefore": "2027-04-17T06:12:00Z", "dueAt": "2027-04-17T06:12:00Z",
        "willDelete": ["rsvps","travel","tickets","own_photos","messages","consents","guest_record"] }
```
Guest-initiated erasure has **no undo window** (`not_before = now()`) but runs at most once per hour per wedding to batch; host-initiated deletes get 7 days.

`GET /v1/weddings/:id/retention`
```json
{ "purgeAfter": "2028-04-20T18:30:00Z",
  "classes": [ { "dataClass": "tickets", "expiresAt": "2027-04-27T18:30:00Z", "done": false }, … ] }
```

## 5. Jobs, events and realtime

### The `PurgeParticipant` interface

Lives in `apps/api/src/common/privacy/purge.ts`. Every module that stores personal data exports one from its `index.ts` and registers it in `modules/privacy/registry.ts`. A CI test fails if a Prisma model with a `guest_id`, `party_id`, `user_id` or `wedding_id` column is not claimed by some participant (`claims: string[]`).

```ts
export type PurgeSubject =
  | { kind: 'guest'; weddingId: string; guestId: string }
  | { kind: 'party'; weddingId: string; partyId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'wedding'; weddingId: string }
  | { kind: 'data_class'; weddingId: string; dataClass: DataClass };   // retention

export interface PurgeContext {
  tx: Prisma.TransactionClient;   // one transaction per participant step
  objects: ObjectStore;           // S3 or FakeObjectStore; deletes are queued, run after commit
  requestId: string | null;       // null for retention runs
  now: Date;
  dryRun: boolean;
  log: Logger;                    // never log subject PII
}

export interface PurgeResult {
  rowsDeleted: Record<string, number>;
  rowsAnonymised: Record<string, number>;
  s3Keys: number;
}

export interface PurgeParticipant {
  module: ModuleName;             // 'face' | 'idv' | ...
  order: number;                  // lower runs first (leaves before roots)
  claims: string[];               // table names this participant is responsible for
  dataClasses: DataClass[];       // retention classes it handles
  /** Must be idempotent: running twice deletes nothing more and does not fail. */
  purge(ctx: PurgeContext, subject: PurgeSubject): Promise<PurgeResult>;
  /** Section of a data export (JSON-serialisable + media keys). Null = nothing held. */
  export(ctx: PurgeContext, subject: Exclude<PurgeSubject, { kind: 'data_class' }>): Promise<ExportSection | null>;
  /** Rows/objects still present for the subject after purge; must be 0 for completion. */
  verify(ctx: PurgeContext, subject: PurgeSubject): Promise<number>;
}
```

**Order** (leaves first, `gst` last because others reference guests):

| Order | Module | What it does for a guest |
| --- | --- | --- |
| 10 | `face` | delete selfie objects, embeddings, matches |
| 20 | `idv` | delete ID objects; on wedding purge schedule KMS key deletion |
| 30 | `quiz`, `feed` | delete answers, posts, reactions by the guest |
| 40 | `media` (CAM/GAL) | own uploads: delete (erasure) or unattribute (photos-consent withdrawal with "keep"); reports, favourites |
| 50 | `rooms`, `pickups` | delete assignments |
| 60 | `travel`, `arrivals` | delete travel, tickets (S3), status updates, check-ins |
| 70 | `messaging` | anonymise deliveries (null phone, provider ids, rendered body; keep counts), delete inbound replies, suppressions keep **hash** of phone so STOP still applies |
| 75 | `rsvp` | delete responses (headcount recomputed) |
| 80 | `access` | revoke sessions/devices, OTP rows, `push_devices` |
| 85 | `audit` (ROL) | under `SET LOCAL mehfil.audit_maintenance = 'on'` (10-rol trigger), scrub `before`/`after` of rows with `entity_id = guest` → `{"redacted":true}`, set `redacted_at`; keep action/time |
| 90 | `privacy` | consents removed (cascade), ledger entry written |
| 95 | `guests` (GST) | hard delete guest; delete party if no members left; rotate link token |

Wedding scope runs the same list with `kind: 'wedding'` (FACE first: its `ON DELETE RESTRICT` FK needs `faces.purgeWedding`), then tombstones the `weddings` row and deletes the S3 prefix `weddings/<id>/` (batched `DeleteObjects`, 1,000 keys/call).

### Queues and crons (pg-boss)

| Job | Queue | Trigger | Payload | Notes |
| --- | --- | --- | --- | --- |
| `prv.request.process` | default | on create (`startAfter = not_before`) + cron `*/10` picks missed | `{ requestId }` | `singletonKey = requestId`; steps resume; retry 5× exp. backoff; failure after 5 → `failed` + ops alert |
| `prv.export.build` | media | from request job | `{ requestId }` | Streams sections + media into a zip in the exports bucket; expires 7 d |
| `prv.retention.media` | default | cron `*/15 * * * *` | — | `delete_after <= now() AND status <> 'deleted'` LIMIT 1000 per loop, until empty or 10 min |
| `prv.retention.classes` | default | cron daily 02:30 IST | — | due rows in `wedding_retention_state` → participant `purge({kind:'data_class'})` |
| `prv.retention.weddings` | default | cron daily 03:00 IST | — | `purge_after <= now()` → creates `data_requests(scope='wedding', channel='retention')` |
| `prv.retention.recompute` | default | events | `{ weddingId }` | rewrites `wedding_retention_state` and bulk-updates `media_objects.delete_after` |
| `prv.purge.warn` | messaging | cron daily 10:00 IST | — | owner notices at −30 d / −7 d |
| `prv.ledger.mirror` | default | cron `*/5` | — | uploads unmirrored ledger rows as JSON lines to `mehfil-prod-prv-ledger` |
| `prv.sla.watch` | default | cron hourly | — | requests with `due_at < now() + 48h` not completed → ops alert `prv_sla` |

### Domain events

| Emits | Consumers |
| --- | --- |
| `privacy.consent_changed { weddingId, guestId, purpose, granted }` | CAM (disable camera), FACE (delete within 24 h), IDV, MSG (marketing suppression) |
| `privacy.subject_erased { weddingId, scope, subjectId }` | RSV/ARR (recompute headcount; SSE refresh), OPS counters |
| `privacy.wedding_purge_scheduled { weddingId, purgeAfter }` | MSG (owner notice), BIL |

| Consumes | Action |
| --- | --- |
| `wedding.dates_changed`, `wedding.created` (SET) | `prv.retention.recompute` |
| `billing.plan_changed`, `billing.addon_purchased` (BIL) | `prv.retention.recompute` |
| `guest.removed` (GST soft delete) | create host-initiated erasure request with 7-day `not_before` |

Realtime: none of its own; erasures emit the ARR/RSV SSE refresh via the consumer modules.

## 6. Mobile app

| Mode | Screen | Contents |
| --- | --- | --- |
| Guest | **Consent** (ACC-04, first open) | Short layered notice (3–5 bullets, icon + label), "Read full notice", core toggle required, photos asked later in context, marketing unticked. For a primary with child members: one line "I consent for my children: Aarav, Myra". |
| Guest | Settings → **Privacy** | Per-purpose toggles with plain consequence text; "Download my data"; "Delete my data" (choose members if primary); request status card; notice version + link. |
| Guest | Re-consent sheet | Shown on `PRV_NOTICE_VERSION_STALE`: "What changed" + accept. |
| Host | Wedding → Settings → **Privacy & retention** | Retention timeline from `/retention`; "Extend storage" CTA; "Delete this wedding". |
| Host | Guest detail → **Delete permanently** | Confirmation with what gets deleted; 7-day undo banner. |
| Host | Wedding → **Data requests** (owner, co-host) | List and status. |
| Host | Account → **Delete account**, **Download my data** | Required by Apple 5.1.1(v) and Play. |

- Query keys: `['privacy','notice',audience,locale]` (stale 24 h, persisted to MMKV so the consent screen works offline after first load), `['me','consents']`, `['me','dataRequests']`, `['wedding',id,'retention']`, `['wedding',id,'consents','summary']`.
- Offline: consent changes queue like other guest mutations but **withdrawals are applied locally at once** (camera disabled immediately) and sent when online.
- Deep link: `mehfil://privacy` and `https://<domain>/g/<token>/privacy` open the Privacy screen.
- Accessibility: notice text respects large-text mode; toggles have explicit on/off labels, not colour; tested with the over-60 panel (GH-05).
- Native permission strings (camera, photos, contacts for GST-08 host import, notifications) written to match the notice purposes; Android 13+ uses the system photo picker (no `READ_MEDIA_IMAGES`, avoiding Play's restricted-permission declaration).

## 7. Guest lite web

Applicable — the no-install path must stay compliant.

| Route | Purpose |
| --- | --- |
| `GET /privacy`, `/privacy/:locale` | Public notice (current version), linked from store listings, WhatsApp templates and the site |
| `GET /g/:token/consent` | First-open consent for lite web (same API as the app) |
| `GET /g/:token/privacy` | Toggles, request export/erasure, status |
| `GET /privacy/delete` | **Play-required web deletion page**: explains the process; form (phone or email) → OTP / email link → request. Also used by hosts who uninstalled the app. |

Pages set `Referrer-Policy: no-referrer`, `Cache-Control: no-store` for `/g/*`, and no third-party scripts.

## 8. Security and privacy

### Roles

| Action | owner | co_host | planner_member | desk_staff | guest | platform_staff |
| --- | --- | --- | --- | --- | --- | --- |
| See consent summary / one guest's status | ✓ | ✓ | ✓ | ✗ (404) | own party | ✗ |
| Erase a guest | ✓ | ✓ | ✗ | ✗ | self + own children | ✗ |
| Delete wedding | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View data requests | ✓ | ✓ | ✗ | ✗ | own | ids/status only |
| Retry/cancel request | ✗ | ✗ | ✗ | ✗ | cancel own | admin |

Planner members cannot erase guests by default because the family (owner) is the fiduciary-facing party; PO can change it (open question).

### Encryption at rest (PRV-04)

| Asset | Control |
| --- | --- |
| EC2 root + Postgres data EBS volumes | "EBS encryption by default" on in `ap-south-1`; AWS-managed key; snapshots inherit |
| Media bucket (`mehfil-prod-media`) | SSE-S3 default encryption, Block Public Access, bucket policy denies non-TLS (`aws:SecureTransport`), versioning **on** with lifecycle "expire noncurrent versions after 7 days" so deletions become real, abort multipart after 1 day |
| ID bucket (`mehfil-prod-idv`) | SSE-KMS with per-wedding CMK (IDV design); no CloudFront |
| Exports bucket | SSE-S3; lifecycle expire 7 d |
| Backups: pgBackRest repo (`mehfil-prod-pgbackrest`) | `repo1-cipher-type=aes-256-cbc` (passphrase in SSM) **and** SSE-KMS (backup CMK) |
| Backups: nightly `pg_dump` (`mehfil-prod-dumps`) | `pg_dump -Fc | age -r <pubkey>`; private key offline (two custodians, password manager + sealed paper); bucket SSE-KMS, **Object Lock (compliance, 35 d)**, writer role has `PutObject` only; copy to `ap-south-2` (Hyderabad) — data stays in India |
| PRV ledger bucket | SSE-S3, Object Lock governance 1 year, ids only |
| Column-level | ID vault envelope encryption (IDV); link tokens, refresh tokens and OTPs stored hashed (baseline) |
| In transit | TLS 1.2+ at Nginx (Let's Encrypt), HSTS; Postgres listens on `127.0.0.1` only |

### Least-privilege IAM

| Principal | Allowed | Not allowed |
| --- | --- | --- |
| EC2 instance role `mehfil-prod-app` (api + worker) | media bucket `Get/Put/DeleteObject` on `weddings/*`; exports bucket; IDV bucket + `kms:GenerateDataKey/Decrypt` on keys tagged `app=mehfil-idv`; `ssm:GetParametersByPath /mehfil/prod/*`; CloudWatch agent | IAM, KMS key admin, any `*` resource, backup buckets |
| Instance role session for backups (separate role assumed only by the `postgres` OS user's pgBackRest / dump scripts) | pgBackRest bucket RW; dumps bucket `PutObject` only; ledger bucket `PutObject` | reading dumps, deleting dumps |
| GitHub Actions deploy (OIDC, no long-lived keys) | `ssm:SendCommand` to the instance tag `role=mehfil-prod`, artefact bucket `PutObject` | everything else |
| Humans | IAM Identity Center + MFA; break-glass admin; root has MFA and no keys | SSH keys shared; port 22 open (use SSM Session Manager) |
| Account-wide | CloudTrail (all regions, to a locked bucket), GuardDuty, IAM Access Analyzer, AWS Budgets alert | — |

Separating api and worker into different roles on one box only protects against bugs, not a box compromise; not worth it now (revisit when the worker moves to its own box).

### Secrets

| Secret | Where | Rotation |
| --- | --- | --- |
| DB password, JWT signing keys (two active `kid`s), BSP key + webhook secret, SMS/DLT creds, FCM service account, Razorpay keys, pgBackRest cipher pass, Google OAuth web client secret (admin) | SSM Parameter Store SecureString `/mehfil/prod/*` → `infra/scripts/render-env.sh` writes `/srv/mehfil/.env` (0600, owner `mehfil`) at deploy | JWT: 90 d overlap via `kid`; provider keys yearly or on staff exit; DB on staff exit |
| `age` private key for dumps | offline only | on custodian change |
| Not secrets | Google client IDs, Sentry DSN, bucket names | — |

`gitleaks` in pre-commit and CI; Pino redaction paths for `authorization`, `cookie`, `*.phone*`, `*.otp*`, `*.token*`, `/g/<token>` URLs; Nginx `log_format` rewrites `/g/[^/ ]+` to `/g/:token`; Sentry `beforeSend` scrubs the same.

### Pre-pilot security review checklist (PRV-05)

**OWASP API Security Top 10 (2023)**

| Risk | Mehfil check | Evidence |
| --- | --- | --- |
| API1 BOLA | Every wedding route returns 404 for a member of another wedding; id-only routes (`/v1/uploads/:mediaId/complete`, `/v1/me/data-requests/:id`) check ownership | **Route-coverage isolation test** (below) |
| API2 Broken authentication | Google ID token audience check; `aud` host vs guest enforced; refresh reuse revokes family; `DEV_AUTH_ENABLED` refuses to boot in prod | unit + e2e tests |
| API3 Broken object property level auth | Zod `.strict()` on inputs (no mass assignment); serialisers mask phone/ID for desk staff | ROL-02 per-role snapshot tests |
| API4 Unrestricted resource consumption | Pagination max 200; upload size/type in presign; export and zip jobs capped; rate limits on OTP, link lookup, web-request form | load test + config review |
| API5 BFLA | Every route declares an action in `permissions.ts`; test enumerates routes and fails if one is missing | CI test |
| API6 Sensitive business flows | **OTP/SMS pumping**: +91 only by default, per-number 3/h, per-wedding daily OTP budget, per-IP limit; announcement sends metered (MSG-09) | ACC-05 tests, cost alert |
| API7 SSRF | No user-supplied URL is fetched server-side (maps links rendered, not fetched; Sheets import uses fixed Google endpoints with URL allowlist) | code review |
| API8 Misconfiguration | `/v1/docs` off in prod; `helmet`; CORS allowlist; Nginx TLS config (Mozilla intermediate); S3 public access block; Postgres localhost only; UFW 80/443 only | scripted check `infra/scripts/prod-audit.sh` |
| API9 Improper inventory | OpenAPI is the inventory; staging and prod only; no old versions | review |
| API10 Unsafe consumption of APIs | BSP webhook HMAC verified, replay window 5 min; Google tokens verified with library; Razorpay signatures | tests with fakes |

**Token-link threat model**

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Link forwarded to the family WhatsApp group | New device → OTP to a phone in the party; device remembered 90 d | Someone holding a party phone can still enter (accepted) |
| Link posted publicly | OTP + rate limits; host can rotate (ACC-01); lookups of rotated tokens 404 | — |
| Token brute force | 128-bit token; 404 identical for unknown/rotated; per-IP limit + spike alert | negligible |
| Token in logs, Referer, analytics, crash reports | Nginx log rewrite; Pino/Sentry scrub; `Referrer-Policy: no-referrer`; no third-party scripts on lite web | — |
| Android App Link / iOS Universal Link hijack | Verified `assetlinks.json` / `apple-app-site-association`; no custom scheme carries the token | — |
| Recycled phone number receives OTP | Host can edit phone + rotate link; OTP message names the wedding so a stranger knows to ignore | Accepted, documented |
| OTP interception / social engineering ("tell me the code") | OTP template says "never share"; codes expire 10 min; 5 attempts → 15 min lockout | — |
| Shared family phone, child acting | Member switcher attributes actions (ACC-03); erasure/export need fresh OTP (step-up) | — |
| Session theft from lost phone | Guest refresh per device, host can "sign out all devices" for a party | — |

**Tenant isolation tests** — `apps/api/test/isolation.e2e.ts`: seeds weddings A and B with every role; iterates over the OpenAPI registry; for each route with `:weddingId` or a resource id, calls it as each role of A against B's ids and asserts **404** and no B data in the body. A route without a fixture builder fails the test ("add an isolation fixture"). Plus SSE: subscribing to B's channel with A's token → 404.

Output of PRV-05: checklist filled in `docs/security/prepilot-review.md` (implementation-time), issues filed, **no open high** at Gate 2.

### Store privacy disclosures (PRV-06, new)

| Data | Apple App Privacy category | Play data safety | Linked to user | Purpose |
| --- | --- | --- | --- | --- |
| Name, phone, email | Contact Info | Personal info | Yes | App functionality |
| Photos/videos uploaded | User Content → Photos or Videos | Photos and videos | Yes | App functionality |
| Travel details (flight/train no., times) | User Content → Other | App info/other — "Other user-generated content" | Yes | App functionality |
| Government ID copies (IDV) | Sensitive Info? → **counsel**; at least "Other Data" | Personal info → Other info | Yes | App functionality |
| Selfie + face matching (FACE) | **counsel** (biometric) | Photos + Personal info | Yes | App functionality, opt-in |
| Device push token, user id | Identifiers → User ID, Device ID | Device or other IDs | Yes | App functionality |
| Crash and performance data (Sentry) | Diagnostics | App info and performance | Yes (user id tag) | Analytics/diagnostics |
| Location | **Not collected** (venue pins are host-entered) | Not collected | — | — |
| Tracking / ads | None | No data shared for ads | — | — |

Play form also: data encrypted in transit **yes**; users can request deletion **yes** (in-app + `/privacy/delete` URL); SDKs declared: Firebase Messaging, Google Sign-In, Sentry. Apple: privacy policy URL `/privacy`; in-app account deletion for hosts; purpose strings for camera, photos, contacts.

### Audit entries

`privacy.consent_granted|withdrawn` (actor guest), `privacy.request_created|cancelled|completed`, `privacy.guest_erased` (actor user, `after = {counts}`), `privacy.wedding_deletion_requested|purged`, `privacy.export_downloaded`. No PII in `before`/`after`.

### Breach readiness

DPDP requires notifying the Data Protection Board and affected principals. Runbook (`docs/ops/runbooks/breach.md` at implementation): contain → assess with CloudTrail/GuardDuty/audit_log → counsel → notify Board (72 h under the Rules — counsel to confirm) and hosts/guests via MSG. `erasure_ledger` and `audit_log` support the assessment.

## 9. Scale and performance

| Stress point | Load | How it holds |
| --- | --- | --- |
| Consent check on every camera upload / face match | 300 uploads/min | `consents_one_active` index-only scan; cached in the guest JWT claims for 15 min (`cns: ["core","photos"]`), invalidated on change by forcing token refresh |
| Media expiry after season | 50 weddings × ~5k photos × 2–3 objects ≈ 750k objects in a week | Batches of 1,000 via `DeleteObjects`; 15-min cron with 10-min budget ⇒ ~400k objects/hour capacity; runs 01:00–06:00 IST preferred |
| Whole-wedding purge | 2,000 guests, 100k rows | One participant per transaction, deletes in 5,000-row chunks to avoid long locks; S3 prefix delete after commit |
| Erasure during a live wedding | single guest | Per-module small transactions; `privacy.subject_erased` triggers SSE refresh |
| Export zip | Guest's own photos (≤ 200) | Streams to S3 multipart from the media worker; never buffers in memory |

## 10. Testing plan

| Level | Tests |
| --- | --- |
| Unit | `retention.ts` table (plan × class × add-on × timezone end-of-day); notice version selection; consent state machine; guardian rule for children |
| API e2e (local Postgres) | consent grant/withdraw/stale; erasure of a guest touches every participant and `verify()` returns 0 for all (`purge-completeness.e2e.ts` seeds one row in every claimed table); idempotent re-run; resume after a participant throws; host delete undo; wedding purge leaves tombstone and invoices; isolation harness; web-request form never reveals existence |
| CI guard | every Prisma model with personal-data columns is claimed by a participant; every route has an isolation fixture and a permission action |
| Jobs | retention dry-run against seeded data; `FakeObjectStore` asserts keys deleted and noncurrent-version lifecycle config present (infra test) |
| Restore drill | after OPS-06 restore, `prv:replay-erasures` removes subjects erased after the restore point |
| Mobile | RNTL: consent screen (child consents), toggles offline, delete flow confirmation; device check of notice in large-text mode |
| Manual | store forms reviewed against the SDK list each release |

Fakes: `FakeObjectStore`, `LogSinkProvider`, fake clock for retention.

## 11. Story breakdown

| Story | Tasks | Backlog pts | Revised | Why |
| --- | --- | --- | --- | --- |
| **PRV-01** Notice and consent records | `[DB]` notices, texts, consents alter, user acceptances · `[API]` notice + consent endpoints, stale-version 409, JWT consent claims · `[MOB]` re-consent sheet, privacy settings screen (consent screen itself in ACC-04) · `[WEB]` `/privacy`, `/g/:token/consent` · `[TEST]` e2e + children rule | 2 | **3** | Versioning, re-consent and parental consent for children were not in scope. **Move to S4** with ACC-04. |
| **PRV-02a** Erasure framework (P0\*) | `[API]` `PurgeParticipant` contract + registry + CI claim test · `[JOB]` `prv.request.process` with steps/resume · `[DB]` requests, steps, ledger · `[API]` guest + host erase endpoints, undo · `[OPS]` ledger bucket + mirror · `[TEST]` completeness e2e | 3 (whole PRV-02) | **5** | Cross-module ordered purge with proof is the bulk of the work. Each module's own participant is **~0.5 pt added to that module's stories** (add to DoD: "personal data claimed by a PurgeParticipant"). |
| **PRV-02b** Export + web request + account deletion | `[JOB]` export zip · `[API]` export download with step-up, host account delete/export, web request + verify · `[MOB]` host account screens, guest download/delete · `[WEB]` `/privacy/delete` · `[TEST]` | (in PRV-02) | **3** | Apple 5.1.1(v) and Play web-deletion URL add host-account paths. |
| **PRV-03** Retention jobs (P0\*) | `[DB]` `wedding_retention_state`, weddings alter, runs · `[API]` `/retention` · `[JOB]` media, classes, weddings, recompute, warn crons · `[OPS]` S3 lifecycle (exports, noncurrent versions, multipart) · `[MOB]` host retention screen · `[TEST]` dry-run, tz edge | 3 | **5** | Recompute on date/plan change, owner warnings, tombstone, noncurrent-version handling. |
| **PRV-04** Encryption and least privilege | `[OPS]` EBS default encryption, bucket policies, KMS backup key, Object Lock dumps bucket, `age` key ceremony, IAM roles, OIDC deploy role, SSM params + `render-env.sh`, CloudTrail/GuardDuty, gitleaks, log redaction config | 2 | **3** | Self-hosted DB means we own backup encryption and key custody that RDS would have done. Pair with FND-11. |
| **PRV-05** Pre-pilot security review | `[TEST]` isolation harness, permission-coverage test · `[OPS]` `prod-audit.sh` · threat model + OWASP pass · fix budget | 3 | **5** | Harness that enumerates routes is new code; reserve ~2 pts of fixes. External pen test stays in S21. |
| **PRV-06** Store privacy disclosures (new) | App Store privacy label, Play data safety form, permission purpose strings, SDK inventory, review with counsel | — | **2** | Required before the first App Store / Play closed-track submission. The RN app is the main client from MVP, so this lands in **S8**, not S18. |
| **Total** | | **13** | **26** | (+ ~0.5 pt per data-holding module in other epics) |

## 12. Dependencies and sequencing

| Needs | From | Why |
| --- | --- | --- |
| VAL-13 notice + terms text, purposes, children wording | Founder + counsel | PRV-01 content |
| `consents`, `media_objects`, `audit_log`, `weddings` | core | — |
| ACC-01/02 guest JWT, OTP step-up helper | E05 ACC | consent and request auth |
| GST soft delete emits `guest.removed` | E04 GST | host delete flow |
| Every data-holding module exports a `PurgeParticipant` | E04, E06–E09, E12–E13, E15–E17, E19, E21–E23 | PRV-02a completeness test fails otherwise; land the contract **before S5** so modules built from S5 include it, back-fill S2–S4 modules in S9 |
| `billing.plan_changed`, `retention_extended_until` writer | E23 BIL | recompute (stub until S16; pilots are on a fixed plan) |
| IDV per-wedding KMS keys | E17 IDV | wedding purge schedules key deletion |
| FND-11 prod environment, OPS backups | E01, E26 | PRV-04 controls are applied there |
| `platform_staff` | this file (shared with E26). **23-bil.sql defines a separate `platform_admins`** — BIL should reuse `platform_staff` (`staff_role = 'admin'`) | admin views |
| Store accounts, app ids | APP / FND | PRV-06 |

## 13. Risks and open questions

| # | Item | Owner |
| --- | --- | --- |
| 1 | **Fiduciary vs processor.** For guest data the host family (or planner) decides purposes; Mehfil is likely a Data Processor for guest data and a Fiduciary for host accounts and its own marketing. Affects notice wording, who answers requests, and the host terms (DPA clause). | Counsel (VAL-13) |
| 2 | **Lawful basis before first open.** The host imports guests and the first WhatsApp invite is sent before any guest consent. Options: rely on the host's own relationship + notice link in the invite template; or treat a WhatsApp RSVP button tap as consent with a notice link. | Counsel + PO |
| 3 | Free-plan photo retention N months (proposed **3**). | PO |
| 4 | Default on photos-consent withdrawal: keep own uploads unattributed (proposed) vs delete. | PO |
| 5 | Can planner members erase guests? (proposed no) | PO |
| 6 | **App Store guideline 4.8**: a third-party login (Google) requires an equivalent privacy-preserving option such as Sign in with Apple for host sign-in on iOS. Not in the baseline. | PO + FND/APP |
| 7 | Apple / Play classification of ID copies and face data (biometric). | Counsel |
| 8 | Backups keep erased data up to 35 days; must be stated in the notice. | Counsel |
| 9 | DPDP Rules phase-in dates and breach-notification window. | Counsel |
| 10 | Photos where an erased guest *appears* but didn't upload: not findable without face search. Handled by GAL-03 report + host hide; FACE could help if opted in. | Accepted |

## 14. Deviations from the baseline

| Baseline says | This design | Action |
| --- | --- | --- |
| Secrets: `.env` on the server | `.env` still used, but rendered at deploy from **SSM Parameter Store** | Add one line to the Stack table "Secrets / keys" |
| Backups: nightly encrypted `pg_dump` to S3 | Adds **pgBackRest WAL archiving / PITR** (designed in 26-ops) and specifies `age` encryption, Object Lock, `ap-south-2` copy | Update Deploy row |
| No platform/staff role | New `platform_staff` table and `/admin` area (shared with 26-ops) | Add to Identity and auth |
| Core `weddings` | Adds `retention_extended_until`, `deletion_requested_at`, `purge_after`, `purged_at`; wedding rows are tombstoned, not deleted | Note in Data section |
| Host sign-in is Google SSO only | iOS likely needs Sign in with Apple (risk 6) | PO decision; FND-05 change if accepted |
