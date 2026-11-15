# E05 — Guest access, identity and consent (ACC)

## 1. Summary

A guest opens the private WhatsApp link `https://<domain>/g/<token>`. The link opens the **React Native app** in Guest mode if it is installed, and the **guest lite web page** otherwise. The first time on a device, the guest picks their name and gets a 6-digit **OTP** on a phone in their party (WhatsApp first, SMS fallback). The device is then trusted for up to 90 days. On a shared family phone, the holder can **switch between party members**, and each action is attributed to the selected member. The first open shows the **DPDP notice and consent** screen. Link lookups, OTP sends and wrong codes are **rate-limited and locked out**.

| | |
| --- | --- |
| Stories | ACC-01 link · ACC-02 new-device OTP (split 02a app / 02b lite web) · ACC-03 shared phone · ACC-04 consent · ACC-05 abuse protection |
| Phase / sprint | MVP: S4 (ACC-01, 02a, 04), S5 (ACC-05, with real WhatsApp OTP), S7 (ACC-02b with the lite web), S9 (ACC-03, P0\*) |
| Module | `apps/api/src/modules/access` (`router.ts`, `service.ts`, `otp.ts`, `link.ts`, `web.ts`, `jobs.ts`, `index.ts`) · app `apps/mobile/src/features/access` |
| Not in this epic | Refresh-token rotation and `authGuest` middleware (FND-05, `refresh_tokens`); consent storage, notices and consent endpoints (PRV-01); deep-link plumbing, Guest entry route and the multi-identity session store (APP-01/02); OTP delivery (MSG `sendOtp`) |

