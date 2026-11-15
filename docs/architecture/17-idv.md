# E17 — ID vault (IDV)

Status: design · Owner module: `apps/api/src/modules/idvault` · App: `apps/mobile/src/features/idvault` · SQL: [`sql/17-idv.sql`](./sql/17-idv.sql)

## 1. Summary

Hotels need a government ID for every guest at check-in. The ID vault lets guests (or hosts on their behalf) upload a photo of each member's ID **once, before travel**, keeps it in a **separate S3 bucket encrypted with a per-wedding AWS KMS key**, lets only the owner/co-host (and named grantees) **view a watermarked copy, with every view logged**, builds a **hotel export** of selected guests, and **auto-deletes everything 3–7 days after the wedding by crypto-shredding** the wedding's key.

| Story | Plan | Proposed |
| --- | --- | --- |
| IDV-01 Encrypted ID upload | Pilot · S11 | **Split:** IDV-01a vault + KMS + API (S11); IDV-01b app upload flow (S11) |
| IDV-02 Restricted view with logging | S11 | S11 |
| IDV-03 Export for hotel | S11 | **S12** (fits after IDV-02; S11 overloads) |
| IDV-04 Auto-delete | S11 | S11 |
| IDV-05 Vault security review | S12 | S12 (external; needs IDV-03 done) |

**Stack reinterpretation.** Upload happens in the React Native Guest mode (camera or photo picker) through the shared upload queue in `sensitive` mode; views happen in Host mode on a screenshot-protected screen. No guest lite web flow. "Envelope encryption with a per-wedding KMS key" is implemented as **SSE-KMS with one KMS key per wedding** (S3 does the per-object data-key envelope; the per-wedding key is the key-encryption key we can destroy).

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Key hierarchy | **One customer-managed KMS key per wedding** (created on first upload), used as the SSE-KMS key for that wedding's objects; S3 Bucket Keys off | One platform KMS key + per-wedding data key stored wrapped in Postgres, app-side AES-GCM | Crypto-shredding must also defeat backups: a wrapped DEK lives in 35 days of `pg_dump`s and pgBackRest WAL, a KMS key doesn't. Disabling the key makes every copy (versions, replicas, stray objects) unreadable at once. SSE-KMS is less code than our own crypto. |
| Where encryption happens | S3 server-side (SSE-KMS headers signed into the presigned PUT) | Client-side encryption in the app | The API must decrypt anyway to watermark; client crypto adds key distribution to phones for no gain. |
| Who can decrypt | App role, only via S3 (`kms:ViaService`), only keys tagged `app=mehfil-idv`; key admin actions (create, disable, schedule deletion) through a separate assumed role `mehfil-idv-keys` | App instance role with KMS admin | Least privilege (PRV-04 forbids KMS admin on the instance role). |
| Accepted files | JPEG/PNG images only, converted to JPEG ≤ 2,400 px; one row per side | PDFs | e-Aadhaar PDFs are password-protected and need a PDF renderer to watermark; a photo of the card (or masked Aadhaar screenshot) covers hotels. |
| Viewing | API decrypts, composites a tiled watermark (`sharp` + SVG: viewer, time, trace code) and streams it with `no-store`; access log row written **before** bytes are sent | Presigned GET of the stored image | Watermark and log can't be bypassed; trace code links a leaked copy to the log row. |
| View protection on device | Image held in memory only (data URI, no disk cache), `FLAG_SECURE` on Android, app-switcher blur on iOS, biometric/device-PIN gate before vault screens | Nothing | Cheap mitigations against casual screenshots and an unlocked phone. |
| Hotel export | Worker-built PDF (one page per document, watermark "For {recipient} check-in, {date}, {exportId}"), stored encrypted in the vault bucket, 24 h life, ≤ 3 downloads | Zip of images | Hotels print; one file; still watermarked and logged. |
| Deletion | PRV retention calls the IDV `PurgeParticipant` for class `id_documents` (+3 d default, host 3–7 d): **DisableKey (immediate) → delete objects → ScheduleKeyDeletion (7 d) → tombstone rows** | IDV's own separate cron | PRV already owns the per-wedding retention schedule (`wedding_retention_state`); one scheduler, one ledger. |
| Access log | Dedicated `idv_access_log` (kept after shredding) | `audit_log` only | High-volume, indexed by document and guest for the guest transparency view; admin actions still go to `audit_log`. |

