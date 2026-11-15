# E25 — Native app (APP)

Status: design · Architect agent · 15 Nov 2026 · SQL: [`sql/25-app.sql`](./sql/25-app.sql) · Builds on [01-fnd.md](./01-fnd.md)

## 1. Summary

The bare React Native 0.88 app is now **the primary client from the MVP**: one app, two modes.

- **Host mode** — owner, co-host, planner member, desk staff. Google SSO (dev builds: `dev:<email>` sign-in screen).
- **Guest mode** — opened from the WhatsApp link `https://<domain>/g/<token>`; first use on a device verifies by OTP (ACC). A phone can hold one host account **and** guest sessions at several weddings at once.

This epic delivers the shell every feature epic plugs its screens into: app project (Android + iOS), navigation and mode switching, deep/universal links, secure token storage, FCM push registration and sending, offline cache and mutation outbox, update strategy, Play Store and App Store pipelines, the budget-Android performance budget, store compliance, and the dev sign-in screen.

**Reinterpreted for the new stack.** The backlog's E25 (P1, season readiness, 16 pts) assumed a web console + PWA with an optional Expo host app later. Under the baseline the app *is* the console and the guest home, so: old APP-01 "host app" becomes the shell + Host navigator (feature screens are built by ARR, MSG, etc.); old APP-02 "optional guest app" becomes Guest mode (replacing the PWA shell of GH-01 and web push of MSG-08); old APP-03 "EAS builds" becomes a Fastlane pipeline for a bare app (no Expo). Stories are renumbered APP-01..10 below.

