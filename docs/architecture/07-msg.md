# E07 — Messaging and announcements (MSG)

## 1. Summary

Delivers one sending pipeline for every message Mehfil sends — invites, RSVP and travel reminders, host announcements, OTPs, confirmations — over **WhatsApp** (primary), **SMS with DLT templates** (fallback) and **FCM push** (free, app users), behind a `MessagingProvider` interface with a `LogSinkProvider` for dev/test. It also owns the inbound webhook router that turns WhatsApp button replies into commands for RSV ("Attending") and ARR ("I've landed").

| Stories | Phase / sprint |
| --- | --- |
| MSG-01, 02, 03, 05, 06 (+ new MSG-11 inbound router) | MVP · S5 |
| MSG-04, 07 | MVP · S7 |
| MSG-08 (now **FCM push**, was web push), 09, 10 | Pilot readiness · S9 (MSG-08 recommended earlier, see §12) |

**Reinterpreted for the current stack:** "web push" (MSG-08) becomes FCM push to the React Native app using core `push_devices`; "fan-out worker" runs on **pg-boss** (no Redis/Celery); the composer and status views are **React Native Host-mode screens** (not a web console); the guest inbox is in the RN Guest mode and the guest lite web page.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| WhatsApp access | **Meta WhatsApp Cloud API direct** as the first adapter; Gupshup adapter as plan B | Gupshup or Interakt as primary | See comparison below: no per-message markup, signed webhooks (`X-Hub-Signature-256`), highest throughput tier, `biz_opaque_callback_data` echoes our delivery id (no status/ID race). A BSP stays possible behind the same interface if VAL-09 goes faster through one. |
| Sender model | **One Mehfil WhatsApp number** (display name approved in VAL-08) for all weddings; the wedding title is a template variable | A number per wedding / per planner | Template approval and quality rating are per number; per-wedding numbers multiply verification work. White-label numbers are WL-01 (P2). |
| Template management | **Templates as code** (`modules/messaging/templates/*.json`), pushed with a CLI (`pnpm msg:templates push`), status synced by cron | Admin UI for templates | No platform-admin role exists; templates change rarely and need review. |
| Announcement text | Host text goes into a variable of an approved **utility** template (`announcement_text`, `announcement_image`) | Free-form session messages | Free-form only works inside the 24 h customer-service window; most guests haven't messaged us. |
| Fan-out unit | **Batch jobs of 50 deliveries** on queue `messaging`; per-delivery retry jobs | One pg-boss job per recipient | 40 jobs instead of 2,000 per announcement; keeps pg-boss tables small at 50 weddings. |
| Idempotency | Unique `(message_id, guest_id, channel)` + claim via `UPDATE … WHERE status='queued'` + `Idempotency-Key` on create/send | Provider-side dedupe | Cloud API has no idempotency key. A crash after the provider accepted but before we wrote marks the row `unknown`; we **never auto-resend** an `unknown` (at-most-once for announcements), the status webhook reconciles it. |
| Status webhooks | Applied **inline** in the webhook request (one indexed UPDATE, monotonic `status_rank`) | Queue every status event as a job | ~6,000 status callbacks per 2,000-guest send; inline is ~1 ms each, jobs would triple pg-boss load. Only inbound replies and unmatched statuses go to a table + job. |
| Audience | Stored as a **filter spec**, resolved to recipients **at send time** | Snapshot recipients at compose time | Scheduled sends should reach guests added later; RSVP status changes between compose and send. |
| Cross-module filters and replies | **Registries owned by MSG** (`registerAudienceFilter`, `registerReplyHandler`) that RSV/ARR/TRV fill at boot | MSG importing RSV/ARR services | RSV and ARR call MSG to send; MSG calling them back would be a module cycle. Dependency inversion keeps MSG at the bottom. |
| SMS provider | **MSG91** (DLT-native, transactional route) behind `SmsProvider` | Gupshup SMS, Kaleyra | Decent DLT tooling and delivery reports; any of the three fits the interface. PO confirms with the DLT registration (VAL-10). |
| Push | **FCM HTTP v1** via `firebase-admin` `sendEach` (≤ 500 tokens/call) | OneSignal / Expo push | Baseline chooses FCM; no third party holding guest device tokens. |
| Fallback timer | `fallback_due_at` on the WhatsApp delivery + **1-minute cron sweep** | One delayed job per delivery | 2,000 delayed jobs per send vs one indexed query per minute. Failures that are final (e.g. "not a WhatsApp user") fall back immediately. |
| Opt-out scope | **Global per phone and channel** (`messaging_opt_outs`), honoured across weddings | Per wedding | One sender number: "STOP" means stop from that number. OTPs the guest requests are still sent. |
| Phones at rest | Only an **HMAC** (`to_hash`) in messaging tables; the clear number stays in `guests` | Copy phone onto deliveries | Minimisation; deletion of a guest leaves nothing re-identifiable here. |