## 3. Data model

DDL: [`sql/17-idv.sql`](./sql/17-idv.sql). **Schema check passed** (`scripts/check-schema.sh arch_idv 000-core.sql 17-idv.sql` → OK; also with all design files).

| Table | Purpose | Notes |
| --- | --- | --- |
| `idv_vaults` | One per wedding: status (`open`, `closed`, `shredding`, `shredded`), `kms_key_arn`, key state, `delete_after_days` (3–7), `uploads_close_at`, `extra_viewer_roles` (`planner_member` only), shred timestamps + `shred_report` | `weddings` FK is **ON DELETE RESTRICT**: a wedding can't be hard-deleted until the IDV participant shreds and removes the row. After a retention shred the row stays as a tombstone. |
| `idv_access_grants` | Named extra viewers (co_host/planner_member users), optional expiry | Desk staff can't be granted (service + matrix). |
| `idv_documents` | One live row per guest per side (`front`, `back`, `single`), doc type, status, `consent_id` (purpose `id_documents`), uploader | Tombstoned (`status='deleted'`, reason) rather than deleted, so the record of deletion survives. Unique live `(guest_id, side)`. |
| `idv_access_log` | Every view / export download: viewer, whose ID, `watermark_id` (unique trace code), IP, UA | Deleted only with the wedding. |
| `idv_exports` | Hotel exports: recipient label, guest ids, status, PDF `media_id`, download count/max, 24 h expiry | |
| `media_objects` (core) | `kind='id_document'` (and `export` for the PDF), `s3_bucket='mehfil-<env>-idv'` | Rows deleted at shred. |

Shred time = PRV `wedding_retention_state(wedding, 'id_documents').expires_at`, computed by PRV from `ends_on` + `idv_vaults.delete_after_days` (IDV emits `idv.settings_changed` so PRV recomputes).

### Bucket and key layout

```
mehfil-<env>-idv   (separate bucket; no CloudFront; versioning OFF; Block Public Access; TLS-only)
  incoming/{weddingId}/{mediaId}                 raw guest upload (SSE-KMS, wedding key)   lifecycle: expire 1 d
  weddings/{weddingId}/docs/{documentId}.jpg     sanitised image (SSE-KMS, wedding key)
  weddings/{weddingId}/exports/{exportId}.pdf    hotel export (SSE-KMS, wedding key)        lifecycle: expire 2 d (job deletes at 24 h)
```

Bucket policy: deny `PutObject` unless `s3:x-amz-server-side-encryption = aws:kms` and a key id header is present; deny non-TLS; deny all principals except the app role and break-glass admin; default encryption SSE-KMS with a platform fallback key. Versioning off so object deletes are real (crypto-shredding covers anything missed). CloudTrail **data events** on this bucket and KMS events (Decrypt carries the object ARN in its encryption context) give a second, tamper-resistant view log.

KMS key per wedding: description `mehfil idv <weddingId>`, tags `app=mehfil-idv`, `wedding=<id>`, `env=<env>`; key policy: account root (admin, break-glass), app role `Encrypt/Decrypt/GenerateDataKey/DescribeKey` with `kms:ViaService = s3.ap-south-1.amazonaws.com`, `mehfil-idv-keys` role `DisableKey/ScheduleKeyDeletion/DescribeKey`. No automatic rotation (keys live weeks).

## 4. API