| Stories | APP-01..10 (see §11) |
| --- | --- |
| Phase / sprints | **MVP S2–S8** for APP-01..09; APP-10 (OTA) optional in season readiness |
| Not in this epic | Feature screens (SET, GST, RSV, TRV, ARR, CAM, GAL, MSG…), guest OTP/session API (ACC), camera upload queue (CAM-05), announcement fan-out (MSG) |

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| App runtime | Bare RN 0.88, New Architecture, Hermes; Expense-Tracker's library set (React Navigation 7, TanStack Query 5, Zustand, MMKV, react-native-keychain, RN Firebase, Sentry RN, FlashList) | Expo managed / EAS | Baseline; reuses ET code; no EAS cost or Expo modules in a bare app. |
| Modes | One root navigator choosing **Welcome / Host / Guest** from a multi-identity session store; switcher sheet | Two separate apps | One store listing, one review, shared shell; a host can also be a guest elsewhere. |
| Identity store | `sessions = { host?: HostSession, guests: GuestSession[] , active }` in Zustand; refresh tokens per identity in Keychain | Single session (ET) | Bride is host of hers and a guest at her cousin's; announcements to both must land. |
| Env config | `scripts/write-env.ts` writes `src/lib/env.ts` from `APP_ENV` before Metro/Gradle/Xcode | `react-native-config` | No extra native module; constants fold so dev code is stripped from release. |
| Build flavours | Android `productFlavors` `dev` / `staging` / `prod` (`applicationIdSuffix .dev/.staging`); iOS configurations + schemes with bundle-id suffixes | One build re-pointed at runtime | Side-by-side installs; separate Firebase apps and Google OAuth clients per flavour. |
| Deep links | Android App Links (`autoVerify`) + iOS Universal Links on `https://<domain>/g/*` and `/h/*`; custom scheme `mehfil://` as fallback | Firebase Dynamic Links (shut down Aug 2025), third-party link SDKs | Native, free, no tracking SDK. |
| Deferred deep link (link tapped before install) | None at MVP: after install the Welcome screen says "Tap your invitation link in WhatsApp again", with a **Paste link** field | Play Install Referrer + handoff code table | Works on both platforms with zero extra infra; re-tapping a WhatsApp link is natural. Revisit if Gate 3 activation is low. |
| Token storage | Access token in memory; refresh tokens, device id, MMKV key in Keychain/Keystore (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`); `allowBackup=false` | AsyncStorage / plain MMKV | Baseline; restored backups would carry tokens whose Keystore keys don't restore. |
| Offline cache | TanStack Query persisted to an **encrypted** MMKV instance, opt-in per query (`meta.persist`), per-identity namespace; paused mutations persisted and resumed | WatermelonDB / SQLite sync | Read-mostly data; far simpler; enough for "schedule at a venue with no signal". |
| Push | FCM via `@react-native-firebase/messaging` (APNs through FCM on iOS); server `PushProvider` interface → `FcmPushProvider` (firebase-admin HTTP v1) / `FakePushProvider` | OneSignal / Expo push | Baseline; ET pattern; no third-party audience data. |
| Realtime client | `react-native-sse` (supports `Authorization` header and `Last-Event-ID`) wrapped in `useEventStream` | WebSocket client; RN `fetch` streaming | Matches FND SSE; header auth means no tokens in URLs. |
| Updates | **No OTA at MVP.** Store releases + server-driven update gate (`GET /v1/app/config`: `minSupported`, `recommended` per platform) | CodePush (retired 2025), EAS Update, self-hosted `hot-updater` | Less moving parts; JS pushes during a live wedding are risky. APP-10 evaluates self-hosted OTA for season readiness. |
| Store delivery | Fastlane: `supply` (Play), `match` + `gym` + `pilot` (TestFlight/App Store), run by GitHub Actions on tags; iOS on a macOS runner only for tags | EAS Build; manual Xcode uploads | Repeatable, scriptable; macOS minutes only on release. |
| iOS host sign-in | **Sign in with Apple** for Host mode on iOS alongside Google (APP-07) | Google only | App Store guideline 4.8 requires an equivalent privacy-preserving login when a third-party login (Google) is offered. **PO decision.** |

## 3. Data model

SQL: [`sql/25-app.sql`](./sql/25-app.sql). **Schema check passed:** `scripts/check-schema.sh arch_app 000-core.sql 01-fnd.sql 25-app.sql` → `OK: 19 tables`. `EXPLAIN` on 30k guest devices: push fan-out by guest uses `push_devices_guest_idx`; a duplicate `(fcm_token, guest_id)` is rejected while the same token for a host user is accepted. Scratch DB dropped.

`push_devices` (core) — owning module `devices`:

| Change | Why |
| --- | --- |
| Drop `UNIQUE (fcm_token)`; add unique `(fcm_token, user_id)` and `(fcm_token, guest_id)` | One install, several identities (host + guest at N weddings). **Deviation**, §14. |
| `device_id` | Same per-install id as `refresh_tokens.device_id`; logout/revoke removes that install's rows. |
| `wedding_id` (required for guest rows) | Tenant scoping and cascade on wedding erasure. |
| `locale`, `os_version`, `permission` | Localised push text; support; skip sends when the OS permission is denied. |
| `disabled_at` | Set when FCM answers `UNREGISTERED`/`INVALID_ARGUMENT`; excluded from fan-out. |
| Indexes on `guest_id`, `user_id` (partial, live rows), `device_id`, `last_seen_at` | Fan-out, logout, weekly purge (not seen for 60 days). |

No other tables: app config/min versions are config values (`APP_MIN_VERSION_ANDROID`, …) and the deferred-link handoff table was rejected (§2).

## 4. API

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/app/config?platform=android&version=1.4.0` | public | `{ update: 'none' \| 'recommended' \| 'required', storeUrl, features: {...}, supportWhatsApp }` | 400 bad platform |
| PUT | `/v1/push-devices` | host or guest | Upsert this install's FCM token for the calling identity | 400 `DEVICE_INVALID_TOKEN` |
| DELETE | `/v1/push-devices` | host or guest | Remove this install's row for the calling identity (also done by `/v1/auth/logout`) | — |
| DELETE | `/v1/me` | host | Delete the host account (store requirement): revoke sessions, remove memberships, erase profile via PRV job | 409 `ACCOUNT_SOLE_OWNER` (owns a live wedding: transfer or end it first) |
| GET | `/.well-known/assetlinks.json` | public (Nginx static) | Android App Links: package + release & upload SHA-256 per flavour | — |
| GET | `/.well-known/apple-app-site-association` | public (Nginx static) | Universal Links: `appIDs`, components `/g/*`, `/h/*` | — |

`POST /v1/auth/google` (FND) also accepts `{ provider: 'apple', idToken }` if APP-07 is approved (`AppleIdTokenVerifier`, audience = bundle id).

### Examples

`PUT /v1/push-devices` (guest access token)
```json
{ "fcmToken": "eXk…", "deviceId": "8f1c2a9e0b7d4c6fa1e2b3c4d5e6f708", "platform": "android",
  "appVersion": "1.0.3 (57)", "osVersion": "9", "locale": "hi", "permission": "granted" }
// 204
```

`GET /v1/app/config?platform=android&version=1.0.1`
```json
{ "update": "required", "storeUrl": "https://play.google.com/store/apps/details?id=in.mehfil.app",
  "features": { "camera": true, "quiz": false }, "supportWhatsApp": "+91…" }
```

## 5. Jobs, events and realtime

| Job (queue) | Payload | Behaviour |
| --- | --- | --- |
| `push.send` (`messaging`) | `{ sendId, target: {guestIds?|userIds?}, template, data, collapseKey }` | Resolves live rows, **de-duplicates by `fcm_token`** (shared family phone gets one push), localises by `locale`, sends in batches of 500 (FCM multicast), marks `disabled_at` on dead tokens. Retries 3×. Idempotent on `sendId` (MSG keeps per-recipient status). |
| `push.purge` (`default`, weekly Sun 04:20 IST) | — | Delete rows not seen for 60 days or disabled > 7 days. |

Events consumed: `auth.logged_out` / `auth.sessions_revoked` (FND) → delete install rows; `acc.link_rotated` (ACC-01) → delete that party's guest rows. Removing a team member (ROL) deletes nothing: host rows are per user, not per wedding, and team pushes filter by current membership at send time.

Push payload: `notification` title/body is short and generic for anything personal ("Travel update from Ananya & Rohan"); `data = { v:1, mode:'guest'|'host', weddingId, route, params }`. No phone numbers, no ID data. Android channels: `announcements` (high), `reminders` (default), `team_alerts` (high, host), `system` (low).

Realtime: `useEventStream(weddingId, channels)` (FND-14) — reconnects with backoff, refreshes the access token before reconnecting, pauses when the app is backgrounded, invalidates the matching TanStack Query keys on each event, refetches all on `reset`.

## 6. Mobile app

### Structure

```
apps/mobile/src/
  navigation/   RootNavigator, WelcomeNavigator, HostNavigator, GuestNavigator, linking.ts, push-routes.ts
  lib/          api (host + guest clients), secure-store, sessions, env, query-client, persist,
                network, event-stream, push, sentry, update-gate, ids
  features/     auth-host, guest-entry, mode-switch, settings, <feature epics…>
  ui/ theme/    design system (FND-10)
```

### Screens owned by APP

| Mode | Screen | Notes |
| --- | --- | --- |
| Shared | Launch | Native splash until sessions load (< 1 s from keychain). |
| Shared | Update required / recommended | From `/v1/app/config`; required blocks with "Update" (store link); recommended is a dismissible banner. |
| Shared | Offline / stale banner | "Showing info from 10:42" when serving cache. |
| Welcome | Welcome | Two big choices: **"I have an invitation"** (explains: open the link from WhatsApp; **Paste link** field) and **"I'm hosting a wedding"**. |
| Welcome | Host sign-in | Google button (+ Apple on iOS if APP-07). **Dev builds:** "Dev sign-in" email field + chips for seeded users (`owner@`, `cohost@`, `planner@`, `desk@mehfil.local`), and an API-base-URL picker (emulator `10.0.2.2`, LAN IP, staging). |
| Guest | Guest entry | Route target for `/g/:token`; hands the token to ACC's start/OTP flow; if a session for that wedding already exists on the phone, opens it (or asks to replace if it's a different party). Dev builds pre-fill OTP `000000`. |
| Both | Mode switcher (sheet) | Lists host account + each guest invitation on the phone; "Add invitation" (paste link). |
| Both | Settings | Language, large text, high contrast, notifications status, privacy notice, sign out / leave invitation, **Delete account** (host), app version. |
| Host | Ops (only for `OPS_ADMIN_EMAILS`) | Failed jobs list + retry (FND-06). |