### WhatsApp provider comparison

| | Meta Cloud API direct | Gupshup | Interakt |
| --- | --- | --- | --- |
| Cost | Meta rate card only | Meta rate + per-message markup | Meta rate + monthly plan |
| API fit for programmatic fan-out | Best (Graph API, documented, sandbox test number) | Good, but two API generations | Built for dashboard/SMB use; thinner API |
| Webhook security | HMAC-SHA256 with app secret | Shared token / IP allowlist (verify at spike) | Verify at spike |
| Throughput | 80 msg/s per number, raised automatically with quality | Passes through Meta limits | Passes through Meta limits |
| Onboarding / support | Self-serve; no human support | Helps with verification; Indian support; also sells DLT SMS | Fast onboarding, SMB support |
| **Verdict** | **Recommend** | Plan B if VAL-09 stalls (one vendor for WA + SMS) | Not recommended |

## 3. Data model

DDL: [`sql/07-msg.sql`](./sql/07-msg.sql). **Schema check passed** (`scripts/check-schema.sh arch_msg 000-core.sql 07-msg.sql` → `OK: 25 tables`). EXPLAIN on 630k sample deliveries (20 weddings × 15 messages × 2,100 guests): fallback sweep, webhook status update, guest inbox and per-message summary all use their indexes (< 15 ms).

| Table | Purpose | Notes |
| --- | --- | --- |
| `message_templates` | Platform catalogue: `key`, purpose, Meta category, `host_selectable` | Not wedding-scoped (one sender). |
| `message_template_variants` | One row per (template, channel, language, provider): provider template name, DLT template id, body, params schema, buttons, `approval_status` | L10N adds `hi`/`kn` rows. Only `approved` rows are selectable. |
| `messages` | Anything sent to guests: kind, template, host text, media, `audience` spec, channels, fallback settings, status, `scheduled_at`, `version`, `idempotency_key`, denormalised `stats` | Created by hosts (composer) or other modules (`created_by_module`). |
| `message_recipients` | Audience resolved at send: guest, party, language, `reply_ref`, `suppressed_reason`, `read_in_app_at` | Guest inbox (GH-06) reads this. |
| `message_deliveries` | One row per (message, guest, channel): status + `status_rank`, provider id, attempts, `billable_units`, `fallback_due_at`, timestamps | Idempotency unit. FK to recipient. |
| `messaging_webhook_events` | Inbound user replies and status events we couldn't match yet; deduped by `(provider, kind, external_id)` | Raw payload purged after 30 days. |
| `messaging_opt_outs` | `(phone_hash, channel)` | Kept indefinitely (needed to honour). |
| `message_quotas` | Per wedding: `limit_units`, `reserved_units`, `used_units`, warning/block timestamps | BIL-01 later sets `limit_units`. |
| `messaging_log_sink` | `LogSinkProvider` output in dev/test | Config refuses `MESSAGING_PROVIDER=log` in production. |
| `push_devices` (core; owned by `devices`, altered in `25-app.sql`) | MSG reads `locale`, `disabled_at`; reports FCM `UNREGISTERED` to `devices.disableToken()` | No MSG DDL. |

