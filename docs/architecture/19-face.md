# E19 — Find my photos (FACE)

Status: design · Owner module: `apps/api/src/modules/faces` · App: `apps/mobile/src/features/faces` · SQL: [`sql/19-face.sql`](./sql/19-face.sql) (builds on [`sql/12-cam.sql`](./sql/12-cam.sql))

## 1. Summary

A guest who **opts in** (DPDP purpose `face_match`) takes a selfie; Mehfil finds the gallery photos they appear in and shows them under **"My photos"** with download. Matching runs **only against opted-in guests' selfies**, is **incremental** as new photos arrive and when new guests opt in, and all face data is **deleted on withdrawal and with the wedding** (with a verification report).

| Story | Plan | Proposed |
| --- | --- | --- |
| FACE-01 Spike: provider choice | Pilot · S11 | S11 (+ legal sign-off on indexing mode, see Q1) |
| FACE-02 Opt-in and selfie | S13 | S13 |
| FACE-03 Matching worker | S13 | **Split:** 03a collection + photo indexing + backfill; 03b selfie search + incremental matching — both S13 |
| FACE-04 "My photos" view | S13 | S13 |
| FACE-05 Face data deletion | S13 | S13 |

**Stack reinterpretation.** Selfie capture uses the RN front camera (VisionCamera) and the shared upload queue; "My photos" is a Guest-mode gallery filter. No lite-web flow.

## 2. Key decisions

### Provider comparison (input to FACE-01, which confirms with 500 real photos)

| Criterion | AWS Rekognition (ap-south-1, Mumbai) | Self-hosted InsightFace on the EC2 box |
| --- | --- | --- |
| Data location | Mumbai region; opt out of AWS AI-service content use via an Organizations AI opt-out policy | On our box |
| **Licence** | Pay per call | Code MIT, but the **pretrained models (buffalo_l etc.) are licensed for non-commercial research only**; commercial use needs a paid licence from InsightFace |
| Accuracy (expected) | Strong general model; must verify on low-light Sangeet, veils/sehra, heavy makeup, siblings | ArcFace r50 is state of the art on benchmarks; same verification needed |
| Multi-face photos | `IndexFaces` stores up to 100 faces per image in one call; `SearchFaces` by face id | Full control (detect → align → embed every face) |
| Incremental both ways | Native: new photo → search its faces against the collection; new selfie → one search returns all matching photo faces | We'd store embeddings ourselves (pgvector or in-memory) |
| Compute | None on our box | SCRFD + ArcFace on CPU ≈ 0.2–0.4 s/photo; competes with `sharp` at the 300 uploads/min peak on the single `m7g.xlarge` (OPS); likely needs a second instance |
| Ops / team fit | SDK call from the TS worker; `FakeFaceProvider` in tests | New Python/ONNX service (or `onnxruntime-node` + custom alignment code), model files, monitoring |
| Sensitive data we hold | Provider face ids only; vectors stay in Rekognition | 512-d embeddings in our DB and backups |
| Cost per large wedding (15k photos, ~3 faces searched each) | ≈ 15k × (1 + 3) × ~US$0.001 ≈ **US$60** (typical 5k-photo wedding ≈ US$20); storage negligible | Licence (unknown, quote needed) + ~US$50–100/month for a second instance in season |
| Latency | ~0.3–1 s per call; default TPS quotas in Mumbai may be low → quota increase | Bounded by our CPU |

