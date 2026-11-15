# E13 — Shared gallery (GAL)

Status: design · Owner module: `apps/api/src/modules/photos` (shared with CAM) · App: `apps/mobile/src/features/gallery` · SQL: [`sql/13-gal.sql`](./sql/13-gal.sql) (builds on [`sql/12-cam.sql`](./sql/12-cam.sql))

## 1. Summary

Guests browse **albums per event** as a fast, cursor-paginated grid of previews served by **CloudFront signed URLs**, download single photos, favourite them, report bad ones, and add photos from their phone's gallery. Hosts hide/unhide, moderate reports and download a **full-album zip** built by a worker and streamed to S3.

| Story | Pri | Plan | Proposed |
| --- | --- | --- | --- |
| GAL-01 Albums per event | P0 | S8 | S8 |
| GAL-02 Downloads | P0 | S8 | **Split:** GAL-02a single download → S8; GAL-02b host album zip → S9 |
| GAL-03 Hide and report | P0 | S8 | S8 |
| GAL-04 Guest full-album download, favourites | P1 | S13 | S13 |
| GAL-05 Upload from phone gallery | P1 | S13 | S13 (could move earlier; small) |

**Stack reinterpretation.** "Guests browse lazy-loaded thumbnails via CDN" becomes a React Native `FlashList` grid in Guest mode; "link emailed/WhatsApped" for the album zip becomes a push + in-app download card (no email provider in the baseline); GAL-04's guest "full-album download" becomes **"Save album to phone"** (photos saved one by one into the phone's gallery) because a zip is useless on a phone. The lite web page has no gallery (baseline).

**What counts as a gallery photo.** Only rows in `photos` (purposes `camera`, `gallery`, `host`). `media_objects` with `kind='photo'` also hold feed, quiz, cover and future P2 uploads; GAL **never** queries `media_objects` by kind. Upload `purpose` (12-cam.md §4) decides whether a `photos` row is created.

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Albums | Events are albums, plus an "Other" album (`event_id IS NULL`) | Album table with custom albums | Matches the AC; no extra CRUD. Custom albums are P2 (PWP). |
| Feed pagination | Keyset on `(captured_at DESC, media_id DESC)`, opaque base64 cursor, 60 per page | Offset; sort by upload time | Stable under concurrent uploads; capture order feels natural; index-only range scan. |
| Wedding-wide feed filter | Exclude the events the guest *can't* see (`event_id <> ALL(:hidden)`) | Include-list `event_id = ANY(:visible)` | EXPLAIN: exclude form keeps the `photos_wedding_feed_idx` range scan (1.2 ms); include form fell back to a bitmap + sort (10 ms, growing with photo count). |
| Preview delivery | CloudFront signed URLs (canned policy) with expiry **rounded to 6-hour windows** | Signed cookies; per-request expiry | RN image loaders don't share cookies well; rounding keeps URLs stable within a window so the device disk cache (keyed by URL) hits. |
| Image component | `@d11/react-native-fast-image` (maintained fork, New Arch) with APP's 150 MB disk cap | `expo-image` (Expo modules rejected by APP); RN `Image` (weak disk cache) | Disk caching + priority; no Expo. |
| Hide | Soft flag on `photos` + **delete the two CloudFront-served derivatives + invalidation**; unhide rebuilds them | Rely on URL expiry | A reported photo must disappear now, not in 12 h. Original is kept for the host. |
| Auto-hide on reports | Hide after `reportAutohideThreshold` (default 3) distinct reporters; host reviews | Pre-moderation; AWS Rekognition moderation | Hosts know their guests; FEED made the same call. |
| Host album zip | `archiver` (STORE, zip64) streamed into an S3 multipart upload (`@aws-sdk/lib-storage`) in the exports bucket; reuse by `snapshot_key` | Build in memory/disk; zip on the API | Constant memory for 10 GB albums; identical requests share one zip. |
| Guest full album (GAL-04) | "Save album to phone": app pages presigned GETs and saves each original via `@react-native-camera-roll/camera-roll` in a download queue | Guest zip | Phones can't open zips into Photos; resumable; no worker cost. Guest zip stays behind `guestZipEnabled`. |
| Single download | Presigned S3 GET (5 min, `response-content-disposition`) of `orig.jpg` | Originals via CloudFront | Originals never go through the CDN (bucket policy). |
| Upload from phone gallery | System photo picker (`react-native-image-picker`, `selectionLimit` = remaining, `assetRepresentationMode: 'compatible'` → JPEG), same queue and `/uploads` with `purpose:'gallery'` | Separate upload path | One pipeline; HEIC converted on device; Android 13+ photo picker needs no media permission (PRV). |