**Retention:** deliveries, recipients and webhook events are deleted 90 days after `weddings.ends_on` by a PRV-03 job (aggregates stay in `messages.stats`); webhook raw payloads after 30 days; `messaging_log_sink` truncated nightly in dev.

## 4. API

Roles: `owner`, `co_host`, `planner_member` have `msg.read`, `msg.compose`, `msg.send`. **`desk_staff` get nothing in this module** (ROL-02). Other weddings → 404.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/weddings/:wid/message-templates?purpose=&language=` | host roles | Approved, host-selectable templates with per-language availability | — |
| GET | `/v1/weddings/:wid/messages?status=&kind=&cursor=` | host roles | List (cursor pagination) | — |
| POST | `/v1/weddings/:wid/messages` | `msg.compose` | Create draft; `Idempotency-Key` | `MSG_TEMPLATE_NOT_APPROVED`, `MSG_BODY_TOO_LONG` |
| PATCH | `/v1/weddings/:wid/messages/:mid` | `msg.compose` | Edit draft or scheduled; needs `version` | `MSG_NOT_EDITABLE`, `MSG_VERSION_CONFLICT` |
| POST | `/v1/weddings/:wid/messages/audience-preview` | `msg.compose` | Count by channel/language, suppressed, units needed, quota left | `MSG_AUDIENCE_EMPTY` |
| GET | `/v1/weddings/:wid/messages/:mid/preview?language=` | host roles | Rendered WhatsApp/SMS/push text per language | — |
| POST | `/v1/weddings/:wid/messages/:mid/test` | `msg.send` | Send to the caller's own phone (not metered beyond 10/day) | `MSG_NO_PHONE_ON_ACCOUNT` |
| POST | `/v1/weddings/:wid/messages/:mid/send` | `msg.send` | Send now or `{scheduledAt}`; `Idempotency-Key`; 202 | `MSG_QUOTA_EXCEEDED`, `MSG_SCHEDULE_IN_PAST`, `MSG_ALREADY_SENT` |
| POST | `/v1/weddings/:wid/messages/:mid/cancel` | `msg.send` | Cancel scheduled; or stop an in-flight send (queued deliveries → `cancelled`) | `MSG_NOT_CANCELLABLE` |
| GET | `/v1/weddings/:wid/messages/:mid/summary` | host roles | Counts per channel × status, fallback count, timings | — |
| GET | `/v1/weddings/:wid/messages/:mid/deliveries?status=failed&cursor=` | host roles | Drill-down: guest name, party, channel, status, error label (phone masked except owner/co_host) | — |
| POST | `/v1/weddings/:wid/messages/:mid/retry-failed` | `msg.send` | Re-queue `failed` (not `unknown`) deliveries | `MSG_NOTHING_TO_RETRY` |
| GET | `/v1/weddings/:wid/messaging/quota` | host roles | Limit, used, reserved, warning state | — |
| GET | `/v1/weddings/:wid/messaging/replies?status=unmatched&cursor=` | host roles | Free-text replies guests sent (so hosts can follow up) | — |
| PUT | `/v1/weddings/:wid/guests/:gid/messaging-opt-out` | owner, co_host | Record an opt-out a guest asked for by phone; audit-logged | — |
| GET | `/v1/guest/announcements?cursor=` | guest | Inbox (GH-06): announcements sent to this guest, in their language | — |
| POST | `/v1/guest/announcements/:mid/read` | guest | Marks in-app read; sets push delivery `read` | — |
| PUT | `/v1/guest/messaging-preferences` | guest | `{ whatsapp: true/false }` opt-out/in for own phone | — |
| GET | `/v1/webhooks/whatsapp/meta` | Meta | `hub.challenge` verification | 403 on wrong verify token |
| POST | `/v1/webhooks/whatsapp/:provider` | provider | Statuses, inbound messages, template status | 401 on bad signature |
| POST | `/v1/webhooks/sms/:provider/:pathSecret` | provider | SMS delivery reports | 404 on bad secret |

**Internal module API** (`modules/messaging/index.ts`, used by RSV, TRV, ARR, ACC, PCK):

```ts
messaging.send({ weddingId, kind, templateKey, audience | guestIds, params, context, channels?, priority?, idempotencyKey }): Promise<{ messageId }>
messaging.sendOtp({ weddingId, phoneE164, code, language }): Promise<{ deliveryId }>   // priority queue, never quota-blocked
messaging.registerAudienceFilter(name, (weddingId, args) => Promise<string[] /* guestIds */>)
messaging.registerReplyHandler(actionPrefix, handler: InboundReplyHandler)
```

### Examples

`POST /v1/weddings/:wid/messages` (Idempotency-Key: `5c1e…`)

```json
{ "kind": "announcement", "templateKey": "announcement_image",
  "title": "Baraat bus timing", "bodyText": "Buses leave the hotel lobby at 4:15 pm sharp.",
  "sourceLanguage": "en", "mediaId": "6f…", "linkTarget": "schedule",
  "audience": { "events": ["e-baraat"], "rsvp": { "eventId": "e-baraat", "statuses": ["attending"] }, "groups": ["g-groom"] },
  "channels": ["whatsapp", "push"], "smsFallback": true, "fallbackAfterMinutes": 10 }
