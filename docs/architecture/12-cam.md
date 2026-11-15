# E12 — Disposable camera and media pipeline (CAM)

Status: design · Owner modules: `apps/api/src/modules/media` (generic uploads, `media_objects`, `media.process`) and `apps/api/src/modules/photos` (camera + gallery: `photos`, counters, event camera settings) · App: `apps/mobile/src/features/camera`, `apps/mobile/src/lib/upload-queue` · SQL: [`sql/12-cam.sql`](./sql/12-cam.sql)

## 1. Summary

Guests open a **native disposable camera** in the app's Guest mode (from the Camera tab, a WhatsApp link or a printed table QR), shoot up to N photos per event, and walk away: photos sit in a **persistent offline queue** and upload straight to **S3 with presigned PUTs** whenever the network allows. A **media worker** strips EXIF/GPS, applies the chosen **film look**, writes a sanitised original plus WebP preview/thumbnail and de-duplicates by SHA-256. Photos stay "developing" until the host's **reveal time**. This epic also delivers the **upload core** every other epic uses (tickets, cover photo, feed photos, selfies).

| Story | Phase / sprint (plan) | Proposed |
| --- | --- | --- |
| CAM-01 Signed direct-to-S3 uploads | MVP · S7 | **Split:** CAM-01a upload core → S3 (SET cover, GST files, TRV-02 need it); CAM-01b camera purposes + reconcile + S3/CloudFront config → S7 |
| CAM-02 Native camera (was "browser camera") | S7 | S7 |
| CAM-03 Shot limit | S7 | S7 |
| CAM-04 Film filter | S7 | S7 |
| CAM-05 Offline queue | S7 | **Split:** 05a persistent foreground queue → S7; 05b background drain → S9 |
| CAM-06 Delayed reveal (P0\*) | S9 | S9 |
| CAM-07 Media worker | S7 | S7 |
| CAM-08 Camera QR / link | S7 | S7 |

**Stack reinterpretation.** The backlog assumes a PWA: "browser camera", "client-side canvas filter", "IndexedDB queue", "presigned POST". Per the baseline these become: a **React Native** camera (`react-native-vision-camera`), a **server-side** film filter (decision below), a **filesystem + MMKV** queue with background retry, and **presigned PUT** with signed `Content-Length` and `x-amz-checksum-sha256`. The guest lite web page gets **no camera** (baseline: camera lives in the app); `/c/:code` on the web is a "get the app" landing page.

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Camera library | `react-native-vision-camera` (≥ 4.6, New Arch; version pinned after the S0 camera spike), shared with ARR's QR scanner | `expo-camera` (needs Expo modules, APP rejected them); system camera intent via `react-native-image-picker` as the *primary* path (no shot counter or filter UX, OEM process-death bugs) | Fastest first frame (Camera2/AVFoundation, format selection lets us ask for a small photo + 720p preview), maintained, already in the app for QR. `launchCamera` stays as the **fallback** when VisionCamera fails to initialise twice. |
| Film filter | **Server-side** in the media worker (`sharp` recipe: `recomb` colour matrix + `modulate` + grain/vignette overlay), 3 looks + none | On-device Skia (`@shopify/react-native-skia`) | Skia adds ~5 MB to the APK, decodes a full bitmap on 2 GB phones, and blocks JS while encoding. The disposable concept hides results until reveal anyway, so a live filtered preview isn't needed — the viewfinder shows a cheap tinted overlay. Looks can be tuned without an app release and are identical on every phone. |
| On-device processing | Native resize to ≤ 2,048 px JPEG q85, metadata dropped (`@bam.tech/react-native-image-resizer`, `keepMeta=false`) | Upload camera originals (3–6 MB) | ~600 KB per photo: 5–8× less venue bandwidth, and OPS's capacity plan for 300 uploads/min assumes it. GPS never leaves the phone. |
| Upload transport | Presigned **PUT**, 5-min expiry, signed `Content-Type`, `Content-Length` and `x-amz-checksum-sha256`; presigned **just in time** before each attempt | Presigned POST policy (backlog); long-lived URLs for background sessions | Baseline. S3 rejects a body whose size or hash differs. Just-in-time presign keeps 5-min expiry valid for an offline queue. |
| Completion signal | App calls `POST /uploads/:id/complete`; `media.reconcile` cron HEADs stragglers | S3 Event Notifications → SQS | No extra AWS plumbing or poller; the cron covers "uploaded, then the app died". |
| Shot limit | Server-authoritative atomic upsert on `photo_shot_counters`, reserved at presign, idempotent per `client_shot_id`; app mirrors the remaining count to disable the shutter offline | Count at `complete`; client-only count | One SQL statement, no race at 300/min; offline shots can't exceed what the server last allowed (except the rare two-devices case, handled as "blocked"). |
| Offline queue | Files in the app's documents dir + queue index in MMKV + `react-native-blob-util` streaming PUT; drain on foreground/NetInfo; `react-native-background-fetch` opportunistic drain (CAM-05b) | `fetch(blob)` (loads the file into JS memory); `react-native-background-upload` (URL must be signed before the OS schedules it) | Survives app kill/reboot, streams from disk on 2 GB phones, re-presigns per attempt. |
| Raw upload location | Top-level `incoming/` prefix, deleted after processing, lifecycle expiry 2 days | Upload straight to the final key | Nothing with EXIF/GPS ever sits at a long-lived key; one lifecycle rule cleans abandoned uploads; CloudFront can never reach a raw upload. |
| Dedupe | SHA-256 declared at presign (unique per wedding among live photos), verified by S3 checksum and re-hashed by the worker | Perceptual hash | Exact duplicates (same photo picked twice, retries under a new id) are the real case; pHash is P2. |
| Reveal | Effective `reveal_at` copied onto each photo, bulk-updated on change; feed filter `reveal_at <= now()` | Join settings on every feed read | Keeps the feed query a single index range scan (§9). |
| Settings storage | Wedding-level values in SET's `weddings.settings.camera` (names from 03-set.md); per-event overrides in `photo_event_settings` | A `photo_settings` table | One place for wedding settings (SET R2); CAM owns the semantics. |