Proposed ROL actions: `idv.view` (owner, co_host; + `extra_viewer_roles`; + grants), `idv.manage` (owner), `idv.export` (owner, co_host), `idv.summary` (owner, co_host, planner_member: counts only). Desk staff: none, ever (404).

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/guest/idv` | guest | Vault state, deletion date, per party member: status per side, "viewed N times" | `IDV_DISABLED` 404 |
| POST | `/v1/guest/idv/documents` | guest (self, or child member) | Create upload: `{ guestId, docType, side, contentType, byteSize, sha256 }` → presigned PUT with SSE-KMS headers; replaces the live doc for that side | `IDV_CONSENT_REQUIRED` 403, `IDV_UPLOADS_CLOSED` 409, `IDV_NOT_PARTY_MEMBER` 404, `MEDIA_TYPE_NOT_ALLOWED` 415, `MEDIA_TOO_LARGE` 413 |
| POST | `/v1/uploads/:mediaId/complete` | uploader | Generic complete (12-cam) → enqueues `idv.process_document` | — |
| GET | `/v1/guest/idv/documents/:id/view` | guest of the same party | Watermarked image (logged) | 404 |
| DELETE | `/v1/guest/idv/documents/:id` | guest of the same party | Delete now | 404 |
| GET / PATCH | `/v1/weddings/:wid/idv` | GET `idv.summary`; PATCH `idv.manage` | Settings (`deleteAfterDays`, `uploadsCloseAt`, `extraViewerRoles`, enabled) + counts | `IDV_DAYS_OUT_OF_RANGE` 400 |
| PUT / DELETE | `/v1/weddings/:wid/idv/grants/:userId` | `idv.manage` | Grant / revoke a named viewer | `IDV_GRANT_ROLE_NOT_ALLOWED` 422 (desk staff) |
| GET | `/v1/weddings/:wid/idv/documents?status=&missing=true&cursor=` | `idv.view` | Who has / hasn't uploaded (names, sides, status; no images) | — |
| POST | `/v1/weddings/:wid/idv/documents` | `idv.manage` | Host uploads on behalf (consent recorded via PRV `host_recorded`) | as guest upload |
| GET | `/v1/weddings/:wid/idv/documents/:id/view` | `idv.view` | Watermarked image (logged) | 404, 429 |
| DELETE | `/v1/weddings/:wid/idv/documents/:id` | `idv.manage` | Delete | — |
| POST | `/v1/weddings/:wid/idv/exports` | `idv.export` | `{ guestIds[], recipientLabel }`, `Idempotency-Key` → 202 | `IDV_EXPORT_EMPTY` 422 |
| GET | `/v1/weddings/:wid/idv/exports/:id` | `idv.export` | Status | `IDV_EXPORT_EXPIRED` 410 |
| POST | `/v1/weddings/:wid/idv/exports/:id/download` | `idv.export` | Logs, increments count, returns 60-s presigned GET | `IDV_EXPORT_DOWNLOAD_LIMIT` 409, 410 |
| GET | `/v1/weddings/:wid/idv/access-log?cursor=` | `idv.manage` | Views and downloads | — |
| POST | `/v1/weddings/:wid/idv/shred` | `idv.manage` | "Delete all IDs now" (typed confirmation) | — |

**Guest upload** — `POST /v1/guest/idv/documents`

```json
{ "guestId": "c1…", "docType": "aadhaar_masked", "side": "front",
  "contentType": "image/jpeg", "byteSize": 402113, "sha256": "q1Zr…=" }