```
→ `201 { "id": "m-…", "status": "draft", "version": 1 }`

`POST /v1/weddings/:wid/messages/audience-preview` →

```json
{ "recipients": 412, "byChannel": { "whatsapp": 398, "push": 171, "smsFallbackEligible": 398 },
  "byLanguage": { "en": 301, "hi": 111 }, "suppressed": { "noPhone": 9, "optedOut": 5, "duplicatePhone": 0 },
  "missingTemplateLanguages": [], "unitsNeeded": 398, "quota": { "limit": 15000, "used": 6120, "reserved": 0 } }
```

`POST /v1/weddings/:wid/messages/:mid/send` `{ "scheduledAt": null }` → `202 { "status": "resolving", "recipientCountEstimate": 412 }`; `409 MSG_QUOTA_EXCEEDED` with `{ needed, remaining }`.

### Provider interfaces (`modules/messaging/providers/`)

```ts
interface MessagingProvider {             // WhatsApp: MetaCloudProvider, GupshupProvider; LogSinkProvider
  channel: 'whatsapp';
  sendTemplate(req: { to: string; templateName: string; language: string; params: string[];
    headerMediaUrl?: string; buttonPayloads?: string[]; callbackRef: string /* delivery id */ }): Promise<SendResult>;
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  parseWebhook(body: unknown): WebhookItem[];        // statuses | inbound | template_status
  listTemplates(): Promise<ProviderTemplateStatus[]>;
  submitTemplate(v: TemplateVariantDef): Promise<void>;
}
interface SmsProvider { sendDlt(req: { to; dltTemplateId; vars: string[]; unicode: boolean; callbackRef }): Promise<SendResult>; parseReport(...) }
interface PushProvider { sendMany(msgs: { token; title; body; data }[]): Promise<PushResult[]> }   // FcmPushProvider, LogSink
type SendResult = { ok: true; providerMessageId: string; billableUnits: number }
                | { ok: false; retryable: boolean; code: string; detail?: string };