## 3. Data model

DDL: [`sql/12-cam.sql`](./sql/12-cam.sql). **Schema check passed** (`scripts/check-schema.sh arch_cam 000-core.sql 12-cam.sql` → OK; also passes with every design file applied).

| Table | Purpose | Notes |
| --- | --- | --- |
| `media_objects` (core, owned by `media`) | Every S3 object | Photo rows: `kind='photo'`, `s3_key` starts as `incoming/{wid}/{mediaId}` and is updated to the sanitised original key; `sha256` = uploaded bytes; `delete_after` set by PRV retention. |
| `photo_event_settings` | Per event: public `camera_code` (QR), `camera_enabled`, `shot_limit` override, `opens_at`/`closes_at`, `reveal_override_at`, effective `reveal_at` | Row created lazily on first camera use or host edit. `camera_code` is 10 chars from an unambiguous alphabet; it routes, it does not authenticate. |
| `photo_shot_counters` | Used shots per guest × (event or wedding) × source (`camera`/`gallery`) | Unique `(guest_id, event_id, source) NULLS NOT DISTINCT`; reservation = `INSERT … ON CONFLICT DO UPDATE SET used = used + 1 WHERE used < :limit RETURNING used`. |
| `photos` | 1:1 with a photo `media_objects` row: event, source, `client_shot_id`, uploader, filter, `captured_at`, `reveal_at`, derivative keys, `blurhash`, `ready_at`, hide state (GAL-03), soft delete | `photos_client_shot_uq` makes presign idempotent; `photos_sha_uq` dedupes live photos per wedding; partial feed indexes on `(event_id \| wedding_id, captured_at DESC, media_id DESC)` where ready, not hidden, not deleted. |