**How the stories change on this stack.** The backlog assumes a PWA with no install. Under the baseline, the link opens the native app (universal/app link) or a server-rendered lite web page. ACC therefore serves **two session carriers**: app sessions (guest JWT + rotating refresh token held in the Keychain/Keystore) and lite-web sessions (HttpOnly cookie). Both sit on FND's `refresh_tokens` table, and both are OTP-verified the same way.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Link token | **Derived**: `token = b64url(HMAC-SHA256(LINK_TOKEN_KEY, "link:v1:" ‖ party_id ‖ ":" ‖ link_version)[0..16])` (128 bits). Only `sha256(token)` is stored in `parties.link_token_hash` | Random token shown once; random token stored encrypted (KMS) | MSG needs the link again for reminders, SMS fallback and confirmations (`07-msg.md` §12 open item). Deriving the token rebuilds the link with no stored secret per party and no KMS call per message. Rotating = `link_version + 1`. |
| What the link alone grants | **Nothing personal.** Without OTP: wedding title, dates, party label, members' first names and masked phones (`•• 21`) | Link-only read of the schedule (PRD "no friction") | WhatsApp links get forwarded. The schedule and venues of a private wedding are personal data. PO can relax this per wedding later (§13 Q1). |
| OTP target | A party member with a valid phone, chosen by the guest; code sent to **that** phone | Only the primary's phone | Couples and adult children share one invite; the person holding the link usually has their own phone. |
| OTP storage | `HMAC(OTP_PEPPER, challenge_id ‖ code)`, 10 min TTL, 5 attempts | bcrypt; plain code | A 6-digit space is too small for slow hashing to help. The pepper stops offline guessing from a DB dump. Constant-time compare. |
| OTP channel | WhatsApp `otp` authentication template; **guest-triggered SMS** ("Send by SMS instead" after 30 s) plus an automatic switch to SMS when MSG returns a synchronous failure | MSG's generic 10-minute fallback sweep | 10 minutes is too long to wait for a login code. |
| Device trust | `guest_devices` row per (party, install). `trusted_until = min(verified_at + 90 d, weddings.ends_on + 30 d)`. Refresh never extends past it | Trust tied only to refresh expiry | Meets "remembered 90 days" without trusting the device long after the wedding (minimisation). The host can see and revoke devices. |
| Sessions | FND `refresh_tokens` (`audience='guest'`, `family_id = guest_devices.id`, `device_id = install_id`, `guest_id = verified member`) | ACC's own refresh table | One rotation and reuse-detection implementation (FND decision). |
| Shared phone | `guest_devices.active_guest_id`. Switching issues a new **access** token with `sub = active member`. The refresh family stays the same | One OTP per member; one device row per member | Matches how Indian households use one phone. Every write is still attributed to the selected member. |
| Lite web session | Opaque 256-bit cookie `mhf_gs`, `HttpOnly; Secure; SameSite=Lax; Path=/g/<token>`, stored as a `refresh_tokens` row (platform `web`), **not rotated per request** (idle expiry slides at most once a day) | JWT in a cookie; rotating the cookie on every request | No JS on the page. Path scoping keeps two invitations in one browser apart. Rotating per request causes false reuse alarms with two tabs open. |
| Lockout state | Postgres `party_auth_state` + counts from `otp_challenges` (per party, per phone HMAC across weddings) | In-memory `express-rate-limit` only | Must survive restarts, and must hold if more API processes are added (FND risk #2). Per-IP limits stay in FND's helper and Nginx. |
| Consent | ACC owns the **first-open gate and screen**; PRV owns storage and the `PUT /v1/me/consents/:purpose` API | ACC writes `consents` | PRV is the single writer of the legal record (`14-prv.md` §2). |
| Consent check per request | Access-token claim `cns: ["core", …]` set at issue/refresh; `requireConsent('core')` middleware reads the claim | DB lookup per request | Saves a query on every guest call. Withdrawing consent revokes the device (reason `consent_withdrawn`), so the gap is at most the 15-minute token life. |

## 3. Data model

DDL: [`sql/05-acc.sql`](./sql/05-acc.sql). **Schema check passed**: `scripts/check-schema.sh arch_acc 000-core.sql 05-acc.sql` → `OK: 19 tables`. The chain `000, 01, 03, 04, 05, 06, 07, 08, 09, 10, 14` → `OK: 58 tables`. EXPLAIN on 50 weddings × 700 parties × 3 guests and 105k OTP rows: link lookup uses `parties_link_token_hash_key` (0.05 ms) and the per-party send limit uses `otp_party_recent_idx` as an index-only scan (0.03 ms). Scratch DBs dropped.

| Table / change | Purpose | Notes |
| --- | --- | --- |
| `parties` + `link_version`, `link_revoked_at` | Inputs to the derived token; revoke state | Rotate: `link_version++`, new hash, `link_rotated_at = now()`. Revoke: hash `NULL` + `link_revoked_at`. CHECK: a revoked link has no hash. |
| `guest_devices` | One verified install or browser per party: who verified, who is active, trust window, revoke reason | Partial unique `(party_id, install_id) WHERE revoked_at IS NULL`. The expiry sweep uses `guest_devices_trusted_until_idx`. Reused by the host "devices" view. |
| `otp_challenges` | One row per code sent | `phone_hmac`/`ip_hmac` = `HMAC(PII_HASH_KEY, …)`, no raw phone or IP. `delivery_id` comes from MSG, with no FK. Purged after 30 days (BRIN on `created_at`). |
| `party_auth_state` | Wrong-code window and lockouts | 10 wrong codes in 1 h → lock 1 h; a second lock within 24 h → 24 h lock and a host alert. |
| Reused: `refresh_tokens` (01-fnd) | App refresh tokens and web cookies | `family_id = guest_devices.id`. Revoking a device revokes the family. |
| Reused: `consents`, `privacy_notices` (core + 14-prv) | Consent record | Written only through `privacy.recordConsent()`; `source` is `guest_app` / `lite_web`. |
| Reused: `push_devices.device_id` (25-app) | Push rows of a revoked install | ACC calls `devices.removeForInstall(installId, guestIds)` on revoke. |
| Reused: `parties.checkin_code` (09-arr) | Party QR | ARR regenerates it on `acc.link_rotated`. |

**Retention:** `otp_challenges` 30 days. Revoked or expired `guest_devices` are deleted 30 days after `revoked_at`/`trusted_until`. `party_auth_state` rows are deleted when the lock and window are older than 7 days. Everything is erased with the party (PRV purge participant `access`, order 80).

## 4. API

Caller: `public` (rate-limited, no token), `guest` (guest JWT), or a host role (host JWT + `requireWeddingRole`). Error codes are prefixed `ACC_`.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| POST | `/v1/guest/auth/start` | public | Resolve the link token. Returns a `linkTicket` (JWT, `aud=link`, 15 min) and the member picker. If a live session for this party exists on this install, returns `sessionExists: true` | 404 `ACC_LINK_INVALID` (unknown, revoked, party deleted, wedding archived; same body for every case), 423 `ACC_PARTY_LOCKED`, 429 `ACC_RATE_LIMITED` |
| POST | `/v1/guest/auth/otp` | public + `linkTicket` | Send a code to the chosen member's phone. `channel` is `whatsapp` (default) or `sms`. A new code supersedes any pending one | 422 `ACC_NO_PHONE`, 429 `ACC_OTP_SEND_LIMIT` (`retryAfter`), 409 `ACC_RESEND_TOO_SOON`, 423 `ACC_PARTY_LOCKED` |
| POST | `/v1/guest/auth/verify` | public + `challengeId` | Check the code. Creates or replaces the `guest_devices` row and issues access + refresh tokens | 400 `ACC_OTP_INVALID` (`attemptsLeft`), 410 `ACC_OTP_EXPIRED`, 429 `ACC_OTP_EXHAUSTED`, 423 `ACC_PARTY_LOCKED`, 409 `ACC_INSTALL_MISMATCH` |
| POST | `/v1/auth/refresh`, `/v1/auth/logout` | guest | **FND endpoints**. ACC plugs in `GuestSessionPolicy`: device not revoked, `now < trusted_until`, party and link still valid, `sub = active_guest_id`, `cns` claim refreshed | 401 `AUTH_REFRESH_INVALID`, 401 `ACC_DEVICE_EXPIRED` (app goes back to OTP using the link token kept in the Keychain) |
| GET | `/v1/guest/session` | guest | Me, active vs verified member, party members (names and roles only, no phones), device trust, `consentNeeded[]` | — |
| POST | `/v1/guest/session/switch` | guest | ACC-03: select another member of the party → new access token | 404 `ACC_NOT_PARTY_MEMBER` |
| GET / DELETE | `/v1/guest/devices`, `/v1/guest/devices/:id` | guest | List or sign out other devices of my party | 404 for other parties' devices |
| GET | `/v1/weddings/:wid/parties/:pid/link` | owner, co_host, planner_member (`guest_link.read`) | Rebuild the link to copy or share. Audited `party.link_viewed` | 404 |
| POST | `/v1/weddings/:wid/parties/:pid/link/rotate` | owner, co_host (`guest_link.manage`) | New link; `{ revokeSessions: true }` by default. Emits `acc.link_rotated` | 404 |
| DELETE | `/v1/weddings/:wid/parties/:pid/link` | owner, co_host | Revoke the link with no replacement; revokes all devices | 404 |
| GET | `/v1/weddings/:wid/parties/:pid/access` | owner, co_host, planner_member | Devices (platform, summary, verified member, last seen), lock state, last OTP time and channel | 404 |
| POST | `/v1/weddings/:wid/parties/:pid/access/unlock` | owner, co_host | Clear the lock (guest called the family) | 404 |
| DELETE | `/v1/weddings/:wid/parties/:pid/access/devices/:deviceId` | owner, co_host | Revoke one device | 404 |

Desk staff get **404** on every host route above: links are login credentials. Consent endpoints are PRV's (`GET /v1/privacy/notices/current`, `PUT /v1/me/consents/:purpose`).

**Lite web routes** (HTML, owned by ACC, rendered inside GH's layout): `POST /g/:token/otp`, `POST /g/:token/verify`, `POST /g/:token/switch`, `POST /g/:token/logout`. `GET /g/:token` shows the ACC landing page (member picker) until a session cookie exists, then GH's home page. The consent page is PRV's `/g/:token/consent`.

**Internal exports** (`modules/access/index.ts`): `linkForParty(partyId) → url`; `resolveLink(token) → { weddingId, partyId } | null`; `requireGuestSession()` (lite web cookie → guest context); `requireConsent(purpose)`; `revokeParty(partyId, reason)`; `GuestSessionPolicy` (for FND); purge participant `access`.

### Examples

`POST /v1/guest/auth/start`
```json
{ "token": "3qX9c1V0bQkz7m2LZ0aR4w", "installId": "a7d1…(32)", "platform": "android", "appVersion": "1.0.3" }
```
→ `200`
```json
{ "linkTicket": "eyJ…", "wedding": { "title": "Ananya & Rohan", "startsOn": "2027-02-12", "endsOn": "2027-02-14" },
  "party": { "label": "Sharma family" },
  "members": [
    { "guestId": "g1…", "firstName": "Sunita", "otp": { "available": true,  "maskedPhone": "+91 •••••• •21" } },
    { "guestId": "g2…", "firstName": "Arjun",  "otp": { "available": true,  "maskedPhone": "+91 •••••• •07" } },
    { "guestId": "g3…", "firstName": "Dadi",   "otp": { "available": false } } ],
  "sessionExists": false }
```

`POST /v1/guest/auth/otp` `{ "linkTicket": "eyJ…", "guestId": "g1…", "channel": "whatsapp" }` → `202 { "challengeId": "c9…", "channel": "whatsapp", "maskedPhone": "+91 •••••• •21", "expiresAt": "…", "resendAfter": 30 }`

`POST /v1/guest/auth/verify` `{ "challengeId": "c9…", "code": "482913", "installId": "a7d1…", "platform": "android", "clientSummary": "Android 10 · 1.0.3" }` → `200`
```json
{ "accessToken": "eyJ…", "refreshToken": "q3V…", "expiresIn": 900,
  "guest": { "id": "g1…", "firstName": "Sunita", "partyId": "p1…", "weddingId": "w1…" },
  "members": [ { "guestId": "g1…", "firstName": "Sunita", "ageBand": "adult" }, { "guestId": "g3…", "firstName": "Dadi", "ageBand": "senior" } ],
  "device": { "id": "d1…", "trustedUntil": "2027-03-16T00:00:00Z" },
  "consentNeeded": [ { "purpose": "core", "noticeVersion": "guest-2027.1" } ] }
```
Wrong code → `400 { "error": { "code": "ACC_OTP_INVALID", "message": "That code didn't match", "details": { "attemptsLeft": 3 } } }`.

**Guest access-token claims** (extends FND): `sub` = active member, `vid` = verified member (new), `pid`, `wid`, `sid` = `guest_devices.id` (the refresh family), `cns` = active consent purposes (new), `aud=guest`, 15 min.

## 5. Jobs, events and realtime

| Item | Kind | Behaviour |
| --- | --- | --- |
| OTP send | `messaging.sendOtp(...)` → `messaging-priority` queue (MSG) | ACC creates the challenge and calls the port **after** commit. Idempotency key = `challengeId`. In dev/test with `DEV_AUTH_ENABLED=true`, `DevOtpSender` sends nothing; the code is `DEV_OTP_CODE` (`000000`), `channel='dev'`, and `otp.dev_code challengeId=…` is logged with no phone. |
| `acc.expire-devices` | cron hourly (`default`) | Marks devices past `trusted_until` as revoked (`expired`), revokes their refresh families, deletes push rows |
| `acc.purge` | cron nightly | Deletes OTP rows > 30 days, devices revoked > 30 days, stale `party_auth_state` |
| `acc.abuse-scan` | cron every 5 min | Counts invalid link lookups (from the `acc_link_lookup_total` counter snapshot), OTP sends per phone HMAC, new locks. Sends a Sentry alert and SNS (FND-08) on spikes; pushes the wedding owner on a 24 h lock |
| `acc.link_rotated { weddingId, partyId }` | domain event | APP deletes push rows; ARR regenerates `checkin_code`; MSG drops any cached link |
| `acc.device_verified`, `acc.party_locked`, `acc.member_switched` | domain events | OPS counters (`ops_wedding_minute.otp_sent/otp_failed`), audit |
| `privacy.consent_changed` (PRV) | consumed | `core` withdrawn → `revokeParty`-style revoke of that guest's devices (`consent_withdrawn`) |

No SSE channels.

**Port to MSG** (dependency on E07). ACC uses MSG's `sendOtp({ weddingId, phoneE164, code, language })` with two additions requested from MSG: `channel?: 'whatsapp' | 'sms'` and `idempotencyKey`. It also needs MSG to return a synchronous `{ ok: false, code: 'NOT_ON_WHATSAPP' }`, which lets ACC switch the challenge to SMS automatically. ACC wraps the port in `OtpSender` (`MessagingOtpSender`, `DevOtpSender`, `FakeOtpSender` that records codes for tests).

## 6. Mobile app

The Guest entry route, multi-identity session store and Keychain storage come from APP-01/02. ACC provides the screens inside that flow.

| Screen | Behaviour |
| --- | --- |
| `GuestWelcome` | Wedding title and cover, "Who are you?" list of members (first name, masked phone); members with no phone are greyed out with "Ask {primary} to open this link". Large buttons with icon and label. |
| `OtpEntry` | `OtpField` (FND-10) with SMS Retriever autofill (Android, no permission) and iOS `oneTimeCode`. 30 s countdown, then "Send by SMS instead". Shows attempts left and the lockout time in plain words. Dev builds pre-fill `000000`. |
| `ConsentGate` | Notice text from PRV (`meta.persist`), "I agree" plus "Not now / leave" (leaving deletes the local identity). Children in the party are listed with "I'm their parent/guardian" checkboxes (PRV `forGuestId`). |
| `MemberSwitcher` (ACC-03) | Bottom sheet on the Guest header: avatars and names; "You're using Mehfil as Dadi" banner after a switch. If the newly selected adult has no consent yet, `ConsentGate` opens first. |
| `Devices` (Settings) | My party's devices; "Sign out this phone / that phone". |

Query keys: `['guest', wid, 'session']`, `['guest', wid, 'devices']`. The access token lives in memory only; the refresh token and link token are in Keychain `mehfil.guest.<weddingId>` (APP). Offline: the OTP screens need the network and say so. A trusted device opens straight to the cached home, and refresh failures because of no network are not treated as logouts. Accessibility: whole flow tested at OS font scale 2.0, every input labelled, no time-limited step shorter than 30 s, error text shown next to the field and announced.

## 7. Guest lite web

**Applicable.** `/g/:token` without a session shows the landing page: wedding title, "Who are you?" radio list, "Send code" (POST `/g/:token/otp`), code form (POST `/g/:token/verify`, `autocomplete="one-time-code"`, `inputmode="numeric"`), "Send by SMS instead". On success it sets `mhf_gs` (`Path=/g/<token>`, `Max-Age` up to `trusted_until`) and redirects 303 to `/g/:token` (or `/g/:token/consent` if consent is needed). Forms carry a CSRF token `HMAC(CSRF_KEY, refresh_token_id ‖ form)` (pre-session: bound to the `linkTicket`). No JavaScript. Pages are ~6 KB.

## 8. Security and privacy

| Area | Measure |
| --- | --- |
| Token secrecy | 128-bit derived token. Lookup by `sha256` index (no timing oracle on secrets). `LINK_TOKEN_KEY` (≥ 32 bytes, SSM → `.env`), never rotated casually: rotating it changes **every** link (runbook: only with a planned re-invite). `Referrer-Policy: no-referrer` on `/g/*`. Nginx log format rewrites `/g/[^/ ]+` → `/g/:token` (PRV/FND). Sentry and Pino scrub `/g/` paths, `token`, `code`, `otp`. |
| Pre-OTP disclosure | Wedding title and dates, party label, first names, phone **last 2 digits**. No surnames, no events, no venues. |
| Link forwarded | A forwarded link still needs an OTP to a party phone. The host can rotate or revoke it, and see and revoke devices. |
| OTP | 6 digits from `crypto.randomInt`. HMAC with pepper, 10 min, 5 attempts per challenge, bound to `install_id` (a code typed into a different install fails with `ACC_INSTALL_MISMATCH`). The new challenge supersedes old ones. |
| Rate limits | See table below. 429 includes `Retry-After`. Messages never reveal whether a token exists. |
| Session theft | Refresh tokens are device-bound (FND), with reuse detection that revokes the family. Web cookie is HttpOnly, Secure, SameSite=Lax, path-scoped. The host can revoke. Trust is capped at wedding end + 30 days. |
| Shared phone | Every write carries `sub` = active member and `vid` = verified member in the audit entry (`after.actingVia`). Switching is audited (`guest.switch_member`). |
| Consent (DPDP) | `core` notice at first open, before any personal data beyond the landing page. Version and text hash stored by PRV. Withdrawal through PRV → devices revoked → PRV erasure flow. Children: guardian consent by the OTP-verified primary (PRV rule). |
| Minimisation | No raw phone, IP, OTP or token stored. `client_summary` instead of the user agent. Retention as in §3. |
| Audit | `party.link_viewed`, `party.link_rotated`, `party.link_revoked`, `guest.device_verified`, `guest.device_revoked`, `party.unlocked`, `guest.switch_member` (actor = user or guest). |
| Tenant isolation | Host routes go through `requireWeddingRole` → 404 for other weddings. Guest tokens are scoped to `wid`/`pid` from the token, never from the path. |

**Rate limits (ACC-05)**

| What | Limit | Store |
| --- | --- | --- |
| `auth/start`, `GET /g/:token` without a session | 10/min and 100/h per IP; Nginx `zone=link 5r/s` | FND helper (memory) + Nginx |
| OTP send | per party 3 / 15 min and 10 / 24 h; per phone HMAC (all weddings) 5 / h and 15 / 24 h; per IP 10 / h; resend ≥ 30 s apart | Postgres counts (`otp_*_recent_idx`) + FND helper |
| OTP verify | 5 per challenge; per party 10 wrong / h → lock 1 h; a 2nd lock in 24 h → 24 h and alert | `party_auth_state` |
| Member switch | 30 / h per device | FND helper |

## 9. Scale and performance

| Stress point | Expectation | How it holds |
| --- | --- | --- |
| Invite wave: 2,000 guests tap the link in ~15 min | ≈ 2–3 `start` + 2 OTP sends per second | Index lookup 0.05 ms. OTP goes on MSG's `messaging-priority` queue so it never waits behind a fan-out. |
| OTP end-to-end | 95 % of codes delivered < 30 s | WhatsApp authentication template; SMS in one tap; OPS dashboard `otp_sent/otp_failed` per wedding-minute |
| 50 live weddings refreshing tokens | ~2,000 refresh/h per wedding at peak | One indexed lookup plus a `guest_devices` PK read in `GuestSessionPolicy` |
| Budget Android | OTP screen < 1 s to interactive | No heavy dependencies; SMS Retriever avoids typing |

## 10. Testing plan

| Level | Cases |
| --- | --- |
| Unit | Token derivation is stable and changes with `link_version`; masking; OTP HMAC and constant-time compare; limit maths (window edges); lock escalation; `trusted_until` = min rule; `cns` claim building |
| API e2e (Postgres, `FakeOtpSender`, dev bypass) | start → otp → verify → refresh → logout; wrong code ×5 → exhausted; 10 wrong → 423, unlock by host; send limits per party and **per phone across two weddings**; revoked link → 404 identical to unknown; rotate → old link 404 and old refresh 401; device expiry job; switch member → writes attributed (assert audit row); consent gate 403 `ACC_CONSENT_REQUIRED` until PRV grant; `DEV_AUTH_ENABLED` + `NODE_ENV=production` refuses boot (FND test); desk_staff 404 on link routes; other wedding 404 |
| Lite web e2e | Landing → OTP → cookie set with correct path and flags → home; CSRF missing → 403; two invitations in one cookie jar stay separate |
| Mobile (RNTL) | Welcome member list (no-phone member disabled), OTP field autofill, countdown → SMS button, lockout message, switcher and consent-on-switch |
| Device | Android 9 / 2 GB: SMS Retriever autofill; iOS 15 one-time-code autofill; WhatsApp link opens app when installed and lite web when not (APP-02 matrix) |
| Security (PRV-05) | Token brute force (expect 429 then lock), enumeration (same response shape), path logging scrubbed |

Helper `signInGuest(partyId, { as?: guestId })` for other epics' tests: creates a device and tokens directly through the service, without the OTP round trip.

## 11. Story breakdown

| Story | Tasks | Points (backlog → revised) | Why |
| --- | --- | --- | --- |
| **ACC-01** Personal link | [DB] `link_version`, `link_revoked_at` · [API] `link.ts` derive/hash, `auth/start` + `linkTicket`, host link GET/rotate/revoke, `linkForParty` export for MSG, `acc.link_rotated` · [WEB] landing page · [TEST] | 3 → **3** | Unchanged. Deep-link plumbing is APP-02. |
| **ACC-02a** New-device OTP (app) | [DB] `guest_devices`, `otp_challenges` · [API] otp/verify, `OtpSender` + dev/fake, `GuestSessionPolicy` for FND refresh, session/devices endpoints, expiry job · [MOB] Welcome, OtpEntry (autofill), Devices · [TEST] | 5 → **5** | Unchanged scope; FND supplies rotation. |
| **ACC-02b** (split) Lite web session | [API] `mhf_gs` cookie session on `refresh_tokens`, `requireGuestSession`, CSRF helper · [WEB] OTP/verify forms, logout · [TEST] | — → **3** | New: the no-install path needs its own session carrier. Lands with GH-08 (lite web). |
| **ACC-03** Shared family phone | [API] switch endpoint, `sub`/`vid` claims, audit attribution helper used by RSV/TRV/ARR · [MOB] MemberSwitcher, banner, consent-on-switch · [WEB] member switch form · [TEST] | 2 → **3** | Consent per member and lite-web parity |
| **ACC-04** Consent capture | [API] `requireConsent` middleware, `cns` claim, `consent_changed` handler · [MOB] ConsentGate incl. children · [WEB] redirect to PRV page · [TEST] | 3 → **3** | Unchanged. Storage and endpoints are PRV-01, which must ship in S4. |
| **ACC-05** Abuse protection | [DB] `party_auth_state` · [API] limits table above, lock/unlock, host access view · [JOB] `acc.abuse-scan`, `acc.purge` · [OPS] Nginx zone, alarms · [TEST] | 2 → **3** | Durable per-phone, cross-wedding limits and host unlock were not in the estimate |
| **Total** | | **15 → 20** | |

## 12. Dependencies and sequencing

| Needs | From | When |
| --- | --- | --- |
| `refresh_tokens`, `/v1/auth/refresh|logout`, `authGuest`, rate-limit helper, `defineRoute` | FND-05/12 | S2–S3 |
| `messaging.sendOtp` with `channel` + `idempotencyKey` + synchronous `NOT_ON_WHATSAPP` | MSG-01 (E07) | Port and fakes in S4; real WhatsApp/SMS from S5 (staging runs `NODE_ENV=production`, so **staging OTP needs MSG-01**; until then test only locally/CI with the dev code) |
| `privacy.recordConsent`, notices, `PUT /v1/me/consents/:purpose` | PRV-01 | **S4** (PRV already proposes moving it) |
| Guest entry route, Keychain session store, universal/app links | APP-01 (S4 part), APP-02 | S4 |
| Party members with valid phones | GST-01/04 | S3 |
| `devices.removeForInstall` | APP-03 | S5 (no-op before) |
| Lite web layout and `eta` | FND / GH-08 | S7 |
| Provides `linkForParty`, `requireConsent`, `requireGuestSession`, `signInGuest` test helper | → MSG, RSV, TRV, ARR, GH, CAM | S4 |

## 13. Risks and open questions

| # | Item | Proposal / owner |
| --- | --- | --- |
| Q1 | **PO:** may the link alone (no OTP) show the schedule, or allow RSVP, to cut friction for elders? | Default **no** (OTP first). Could be a per-wedding toggle `settings.guest.linkOnlyPreview` later. |
| Q2 | **PO:** device trust `min(90 days, wedding end + 30 days)`. Is the cap acceptable? | Yes, recommended for privacy |
| Q3 | **PO:** on a shared phone, may the holder switch to an adult member who has their own phone without that member's OTP? | Default **yes**, audited. Alternative: require OTP for members with phones (adds friction). |
| Q4 | **PO:** an adult member (e.g. Dadi) consents through whoever holds the phone. Acceptable under DPDP? | Counsel (VAL-13) |
| R1 | WhatsApp authentication template approval and pricing (India authentication rate) | Submitted in S0 (VAL-09). SMS DLT OTP template as backup. |
| R2 | `LINK_TOKEN_KEY` leak exposes every link | SSM SecureString, never logged, rotate only with a re-invite campaign. The OTP still protects personal data. |
| R3 | Guests with no phone in the party at all | Host sees "no verifiable phone" in the access view (from GST `phone_status`) and adds one, or records RSVPs on their behalf (RSV-05) |
| R4 | SMS Retriever needs the app hash in the SMS template | MSG/DLT template includes the hash for the Android app; documented in APP-05 |

## 14. Deviations from the baseline

| Baseline says | This design | Why |
| --- | --- | --- |
| "128-bit link token; only its sha256 is stored" (implies random) | Token is **derived** by HMAC from `LINK_TOKEN_KEY`, `party_id` and `link_version`; still 128 bits and only the hash is stored | Links must be rebuilt for reminders and SMS fallback (answers MSG §12). Adds `LINK_TOKEN_KEY` to the secrets list. |
| Guest auth = JWT + refresh per device | Plus an opaque **cookie session** for the lite web, stored in `refresh_tokens` | No JS on the lite page |
| Guest JWT claims `sub, party_id, wedding_id` | Adds `vid` (verified member) and `cns` (consent purposes); `sub` is the **active** member | Shared phone attribution; consent gate without a DB hit |
| Rate limits via `express-rate-limit` | Per-party and per-phone OTP limits and lockouts persisted in Postgres | Must survive restarts; per-phone limits across weddings |

`00-overview.md` should list `LINK_TOKEN_KEY`, `OTP_PEPPER`, `PII_HASH_KEY` and `CSRF_KEY` under secrets once this is accepted.