```

### Inbound reply router (interface for RSV and ARR)

```ts
type InboundReplyCommand = {
  inboundId: string;                // messaging_webhook_events.id — handlers must be idempotent on it
  action: `rsv.${'attend'|'decline'|'maybe'}` | `arr.${'landed'|'at_hotel'|'running_late'}` | string;
  weddingId: string; guestId: string; partyId: string;
  messageId?: string; context: Record<string, unknown>;  // from messages.context, e.g. { eventIds: [...] }
  args: Record<string, string>;     // e.g. { minutesLate: "30" }
  providerMessageId: string;        // inbound WhatsApp id; ARR stores it as travel_status_updates.inbound_message_id
  receivedAt: Date;
};
type InboundReplyResult = { outcome: 'ok' | 'already_done' | 'rejected';
  reply?: { templateKey: string; params: Record<string, string> } };   // MSG sends it (free inside 24 h window)
interface InboundReplyHandler { handle(cmd: InboundReplyCommand): Promise<InboundReplyResult> }
```

Button payloads are `"<action>|<reply_ref>"` (e.g. `rsv.attend|k3j9…`). Resolution order: WhatsApp `context.id` → delivery → recipient; else payload `reply_ref` → recipient; else sender phone hash → latest delivery to that phone in the last 30 days. **RSV** registers `rsv.*` (designed in `06-rsv.md`), **ARR** registers `arr.*` (`09-arr.md`); those owners must accept this command shape — noted under §12.

## 5. Jobs, events and realtime

| Queue / job | Trigger | Payload | Behaviour |
| --- | --- | --- | --- |
| `messaging` · `msg.resolve` | send now; scheduled time | `{ messageId, version }` | Check `status`/`version`; resolve audience (core filters + registered filters) in one tx: `INSERT … SELECT` recipients and deliveries, suppressions, reserve quota; enqueue `msg.send-batch` per 50 deliveries (WhatsApp and push in parallel). `singletonKey = messageId`. |
| `messaging` · `msg.send-batch` | from resolve | `{ deliveryIds[] }` | Claim rows (`queued → sending`), render per language, call provider with ≤ 10 in flight, global token bucket (`MSG_WA_RATE`, default 60/s, split across worker processes). Write `sent`/`failed`. Retryable failures → `msg.send-one` with backoff 30 s, 2 min, 10 min (max 3). |
| `messaging-priority` · `msg.send-one` | OTP, confirmations, retries | `{ deliveryId }` | Separate queue so OTPs never wait behind a 2,000-guest fan-out. |
| cron 1 min · `msg.fallback-sweep` | — | — | WhatsApp deliveries past `fallback_due_at` and not delivered → create SMS delivery (`is_fallback`) → `msg.send-one`. `FOR UPDATE SKIP LOCKED`, 500 per pass. |
| cron 1 min · `msg.schedule-sweep` | — | — | Safety net for scheduled messages whose delayed job was lost. |
| cron 5 min · `msg.stuck-sweep` | — | — | `sending` > 5 min → `unknown`; no resend; reconciled by webhook if it arrives. |
| `messaging` · `msg.inbound-route` | webhook | `{ webhookEventId }` | Decode action; `msg.stop`/`msg.start` handled here; else call the registered handler; send its reply. |
| cron 15 min · `msg.template-sync` | — | — | Pull approval status; **alert** if an approved template becomes `paused`/`rejected`. |
| cron 1 min · `msg.stats-refresh` | while any message `sending` | — | Refresh `messages.stats`; `NOTIFY` progress. |

**Domain events** (in-process): `message.sent`, `message.delivery_failed` (OPS-03 dashboard), `messaging.opted_out` (guest record badge).
**SSE:** `msg.progress` on the wedding channel (`{ messageId, counts }`, throttled to 1 per 2 s per message) for the host message-detail screen; uses ARR-05's SSE infrastructure.

## 6. Mobile app

| Mode | Screen | Notes |
| --- | --- | --- |
| Host | **Messages** list | Drafts, scheduled (local wedding time), sent with delivered % chip |
| Host | **Composer** (stack: Template → Text + image → Audience → Preview → Send/Schedule) | Audience picker: groups, events, RSVP status per event, hand-picked guests (search). Live recipient count from `audience-preview`. Preview tabs per language (L10N). "Send test to me". Draft and `Idempotency-Key` saved in MMKV so a dropped network can't double-send. |
| Host | **Message detail** | Live counts via SSE; failures list with call / WhatsApp buttons (phone shown per role); "Retry failed"; cancel while scheduled |
| Host | Quota banner | Shown at 80% and when blocked |
| Guest | **Announcements** inbox (GH-06) | Persisted query cache for offline reading; image previews via CloudFront URLs |
| Guest | Notification permission prompt | Asked in context (after first RSVP), not at first launch; Android 13+ runtime permission |
| Guest | Settings → "WhatsApp updates" toggle | Calls `messaging-preferences` |

Deep links: push `data.link = mehfil://g/announcements/:messageId` (Guest) and `mehfil://h/weddings/:wid/messages/:mid` (Host). Query keys: `['wedding', wid, 'messages', filters]`, `['wedding', wid, 'message', mid]`, `['wedding', wid, 'message', mid, 'deliveries', status]`, `['wedding', wid, 'msg-quota']`, `['guest', 'announcements']`. FCM token registration and refresh are owned by APP's `devices` module (`25-app.md`). Accessibility: status chips use icon + label; composer works at 200% font scale.