**Settings keys** (SET's `WeddingSettingsV1.camera`, names kept): `shotLimit` (0 = camera off), `limitScope` (`wedding`/`event`), `revealMode` (`instant`, `next_morning`, `after_wedding`, `scheduled`), `revealAt`. **CAM/GAL add** (PR to `packages/domain/src/wedding/settings.ts`): `galleryUploadLimit` (default 20, GAL-05), `reportAutohideThreshold` (default 3, GAL-03), `guestZipEnabled` (default false, GAL-04).

**Reveal semantics** (CAM owns; all times in the wedding timezone):

| `revealMode` | Effective `reveal_at` for an event |
| --- | --- |
| `instant` | `-infinity` |
| `next_morning` | 09:00 on the day after the event's local end date |
| `after_wedding` | 09:00 on the day after `weddings.ends_on` |
| `scheduled` | `settings.camera.revealAt` |
| any + `reveal_override_at` | the override (host "Reveal now" or a per-event time) |

Photos without an event ("Other" album) use the wedding-level rule (`next_morning` behaves as `after_wedding`).

**Retention.** Photos follow PRV's `photos` class (`media_objects.delete_after`); counters and settings go with the wedding. Abandoned uploads are reaped after 72 h. Local queue files are deleted on successful completion.

### S3 layout

Bucket names and encryption follow PRV-04 (`mehfil-<env>-media`: SSE-S3, Block Public Access, TLS-only policy, versioning on with noncurrent versions expired after 7 days, abort incomplete multipart after 1 day).

```
mehfil-<env>-media
  incoming/{weddingId}/{mediaId}                     every presigned PUT for photo/ticket/cover/feed (raw, may hold EXIF)
  selfies/{weddingId}/{mediaId}.jpg                  FACE selfies (deleted right after indexing)
  weddings/{weddingId}/photos/{mediaId}/orig.jpg     sanitised original (filtered, no metadata)   tag class=orig
  weddings/{weddingId}/photos/{mediaId}/pv.webp      1,600 px preview   (CloudFront)               tag class=deriv
  weddings/{weddingId}/photos/{mediaId}/th.webp      400 px thumbnail  (CloudFront)               tag class=deriv
  weddings/{weddingId}/feed/{mediaId}/{orig.jpg|pv.webp|th.webp}   FEED photos, same pipeline
  weddings/{weddingId}/covers/{mediaId}/{orig.jpg|pv.webp}         SET cover
  weddings/{weddingId}/tickets/{mediaId}.{jpg|pdf}                 TRV tickets (never via CloudFront)
mehfil-<env>-exports   gallery/{weddingId}/{exportId}.zip (GAL), prv/... (PRV)      lifecycle: expire 7 d
mehfil-<env>-idv       see 17-idv.md (SSE-KMS, per-wedding key, no CloudFront)
```

Why: everything for a wedding sits under one `weddings/{id}/` prefix, so a wedding purge is a prefix list + `DeleteObjects` in batches of 1,000; lifecycle rules can filter only by prefix or tag, so short-lived objects get their own top-level prefixes.

| Lifecycle rule (media bucket) | Filter | Action |
| --- | --- | --- |
| `incoming-expire` | prefix `incoming/` | expire current after 2 d |
| `selfies-expire` | prefix `selfies/` | expire current after 1 d (backstop; FACE deletes at once) |
| `orig-ia` | tag `class=orig` | transition to STANDARD_IA after 45 d (originals are only read on download) |
| `noncurrent` | whole bucket | expire noncurrent versions after 7 d (PRV) |
| `mpu` | whole bucket | abort incomplete multipart uploads after 1 d |

Previews stay STANDARD (hot through CloudFront). Retention deletes are done by PRV jobs, not lifecycle (lifecycle can't know the plan).

**CloudFront** (`media.<domain>`, origin access control): one behaviour `/weddings/*`, **trusted key group required** (signed URLs), cache key without query string/cookies/headers, long TTL (keys are immutable). The bucket policy lets the CloudFront principal `GetObject` only on `weddings/*/photos/*/pv.webp`, `…/th.webp`, `weddings/*/feed/*/*.webp` and `weddings/*/covers/*/pv.webp` — originals, tickets and raw uploads return 403 even through CloudFront.

**IAM delta to PRV-04's app role:** add `s3:PutObject` on `incoming/*` and `selfies/*`, `s3:GetObject`/`DeleteObject` on both (worker), `s3:PutObjectTagging` on `weddings/*`, `cloudfront:CreateInvalidation` on the media distribution (GAL hide purge).

## 4. API

Guest calls use the guest JWT (`/v1/guest/*` resolves the wedding from the token); host calls use `requireWeddingRole`. Proposed permission actions for the ROL matrix: `camera.manage` and `photos.upload_host` (owner, co_host, planner_member); desk staff get none of CAM.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| POST | `/v1/weddings/:wid/uploads` | guest (own wedding), host roles | Create upload: `purpose` ∈ `camera`, `gallery`, `feed`, `ticket`, `cover`, `selfie` (policy registry; IDV has its own endpoint). Returns presigned PUT + headers. Idempotent per `photo.clientShotId` | `MEDIA_TYPE_NOT_ALLOWED` 415, `MEDIA_TOO_LARGE` 413, `CAM_SHOT_LIMIT_REACHED` 409, `CAM_CAMERA_CLOSED` 409, `CAM_EVENT_NOT_FOUND` 404 (not invited = not found), `CAM_DUPLICATE` 409 (+ existing id), `CAM_CONSENT_REQUIRED` 403, 429 |
| POST | `/v1/uploads/:mediaId/complete` | the uploader | HEAD object, check size/checksum, mark `uploaded`, enqueue `media.process` (idempotent) | `MEDIA_NOT_FOUND` 404, `MEDIA_OBJECT_MISSING` 409 (retry PUT), `MEDIA_SIZE_MISMATCH` 422 |
| GET | `/v1/guest/camera` | guest | Camera state per invited event: open window, enabled, `remaining`, `limit`, scope, `revealAt`, developing count | — |
| GET | `/v1/guest/camera/shots?cursor=` | guest | My shots: id, event, status (`developing`/`revealed`/`hidden`), thumb URL once revealed | — |
| GET | `/v1/guest/camera/codes/:code` | guest | Resolve a QR code to `{ weddingId, eventId }` | `CAM_CODE_NOT_FOUND` 404 (also for another wedding's code) |
| GET / PUT | `/v1/weddings/:wid/camera/events/:eid` | read: host roles; write: `camera.manage` | Per-event overrides: enabled, `shotLimit`, `opensAt`/`closesAt`, `revealOverrideAt` | `CAM_WINDOW_INVALID` 400 |
| POST | `/v1/weddings/:wid/camera/events/:eid/reveal` | `camera.manage` | Reveal now (sets override = now, schedules push) | — |
| POST | `/v1/weddings/:wid/camera/events/:eid/code/rotate` | `camera.manage` | New QR code (old one stops resolving) | — |
| GET | `/v1/weddings/:wid/camera/events/:eid/qr.pdf` | host roles | A5 table card with QR + "Scan to open the camera" (pdfkit + qrcode, sync) | — |
| GET | `/v1/weddings/:wid/camera/stats` | host roles | Per event: shots, guests shooting, processing backlog, failures (from OPS counters) | — |
| DELETE | `/v1/guest/camera/shots/:mediaId` | uploader | Delete my shot (shot not refunded) | 404 |

Wedding-level settings are edited through SET's `PATCH /v1/weddings/:wid/settings` (`camera.*`); a change emits `wedding.settings_updated`, which CAM uses to recompute reveal times.

**Create a camera upload** — `POST /v1/weddings/:wid/uploads`

```json
{ "purpose": "camera", "contentType": "image/jpeg", "byteSize": 612344,
  "sha256": "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=",
  "photo": { "clientShotId": "6f0d1c1e-5c1b-4c43-9a51-2f0b7c7d1a10", "eventId": "8b1…",
             "filter": "marigold", "capturedAt": "2027-03-13T16:41:09Z" } }
```
`201` (first call) or `200` (replay of the same `clientShotId`):
```json
{ "mediaId": "0c7…", "status": "pending",
  "upload": { "method": "PUT", "url": "https://mehfil-prod-media.s3.ap-south-1.amazonaws.com/incoming/2b4…/0c7…?X-Amz-Algorithm=…",
              "headers": { "Content-Type": "image/jpeg", "Content-Length": "612344",
                           "x-amz-checksum-sha256": "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=" },
              "expiresAt": "2027-03-13T16:47:12Z" },
  "shots": { "used": 13, "limit": 24, "scope": "event" } }
```
A replay whose object is already uploaded returns `"status": "uploaded"` and no `upload` block; the app goes straight to `complete`. `409 CAM_SHOT_LIMIT_REACHED` carries `{ used, limit }` so the app can show "Film finished — this photo is saved on your phone only".

**Policy registry.** `media.registerUploadPolicy(purpose, { kind, maxBytes, contentTypes, keyFor, authorize(tx, caller, body), afterProcessed })`. CAM registers `camera`/`gallery`; TRV `ticket` (PDF/JPEG/PNG ≤ 10 MB); SET `cover`; FEED `feed`; FACE `selfie`. HEIC is not accepted anywhere: the app converts to JPEG (prebuilt `sharp` has no HEVC decoder).

## 5. Jobs, events and realtime

| Job (queue) | Trigger | Payload | Behaviour |
| --- | --- | --- | --- |
| `media.process` (`media`, FND: concurrency per OPS, `sharp.concurrency(1)`) | `complete`, reconcile | `{ mediaId }` | Idempotent (no-op if `processed`). Stream from `incoming/`, check size ≤ policy max, sniff magic bytes (`file-type`), `limitInputPixels` 40 MP, recompute SHA-256 (dup → mark `duplicate`, release shot). `sharp().rotate()` → resize ≤ 2,560 px → film recipe → `orig.jpg` (q86, **no metadata**) → `pv.webp` 1,600 q78 → `th.webp` 400 q70 → blurhash. PUT 3 objects with tags, then one transaction: `media_objects` (`s3_key`, `processed`, size), `photos` (`ready_at`, keys, size, blurhash). Delete the `incoming/` object. Emits `photo.ready`. Retries 3 × 30 s → `media.dlq`; final failure sets `media_objects.status='rejected'`. |
| `media.reconcile` (`default`, cron */5 min) | — | — | Pending uploads presigned 10 min – 72 h ago: HEAD the key; present → `uploaded` + enqueue `media.process`. |
| `media.reap` (`default`, cron hourly) | — | — | Pending > 72 h: `media_objects.rejected`, `photos.deleted_reason='abandoned'`, release the shot (`used - 1`). A later replay of the same `clientShotId` revives the row and re-reserves. |
| `photos.recompute_reveal` (`default`) | `wedding.settings_updated`, `event.updated`, override change | `{ weddingId, eventId? }` | Recompute `photo_event_settings.reveal_at`; `UPDATE photos SET reveal_at = … WHERE event_id = …`; (re)schedule `photos.reveal_notify` with `singletonKey = reveal:{eventId}`, `startAfter = reveal_at`. |
| `photos.reveal_notify` (`default`) | scheduled | `{ eventId, revealAt }` | If `reveal_at` still equals payload and not yet notified: `messaging.send({ channels: ['push'], templateKey: 'photos_revealed', guestIds: invited guests })`; set `revealed_notified_at`. |

**Domain events** (in-process, after commit): `photo.ready { weddingId, photoId, eventId }` (FACE enqueues `face.index_photo`), `photo.hidden` / `photo.unhidden` / `photo.deleted` (GAL purge, FACE removes faces), `camera.revealed { eventId }`. CAM listens to `privacy.consent_changed` (`photos` withdrawn → camera disabled; PRV handles keep/delete of uploads) and SET's `wedding.settings_updated` / `event.updated`.

**Realtime:** none needed. The host stats screen polls every 30 s while open.

**Metrics** into OPS's `ops_wedding_minute`: `upload_started` (presign), `upload_completed`, `upload_failed`, `media_processed`, `media_failed`.

## 6. Mobile app

**Guest mode** (Camera tab; feature lazy-loaded per APP-08):

| Screen | Content |
| --- | --- |
| `CameraHome` | Event chooser (defaults to the event open now; "Camera opens at 6:00 pm for Sangeet" otherwise), big remaining-shots counter, "12 photos developing", queue status chip ("3 waiting for network"), consent sheet on first use (`photos` purpose, PRV copy) |
| `CameraScreen` | Full-screen viewfinder, shutter (≥ 72 dp), flip, flash, 4 look chips (tinted overlay preview), counter "13 / 24", haptic + shutter sound. No photo review (disposable). Shutter disabled at 0 with "Film finished" |
| `UploadQueueScreen` | Pending/blocked items with reason, "Retry now", "Save to my phone" for blocked items |
| `MyShotsScreen` | Developing placeholders (blurhash-free grey cards) until reveal, then thumbnails |

**Host mode:** `EventCameraSettings` (enable, per-event limit, window, "Reveal now", print QR → share sheet with the PDF), `CameraStats`. Wedding-level camera settings are on SET's `WeddingSettings` screen.

**Deep links** (APP-02 `linking.ts`): `https://<domain>/c/:code` (printed QR; **add `/c/*` to AASA and assetlinks**) → `CameraScreen({ code })`; `https://<domain>/g/:token/c/:eventId` (personalised WhatsApp link, already in APP) → camera for that event after guest entry. If the code's wedding is not one of the device's identities: "Open your invitation link from WhatsApp first".

**Camera open < 2 s on a budget Android:**
- Camera feature chunk prefetched after the Guest navigator settles (`InteractionManager`), so the tap only mounts.
- Permission asked once, in context, with PRV's purpose string; `Camera isActive={focused && appActive}`.
- `useCameraFormat` asks for a ~2 MP photo and ≤ 1,280 × 720 preview; `photoQualityBalance="speed"`; no video/audio session, no frame processors, `enableLocation=false`.
- Measured: Sentry span `camera.open` from tap to `onInitialized`; budget 2.0 s p90 on the Android 9 / 2 GB device in OPS-04. If `takePhoto` exceeds 600 ms there, switch Android to `takeSnapshot({ quality: 85 })` (decided in the S0 spike).
- Fallback: two init failures → `launchCamera` (system camera), same queue.

**Upload queue** (`src/lib/upload-queue`, shared by TRV tickets, SET cover, FEED, FACE selfie, IDV with a `sensitive` flag):

| State | Next | Notes |
| --- | --- | --- |
| `captured` | `prepared` | Raw file in `Documents/mehfil/queue/`; resize ≤ 2,048 px JPEG q85 without metadata; SHA-256 via `react-native-blob-util` `fs.hash` (native); raw deleted |
| `prepared` | `uploading` | `POST /uploads` just in time (fresh 5-min URL) |
| `uploading` | `completing` | Streaming PUT from disk with progress; 2 parallel on Wi-Fi, 1 on cellular |
| `completing` | `done` | `POST /complete`; file deleted; entry kept 7 days for MyShots, then pruned |
| any | `blocked` | Permanent errors (`CAM_SHOT_LIMIT_REACHED`, `CAM_CAMERA_CLOSED`, `CAM_CONSENT_REQUIRED`, 404): keep file, show reason, offer "Save to my phone" |
| any | retry | Network/5xx/429/expired URL: backoff 2 s × 2ⁿ, cap 15 min, full jitter; re-presign each attempt; give up after 14 days |

Index in MMKV (per identity namespace, written before the shutter animation ends); guard: refuse capture below 200 MB free or above 500 queued items. Drains on app start, foreground, NetInfo "reachable", after each capture. CAM-05b: `react-native-background-fetch` (Android headless task with network constraint; iOS BGAppRefresh, best effort ~30 s → 1–3 photos per wake). Sign-out with pending items warns first.

**Query keys:** `['guest','camera']` (staleTime 60 s; the local counter is `remaining − queued-not-yet-reserved`), `['guest','camera','shots']`, `['wedding',wid,'camera','event',eid]`, `['wedding',wid,'camera','stats']`. The queue itself is a Zustand store persisted to MMKV, not TanStack Query.

**Accessibility:** counter and buttons are icon + label, readable at 200 % font scale; high-contrast mode swaps the translucent overlays for solid ones; TalkBack/VoiceOver labels ("Take photo, 11 shots left"); the shutter is reachable one-handed.

## 7. Guest lite web

`GET /c/:code` (server-rendered, ~5 KB): wedding title + event name, "Open in the Mehfil app" (App/Universal Link), Play/App Store buttons, and "Already invited? Tap your invitation link in WhatsApp". **No browser camera or upload** — baseline keeps camera in the app. If the product owner wants no-install photo uploads, a file-input page on `/g/:token/photos` reusing the same presign/complete flow is ~3 pts (open question Q1).

## 8. Security and privacy

- **Consent:** active `photos` consent required for `camera`/`gallery` purposes (checked from the guest JWT `cns` claim, PRV); withdrawal disables the camera at once in the app and at the API.
- **Minimisation:** EXIF/GPS dropped on the device **and** re-encoded away on the server; raw uploads live ≤ 2 days under `incoming/`; `enableLocation=false`.
- **Upload integrity:** server-generated keys only; content type allowlist (`image/jpeg` for photos); size and SHA-256 signed into the URL; magic-byte sniff and pixel limit in the worker; no SVG.
- **Access:** buckets private; CloudFront serves only derivatives, only with signed URLs; originals only via 5-min presigned GET (GAL).
- **Tenant isolation:** `eventId` must belong to the token's wedding and be visible to the guest's groups, else 404; `camera_code` lookup is scoped to the caller's identities; `complete` only by the uploader.
- **Rate limits:** presign 60/min per guest, 600/min per wedding; ≤ 50 pending uploads per guest; QR code lookup 30/min per guest.
- **Audit:** `camera.settings.update`, `camera.reveal`, `camera.code.rotate` via `audit.record`. Uploads are not audit-logged (volume); they're in `media_objects`.
- **Erasure:** `photos`/`media` `PurgeParticipant` (PRV order 40): guest erasure deletes their uploads (objects + rows); consent withdrawal follows PRV's keep-unattributed/delete choice; wedding purge deletes `weddings/{id}/` by prefix.
- **Logs:** never log presigned URLs (they carry signatures), tokens or phone numbers.

## 9. Scale and performance

| Stress point | Load at 300 uploads/min | How it holds |
| --- | --- | --- |
| API presign + complete | 10 req/s | One indexed upsert + one insert per presign; presigning is local HMAC. Trivial. |
| Shot counter contention | Same guest rarely concurrent | Row-level lock only on that guest's counter. |
| Worker CPU | 5 photos/s × ~150 ms (2 MP decode, filter, JPEG + 2 WebP) ≈ 0.75 vCPU | OPS: media concurrency 2 on `m7g.xlarge`; queue absorbs bursts; alarm if oldest job > 5 min. Client resize is what makes this fit. |
| S3 | ~5 PUT/s raw + 15 PUT/s derivatives | Far below S3 per-prefix limits (3,500 PUT/s). Same-region transfer is free. |
| Worker network | ~5 × 1.5 MB/s ≈ 60 Mbit/s | Fine on EC2. |
| Feed / reveal update | 15k photos per wedding | Reveal change = one indexed `UPDATE … WHERE event_id`. |
| Storage | ~15k photos × ~1 MB (orig + 2 previews) ≈ 15 GB per large wedding | ≈ US$0.40/month; originals → IA at 45 d. |

`EXPLAIN` on 200k sample photos (50 weddings): the album page query uses `photos_event_feed_idx` (Index Cond on `event_id` + row comparison, 0.4 ms); the shot reservation upsert uses `photo_shot_counters_uq` (1 ms). Hot queries are listed in 13-gal.md §9.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Reveal computation for each mode × time zones × date-line events; window checks; `captured_at` clamping; key builder; queue state machine with fake fs/NetInfo/clock (retry classes, re-presign on 403 expiry, give-up). |
| API e2e (`mehfil_test`, `FakeObjectStore`) | Presign → complete → process happy path; **50 parallel presigns against limit 24 → exactly 24 succeed**; idempotent replay returns the same `mediaId` and does not consume a shot; duplicate SHA → `CAM_DUPLICATE`; not-invited event → 404; other wedding → 404; consent withdrawn → 403; reconcile picks up an object uploaded without `complete`; reaper releases the shot; per-role matrix rows (desk staff → 404 on camera admin). |
| Worker | Fixture JPEGs with GPS EXIF, rotated orientation, CMYK, 50 MP bomb, PNG renamed `.jpg`: output has no EXIF (`sharp(orig).metadata()`), correct orientation, bomb rejected, mismatch rejected; golden-image check per film look (perceptual diff tolerance). |
| Integration (CI service `minio`) | Signed `Content-Length` and `x-amz-checksum-sha256` are enforced (wrong body → 400/403) — guards against SDK presigner header hoisting changes. |
| Mobile (Jest + RNTL) | Camera screen with a VisionCamera mock (counter, disabled shutter, permission denied state); queue hooks; MyShots developing vs revealed. |
| Device (OPS-04) | Camera open time on Android 9/2 GB; 10 shots in airplane mode → kill app → reboot → reconnect → all upload once; low storage; shared family phone switching member mid-queue. |
| Load (OPS-01 S2) | k6: 300/min for 30 min, 600/min for 5 min against staging; 0 lost uploads; p95 upload→processed < 60 s. |

**Observability:** alarms (OPS): `media_lag` (oldest `media` job > 5 min warn, 15 min page), upload failure rate > 10 %, `media.dlq` non-empty, reconcile finding > 5 % of uploads (means `complete` is failing). Dashboards: per-wedding uploads/min, processed/min, blocked by limit. App sends `X-Upload-Queue-Depth` on presign → p95 field backlog gauge.

## 11. Story breakdown

| Story | Tasks | Pts (backlog → revised) | Why |
| --- | --- | --- | --- |
| **CAM-01a** Upload core | [API] `media` module: policy registry, `POST /uploads`, `POST /complete`, `ObjectStore.presignPut` with signed length/checksum (FND-13) · [JOB] `media.process` skeleton (sanitise + derivatives for `cover`) · [TEST] e2e + MinIO header test | 3 → **2** (pull to **S3**) | SET-06 cover, TRV-02 tickets and FEED need it long before S7. |
| **CAM-01b** Camera purposes and S3 config | [API] `camera`/`gallery` policies (consent, event visibility, window, idempotency, dedupe) · [JOB] `media.reconcile`, `media.reap` · [OPS] bucket lifecycle rules, tags, CloudFront behaviour + key group + bucket policy, IAM delta · [TEST] | — → **3** | Lifecycle/CloudFront/IAM were implicit. |
| CAM-02 Native camera | [MOB] VisionCamera screen, format selection, permission flow, fallback to `launchCamera`, open-time span · [TEST] RNTL + device timing | 5 → **5** | Unchanged size; native instead of browser. |
| CAM-03 Shot limit | [DB] counters · [API] atomic reservation, per-event/wedding scope, `GET /guest/camera`, host event overrides · [MOB] counter + offline mirror + "Film finished" · [TEST] concurrency e2e | 2 → **3** | Offline mirror and per-event overrides. |
| CAM-04 Film filter | [JOB] 3 `sharp` recipes + grain asset · [MOB] look chips + tint overlay · [TEST] golden images | 3 → **2** | Server-side recipe is simpler than an on-device canvas/Skia pipeline. |
| **CAM-05a** Persistent upload queue | [MOB] `lib/upload-queue` (MMKV index, file store, resize + hash, streaming PUT, retry classes, blocked/save-to-phone, queue screen) · [TEST] state machine | 5 → **5** | Core of the offline promise. |
| **CAM-05b** Background drain | [MOB] `react-native-background-fetch` headless task (Android) + BGAppRefresh (iOS), identity token refresh in headless context · [TEST] device kill/reboot | — → **3** (**S9**) | Native background work is its own risk; foreground drain covers the rehearsal. |
| CAM-06 Delayed reveal | [API] reveal computation, override + "Reveal now", recompute job · [JOB] `photos.reveal_notify` push · [MOB] developing states, host controls · [TEST] | 2 → **3** | Push + recompute on settings/event changes. |
| CAM-07 Media worker | [JOB] full `media.process` (sniff, limits, re-hash dedupe, rotate, derivatives, blurhash, tags, delete raw, metrics, DLQ) · [TEST] fixtures | 3 → **5** | Security fixtures, dedupe race and metrics; 300/min proof is OPS-01. |
| CAM-08 Camera QR / link | [API] codes, resolve, rotate, `qr.pdf` · [WEB] `/c/:code` landing · [MOB] linking routes · [OPS] AASA/assetlinks `/c/*` · [TEST] | 1 → **2** | PDF card + app/universal link plumbing. |
| **Total** | | **24 → 33** | +0.5 pt PurgeParticipant per PRV is inside CAM-07/01b. |

## 12. Dependencies and sequencing

| Needs | From | Note |
| --- | --- | --- |
| `ObjectStore` (presignPut/Get, head, get, put, delete), CloudFront signer, `JobQueue` + `media` queue/DLQ | FND-13, FND-06 | FND-13 must expose signed `Content-Length`/checksum options. |
| Guest JWT with `cns` consent claim, `authGuest` | ACC-01/02, PRV-01 | |
| `events.visibleEventIdsForGuest(weddingId, guestId)` + `wedding.settings_updated`, `event.updated` events | SET-04, SET-06 | |
| `messaging.send` with `channels: ['push']` | MSG-08 (FCM) | Reveal push; without it, reveal is silent (in-app only). |
| `linking.ts`, AASA/assetlinks, identity store | APP-02 | Add `/c/*`. |
| `PurgeParticipant` contract | PRV-02a | |
| `ops_wedding_minute` counters | OPS-03 | |
| Consumers | GAL (all), FACE-03 (`photo.ready`), FEED (`feed` purpose), TRV-02, SET-06, IDV (queue `sensitive` mode) | |

Sequencing: CAM-01a S3 → CAM-01b, 02, 03, 04, 05a, 07, 08 in S7 → CAM-05b, 06 in S9. S7 becomes ~34 pts with MSG-04/07 and RSV-04; **move RSV-04 (2) to S8 or S9** to stay at ~32.

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | VisionCamera on RN 0.88 New Architecture: confirm the version in the S0 camera spike (SPIKE-2, reinterpreted from "browser camera" to native). Fallback `launchCamera` limits the blast radius. |
| R2 | Camera open < 2 s on Android 9 / 2 GB is device-dependent; measured every release (OPS-04). |
| R3 | iOS background execution is opportunistic; photos taken late at night may wait until the app is next opened. Mitigation: drain on open, visible queue chip. |
| R4 | Guests without the app cannot shoot (activation risk for a P0 differentiator). See Q1. |
| R5 | Two devices for one guest can over-shoot offline; extra shots become "blocked — saved on phone only". Accepted. |
| Q1 | **PO:** offer a no-install photo upload on the lite web page (~3 pts)? |
| Q2 | **PO:** should a guest see their own photos before the reveal? Default: no (count + placeholders only). |
| Q3 | **PO:** default `revealMode` — SET defaults to `next_morning`; confirm. |
| Q4 | **PO:** store the filtered original only (default) or also keep the unfiltered one for hosts (+~40 % storage)? |
| Q5 | **PO/Design:** names and looks of the 3 film filters (`marigold`, `mono`, `faded` placeholders). |

## 14. Deviations from the baseline

| Baseline says | This design | Why |
| --- | --- | --- |
| Upload request carries `kind` | Carries `purpose` (camera, gallery, feed, ticket, cover, selfie); `kind` is derived | One kind (`photo`) has several purposes with different rules (FEED already uses `purpose='feed'`). TRV-02's `{kind:'ticket'}` becomes `{purpose:'ticket'}`. |
| Presigned PUT objects go to their final key | Raw uploads go to `incoming/`; the worker writes sanitised objects under `weddings/{id}/` and deletes the raw one | Raw files can carry EXIF/GPS; keeps them short-lived and out of CloudFront's reach. |
| PRV-04 IAM grants the app `weddings/*` only | Adds `incoming/*`, `selfies/*`, object tagging and CloudFront invalidation | Required by the layout above. **PRV-04 table needs the same edit.** |
| Film filter "client-side canvas" (backlog) | Server-side `sharp` recipe | See §2. |
