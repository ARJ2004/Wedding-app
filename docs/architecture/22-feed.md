# E22 — Wedding feed and moderation (FEED)

## 1. Summary

A small, host-moderated space for guests: text and photo posts in one thread per event plus an "Everyone" thread, **wishes** to the couple (public or private to the hosts), emoji reactions, host hide, pin and pre-moderation, and a guest report button. There are no comments, no direct messages, no follower graph and no realtime.

| Story | Covered by |
| --- | --- |
| FEED-01 Posts and threads per event | `feed_posts`, `feed_post_media`, thread read/post API, app thread screens |
| FEED-02 Moderation | `feed_settings`, statuses `pending/held/hidden`, pins, `feed_reports`, host queue |
| FEED-03 Wishes and reactions | `kind='wish'` with `audience`, `feed_reactions`, wishes tab, lite web wish form |

Phase: Pilot, **S15 (14 – 27 Jun 2027)**, only if pilot hosts ask for it (backlog gate). §11 proposes a re-cut so that **wishes can ship without the feed**.

**Changes for the new stack.** FEED-01 depended on GH-01 (PWA). The guest surface is now the React Native app's Guest mode, so it depends on the guest home in the app instead. Photos are core `media_objects` uploaded through the standard presigned-PUT flow. No Redis, no SSE.

### The PRD open question: does a feed compete with the family WhatsApp group?

Probably yes for chatter. WhatsApp wins for back-and-forth, and we should not try to replace it. Three things a WhatsApp group can't do well, and which this design keeps:

1. **Wishes collected in one place for the couple**, including private ones and ones from guests not in "the group". They are also the seed for WSH-01 video wishes and the PWP-01 thank-you book.
2. **Per-event, host-curated content**: pinned "bus leaves at 6" posts sit next to photos from that event, inside the app guests already use for schedule and camera.
3. **Mixed families**: the bride's side and the groom's side are rarely in one WhatsApp group.

So the feed has three modes per wedding: `off` (default), `wishes_only` and `full`. Gate 3 measures posts per active guest in `full` mode, and the share of weddings that switch it on.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Feed default | `off`; host picks `wishes_only` or `full` in settings | On by default | Answers the WhatsApp worry. Nothing to moderate unless the host asks for it. |
| Threads | Implicit: `(wedding_id, event_id)`, with `event_id NULL` = Everyone | A `feed_threads` table | One thread per event is fixed by the story. No extra table to keep in sync with events. |
| Replies | **None**; reactions only | Comment threads | Halves the moderation surface and keeps it from turning into a chat app. Conversation belongs on WhatsApp. |
| Reactions | One per person per post from a fixed set of 6; counts aggregated on read | Denormalised counters | 20 posts × ≤ 2,000 reactions grouped through the PK index is cheap (EXPLAIN checked). No hot-row contention on viral posts. |
| Realtime | Pull-to-refresh + 30 s poll while the screen is focused; push only for host-pinned posts | SSE channel per wedding | 2,000 open connections for low-value content would compete with arrivals and quiz. Nobody needs a feed post in under 30 s. |
| Automated content moderation | Word list (en, hi, Hinglish) puts a post in `pending`; reports auto-hold at N distinct reporters | AWS Rekognition / Comprehend | Cost and latency, weak on Indic text, false positives at weddings (haldi photos). Hosts know their guests. |
| Photo storage | Core `media_objects` (kind `photo`) linked through `feed_post_media`; up to 4 per post | Re-use the camera/gallery tables | Feed photos are a separate purpose with their own limit. Gallery membership must come from the GAL module's own data, not `kind`. |
| Private wishes | `audience='hosts'` on wish posts | A separate wishes table | Same moderation, media and retention code. WSH-01 extends it with video. |

## 3. Data model

SQL: [`sql/22-feed.sql`](sql/22-feed.sql). Depends on `000-core.sql` only. **Schema check: `OK` (21 tables in `arch_feed`). It also applies cleanly after every other design file present.**