Host navigator skeleton (filled by feature epics): wedding picker → tabs **Home · Guests · Arrivals · Messages · More**. Desk staff get **Arrivals · Check-in · More** only (ROL matrix). Guest navigator skeleton: tabs **Home (schedule) · Travel · Camera · Photos · Me**; RSVP opens from Home.

### Navigation and links

| URL | Opens |
| --- | --- |
| `https://<domain>/g/:token` | Guest entry |
| `https://<domain>/g/:token/c/:eventId` | Guest entry → Camera for that event (CAM-08 QR) |
| `https://<domain>/h/invite/:inviteToken` | Host sign-in → accept team invite (ROL-01) |
| `mehfil://…` same paths | Fallback (lite web "Open in app" button: Safari doesn't trigger universal links on same-domain navigation) |
| Push `data.route` | Switches active identity if needed, then navigates (`push-routes.ts` whitelist; unknown routes go Home) |

Link tokens are never logged (Sentry breadcrumbs scrub `/g/` and `/h/invite/` paths). The guest's link token is kept in the Keychain alongside its refresh token so a later re-verification (device trust expired) doesn't need the WhatsApp message again.

### Data, offline and storage

| Item | Storage | Lifetime |
| --- | --- | --- |
| Device id | Keychain `mehfil.device` | Install |
| Host refresh token | Keychain `mehfil.host.refresh` | Until logout / 30 days idle |
| Guest refresh + link token | Keychain `mehfil.guest.<weddingId>` | Until leave / expiry (ACC) |
| MMKV encryption key | Keychain `mehfil.mmkv` | Install |
| Query cache | Encrypted MMKV `rq.<identity>` | Guest 7 days, host 24 h (contains guest PII); wiped on sign-out/leave |
| Paused mutations | Same MMKV namespace | Until sent; each carries a client UUID used as `Idempotency-Key` |
| Preferences | Plain MMKV `prefs` | Install |

Query key convention: `['g', weddingId, ...]` for guest, `['h', weddingId?, ...]` for host. Feature epics mark persisted queries (`meta: { persist: true }`) — guest schedule, contacts, my travel, party QR, announcement inbox; host arrivals snapshot. Feature epics register offline-capable mutations with `queryClient.setMutationDefaults` (RSVP, "I've landed", desk check-in). Network state via `@react-native-community/netinfo` → `onlineManager`; resume on reconnect and on app foreground.

### Accessibility

Large-text and high-contrast modes (FND-10) are top-level Settings toggles and also offered on first guest open; OS font scale respected; every icon has a label; 48 dp targets; no gesture-only actions; TalkBack/VoiceOver labels on all shell screens; Welcome copy tested with guests over 60 (DSN-01).

## 7. Guest lite web

The lite page (`/g/:token`, GH/RSV) gets from APP: a **Get the app** block with store badges, an **Open in app** button (`mehfil://g/<token>` on iOS, `intent://` URL on Android with Play fallback), and the iOS Smart App Banner (`<meta name="apple-itunes-app" content="app-id=…, app-argument=https://<domain>/g/<token>">`). The page remains fully usable for schedule and RSVP without installing.

## 8. Security and privacy

| Area | Control |
| --- | --- |
| Tokens | §6 table; access tokens memory-only; refresh per identity; device-bound (FND). `allowBackup=false`, iOS items `ThisDeviceOnly`. |
| Dev code | Dev sign-in, URL picker, OTP prefill compiled only when `APP_ENV=development`; release CI greps the bundle for `dev:` and `mehfil.local` and fails if found. Server refuses the bypass in production anyway (FND). |
| Cache | Encrypted MMKV; host cache TTL 24 h; wiped on sign-out, leave invitation, or `AUTH_REFRESH_REUSED`. |
| Screenshots | `FLAG_SECURE` only on screens showing ID documents (IDV). The party QR stays screenshot-able on purpose (older guests show a screenshot at the desk). |
| Push | Generic text for personal content; no PII in `data`; tokens removed on logout and link rotation. |
| Links | App Links verified (`autoVerify`) so other apps can't claim `/g/*`; `assetlinks.json` lists only our signing certs. |
| Third-party SDKs | Firebase Messaging only (Analytics **off**: `firebase_analytics_collection_enabled=false`, no Crashlytics), Sentry with `sendDefaultPii:false`. Declared in Play Data safety and App Store privacy labels. |
| DPDP | Consent screens are ACC; APP adds account deletion (`DELETE /v1/me`) and "leave this invitation" (deletes local data + push rows; server data stays under the host's control and PRV rules). Audit: `account.delete_requested`. |
| Store rules | In-app account deletion + web deletion URL (Play + App Store requirement for apps with account creation); privacy policy URL (VAL-13). |

## 9. Scale and performance

**Performance budget — reference device: Android 9, 2 GB RAM, quad-core A53 (e.g. Redmi 9A class), 4G throttled to 1.6 Mbps / 150 ms.**

| Metric | Budget | How enforced |
| --- | --- | --- |
| Cold start → guest home with cached data | p75 < 3.0 s | Sentry app-start + custom `home_interactive` span (10 % sampled); device lab each release (OPS-04) |
| Cold start → guest home, no cache, 4G | p75 < 4.5 s | Same |
| Camera open | < 2 s | CAM owns; APP keeps camera module lazy-loaded |
| JS bundle (Hermes bytecode) | < 4 MB | CI step builds the release bundle and fails at > budget + 5 % |
| Android download (AAB per-ABI) | < 30 MB; iOS < 60 MB | Reported by Play/App Store Connect; checked per release |
| Memory (guest home + 200-photo gallery scroll) | < 250 MB PSS | Device lab |
| Lists | 60 fps target, no JS long task > 100 ms | FlashList everywhere; `getItemType`; image sizes from CloudFront previews |

Tactics: Hermes + R8 minify + resource shrinking; Metro inline requires; Host navigator and heavy features (camera, gallery, QR scanner) `React.lazy`-loaded so guests never parse host code; only `en` catalog bundled at MVP; no moment/lodash-full/large icon fonts (SVG icon subset); image disk-cache cap 150 MB.

Server-side scale: push fan-out for a 2,000-guest announcement is 4 FCM multicast calls; `push_devices_guest_idx` keeps target resolution an index scan. `/v1/app/config` is cacheable for 5 min at Nginx.

## 10. Testing plan

| Layer | What |
| --- | --- |
| Unit (Jest) | session store transitions (add/switch/remove identity, reuse → wipe), linking config parses every URL form, push route whitelist, update-gate version compare, persist filter (`meta.persist` only, PII TTL) |
| Component (RNTL) | Welcome, Host sign-in (dev and Google variants), Guest entry (existing/different party), Mode switcher, Settings delete-account flow, offline banner |
| API e2e | `PUT/DELETE /v1/push-devices` for both audiences (same token, two identities), logout removes rows, link rotation removes guest rows, `DELETE /v1/me` sole-owner 409, `/v1/app/config` |
| Job | `push.send` with `FakePushProvider`: de-dup by token, disabled tokens skipped, `UNREGISTERED` marks `disabled_at` |
| Device (manual, OPS-04 matrix) | App Links/Universal Links from WhatsApp (installed / not installed), push in foreground/background/killed, cold start budget, offline schedule, large text at OS 200 %, TalkBack |
| Release | Fastlane lanes dry-run on PR when lanes change; bundle-size check; dev-string grep |

## 11. Story breakdown

Backlog E25: **16 pts** (APP-01 8, APP-02 5, APP-03 3), all in season readiness. Revised: **35 pts in the MVP** + **3 optional** (APP-10). Offsets in other epics: GH-01 shrinks ~5 → 2 (PWA shell/service worker replaced by APP-01/04), MSG-08 web push (3) is replaced by APP-03. **Net MVP increase ≈ 29 pts (~1 sprint).**

| Story | Tasks | Pts (backlog → revised) | Sprint | Why |
| --- | --- | --- | --- | --- |
| **APP-01** App shell, sessions and host sign-in | [MOB] RN 0.88 bare project (Android first), flavours, `write-env`, Root/Welcome/Host/Guest navigator skeletons, multi-identity session store, secure-store, host+guest API clients with refresh middleware (ET pattern), Google sign-in + **dev sign-in screen** + URL picker, launch/offline/update-gate, Sentry RN, Intl + theme providers [API] `/v1/app/config` [TEST] | old APP-01 8 → **8** (split 5 + 3) | **S2** (5: shell + host sign-in) · **S4** (3: guest identities + mode switcher) | Reinterpreted: shell for both modes, not a host-only P1 app. Host screens move to feature epics. |
| **APP-02** Deep and universal links | [OPS] `assetlinks.json`, AASA, Nginx; [MOB] `linking.ts`, Guest entry, Paste link, team-invite route; [WEB] lite page app block + Smart Banner [TEST] link matrix | — → **3** | **S4** (with ACC-01) | New; required for the WhatsApp link to open the app. |
| **APP-03** Push notifications | [DB] `25-app.sql` [API] `devices` module, `PushProvider` + FCM + Fake, `push.send`, `push.purge` [MOB] permission ask at a meaningful moment (after first RSVP / host sign-in), channels, token refresh, tap routing [TEST] | old APP-02 part → **5** | **S5** (with MSG-03) | Replaces MSG-08 web push (3) in S9; MSG uses `push.send`. |
| **APP-04** Offline cache and mutation outbox | [MOB] encrypted MMKV persister, `meta.persist` filter, per-identity namespaces, NetInfo/onlineManager, paused-mutation persistence + resume, stale banner [TEST] | — → **3** | **S4** (with GH-01/02) | Replaces GH-01's service-worker offline cache. |
| **APP-05** Store release pipeline | [OPS] Android: upload key + Play App Signing (ET `release-signing.md`), Fastlane `supply`, internal → closed testing → production (staged rollout); iOS: `match`, `gym`, `pilot` → TestFlight internal → external public link → App Store; `mobile-release.yml` on `mobile-v*` tags (iOS on macOS runner), Sentry source maps/dSYM/R8 mapping upload, versioning; listings, Data safety, privacy labels | old APP-03 3 → **5** | **S3** (2: Android internal track) · **S7** (3: iOS + external tracks) | Two stores, flavours and signing without EAS; needed for the S8 rehearsal installs. |
| **APP-06** iOS platform bring-up | [MOB] iOS project, bundle ids per config, Associated Domains, push entitlement + APNs key in Firebase, Google Sign-In iOS client/URL scheme, permission strings, Keychain access settings; parity pass of APP-01..04 on iOS 15+ [TEST] | — → **3** | **S6** | Expense-Tracker is Android-only; iOS is new ground. |
| **APP-07** Sign in with Apple for hosts (iOS) | [API] `AppleIdTokenVerifier` (JWKS, aud = bundle id), `google_sub = 'apple|<sub>'` [MOB] Apple button on iOS [TEST] | — → **3** | **S7** (before first external TestFlight) | App Store 4.8. **Conditional on PO decision.** |
| **APP-08** Performance budget and release checks | [MOB] start-up spans, lazy host/camera/gallery, bundle-size CI check, dev-string grep; [TEST] budget run on reference device | — → **2** | **S8** (with OPS-04) | Makes Gate 2's "< 3 s on a budget Android" measurable for an app. |
| **APP-09** Store compliance | [API] `DELETE /v1/me` + job (uses PRV erasure) [MOB] delete-account + leave-invitation flows, privacy links [OPS] web deletion page, Data safety/labels, **reviewer demo access** (demo wedding + review credentials, see §13) | — → **3** | **S8** | Both stores reject apps with account creation but no in-app deletion. |
| **APP-10** OTA updates (optional) | [OPS/MOB] evaluate and, if adopted, self-host JS updates on S3/CloudFront (`hot-updater` or `expo-updates` custom server), signed bundles, channel per flavour, kill switch | — → **3** | S17 (season readiness) | Only if store review latency hurt pilots. **PO decision.** |

### Where host features of old APP-01 went

| Old APP-01 item | Now delivered by |
| --- | --- |
| Arrivals board | ARR-02 as a Host-mode screen (realtime via FND-14) |
| QR check-in scanner | ARR-03 (`react-native-vision-camera` code scanner, shared with CAM) |
| Send announcement | MSG-03 composer screen |
| Push alerts for late guests | ARR-04 + APP-03 (`team_alerts` channel) |

## 12. Dependencies and sequencing

| Sprint | APP work | Needs first |
| --- | --- | --- |
| S0–S1 | — (long-lead admin, below) | — |
| S2 | APP-01 (5) | FND-01, FND-05, FND-10 started, FND-12 client; Google OAuth Web + Android (debug SHA-1) clients |
| S3 | APP-05 Android internal (2) | Play Console org account, upload key |
| S4 | APP-01 (3), APP-02, APP-04 | ACC-01/02 endpoints; domain + TLS live (FND-07) |
| S5 | APP-03 | Firebase project per flavour; MSG-03 |
| S6 | APP-06 | Apple Developer org account; APNs key |
| S7 | APP-05 iOS + external tracks, APP-07 (if approved) | Beta App Review lead time (~1–2 days) |
| S8 | APP-08, APP-09 | PRV-02 erasure job (pulled earlier or minimal host-only version), OPS-04 device lab; **rehearsal installs via Play closed testing + TestFlight public link** |

**Long-lead admin to add to E00 (start S0):** Apple Developer Program **organization** enrollment (needs a D-U-N-S number; 1–4 weeks); Google Play Console **organization** account (D-U-N-S; organization accounts avoid the 12-tester / 14-day closed-test requirement imposed on new personal accounts before production); Firebase projects; Google OAuth consent screen verification for the production domain.

## 13. Risks and open questions

| # | Risk / question | Impact | Mitigation / owner |
| --- | --- | --- | --- |
| 1 | **MVP capacity:** ~29 net pts move into S2–S8, which are already at 29–34 | Gate 2 slips | PO: add a sprint before Gate 2, or defer P0-lite items (e.g. GAL-02 album zip, CAM-04 filter) to S9. |
| 2 | **Host experience is phone-only** (no web console) for planners importing 2,000-row spreadsheets | Planner adoption | PO decision; GST import could accept a file picked on the phone (Drive/Files) — already planned in GST — and tablet layouts for desk/board. A web console is a later option. |
| 3 | **Apple 4.8** rejection without Sign in with Apple | iOS pilots blocked | APP-07 (3 pts) — PO decision. |
| 4 | **App review needs guest access** (link + OTP) | Rejection / delays | A production "review demo" wedding and party with a fixed OTP for one configured phone number, scoped to that demo wedding only; ACC must design it safely. PO + ACC decision. |
| 5 | Guest activation drops because an install is required | Gate 3 activation ≥ 70 % at risk | Lite web page covers schedule/RSVP without install; measure installs vs lite usage separately at Gate 3. |
| 6 | Pilot guests on Android need a public-enough track before production approval | Rehearsal/pilot installs blocked | Org Play account → production with staged rollout (or open testing) by S8; iOS via TestFlight public link. |
| 7 | RN 0.88 minimum iOS version vs baseline "iOS 15+" | Some older iPhones excluded | Verify at APP-06; update baseline device matrix if RN requires higher. |
| 8 | No OTA: a critical JS bug during a wedding waits for store review | Hours (Play) to ~1 day (Apple; expedited review possible) | Update gate + feature flags in `/v1/app/config` to switch features off server-side; APP-10 later. |
| 9 | Team skills (plan assumed Python + React web + PWA) | Velocity on native builds, signing, iOS | PO confirm team; pair on APP-05/06. |

## 14. Deviations from the baseline

| Baseline says | This design | Reason |
| --- | --- | --- |
| `push_devices.fcm_token UNIQUE` (000-core) | Dropped in `25-app.sql`; unique per `(fcm_token, user_id)` and `(fcm_token, guest_id)` | One phone holds a host account and guest sessions at several weddings with a single FCM token. **000-core.sql should adopt this.** |
| `users.google_sub` = Google subject or `dev|<email>` | Also `apple|<sub>` if APP-07 is approved; suggest renaming to `idp_subject` at Prisma translation | Sign in with Apple for iOS hosts. |
| Mobile stack list | Adds `react-native-sse`, `@react-native-community/netinfo`, `@tanstack/query-sync-storage-persister` (MMKV-backed), Fastlane | Realtime, offline and release needs. Additions, not replacements. |
| iOS 15+ | Pending RN 0.88's minimum (verify in APP-06) | — |
| (Not stated) update strategy | No OTA at MVP; server-driven update gate | §2. |