## 7. Guest lite web

**Applicable.** `/g/:token` shows the last 20 announcements (server-rendered, no JS required); SMS fallback links to `/g/:token?m=<shortId>` which highlights that announcement. "Stop WhatsApp updates" link on the page. Same i18n catalogue as the app.

## 8. Security and privacy

- **Webhooks:** raw body (`express.raw`) + HMAC-SHA256 check with the Meta app secret, constant-time compare; SMS DLRs on a secret path + provider IP allowlist in Nginx; 1 MB body cap; dedupe by external id (replays are no-ops).
- **Minimisation:** no clear phone numbers in MSG tables (`to_hash`); rendered bodies are not stored per delivery; Pino redaction for `to`, `phone*`, OTP codes; LogSink is dev-only.
- **Consent purpose:** `core` (wedding logistics) covers utility messages; Mehfil sends **no marketing** templates to guests. Opt-out via "STOP", button, app toggle or host record; `START` re-subscribes.
- **Desk staff** never see messages, deliveries or replies. Phone numbers in failure lists are shown only to owner/co_host; planner members see masked numbers with a call button that dials via `tel:` after a confirm (PO can relax).
- **Audit log:** `message.send`, `message.schedule`, `message.cancel`, `message.retry_failed`, `messaging.opt_out.host_recorded`.
- **Rate limits:** `send` 10/min per wedding; `test` 10/day per user; OTP limits live in ACC-05 and are enforced before `sendOtp`.
- **Guest link in messages:** links are built through ACC's `access.linkForParty(partyId)` (ACC derives the token from an HMAC of party id + link version, see `05-acc.sql`); MSG never stores tokens.
- **Abuse:** a host can only target guests of their wedding; message body length capped (WhatsApp variable 1,024 chars, no newlines-only spam); quota caps blast volume.

## 9. Scale and performance

Target: **95% of a 2,000-guest announcement delivered within 2 minutes.**

| Stage | Budget | How |
| --- | --- | --- |
| Resolve + insert 2,000 recipients and ~3,000 deliveries | < 3 s | One transaction, set-based `INSERT … SELECT` |
| Enqueue 60 batch jobs | < 1 s | `boss.insert` bulk |
| Send 2,000 WhatsApp | ~35 s | 60 msg/s token bucket under Meta's 80/s tier; ~300 ms per call with 10–20 in flight |
| Push to ~800 devices | < 5 s | `sendEach` 500 per call |
| Provider → handset delivered | 5–60 s typical | Outside our control; measured by webhook |