| Table | Purpose | Notes |
| --- | --- | --- |
| `feed_settings` | Per-wedding mode (`off`/`wishes_only`/`full`), `premoderation`, `auto_hold_reports` (default 3) | A missing row means `off` |
| `feed_posts` | Posts and wishes | `status`: `pending` (pre-moderation or word list), `visible`, `held` (auto-held by reports), `hidden` (host). Author is a guest or a host user; at most one is set. `pinned_at` only when visible. `deleted_at` = author deleted it. `source` = `app`/`lite_web`. |
| `feed_post_media` | 0–4 photos per post (1 video for WSH-01) | `UNIQUE(media_id)`: a media object belongs to one post |
| `feed_reactions` | PK `(post_id, reactor_type, reactor_id)` | Polymorphic reactor (guest or user). PRV guest deletion removes rows by `(reactor_type, reactor_id)` (index provided). |
| `feed_reports` | One per guest per post | Open-reports index for the host queue |

Indexes match the reads: thread page `(wedding_id, event_id, created_at DESC, id DESC) WHERE visible ∧ not deleted ∧ audience='all'`; pinned strip; moderation queue `(wedding_id, status, created_at) WHERE status IN (pending, held)`; wishes tab.

**EXPLAIN results** (50 weddings, 60 k posts, 480 k reactions): an event thread page and the Everyone thread (`event_id IS NULL`) both use `feed_posts_thread_idx`. Reaction counts for a page of 20 use the `feed_reactions` PK.

## 4. API

Host roles = `owner`, `co_host`, `planner_member` (`feed.moderate`). `desk_staff`: no feed access (404). Guests can only see threads for events they are invited to, plus Everyone. A post in another thread or another wedding returns 404.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET/PUT | `/v1/weddings/:w/feed/settings` | host (PUT), guest (GET mode only) | Mode, pre-moderation, report threshold | |
| GET | `/v1/weddings/:w/feed/threads` | guest, host | Threads visible to me, with latest post time | `FEED_OFF` (404 to guests) |
| GET | `/v1/weddings/:w/feed/posts?event=<id\|everyone>&cursor=&limit=` | guest, host | `{pinned:[≤3], items:[…], nextCursor}`. Hosts may add `status=pending\|held\|hidden` | |
| POST | `/v1/weddings/:w/feed/posts` | guest, host | `{event, kind, audience, body, mediaIds[≤4]}`. `Idempotency-Key` supported (offline retry) | `FEED_OFF`, `FEED_WISHES_ONLY`, `FEED_MEDIA_INVALID`, `FEED_CONSENT_PHOTOS` (needs `photos` consent), `RATE_LIMITED` |
| PATCH | `/v1/weddings/:w/feed/posts/:id` | author | Edit body within 15 min | `FEED_EDIT_WINDOW` |
| DELETE | `/v1/weddings/:w/feed/posts/:id` | author, host | Author: soft delete. Host: same, audited | |
| POST | `/v1/weddings/:w/feed/posts/:id/moderation` | host | `{action: approve\|hide\|unhide\|pin\|unpin}` | `FEED_PIN_LIMIT` (3 per thread) |
| PUT/DELETE | `/v1/weddings/:w/feed/posts/:id/reaction` | guest, host | Set or clear my reaction `{emoji}` | |
| POST | `/v1/weddings/:w/feed/posts/:id/reports` | guest | `{reason, note?}` | Repeat → 200 (no-op) |
| GET | `/v1/weddings/:w/feed/moderation` | host | Queue: pending + held + open reports, with counts | |
| POST | `/v1/weddings/:w/feed/reports/:id/resolve` | host | `{resolution: kept\|hidden}` | |
| GET | `/v1/weddings/:w/feed/wishes?cursor=` | host | All wishes, including `audience='hosts'` | |
| GET/POST | `/g/:token/wish` | guest (lite web cookie) | Server-rendered text-only wish form (`source='lite_web'`) | |

**Create a post:**

```http
POST /v1/weddings/7f…/feed/posts
Idempotency-Key: 9b1c…
{ "event": "e-sangeet…", "kind": "post", "body": "Dadi stole the show 💃", "mediaIds": ["m1…", "m2…"] }

201 { "id": "p…", "status": "visible", "createdAt": "…", "media": [{ "id": "m1…", "previewUrl": "https://cdn…", "processing": false }] }
201 { "id": "p…", "status": "pending" }   // pre-moderation on, or the word list matched; only the author sees it
```