**Recommendation: Rekognition**, one collection per wedding. The licence blocks InsightFace for a commercial product without a separate deal, it would load the one box at exactly the peak, and it would put face embeddings in our database and backups. Revisit at ~200 weddings/season if per-call cost dominates.

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Provider | Rekognition behind `FaceProvider` (`RekognitionFaceProvider`, `FakeFaceProvider`) | InsightFace self-hosted | Table above. |
| Indexing mode | **Collection mode:** one Rekognition collection per wedding holding opted-in selfie faces (`ExternalImageId = g:<guestId>`) and gallery photo faces (`p:<photoId>`); results filtered to `g:` hits | **Transient mode:** detect faces, search each crop against selfies only, store nothing for photos | Collection mode makes both directions incremental at 1–2 calls; transient mode needs a full re-scan (~US$40–60) for every batch of late opt-ins after the wedding. **Collection mode stores face vectors of people who haven't opted in** (unlinked to identity, never searchable except by an opted-in selfie) — needs counsel sign-off (Q1). Transient mode is the fallback if counsel says no. |
| When photos are indexed | **Lazily**: only once the wedding has ≥ 1 active enrolment; first enrolment triggers a backfill | Index every photo at upload | No face data at all for weddings where nobody opts in; saves cost. |
| Collection lifetime | Deleted when the last active enrolment withdraws, and at PRV `face_data` expiry (wedding end + 30 d) | Keep with the photos | Minimisation; late opt-ins after +30 d aren't supported. |
| Match results | `face_matches` kept after the collection is deleted, until withdrawal or photo retention (PO Q2) | Delete with vectors | "My photos" stays useful for months; matches are the guest's own consented data, not biometrics. |
| Threshold | `FaceMatchThreshold` 95 (per-wedding override 80–99.9), "Not me" dismiss | Default 80 | Families have look-alike siblings/cousins; false positives are worse than misses. Tuned in FACE-01. |
| Liveness / selfie proof | None; exactly one good-quality face required | Rekognition Face Liveness | "My photos" only filters photos the guest can already see in the gallery, so a fake selfie reveals nothing new. |
| Who can enrol | Guests with `age_band` ≠ `child` | Guardian consent for children | DPDP restricts children's data and tracking; children's own matching isn't worth the risk. |
| Selfie storage | Deleted right after indexing (`selfies/` prefix, 1-day lifecycle backstop) | Keep for re-indexing | Vector is enough; provider change → ask guests to retake. |

## 3. Data model

DDL: [`sql/19-face.sql`](./sql/19-face.sql). **Schema check passed** (`scripts/check-schema.sh arch_face 000-core.sql 12-cam.sql 19-face.sql` → OK; also with all design files). No images or embeddings are stored in Postgres.

| Table | Purpose | Notes |
| --- | --- | --- |
| `face_collections` | One per wedding: provider, `collection_id`, status, `match_threshold`, backfill status/cursor, `vectors_delete_at`, `api_calls` (cost meter), deletion report | FK to `weddings` **ON DELETE RESTRICT**: wedding purge must call the FACE participant (DeleteCollection) first, which then removes the row. |
| `face_enrolments` | A guest's opt-in: `consent_id` (`face_match`), selfie media id, provider face id, status (`pending`, `active`, `rejected`, `withdrawn`, `deleted`), reject reason | One live enrolment per guest. |
| `face_photo_index` | Per photo: indexed/no_faces/failed/purged, provider face ids, count | Lets a hidden/deleted photo's faces be removed; makes indexing idempotent. |
| `face_matches` | (enrolment, photo) → similarity, matched face id, bbox, `dismissed_at` | Cascades with the enrolment (withdrawal) and the photo. Index `(guest_id, created_at) WHERE dismissed_at IS NULL`. |