Concurrency across weddings: one sender number shares 80 msg/s, so two simultaneous 2,000-guest blasts take ~70 s — still within budget; at 50 live weddings we request the next Meta throughput tier (automatic with good quality rating) and the token bucket is config. Webhook load: ~50 status callbacks/s for one blast, inline UPDATEs. Verified in OPS-01 with a `SlowFakeProvider` (300 ms latency, 80/s cap) and 5 concurrent 2,000-guest sends. **SLI** = time from send to `delivered`; we alert on time to `sent` because delivery depends on handsets.

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit | Audience spec → SQL; status monotonicity; button payload codec; Meta signature verification with recorded fixtures; DLT variable rendering; SMS segment count (GSM-7 vs UCS-2: Hindi/Kannada 70 chars); token bucket; quota reservation maths |
| API e2e (Postgres + LogSinkProvider) | Create → preview → send → deliveries in sink; double POST with same `Idempotency-Key`; schedule/edit/cancel with fake clock; webhook status sequence out of order; fallback sweep creates SMS; STOP inbound suppresses next send; RSV/ARR reply routed to a fake handler; quota 80% warning and block; desk staff 404/403 per route; other wedding 404 |
| Adapter contract | `nock` fixtures for Meta Cloud API, MSG91, FCM (send, errors, rate-limit 429/131056) |
| Sandbox smoke | Weekly CI job sends a template to Meta's test number (secrets in CI) |
| Mobile | RNTL: composer validation, audience count, preview tabs, inbox offline; device check of push on Android 9 / iOS 15 |
| Load | OPS-01 scenario above |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| MSG-01 Provider abstraction + WhatsApp | [DB] templates, variants, messages, recipients, deliveries · [API] provider interfaces, `MetaCloudProvider`, `LogSinkProvider`, config guard · [API] webhook endpoints with signature + inline status apply · [TEST] fixtures, e2e | 8 → **8** | Unchanged; inbound routing split out to MSG-11 |
| **MSG-11 Inbound reply router (new)** | [DB] webhook events · [JOB] `msg.inbound-route` · [API] handler registry, payload codec, phone-hash fallback · [TEST] fake RSV/ARR handlers | — → **3** | Needed by RSV-02 (S5) and ARR-01 (S6); was hidden inside MSG-01 |
| MSG-02 Template catalogue | [DB] seed · [OPS] templates-as-code + push CLI · [JOB] template-sync + alert · [API] list endpoint | 3 → **3** | Unchanged |
| MSG-03 Announcement composer | [API] CRUD, audience spec + filter registry, preview, test-send · [MOB] composer stack, audience picker, preview, MMKV draft · [TEST] | 5 → **8** | RN screens + filter registry + per-language preview |
| MSG-04 Scheduled sends | [JOB] delayed `msg.resolve` + version check + sweep · [API] schedule/edit/cancel · [MOB] date-time picker in wedding tz | 2 → **2** | Unchanged |
| MSG-05 Fan-out worker | [JOB] resolve, send-batch, send-one, priority queue, token bucket, stuck sweep · [TEST] idempotency + crash cases | 5 → **5** | Unchanged |
| MSG-06 Delivery and read status | [API] summary, deliveries list, retry-failed · [JOB] stats refresh + SSE · [MOB] detail + failures list | 3 → **5** | Live SSE progress and mobile drill-down |
| MSG-07 SMS fallback | [API] `Msg91Provider` + DLR endpoint · [JOB] fallback sweep, immediate fallback on final WA errors · [DB] DLT ids on variants | 5 → **5** | Unchanged |
| MSG-08 Push (was web push) | [MOB] `@react-native-firebase/messaging`, APNs key, permission prompt, token registration, deep links, read receipt · [API] `FcmPushProvider`, token pruning; device registration slice of APP's `devices` module pulled forward | 3 → **5** | Native setup on two platforms + host pushes reused by APP/ARR |
| MSG-09 Quota metering | [DB] quotas · [API] reserve/commit/release, 80% warning push to owner, block · [MOB] banner | 2 → **3** | Reservation + SMS segment units |
| MSG-10 Opt-out | [DB] opt-outs · [JOB] STOP/START keywords · [API] guest and host endpoints · [WEB] lite-page link | 2 → **2** | Unchanged |
| **Total** | | **38 → 49** | +11 |