```
→ `201`
```json
{ "documentId": "d4…", "mediaId": "7a…",
  "upload": { "method": "PUT",
    "url": "https://mehfil-prod-idv.s3.ap-south-1.amazonaws.com/incoming/2b4…/7a…?X-Amz-…",
    "headers": { "Content-Type": "image/jpeg", "Content-Length": "402113",
      "x-amz-checksum-sha256": "q1Zr…=",
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:ap-south-1:…:key/…" },
    "expiresAt": "2027-04-20T10:05:00Z" },
  "deletesOn": "2027-04-27" }
```

**Host view** — `GET /v1/weddings/:wid/idv/documents/d4…/view` → `200 image/jpeg`, headers `Cache-Control: no-store, private`, `X-Watermark-Id: K7Q2M9XD`. Order inside the handler: authorise → insert `idv_access_log` (fail → 503, nothing shown) → S3 GetObject (decrypt) → watermark → stream.

## 5. Jobs, events and realtime

| Job (queue) | Trigger | Payload | Behaviour |
| --- | --- | --- | --- |
| key provisioning (inline, not a job) | first upload | — | `SELECT … FOR UPDATE` on `idv_vaults`; if no key: assume `mehfil-idv-keys`, `CreateKey` with policy + tags; store ARN. ~200 ms once per wedding. |
| `idv.process_document` (`media`) | complete | `{ documentId }` | GetObject from `incoming/`, sniff JPEG/PNG, `limitInputPixels` 40 MP, `rotate()`, resize ≤ 2,400 px, JPEG q85 **without metadata**, PutObject to `weddings/{wid}/docs/{id}.jpg` (SSE-KMS, wedding key), delete raw, `ready`. No thumbnails, ever. Invalid → `rejected`. Previous live doc for the side → tombstoned `replaced` and its object deleted. |
| `idv.build_export` (`default`) | export created | `{ exportId }` | `pdfkit`: per document a page with guest name, doc type, side, watermark; PutObject encrypted; `ready`; push the requester. |
| `idv.expire_exports` (`default`, cron hourly) | — | — | Exports past `expires_at`: delete object, `expired`. |
| `idv.shred_reminder` (`default`, cron hourly) | — | — | Vaults whose PRV `id_documents` expiry is within 24 h and `reminder_sent_at` null: push owner "IDs will be deleted tomorrow at 03:00". |
| PRV `class_expiry` → IDV `PurgeParticipant` (order 20) | PRV daily cron 03:00 IST | `{ data_class: 'id_documents', weddingId }` | `status='shredding'` → **DisableKey** (crypto-shred, immediate) → list + `DeleteObjects` under `incoming/{wid}/` and `weddings/{wid}/` → **ScheduleKeyDeletion(7 d)** → tombstone docs (`retention`), cancel exports, delete `media_objects` rows → `shred_report`, `shredded` → `audit.record('idv.shred')` + PRV ledger. Each step idempotent; resumes from `status`. `verify()`: 0 objects listed and key state `Disabled`/`PendingDeletion`. |
| same participant, guest/party subject | erasure, `privacy.consent_changed` (`id_documents` withdrawn) | — | Delete that guest's objects + tombstone (`guest_erasure` / `consent_withdrawn`); key stays. |
| same participant, wedding subject | wedding purge | — | Shred if not yet, then delete the `idv_vaults` row (releases the RESTRICT). |
| `idv.shred_verify` (`default`, cron daily) | — | — | Shredded vaults: `DescribeKey` must be `PendingDeletion` or gone; else page on-call. |

Events emitted: `idv.document_ready`, `idv.shredded` (OPS dashboard). Consumed: `privacy.consent_changed`, `guest.deleted`. No realtime.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | `IdVaultHome` (from Home → "Hotel check-in IDs") | Per party member: status chips (Missing / Uploaded / Viewed 2×), deletion date, "Why we ask" |
| Guest | `IdConsentSheet` | Purpose, who can see it, deletion date, "Prefer **masked Aadhaar**" with how-to (DigiLocker / UIDAI), consent toggle (PRV); for children the primary consents as guardian; adults consent themselves (switch member, ACC-03) |
| Guest | `IdCapture` | VisionCamera with a card-shaped frame, front/back steps, or pick from gallery; preview + retake; never saved to the phone gallery |
| Host | `IdVaultDashboard` | Counts, missing list with "Remind" (MSG template), settings (owner) |
| Host | `IdViewer` | Biometric/PIN gate, `FLAG_SECURE`, watermarked image in memory, auto-close after 60 s idle |
| Host | `IdExport` | Select guests (filter by hotel via ROM when available), recipient label, status, Download → share sheet |
| Host | `IdAccessLog` (owner) | Who viewed whose ID, when |

Upload queue in `sensitive` mode: files in a no-backup directory with iOS `NSFileProtectionComplete`, deleted on completion or after 24 h; no "Save to my phone" action; not retried after 24 h. Query keys: `['guest','idv']`, `['wedding',wid,'idv']`, `['wedding',wid,'idv','documents',filters]`, `['wedding',wid,'idv','exports']`, `['wedding',wid,'idv','access-log']`; **never persisted** (`meta.persist` off), image bytes never in the query cache. Accessibility: step-by-step capture with large labels; works at 200 % font scale.

## 7. Guest lite web

Not applicable. Capturing and uploading an ID needs the app's camera and secure queue; lite-web guests see "Upload IDs in the Mehfil app" with store links, or the host uploads on their behalf at the desk.

## 8. Security and privacy

- **Consent:** active `id_documents` consent for the subject guest is required for upload and checked again at view; withdrawal deletes immediately (PRV).
- **Legal:** storing full Aadhaar copies is restricted under the Aadhaar Act/regulations; the flow pushes **masked Aadhaar** and passport/DL; full Aadhaar acceptance is a counsel decision (Q1).
- **Minimisation:** no OCR, no ID numbers in the database, no thumbnails, no CDN; metadata stripped; raw uploads ≤ 1 day.
- **Encryption:** SSE-KMS per-wedding key; TLS; key usage restricted to S3 and the app role; admin actions via a separate role.
- **Access:** owner + co_host by default; owner may add planner members by role or by name; desk staff never; 404 for everything else. Every view/download logged with a trace code that is printed in the watermark.
- **Rate limits / alerts:** views 60/hour per user; > 30 views in 10 min → push to owner + Sentry alert; export downloads ≤ 3.
- **Device:** biometric gate, `FLAG_SECURE`, no disk cache, sensitive upload queue.
- **Audit (`audit_log`):** `idv.settings.update`, `idv.grant`, `idv.revoke`, `idv.document.delete`, `idv.export.create`, `idv.shred`, `idv.key.create`.
- **Deletion proof:** `shred_report`, PRV ledger, CloudTrail `DisableKey`/`ScheduleKeyDeletion`.
- **Backups:** Postgres holds no key material and no images; restored backups can't decrypt shredded objects (key disabled/deleted). PRV ledger replay re-tombstones rows.

## 9. Scale and performance

Low volume: ~2,000 guests × ≤ 2 images ≈ 4,000 objects per wedding, mostly uploaded over weeks. A watermark render is ~80–120 ms (decode, SVG composite, encode) on the API process — fine at ≤ 60 views/hour/user; `sharp` runs on the libuv pool, so the event loop isn't blocked. A 500-guest export PDF (~1,000 pages, ~300 MB) is streamed page by page into a multipart upload. KMS: one `GenerateDataKey`/`Decrypt` per object operation, far below quotas. Cost: ~US$1 per key-month while a key exists plus negligible S3/KMS requests (verify pending-deletion billing in IDV-01a).

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Permission resolution (roles × extra roles × grants × expiry); watermark text building; shred state machine resume from each step. |
| API e2e (`FakeObjectStore`, `FakeKms`) | Upload needs consent (403 without, 404 for non-party member); replace tombstones old doc; desk staff 404 on every endpoint; planner 404 until granted; **view writes a log row before any bytes** (fault-inject log insert → 503, no body); export download limit; shred: key disabled before objects deleted, idempotent second run, `verify()` = 0; consent withdrawal deletes; wedding hard delete blocked until participant ran. |
| Integration (staging AWS, manual in IDV-05 prep) | Presigned PUT without SSE headers is rejected by bucket policy; object unreadable after `DisableKey`; app role cannot `ScheduleKeyDeletion` directly. |
| Mobile | RNTL: consent sheet, capture steps, viewer gate; device: `FLAG_SECURE` blocks screenshots on Android 9; iOS switcher blur. |
| Security | IDV-05 external review of upload, view, export, delete; tenant-isolation tests from PRV-05. |

Observability: metrics `idv_views_total`, `idv_shred_failures`; alerts: shred overdue (vault `open` past PRV expiry + 6 h), `shred_verify` failure, view-burst alert.

## 11. Story breakdown

| Story | Tasks | Pts (backlog → revised) | Why |
| --- | --- | --- | --- |
| **IDV-01a** Vault, keys and upload API | [DB] vaults, documents · [OPS] idv bucket + policy + lifecycle, `mehfil-idv-keys` role, CloudTrail data events · [API] key provisioning, upload create with SSE-KMS presign, settings · [JOB] `idv.process_document` · [TEST] incl. `FakeKms` | 5 → **5** | |
| **IDV-01b** App upload flow | [MOB] IdVaultHome, consent sheet (masked Aadhaar guidance), card-frame capture, sensitive queue mode · [TEST] | — → **3** | RN capture + sensitive queue weren't counted. |
| IDV-02 Restricted view with logging | [DB] grants, access log · [API] view with log-first + watermark, grants, access-log list, guest "viewed N times" · [MOB] IdViewer (biometric, `FLAG_SECURE`), dashboard, access log · [TEST] | 3 → **5** | Watermark, device protections, grants and transparency. |
| IDV-03 Export for hotel | [DB] exports · [API] create/status/download · [JOB] PDF build + expiry · [MOB] IdExport · [TEST] | 2 → **3** | PDF worker + download limits. |
| IDV-04 Auto-delete | [API] IDV `PurgeParticipant` (class, guest, wedding subjects) · [JOB] reminder, verify · [OPS] alarms · [TEST] shred e2e | 3 → **3** | PRV owns scheduling. |
| IDV-05 Vault security review | [OPS] external review, fixes | 3 → **3** | Unchanged. |
| **Total** | | **16 → 22** | |

## 12. Dependencies and sequencing

| Needs | From |
| --- | --- |
| Upload core (`/uploads` pattern, `complete`, `ObjectStore` with SSE options), upload queue | CAM-01a, CAM-05a, FND-13 (add SSE-KMS presign options) |
| Consent API incl. guardian consent, `privacy.consent_changed`, `PurgeParticipant`, retention class `id_documents` | PRV-01, PRV-02a, PRV-03 |
| Role matrix entries above; audit | ROL-02, ROL-03 |
| "Remind" for missing IDs | MSG-03 (template `idv_reminder`) |
| Hotel filter in export | ROM-02 (optional) |
| Biometric gate | APP (react-native-keychain access control) |

Sequencing: IDV-01a + 01b + 02 + 04 in S11 (16 pts — with ROM-02/03 and FACE-01, S11 reaches 26 + buffer; tight) → **move IDV-03 to S12** next to IDV-05 (S12 then 27 + 8).

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | Per-wedding KMS keys need an IAM path for key creation that PRV-04 doesn't have yet (deviation below). |
| R2 | Older guests may struggle to photograph IDs; host on-behalf upload at the desk is the fallback (consent recorded as `host_recorded`). |
| R3 | Screenshots on iOS can't be blocked; watermark trace codes deter and attribute leaks. |
| Q1 | **Counsel/PO:** accept full (unmasked) Aadhaar at all? Proposed: allow with a strong masked-Aadhaar nudge, or block `aadhaar` type entirely. |
| Q2 | **PO:** default `delete_after_days` 3 (PRV) — confirm; and is an earlier manual "delete now" enough for families who want it sooner? |
| Q3 | **PO:** should guests be told each time their ID is viewed (push), or only see a count? Default: count. |
| Q4 | **PO:** plan gating — PRV says Essentials and above; confirm IDV is not on Free. |

## 14. Deviations from the baseline

| Baseline / PRV says | This design | Why |
| --- | --- | --- |
| Baseline: "AWS KMS for ID-vault envelope keys"; PRV-04 lists "Column-level: ID vault envelope encryption" | Per-wedding KMS key used via SSE-KMS (S3-managed per-object envelope); no application-level column encryption | Same guarantee, less code; shredding works against backups. |
| PRV-04 IAM: app role may only `GenerateDataKey/Decrypt` on tagged keys, no KMS admin | Adds role `mehfil-idv-keys` (assumable by the app role) allowed `kms:CreateKey` with request tag `app=mehfil-idv`, and `DisableKey`/`ScheduleKeyDeletion`/`DescribeKey` on resources tagged `app=mehfil-idv` | Per-wedding keys must be created and destroyed by the app. **PRV-04's IAM table needs this row.** |
| PRV bucket table says nothing about IDV bucket versioning | Versioning **off** on `mehfil-<env>-idv` | Deletes are final; crypto-shredding covers the rest. |
| Backlog IDV-04 "auto-delete job" | PRV's retention cron drives it via the IDV `PurgeParticipant` | One scheduler (PRV). |