Feature switch: `weddings.settings.faceSearch.enabled` (proposed key for SET's settings schema, default false; plan-gated to Complete by BIL-01).

Retention (PRV `face_data`, +30 d after the wedding): collection deleted → enrolments `deleted`, `face_photo_index` → `purged`. Matches follow Q2.

## 4. API

Proposed ROL action: `faces.manage` (owner, co_host). Hosts never see who matched which photo beyond aggregate counts.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/guest/faces` | guest | Feature on?, my enrolment status, match count, data deletion date | — |
| POST | `/v1/guest/faces/enrolment` | guest | Start (or replace) enrolment: `{ contentType, byteSize, sha256 }` → enrolment + presigned PUT to `selfies/` | `FACE_DISABLED` 404, `FACE_CONSENT_REQUIRED` 403, `FACE_CHILD_NOT_ALLOWED` 403, `FACE_WINDOW_CLOSED` 409 (after +30 d) |
| GET | `/v1/guest/faces/enrolment` | guest | Status: pending / active / rejected (`no_face`, `multiple_faces`, `low_quality`) | — |
| DELETE | `/v1/guest/faces/enrolment` | guest | Withdraw (also triggered by PRV consent withdrawal) | — |
| GET | `/v1/guest/faces/photos?cursor=` | guest | "My photos": matched photos that pass GAL `visibleTo`, newest first, same item shape as the gallery | — |
| POST | `/v1/guest/faces/photos/:pid/dismiss` | guest | "Not me" | 404 |
| GET / PATCH | `/v1/weddings/:wid/faces` | GET host roles; PATCH `faces.manage` | Enable/disable, threshold; stats: enrolled, photos indexed, backfill progress, API calls/est. cost | `FACE_PLAN_REQUIRED` 402 |

Upload completion uses the generic `POST /v1/uploads/:mediaId/complete` (purpose `selfie`), which enqueues `face.enrol`.

**Start enrolment** — `POST /v1/guest/faces/enrolment` `{ "contentType": "image/jpeg", "byteSize": 182004, "sha256": "…" }` →
```json
{ "enrolmentId": "f2…", "status": "pending",
  "upload": { "method": "PUT", "url": "https://mehfil-prod-media.s3.ap-south-1.amazonaws.com/selfies/2b4…/9d…?X-Amz-…",
              "headers": { "Content-Type": "image/jpeg", "Content-Length": "182004", "x-amz-checksum-sha256": "…" },
              "expiresAt": "…" },
  "deletesFaceDataOn": "2027-05-30" }
```

**My photos** — `GET /v1/guest/faces/photos` → `{ "items": [ { "id": "0c7…", "thumbUrl": "…", "previewUrl": "…", "eventId": "…", "capturedAt": "…", "similarity": 98.7, "bbox": { "left": 0.41, "top": 0.22, "width": 0.08, "height": 0.11 } } ], "nextCursor": "…", "status": "active", "indexing": { "pending": 120 } }`

## 5. Jobs, events and realtime

All on a dedicated pg-boss queue name `faces` grouped with `media` workers (concurrency 4, tuned to the Rekognition TPS quota); every Rekognition call increments `face_collections.api_calls`. `ThrottlingException` / `ProvisionedThroughputExceeded` → retry with backoff 5 s × 2ⁿ, never DLQ on throttling alone.

| Job | Trigger | Payload | Behaviour |
| --- | --- | --- | --- |
| `face.enrol` | selfie upload complete | `{ enrolmentId }` | Ensure collection (`CreateCollection` `mehfil-<env>-<weddingId>` on first enrolment → enqueue `face.backfill`). `IndexFaces` on the selfie (S3Object, `MaxFaces 2`, `QualityFilter HIGH`, `ExternalImageId g:<guestId>`): 0 faces → `rejected no_face`; 2 → delete both, `rejected multiple_faces`. Else store face id, `active`. `SearchFaces(selfieFaceId, threshold, MaxFaces 4096)` → keep `p:` hits → upsert `face_matches`. Delete selfie object; a replaced enrolment's old face is deleted. Push "We found 23 photos of you". |
| `face.backfill` | first enrolment | `{ weddingId }` | Page ready, visible photos by `media_id > backfill_cursor` (500 per run) → enqueue `face.index_photo` (rate-limited), advance cursor, re-enqueue itself until done. |
| `face.index_photo` | `photo.ready` (only if collection `active`), `photo.unhidden`, backfill | `{ photoId }` | Skip if already indexed or photo hidden/deleted. `IndexFaces` on `orig.jpg` (Rekognition reads JPEG/PNG, not WebP; `MaxFaces 15`, `QualityFilter MEDIUM`, `ExternalImageId p:<photoId>`); drop faces < 40 px. Record face ids. For each new face `SearchFaces(faceId, threshold, MaxFaces 10)` → `g:` hits → active enrolment → insert match. |
| `face.unindex_photo` | `photo.hidden`, `photo.deleted` | `{ photoId }` | `DeleteFaces(provider_face_ids)`; delete matches for the photo; index row `purged`. |
| `face.withdraw` | `DELETE /enrolment`, `privacy.consent_changed(face_match, false)` | `{ enrolmentId }` | `DeleteFaces(selfie face)`; delete matches (cascade); `deleted`. If no active enrolments remain → `face.delete_collection`. Done within minutes (PRV SLA 24 h). |
| `face.delete_collection` | last withdrawal, PRV `face_data` expiry, wedding purge | `{ weddingId, reason }` | `DeleteCollection`; enrolments → `deleted`; index rows → `purged`; verify with `DescribeCollection` = not found; write `deletion_report`; `audit.record('face.collection.delete')`. |
| FACE `PurgeParticipant` (PRV order 10) | guest erasure, class `face_data`, wedding purge | — | Guest: as `face.withdraw` + delete their matches. Class: `face.delete_collection`. Wedding: same + delete the `face_collections` row. `verify()`: provider face ids of the subject no longer listed (`ListFaces` with `FaceIds`) / collection gone. |
| `face.verify_deletions` (cron daily) | — | — | Collections marked deleted must not exist; withdrawn enrolments' faces must be gone; mismatches page on-call. This is FACE-05's "verified by job report". |

Events consumed: `photo.ready`, `photo.hidden`, `photo.unhidden`, `photo.deleted` (CAM/GAL), `privacy.consent_changed`. Emitted: `face.matched { guestId, count }` (push). No SSE; "My photos" refetches on focus.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | `FindMyPhotosIntro` (Photos tab card) | Plain-language notice: what a selfie is used for, that only your matches are shown to you, deletion date, withdraw anytime; consent toggle (PRV `face_match`, separate, unticked) |
| Guest | `SelfieCapture` | Front camera with an oval guide, good-light hint, one shot, retake; rejection reasons shown with fixes ("Only you in the photo, please") |
| Guest | `MyPhotos` | Same grid as GAL with "Not me" long-press, download/save-all reuse GAL; "Still scanning 120 photos" while indexing |
| Guest | `FaceSettings` (Me tab) | Status, retake selfie, withdraw (confirm) |
| Host | `FaceSearchSettings` | Enable (owner/co_host), threshold (advanced), stats and estimated cost |

Query keys: `['guest','faces']`, `['guest','faces','photos']` (infinite), `['wedding',wid,'faces']`. Selfie goes through the upload queue (not `sensitive` mode but not saved to the gallery). Children's member profiles don't show the feature. Accessibility: one-step flow, large buttons, voice-over prompts for framing.

## 7. Guest lite web

Not applicable: needs the front camera and the app gallery. The lite page can mention "Find your photos in the app".

## 8. Security and privacy

- **Consent:** separate explicit `face_match` consent, off by default; no enrolment, no indexing for the wedding until someone opts in; withdrawal deletes face data within minutes.
- **Non-participants (collection mode):** photo faces are stored only as provider vectors keyed by photo id, never linked to an identity unless they match an opted-in selfie, never exposed through any API, deleted at +30 d, on photo hide/delete and when the last enrolment ends. The `photos` and privacy notices must say photos may be scanned to help guests who opt in find themselves (PRV copy). **Counsel sign-off required before FACE-03 ships (Q1).**
- **Children:** cannot enrol; photo faces of children may be indexed in collection mode (same caveat).
- **No access expansion:** "My photos" is intersected with GAL `visibleTo`; hosts see aggregates only.
- **Provider settings:** Rekognition in `ap-south-1`; AWS Organizations AI-services opt-out policy for Rekognition; IAM limited to `rekognition:*Faces`, `SearchFaces`, `CreateCollection`/`DeleteCollection`/`DescribeCollection` on `collection/mehfil-<env>-*`, plus `s3:GetObject` on `weddings/*/photos/*/orig.jpg` and `selfies/*`.
- **Rate limits:** enrolment 5/day per guest; dismiss 120/hour.
- **Audit:** `face.enable`/`disable`, `face.collection.create`/`delete`, enrolment withdraw.
- **Store disclosures:** biometric classification for Apple/Play is a counsel item (PRV).

## 9. Scale and performance

| Stress point | Load | How it holds |
| --- | --- | --- |
| Live Sangeet with face search on | up to 5 photos/s → 5 `IndexFaces` + ~15 `SearchFaces` per second across weddings | **Request a Rekognition TPS quota increase in ap-south-1 before pilots** (long lead; add to VAL). Jobs queue and catch up; "My photos" is eventually consistent (target p95 < 10 min). |
| Backfill on first enrolment | 15k photos | Rate-limited to a share of TPS (e.g. 5/s → ~50 min); progress shown to guest and host. |
| Late opt-in | 1 guest | 2 calls; matches in seconds. |
| "My photos" query | per guest | Index on `face_matches(guest_id)` + PK join to `photos`: 0.5 ms on 360k sample matches (EXPLAIN). |
| Cost | ≈ US$0.004 per photo while enrolments exist | `api_calls` metered per wedding; alert above US$100/wedding. |

## 10. Testing plan

| Level | What |
| --- | --- |
| FACE-01 spike | 500 photos from consenting team/friends' weddings (low light, veils/sehra, makeup, kids, siblings), 20 enrolled volunteers: precision/recall at thresholds 90/95/98, filtered vs unfiltered (CAM film looks), latency, real ap-south-1 price and TPS quotas. InsightFace only if its licence permits evaluation. Output: provider + threshold + Q1 recommendation. |
| Unit | ExternalImageId parse; threshold handling; reject-reason mapping. |
| API e2e (`FakeFaceProvider`: deterministic "faces" encoded in fixture names) | No consent → 403; child → 403; enrol → backfill → matches; new photo after enrolment matches; hidden photo's matches disappear and are restored on unhide; "My photos" never returns hidden/unrevealed/other-group photos; withdrawal deletes provider faces and matches and deletes the collection when last; PRV participant `verify()` = 0; wedding purge blocked until participant ran. |
| Resilience | Throttling fake → retries without DLQ; provider outage → jobs wait; idempotent re-run of `face.index_photo`. |
| Mobile | RNTL: intro/consent, selfie reject messages, Not me; device: front camera on Android 9. |

Observability: queue `faces` depth/age, Rekognition throttles/min, per-wedding `api_calls`, `face.verify_deletions` failures (page).

## 11. Story breakdown

| Story | Tasks | Pts (backlog → revised) | Why |
| --- | --- | --- | --- |
| FACE-01 Spike | [OPS] dataset with consent, Rekognition test account + AI opt-out, quota check · [TEST] accuracy/cost/latency report, licence check | 3 → **3** | Unchanged; adds licence + TPS check. |
| FACE-02 Opt-in and selfie | [DB] enrolments · [API] enrolment endpoints, `selfie` upload policy · [MOB] intro, consent, SelfieCapture, settings · [TEST] | 3 → **3** | Reuses PRV consent + upload queue. |
| **FACE-03a** Collections and indexing | [DB] collections, photo index · [JOB] collection lifecycle, backfill, `index_photo`, `unindex_photo`, throttling · [API] `FaceProvider` + Rekognition + fake · [OPS] IAM · [TEST] | 5 → **5** | |
| **FACE-03b** Matching | [JOB] `face.enrol` search, per-face search on new photos, push · [DB] matches · [TEST] | — → **3** | Both directions of incremental matching. |
| FACE-04 "My photos" | [API] list + dismiss (GAL `visibleTo`) · [MOB] MyPhotos | 2 → **2** | Reuses GAL grid/downloads. |
| FACE-05 Face data deletion | [API] PurgeParticipant · [JOB] withdraw, delete_collection, verify_deletions · [TEST] | 2 → **3** | Three deletion paths + daily verification report. |
| **Total** | | **15 → 19** | |

## 12. Dependencies and sequencing

| Needs | From |
| --- | --- |
| `photos`, `photo.ready/hidden/unhidden/deleted`, upload queue, `selfie` purpose + `selfies/` prefix | CAM (12-cam.md) |
| `visibleTo`, grid and downloads | GAL-01/02 |
| `face_match` consent, `privacy.consent_changed`, `PurgeParticipant`, class `face_data` | PRV-01/02a/03 |
| `age_band` on guests | GST |
| `settings.faceSearch.enabled` key; plan gate | SET-06 (schema PR), BIL-01 |
| Rekognition quota increase, AI opt-out policy | **New VAL/OPS item before S11** |
| Counsel decision on collection vs transient mode | Before FACE-03 (S13); raise in S11 with the spike result |

S13 total becomes 3 + 5 + 3 + 2 + 3 (FACE) + GAL-04/05 5 + TRV-05 5 = 26 + 8 buffer — over the 24 planned. Move **TRV-05** or **GAL-05** out of S13 (GAL-05 is small and could go to S9/S10 where the camera already exists).

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | Accuracy on Indian wedding photos (low light, veils, sehra, makeup, filters) is unproven; FACE-01 decides threshold and whether filters are applied before indexing. |
| R2 | Default Rekognition TPS in ap-south-1 may throttle a live Sangeet; quota request is long-lead. |
| R3 | Rekognition per-call cost grows with faces per photo; metering + alert; plan-gated. |
| Q1 | **Counsel/PO:** approve **collection mode** (vectors of non-opted-in faces stored, unlinked, ≤ 30 days after the wedding) or require **transient mode** (no storage of non-participant faces; late opt-ins matched by a costly nightly rescan)? |
| Q2 | **PO:** keep "My photos" matches after face vectors are deleted at +30 d (proposed) or delete them too (PRV's `face_data` class reading)? |
| Q3 | **PO:** plan gating (Complete only) and a per-wedding cost cap? |
| Q4 | **PO:** allow hosts (couple) to enrol as guests? Hosts are users, not guests; proposed: no in v1. |

## 14. Deviations from the baseline

| Baseline / other design | This design | Why |
| --- | --- | --- |
| PRV `face_data` class = "selfies + embeddings" | Embeddings (provider vectors) and selfies deleted at +30 d; **match rows kept** until photo retention or withdrawal (pending Q2) | Keeps "My photos" useful; no biometrics retained. **PRV retention table note needed if accepted.** |
| FND queues `messaging`, `media`, `default` | Adds pg-boss queue `faces`, run by the media worker group | Rekognition throttling must not block `sharp` processing. |
| Baseline names no third-party ML service | AWS Rekognition (ap-south-1) behind `FaceProvider` | Provider choice per FACE-01. |