## 3. Data model

DDL: [`sql/13-gal.sql`](./sql/13-gal.sql). **Schema check passed** (`scripts/check-schema.sh arch_gal 000-core.sql 12-cam.sql 13-gal.sql` → OK; also with all design files).

| Table | Purpose | Notes |
| --- | --- | --- |
| `photos` (12-cam) | Hide state: `hidden_at`, `hidden_by_user_id`, `hidden_reason` (`host`/`reports`), `report_count` | Owned by the same `photos` module. |
| `photo_reports` | One report per reporter per photo: reason (`inappropriate`, `privacy`, `i_am_in_it`, `other`), note ≤ 280, resolution | Partial uniques per reporter type; open-queue index. |
| `photo_favourites` | Guest or host favourites | Unique per (guest, photo) / (user, wedding, photo). |
| `gallery_exports` | Zip jobs: scope (`host_all`, `guest_visible`, `favourites`), `snapshot_key` = SHA-256 of the sorted photo ids, status, size, `media_id` (kind `export`), `expires_at` | Partial unique `(wedding, event, scope, snapshot_key) NULLS NOT DISTINCT` for live exports → reuse. |

Visibility rule (one function, `photos.visibleTo(caller)`), used by every read:

| Caller | Sees |
| --- | --- |
| Guest | `ready_at` set, not hidden, not deleted, `reveal_at <= now()`, event visible to the guest's groups (or "Other") |
| Owner, co_host, planner_member | Everything not deleted, including hidden and unrevealed (badged) |
| Desk staff | Nothing (404) |

Retention: reports and favourites cascade with the photo; exports expire 7 days after ready (S3 lifecycle on the exports bucket + `gallery.expire_exports`).

## 4. API

Proposed ROL actions: `photos.view_all`, `photos.moderate`, `photos.export` (owner, co_host, planner_member). Guests use `/v1/guest/gallery/*`.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/guest/gallery/albums` | guest | Visible events with count, cover thumb, `revealAt`/`developing` | — |
| GET | `/v1/guest/gallery/photos?eventId=&cursor=&limit=&filter=all\|mine\|favourites` | guest | Page of photos | `GAL_CURSOR_INVALID` 400 |
| GET | `/v1/guest/gallery/photos/:pid` | guest | One photo (preview URL, uploader first name, favourite, mine) | 404 if not visible |
| GET | `/v1/guest/gallery/photos/:pid/download` | guest | `{ url, filename, expiresAt }` presigned GET of original | 404, 429 |
| GET | `/v1/guest/gallery/albums/:eventId/download-list?cursor=` | guest | GAL-04: pages of `{ id, url }` (50 per page, URLs 15 min) for "Save album to phone" | 429 |
| PUT / DELETE | `/v1/guest/gallery/photos/:pid/favourite` | guest | Favourite / unfavourite (idempotent) | 404 |
| POST | `/v1/guest/gallery/photos/:pid/report` | guest | `{ reason, note? }`; may auto-hide | `GAL_ALREADY_REPORTED` 409, 429 |
| GET | `/v1/weddings/:wid/gallery/albums` · `/photos?…&include=hidden,unrevealed` · `/photos/:pid` · `/photos/:pid/download` | `photos.view_all` | Host equivalents | 404 |
| PUT / DELETE | `/v1/weddings/:wid/gallery/photos/:pid/hidden` | `photos.moderate` | Hide / unhide | — |
| DELETE | `/v1/weddings/:wid/gallery/photos/:pid` | `photos.moderate` | Delete (soft; objects purged by job) | — |
| GET | `/v1/weddings/:wid/gallery/reports?status=open&cursor=` | `photos.moderate` | Moderation queue | — |
| POST | `/v1/weddings/:wid/gallery/reports/:rid/resolve` | `photos.moderate` | `{ action: keep\|hide\|delete }` resolves all open reports on the photo | — |
| POST | `/v1/weddings/:wid/gallery/exports` | `photos.export` (guest variant behind `guestZipEnabled`) | `{ eventId \| null, scope }`, `Idempotency-Key`; 202 with export (new or reused) | `GAL_EXPORT_EMPTY` 422, 429 |
| GET | `/v1/weddings/:wid/gallery/exports` · `/exports/:id` | requester / host roles | Status; `downloadUrl` (presigned GET, 1 h) when ready | `GAL_EXPORT_EXPIRED` 410 |

Uploads from the phone gallery use `POST /v1/weddings/:wid/uploads` with `purpose:'gallery'` (12-cam.md §4), counted against `galleryUploadLimit` in `photo_shot_counters` (`source='gallery'`, per wedding).

**Album page** — `GET /v1/guest/gallery/photos?eventId=8b1…&limit=60`

```json
{ "items": [
    { "id": "0c7…", "eventId": "8b1…", "capturedAt": "2027-03-13T16:41:09Z",
      "width": 1600, "height": 1200, "blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      "thumbUrl": "https://media.mehfil.app/weddings/2b4…/photos/0c7…/th.webp?Expires=1773442800&Signature=…&Key-Pair-Id=K2…",
      "previewUrl": "https://media.mehfil.app/weddings/2b4…/photos/0c7…/pv.webp?Expires=…",
      "uploader": { "firstName": "Priya" }, "isMine": false, "isFavourite": true } ],
  "nextCursor": "eyJ0IjoiMjAyNy0wMy0xM1QxNjo0MDo1MloiLCJpZCI6IjBhMy4uLiJ9" }