**Read a thread page:**

```http
GET /v1/weddings/7f…/feed/posts?event=everyone&limit=20
200 { "pinned": [ … ], "items": [ { "id": "p…", "kind": "wish", "author": { "name": "Meena S.", "isHost": false },
      "body": "…", "media": [ … ], "reactions": { "heart": 41, "clap": 7 }, "myReaction": "heart", "createdAt": "…" } ],
      "nextCursor": "MjAyNy0wNi0wNVQxNTo…" }
```

Media must be `processed` and uploaded by the caller in this wedding. A post whose photos are still processing is created as visible, and the app shows a placeholder until previews exist.

## 5. Jobs, events and realtime

| Item | Detail |
| --- | --- |
| Realtime | None (30 s poll while focused) |
| Domain events | `feed.post_created` (status pending) → host badge count. `feed.post_pinned` → push to guests of that thread (FCM through the push module, at most 3 pins per thread per day). `feed.report_threshold` → status `held` in the same transaction, plus a host push. |
| pg-boss | `feed.retention` daily cron: hard-delete posts with `deleted_at` older than 30 days. Posts in weddings past photo retention are hard-deleted and their media marked for PRV deletion. |
| Media | Standard `media.process` (CAM) with upload `purpose='feed'`. EXIF/GPS stripped before any preview is served. |

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Guest | Home → `FeedThreads` (Everyone + my events) → `FeedThread` | Pinned strip, then posts. The reaction picker has 6 large emoji. Report from the "…" menu. |
| Guest | `FeedCompose` | Text ≤ 1000 characters, up to 4 photos from the camera roll (offline queue reuses the CAM upload queue). Toggle "Wish for the couple" → "Only the couple can see" option. |
| Guest | `WishesCompose` (only entry point in `wishes_only` mode) | Big text box; "Send to couple" |
| Host | `FeedSettings` | Mode, pre-moderation, report threshold |
| Host | `FeedModeration` (badge) | Pending / held / reported tabs with approve, hide, keep |
| Host | `WishesBook` | All wishes; filter private/public; share sheet (WSH-01 extends with reel/book) |

- Query keys: `['feed', weddingId, 'threads']`, `['feed', weddingId, 'posts', eventKey]` (infinite), `['feed', weddingId, 'moderation']`, `['feed', weddingId, 'wishes']`.
- Reactions are optimistic updates with rollback.
- **Offline:** the last 50 posts per thread are cached in MMKV. Composed posts queue with an `Idempotency-Key` and send on reconnect.
- **Budget Android:** FlashList, preview images 480 px WebP, no autoplay.
- **Accessibility:** large text; reaction buttons ≥ 48 dp with labels for screen readers; high contrast.

## 7. Guest lite web

`/g/:token/wish`: a text-only wish form and a "thank you" page. It is server-rendered with no JavaScript needed. Elders who never install the app are the people most likely to want to send a blessing. Reading the feed stays in the app.

## 8. Security and privacy

- Tenant scoping and thread visibility checks on every read. Private wishes (`audience='hosts'`) are never returned to guests, including their counts.
- Moderation actions (approve, hide, unhide, pin, delete-by-host, report resolve) → `audit_log` with before/after status.
- Photo posts need active `photos` consent (DPDP purpose, PRV). Withdrawing consent hides that guest's photo posts.
- Retention: feed photos follow the wedding's photo retention. Author-deleted posts are purged after 30 days. PRV guest deletion cascades posts, reports (`SET NULL` on reporter) and reactions (by reactor index).
- Rate limits: 10 posts/hour/guest, 60 reactions/min/guest, 10 reports/hour/guest. Feed photos: 20 per guest per wedding, separate from the camera shot limit.
- The serialiser exposes the author's display name only (first name + last initial). No phone numbers, party or group.
- Pre-moderated and held posts are visible only to their author and hosts.

## 9. Scale and performance