## 12. Dependencies and sequencing

| Needs | From | Notes |
| --- | --- | --- |
| pg-boss worker, config, Sentry | FND-06, FND-08 | — |
| VAL-08/09 (name, Meta verification), VAL-10 (DLT) | Admin | Build against Meta's test number and LogSink until approved |
| DSN-05 template copy | Design | Including Hindi/Kannada later (L10N) |
| `guests`, `parties`, `guest_groups`, events visibility | Core / GST-06 / SET-04 | Audience resolution reads them through SET/GST `index.ts` |
| `access.linkForParty(partyId)` | **ACC (05-acc)** | ACC derives tokens (`HMAC(LINK_TOKEN_KEY, party_id ‖ link_version)`), so MSG can build links at send time; must be exported from ACC `index.ts` |
| `push_devices` columns `locale`, `disabled_at`, `wedding_id` + device registration endpoints | **APP (`25-app.sql`, `devices` module)** | MSG-08 (S9) needs these before APP's own stories (S16+): implement the `devices` registration slice with MSG-08 |
| `registerReplyHandler('rsv', …)` | **RSV (06-rsv)** | Must accept `InboundReplyCommand`; RSV-02 also defines invite `context.eventIds` |
| `registerReplyHandler('arr', …)` | **ARR (09-arr)** | "I've landed" / "At the hotel" / "Running late" quick replies |
| `registerAudienceFilter('rsvp_status')`, `('travel_missing')` | RSV, TRV | Used by RSV-04 and TRV-04 |
| SSE infrastructure | ARR-05 (S6) | MSG-06 (S5) polls every 5 s until ARR-05 lands |
| Plan limits | BIL-01 | Until then `limit_units` set per pilot by ops |
| Content translations | L10N (20-l10n) | Composer preview per language |

**Sprint suggestions:** add MSG-11 (3) to S5 — S5 then needs 3 points freed (move SET-04 to S4 or RSV-02's confirmation reply to S7). Consider pulling **MSG-08 push into S7/S8**: the native app is now the main guest client, push is free and covers the DLT risk the sprint plan names for the rehearsal.

## 13. Risks and open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| Meta recategorises the variable-heavy `announcement_text` utility template as marketing (higher price, frequency caps in India) | Several narrower utility templates (schedule change, transport, venue update); fall back to push + SMS; PO decides acceptable price |
| Template paused for low quality after a blast | Template-sync alert; keep a second approved variant; opt-out link visible |
| Guests not on WhatsApp / landlines | SMS fallback; host sees "no WhatsApp" in failures |
| "Delivered in 2 min" depends on handsets being online (venue network) | SLI measured on `sent`; dashboard shows both |
| Crash between provider accept and DB write | `unknown` state, reconciled by webhook (`biz_opaque_callback_data`), never auto-resent |
| Push-first to save cost? | PO decision (below) |

**Product owner decisions:** (1) Meta Cloud API direct vs a BSP; (2) whether announcements go to app users by push only (cheaper) or push + WhatsApp (default here); (3) global vs per-wedding STOP; (4) default SMS fallback delay (10 min) and whether SMS is sent in Hindi/Kannada (UCS-2 doubles cost) or English only; (5) monthly message quota per plan.

## 14. Deviations from the baseline

| Baseline | Change | Why |
| --- | --- | --- |
| pg-boss queues `messaging`, `media`, `default` | Add **`messaging-priority`** queue | OTP and confirmations must not wait behind a fan-out |
| Baseline names "WhatsApp Business API through a BSP" | Recommend Meta Cloud API direct (BSP remains a drop-in adapter) | Cost, signed webhooks, throughput; PO to confirm |

`00-overview.md` should be updated to list the extra queue and the provider choice once accepted.