```

**Request a host zip** — `POST /v1/weddings/:wid/gallery/exports` (`Idempotency-Key: 9e2…`) `{ "eventId": "8b1…", "scope": "host_all" }` → `202 { "id": "e51…", "status": "queued", "photoCount": 2841, "reused": false }`; later `GET …/exports/e51…` → `{ "status": "ready", "byteSize": 2093412211, "downloadUrl": "https://mehfil-prod-exports.s3…", "expiresAt": "2027-03-21T09:00:00Z" }`.

## 5. Jobs, events and realtime

| Job (queue) | Trigger | Payload | Behaviour |
| --- | --- | --- | --- |
| `gallery.build_zip` (`default`, 1 at a time per wedding via `singletonKey`, `expireIn` 2 h) | export created | `{ exportId }` | Resolve photo ids (snapshot), stream each `orig.jpg` → `archiver` (STORE, zip64, names `Sangeet/0001-priya.jpg`) → multipart upload to `mehfil-<env>-exports` at `gallery/{wid}/{exportId}.zip`; set ready + size; push the requester. Retries 2; partial multipart aborted (lifecycle backstop). |
| `gallery.expire_exports` (`default`, cron daily) | — | — | `ready` past `expires_at` → delete object, `expired`. |
| `photos.hide_purge` (`media`) | hide (host or auto) | `{ photoId }` | Delete `pv.webp`/`th.webp`, CloudFront invalidation `/weddings/{wid}/photos/{pid}/*`. Emits `photo.hidden`. |
| `photos.rebuild_derivatives` (`media`) | unhide | `{ photoId }` | Re-create derivatives from `orig.jpg`. Emits `photo.unhidden`. |
| `photos.purge_deleted` (`default`, cron hourly) | — | — | Soft-deleted photos older than 1 h: delete all 3 objects, `media_objects.status='deleted'`. |

Events consumed: `photo.ready` (none needed — the feed is pull-based). Events emitted: `photo.hidden`/`unhidden`/`deleted` (FACE). No SSE: album screens refetch on focus and pull-to-refresh; new photos appear on the next page load.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | `GalleryHome` (Photos tab) | Album cards (cover thumb, count, "Developing — reveals tomorrow 9:00 am"), "My photos" (FACE, P1), "Favourites" |
| Guest | `AlbumGrid` | `FlashList` 3 columns, `useInfiniteQuery`, blurhash placeholders, thumbs only; prefetch next page at 70 % scroll |
| Guest | `PhotoViewer` | Swipe pager of previews, pinch zoom, Download (to camera roll, "Saved" toast), Favourite, Report sheet (big reason buttons) |
| Guest | `SaveAlbumSheet` (P1) | "Save 214 photos to your phone (~150 MB)" with Wi-Fi-only toggle; progress; resumes after app restart (download queue mirrors the upload queue) |
| Guest | `AddFromGallery` (P1) | Picker → event choice → queue; shows remaining "8 of 20 left" |
| Host | `HostGallery` | Same grid with hidden/unrevealed badges, multi-select hide/delete |
| Host | `ModerationQueue` | Open reports with reason counts; Keep / Hide / Delete |
| Host | `Exports` | Request album zip, status, "Share link" (system share sheet with the presigned URL to open on a laptop) |

Query keys: `['guest','gallery','albums']`, `['guest','gallery','photos', eventId ?? 'all', filter]` (infinite), `['guest','gallery','photo', pid]`, `['wedding',wid,'gallery',…]` host mirrors, `['wedding',wid,'gallery','reports']`, `['wedding',wid,'gallery','exports']`. Signed URLs live ≥ 6 h, so `staleTime` 5 min is safe. Album lists are persisted (APP `meta.persist`) so the last-seen grid renders offline; images come from the disk cache.

Performance: thumbnails are 400 px WebP (~25 KB); `FlashList` `estimatedItemSize`; no previews in the grid; 2 GB device memory checked at 1,000-photo scroll (OPS-04). Accessibility: each tile has a label ("Photo by Priya, Sangeet, 9:41 pm"); all actions icon + label; viewer buttons ≥ 48 dp.

## 7. Guest lite web

Not applicable. The baseline keeps gallery in the app; the lite page's "get the app" block covers it. The host zip link is a plain S3 URL that opens on any laptop browser.

## 8. Security and privacy

- Every read goes through `visibleTo(caller)`; photo ids from another wedding or invisible events → 404.
- CloudFront serves only derivatives, only with signed URLs; hidden photos lose their derivatives immediately (+ invalidation). Originals: 5-min presigned GET; exports: 1-h presigned GET, objects expire in 7 days.
- Uploader shown to guests by **first name only**; hosts see the full name.
- Reports are visible to hosts only; reporter identity is shown to hosts (needed to follow up) but never to guests.
- Rate limits: downloads 120/hour/guest, download-list pages 30/hour, reports 10/hour, exports 3/day per requester.
- Audit: `photo.hide`, `photo.unhide`, `photo.delete`, `report.resolve`, `export.create` via `audit.record`.
- Erasure (`photos` PurgeParticipant, PRV order 40): reports by the guest → reporter set null; favourites deleted; exports requested by the guest deleted. Wedding purge deletes `gallery/{wid}/` in the exports bucket.
- A person who appears in a photo but did not upload it uses Report → `i_am_in_it`; hosts are prompted to hide.

## 9. Scale and performance

| Stress point | Load | How it holds |
| --- | --- | --- |
| Album pages | 500 guests scrolling after reveal ≈ 20 req/s | Index range scan, 60 rows, ~0.4 ms (EXPLAIN below); 60 RSA signatures per page ≈ 6 ms (sign once per photo per 6-h window with an in-process LRU) |
| Reveal stampede | All guests open at 9:00 | CloudFront absorbs image load; API reads are cheap; push is sent in batches by MSG |
| Zip | 3k-photo album ≈ 2 GB, whole wedding ≈ 15 GB | Streaming, constant memory; ~2–5 min per GB on one box; one zip per wedding at a time; reuse by snapshot |
| Invalidations | Hides | 1,000 paths/month free, then $0.005 each — negligible |

EXPLAIN (sample: 200k photos, 50 weddings):

| Query | Plan | Time |
| --- | --- | --- |
| Album page (`event_id`, keyset) | Index Scan `photos_event_feed_idx`, filter `reveal_at <= now()` | 0.4 ms |
| Wedding feed with excluded events | Index Scan `photos_wedding_feed_idx` | 1.2 ms |
| Same with include-list (rejected form) | Bitmap + top-N sort | 10 ms |

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Cursor encode/decode/tamper; `visibleTo` truth table (role × hidden × revealed × event groups); snapshot key stability; signed-URL window rounding. |
| API e2e | Pagination with concurrent inserts (no dupes/gaps); guest can't see hidden/unrevealed/other-group photos (404 on direct id); desk staff 404; auto-hide at threshold with distinct reporters only; hide → purge job deletes derivatives (FakeObjectStore) and calls invalidation fake; export reuse with same snapshot; idempotency key replay; expired export 410. |
| Worker | Zip of fixtures with names and zip64 path (> 65,535 entries simulated with tiny files); multipart abort on failure. |
| Mobile | RNTL: grid renders blurhash then image; viewer actions; report sheet; save-album queue resume. |
| Device | 1,000-photo scroll on 2 GB Android; save 100 photos to camera roll on Android 9 and iOS 15 (permission flows). |

Observability: zip duration and size histograms; `gallery.build_zip` failures alert; hide-to-purge latency; CloudFront 4xx rate (expired signatures signal a clock or window bug).

## 11. Story breakdown

| Story | Tasks | Pts (backlog → revised) | Why |
| --- | --- | --- | --- |
| GAL-01 Albums per event | [API] albums, keyset feed, `visibleTo`, CloudFront signer with window + LRU · [MOB] GalleryHome, AlbumGrid, PhotoViewer, FastImage · [TEST] | 3 → **5** | Signed URLs, visibility rules and an RN grid tuned for 2 GB phones. |
| **GAL-02a** Single download | [API] presigned GET with disposition · [MOB] save to camera roll + permission · [TEST] | 3 → **2** | |
| **GAL-02b** Host album zip | [DB] `gallery_exports` · [API] create/status · [JOB] `build_zip`, `expire_exports` · [OPS] exports bucket lifecycle · [MOB] Exports screen, share link · [TEST] | — → **3** (**S9**) | Streaming multipart zip is its own piece; not needed for the rehearsal. |
| GAL-03 Hide and report | [DB] reports · [API] hide/unhide/delete, report, auto-hide, moderation queue · [JOB] hide purge + invalidation, rebuild, purge deleted · [MOB] report sheet, ModerationQueue · [TEST] | 2 → **3** | CDN purge and moderation queue. |
| GAL-04 Save album + favourites | [DB] favourites · [API] favourite, download-list · [MOB] SaveAlbumSheet download queue, favourites filter · [TEST] | 3 → **3** | Zip replaced by save-to-phone; similar size. |
| GAL-05 Upload from phone gallery | [API] `gallery` purpose + limit · [MOB] picker, JPEG conversion, event choice, remaining count · [TEST] | 2 → **2** | Reuses CAM queue and pipeline. |
| **Total** | | **13 → 18** | S8 GAL drops from 8 to 10 pts with GAL-02b moved to S9. |

## 12. Dependencies and sequencing

| Needs | From |
| --- | --- |
| `photos`, `media.process` derivatives, upload queue, `/uploads` | CAM-01, CAM-05a, CAM-07 (S7) |
| CloudFront distribution + key group, exports bucket | CAM-01b, FND-07, PRV-04 |
| Event visibility per guest | SET-04 |
| Push to requester (export ready) | MSG-08 / APP devices |
| Reveal state | CAM-06 (S9) — until then `reveal_at = -infinity` (instant) |
| Consumers | FACE-04 (uses `visibleTo` + download endpoints), PRV export (guest's own photos), PWP-01 |

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | Saving hundreds of photos to iOS Photos needs add-only permission and can be slow; download queue is resumable. |
| R2 | A hidden photo may persist in a device's disk cache until evicted; acceptable (only devices that already viewed it). |
| R3 | 15 GB whole-wedding zips are awkward on slow connections; offer per-event zips first in the UI. |
| Q1 | **PO:** auto-hide threshold default 3 distinct reports — OK? |
| Q2 | **PO:** may guests delete their own photos after reveal? Default yes (shot not refunded). |
| Q3 | **PO:** show uploader first name to guests (default) or anonymous? |
| Q4 | **PO:** guest zip off by default (`guestZipEnabled=false`) in favour of "Save album to phone" — confirm the GAL-04 reinterpretation. |

## 14. Deviations from the baseline

| Baseline / backlog | This design | Why |
| --- | --- | --- |
| GAL-02 "link emailed/WhatsApped" | Push + in-app Exports card with share sheet | No email provider in the baseline; a WhatsApp template for a host-only link isn't worth Meta approval. |
| GAL-04 guest full-album zip | "Save album to phone" (zip optional per wedding) | Zips don't work on phones. |
| Baseline names CloudFront for previews only | Unchanged; adds `cloudfront:CreateInvalidation` to the app role (listed in 12-cam.md §14) | Immediate hide. |