Worst case: a 2,000-guest wedding in `full` mode, about 3,000 posts, about 60 k reactions. Reads are index range scans with `LIMIT 20`, plus one grouped reaction query per page. A 30 s poll from 500 active phones is about 17 req/s, cheap, and it backs off to 120 s when the app is in the background. Photo uploads share the S3 path and CAM media worker. Feed photos are small next to the 300 uploads/min camera target, and the per-guest limit keeps them that way.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Status transitions (pre-moderation, word list, auto-hold threshold), pin limit, edit window |
| API e2e | Mode gates (`off` → 404, `wishes_only` blocks posts); thread visibility for non-invited event → 404; private wish never in guest responses; idempotent create; consent required for photo posts; report → auto-hold at N distinct reporters; host actions audited; desk staff 404; other wedding 404; guest deletion removes reactions |
| Mobile | RNTL: compose with queued photos offline → sends on reconnect; optimistic reaction rollback; moderation queue actions |
| Lite web | Supertest: wish form renders without JS; CSRF token; rate limit |
| Device | Budget Android scroll of 200 posts with images at 60 fps target, no out-of-memory |

**Observability:** posts/day per wedding, pending-queue age (alert a host by push if > 2 h during the wedding), reports per wedding, share of weddings per mode (a Gate 3 metric).

## 11. Story breakdown

Proposed re-cut so wishes don't wait on the feed decision:

| Story | Tasks | Backlog | Revised | Why |
| --- | --- | --- | --- | --- |
| **FEED-03a Wishes** (can ship without the feed) | [DB] `feed_settings`, `feed_posts`, `feed_post_media`; [API] settings, create wish, wishes list; [MOB] WishesCompose, WishesBook, FeedSettings; [WEB] `/g/:token/wish`; [TEST] private-wish leakage, mode gates | part of 2 | **3** | Takes on the table and posting work from FEED-01, plus the lite web form |
| FEED-01 Threads and photo posts | [API] threads, thread page with pins + cursor, create post with media, edit/delete; [MOB] FeedThreads, FeedThread, FeedCompose (upload queue); [JOB] retention; [TEST] visibility, media validation, idempotency | 5 | **4** | Table and post work moved to FEED-03a; no comments |
| FEED-02 Moderation | [DB] `feed_reports`; [API] moderation actions, queue, reports, auto-hold, word list; [MOB] FeedModeration; [TEST] audit + threshold | 3 | **3** | Unchanged |
| FEED-03b Reactions | [DB] `feed_reactions`; [API] set/clear, aggregation; [MOB] reaction picker; [TEST] | part of 2 | **1** | |
| **Total** | | **10** | **11** | +1 for the lite web wish form |

## 12. Dependencies and sequencing

| Needs | From |
| --- | --- |
| Guest home in the RN app; guest JWT; lite web cookie session | APP-02 / GH (reinterpreted), ACC |
| Event invitation helper (`visibleEventIdsForGuest`) | RSV / SET |
| Upload flow with `purpose='feed'` and its own per-guest limit; `media.process` | CAM (needs `purpose` on the upload request) |
| `photos` consent check; retention and guest deletion hooks | PRV |
| Push to thread guests | APP / push module |
| **Coordination:** GAL must not treat every `media_objects.kind='photo'` row as a gallery photo | GAL / CAM |

Order: FEED-03a → FEED-01 → FEED-02 → FEED-03b. FEED-02 must ship **with** FEED-01: no feed without moderation.

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| Feed unused because WhatsApp wins | Default `off`; wishes-only mode; Gate 3 metric. **Product owner:** ship FEED-03a (3 pts) in S15 regardless of the feed decision? |
| Embarrassing photos or comments in front of elders | No comments; pre-moderation option; auto-hold on reports; host push for queue |
| Moderation load on a busy host on the wedding day | Default is post-moderation; auto-hold; a planner member can moderate |
| Feed photos vs gallery: should guests be able to share a feed photo to the gallery? | Out of scope; **product owner** decides later |
| Word list maintenance for Hindi and Hinglish | Small seed list in `packages/domain`; hosts can add words later (not in scope) |

## 14. Deviations from the baseline

1. **Guest lite web gains a wish form** (`/g/:token/wish`). The baseline limits lite web to schedule, RSVP, travel and "get the app". It is small and server-rendered.
2. Request to CAM: the upload request needs a `purpose` (`camera`/`gallery`/`feed`/`quiz`/`wish`), so that limits apply per purpose. Without it, feed photos would count against the shot limit.
